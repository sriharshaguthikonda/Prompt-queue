// Content script for AI Task Sequencer

// Console prefix patch - runs in page context
// NOTE: This patch exists in all 3 JS files because Chrome extensions have separate
// JavaScript contexts (service worker, popup, page). Each context needs its own patch.
(function () {
  if (console.__aiPromptQueuePatched) return;
  const PREFIX = '[AI Prompt Queue]';
  console.__aiPromptQueuePatched = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
    const original = console[method]?.bind(console);
    if (original) {
      console[method] = (...args) => {
        const first = args[0];
        if (typeof first === 'string') {
          original(`${PREFIX} ${first}`, ...args.slice(1));
        } else {
          original(PREFIX, ...args);
        }
      };
    }
  });
})();

(function () {
  if (window.__aiTaskSequencerInjected) return;
  window.__aiTaskSequencerInjected = true;

  let currentPromptId = null; // Track per-prompt instead of global flag
  let automationAborted = false; // Signal to queued prompts to stop
  let autoConfirmDialogs = false;
  let lastConfirmClickAt = 0;

  const DEFAULTS = {
    stableMs: 10000,
    maxWaitMs: 180000,
    pollIntervalMs: 1500,
    watchedElementSelector: 'button[data-testid="copy-turn-action-button"]',
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

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeButtonText(text) {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isConfirmButton(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag !== 'button') return false;
    const label = normalizeButtonText(el.innerText || el.textContent || el.getAttribute('aria-label'));
    if (label !== 'confirm') return false;
    if (!isButtonEnabled(el) || !isElementVisible(el)) return false;
    return true;
  }

  function isConfirmDialogVisible() {
    const candidates = Array.from(document.querySelectorAll('button'));
    return candidates.some(isConfirmButton);
  }

  function maybeClickConfirmButtons() {
    if (!autoConfirmDialogs) return false;
    const now = Date.now();
    if (now - lastConfirmClickAt < 1000) return false;
    const candidates = Array.from(document.querySelectorAll('button'));
    const confirmButtons = candidates.filter(isConfirmButton);
    if (confirmButtons.length === 0) return false;
    const target = confirmButtons[0];
    console.log('[AutoConfirm] Clicking confirm button', {
      text: (target.innerText || target.textContent || '').trim(),
      className: target.className
    });
    target.click();
    lastConfirmClickAt = now;
    return true;
  }

  function setAutoConfirmDialogs(enabled, source = 'unknown') {
    const next = enabled === true;
    if (autoConfirmDialogs === next) return;
    autoConfirmDialogs = next;
    console.log('[AutoConfirm] Updated setting', { enabled: autoConfirmDialogs, source });
  }

  async function refreshAutoConfirmSetting(source = 'init') {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res?.ok && res.settings) {
        setAutoConfirmDialogs(res.settings.autoConfirmDialogs === true, source);
      }
    } catch (_) {}
  }

  setInterval(() => {
    maybeClickConfirmButtons();
  }, 1000);

  function setProseMirrorText(el, text) {
    el.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);

    const paragraphs = String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.length === 0 ? '<p><br></p>' : `<p>${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('');

    const insertHtmlOk = document.execCommand('insertHTML', false, paragraphs);
    if (insertHtmlOk) return;

    // Fallback: chunked insertText to avoid length limits
    const chunks = [];
    const maxChunk = 4000;
    for (let i = 0; i < text.length; i += maxChunk) {
      chunks.push(text.slice(i, i + maxChunk));
    }
    try {
      for (const chunk of chunks) {
        document.execCommand('insertText', false, chunk);
      }
      return;
    } catch (_) {
      // Last resort: set textContent and dispatch events
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { data: text, bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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

  function getInputCurrentText(el) {
    if (!el) {
      console.warn('[GetInputCurrentText] Called with null/undefined element');
      return '';
    }
    const isContentEditable = el.getAttribute && el.getAttribute('contenteditable') === 'true';
    let text = '';
    if (isContentEditable) {
      text = el.textContent || '';
    } else if (typeof el.value === 'string') {
      text = el.value;
    } else {
      text = el.textContent || '';
    }
    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
    console.log('[GetInputCurrentText] Read text from input', { length: text.length, preview });
    return text;
  }

  function normalizeWhitespace(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function fuzzyIncludes(haystack, needle) {
    if (!haystack || !needle) return false;
    const h = normalizeWhitespace(haystack).toLowerCase();
    const n = normalizeWhitespace(needle).toLowerCase();
    if (!h || !n) return false;
    if (h.includes(n)) return true;
    if (n.includes(h)) return true;
    if (n.length > 60) {
      const truncated = n.slice(0, 60);
      return h.includes(truncated);
    }
    return false;
  }

  function findRenderedMessageMatch(targetText) {
    const target = normalizeWhitespace(targetText);
    if (!target) return null;
    const candidates = Array.from(document.querySelectorAll('div.whitespace-pre-wrap'));
    for (const el of candidates) {
      const content = normalizeWhitespace(el.textContent || '');
      if (fuzzyIncludes(content, target)) {
        return { el, contentPreview: content.slice(0, 100) };
      }
    }
    return null;
  }

  async function verifyPromptRendered({ text, promptId, attempts = 4, delayMs = 600 }) {
    const target = normalizeWhitespace(text);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const nodes = Array.from(document.querySelectorAll('div.whitespace-pre-wrap'));
      const matchNode = nodes.find((node) => fuzzyIncludes(node.textContent, target));
      if (matchNode) {
        console.log('[PromptQueue] Prompt render verified in chat', { promptId, attempt, nodesChecked: nodes.length, contentPreview: normalizeWhitespace(matchNode.textContent).slice(0, 120) });
        return true;
      }
      console.warn('[PromptQueue] Prompt render not found yet, retrying', { promptId, attempt, attempts, nodesChecked: nodes.length });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('Prompt text not found in chat after send');
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

  function getTailConversationTurns(maxTurns = 2) {
    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"], article[data-turn-id]'));
    if (turns.length === 0) return [];
    return turns.slice(Math.max(0, turns.length - maxTurns));
  }

  function findElementInTailTurns(selector, tailTurns) {
    let matches = [];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch (_) {
      return null;
    }
    if (matches.length === 0) return null;
    if (!tailTurns || tailTurns.length === 0) return matches[matches.length - 1] || null;
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const candidate = matches[i];
      if (tailTurns.some((turn) => turn.contains(candidate))) {
        return candidate;
      }
    }
    return null;
  }

  function hasActiveToolStatusInTailTurns(tailTurns) {
    if (!tailTurns || tailTurns.length === 0) return false;
    const activePatterns = [
      /\btalking to\b/i,
      /\bwants to talk to\b/i,
      /\brunning\b/i,
      /\bprocessing\b/i,
    ];
    const inactivePatterns = [
      /\btalked to\b/i,
      /\bstopped talking to\b/i,
      /\byou allowed this action\b/i,
      /\byou denied this action\b/i,
    ];

    for (const turn of tailTurns) {
      if (!turn) continue;
      const loadingInTurn = findElementInTailTurns('.loading-shimmer', [turn]);
      if (loadingInTurn) return true;

      let statusNodes = [];
      try {
        statusNodes = Array.from(turn.querySelectorAll('[class*="tool-message"] .text-start, [class*="tool-message"] button, [class*="tool-message"] .loading-shimmer'));
      } catch (_) {
        statusNodes = [];
      }

      for (const node of statusNodes) {
        if (!node || !isElementVisible(node)) continue;
        const text = normalizeButtonText(node.textContent || node.innerText || '');
        if (!text) continue;
        if (inactivePatterns.some((pattern) => pattern.test(text))) continue;
        if (activePatterns.some((pattern) => pattern.test(text))) return true;
      }
    }
    return false;
  }

  function isChatGPTThinking() {
    // Ignore stale indicators in older turns; only tail turns can block sending.
    const tailTurns = getTailConversationTurns(2);
    const loadingShimmer = findElementInTailTurns('.loading-shimmer', tailTurns);
    const thinkingIndicator = findElementInTailTurns('[class*="thinking"], [data-testid*="thinking"]', tailTurns);
    const activeToolStatus = hasActiveToolStatusInTailTurns(tailTurns);
    const stopPresent = document.querySelector('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    const confirmVisible = isConfirmDialogVisible();
    return !!loadingShimmer || !!thinkingIndicator || !!activeToolStatus || !!stopPresent || confirmVisible;
  }

  function waitForChatGPTSendWindow({ sendButton, maxWaitMs = 60000, quietWindowMs = 1200, pollMs = 250 }) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let readySince = null;

      const check = () => {
        maybeClickConfirmButtons();
        const elapsed = Date.now() - start;
        const busy = isChatGPTThinking();
        const directReady = sendButton ? isButtonEnabled(sendButton) : false;
        const canSend = directReady || isChatGPTReadyToSend();

        if (!busy && canSend) {
          if (readySince === null) {
            readySince = Date.now();
          } else if (Date.now() - readySince >= quietWindowMs) {
            console.log('[PreSendGuard] Quiet send window reached', { elapsed, quietWindowMs });
            resolve();
            return;
          }
        } else {
          if (readySince !== null) {
            console.log('[PreSendGuard] Busy signal returned; resetting quiet window', { elapsed, busy, canSend });
          }
          readySince = null;
        }

        if (elapsed >= maxWaitMs) {
          reject(new Error('ChatGPT did not reach a stable send window before timeout'));
          return;
        }
        setTimeout(check, pollMs);
      };

      check();
    });
  }

  function checkForStopWord(stopWord, caseSensitive) {
    if (!stopWord || stopWord.trim() === '') return false;
  
    const pageText = document.body.innerText;
    const searchText = caseSensitive ? stopWord : stopWord.toLowerCase();
    const checkText = caseSensitive ? pageText : pageText.toLowerCase();
  
    const found = checkText.includes(searchText);
    if (found) {
      console.log('[StopWord] Stop word detected:', { stopWord, found });
    }
    return found;
  }

  function isChatGPTReadyToSend() {
    // Check if send button is enabled or if we're in a state where we can send
    const sendBtn = document.querySelector('[data-testid="send-button"]');
    if (sendBtn && isButtonEnabled(sendBtn)) return true;
    const regenPresent = document.querySelector('button:has([data-testid="regenerate-response-button"]) , button[aria-label*="Regenerate"]');
    const isThinking = isChatGPTThinking();
    return (!!sendBtn || !!regenPresent) && !isThinking;
  }

  function getElementsBySelector(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (e) {
      console.warn('[WatchGate] Invalid selector', { selector, error: e?.message });
      return null;
    }
  }

  function buildWatchGate(options) {
    const enabled = options?.enableWatchedElementGate === true;
    if (!enabled) return { enabled: false };

    const selector = (options?.watchedElementSelector || DEFAULTS.watchedElementSelector || '').trim();
    if (!selector) return { enabled: false };

    const baselineElements = getElementsBySelector(selector);
    if (!baselineElements) return { enabled: false };

    const baselineCount = baselineElements.length;
    const baselineElementSet = new Set(baselineElements);

    console.log('[WatchGate] Baseline captured', { selector, baselineCount });
    return { enabled: true, selector, baselineCount, baselineElementSet };
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

  function waitForCompletion({ sendButton, stopButtonSelector, messagesContainer, stableMs, maxWaitMs, pollIntervalMs, enableMaxWaitTimeout, stopWord, stopWordCaseSensitive, watchGate }) {
    const site = detectSite();
    const effectiveStableMs = typeof stableMs === 'number' ? stableMs : DEFAULTS.stableMs;
    const effectiveMaxWaitMs = typeof maxWaitMs === 'number' ? maxWaitMs : DEFAULTS.maxWaitMs;
    const effectivePollMs = typeof pollIntervalMs === 'number' ? pollIntervalMs : DEFAULTS.pollIntervalMs;
    const enableTimeout = enableMaxWaitTimeout !== false;
    const completionId = Math.random();

    console.log('[WaitForCompletion] Starting', { completionId, effectiveStableMs, effectiveMaxWaitMs, effectivePollMs, enableTimeout, stopWord });

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
        maybeClickConfirmButtons();
        const elapsed = Date.now() - startTime;
        const stableFor = Date.now() - lastChange;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopBtnPresent = stopBtn && isButtonEnabled(stopBtn);

        // Check for stop word
        if (stopWord && checkForStopWord(stopWord, stopWordCaseSensitive)) {
          console.log('[WaitForCompletion] Stop word detected, stopping automation', { completionId, stopWord });
          cleanup();
          resolve({ stoppedByStopWord: true });
          return;
        }

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

        let watchGateSatisfied = true;
        if (watchGate?.enabled) {
          const currentElements = getElementsBySelector(watchGate.selector);
          const currentCount = currentElements ? currentElements.length : null;
          const hasNewElement = !!currentElements && currentElements.some((el) => !watchGate.baselineElementSet.has(el));
          watchGateSatisfied = currentCount !== null && (currentCount > watchGate.baselineCount || hasNewElement);

          if (!watchGateSatisfied && elapsed % 5000 < effectivePollMs) {
            console.log('[WatchGate] Waiting for new watched element', {
              selector: watchGate.selector,
              baselineCount: watchGate.baselineCount,
              currentCount,
              hasNewElement
            });
          }
        }

        if (stableFor >= effectiveStableMs && !stopBtnPresent && canSend && watchGateSatisfied) {
          console.log('[WaitForCompletion] Completion condition met', { 
            completionId, 
            elapsed, 
            stableFor, 
            stopBtnPresent, 
            canSend,
            watchGateSatisfied
          });
          cleanup();
          resolve();
          return;
        }
        if (enableTimeout && elapsed > effectiveMaxWaitMs) {
          if (watchGate?.enabled && !watchGateSatisfied) {
            console.warn('[WatchGate] Max wait reached and gate is not satisfied; proceeding due timeout', {
              selector: watchGate.selector,
              baselineCount: watchGate.baselineCount
            });
          }
          console.warn('[WaitForCompletion] Max wait timeout reached (timeout enabled)', { 
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

  function waitForStreamsToStop({ stopButtonSelector, maxWaitMs, enableTimeout }) {
    const enableTimeoutCheck = enableTimeout !== false;
    const effectiveMaxWaitMs = enableTimeoutCheck && typeof maxWaitMs === 'number' ? maxWaitMs : Infinity;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let noStopButtonCount = 0;
      const requiredNoStopChecks = 3; // Require 3 consecutive checks without stop button
      const site = detectSite();

      const checkStop = () => {
        maybeClickConfirmButtons();
        const elapsed = Date.now() - startTime;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopPresent = !!stopBtn && isButtonEnabled(stopBtn);

        let stillStreaming = stopPresent;

        // For ChatGPT, also treat thinking indicators as active streaming
        if (site === 'chatgpt') {
          if (isChatGPTThinking()) {
            stillStreaming = true;
          }
        }

        if (!stillStreaming) {
          noStopButtonCount++;
          console.log('[WaitForStreamsToStop] No stop button detected', { 
            noStopButtonCount, 
            requiredNoStopChecks,
            elapsed,
            enableTimeout: enableTimeoutCheck
          });
          
          // Require multiple consecutive checks without stop button to confirm not streaming
          if (noStopButtonCount >= requiredNoStopChecks) {
            console.log('[WaitForStreamsToStop] Confirmed: No active stream, safe to proceed');
            resolve();
            return;
          }
        } else {
          // Reset counter if stop button appears
          noStopButtonCount = 0;
          console.log('[WaitForStreamsToStop] Stop button detected, resetting counter', { enableTimeout: enableTimeoutCheck });
        }

        if (elapsed > effectiveMaxWaitMs) {
          // Timeout: reject instead of proceeding with potentially active stream
          console.error('[WaitForStreamsToStop] Timeout waiting for stream to stop after ' + effectiveMaxWaitMs + 'ms. Stop button still present.');
          reject(new Error('Stream did not stop within timeout period. Stopping automation to prevent queue rush.'));
          return;
        }

        // Still checking, verify again soon
        setTimeout(checkStop, 1000);
      };

      checkStop();
    });
  }

  function waitForStreamStart({ stopButtonSelector, maxWaitMs, pollIntervalMs }) {
    const site = detectSite();
    const effectiveMaxWaitMs = typeof maxWaitMs === 'number' ? maxWaitMs : 5000;
    const effectivePollMs = typeof pollIntervalMs === 'number' ? pollIntervalMs : DEFAULTS.pollIntervalMs;

    return new Promise((resolve) => {
      const startTime = Date.now();
      console.log('[WaitForStreamStart] Starting', { site, effectiveMaxWaitMs, effectivePollMs, stopButtonSelector });

      const check = () => {
        maybeClickConfirmButtons();
        const elapsed = Date.now() - startTime;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopPresent = !!stopBtn && isButtonEnabled(stopBtn);

        let streaming = false;

        if (site === 'chatgpt') {
          if (isChatGPTThinking()) {
            streaming = true;
          }
        } else if (site === 'gemini') {
          streaming = !isGeminiDone();
        } else if (site === 'grok') {
          streaming = !isGrokDone();
        } else if (site === 'claude') {
          streaming = !isClaudeDone();
        }

        if (!streaming && stopPresent) {
          streaming = true;
        }

        if (streaming) {
          console.log('[WaitForStreamStart] Active stream detected', { elapsed, stopPresent, site });
          resolve(true);
          return;
        }

        if (elapsed > effectiveMaxWaitMs) {
          console.warn('[WaitForStreamStart] Timeout with no active stream detected', { elapsed, effectiveMaxWaitMs, stopPresent, site });
          resolve(false);
          return;
        }

        setTimeout(check, effectivePollMs);
      };

      check();
    });
  }

  async function PromptQueue(text, options, promptId) {
    console.log('[PromptQueue] Received prompt request', { promptId, currentPromptId, textLength: text?.length });
  
    // Wait for any currently processing prompt to complete
    if (currentPromptId !== null && currentPromptId !== promptId) {
      const queueMeta = { 
        newPromptId: promptId, 
        currentPromptId, 
        timestamp: Date.now() 
      };
      console.warn('[PromptQueue] QUEUED: Waiting for current prompt to complete', queueMeta, JSON.stringify(queueMeta));
      
      const enableQueueTimeout = options?.enableMaxWaitTimeout !== false;
      // When queue timeout is enabled, wait up to 30 seconds for current prompt to finish.
      // When disabled, wait indefinitely until currentPromptId is cleared by the previous prompt.
      let waitTime = 0;
      const maxWaitTime = 30000;
      const checkInterval = 100;
      console.log('[PromptQueue] Waiting loop for previous prompt started', {
        currentPromptId,
        newPromptId: promptId,
        maxWaitTime,
        checkInterval,
      });
      
      if (enableQueueTimeout) {
        while (currentPromptId !== null && waitTime < maxWaitTime && !automationAborted) {
          await new Promise(r => setTimeout(r, checkInterval));
          waitTime += checkInterval;

          if (waitTime % 5000 === 0) {
            console.log('[PromptQueue] Still waiting for previous prompt to complete', {
              currentPromptId,
              newPromptId: promptId,
              waitedMs: waitTime,
            });
          }
        }

        if (automationAborted) {
          console.log('[PromptQueue] Automation was aborted (stop word), not proceeding', {
            newPromptId: promptId,
            waitedMs: waitTime,
          });
          return; // Don't process this prompt
        }

        if (currentPromptId !== null) {
          const site = detectSite();
          console.error('[PromptQueue] TIMEOUT: Previous prompt did not complete, forcing reset', { 
            stuckPromptId: currentPromptId,
            newPromptId: promptId,
            waitedMs: waitTime,
            site,
            timestamp: Date.now(),
          });
          currentPromptId = null;
        } else {
          console.log('[PromptQueue] Previous prompt completed, proceeding', { 
            newPromptId: promptId,
            waitedMs: waitTime
          });
        }
      } else {
        // No queue timeout: wait indefinitely until the previous prompt clears currentPromptId
        while (currentPromptId !== null && !automationAborted) {
          await new Promise(r => setTimeout(r, checkInterval));
          waitTime += checkInterval;
        }

        if (automationAborted) {
          console.log('[PromptQueue] Automation was aborted (stop word), not proceeding', {
            newPromptId: promptId,
            waitedMs: waitTime,
          });
          return; // Don't process this prompt
        }

        console.log('[PromptQueue] Previous prompt completed, proceeding (no timeout)', {
          newPromptId: promptId,
          waitedMs: waitTime,
        });
      }
    }

    currentPromptId = promptId;
    automationAborted = false; // Reset abort flag for new prompt
    console.log('[PromptQueue] Starting processing', { promptId, timestamp: Date.now(), options });
    
    // Set a safety timeout to force cleanup if this prompt takes too long
    const enablePromptTimeout = options?.enableMaxWaitTimeout !== false;
    const maxPromptDuration = (options?.maxWaitMs || DEFAULTS.maxWaitMs) + 10000; // Add 10s buffer
    const timeoutId = enablePromptTimeout
      ? setTimeout(() => {
          console.error('[PromptQueue] TIMEOUT: Prompt processing exceeded max duration', { 
            promptId, 
            maxPromptDuration,
            timestamp: Date.now()
          });
          currentPromptId = null;
          try {
            chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, error: 'Prompt processing timeout' });
          } catch (_) {}
        }, maxPromptDuration)
      : null;
    
    try {
      const site = detectSite();
      console.log('[PromptQueue] Detected site:', site);
      const cfg = selectorsForSite(site);

      let inputEl = queryFirst(cfg.inputCandidates);
      let sendBtn = queryFirst(cfg.sendButtonCandidates);
      const stopBtnSel = cfg.stopButtonCandidates?.[0] || null;
      let messagesContainer = queryFirst(cfg.messagesContainerCandidates);
      
      console.log('[PromptQueue] Initial element detection', { 
        hasInputEl: !!inputEl, 
        hasSendBtn: !!sendBtn, 
        stopBtnSel, 
        hasMessagesContainer: !!messagesContainer 
      });

      if ((site === 'chatgpt' || site === 'gemini' || site === 'claude') && !inputEl) {
        console.log('[PromptQueue] Input not found, attempting to locate and focus');
        const composer = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
        composer?.scrollIntoView({ block: 'end' });
        composer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        inputEl = queryFirst(cfg.inputCandidates) || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable="true"], form textarea, [contenteditable="true"]');
        sendBtn = sendBtn || queryFirst(cfg.sendButtonCandidates);
        messagesContainer = messagesContainer || queryFirst(cfg.messagesContainerCandidates) || document.body;
        console.log('[PromptQueue] After focus attempt', { hasInputEl: !!inputEl, hasSendBtn: !!sendBtn });
      }

      if (!inputEl) throw new Error('Could not find chat input on this page.');

      const watchGate = buildWatchGate(options);

      // Wait for any active streaming/processing to complete before sending
      console.log('[PromptQueue] Waiting for streams to stop', { promptId, enableTimeout: false });
      try {
        await waitForStreamsToStop({ stopButtonSelector: stopBtnSel, maxWaitMs: undefined, enableTimeout: false });
      } catch (e) {
        console.error('[PromptQueue] waitForStreamsToStop failed', { promptId, error: e?.message });
        throw e;
      }
      console.log('[PromptQueue] Streams stopped, proceeding', { promptId });

      console.log('[PromptQueue] Setting text input', { promptId, textLength: text?.length });
      setTextInInput(inputEl, text);
      await new Promise((r) => setTimeout(r, 150));

      let pasteVerifyAttempts = 0;
      const maxPasteVerifyAttempts = 3;
      while (pasteVerifyAttempts < maxPasteVerifyAttempts) {
        const currentText = getInputCurrentText(inputEl);
        const normalizedCurrent = (currentText || '').replace(/\s+/g, ' ').trim();
        if (normalizedCurrent) {
          console.log('[PromptQueue] Input text present, proceeding', { promptId, pasteVerifyAttempts, length: currentText?.length });
          break;
        }
        pasteVerifyAttempts += 1;
        console.warn('[PromptQueue] Input appears empty, re-setting text', { promptId, pasteVerifyAttempts, maxPasteVerifyAttempts });
        setTextInInput(inputEl, text);
        await new Promise((r) => setTimeout(r, 150));
      }

      const finalCurrentText = getInputCurrentText(inputEl);
      const finalNormalized = (finalCurrentText || '').replace(/\s+/g, ' ').trim();
      if (!finalNormalized) {
        console.error('[PromptQueue] Input still empty before send after retries', {
          promptId,
          finalLength: finalNormalized.length,
        });
        throw new Error('Input field empty before sending');
      }
      console.log('[PromptQueue] Final input verified before send', { promptId, finalLength: finalNormalized.length, preview: finalNormalized.slice(0, 120) });

      if (site === 'chatgpt') {
        const preSendMaxWaitMs = Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 60000);
        console.log('[PromptQueue] Waiting for ChatGPT pre-send quiet window', { promptId, preSendMaxWaitMs });
        await waitForChatGPTSendWindow({
          sendButton: sendBtn,
          maxWaitMs: preSendMaxWaitMs,
          quietWindowMs: 1200,
          pollMs: 250,
        });
      }
      
      console.log('[PromptQueue] Clicking send button', { promptId });
      await clickSend(sendBtn, inputEl);

      let attempt = 0;
      const maxAttempts = 2;
      let streamStarted = false;

      while (attempt < maxAttempts && !streamStarted) {
        attempt += 1;
        console.log('[PromptQueue] Verifying stream started', { promptId, attempt, maxAttempts });
        streamStarted = await waitForStreamStart({
          stopButtonSelector: stopBtnSel,
          maxWaitMs: Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 10000),
          pollIntervalMs: options?.pollIntervalMs,
        });

        if (!streamStarted && attempt < maxAttempts) {
          const renderMatch = findRenderedMessageMatch(text);
          if (renderMatch) {
            console.log('[PromptQueue] Detected rendered message despite no stream signal; treating as sent', { 
              promptId, 
              attempt, 
              maxAttempts, 
              contentPreview: renderMatch.contentPreview 
            });
            streamStarted = true;
            break;
          }
          console.warn('[PromptQueue] No active stream detected and no rendered message, re-attempting send', { promptId, attempt, maxAttempts });
          await new Promise((r) => setTimeout(r, 250));
          if (site === 'chatgpt') {
            const retryPreSendMaxWaitMs = Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 60000);
            console.log('[PromptQueue] Waiting for ChatGPT pre-send quiet window before retry', {
              promptId,
              attempt,
              retryPreSendMaxWaitMs,
            });
            await waitForChatGPTSendWindow({
              sendButton: sendBtn,
              maxWaitMs: retryPreSendMaxWaitMs,
              quietWindowMs: 1200,
              pollMs: 250,
            });
          }
          await clickSend(sendBtn, inputEl);
        }
      }

      if (!streamStarted) {
        throw new Error('No active stream detected after sending prompt (after retries)');
      }
      console.log('[PromptQueue] Stream detected or render found, proceeding to render verification', { promptId, streamStarted });

      // Verify the prompt text appears in the rendered chat (e.g., ChatGPT message bubble)
      try {
        await verifyPromptRendered({ text, promptId, attempts: 4, delayMs: 500 });
        console.log('[PromptQueue] Render verification succeeded', { promptId });
      } catch (e) {
        console.error('[PromptQueue] Prompt render verification failed', { promptId, error: e?.message });
        throw e;
      }

      const enableCompletionTimeout = options?.enableMaxWaitTimeout !== false;
      const effectiveStopWord = options?.enableStopWord ? options?.stopWord : null;
      console.log('[PromptQueue] Waiting for completion', { promptId, stableMs: options?.stableMs, maxWaitMs: options?.maxWaitMs, enableMaxWaitTimeout: enableCompletionTimeout, enableStopWord: options?.enableStopWord, stopWord: effectiveStopWord, watchGate });
      try {
        let result;
        if (enableCompletionTimeout && !watchGate?.enabled) {
          result = await Promise.race([
            waitForCompletion({
              sendButton: sendBtn,
              stopButtonSelector: stopBtnSel,
              messagesContainer,
              stableMs: options?.stableMs,
              maxWaitMs: options?.maxWaitMs,
              pollIntervalMs: options?.pollIntervalMs,
              enableMaxWaitTimeout: enableCompletionTimeout,
              stopWord: effectiveStopWord,
              stopWordCaseSensitive: options?.stopWordCaseSensitive,
              watchGate,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('waitForCompletion timeout')), (options?.maxWaitMs || DEFAULTS.maxWaitMs) + 5000))
          ]);
        } else {
          result = await waitForCompletion({
            sendButton: sendBtn,
            stopButtonSelector: stopBtnSel,
            messagesContainer,
            stableMs: options?.stableMs,
            maxWaitMs: options?.maxWaitMs,
            pollIntervalMs: options?.pollIntervalMs,
            enableMaxWaitTimeout: enableCompletionTimeout,
            stopWord: effectiveStopWord,
            stopWordCaseSensitive: options?.stopWordCaseSensitive,
            watchGate,
          });
        }

        // Check if automation was stopped by stop word
        if (result?.stoppedByStopWord) {
          console.log('[PromptQueue] Automation stopped by stop word', { promptId });
          automationAborted = true; // Signal queued prompts to abort
          try {
            chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, stoppedByStopWord: true });
          } catch (_) {}
          return;
        }
        console.log('[PromptQueue] Completion wait finished (no stop word)', { promptId });
      } catch (e) {
        console.error('[PromptQueue] waitForCompletion failed', { promptId, error: e?.message });
        throw e;
      }
      
      console.log('[PromptQueue] Completion detected, sending RESPONSE_COMPLETE', { promptId });
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId });
        console.log('[PromptQueue] RESPONSE_COMPLETE sent, got response', { promptId, resp });
      } catch (e) {
        console.error('[PromptQueue] Failed to send RESPONSE_COMPLETE', { promptId, error: e?.message });
      }
    } catch (e) {
      console.error('[PromptQueue] Error during processing', { 
        promptId, 
        error: e?.message, 
        stack: e?.stack,
        timestamp: Date.now() 
      });
      try {
        chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, error: String(e) });
      } catch (_) {}
    } finally {
      console.log('[PromptQueue] Cleanup - clearing currentPromptId', { promptId, timestamp: Date.now() });
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

        if (message?.type === 'SETTINGS_UPDATED' && message.settings) {
          setAutoConfirmDialogs(message.settings.autoConfirmDialogs === true, 'settings_updated');
          sendResponse({ ok: true });
          return;
        }

        if (message?.type === 'SEND_PROMPT' && typeof message.text === 'string') {
          const promptId = message.promptId || Math.random();
          if (message.options && typeof message.options.autoConfirmDialogs === 'boolean') {
            setAutoConfirmDialogs(message.options.autoConfirmDialogs, 'send_prompt');
          }
          console.log('[MessageListener] SEND_PROMPT received', { 
            promptId, 
            textLength: message.text?.length,
            currentPromptId,
            index: message.index,
            total: message.total,
            timestamp: Date.now()
          });
          await PromptQueue(message.text, message.options, promptId);
          console.log('[MessageListener] PromptQueue completed', { promptId, timestamp: Date.now() });
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
  refreshAutoConfirmSetting('content_ready');
})();
