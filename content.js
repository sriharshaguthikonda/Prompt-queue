// Content script for AI Task Sequencer

// Console prefix patch - runs in page context
// NOTE: This patch exists in all 3 JS files because Chrome extensions have separate
// JavaScript contexts (service worker, popup, page). Each context needs its own patch.
(function () {
  const root = window;
  const setDebugEnabled = (enabled) => {
    root.__aiPromptQueueDebugLoggingEnabled = enabled === true;
  };

  if (console.__aiPromptQueuePatched) {
    root.__aiPromptQueueSetDebugLogging = setDebugEnabled;
    if (typeof root.__aiPromptQueueDebugLoggingEnabled !== 'boolean') {
      setDebugEnabled(false);
    }
    return;
  }

  const PREFIX = '[AI Prompt Queue]';
  setDebugEnabled(false);
  root.__aiPromptQueueSetDebugLogging = setDebugEnabled;
  console.__aiPromptQueuePatched = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
    const original = console[method]?.bind(console);
    if (!original) return;

    const alwaysEmit = method === 'error';
    console[method] = (...args) => {
      if (!alwaysEmit && root.__aiPromptQueueDebugLoggingEnabled !== true) {
        return;
      }
      const first = args[0];
      if (typeof first === 'string') {
        original(`${PREFIX} ${first}`, ...args.slice(1));
      } else {
        original(PREFIX, ...args);
      }
    };
  });
})();

