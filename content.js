// Content script for AI Task Sequencer

(function () {
  if (window.__aiTaskSequencerInjected) return;
  window.__aiTaskSequencerInjected = true;

  let isProcessing = false; // Prevent concurrent prompt processing

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
            'button[aria-label="Stop generating"]',
            'button[data-testid="stop-button"]'
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
      if (!ok) {
        const before = new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(before);
        const input = new InputEvent('input', { data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(input);
        el.textContent = text;
      }
    } catch (_) {
      el.textContent = text;
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

  function isChatGPTReadyToSend() {
    const sendEnabled = document.querySelector('form button[data-testid="send-button"]:not([disabled])');
    const stopPresent = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    const regenPresent = document.querySelector('button:has([data-testid="regenerate-response-button"]) , button[aria-label*="Regenerate"]');
    return (!!sendEnabled || !!regenPresent) && !stopPresent;
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
        const stopBtnPresent = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;

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
          cleanup();
          resolve();
          return;
        }
        if (elapsed > effectiveMaxWaitMs) {
          cleanup();
          resolve();
        }
      }, effectivePollMs);

      function cleanup() {
        clearInterval(interval);
        observer.disconnect();
      }
    });
  }

  async function handleSendPrompt(text, options) {
    const site = detectSite();
    const cfg = selectorsForSite(site);

    let inputEl = queryFirst(cfg.inputCandidates);
    let sendBtn = queryFirst(cfg.sendButtonCandidates);
    const stopBtnSel = cfg.stopButtonCandidates?.[0] || null;
    let messagesContainer = queryFirst(cfg.messagesContainerCandidates);

    if ((site === 'chatgpt' || site === 'gemini' || site === 'claude') && !inputEl) {
      const composer = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
      composer?.scrollIntoView({ block: 'end' });
      composer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      inputEl = queryFirst(cfg.inputCandidates) || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
      sendBtn = sendBtn || queryFirst(cfg.sendButtonCandidates);
      messagesContainer = messagesContainer || queryFirst(cfg.messagesContainerCandidates) || document.body;
    }

    if (!inputEl) throw new Error('Could not find chat input on this page.');

    setTextInInput(inputEl, text);
    await new Promise((r) => setTimeout(r, 150));
    await clickSend(sendBtn, inputEl);

    await waitForCompletion({
      sendButton: sendBtn,
      stopButtonSelector: stopBtnSel,
      messagesContainer,
      stableMs: options?.stableMs,
      maxWaitMs: options?.maxWaitMs,
      pollIntervalMs: options?.pollIntervalMs,
    });

    chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE' }).catch(() => {});
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      // Handle PING for health checks (used by recovery logic)
      if (message?.type === 'PING') {
        sendResponse({ ok: true, timestamp: Date.now() });
        return;
      }

      if (message?.type === 'SEND_PROMPT' && typeof message.text === 'string') {
        try {
          await handleSendPrompt(message.text, message.options);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
    })();
    return true;
  });

  // Notify background that content script is ready
  chrome.runtime.sendMessage({ type: 'CONTENT_READY' }).catch(() => {});
})();