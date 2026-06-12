(function () {
  const TARGETS_VERSION = '2026-06-01.no-reload-v2';
  if (window.PromptQueueTargets?.version === TARGETS_VERSION) return;

  const DEFAULT_TARGET_SELECTORS = Object.freeze({
    promptInput: '',
    sendButton: '',
    stopButton: '',
    watchedElement: 'button[data-testid="copy-turn-action-button"]',
  });

  const SITE_TARGETS = {
    chatgpt: {
      inputCandidates: [
        '#prompt-textarea[contenteditable]',
        '#prompt-textarea.ProseMirror[contenteditable]',
        '[data-testid="prompt-textarea"][contenteditable]',
        'div#prompt-textarea[contenteditable]',
        'div[contenteditable][role="textbox"]',
        'form [contenteditable][role="textbox"]',
        '.ProseMirror[contenteditable]',
        'textarea#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
        'form textarea[name="prompt-textarea"]',
        'form textarea[aria-label*="message"]',
        'form textarea[aria-label*="Message"]',
        'form textarea[aria-label*="Chat with ChatGPT"]',
        'form textarea[placeholder*="message"]',
        'form textarea[placeholder*="Message"]',
        'form textarea',
        'textarea.wcDTda_fallbackTextarea',
      ],
      sendButtonCandidates: [
        'button[data-testid="send-button"]',
        'form button[data-testid="send-button"]',
        'form button[aria-label="Send message"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send prompt"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button[aria-label*="Submit"]',
        'button[aria-label*="submit"]',
        'form button[type="submit"]',
        'button[type="submit"]',
      ],
      stopButtonCandidates: [
        'button#composer-submit-button[aria-label*="Stop"]',
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label*="Stop"]',
      ],
      watchedElementCandidates: [
        'button[data-testid="copy-turn-action-button"]',
      ],
      messagesContainerCandidates: [
        '[data-testid="conversation-turns"]',
        'main',
        'body',
      ],
    },
    gemini: {
      inputCandidates: [
        'textarea[aria-label="Enter a prompt here"]',
        '[contenteditable="true"][aria-label*="Message"]',
        '[contenteditable="true"]',
        'textarea',
      ],
      sendButtonCandidates: [
        'button[aria-label="Send"]',
        'button[aria-label*="Send message"]',
        'button[type="submit"]',
      ],
      stopButtonCandidates: [
        'button[aria-label*="Stop"]',
        'button[data-tooltip*="Stop"]',
      ],
      watchedElementCandidates: [DEFAULT_TARGET_SELECTORS.watchedElement],
      messagesContainerCandidates: ['main', 'body'],
    },
    grok: {
      inputCandidates: ['textarea', '[contenteditable="true"]'],
      sendButtonCandidates: ['button[type="submit"]', 'button[aria-label*="Send"]'],
      stopButtonCandidates: ['button[aria-label*="Stop"]', 'button:has(svg[aria-label*="stop"])'],
      watchedElementCandidates: [DEFAULT_TARGET_SELECTORS.watchedElement],
      messagesContainerCandidates: ['[data-testid="conversation-root"]', 'main', 'body'],
    },
    claude: {
      inputCandidates: [
        'textarea[aria-label*="Message"]',
        'textarea[placeholder*="Message"]',
        'textarea',
        '[contenteditable="true"]',
      ],
      sendButtonCandidates: [
        'button[aria-label="Send"]',
        'button[type="submit"]',
        'form button:not([disabled])',
      ],
      stopButtonCandidates: ['button[aria-label*="Stop"]', 'button:has(svg[aria-label*="stop"])'],
      watchedElementCandidates: [DEFAULT_TARGET_SELECTORS.watchedElement],
      messagesContainerCandidates: ['[data-testid*="conversation"]', 'main', 'body'],
    },
    unknown: {
      inputCandidates: ['textarea', '[contenteditable]'],
      sendButtonCandidates: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button:has(svg[aria-label*="send"])'],
      stopButtonCandidates: ['button[aria-label*="Stop"]'],
      watchedElementCandidates: [DEFAULT_TARGET_SELECTORS.watchedElement],
      messagesContainerCandidates: ['main', 'body'],
    },
  };

  const ROLE_TO_KEY = {
    promptInput: 'inputCandidates',
    sendButton: 'sendButtonCandidates',
    stopButton: 'stopButtonCandidates',
    watchedElement: 'watchedElementCandidates',
  };
  const BUTTON_CONTEXT_ROLES = new Set(['sendButton', 'stopButton', 'watchedElement']);

  let activePicker = null;

  function getSiteTargets(site) {
    return SITE_TARGETS[site] || SITE_TARGETS.unknown;
  }

  function sanitizeSelectorValue(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
  }

  function normalizeCommonDataTestIdPattern(rawValue, role) {
    const trimmed = sanitizeSelectorValue(rawValue);
    if (!trimmed) return '';

    const hashMatch = trimmed.match(/^data-testid#([a-zA-Z0-9_.:-]+)$/);
    if (hashMatch) {
      const base = `[data-testid="${hashMatch[1]}"]`;
      return BUTTON_CONTEXT_ROLES.has(role) ? `button${base}` : base;
    }

    const equalsMatch = trimmed.match(/^data-testid\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?$/);
    if (equalsMatch) {
      const base = `[data-testid="${equalsMatch[1]}"]`;
      return BUTTON_CONTEXT_ROLES.has(role) ? `button${base}` : base;
    }

    return trimmed;
  }

  function isValidCssSelector(selector) {
    if (!selector) return true;
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (_) {
      return false;
    }
  }

  function sanitizeTargetSelectors(input = {}, legacy = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    const old = legacy && typeof legacy === 'object' ? legacy : {};
    const watchedFallback = sanitizeSelectorValue(old.watchedElementSelector, DEFAULT_TARGET_SELECTORS.watchedElement);
    const promptInput = normalizeCommonDataTestIdPattern(raw.promptInput, 'promptInput');
    const sendButton = normalizeCommonDataTestIdPattern(raw.sendButton, 'sendButton');
    const stopButton = normalizeCommonDataTestIdPattern(raw.stopButton, 'stopButton');
    const watchedElement = normalizeCommonDataTestIdPattern(
      sanitizeSelectorValue(raw.watchedElement, watchedFallback || DEFAULT_TARGET_SELECTORS.watchedElement),
      'watchedElement',
    );

    return {
      promptInput: isValidCssSelector(promptInput) ? promptInput : '',
      sendButton: isValidCssSelector(sendButton) ? sendButton : '',
      stopButton: isValidCssSelector(stopButton) ? stopButton : '',
      watchedElement: isValidCssSelector(watchedElement) ? watchedElement : DEFAULT_TARGET_SELECTORS.watchedElement,
    };
  }

  function querySelectorAllSafe(selector, root = document) {
    if (!selector || typeof selector !== 'string') return [];
    try {
      return Array.from((root || document).querySelectorAll(selector));
    } catch (error) {
      return [{ __promptQueueSelectorError: error }];
    }
  }

  function isElementVisible(element) {
    if (!element || element.__promptQueueSelectorError) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isPromptEditableElement(element) {
    if (!element || element.__promptQueueSelectorError || element.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = element.tagName?.toLowerCase?.() || '';
    if (tag === 'textarea') return true;
    if (tag === 'input' && ['text', 'search', ''].includes((element.getAttribute('type') || '').toLowerCase())) return true;
    const editable = String(element.getAttribute('contenteditable') || '').toLowerCase();
    return editable === 'true' || editable === 'plaintext-only';
  }

  function findPromptEditableNear(element, site = 'unknown') {
    if (!element || element.__promptQueueSelectorError) return null;
    if (isPromptEditableElement(element)) return element;

    const closestEditable = element.closest?.('textarea, input, [contenteditable]');
    if (isPromptEditableElement(closestEditable)) return closestEditable;

    for (const selector of getSiteTargets(site).inputCandidates || []) {
      const scopedMatches = querySelectorAllSafe(selector, element);
      const scopedEditable = scopedMatches.find((candidate) => isPromptEditableElement(candidate) && isElementVisible(candidate));
      if (scopedEditable) return scopedEditable;
    }

    const form = element.closest?.('form');
    if (form) {
      for (const selector of getSiteTargets(site).inputCandidates || []) {
        const formMatches = querySelectorAllSafe(selector, form);
        const formEditable = formMatches.find((candidate) => isPromptEditableElement(candidate) && isElementVisible(candidate));
        if (formEditable) return formEditable;
      }
    }

    return null;
  }

  function canonicalizeRoleElement(role, element, site = 'unknown') {
    if (role !== 'promptInput') return element;
    return findPromptEditableNear(element, site) || element;
  }

  function getCustomSelectorForRole(role, settings = {}) {
    const selectors = sanitizeTargetSelectors(settings.targetSelectors, settings);
    return selectors[role] || '';
  }

  function resolveTarget(role, { site = 'unknown', settings = {}, root = document, requireVisible = true } = {}) {
    const selector = getCustomSelectorForRole(role, settings);
    if (selector) {
      const matches = querySelectorAllSafe(selector, root);
      if (matches[0]?.__promptQueueSelectorError) {
        console.warn('[Targets] Invalid custom selector', { role, selector, error: matches[0].__promptQueueSelectorError?.message });
      } else {
        const visibleMatch = requireVisible ? matches.find(isElementVisible) : (matches[0] || null);
        if (visibleMatch) {
          const canonicalElement = canonicalizeRoleElement(role, visibleMatch, site);
          const canonicalSelector = canonicalElement === visibleMatch ? selector : buildCssSelector(canonicalElement);
          console.log('[Targets] Resolved custom selector', {
            role,
            selector,
            canonicalSelector,
            source: canonicalElement === visibleMatch ? 'custom' : 'custom-canonical',
            matchedCount: matches.length,
          });
          return {
            element: canonicalElement,
            selector: canonicalSelector || selector,
            source: canonicalElement === visibleMatch ? 'custom' : 'custom-canonical',
            matchedCount: matches.length,
          };
        }
        console.warn('[Targets] Custom selector had no visible match; falling back', { role, selector, matchedCount: matches.length });
      }
    }

    const key = ROLE_TO_KEY[role];
    const fallbacks = key ? (getSiteTargets(site)[key] || []) : [];
    for (const fallbackSelector of fallbacks) {
      const matches = querySelectorAllSafe(fallbackSelector, root);
      const visibleMatch = requireVisible ? matches.find(isElementVisible) : (matches[0] || null);
      if (visibleMatch) {
        return { element: visibleMatch, selector: fallbackSelector, source: 'fallback', matchedCount: matches.length };
      }
    }

    return { element: null, selector: fallbacks[0] || '', source: 'none', matchedCount: 0 };
  }

  function resolveSelector(role, { site = 'unknown', settings = {} } = {}) {
    const resolved = resolveTarget(role, { site, settings, requireVisible: true });
    if (resolved.selector) return resolved;
    const key = ROLE_TO_KEY[role];
    const fallbacks = key ? (getSiteTargets(site)[key] || []) : [];
    return { element: null, selector: fallbacks[0] || '', source: 'fallback', matchedCount: 0 };
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function escapeAttributeValue(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function selectorIsUnique(selector) {
    if (!selector) return false;
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  }

  function buildSegment(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = element.tagName.toLowerCase();
    if (element.id) {
      const selector = `${tag}#${cssEscape(element.id)}`;
      if (selectorIsUnique(selector)) return selector;
      const idOnly = `#${cssEscape(element.id)}`;
      if (selectorIsUnique(idOnly)) return idOnly;
    }

    const attrPairs = [
      ['data-testid', element.getAttribute('data-testid')],
      ['name', element.getAttribute('name')],
      ['aria-label', element.getAttribute('aria-label')],
      ['placeholder', element.getAttribute('placeholder')],
      ['type', element.getAttribute('type')],
      ['role', element.getAttribute('role')],
    ];
    for (const [attr, value] of attrPairs) {
      if (!value) continue;
      const selector = `${tag}[${attr}="${escapeAttributeValue(value)}"]`;
      if (selectorIsUnique(selector)) return selector;
    }

    const rawClassName = typeof element.className === 'string'
      ? element.className
      : (typeof element.getAttribute === 'function' ? (element.getAttribute('class') || '') : '');
    const classNames = rawClassName
      .split(/\s+/)
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => !/^[a-z0-9]{8,}$/i.test(name))
      .slice(0, 2);
    if (classNames.length) {
      const selector = `${tag}.${classNames.map(cssEscape).join('.')}`;
      if (selectorIsUnique(selector)) return selector;
    }

    const siblings = element.parentElement ? Array.from(element.parentElement.children).filter((child) => child.tagName === element.tagName) : [];
    const index = siblings.indexOf(element) + 1;
    return `${tag}:nth-of-type(${Math.max(1, index)})`;
  }

  function buildCssSelector(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return '';
    const immediate = buildSegment(element);
    if (immediate && selectorIsUnique(immediate)) return immediate;

    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const segment = buildSegment(current);
      if (!segment) break;
      parts.unshift(segment);
      const selector = parts.join(' > ');
      if (selectorIsUnique(selector)) return selector;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function cleanupPicker(result) {
    if (!activePicker) return;
    const { hovered, label, abort } = activePicker;
    document.removeEventListener('mousemove', activePicker.onMouseMove, true);
    document.removeEventListener('click', activePicker.onClick, true);
    document.removeEventListener('keydown', activePicker.onKeyDown, true);
    if (hovered?.element) {
      hovered.element.style.outline = hovered.previousOutline;
      hovered.element.style.outlineOffset = hovered.previousOutlineOffset;
      hovered.element.style.cursor = hovered.previousCursor;
    }
    label?.remove();
    activePicker = null;
    if (abort && result?.cancelled) {
      abort(result);
    }
  }

  function setHoveredElement(nextElement) {
    if (!activePicker) return;
    const hovered = activePicker.hovered;
    if (hovered.element === nextElement) return;
    if (hovered.element) {
      hovered.element.style.outline = hovered.previousOutline;
      hovered.element.style.outlineOffset = hovered.previousOutlineOffset;
      hovered.element.style.cursor = hovered.previousCursor;
    }
    hovered.element = nextElement;
    hovered.previousOutline = nextElement?.style?.outline || '';
    hovered.previousOutlineOffset = nextElement?.style?.outlineOffset || '';
    hovered.previousCursor = nextElement?.style?.cursor || '';
    if (nextElement) {
      nextElement.style.outline = '2px solid #38bdf8';
      nextElement.style.outlineOffset = '2px';
      nextElement.style.cursor = 'crosshair';
    }
  }

  function startTargetPicker(role) {
    if (activePicker) {
      cleanupPicker({ ok: false, cancelled: true, error: 'Picker replaced by new request' });
    }

    return new Promise((resolve) => {
      const label = document.createElement('div');
      label.textContent = `Pick ${role}`;
      Object.assign(label.style, {
        position: 'fixed',
        zIndex: '2147483647',
        top: '12px',
        right: '12px',
        background: 'rgba(15, 23, 42, 0.95)',
        color: '#e2e8f0',
        padding: '8px 10px',
        borderRadius: '6px',
        font: '12px/1.3 system-ui, sans-serif',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(label);

      activePicker = {
        role,
        hovered: {
          element: null,
          previousOutline: '',
          previousOutlineOffset: '',
          previousCursor: '',
        },
        label,
        abort: resolve,
      };

      activePicker.onMouseMove = (event) => {
        const nextElement = document.elementFromPoint(event.clientX, event.clientY);
        setHoveredElement(nextElement);
      };
      activePicker.onClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const target = activePicker?.hovered?.element || document.elementFromPoint(event.clientX, event.clientY);
        const site = location.hostname?.includes('chatgpt.com') || location.hostname?.includes('chat.openai.com')
          ? 'chatgpt'
          : 'unknown';
        const canonicalTarget = canonicalizeRoleElement(role, target, site);
        const selector = buildCssSelector(canonicalTarget);
        const result = {
          ok: Boolean(selector),
          cancelled: false,
          role,
          selector,
          tagName: canonicalTarget?.tagName?.toLowerCase() || '',
          pickedTagName: target?.tagName?.toLowerCase() || '',
          textPreview: (canonicalTarget?.getAttribute?.('aria-label') || canonicalTarget?.textContent || '').trim().slice(0, 80),
        };
        cleanupPicker(result);
        resolve(result);
      };
      activePicker.onKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        cleanupPicker({ ok: false, cancelled: true, role, error: 'Picker cancelled' });
        resolve({ ok: false, cancelled: true, role, error: 'Picker cancelled' });
      };

      document.addEventListener('mousemove', activePicker.onMouseMove, true);
      document.addEventListener('click', activePicker.onClick, true);
      document.addEventListener('keydown', activePicker.onKeyDown, true);
    });
  }

  if (chrome?.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'START_TARGET_PICKER') {
        startTargetPicker(String(message.role || 'promptInput'))
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, cancelled: false, error: error?.message || String(error) }));
        return true;
      }
      if (message?.type === 'CANCEL_TARGET_PICKER') {
        cleanupPicker({ ok: false, cancelled: true, role: String(message.role || ''), error: 'Picker cancelled' });
        sendResponse({ ok: true, cancelled: true });
        return;
      }
      return undefined;
    });
  }

  window.PromptQueueTargets = {
    version: TARGETS_VERSION,
    DEFAULT_TARGET_SELECTORS,
    buildCssSelector,
    canonicalizeRoleElement,
    getCustomSelectorForRole,
    getSiteTargets,
    isElementVisible,
    isPromptEditableElement,
    resolveSelector,
    resolveTarget,
    sanitizeTargetSelectors,
    startTargetPicker,
  };
})();