(function () {
  const CONTENT_SCRIPT_VERSION = '2026-06-06.infinite-response-wait-v1';
  if (window.__aiTaskSequencerInjected === CONTENT_SCRIPT_VERSION) return;
  window.__aiTaskSequencerInjected = CONTENT_SCRIPT_VERSION;

  let currentPromptId = null; // Track per-prompt instead of global flag
  let automationAborted = false; // Signal to queued prompts to stop
  let autoConfirmDialogs = false;
  let lastConfirmClickAt = 0;
  let activeStopWord = null;
  let activeStopWordCaseSensitive = false;
  let stopWordGuardArmed = false;
  let stopWordBlockedAutoConfirm = false;
  let currentTargetSettings = {};

  function setDebugLoggingEnabled(enabled) {
    const next = enabled === true;
    if (typeof window.__aiPromptQueueSetDebugLogging === 'function') {
      window.__aiPromptQueueSetDebugLogging(next);
      return;
    }
    window.__aiPromptQueueDebugLoggingEnabled = next;
  }

  function queryOneSafe(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      return document.querySelector(selector);
    } catch (error) {
      console.warn('[Targets] Invalid selector', { selector, error: error?.message });
      return null;
    }
  }

  const DEFAULTS = {
    stableMs: 10000,
    maxWaitMs: 180000,
    pollIntervalMs: 1500,
    watchedElementSelector: 'button[data-testid="copy-turn-action-button"]',
  };
  const RESPONSE_CAPTURE_CHARS = 20000;
  const targetTools = window.PromptQueueTargets || {};
  const inputTools = window.PromptQueueInput || {};
  const {
    getInputCurrentText,
    getInputCurrentTextQuiet,
    getInputTextLengthQuiet,
    isContentEditableElement,
    setTextInInput,
  } = inputTools;
  const statusTools = window.PromptQueueStatus || {};
  const emitStepUpdate = typeof statusTools.emitStepUpdate === 'function'
    ? statusTools.emitStepUpdate
    : () => null;
  const delayWithStatus = typeof statusTools.delayWithStatus === 'function'
    ? statusTools.delayWithStatus
    : ({ durationMs = 0 } = {}) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(durationMs) || 0)));
  const chatStateTools = window.PromptQueueChatState || {};

  function detectSite() {
    let host = location.hostname || '';
    if (!host && location.href) {
      try {
        host = new URL(location.href).hostname;
      } catch (_) {
        host = '';
      }
    }
    if (host.includes('chat.openai.com') || host.includes('chatgpt.com')) return 'chatgpt';
    if (host.includes('gemini.google.com')) return 'gemini';
    if (host.includes('grok.x.ai')) return 'grok';
    if (host.includes('claude.ai')) return 'claude';
    return 'unknown';
  }

  function selectorsForSite(site) {
    if (typeof targetTools.getSiteTargets === 'function') {
      return targetTools.getSiteTargets(site);
    }
    return {
      inputCandidates: ['textarea', '[contenteditable]'],
      sendButtonCandidates: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button:has(svg[aria-label*="send"])'],
      stopButtonCandidates: ['button[aria-label*="Stop"]'],
      messagesContainerCandidates: ['main', 'body'],
      watchedElementCandidates: [DEFAULTS.watchedElementSelector],
    };
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

  function buttonLooksLikeSend(el) {
    if (!el || el.tagName !== 'BUTTON') return false;
    const label = normalizeButtonText(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || '');
    const testId = normalizeButtonText(el.getAttribute('data-testid') || '');
    const type = normalizeButtonText(el.getAttribute('type') || '');
    return label.includes('send')
      || label.includes('submit')
      || testId.includes('send')
      || testId.includes('submit')
      || type === 'submit';
  }

  function findChatGPTSendButton(inputEl) {
    const roots = [
      inputEl?.closest?.('form'),
      inputEl?.closest?.('[data-testid*="composer"]'),
      inputEl?.closest?.('[class*="composer"]'),
      document,
    ].filter(Boolean);
    const selectors = [
      'button[data-testid*="send"]',
      'button[data-testid*="submit"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="submit"]',
      'button[aria-label*="Send prompt"]',
      'button[type="submit"]',
    ];
    for (const root of roots) {
      for (const selector of selectors) {
        let candidates = [];
        try {
          candidates = Array.from(root.querySelectorAll(selector));
        } catch (_) {
          candidates = [];
        }
        const match = candidates.find((candidate) => buttonLooksLikeSend(candidate));
        if (match) return match;
      }
    }
    return null;
  }

  function findPromptInputForSite(site, settings = currentTargetSettings) {
    const resolved = typeof targetTools.resolveTarget === 'function'
      ? targetTools.resolveTarget('promptInput', { site, settings })
      : null;
    if (resolved?.element) return resolved.element;
    return queryFirst(selectorsForSite(site).inputCandidates);
  }

  function findSendButtonForSite(site, inputEl, settings = currentTargetSettings) {
    const resolved = typeof targetTools.resolveTarget === 'function'
      ? targetTools.resolveTarget('sendButton', { site, settings })
      : null;
    if (resolved?.element) return resolved.element;
    if (site === 'chatgpt') {
      const direct = queryFirst(selectorsForSite(site).sendButtonCandidates);
      return direct || findChatGPTSendButton(inputEl);
    }
    return queryFirst(selectorsForSite(site).sendButtonCandidates);
  }

  function resolveStopButtonSelector(site, settings = currentTargetSettings) {
    if (typeof targetTools.getCustomSelectorForRole === 'function') {
      const customSelector = targetTools.getCustomSelectorForRole('stopButton', settings);
      if (customSelector) return customSelector;
    }
    if (typeof targetTools.resolveSelector === 'function') {
      const resolved = targetTools.resolveSelector('stopButton', { site, settings });
      if (resolved?.selector) return resolved.selector;
    }
    return selectorsForSite(site).stopButtonCandidates?.[0] || null;
  }

  function emitSelectorHealth(site, settings = currentTargetSettings) {
    if (typeof targetTools.resolveSelector !== 'function') return;
    const roles = ['promptInput', 'sendButton', 'stopButton', 'watchedElement'];
    const health = {};
    for (const role of roles) {
      try {
        const resolved = targetTools.resolveSelector(role, { site, settings });
        health[role] = {
          selector: resolved?.selector || '',
          source: resolved?.source || 'none',
          matchedCount: Number(resolved?.matchedCount || 0),
          visible: !!resolved?.element,
        };
      } catch (error) {
        health[role] = { selector: '', source: 'error', matchedCount: 0, visible: false, error: error?.message || String(error) };
      }
    }
    try {
      chrome.runtime.sendMessage({ type: 'SELECTOR_HEALTH', site, health });
    } catch (_) {}
  }

  function isButtonEnabled(btn) {
    if (!btn) return false;
    const disabled = btn.getAttribute('disabled') !== null
      || btn.getAttribute('aria-disabled') === 'true'
      || btn.ariaDisabled === 'true';
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

  function maybeClickConfirmButtons(source = 'unknown') {
    if (!autoConfirmDialogs) return false;
    if (shouldBlockConfirmForStopWord(source)) return false;
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
        setDebugLoggingEnabled(res.settings.debugLoggingEnabled === true);
        currentTargetSettings = res.settings || {};
        emitSelectorHealth(detectSite(), currentTargetSettings);
      }
    } catch (_) {}
  }

  setInterval(() => {
    maybeClickConfirmButtons('interval');
  }, 1000);

  function findPromptInput() {
    const active = document.activeElement;
    if (active) {
      const isTextarea = active.tagName === 'TEXTAREA';
      const isContentEditable = isContentEditableElement(active);
      if (isTextarea || isContentEditable) {
        return active;
      }
    }
    const site = detectSite();
    const cfg = selectorsForSite(site);
    return findPromptInputForSite(site, currentTargetSettings)
      || queryFirst(cfg.inputCandidates)
      || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable], form textarea, [contenteditable], textarea, textarea.wcDTda_fallbackTextarea');
  }

  function waitForComposerReady({
    site,
    settings = currentTargetSettings,
    inputEl = null,
    maxWaitMs = Math.min(DEFAULTS.maxWaitMs || 60000, 10000),
    stableWindowMs = 300,
    pollMs = 100,
  } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let readySince = null;
      let stableElement = null;

      const getComposerCandidate = () => inputEl && inputEl.isConnected && isElementVisible(inputEl)
        ? inputEl
        : (findPromptInputForSite(site, settings)
          || queryFirst(selectorsForSite(site).inputCandidates)
          || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable], form textarea, [contenteditable], textarea, textarea.wcDTda_fallbackTextarea'));

      const check = () => {
        const elapsed = Date.now() - start;
        const candidate = getComposerCandidate();

        if (candidate && candidate.isConnected && isElementVisible(candidate)) {
          if (stableElement !== candidate) {
            stableElement = candidate;
            readySince = Date.now();
          } else if (readySince !== null && Date.now() - readySince >= stableWindowMs) {
            resolve(candidate);
            return;
          }
        } else {
          stableElement = null;
          readySince = null;
        }

        if (elapsed >= maxWaitMs) {
          reject(new Error('Composer did not become ready before timeout'));
          return;
        }

        setTimeout(check, pollMs);
      };

      check();
    });
  }

  function coerceDelayWindow(options = {}) {
    const fallbackMin = 500;
    const fallbackMax = 1500;
    const rawMin = Number(options.postPopulateDelayMinMs);
    const rawMax = Number(options.postPopulateDelayMaxMs);
    const min = Number.isFinite(rawMin) ? Math.min(60000, Math.max(0, rawMin)) : fallbackMin;
    const max = Number.isFinite(rawMax) ? Math.min(60000, Math.max(0, rawMax)) : fallbackMax;
    return {
      minMs: Math.min(min, max),
      maxMs: Math.max(min, max),
    };
  }

  function randomDelayFromWindow(windowConfig) {
    const min = Math.max(0, Number(windowConfig?.minMs) || 0);
    const max = Math.max(min, Number(windowConfig?.maxMs) || min);
    if (max <= min) return Math.round(min);
    return Math.round(min + Math.random() * (max - min));
  }

  function getVisiblePageContext() {
    const root = document.querySelector('main') || document.body;
    return (root?.innerText || document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  }

  function getMemorySource(source) {
    const requested = source || 'prompt_box';
    if (requested === 'selection') {
      return { source: requested, text: String(window.getSelection?.() || '').trim() };
    }
    if (requested === 'page') {
      return { source: requested, text: getVisiblePageContext() };
    }
    const inputEl = findPromptInput();
    const promptText = getInputCurrentTextQuiet(inputEl).trim();
    if (requested === 'combined') {
      const selectionText = String(window.getSelection?.() || '').trim();
      return {
        source: requested,
        text: [promptText, selectionText].filter(Boolean).join('\n\n'),
      };
    }
    return { source: 'prompt_box', text: promptText };
  }

  function replaceSelectedTextInInput(inputEl, markdown) {
    if (!inputEl) return false;
    const isTextarea = inputEl.tagName === 'TEXTAREA' || typeof inputEl.value === 'string';
    if (isTextarea && Number.isFinite(inputEl.selectionStart) && inputEl.selectionStart !== inputEl.selectionEnd) {
      const before = inputEl.value.slice(0, inputEl.selectionStart);
      const after = inputEl.value.slice(inputEl.selectionEnd);
      setTextInInput(inputEl, `${before}${markdown}${after}`);
      return true;
    }
    const isContentEditable = isContentEditableElement(inputEl);
    const selection = window.getSelection?.();
    if (isContentEditable && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (inputEl.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(document.createTextNode(markdown));
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function insertMemoryPack(markdown, behavior) {
    const pack = String(markdown || '').trim();
    if (!pack) throw new Error('Memory pack is empty.');
    const begin = '<!-- BEGIN C_MEMORY_BROWSER_PACK -->';
    const end = '<!-- END C_MEMORY_BROWSER_PACK -->';
    if (!pack.includes(begin) || !pack.includes(end)) {
      throw new Error('Memory pack is missing managed block markers.');
    }
    const inputEl = findPromptInput();
    if (!inputEl) throw new Error('Could not find prompt input.');
    if (behavior === 'replace_selected_text' && replaceSelectedTextInInput(inputEl, pack)) {
      return { ok: true, replaced: true, behavior };
    }

    const current = getInputCurrentTextQuiet(inputEl);
    const blockPattern = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n*`, 'm');
    let nextText = '';
    let replaced = false;
    if (blockPattern.test(current)) {
      nextText = current.replace(blockPattern, `${pack}\n\n`);
      replaced = true;
    } else if (behavior === 'append') {
      nextText = current.trim() ? `${current.trimEnd()}\n\n${pack}` : pack;
    } else {
      nextText = current.trim() ? `${pack}\n\n${current.trimStart()}` : pack;
    }
    setTextInInput(inputEl, nextText);
    return { ok: true, replaced, behavior: behavior || 'prepend_or_replace_managed_block' };
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
    const selectors = [
      'div.whitespace-pre-wrap',
      '[data-message-author-role="user"]',
      'article[data-testid^="conversation-turn-"]',
      'article[data-turn-id]',
      'main [data-testid*="message"]',
    ];
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          if (!seen.has(el)) {
            seen.add(el);
            candidates.push(el);
          }
        }
      } catch (_) {}
    }
    for (const el of candidates) {
      const content = normalizeWhitespace(el.textContent || '');
      if (fuzzyIncludes(content, target)) {
        return { el, contentPreview: content.slice(0, 100) };
      }
    }
    return null;
  }

  function cleanCapturedResponseText(text) {
    const cleaned = String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length <= RESPONSE_CAPTURE_CHARS) return cleaned;
    return `${cleaned.slice(0, RESPONSE_CAPTURE_CHARS - 28)}\n\n[response truncated]`;
  }

  function responseCandidateSelectors(site) {
    if (site === 'chatgpt') {
      return [
        'article[data-testid^="conversation-turn-"]',
        '[data-message-author-role="assistant"]',
        'main .markdown',
      ];
    }
    if (site === 'claude') {
      return [
        '[data-testid*="conversation"]',
        '[data-testid*="message"]',
        'main .font-claude-message',
        'main article',
      ];
    }
    if (site === 'gemini') {
      return [
        'message-content',
        'model-response',
        'main [id^="model-response"]',
        'main article',
      ];
    }
    if (site === 'grok') {
      return [
        'main article',
        '[data-testid*="message"]',
        '[class*="message"]',
      ];
    }
    return ['main article', '[data-testid*="message"]', '.markdown'];
  }

  function captureLatestAssistantResponse(promptText) {
    const site = detectSite();
    const seen = new Set();
    const candidates = [];
    for (const selector of responseCandidateSelectors(site)) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_) {
        nodes = [];
      }
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }
    candidates.sort((a, b) => {
      if (a === b) return 0;
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const candidateTexts = candidates.map((candidate) => cleanCapturedResponseText(candidate.innerText || candidate.textContent || ''));
    let promptIndex = -1;
    for (let i = 0; i < candidateTexts.length; i += 1) {
      if (fuzzyIncludes(candidateTexts[i], promptText)) promptIndex = i;
    }

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (site === 'chatgpt' && promptIndex >= 0 && i <= promptIndex) continue;
      const text = candidateTexts[i];
      if (!text) continue;
      if (fuzzyIncludes(text, promptText)) continue;
      const responseScope = candidates[i].closest?.('article[data-testid^="conversation-turn-"], article[data-turn-id], [data-message-author-role="assistant"]') || candidates[i];
      return {
        ok: true,
        site,
        url: location.href,
        responseText: text,
        responseLength: text.length,
        responseScope,
      };
    }
    return { ok: false, site, url: location.href, responseText: '', responseLength: 0, responseScope: null };
  }

  async function verifyPromptRendered({ text, promptId, attempts = 4, delayMs = 600 }) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const match = findRenderedMessageMatch(text);
      if (match) {
        console.log('[PromptQueue] Prompt render verified in chat', { promptId, attempt });
        return true;
      }
      console.warn('[PromptQueue] Prompt render not found yet, retrying', { promptId, attempt, attempts });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('Prompt text not found in chat after send');
  }

  async function clickSend(btn, inputEl) {
    if (btn && isButtonEnabled(btn)) {
      console.log('[ClickSend] Dispatching click on enabled send button', {
        tagName: btn.tagName,
        ariaLabel: btn.getAttribute?.('aria-label') || '',
        testId: btn.getAttribute?.('data-testid') || '',
        type: btn.getAttribute?.('type') || '',
      });
      inputEl?.focus();
      btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      btn.click();
      return;
    }

    console.warn('[ClickSend] No enabled send button; dispatching Enter fallback', {
      hasButton: !!btn,
      buttonEnabled: isButtonEnabled(btn),
      hasInput: !!inputEl,
      inputLength: getInputTextLengthQuiet(inputEl),
    });
    inputEl?.focus();
    const down = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true });
    const press = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true });
    const up = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true });
    inputEl?.dispatchEvent(down);
    inputEl?.dispatchEvent(press);
    inputEl?.dispatchEvent(up);
  }

  function getChatGPTThinkingSignals(options = {}) {
    if (typeof chatStateTools.getChatGPTThinkingSignals === 'function') {
      return chatStateTools.getChatGPTThinkingSignals({
        stopButtonSelector: resolveStopButtonSelector('chatgpt', currentTargetSettings),
        targetSettings: currentTargetSettings,
        ...options,
      });
    }
    const composerRole = getChatGPTComposerRole();
    return {
      loadingShimmer: false,
      loadingShimmerHardBlock: false,
      staleLoadingShimmer: false,
      thinkingIndicator: false,
      activeToolStatus: false,
      stopPresent: composerRole.role === 'stop-active',
      confirmVisible: false,
      composerRole,
      active: composerRole.role === 'stop-active',
      hardActivityPresent: composerRole.role === 'stop-active',
      blockingReasons: composerRole.role === 'stop-active' ? ['stopButton'] : [],
      hardBlockingReasons: composerRole.role === 'stop-active' ? ['stopButton'] : [],
      staleActivityReasons: [],
      responseCompletionMarkers: [],
      responseCompletionMarkerNames: [],
      hasStableCapturedResponse: false,
      responseCompletionEvidence: false,
    };
  }

  function isChatGPTThinking() {
    return getChatGPTThinkingSignals().active;
  }

  function getChatGPTComposerRole(button) {
    if (typeof chatStateTools.getComposerActionRole === 'function') {
      return chatStateTools.getComposerActionRole(button || undefined);
    }
    return { role: 'missing', enabled: false, reason: 'missing' };
  }

  function isActiveStopButton(button) {
    if (typeof chatStateTools.isActiveStopButton === 'function') {
      return chatStateTools.isActiveStopButton(button || undefined);
    }
    return false;
  }

  function findChatGPTResponseCompletionMarkers(responseScope) {
    if (typeof chatStateTools.findResponseCompletionMarkers === 'function') {
      return chatStateTools.findResponseCompletionMarkers(responseScope);
    }
    return [];
  }

  function getChatGPTActivityDiagnostics(options = {}) {
    const signals = getChatGPTThinkingSignals(options);
    const diagnostics = signals?.activityDiagnostics || {};
    return {
      selectorUsed: diagnostics.selectorUsed || options?.stopButtonSelector || null,
      stopButtonCandidates: diagnostics.stopButtonCandidates || { selector: options?.stopButtonSelector || null, count: 0, candidates: [], invalidSelector: false },
      fallbackStopCandidates: diagnostics.fallbackStopCandidates || { selector: 'button[aria-label="Stop generating"], button[data-testid="stop-button"]', count: 0, candidates: [], invalidSelector: false },
      explicitStop: diagnostics.explicitStop || null,
      fallbackStop: diagnostics.fallbackStop || null,
      composerAction: diagnostics.composerAction || null,
      loadingShimmer: diagnostics.loadingShimmer || null,
      thinkingIndicator: diagnostics.thinkingIndicator || null,
      counts: diagnostics.counts || { stopButtonCandidates: 0, fallbackStopCandidates: 0, responseCompletionMarkers: 0 },
      hardBlockingReasons: diagnostics.hardBlockingReasons || signals?.hardBlockingReasons || [],
      staleActivityReasons: diagnostics.staleActivityReasons || signals?.staleActivityReasons || [],
      responseCompletionMarkers: diagnostics.responseCompletionMarkers || [],
      hasStableCapturedResponse: diagnostics.hasStableCapturedResponse || signals?.hasStableCapturedResponse || false,
      responseCompletionEvidence: diagnostics.responseCompletionEvidence || signals?.responseCompletionEvidence || false,
      activeToolStatus: diagnostics.activeToolStatus || signals?.activeToolStatus || false,
      confirmVisible: diagnostics.confirmVisible || signals?.confirmVisible || false,
      finalDecisionReason: diagnostics.finalDecisionReason || 'unknown',
    };
  }

  function waitForChatGPTSendWindow({ sendButton, inputEl, maxWaitMs = 60000, quietWindowMs = 1200, pollMs = 250 }) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let readySince = null;
      let lastDebugAt = 0;

      const check = () => {
        maybeClickConfirmButtons('waitForChatGPTSendWindow');
        const elapsed = Date.now() - start;
        const busy = isChatGPTThinking();
        const currentSendButton = findSendButtonForSite('chatgpt', inputEl) || sendButton;
        const directReady = currentSendButton ? isButtonEnabled(currentSendButton) : false;
        const canSend = directReady || isChatGPTReadyToSend(inputEl);
        if (elapsed - lastDebugAt >= 5000) {
          lastDebugAt = elapsed;
          console.log('[PreSendGuard] Still waiting for send window', {
            elapsed,
            busy,
            hasSendButton: !!currentSendButton,
            directReady,
            canSend,
            preSendQuietWindowMs: quietWindowMs,
            quietWindowMs,
            inputLength: getInputTextLengthQuiet(inputEl),
          });
        }

        if (!busy && canSend) {
          if (quietWindowMs <= 0) {
            console.log('[PreSendGuard] Quiet send window reached', {
              elapsed,
              preSendQuietWindowMs: quietWindowMs,
              quietWindowMs,
              reason: 'disabledQuietWindow',
            });
            resolve();
            return;
          }
          if (readySince === null) {
            readySince = Date.now();
          } else if (Date.now() - readySince >= quietWindowMs) {
            console.log('[PreSendGuard] Quiet send window reached', {
              elapsed,
              preSendQuietWindowMs: quietWindowMs,
              quietWindowMs,
            });
            resolve();
            return;
          }
        } else {
          if (readySince !== null) {
            console.log('[PreSendGuard] Busy signal returned; resetting quiet window', {
              elapsed,
              busy,
              canSend,
              preSendQuietWindowMs: quietWindowMs,
            });
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

  function getChatGPTPreSendQuietWindowMs(settings = currentTargetSettings) {
    const raw = Number(settings?.preSendQuietWindowMs ?? settings?.chatgptPreSendQuietWindowMs);
    if (!Number.isFinite(raw)) return 1200;
    return Math.min(60000, Math.max(0, Math.round(raw)));
  }

  function waitForEnabledSendButton({
    site = 'chatgpt',
    inputEl,
    settings = currentTargetSettings,
    maxWaitMs = 5000,
    pollMs = 100,
    reason = 'unknown',
  } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let settled = false;
      let observer = null;
      let interval = null;
      let timeout = null;

      const finish = (button, source) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        const payload = {
          reason,
          source,
          elapsedMs: Date.now() - startedAt,
          hasButton: !!button,
          buttonEnabled: isButtonEnabled(button),
          inputLength: getInputTextLengthQuiet(inputEl),
        };
        if (button) {
          console.log('[SendButtonObserver] Enabled send button found', payload);
        } else {
          console.warn('[SendButtonObserver] No enabled send button found before timeout', payload);
        }
        resolve(button || null);
      };

      const check = (source) => {
        const button = findSendButtonForSite(site, inputEl, settings);
        if (button && isButtonEnabled(button)) {
          finish(button, source);
        }
      };

      if (typeof MutationObserver === 'function' && (document.body || document.documentElement)) {
        observer = new MutationObserver(() => check('mutation'));
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-disabled', 'aria-label', 'class', 'data-testid', 'disabled', 'style', 'type'],
        });
      }

      interval = setInterval(() => check('interval'), pollMs);
      timeout = setTimeout(() => finish(null, 'timeout'), maxWaitMs);
      check('initial');
    });
  }

  async function recoverSendButtonAfterPreSendTimeout({
    promptId,
    site,
    inputEl,
    sendBtn,
    options,
    stopBtnSel,
    error,
    attempt = null,
  }) {
    console.warn('[PromptQueue] Pre-send guard timed out; trying enabled-button observer fallback', {
      promptId,
      attempt,
      error: error?.message || String(error),
      snapshot: buildPromptQueueDebugSnapshot({
        site,
        inputEl,
        sendBtn,
        stopButtonSelector: stopBtnSel,
        promptId,
        attempt,
      }),
    });

    const observedSendBtn = await waitForEnabledSendButton({
      site,
      inputEl,
      settings: options,
      maxWaitMs: 5000,
      reason: attempt === null ? 'pre-send-timeout' : 'retry-pre-send-timeout',
    });

    if (observedSendBtn) return observedSendBtn;
    throw error;
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

  function configureStopWordGuard(stopWord, caseSensitive) {
    activeStopWord = typeof stopWord === 'string' && stopWord.trim() ? stopWord.trim() : null;
    activeStopWordCaseSensitive = caseSensitive === true;
    stopWordGuardArmed = false;
    stopWordBlockedAutoConfirm = false;
  }

  function armStopWordGuard(source = 'unknown') {
    if (!activeStopWord || stopWordGuardArmed) return;
    stopWordGuardArmed = true;
    console.log('[StopWord] Guard armed', { source, stopWord: activeStopWord });
  }

  function blockAutoConfirmForStopWord(source = 'unknown') {
    if (stopWordBlockedAutoConfirm) return true;
    stopWordBlockedAutoConfirm = true;
    automationAborted = true;
    console.log('[StopWord] Blocking auto-confirm after stop word detection', {
      source,
      stopWord: activeStopWord,
    });
    return true;
  }

  function shouldBlockConfirmForStopWord(source = 'unknown') {
    if (automationAborted || stopWordBlockedAutoConfirm) return true;
    if (!stopWordGuardArmed || !activeStopWord) return false;
    if (!checkForStopWord(activeStopWord, activeStopWordCaseSensitive)) return false;
    return blockAutoConfirmForStopWord(source);
  }

  function isChatGPTReadyToSend(inputEl) {
    // Check if send button is enabled or if we're in a state where we can send
    const sendBtn = findSendButtonForSite('chatgpt', inputEl);
    if (sendBtn && isButtonEnabled(sendBtn)) return true;
    const regenPresent = document.querySelector('button:has([data-testid="regenerate-response-button"]) , button[aria-label*="Regenerate"]');
    const isThinking = isChatGPTThinking();
    const hasDraft = getInputTextLengthQuiet(inputEl || findPromptInput()) > 0;
    return (!!sendBtn || !!regenPresent || hasDraft) && !isThinking;
  }

  function buildPromptQueueDebugSnapshot({ site, inputEl, sendBtn, stopButtonSelector, promptId, attempt }) {
    const resolvedSite = site || detectSite();
    const resolvedSendBtn = sendBtn || findSendButtonForSite(resolvedSite, inputEl);
    const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
    const inputLength = getInputTextLengthQuiet(inputEl);
    return {
      promptId,
      attempt: Number.isFinite(attempt) ? attempt : null,
      site: resolvedSite,
      url: location.href,
      visibilityState: document.visibilityState,
      hasInputEl: !!inputEl,
      inputLength,
      hasSendButton: !!resolvedSendBtn,
      sendButtonEnabled: isButtonEnabled(resolvedSendBtn),
      stopButtonSelector: stopButtonSelector || null,
      stopButtonPresent: isActiveStopButton(stopBtn),
      isChatGPTThinking: resolvedSite === 'chatgpt' ? isChatGPTThinking() : null,
      hasConfirmDialog: isConfirmDialogVisible(),
      activeElementTag: document.activeElement?.tagName || null,
      activeElementId: document.activeElement?.id || null,
    };
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

    const site = detectSite();
    const resolved = typeof targetTools.resolveSelector === 'function'
      ? targetTools.resolveSelector('watchedElement', { site, settings: options || {} })
      : null;
    const selector = (resolved?.selector || options?.watchedElementSelector || DEFAULTS.watchedElementSelector || '').trim();
    if (!selector) return { enabled: false };

    const baselineElements = getElementsBySelector(selector);
    if (!baselineElements) return { enabled: false };

    const baselineCount = baselineElements.length;
    const baselineElementSet = new Set(baselineElements);

    console.log('[WatchGate] Baseline captured', {
      selector,
      baselineCount,
      source: resolved?.source || 'legacy',
    });
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

  function waitForCompletion({ sendButton, stopButtonSelector, messagesContainer, stableMs, maxWaitMs, pollIntervalMs, enableMaxWaitTimeout, stopWord, stopWordCaseSensitive, watchGate, promptText, inputEl }) {
    const site = detectSite();
    const effectiveStableMs = typeof stableMs === 'number' ? stableMs : DEFAULTS.stableMs;
    const effectiveMaxWaitMs = typeof maxWaitMs === 'number' ? maxWaitMs : DEFAULTS.maxWaitMs;
    const effectivePollMs = typeof pollIntervalMs === 'number' ? pollIntervalMs : DEFAULTS.pollIntervalMs;
    const enableTimeout = enableMaxWaitTimeout === false;
    const completionId = Math.random();

    console.log('[WaitForCompletion] Starting', { completionId, effectiveStableMs, effectiveMaxWaitMs, effectivePollMs, enableTimeout, stopWord, hasPromptText: !!promptText });
    emitStepUpdate({
      step: 'completion_wait',
      detail: 'Waiting for assistant response stability',
      durationMs: effectiveStableMs,
      log: false,
    });

    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastChange = Date.now();
      let lastStatusAt = 0;
      let lastResponseLength = 0;
      let responseStableSince = null;
      let responseSnapshot = { ok: false, responseLength: 0 };

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
        if (stopWord && checkForStopWord(stopWord, stopWordCaseSensitive)) {
          blockAutoConfirmForStopWord('waitForCompletion');
          console.log('[WaitForCompletion] Stop word detected, stopping automation', { completionId, stopWord });
          cleanup();
          resolve({ stoppedByStopWord: true });
          return;
        }
        maybeClickConfirmButtons('waitForCompletion');
        const elapsed = Date.now() - startTime;
        const stableFor = Date.now() - lastChange;
        const stopBtn = stopButtonSelector ? queryOneSafe(stopButtonSelector) : null;
        const stopBtnPresent = isActiveStopButton(stopBtn);
        let activeGenerationPresent = stopBtnPresent;
        let chatGptThinkingSignals = null;
        let chatGptActivityDiagnostics = null;
        let composerActionRole = null;

        let currentSendButton = sendButton;
        let canSend = isButtonEnabled(currentSendButton);
        if (site === 'chatgpt') {
          currentSendButton = findSendButtonForSite('chatgpt', inputEl || findPromptInput()) || sendButton;
          composerActionRole = getChatGPTComposerRole(currentSendButton);
          canSend = isButtonEnabled(currentSendButton) || isChatGPTReadyToSend(inputEl || findPromptInput());
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

        let responseStableFor = 0;
        if (site === 'chatgpt' && promptText) {
          responseSnapshot = captureLatestAssistantResponse(promptText);
          if (responseSnapshot.ok) {
            if (responseSnapshot.responseLength !== lastResponseLength) {
              lastResponseLength = responseSnapshot.responseLength;
              responseStableSince = Date.now();
            } else if (responseStableSince !== null) {
              responseStableFor = Date.now() - responseStableSince;
            }
          } else {
            responseStableSince = null;
            lastResponseLength = 0;
          }
        }

        if (site === 'chatgpt') {
          chatGptThinkingSignals = getChatGPTThinkingSignals({
            responseScope: responseSnapshot.responseScope,
            responseText: responseSnapshot.responseText,
            responseStableForMs: responseStableFor,
            stableMs: effectiveStableMs,
          });
          chatGptActivityDiagnostics = getChatGPTActivityDiagnostics({
            responseScope: responseSnapshot.responseScope,
            responseText: responseSnapshot.responseText,
            responseStableForMs: responseStableFor,
            stableMs: effectiveStableMs,
            stopButtonSelector,
          });
          composerActionRole = chatGptThinkingSignals.composerRole || composerActionRole;
          activeGenerationPresent = stopBtnPresent || chatGptThinkingSignals.active;
        }

        const domStableEnough = stableFor >= effectiveStableMs;
        const responseStableEnough = site === 'chatgpt' && responseSnapshot.ok && responseStableFor >= effectiveStableMs;
        const responseCompletionMarkers = site === 'chatgpt' && responseSnapshot.ok
          ? (chatGptThinkingSignals?.responseCompletionMarkers || findChatGPTResponseCompletionMarkers(responseSnapshot.responseScope))
          : [];
        const responseCompletionMarkerNames = responseCompletionMarkers.map((marker) => marker.label || marker.selector);
        const responseActionSatisfied = watchGateSatisfied || responseCompletionMarkers.length > 0;
        const hardChatGptActivityPresent = !!chatGptThinkingSignals?.hardActivityPresent;
        const activityBlockerReasons = chatGptThinkingSignals?.hardBlockingReasons || chatGptThinkingSignals?.blockingReasons || [];
        const composerStopActive = composerActionRole?.role === 'stop-active';
        const currentStopActive = !!(stopBtnPresent || composerStopActive || chatGptThinkingSignals?.stopPresent);
        const stopOnlyChatGptActivity = site === 'chatgpt'
          && activeGenerationPresent
          && !hardChatGptActivityPresent;
        const chatGptResponseComplete = responseStableEnough
          && responseActionSatisfied
          && !currentStopActive
          && !hardChatGptActivityPresent;
        const domComplete = domStableEnough && !activeGenerationPresent && canSend && watchGateSatisfied;
        const completeEnough = site === 'chatgpt' ? (chatGptResponseComplete || domComplete) : domComplete;
        const finalDecisionReason = site === 'chatgpt'
          ? (
            chatGptResponseComplete ? 'chatgptResponseComplete'
              : domComplete ? 'domComplete'
                : currentStopActive ? 'blocked:stopActive'
                  : hardChatGptActivityPresent ? `blocked:${activityBlockerReasons.join(',') || 'hardActivity'}`
                    : !responseActionSatisfied ? 'waiting:responseMarkersOrWatchGate'
                      : !responseStableEnough ? 'waiting:responseStability'
                        : !domStableEnough ? 'waiting:domStability'
                          : !canSend ? 'waiting:sendReady'
                            : 'waiting:unknown'
          )
          : (
            domComplete ? 'domComplete'
              : activeGenerationPresent ? 'blocked:activeGeneration'
                : !domStableEnough ? 'waiting:domStability'
                  : !canSend ? 'waiting:sendReady'
                    : !watchGateSatisfied ? 'waiting:watchGate'
                      : 'waiting:unknown'
          );

        if (elapsed - lastStatusAt >= 5000) {
          lastStatusAt = elapsed;
          emitStepUpdate({
            step: 'completion_wait',
            detail: responseSnapshot.ok ? 'Assistant response captured; waiting for stability' : 'Waiting for assistant response',
            durationMs: enableTimeout ? Math.max(0, effectiveMaxWaitMs - elapsed) : 0,
            endAt: enableTimeout ? Date.now() + Math.max(0, effectiveMaxWaitMs - elapsed) : 0,
            log: false,
          });
          console.log('[WaitForCompletion] Waiting status', {
            completionId,
            elapsed,
            stableFor,
            responseStableFor,
            responseCaptured: responseSnapshot.ok,
            responseLength: responseSnapshot.responseLength || 0,
            stopBtnPresent,
            activeGenerationPresent,
            hardChatGptActivityPresent,
            stopOnlyChatGptActivity,
            hasCurrentSendButton: !!currentSendButton,
            composerActionRole: composerActionRole?.role || null,
            responseCompletionMarkers: responseCompletionMarkerNames,
            activityBlockerReasons,
            staleActivityReasons: chatGptThinkingSignals?.staleActivityReasons || [],
            canSend,
            chatGptResponseComplete,
            watchGateSatisfied,
            finalDecisionReason,
            activityDiagnostics: site === 'chatgpt' ? chatGptActivityDiagnostics : null,
          });
        }

        if (completeEnough) {
          console.log('[WaitForCompletion] Completion condition met', { 
            completionId, 
            elapsed, 
            stableFor, 
            responseStableFor,
            responseCaptured: responseSnapshot.ok,
            stopBtnPresent, 
            activeGenerationPresent,
            composerActionRole: composerActionRole?.role || null,
            responseCompletionMarkers: responseCompletionMarkerNames,
            activityBlockerReasons,
            staleActivityReasons: chatGptThinkingSignals?.staleActivityReasons || [],
            canSend,
            chatGptResponseComplete,
            watchGateSatisfied,
            finalDecisionReason,
            activityDiagnostics: site === 'chatgpt' ? chatGptActivityDiagnostics : null,
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
            canSend,
            responseCaptured: responseSnapshot.ok,
            responseLength: responseSnapshot.responseLength || 0,
            activityBlockerReasons,
            staleActivityReasons: chatGptThinkingSignals?.staleActivityReasons || [],
            finalDecisionReason,
            activityDiagnostics: site === 'chatgpt' ? chatGptActivityDiagnostics : null,
          });
          cleanup();
          resolve({ timedOut: true, error: 'waitForCompletion timeout' });
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

      function buildWaitForStreamsLogPayload({
        elapsed,
        stopPresent,
        stillStreaming,
        chatGptThinkingSignals,
        chatGptActivityDiagnostics,
        finalDecisionReason,
      }) {
        return {
          site,
          stopButtonSelector: stopButtonSelector || null,
          elapsed,
          enableTimeout: enableTimeoutCheck,
          noStopButtonCount,
          requiredNoStopChecks,
          stopPresent,
          stillStreaming,
          explicitStop: chatGptActivityDiagnostics?.explicitStop || null,
          fallbackStop: chatGptActivityDiagnostics?.fallbackStop || null,
          composerAction: chatGptActivityDiagnostics?.composerAction || null,
          candidateCounts: {
            stopButtonCandidates: chatGptActivityDiagnostics?.counts?.stopButtonCandidates ?? 0,
            fallbackStopCandidates: chatGptActivityDiagnostics?.counts?.fallbackStopCandidates ?? 0,
          },
          hardBlockingReasons: chatGptThinkingSignals?.hardBlockingReasons || (stopPresent ? ['stopButton'] : []),
          staleActivityReasons: chatGptThinkingSignals?.staleActivityReasons || [],
          finalDecisionReason,
          activityDiagnostics: chatGptActivityDiagnostics || null,
        };
      }

      const checkStop = () => {
        maybeClickConfirmButtons('waitForStreamsToStop');
        const elapsed = Date.now() - startTime;
        const stopBtn = stopButtonSelector ? queryOneSafe(stopButtonSelector) : null;
        const stopPresent = isActiveStopButton(stopBtn);

        let stillStreaming = stopPresent;
        let chatGptThinkingSignals = null;
        let chatGptActivityDiagnostics = null;
        let finalDecisionReason = stopPresent ? 'blocked:stopButton' : 'waiting:quietChecks';

        // For ChatGPT, also treat thinking indicators as active streaming
        if (site === 'chatgpt') {
          chatGptThinkingSignals = getChatGPTThinkingSignals({ stopButtonSelector, targetSettings: currentTargetSettings });
          chatGptActivityDiagnostics = getChatGPTActivityDiagnostics({ stopButtonSelector, targetSettings: currentTargetSettings });
          if (chatGptThinkingSignals.active) {
            stillStreaming = true;
            finalDecisionReason = `blocked:${chatGptActivityDiagnostics.finalDecisionReason || 'chatgptActivity'}`;
          } else if (!stopPresent) {
            finalDecisionReason = noStopButtonCount + 1 >= requiredNoStopChecks
              ? 'resolved:quietChecksSatisfied'
              : 'waiting:quietChecks';
          }
        }

        const diagnosticPayload = buildWaitForStreamsLogPayload({
          elapsed,
          stopPresent,
          stillStreaming,
          chatGptThinkingSignals,
          chatGptActivityDiagnostics,
          finalDecisionReason,
        });

        if (!stillStreaming) {
          noStopButtonCount++;
          console.log('[WaitForStreamsToStop] No stop button detected', {
            ...diagnosticPayload,
            noStopButtonCount,
          });
          
          // Require multiple consecutive checks without stop button to confirm not streaming
          if (noStopButtonCount >= requiredNoStopChecks) {
            console.log('[WaitForStreamsToStop] Confirmed: No active stream, safe to proceed', {
              elapsed,
              noStopButtonCount,
              requiredNoStopChecks,
              selectorUsed: stopButtonSelector || null,
              finalDecisionReason: 'resolved:quietChecksSatisfied',
              activityDiagnostics: site === 'chatgpt' ? chatGptActivityDiagnostics : null,
            });
            resolve();
            return;
          }
        } else {
          // Reset counter if stop button appears
          noStopButtonCount = 0;
          console.log('[WaitForStreamsToStop] Stop button detected, resetting counter', {
            ...diagnosticPayload,
            noStopButtonCount,
          });
        }

        if (elapsed > effectiveMaxWaitMs) {
          // Timeout: reject instead of proceeding with potentially active stream
          console.error('[WaitForStreamsToStop] Timeout waiting for stream to stop after ' + effectiveMaxWaitMs + 'ms. Stop button still present.', {
            elapsed,
            selectorUsed: stopButtonSelector || null,
            stopPresent,
            activityBlockerReasons: chatGptThinkingSignals?.hardBlockingReasons || (stopPresent ? ['stopButton'] : []),
            staleActivityReasons: chatGptThinkingSignals?.staleActivityReasons || [],
            responseCompletionMarkers: chatGptThinkingSignals?.responseCompletionMarkerNames || [],
            finalDecisionReason,
            activityDiagnostics: site === 'chatgpt' ? chatGptActivityDiagnostics : null,
          });
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
        maybeClickConfirmButtons('waitForStreamStart');
        const elapsed = Date.now() - startTime;
        const stopBtn = stopButtonSelector ? document.querySelector(stopButtonSelector) : null;
        const stopPresent = isActiveStopButton(stopBtn);

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
    currentTargetSettings = options || {};
  
    // Wait for any currently processing prompt to complete
    if (currentPromptId !== null && currentPromptId !== promptId) {
      const queueMeta = { 
        newPromptId: promptId, 
        currentPromptId, 
        timestamp: Date.now() 
      };
      console.warn('[PromptQueue] QUEUED: Waiting for current prompt to complete', queueMeta, JSON.stringify(queueMeta));
      
      const enableQueueTimeout = options?.enableMaxWaitTimeout === false;
      // Finite max-wait mode waits up to 30 seconds for current prompt to finish.
      // Infinite mode waits until currentPromptId is cleared by the previous prompt.
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
    configureStopWordGuard(options?.enableStopWord ? options?.stopWord : null, options?.stopWordCaseSensitive);
    console.log('[PromptQueue] Starting processing', { promptId, timestamp: Date.now(), options });
    
    // Set a safety timeout to force cleanup if this prompt takes too long
    const isParallelDispatch = options?.parallelDispatchMode === true;
    const enablePromptTimeout = options?.enableMaxWaitTimeout === false && !isParallelDispatch;
    const maxPromptDuration = (options?.maxWaitMs || DEFAULTS.maxWaitMs) + 10000; // Add 10s buffer
    console.log('[PromptQueue] Prompt timeout configuration', {
      promptId,
      isParallelDispatch,
      enablePromptTimeout,
      maxPromptDuration,
      maxWaitMs: options?.maxWaitMs || DEFAULTS.maxWaitMs,
      stableMs: options?.stableMs || DEFAULTS.stableMs,
      pollIntervalMs: options?.pollIntervalMs || DEFAULTS.pollIntervalMs,
    });
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
      emitSelectorHealth(site, options);
      const cfg = selectorsForSite(site);

      let inputEl = findPromptInputForSite(site, options);
      let sendBtn = findSendButtonForSite(site, inputEl, options);
      const stopBtnSel = resolveStopButtonSelector(site, options);
      let messagesContainer = queryFirst(cfg.messagesContainerCandidates);
      let promptSubmittedNotified = false;

      async function notifyPromptSubmitted(reason) {
        if (promptSubmittedNotified) return;
        promptSubmittedNotified = true;
        try {
          const submittedResp = await chrome.runtime.sendMessage({
            type: 'PROMPT_SUBMITTED',
            promptId,
            reason,
          });
          console.log('[PromptQueue] PROMPT_SUBMITTED sent; background should release cross-tab send lock now', {
            promptId,
            reason,
            response: submittedResp || null,
          });
        } catch (submissionErr) {
          console.warn('[PromptQueue] Failed to send PROMPT_SUBMITTED', {
            promptId,
            reason,
            error: submissionErr?.message || String(submissionErr),
          });
        }
      }
      
      console.log('[PromptQueue] Initial element detection', { 
        hasInputEl: !!inputEl, 
        hasSendBtn: !!sendBtn, 
        stopBtnSel, 
        hasMessagesContainer: !!messagesContainer 
      });

      if ((site === 'chatgpt' || site === 'gemini' || site === 'claude') && !inputEl) {
        console.log('[PromptQueue] Input not found, attempting to locate and focus');
        const composer = document.querySelector('#prompt-textarea, .ProseMirror[contenteditable], form textarea, [contenteditable], textarea.wcDTda_fallbackTextarea');
        composer?.scrollIntoView({ block: 'end' });
        composer?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 150));
        inputEl = findPromptInputForSite(site, options) || document.querySelector('#prompt-textarea, .ProseMirror[contenteditable], form textarea, [contenteditable], textarea.wcDTda_fallbackTextarea');
        sendBtn = sendBtn || findSendButtonForSite(site, inputEl, options);
        messagesContainer = messagesContainer || queryFirst(cfg.messagesContainerCandidates) || document.body;
        console.log('[PromptQueue] After focus attempt', { hasInputEl: !!inputEl, hasSendBtn: !!sendBtn });
      }

      const watchGate = buildWatchGate(options);

      // Wait for any active streaming/processing to complete before sending
      const streamWaitStartedAt = Date.now();
      emitStepUpdate({ step: 'waiting_for_response', promptId, detail: 'Waiting for existing stream to stop', log: options?.perStepConsoleLogging === true });
      console.log('[PromptQueue] Waiting for streams to stop', { promptId, enableTimeout: false });
      try {
        await waitForStreamsToStop({ stopButtonSelector: stopBtnSel, maxWaitMs: undefined, enableTimeout: false });
      } catch (e) {
        console.error('[PromptQueue] waitForStreamsToStop failed', { promptId, error: e?.message });
        throw e;
      }
      console.log('[PromptQueue] Streams stopped, proceeding', {
        promptId,
        elapsedMs: Date.now() - streamWaitStartedAt,
        snapshot: buildPromptQueueDebugSnapshot({
          site,
          inputEl,
          sendBtn,
          stopButtonSelector: stopBtnSel,
          promptId,
        }),
      });

      const composerReadyMaxWaitMs = Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 10000);
      emitStepUpdate({ step: 'waiting_for_tab', promptId, detail: 'Waiting for visible composer', durationMs: composerReadyMaxWaitMs, endAt: Date.now() + composerReadyMaxWaitMs, log: options?.perStepConsoleLogging === true });
      console.log('[PromptQueue] Waiting for composer readiness', {
        promptId,
        composerReadyMaxWaitMs,
      });
      try {
        inputEl = await waitForComposerReady({
          site,
          settings: options,
          inputEl,
          maxWaitMs: composerReadyMaxWaitMs,
          stableWindowMs: 300,
          pollMs: 100,
        });
      } catch (readyErr) {
        console.error('[PromptQueue] Composer readiness wait failed', {
          promptId,
          error: readyErr?.message || String(readyErr),
          snapshot: buildPromptQueueDebugSnapshot({
            site,
            inputEl,
            sendBtn,
            stopButtonSelector: stopBtnSel,
            promptId,
          }),
        });
        throw readyErr;
      }

      if (!inputEl) throw new Error('Could not find chat input on this page.');

      emitStepUpdate({ step: 'populating', promptId, detail: 'Writing prompt into visible composer', log: options?.perStepConsoleLogging === true });
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
          snapshot: buildPromptQueueDebugSnapshot({
            site,
            inputEl,
            sendBtn,
            stopButtonSelector: stopBtnSel,
            promptId,
          }),
        });
        throw new Error('Input field empty before sending');
      }
      console.log('[PromptQueue] Final input verified before send', { promptId, finalLength: finalNormalized.length });
      if (options?.dryRunPopulateOnly === true) {
        emitStepUpdate({ step: 'complete', promptId, detail: 'Dry-run populated composer', log: options?.perStepConsoleLogging === true });
        console.log('[PromptQueue] Dry-run populate complete; send skipped', { promptId, finalLength: finalNormalized.length });
        try {
          await chrome.runtime.sendMessage({
            type: 'RESPONSE_COMPLETE',
            promptId,
            dryRun: true,
            site,
            url: location.href,
          });
        } catch (_) {}
        return;
      }
      const postPopulateDelayWindow = coerceDelayWindow(options);
      const postPopulateDelayMs = randomDelayFromWindow(postPopulateDelayWindow);
      if (postPopulateDelayMs > 0) {
        console.log('[PromptQueue] Waiting post-populate delay before send', {
          promptId,
          postPopulateDelayMs,
          minMs: postPopulateDelayWindow.minMs,
          maxMs: postPopulateDelayWindow.maxMs,
        });
        await delayWithStatus({
          step: 'post_populate_delay',
          promptId,
          durationMs: postPopulateDelayMs,
          detail: 'Waiting before send click',
          log: options?.perStepConsoleLogging === true,
        });
      }
      sendBtn = findSendButtonForSite(site, inputEl, options) || sendBtn;

      if (site === 'chatgpt') {
        const preSendMaxWaitMs = Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 60000);
        const configuredQuietWindowMs = getChatGPTPreSendQuietWindowMs(options);
        emitStepUpdate({ step: 'pre_send_quiet_window', promptId, detail: 'Waiting for ChatGPT send window', durationMs: preSendMaxWaitMs, endAt: Date.now() + preSendMaxWaitMs, log: options?.perStepConsoleLogging === true });
        console.log('[PromptQueue] Waiting for ChatGPT pre-send quiet window', {
          promptId,
          preSendMaxWaitMs,
          preSendQuietWindowMs: configuredQuietWindowMs,
          quietWindowMs: configuredQuietWindowMs,
        });
        try {
          await waitForChatGPTSendWindow({
            sendButton: sendBtn,
            inputEl,
            maxWaitMs: preSendMaxWaitMs,
            quietWindowMs: configuredQuietWindowMs,
            pollMs: 250,
          });
        } catch (preSendErr) {
          console.error('[PromptQueue] Pre-send quiet window failed', {
            promptId,
            error: preSendErr?.message || String(preSendErr),
            snapshot: buildPromptQueueDebugSnapshot({
              site,
              inputEl,
              sendBtn,
              stopButtonSelector: stopBtnSel,
              promptId,
            }),
          });
          sendBtn = await recoverSendButtonAfterPreSendTimeout({
            promptId,
            site,
            inputEl,
            sendBtn,
            options,
            stopBtnSel,
            error: preSendErr,
          });
        }
      }
      
      emitStepUpdate({ step: 'sending', promptId, detail: 'Clicking send button', log: options?.perStepConsoleLogging === true });
      console.log('[PromptQueue] Clicking send button', {
        promptId,
        hasSendBtn: !!sendBtn,
        sendButtonEnabled: isButtonEnabled(sendBtn),
      });
      sendBtn = findSendButtonForSite(site, inputEl, options) || sendBtn;
      await clickSend(sendBtn, inputEl);
      await notifyPromptSubmitted('send-click-dispatched');

      let attempt = 0;
      const maxAttempts = 2;
      let streamStarted = false;

      while (attempt < maxAttempts && !streamStarted) {
        attempt += 1;
        emitStepUpdate({ step: 'waiting_for_response', promptId, detail: 'Verifying stream start', log: options?.perStepConsoleLogging === true });
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
              matchedRenderedPrompt: true
            });
            streamStarted = true;
            break;
          }
          console.warn('[PromptQueue] No active stream detected and no rendered message, re-attempting send', {
            promptId,
            attempt,
            maxAttempts,
            snapshot: buildPromptQueueDebugSnapshot({
              site,
              inputEl,
              sendBtn,
              stopButtonSelector: stopBtnSel,
              promptId,
              attempt,
            }),
          });
          await new Promise((r) => setTimeout(r, 250));
          if (site === 'chatgpt') {
            const retryPreSendMaxWaitMs = Math.min(options?.maxWaitMs || DEFAULTS.maxWaitMs, 60000);
            const configuredQuietWindowMs = getChatGPTPreSendQuietWindowMs(options);
            console.log('[PromptQueue] Waiting for ChatGPT pre-send quiet window before retry', {
              promptId,
              attempt,
              retryPreSendMaxWaitMs,
              preSendQuietWindowMs: configuredQuietWindowMs,
              quietWindowMs: configuredQuietWindowMs,
            });
            try {
              await waitForChatGPTSendWindow({
                sendButton: sendBtn,
                inputEl,
                maxWaitMs: retryPreSendMaxWaitMs,
                quietWindowMs: configuredQuietWindowMs,
                pollMs: 250,
              });
            } catch (retryPreSendErr) {
              console.error('[PromptQueue] Retry pre-send quiet window failed', {
                promptId,
                attempt,
                error: retryPreSendErr?.message || String(retryPreSendErr),
                snapshot: buildPromptQueueDebugSnapshot({
                  site,
                  inputEl,
                  sendBtn,
                  stopButtonSelector: stopBtnSel,
                  promptId,
                  attempt,
                }),
              });
              sendBtn = await recoverSendButtonAfterPreSendTimeout({
                promptId,
                site,
                inputEl,
                sendBtn,
                options,
                stopBtnSel,
                error: retryPreSendErr,
                attempt,
              });
            }
          }
          sendBtn = findSendButtonForSite(site, inputEl, options) || sendBtn;
          await clickSend(sendBtn, inputEl);
          await notifyPromptSubmitted('retry-send-click-dispatched');
        }
      }

      if (!streamStarted) {
        console.error('[PromptQueue] Stream start verification failed after retries', {
          promptId,
          maxAttempts,
          snapshot: buildPromptQueueDebugSnapshot({
            site,
            inputEl,
            sendBtn,
            stopButtonSelector: stopBtnSel,
            promptId,
            attempt: maxAttempts,
          }),
        });
        throw new Error('No active stream detected after sending prompt (after retries)');
      }
      console.log('[PromptQueue] Stream detected or render found, proceeding to render verification', { promptId, streamStarted });

      await notifyPromptSubmitted('stream-start-detected');

      // Verify the prompt text appears in the rendered chat (e.g., ChatGPT message bubble)
      try {
        await verifyPromptRendered({ text, promptId, attempts: 4, delayMs: 500 });
        console.log('[PromptQueue] Render verification succeeded', { promptId });
      } catch (e) {
        console.error('[PromptQueue] Prompt render verification failed', { promptId, error: e?.message });
        throw e;
      }

      const enableCompletionTimeout = options?.enableMaxWaitTimeout === false;
      const effectiveStopWord = options?.enableStopWord ? options?.stopWord : null;
      armStopWordGuard('PromptQueue');
      emitStepUpdate({
        step: 'completion_wait',
        promptId,
        detail: 'Waiting for completion',
        durationMs: enableCompletionTimeout ? (options?.maxWaitMs || DEFAULTS.maxWaitMs) : 0,
        endAt: enableCompletionTimeout ? Date.now() + (options?.maxWaitMs || DEFAULTS.maxWaitMs) : 0,
        log: options?.perStepConsoleLogging === true
      });
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
              promptText: text,
              inputEl,
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
            promptText: text,
            inputEl,
          });
        }

        // Check if automation was stopped by stop word
        if (result?.stoppedByStopWord) {
          blockAutoConfirmForStopWord('PromptQueueResult');
          console.log('[PromptQueue] Automation stopped by stop word', { promptId });
          automationAborted = true; // Signal queued prompts to abort
          try {
            chrome.runtime.sendMessage({ type: 'RESPONSE_COMPLETE', promptId, stoppedByStopWord: true });
          } catch (_) {}
          return;
        }
        if (result?.timedOut) {
          throw new Error(result.error || 'waitForCompletion timeout');
        }
        console.log('[PromptQueue] Completion wait finished (no stop word)', { promptId });
      } catch (e) {
        console.error('[PromptQueue] waitForCompletion failed', {
          promptId,
          error: e?.message,
          snapshot: buildPromptQueueDebugSnapshot({
            site,
            inputEl,
            sendBtn,
            stopButtonSelector: stopBtnSel,
            promptId,
          }),
        });
        throw e;
      }
      
      const capturedResponse = captureLatestAssistantResponse(text);
      console.log('[PromptQueue] Completion detected, sending RESPONSE_COMPLETE', {
        promptId,
        responseCaptured: capturedResponse.ok,
        responseLength: capturedResponse.responseLength,
      });
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'RESPONSE_COMPLETE',
          promptId,
          responseText: capturedResponse.responseText,
          site: capturedResponse.site,
          url: capturedResponse.url,
        });
        console.log('[PromptQueue] RESPONSE_COMPLETE sent, got response', { promptId, resp });
      } catch (e) {
        console.error('[PromptQueue] Failed to send RESPONSE_COMPLETE', { promptId, error: e?.message });
      }
    } catch (e) {
      const catchSite = detectSite();
      const catchCfg = selectorsForSite(catchSite);
      const catchInputEl = findPromptInputForSite(catchSite, options);
      const catchSendBtn = findSendButtonForSite(catchSite, catchInputEl, options);
      const catchStopBtnSel = resolveStopButtonSelector(catchSite, options);
      console.error('[PromptQueue] Error during processing', { 
        promptId, 
        error: e?.message, 
        stack: e?.stack,
        timestamp: Date.now(),
        snapshot: buildPromptQueueDebugSnapshot({
          site: catchSite,
          inputEl: catchInputEl,
          sendBtn: catchSendBtn,
          stopButtonSelector: catchStopBtnSel,
          promptId,
        }),
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

  if (window.__PROMPT_QUEUE_TEST__) {
    window.PromptQueueContentTest = {
      clickSend,
      detectSite,
      findPromptInputForSite,
      findRenderedMessageMatch,
      findSendButtonForSite,
      isButtonEnabled,
      isChatGPTReadyToSend,
      resolveStopButtonSelector,
      selectorsForSite,
      setTextInInput,
      waitForComposerReady,
      waitForCompletion,
      waitForChatGPTSendWindow,
      waitForStreamsToStop,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (message?.type === 'PING') {
          console.log('[MessageListener] PING received');
          sendResponse({ ok: true, timestamp: Date.now(), version: CONTENT_SCRIPT_VERSION });
          return;
        }

        if (message?.type === 'PING_CURRENT') {
          console.log('[MessageListener] PING_CURRENT received');
          sendResponse({ ok: true, timestamp: Date.now(), version: CONTENT_SCRIPT_VERSION });
          return;
        }

        if (message?.type === 'SETTINGS_UPDATED' && message.settings) {
          currentTargetSettings = message.settings || {};
          setAutoConfirmDialogs(message.settings.autoConfirmDialogs === true, 'settings_updated');
          setDebugLoggingEnabled(message.settings.debugLoggingEnabled === true);
          emitSelectorHealth(detectSite(), currentTargetSettings);
          sendResponse({ ok: true });
          return;
        }

        if (message?.type === 'GET_MEMORY_SOURCE') {
          const result = getMemorySource(message.source || 'prompt_box');
          sendResponse({ ok: true, source: result.source, text: result.text, textLength: result.text.length });
          return;
        }

        if (message?.type === 'INSERT_MEMORY_PACK') {
          const result = insertMemoryPack(message.markdown, message.behavior);
          sendResponse(result);
          return;
        }

        if ((message?.type === 'SEND_PROMPT_CURRENT' || message?.type === 'SEND_PROMPT') && typeof message.text === 'string') {
          const promptId = message.promptId || Math.random();
          if (message.options && typeof message.options.autoConfirmDialogs === 'boolean') {
            setAutoConfirmDialogs(message.options.autoConfirmDialogs, 'send_prompt');
          }
          if (message.options && typeof message.options.debugLoggingEnabled === 'boolean') {
            setDebugLoggingEnabled(message.options.debugLoggingEnabled);
          }
          console.log('[MessageListener] SEND_PROMPT received', { 
            promptId, 
            textLength: message.text?.length,
            currentPromptId,
            index: message.index,
            total: message.total,
            timestamp: Date.now()
          });
          // Acknowledge immediately so background can fan-out without waiting for completion.
          sendResponse({ ok: true, accepted: true, promptId });
          Promise.resolve()
            .then(async () => {
              await PromptQueue(message.text, message.options, promptId);
              console.log('[MessageListener] PromptQueue completed', { promptId, timestamp: Date.now() });
            })
            .catch(async (queueErr) => {
              console.error('[MessageListener] PromptQueue background execution failed', {
                promptId,
                error: queueErr?.message || String(queueErr),
              });
              try {
                await chrome.runtime.sendMessage({
                  type: 'RESPONSE_COMPLETE',
                  promptId,
                  error: String(queueErr?.message || queueErr),
                });
              } catch (_) {}
            });
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

  chrome.runtime.sendMessage({ type: 'CONTENT_READY', version: CONTENT_SCRIPT_VERSION }).catch(() => {});
  refreshAutoConfirmSetting('content_ready');
})();
