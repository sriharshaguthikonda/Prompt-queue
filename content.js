// Content script for AI Task Sequencer

(function () {
  if (window.__aiTaskSequencerInjected) return;
  window.__aiTaskSequencerInjected = true;

  let currentPromptId = null; // Track per-prompt instead of global flag

  const DEFAULTS = {
    stableMs: 1200,
    maxWaitMs: 180000,
    pollIntervalMs: 300,
  };

  function detectSite() {
    const host = location.hostname;
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    if (host.includes('grok.x.ai')) return 'grok';
    if (host.includes('claude.ai')) return 'claude';
    return 'unknown';
  }

  function selectorsForSite(site) {
    switch (site) {
      case 'chatgpt':
        return {
          inputCandidates: [
            '#prompt-textarea.ProseMirror[contenteditable="true"]',
            'div#prompt-textarea[contenteditable="true"]',
            '.ProseMirror[contenteditable="true"]',
            'form textarea[name="prompt-textarea"]',
            'form textarea[aria-label*="message"]',
            'form textarea',
          ],
          sendButtonCandidates: [
            'form button[data-testid="send-button"]',
            'form button[aria-label="Send message"]',
            'form button[type="submit"]',
          ],
          stopButtonCandidates: [
            'button[data-testid="stop-button"]',
            'button[aria-label="Stop streaming"]',
            'button[aria-label="Stop generating"]',
          ],
          messagesContainerCandidates: [
            '[data-testid="conversation-turns"]',
            'main',
            'body'
          ],
        };
      case 'gemini':
        return {
          inputCandidates: [
            'textarea[aria-label="Enter a prompt here"]',
            '[contenteditable="true"][aria-label*="Message"]',
            '[contenteditable="true"]',
            'textarea'
          ],
          sendButtonCandidates: [
            'button[aria-label="Send"]',
            'button[aria-label*="Send message"]',
            'button[type="submit"]',
          ],
          stopButtonCandidates: [
            'button[aria-label*="Stop"]',
            'button[data-tooltip*="Stop"]'
          ],
          messagesContainerCandidates: [
            'main',
            'body'
          ],
        };
      case 'grok':
        return {
          inputCandidates: [
            'textarea',
            '[contenteditable="true"]'
          ],
          sendButtonCandidates: [
            'button[type="submit"]',
            'button[aria-label*="Send"]'
          ],
          stopButtonCandidates: [
            'button[aria-label*="Stop"]',
            'button:has(svg[aria-label*="stop"])'
          ],
          messagesContainerCandidates: [
            '[data-testid="conversation-root"]',
            'main',
            'body'
          ],
        };
      case 'claude':
        return {
          inputCandidates: [
            'textarea[aria-label*="Message"]',
            'textarea[placeholder*="Message"]',
            'textarea',
            '[contenteditable="true"]'
          ],
          sendButtonCandidates: [
            'button[aria-label="Send"]',
            'button[type="submit"]',
            'form button:not([disabled])'
          ],
          stopButtonCandidates: [
            'button[aria-label*="Stop"]',
            'button:has(svg[aria-label*="stop"])'
          ],
          messagesContainerCandidates: [
            '[data-testid*="conversation"]',
            'main',
            'body'
          ],
        };
      default:
        return {
          inputCandidates: ['textarea', '[contenteditable="true"]'],
          sendButtonCandidates: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button:has(svg[aria-label*="send"])'],
          stopButtonCandidates: ['button[aria-label*="Stop"]'],
          messagesContainerCandidates: ['main', 'body'],
        };
    }
  }

  function queryFirst(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function isButtonEnabled(btn) {
    if (!btn) return false;
    const disabled = btn.getAttribute('disabled') !== null || btn.ariaDisabled === 'true';
    const opacity = parseFloat(getComputedStyle(btn).opacity || '1');
    return !disabled && opacity > 0.5;
  }

  function setProseMirrorText(el, text) {
    el.focus();
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      
      const ok = document.execCommand('insertText', false, text);
      if (ok) return;
      
      throw new Error('insertText returned false');
    } catch (_) {
      try {
        const before = new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(before);
        const input = new InputEvent('input', { data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(input);
        el.textContent = text;
      } catch (_) {
        el.textContent = text;
      }
    }
  }

  function setTextInInput(el, text) {
    if (!el) throw new Error('Input element not found');
    const isContentEditable = el.getAttribute && el.getAttribute('contenteditable') === 'true';
    if (isContentEditable) {
      if (el.id === 'prompt-textarea' || el.classList.contains('ProseMirror')) {
        setProseMirrorText(el, text);
      } else {
        el.focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, text);
    } else {
      el.value = text;
    }
    el.focus();
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clickSend(btn, inputEl) {
    if (!btn) {
      inputEl?.focus();
      const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      const press = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      const up = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      inputEl?.dispatchEvent(down);
      inputEl?.dispatchEvent(press);
      inputEl?.dispatchEvent(up);
      return;
    }
    btn.click();
  }

  function isChatGPTThinking() {
    // Detect ChatGPT thinking/loading state
    const loadingShimmer = document.querySelector('.loading-shimmer');
    const thinkingIndicator = document.querySelector('[class*="thinking"], [data-testid*="thinking"]');
    const stopPresent = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    return !!loadingShimmer || !!thinkingIndicator || !!stopPresent;
  }

  function isChatGPTReadyToSend() {
    const sendEnabled = document.querySelector('form button[data-testid="send-button"]:not([disabled])');
    const regenPresent = document.querySelector('button:has([data-testid="regenerate-response-button"]) , button[aria-label*="Regenerate"]');
    const isThinking = isChatGPTThinking();
    return (!!sendEnabled || !!regenPresent) && !isThinking;
  }

  function isGeminiDone() {
    const stop = document.querySelector('button[aria-label*="Stop"], button[data-tooltip*="Stop"]');
    const spinner = document.querySelector('[aria-label*="Loading"], [role="progressbar"]');
    return !stop && !spinner;
  }

  function isGrokDone() {
    const stop = document.querySelector('button[aria-label*="Stop"], button:has(svg[aria-label*="stop"])');
    const typingDots = document.querySelector('[data-testid*="typing"], [class*="typing"]');
    return !stop && !typingDots;
  }

  function isClaudeDone() {
    const stop = document.querySelector('button[aria-label*="Stop"], [data-testid*="stop"]');
    const spinner = document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]');
    return !stop && !spinner;
  }

  function waitForCompletion({ sendButton, stopButtonSelector, messagesContainer, stableMs, maxWaitMs, pollIntervalMs }) {
    const site = detectSite();
    const effectiveStableMs = typeof stableMs === 'number' ? stableMs : DEFAULTS.stableMs;
    const effectiveMaxWaitMs = typeof maxWaitMs === 'number' ? maxWaitMs : DEFAULTS.maxWaitMs;
    const effectivePollMs = typeof pollIntervalMs === 'number' ? pollIntervalMs : DEFAULTS.pollIntervalMs;
    const completionId = Math.random();

    console.log('[WaitForCompletion] Starting', { completionId, effectiveStableMs, effectiveMaxWaitMs, effectivePollMs });

    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastChange = Date.now();

      const container = messagesContainer || document.body;
      const observer = new MutationObserver(() => {
        lastChange = Date.now();
      });
      try {
        observer.observe(container, { childList: true, subtree: true, characterData: true });
      } catch (_) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }

      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const stableFor = Date.now() - lastChange;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopBtnPresent = stopBtn && isButtonEnabled(stopBtn);

        let canSend = isButtonEnabled(sendButton);
        if (site === 'chatgpt') {
          if (!sendButton) canSend = true; else if (!canSend) canSend = isChatGPTReadyToSend();
        } else if (site === 'gemini') {
          canSend = isGeminiDone();
        } else if (site === 'grok') {
          canSend = isGrokDone();
        } else if (site === 'claude') {
          canSend = isClaudeDone();
        }

        if (stableFor >= effectiveStableMs && !stopBtnPresent && canSend) {
          console.log('[WaitForCompletion] Completion condition met', { 
            completionId, 
            elapsed, 
            stableFor, 
            stopBtnPresent, 
            canSend 
          });
          cleanup();
          resolve();
          return;
        }
        if (elapsed > effectiveMaxWaitMs) {
          console.warn('[WaitForCompletion] Max wait timeout reached', { 
            completionId, 
            elapsed, 
            effectiveMaxWaitMs, 
            stableFor, 
            stopBtnPresent, 
            canSend 
          });
          cleanup();
          resolve();
        }
      }, effectivePollMs);

      function cleanup() {
        console.log('[WaitForCompletion] Cleanup', { completionId });
        clearInterval(interval);
        observer.disconnect();
      }
    });
  }

  function waitForStreamsToStop({ stopButtonSelector, maxWaitMs }) {
    const effectiveMaxWaitMs = typeof maxWaitMs === 'number' ? maxWaitMs : DEFAULTS.maxWaitMs;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkStop = () => {
        const elapsed = Date.now() - startTime;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopPresent = !!stopBtn && isButtonEnabled(stopBtn);

        if (!stopPresent) {
          // No stop button = not streaming, safe to proceed
          resolve();
          return;
        }

        if (elapsed > effectiveMaxWaitMs) {
          // Timeout: reject instead of proceeding with potentially active stream
          console.error('[WaitForStreamsToStop] Timeout waiting for stream to stop after ' + effectiveMaxWaitMs + 'ms. Stop button still present.');
          reject(new Error('Stream did not stop within timeout period. Stopping automation to prevent queue rush.'));
          return;
        }

        // Still streaming, check again soon
        setTimeout(checkStop, 300);
      };

      checkStop();
    });
  }

  async function handleSendPrompt(text, options, promptId) {
    console.log('[HandleSendPrompt] Received prompt request', { promptId, currentPromptId, textLength: text?.length });
    
    if (currentPromptId !== null && currentPromptId !== promptId) {
      console.warn('[HandleSendPrompt] BLOCKED: Different prompt already processing', { 
        newPromptId: promptId, 
        currentPromptId, 
        timestamp: Date.now() 
      });
      
      // Force reset if the same prompt ID keeps getting blocked (stuck state)
      // This prevents infinite loops where a prompt never completes
      console.warn('[HandleSendPrompt] FORCE RESET: Clearing stuck currentPromptId to allow queue to proceed', { 
        stuckPromptId: currentPromptId,
        newPromptId: promptId
      });
      currentPromptId = null;
      
      try {
        chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId });
      } catch (_) {}
      return;
    }

    currentPromptId = promptId;
    console.log('[HandleSendPrompt] Starting processing', { promptId, timestamp: Date.now() });
    
    // Set a safety timeout to force cleanup if this prompt takes too long
    const maxPromptDuration = (options?.maxWaitMs || DEFAULTS.maxWaitMs) + 10000; // Add 10s buffer
    const timeoutId = setTimeout(() => {
      console.error('[HandleSendPrompt] TIMEOUT: Prompt processing exceeded max duration', { 
        promptId, 
        maxPromptDuration,
        timestamp: Date.now()
      });
      currentPromptId = null;
      try {
        chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, error: 'Prompt processing timeout' });
      } catch (_) {}
    }, maxPromptDuration);
    
    try {
      const site = detectSite();
      console.log('[HandleSendPrompt] Detected site:', site);
      const cfg = selectorsForSite(site);

      let inputEl = queryFirst(cfg.inputCandidates);
      let sendBtn = queryFirst(cfg.sendButtonCandidates);
      const stopBtnSel = cfg.stopButtonCandidates?.[0] || null;
      let messagesContainer = queryFirst(cfg.messagesContainerCandidates);
      
      console.log('[HandleSendPrompt] Initial element detection', { 
        hasInputEl: !!inputEl, 
        hasSendBtn: !!sendBtn, 
        stopBtnSel, 
        hasMessagesContainer: !!messagesContainer 
      });

      if ((site === 'chatgpt' || site === 'gemini' || site === 'claude') && !inputEl) {
        console.log('[HandleSendPrompt] Input not found, attempting to locate and focus');
        const composer = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
        composer?.scrollIntoView({ block: 'end' });
        composer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        inputEl = queryFirst(cfg.inputCandidates) || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
        sendBtn = sendBtn || queryFirst(cfg.sendButtonCandidates);
        messagesContainer = messagesContainer || queryFirst(cfg.messagesContainerCandidates) || document.body;
        console.log('[HandleSendPrompt] After focus attempt', { hasInputEl: !!inputEl, hasSendBtn: !!sendBtn });
      }

      if (!inputEl) throw new Error('Could not find chat input on this page.');

      // Wait for any active streaming/processing to complete before sending
      console.log('[HandleSendPrompt] Waiting for streams to stop', { promptId, maxWaitMs: DEFAULTS.maxWaitMs });
      try {
        await Promise.race([
          waitForStreamsToStop({ stopButtonSelector: stopBtnSel, maxWaitMs: DEFAULTS.maxWaitMs }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('waitForStreamsToStop timeout')), DEFAULTS.maxWaitMs + 5000))
        ]);
      } catch (e) {
        console.error('[HandleSendPrompt] waitForStreamsToStop failed', { promptId, error: e?.message });
        throw e;
      }
      console.log('[HandleSendPrompt] Streams stopped, proceeding', { promptId });

      console.log('[HandleSendPrompt] Setting text input', { promptId, textLength: text?.length });
      setTextInInput(inputEl, text);
      await new Promise((r) => setTimeout(r, 150));
      
      console.log('[HandleSendPrompt] Clicking send button', { promptId });
      await clickSend(sendBtn, inputEl);

      console.log('[HandleSendPrompt] Waiting for completion', { promptId, stableMs: options?.stableMs, maxWaitMs: options?.maxWaitMs });
      try {
        await Promise.race([
          waitForCompletion({
            sendButton: sendBtn,
            stopButtonSelector: stopBtnSel,
            messagesContainer,
            stableMs: options?.stableMs,
            maxWaitMs: options?.maxWaitMs,
            pollIntervalMs: options?.pollIntervalMs,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('waitForCompletion timeout')), (options?.maxWaitMs || DEFAULTS.maxWaitMs) + 5000))
        ]);
      } catch (e) {
        console.error('[HandleSendPrompt] waitForCompletion failed', { promptId, error: e?.message });
        throw e;
      }
      
      console.log('[HandleSendPrompt] Completion detected, sending RESPONSE_COMPLETE', { promptId });
      try {
        chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId });
      } catch (_) {}
    } catch (e) {
      console.error('[HandleSendPrompt] Error during processing', { 
        promptId, 
        error: e?.message, 
        stack: e?.stack,
        timestamp: Date.now() 
      });
      try {
        chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, error: String(e) });
      } catch (_) {}
    } finally {
      console.log('[HandleSendPrompt] Cleanup - clearing currentPromptId', { promptId, timestamp: Date.now() });
      clearTimeout(timeoutId);
      currentPromptId = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (message?.type === 'PING') {
          console.log('[MessageListener] PING received');
          sendResponse({ ok: true, timestamp: Date.now() });
          return;
        }

        if (message?.type === 'SEND_PROMPT' && typeof message.text === 'string') {
          const promptId = message.promptId || Math.random();
          console.log('[MessageListener] SEND_PROMPT received', { 
            promptId, 
            textLength: message.text?.length,
            currentPromptId,
            index: message.index,
            total: message.total,
            timestamp: Date.now()
          });
          await handleSendPrompt(message.text, message.options, promptId);
          console.log('[MessageListener] handleSendPrompt completed', { promptId, timestamp: Date.now() });
          sendResponse({ ok: true });
          return;
        }
        
        console.log('[MessageListener] Unknown message type:', message?.type);
      } catch (e) {
        console.error('[MessageListener] Unexpected error:', { error: e?.message, stack: e?.stack });
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  });

  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
})();