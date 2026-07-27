(function () {
  const CHAT_STATE_VERSION = '2026-07-28.chat-state-v6';
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
    // ponytail: `|| el.isConnected` makes every attached node "visible", which is wrong — but
    // it is load-bearing for the jsdom fixtures (jsdom reports a 0x0 rect and a null
    // offsetParent unless a test mocks them), and the stop-button false positive it could
    // cause is already blocked by isInComposerRegion below. Tighten to the first three
    // signals only alongside a fixture pass that mocks rects, not before.
    return rect.width > 0 || rect.height > 0 || el.offsetParent !== null || el.isConnected === true;
  }

  // A generation Stop control always lives in the composer. chatgpt.com REMOVES
  // button#composer-submit-button from the DOM when generation ends (it is not hidden, it is
  // gone), so the stop-button candidate list falls through to the loose
  // `button[aria-label*="Stop"]` last resort — which matches a sidebar conversation whose
  // TITLE contains "Stop" (observed live: aria-label "Pin Ollama Stop Usage", inside
  // nav[aria-label="Chat history"]). That read as an active Stop forever and blocked every
  // completion. Whitelist the composer region instead of blacklisting the sidebar: fail
  // closed, the way a wrong "still generating" verdict costs an entire job.
  function isInComposerRegion(el) {
    if (!el) return false;
    try {
      if (el.closest('form') || el.closest('main')) return true;
      // If the page has no composer region at all, containment cannot discriminate anything
      // and must not veto — that is the shape of the non-ChatGPT hosts and of the bare
      // single-button test DOMs. The sidebar false positive only exists on pages that do
      // have a composer, where this check stays active.
      return !document.querySelector('form, main');
    } catch (_) {
      return false;
    }
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

  function getAccessibleButtonName(button) {
    const direct = button?.getAttribute?.('aria-label') || button?.getAttribute?.('title');
    if (direct) return { value: direct, source: 'label' };
    const labelledBy = String(button?.getAttribute?.('aria-labelledby') || '').trim();
    if (labelledBy) {
      const value = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (value) return { value, source: 'accessible-name' };
    }
    return { value: button?.textContent || '', source: 'text' };
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
    const accessibleName = getAccessibleButtonName(button);
    const label = normalizeText(accessibleName.value);
    const testId = normalizeText(button.getAttribute('data-testid'));
    const type = normalizeText(button.getAttribute('type'));
    const labelHasStop = /\bstop\b|stop answering|stop generating|stop streaming/.test(label);
    const labelHasSend = /\bsend\b|submit|send prompt|send message/.test(`${label} ${type}`);
    const testIdHasStop = /\bstop\b|stop-button/.test(testId);
    const testIdHasSend = /\bsend\b|send-button/.test(testId);
    const hasStop = labelHasStop || (testIdHasStop && !labelHasSend);
    const hasSend = labelHasSend || testIdHasSend;
    const labelReason = accessibleName.source === 'accessible-name' ? 'accessible-name' : 'label';
    if (hasSend && enabled) return { role: 'send-ready', enabled, reason: labelHasSend ? `send-${labelReason}` : 'send-testid' };
    if (hasStop && enabled) return { role: 'stop-active', enabled, reason: labelHasStop ? `stop-${labelReason}` : 'stop-testid' };
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
    // The composer button is identified by a unique id, so it needs no containment check.
    if (isComposerActionButton(button)) return getComposerActionRole(button).role === 'stop-active';
    // Everything else arrives from a loose selector match and must prove it is part of the
    // composer before it may claim generation is running. This is the branch the sidebar
    // conversation title reached.
    if (!isInComposerRegion(button)) return false;
    const label = normalizeText(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent);
    const testId = normalizeText(button.getAttribute('data-testid'));
    const combined = `${label} ${testId}`;
    const hasSend = /\bsend\b|send prompt|send message|send-button/.test(combined);
    const hasStop = /\bstop\b|stop answering|stop generating|stop streaming|stop-button/.test(combined);
    return hasStop && !hasSend;
  }

  // chatgpt.com moved the turn container from <article data-testid="conversation-turn-1">
  // to <section data-turn-id="..." data-testid="conversation-turn-1" data-turn="user">.
  // driftwatch's chatgpt.com pack tracks that shape; fall back to the legacy hardcoded
  // selector if driftwatch itself is unavailable (older cached content scripts, injection
  // order changed) so this never throws.
  function getDriftwatchChatGptInstance() {
    try {
      const dw = window.driftwatch;
      const pack = dw?.packs?.['chatgpt.com'];
      if (!dw || !pack || typeof dw.use !== 'function') return null;
      return dw.use(pack);
    } catch (_) {
      return null;
    }
  }

  function getTailConversationTurns(maxTurns = 2) {
    const dw = getDriftwatchChatGptInstance();
    let turns = [];
    if (dw) {
      try {
        turns = dw.resolve('conversationTurn', document)?.els || [];
      } catch (_) {
        turns = [];
      }
    }
    if (turns.length === 0) {
      // No tag qualifier: chatgpt.com moved the turn from <article> to <section>, so the
      // qualified form matches 0 (verified live).
      turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [data-turn-id]'));
    }
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

  function isAssistantTurn(node) {
    if (!node || typeof node.getAttribute !== 'function') return false;
    // Current layout marks the turn container directly: <section data-turn="user|assistant">.
    const turnRole = normalizeText(node.getAttribute('data-turn') || '');
    if (turnRole) return turnRole === 'assistant';
    // Older layouts (e.g. <article data-testid="conversation-turn-N">) carry no data-turn.
    // They may put the author role on the turn element itself, or on a descendant.
    const ownRole = normalizeText(node.getAttribute('data-message-author-role') || '');
    if (ownRole) return ownRole === 'assistant';
    try {
      return !!node.querySelector('[data-message-author-role="assistant"]');
    } catch (_) {
      return false;
    }
  }

  function getLatestAssistantTurn() {
    // Must return the turn CONTAINER, not the inner [data-message-author-role="assistant"]
    // div: the copy/feedback action bar that findResponseCompletionMarkers looks for lives
    // as a sibling of that div, inside the turn container, not inside it.
    const dw = getDriftwatchChatGptInstance();
    if (dw) {
      let turnEls = null;
      try {
        turnEls = dw.resolve('conversationTurn', document)?.els || [];
      } catch (_) {
        turnEls = null; // resolver threw: treat as "cannot resolve", fall through below
      }
      if (turnEls && turnEls.length > 0) {
        for (let i = turnEls.length - 1; i >= 0; i -= 1) {
          const node = turnEls[i];
          // Assistant turns ONLY. The conversationTurn anchor resolves user turns too, and a
          // user turn carries its own copy-turn-action-button — returning one would make
          // findResponseCompletionMarkers report "response complete" the moment the prompt is
          // sent, before any answer exists. Silently capturing the wrong text is worse than
          // waiting, so this filters rather than falling back to "last turn of any kind".
          if (!isAssistantTurn(node)) continue;
          const text = normalizeText(node.textContent || '');
          if (!/\bqueued prompt\b/.test(text)) return node;
        }
        return null; // no assistant turn yet, or every one was a queued-prompt placeholder
      }
    }
    // Legacy fallback: only reached when the conversationTurn anchor cannot resolve at all
    // (driftwatch missing/older cached content script, or the anchor is fully broken).
    // No tag qualifier on the turn selectors, same reason as above. Resolve each candidate
    // to its TURN container first (closest turn selector), the way the driftwatch branch
    // above does, so the action bar outside the inner assistant-role div stays visible to
    // findResponseCompletionMarkers. Only the bare inner div is returned when no turn
    // container wraps it at all.
    const candidates = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], [data-turn-id], [data-message-author-role="assistant"]'));
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      const role = node.getAttribute?.('data-message-author-role') || '';
      const resolved = node.closest?.('[data-testid^="conversation-turn-"], [data-turn-id]') || node;
      const text = normalizeText(resolved.textContent || '');
      if (role === 'assistant' || !/\bqueued prompt\b/.test(text)) return resolved;
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
    isInComposerRegion,
    responseActionSelectors: RESPONSE_ACTION_SELECTORS.slice(),
  });
})();
