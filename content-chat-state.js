(function () {
  const CHAT_STATE_VERSION = '2026-06-04.chat-state-v3';
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

  function getNodeTextLength(node) {
    return String(node?.innerText || node?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .length;
  }

  function getClassSnippet(node) {
    return String(node?.className || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || null;
  }

  function getRectSnapshot(node) {
    if (!node?.getBoundingClientRect) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: Number.isFinite(rect.x) ? Math.round(rect.x) : 0,
      y: Number.isFinite(rect.y) ? Math.round(rect.y) : 0,
      width: Number.isFinite(rect.width) ? Math.round(rect.width) : 0,
      height: Number.isFinite(rect.height) ? Math.round(rect.height) : 0,
    };
  }

  function describeNode(node, extras = {}) {
    if (!node) return null;
    return {
      tag: node.tagName?.toLowerCase() || null,
      id: node.id || null,
      role: node.getAttribute?.('role') || null,
      ariaLabel: node.getAttribute?.('aria-label') || null,
      textLength: getNodeTextLength(node),
      dataTestId: node.getAttribute?.('data-testid') || null,
      disabled: node.getAttribute?.('disabled') !== null || node.disabled === true || node.getAttribute?.('aria-disabled') === 'true',
      visible: isElementVisible(node),
      rect: getRectSnapshot(node),
      classSnippet: getClassSnippet(node),
      ...extras,
    };
  }

  function getResponseActionLabel(node, selector) {
    const values = [
      node?.getAttribute?.('aria-label'),
      node?.getAttribute?.('data-testid'),
      selector,
    ].map((value) => String(value || '').toLowerCase());
    if (values.some((value) => value.includes('copy-turn-action-button') || value.includes('copy response'))) return 'Copy response';
    if (values.some((value) => value.includes('good response'))) return 'Good response';
    if (values.some((value) => value.includes('bad response'))) return 'Bad response';
    return 'Response action';
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

  function getComposerActionDiagnostics(button = getComposerActionButton()) {
    const role = getComposerActionRole(button);
    return describeNode(button, {
      enabled: role.enabled,
      roleDecision: role.role,
      roleReason: role.reason,
    });
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

  function describeCandidateNodes(selector, limit = 5) {
    if (!selector || typeof selector !== 'string') {
      return { selector: selector || null, count: 0, candidates: [], invalidSelector: false };
    }
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (_) {
      return { selector, count: 0, candidates: [], invalidSelector: true };
    }
    return {
      selector,
      count: nodes.length,
      candidates: nodes.slice(0, limit).map((node, index) => describeNode(node, { index })),
      invalidSelector: false,
    };
  }

  function buildResponseEvidence({
    responseScope = null,
    responseText = '',
    responseStableForMs = 0,
    stableMs = 0,
  } = {}) {
    const scope = responseScope || getLatestAssistantTurn();
    const responseCompletionMarkers = findResponseCompletionMarkers(scope);
    const stableThreshold = Math.max(0, Number(stableMs) || 0);
    const stableFor = Math.max(0, Number(responseStableForMs) || 0);
    const normalizedResponseText = normalizeText(responseText);
    const hasStableCapturedResponse = !!normalizedResponseText && stableFor >= stableThreshold;
    return {
      scope,
      responseCompletionMarkers,
      responseCompletionMarkerNames: responseCompletionMarkers.map((marker) => marker.label || marker.selector),
      hasStableCapturedResponse,
      responseCompletionEvidence: responseCompletionMarkers.length > 0 && hasStableCapturedResponse,
    };
  }

  function classifyChatGPTDomActivity({
    stopButtonSelector = '',
    targetSettings = {},
    responseScope = null,
    responseText = '',
    responseStableForMs = 0,
    stableMs = 0,
  } = {}) {
    const tailTurns = getTailConversationTurns(2);
    const responseEvidence = buildResponseEvidence({
      responseScope,
      responseText,
      responseStableForMs,
      stableMs,
    });
    const loadingShimmerEl = findElementInTailTurns('.loading-shimmer', tailTurns);
    const thinkingIndicatorEl = findElementInTailTurns('[class*="thinking"], [data-testid*="thinking"]', tailTurns);
    const activeToolStatus = hasActiveToolStatusInTailTurns(tailTurns);
    const explicitStop = queryOneSafe(stopButtonSelector);
    const fallbackStop = queryOneSafe('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    const composerRole = getComposerActionRole();
    const composerAction = getComposerActionDiagnostics();
    const stopPresent = isActiveStopButton(explicitStop)
      || isActiveStopButton(fallbackStop)
      || composerRole.role === 'stop-active';
    const confirmVisible = isConfirmDialogVisible();
    const responseScopeContains = (node) => !!(
      node
      && responseEvidence.responseCompletionEvidence
      && responseEvidence.scope
      && responseEvidence.scope.contains(node)
    );
    const shimmerContradictedByCompletion = responseScopeContains(loadingShimmerEl);
    const thinkingContradictedByCompletion = responseScopeContains(thinkingIndicatorEl);
    const hardBlockingReasons = [];
    const staleActivityReasons = [];
    if (stopPresent) hardBlockingReasons.push('stopButton');
    if (loadingShimmerEl && !shimmerContradictedByCompletion) {
      hardBlockingReasons.push('loadingShimmer');
    } else if (loadingShimmerEl) {
      staleActivityReasons.push('staleLoadingShimmer');
    }
    if (thinkingIndicatorEl && !thinkingContradictedByCompletion) {
      hardBlockingReasons.push('thinkingIndicator');
    } else if (thinkingIndicatorEl) {
      staleActivityReasons.push('staleThinkingIndicator');
    }
    if (activeToolStatus) hardBlockingReasons.push('activeToolStatus');
    if (confirmVisible) hardBlockingReasons.push('confirmDialog');
    const stopButtonCandidates = describeCandidateNodes(stopButtonSelector || 'button[data-testid="stop-button"]');
    const fallbackStopCandidates = describeCandidateNodes('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
    const responseCompletionMarkerDiagnostics = responseEvidence.responseCompletionMarkers.map((marker, index) => ({
      selector: marker.selector,
      label: marker.label || null,
      node: describeNode(marker.node, { index }),
    }));
    const activityDiagnostics = {
      selectorUsed: stopButtonSelector || null,
      explicitStop: describeNode(explicitStop, { activeStop: isActiveStopButton(explicitStop) }),
      fallbackStop: describeNode(fallbackStop, { activeStop: isActiveStopButton(fallbackStop) }),
      stopButtonCandidates,
      fallbackStopCandidates,
      composerAction,
      loadingShimmer: describeNode(loadingShimmerEl, {
        stale: !!loadingShimmerEl && shimmerContradictedByCompletion,
      }),
      thinkingIndicator: describeNode(thinkingIndicatorEl, {
        stale: !!thinkingIndicatorEl && thinkingContradictedByCompletion,
      }),
      counts: {
        stopButtonCandidates: stopButtonCandidates.count,
        fallbackStopCandidates: fallbackStopCandidates.count,
        responseCompletionMarkers: responseCompletionMarkerDiagnostics.length,
      },
      activeToolStatus,
      confirmVisible,
      hardBlockingReasons: hardBlockingReasons.slice(),
      staleActivityReasons: staleActivityReasons.slice(),
      responseCompletionMarkers: responseCompletionMarkerDiagnostics,
      hasStableCapturedResponse: responseEvidence.hasStableCapturedResponse,
      responseCompletionEvidence: responseEvidence.responseCompletionEvidence,
      finalDecisionReason: hardBlockingReasons.length > 0
        ? `active:${hardBlockingReasons.join(',')}`
        : responseEvidence.responseCompletionEvidence
          ? 'inactive:stableResponseMarkers'
          : 'inactive:noActivitySignals',
    };
    return {
      loadingShimmer: !!loadingShimmerEl,
      loadingShimmerHardBlock: !!loadingShimmerEl && !shimmerContradictedByCompletion,
      staleLoadingShimmer: !!loadingShimmerEl && shimmerContradictedByCompletion,
      thinkingIndicator: !!thinkingIndicatorEl,
      thinkingIndicatorHardBlock: !!thinkingIndicatorEl && !thinkingContradictedByCompletion,
      activeToolStatus: !!activeToolStatus,
      stopPresent,
      confirmVisible,
      composerRole,
      active: hardBlockingReasons.length > 0,
      hardActivityPresent: hardBlockingReasons.length > 0,
      blockingReasons: hardBlockingReasons.slice(),
      hardBlockingReasons,
      staleActivityReasons,
      responseCompletionMarkers: responseEvidence.responseCompletionMarkers,
      responseCompletionMarkerNames: responseEvidence.responseCompletionMarkerNames,
      hasStableCapturedResponse: responseEvidence.hasStableCapturedResponse,
      responseCompletionEvidence: responseEvidence.responseCompletionEvidence,
      activityDiagnostics,
      targetSettings,
    };
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

  function getChatGPTThinkingSignals(options = {}) {
    return classifyChatGPTDomActivity(options);
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
        markers.push({ selector, label: getResponseActionLabel(node, selector), node });
      }
    }
    return markers;
  }

  window.PromptQueueChatState = Object.freeze({
    version: CHAT_STATE_VERSION,
    classifyChatGPTDomActivity,
    findResponseCompletionMarkers,
    getChatGPTThinkingSignals,
    getComposerActionButton,
    getComposerActionDiagnostics,
    getComposerActionRole,
    getLatestAssistantTurn,
    isActiveStopButton,
    isButtonEnabled,
    isElementVisible,
    responseActionSelectors: RESPONSE_ACTION_SELECTORS.slice(),
  });
})();
