(function () {
  const CHAT_STATE_VERSION = '2026-06-04.chat-state-v2';
  if (window.PromptQueueChatState?.version === CHAT_STATE_VERSION) return;

  const RESPONSE_ACTION_SELECTORS = [
    'button[data-testid="copy-turn-action-button"]',
    'button[aria-label="Copy response"]',
    'button[aria-label="Good response"]',
    'button[aria-label="Bad response"]',
  ];

  function isElementVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.offsetParent !== null || el.isConnected === true;
  }

  function isButtonEnabled(btn) {
    if (!btn) return false;
    const disabled = btn.getAttribute('disabled') !== null
      || btn.getAttribute('aria-disabled') === 'true'
      || btn.ariaDisabled === 'true';
    const opacity = parseFloat(getComputedStyle(btn).opacity || '1');
    return !disabled && opacity > 0.5;
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getComposerActionButton() {
    return document.querySelector('button#composer-submit-button');
  }

  function queryOneSafe(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      return document.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function getComposerActionRole(button = getComposerActionButton()) {
    if (!button) return { role: 'missing', enabled: false, reason: 'missing' };
    const enabled = isButtonEnabled(button);
    const label = normalizeText(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent);
    const testId = normalizeText(button.getAttribute('data-testid'));
    const type = normalizeText(button.getAttribute('type'));
    const labelHasStop = /\bstop\b|stop answering|stop generating|stop streaming/.test(label);
    const labelHasSend = /\bsend\b|submit|send prompt|send message/.test(`${label} ${type}`);
    const testIdHasStop = /\bstop\b|stop-button/.test(testId);
    const testIdHasSend = /\bsend\b|send-button/.test(testId);
    const hasStop = labelHasStop || (testIdHasStop && !labelHasSend);
    const hasSend = labelHasSend || testIdHasSend;
    if (hasSend && enabled) return { role: 'send-ready', enabled, reason: labelHasSend ? 'send-label' : 'send-testid' };
    if (hasStop && enabled) return { role: 'stop-active', enabled, reason: labelHasStop ? 'stop-label' : 'stop-testid' };
    if (hasSend) return { role: 'send-disabled', enabled, reason: labelHasSend ? 'send-disabled-label' : 'send-disabled-testid' };
    if (hasStop) return { role: 'stop-disabled', enabled, reason: labelHasStop ? 'stop-disabled-label' : 'stop-disabled-testid' };
    return { role: enabled ? 'unknown-enabled' : 'idle-disabled', enabled, reason: 'unknown' };
  }

  function isComposerActionButton(button) {
    return !!button && button.matches?.('button#composer-submit-button');
  }

  function isActiveStopButton(button) {
    if (!button || !isButtonEnabled(button) || !isElementVisible(button)) return false;
    if (isComposerActionButton(button)) return getComposerActionRole(button).role === 'stop-active';
    const label = normalizeText(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent);
    const testId = normalizeText(button.getAttribute('data-testid'));
    const combined = `${label} ${testId}`;
    const hasSend = /\bsend\b|send prompt|send message|send-button/.test(combined);
    const hasStop = /\bstop\b|stop answering|stop generating|stop streaming|stop-button/.test(combined);
    return hasStop && !hasSend;
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
      if (tailTurns.some((turn) => turn.contains(candidate))) return candidate;
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
        const text = normalizeText(node.textContent || node.innerText || '');
        if (!text) continue;
        if (inactivePatterns.some((pattern) => pattern.test(text))) continue;
        if (activePatterns.some((pattern) => pattern.test(text))) return true;
      }
    }
    return false;
  }

  function isConfirmButton(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag !== 'button') return false;
    if (normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label')) !== 'confirm') return false;
    return isButtonEnabled(el) && isElementVisible(el);
  }

  function isConfirmDialogVisible() {
    return Array.from(document.querySelectorAll('button')).some(isConfirmButton);
  }

  function getChatGPTThinkingSignals({ stopButtonSelector = '', targetSettings = {} } = {}) {
    const tailTurns = getTailConversationTurns(2);
    const loadingShimmer = findElementInTailTurns('.loading-shimmer', tailTurns);
    const thinkingIndicator = findElementInTailTurns('[class*="thinking"], [data-testid*="thinking"]', tailTurns);
    const activeToolStatus = hasActiveToolStatusInTailTurns(tailTurns);
    const explicitStop = queryOneSafe(stopButtonSelector);
    const fallbackStop = queryOneSafe('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    const composerRole = getComposerActionRole();
    const stopPresent = isActiveStopButton(explicitStop)
      || isActiveStopButton(fallbackStop)
      || composerRole.role === 'stop-active';
    const confirmVisible = isConfirmDialogVisible();
    const reasons = [];
    if (stopPresent) reasons.push('stopButton');
    if (loadingShimmer) reasons.push('loadingShimmer');
    if (thinkingIndicator) reasons.push('thinkingIndicator');
    if (activeToolStatus) reasons.push('activeToolStatus');
    if (confirmVisible) reasons.push('confirmDialog');
    return {
      loadingShimmer: !!loadingShimmer,
      thinkingIndicator: !!thinkingIndicator,
      activeToolStatus: !!activeToolStatus,
      stopPresent,
      confirmVisible,
      composerRole,
      active: reasons.length > 0,
      blockingReasons: reasons,
      targetSettings,
    };
  }

  function getLatestAssistantTurn() {
    const candidates = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"], article[data-turn-id], [data-message-author-role="assistant"]'));
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      const role = node.getAttribute?.('data-message-author-role') || '';
      const text = normalizeText(node.textContent || '');
      if (role === 'assistant' || !/\bqueued prompt\b/.test(text)) return node;
    }
    return null;
  }

  function findResponseCompletionMarkers(scope = getLatestAssistantTurn()) {
    const root = scope || document;
    const markers = [];
    for (const selector of RESPONSE_ACTION_SELECTORS) {
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch (_) {
        nodes = [];
      }
      for (const node of nodes) {
        if (!node || !isElementVisible(node)) continue;
        const label = node.getAttribute('aria-label') || node.getAttribute('data-testid') || node.textContent || selector;
        markers.push({ selector, label: String(label).slice(0, 80) });
      }
    }
    return markers;
  }

  window.PromptQueueChatState = Object.freeze({
    version: CHAT_STATE_VERSION,
    findResponseCompletionMarkers,
    getChatGPTThinkingSignals,
    getComposerActionButton,
    getComposerActionRole,
    getLatestAssistantTurn,
    responseActionSelectors: RESPONSE_ACTION_SELECTORS.slice(),
  });
})();
