// Background service worker for AI Task Sequencer with sleep/wake support

// Console prefix patch - runs in service worker context
// NOTE: This patch exists in all 3 JS files because Chrome extensions have separate
// JavaScript contexts (service worker, popup, page). Each context needs its own patch.
(function () {
  const root = self;
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

importScripts('prompt-queue-constants.js', 'background-parallel-utils.js');
const PQ_CONSTANTS = self.PromptQueueConstants || {};
const MESSAGE_TYPES = PQ_CONSTANTS.MESSAGE_TYPES || {};
const STORAGE_KEYS = PQ_CONSTANTS.STORAGE_KEYS || {};
const LIMITS = PQ_CONSTANTS.LIMITS || {};
const {
  PARALLEL_CONFIG,
  buildParallelPromptId,
  buildParallelWorkerId,
  resolveParallelLaunchUrl: resolveParallelLaunchUrlWithHelpers,
  shouldUseParallelMode,
  resolveParallelPromptGroups,
} = self.BackgroundParallelUtils;

// Open side panel when extension icon is clicked
const openSidePanels = new Set();

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (!tabId) return;

  // Toggle: if already open for this tab, ask panel to close itself
  if (openSidePanels.has(tabId)) {
    try {
      chrome.runtime.sendMessage({ type: 'CLOSE_SIDE_PANEL', tabId });
    } catch (_) {}
    openSidePanels.delete(tabId);
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId });
    openSidePanels.add(tabId);
  } catch (e) {
    console.error('[SidePanel] Failed to open:', e);
  }
});

const state = {
  prompts: [],
  currentIndex: 0,
  mode: 'sequential',
  running: false,
  paused: false,
  tabId: null,
  options: {
    stableMs: undefined,
    stableMinMs: undefined,
    stableMaxMs: undefined,
    maxWaitMs: undefined,
    pollIntervalMs: undefined,
    systemPrompt: '',
    appendPromptText: '',
    prependSystemPrompt: true,
    appendSystemPrompt: false,
    theme: 'dark',
    autoConfirmDialogs: false,
    enableWatchedElementGate: false,
    watchedElementSelector: 'button[data-testid="copy-turn-action-button"]',
    targetSelectors: {
      promptInput: '',
      sendButton: '',
      stopButton: '',
      watchedElement: 'button[data-testid="copy-turn-action-button"]',
    },
    refreshTabBeforeEachPrompt: false,
    parallelOneTabPerPrompt: false,
    enableRetryOnFailure: true,
    maxRetriesPerPrompt: 2,
    retryDelayMs: 2000,
    debugLoggingEnabled: false,
    openNewChatPerPrompt: false,
    openNewChatPerPromptUrl: '',
  },
  lastActivityTime: Date.now(),
  recoveryAttempts: 0,
  processing: false,
  promptStartTime: 0,
  lastRecoveryTime: 0,
  currentPromptId: null,
  currentRetryCount: 0,
  stableCountdownMs: 0,
  responseDurations: [],
  parallel: null,
};
let sequentialRetryTimer = null;
const parallelSubmissionWaiters = new Map();
let hasHydratedPersistentState = false;

const MEMORY_CLASSES = [
  'beliefs_preferences',
  'world_facts',
  'entity_observations',
  'agent_experiences',
  'reflections',
];

const DEFAULT_MEMORY_SETTINGS = {
  enabled: true,
  bridgeBaseUrl: 'http://127.0.0.1:5599',
  authMode: 'native_host',
  nativeHostName: 'com.aipromptqueue.transcription',
  storedToken: '',
  querySource: 'prompt_box',
  project: 'global',
  mode: 'smart',
  maxTokens: 800,
  topK: 8,
  minScore: 0.2,
  pinnedPolicy: 'relevant_only',
  includeClasses: MEMORY_CLASSES,
  excludeClasses: [],
  insertBehavior: 'prepend_or_replace_managed_block',
  debug: false,
};

const DEFAULT_SETTINGS = {
  stableMs: 10000,
  stableMinMs: 10000,
  stableMaxMs: 10000,
  maxWaitMs: 180000,
  pollIntervalMs: 1500,
  systemPrompt: '',
  appendPromptText: '',
  prependSystemPrompt: true,
  appendSystemPrompt: false,
  theme: 'dark',
  autoConfirmDialogs: false,
  enableWatchedElementGate: false,
  watchedElementSelector: 'button[data-testid="copy-turn-action-button"]',
  targetSelectors: {
    promptInput: '',
    sendButton: '',
    stopButton: '',
    watchedElement: 'button[data-testid="copy-turn-action-button"]',
  },
  refreshTabBeforeEachPrompt: false,
  parallelOneTabPerPrompt: false,
  enableRetryOnFailure: true,
  maxRetriesPerPrompt: 2,
  retryDelayMs: 2000,
  debugLoggingEnabled: false,
  enableMaxWaitTimeout: true,
  enableStopWord: false,
  stopWord: 'end of feedback',
  stopWordCaseSensitive: false,
  openNewChatPerPrompt: false,
  openNewChatPerPromptUrl: '',
  memory: DEFAULT_MEMORY_SETTINGS,
};

const SETTINGS_STORAGE_KEY = STORAGE_KEYS.SETTINGS || 'aiTaskSequencerSettings';
const HISTORY_STORAGE_KEY = STORAGE_KEYS.HISTORY || 'aiTaskSequencerHistory';
const RESPONSE_LOG_STORAGE_KEY = STORAGE_KEYS.RESPONSES || 'aiTaskSequencerResponses';
const PROMPT_PREVIEW_CHARS = LIMITS.PROMPT_PREVIEW_CHARS || 120;
const RESPONSE_TEXT_CHARS = LIMITS.RESPONSE_TEXT_CHARS || 20000;
const RESPONSE_RECORD_LIMIT = LIMITS.RESPONSE_RECORD_LIMIT || 200;

function applyDebugLoggingSetting(enabled) {
  const next = enabled === true;
  try {
    if (typeof self.__aiPromptQueueSetDebugLogging === 'function') {
      self.__aiPromptQueueSetDebugLogging(next);
    } else {
      self.__aiPromptQueueDebugLoggingEnabled = next;
    }
  } catch (_) {}
}

const RECOVERY_CONFIG = {
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 2000,
  staleThresholdMs: 60000, // Increased to 60 seconds for slower AI responses
  healthCheckIntervalMs: 5000,
  minRecoveryIntervalMs: 3000,
  recoveryBackoffMultiplier: 1.5, // Exponential backoff
};

function coerceNumber(v, min, max, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (typeof min === 'number' && n < min) return fallback;
    if (typeof max === 'number' && n > max) return fallback;
    return n;
  }
  return fallback;
}

function sanitizeMemoryBridgeBaseUrl(url) {
  const trimmed = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return DEFAULT_MEMORY_SETTINGS.bridgeBaseUrl;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch (_) {}
  return DEFAULT_MEMORY_SETTINGS.bridgeBaseUrl;
}

const BUTTON_CONTEXT_SELECTOR_ROLES = new Set(['sendButton', 'stopButton', 'watchedElement']);

function normalizeCommonDataTestIdPattern(rawValue, role) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!trimmed) return { value: '', normalized: false };

  const hashMatch = trimmed.match(/^data-testid#([a-zA-Z0-9_.:-]+)$/);
  if (hashMatch) {
    const base = `[data-testid="${hashMatch[1]}"]`;
    return { value: BUTTON_CONTEXT_SELECTOR_ROLES.has(role) ? `button${base}` : base, normalized: true };
  }

  const equalsMatch = trimmed.match(/^data-testid\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?$/);
  if (equalsMatch) {
    const base = `[data-testid="${equalsMatch[1]}"]`;
    return { value: BUTTON_CONTEXT_SELECTOR_ROLES.has(role) ? `button${base}` : base, normalized: true };
  }

  return { value: trimmed, normalized: false };
}

function isValidCssSelector(selector) {
  if (!selector) return true;
  try {
    if (typeof document !== 'undefined' && document?.createDocumentFragment) {
      document.createDocumentFragment().querySelector(selector);
      return true;
    }
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
      return CSS.supports(`selector(:is(${selector}))`);
    }
  } catch (_) {
    return false;
  }
  return isSupportedSelectorWithoutEngine(selector);
}

function isRecognizedSimpleDataTestIdSelector(selector) {
  const trimmed = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmed) return true;
  const tag = '(?:[a-zA-Z][a-zA-Z0-9_-]*)?';
  const value = '(?:"[a-zA-Z0-9_.:-]+"|\'[a-zA-Z0-9_.:-]+\'|[a-zA-Z0-9_.:-]+)';
  return new RegExp(`^${tag}\\[\\s*data-testid\\s*=\\s*${value}\\s*\\]$`).test(trimmed);
}

function isSupportedSelectorWithoutEngine(selector) {
  const trimmed = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmed) return true;

  const tokenPattern = '(?:[#.][a-zA-Z_][a-zA-Z0-9_-]*|[a-zA-Z][a-zA-Z0-9_-]*|\\[\\s*[a-zA-Z_][a-zA-Z0-9_-]*(?:\\s*=\\s*(?:"[^"\\n\\r\\f\\\\]*"|\'[^\'\\n\\r\\f\\\\]*\'|[^\\s\\]]+))?\\s*\\])';
  const segmentPattern = `${tokenPattern}(?:${tokenPattern})*`;
  const selectorPattern = `^${segmentPattern}(?:\\s+${segmentPattern})*$`;
  return new RegExp(selectorPattern).test(trimmed);
}

function normalizeRoleSelector(rawValue, role, strict, errors) {
  const normalized = normalizeCommonDataTestIdPattern(rawValue, role);
  if (!normalized.value) return '';
  if (isValidCssSelector(normalized.value)) return normalized.value;
  if (strict && errors) errors[role] = 'Invalid CSS selector';
  return '';
}

function validateTargetSelectors(input = {}, legacy = {}, options = {}) {
  const strict = options?.strict === true;
  const errors = {};
  const raw = input && typeof input === 'object' ? input : {};
  const old = legacy && typeof legacy === 'object' ? legacy : {};
  const watchedFallback = typeof old.watchedElementSelector === 'string' && old.watchedElementSelector.trim()
    ? old.watchedElementSelector.trim()
    : DEFAULT_SETTINGS.targetSelectors.watchedElement;

  const selectors = {
    promptInput: normalizeRoleSelector(raw.promptInput, 'promptInput', strict, errors),
    sendButton: normalizeRoleSelector(raw.sendButton, 'sendButton', strict, errors),
    stopButton: normalizeRoleSelector(raw.stopButton, 'stopButton', strict, errors),
    watchedElement: '',
  };

  const watchedRaw = typeof raw.watchedElement === 'string' && raw.watchedElement.trim()
    ? raw.watchedElement.trim()
    : watchedFallback;
  selectors.watchedElement = normalizeRoleSelector(watchedRaw, 'watchedElement', strict, errors) || DEFAULT_SETTINGS.targetSelectors.watchedElement;

  return { selectors, errors };
}

function validateMemorySettings(input = {}) {
  const memoryInput = input && typeof input === 'object' ? input : {};
  const includeClasses = Array.isArray(memoryInput.includeClasses)
    ? memoryInput.includeClasses.filter((c) => MEMORY_CLASSES.includes(c))
    : DEFAULT_MEMORY_SETTINGS.includeClasses.slice();
  const excludeClasses = Array.isArray(memoryInput.excludeClasses)
    ? memoryInput.excludeClasses.filter((c) => MEMORY_CLASSES.includes(c))
    : [];
  const authMode = memoryInput.authMode === 'stored_token' ? 'stored_token' : 'native_host';
  const querySource = ['prompt_box', 'selection', 'clipboard', 'page', 'manual', 'combined'].includes(memoryInput.querySource)
    ? memoryInput.querySource
    : DEFAULT_MEMORY_SETTINGS.querySource;
  const mode = ['smart', 'compact_hits', 'full_pack', 'debug'].includes(memoryInput.mode)
    ? memoryInput.mode
    : DEFAULT_MEMORY_SETTINGS.mode;
  const pinnedPolicy = ['core_only', 'relevant_only', 'all', 'none'].includes(memoryInput.pinnedPolicy)
    ? memoryInput.pinnedPolicy
    : DEFAULT_MEMORY_SETTINGS.pinnedPolicy;
  const insertBehavior = ['prepend_or_replace_managed_block', 'append', 'replace_selected_text', 'copy_only'].includes(memoryInput.insertBehavior)
    ? memoryInput.insertBehavior
    : DEFAULT_MEMORY_SETTINGS.insertBehavior;

  return {
    enabled: memoryInput.enabled !== false,
    bridgeBaseUrl: sanitizeMemoryBridgeBaseUrl(memoryInput.bridgeBaseUrl),
    authMode,
    nativeHostName: typeof memoryInput.nativeHostName === 'string' && memoryInput.nativeHostName.trim()
      ? memoryInput.nativeHostName.trim()
      : DEFAULT_MEMORY_SETTINGS.nativeHostName,
    storedToken: typeof memoryInput.storedToken === 'string' ? memoryInput.storedToken.trim() : '',
    querySource,
    project: typeof memoryInput.project === 'string' && memoryInput.project.trim() ? memoryInput.project.trim() : DEFAULT_MEMORY_SETTINGS.project,
    mode,
    maxTokens: coerceNumber(memoryInput.maxTokens, 300, 3000, DEFAULT_MEMORY_SETTINGS.maxTokens),
    topK: coerceNumber(memoryInput.topK, 3, 20, DEFAULT_MEMORY_SETTINGS.topK),
    minScore: coerceNumber(memoryInput.minScore, 0, 1, DEFAULT_MEMORY_SETTINGS.minScore),
    pinnedPolicy,
    includeClasses: includeClasses.length ? includeClasses : MEMORY_CLASSES.slice(),
    excludeClasses,
    insertBehavior,
    debug: memoryInput.debug === true,
  };
}

function validateSettings(input = {}, options = {}) {
  const sanitizedUrl = sanitizeUrlOrEmpty(input.openNewChatPerPromptUrl);
  const targetResult = validateTargetSelectors(input.targetSelectors, input, options);
  const targetSelectors = targetResult.selectors;
  if (options?.strict === true && Object.keys(targetResult.errors || {}).length > 0) {
    const err = new Error('Invalid target selector');
    err.validationErrors = targetResult.errors;
    throw err;
  }
  const rawStableMin = coerceNumber(input.stableMinMs ?? input.stableMs, 100, 60000, DEFAULT_SETTINGS.stableMinMs);
  const rawStableMax = coerceNumber(input.stableMaxMs ?? input.stableMs, 100, 60000, DEFAULT_SETTINGS.stableMaxMs);
  const stableMinMs = Math.min(rawStableMin, rawStableMax);
  const stableMaxMs = Math.max(rawStableMin, rawStableMax);
  const effectiveStableMs = coerceNumber(input.stableMs, stableMinMs, stableMaxMs, stableMaxMs);
  return {
    stableMs: effectiveStableMs,
    stableMinMs,
    stableMaxMs,
    maxWaitMs: coerceNumber(input.maxWaitMs, 5000, 86400000, DEFAULT_SETTINGS.maxWaitMs),
    pollIntervalMs: coerceNumber(input.pollIntervalMs, 50, 5000, DEFAULT_SETTINGS.pollIntervalMs),
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
    appendPromptText: typeof input.appendPromptText === 'string' ? input.appendPromptText : DEFAULT_SETTINGS.appendPromptText,
    prependSystemPrompt: input.prependSystemPrompt !== false,
    appendSystemPrompt: input.appendSystemPrompt === true,
    theme: input.theme === 'light' ? 'light' : 'dark',
    autoConfirmDialogs: input.autoConfirmDialogs === true,
    enableWatchedElementGate: input.enableWatchedElementGate === true,
    watchedElementSelector: targetSelectors.watchedElement,
    targetSelectors,
    refreshTabBeforeEachPrompt: input.refreshTabBeforeEachPrompt === true,
    parallelOneTabPerPrompt: input.parallelOneTabPerPrompt === true,
    enableRetryOnFailure: input.enableRetryOnFailure !== false,
    maxRetriesPerPrompt: coerceNumber(input.maxRetriesPerPrompt, 0, 10, DEFAULT_SETTINGS.maxRetriesPerPrompt),
    retryDelayMs: coerceNumber(input.retryDelayMs, 0, 60000, DEFAULT_SETTINGS.retryDelayMs),
    debugLoggingEnabled: input.debugLoggingEnabled === true,
    enableMaxWaitTimeout: input.enableMaxWaitTimeout !== false,
    enableStopWord: input.enableStopWord === true,
    stopWord: typeof input.stopWord === 'string' ? input.stopWord.trim() : DEFAULT_SETTINGS.stopWord,
    stopWordCaseSensitive: input.stopWordCaseSensitive === true,
    openNewChatPerPrompt: input.openNewChatPerPrompt === true,
    openNewChatPerPromptUrl: sanitizedUrl,
    memory: validateMemorySettings(input.memory || {}),
  };
}

function publicSettings(settings = state.options) {
  const safe = { ...(settings || {}) };
  safe.memory = { ...(safe.memory || DEFAULT_MEMORY_SETTINGS) };
  safe.memory.hasStoredToken = Boolean(safe.memory.storedToken);
  safe.memory.storedToken = '';
  return safe;
}

function sanitizeSettingsForHistory(settings = {}) {
  const safe = publicSettings(validateSettings({ ...DEFAULT_SETTINGS, ...(settings || {}) }));
  if (safe.memory) {
    safe.memory.storedToken = safe.memory.hasStoredToken ? '<stored>' : '';
  }
  return safe;
}

function sanitizeUrlOrEmpty(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.toString();
    }
  } catch (_) {
    return '';
  }
  return '';
}

function truncateForStatus(text, maxChars = PROMPT_PREVIEW_CHARS) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function clampStoredResponseText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= RESPONSE_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, Math.max(0, RESPONSE_TEXT_CHARS - 28))}\n\n[response truncated]`;
}

function pushPromptDuration(target, startedAt, completedAt = Date.now()) {
  const start = Number(startedAt || 0);
  if (!target || !Number.isFinite(start) || start <= 0) return 0;
  const duration = Math.max(0, completedAt - start);
  if (duration <= 0) return 0;
  const durations = Array.isArray(target.responseDurations) ? target.responseDurations : [];
  durations.push(duration);
  target.responseDurations = durations.slice(-20);
  return duration;
}

function averageDurationMs(durations) {
  const clean = (Array.isArray(durations) ? durations : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (clean.length === 0) return 0;
  return Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length);
}

function buildTimingStatus({ running, processing, promptStartTime, currentIndex, total, responseDurations }) {
  const averageResponseMs = averageDurationMs(responseDurations);
  const elapsedPromptMs = running && promptStartTime ? Math.max(0, Date.now() - Number(promptStartTime || 0)) : 0;
  let etaMs = 0;
  if (running && averageResponseMs > 0 && Number.isFinite(total) && Number.isFinite(currentIndex)) {
    const remainingAfterCurrent = Math.max(0, Number(total) - Number(currentIndex) - 1);
    etaMs = remainingAfterCurrent * averageResponseMs;
    if (processing && elapsedPromptMs > 0) {
      etaMs += Math.max(0, averageResponseMs - elapsedPromptMs);
    }
  }
  return { averageResponseMs, elapsedPromptMs, etaMs };
}

async function recordCapturedResponse(record = {}) {
  const responseText = clampStoredResponseText(record.responseText);
  if (!responseText) return false;
  const safeRecord = {
    promptId: record.promptId ? String(record.promptId) : '',
    promptIndex: Number.isFinite(record.promptIndex) ? Number(record.promptIndex) : null,
    tabId: Number.isFinite(record.tabId) ? Number(record.tabId) : null,
    mode: record.mode || 'sequential',
    site: record.site || '',
    url: typeof record.url === 'string' ? record.url.slice(0, 500) : '',
    promptText: clampStoredResponseText(record.promptText),
    promptPreview: truncateForStatus(record.promptText),
    responseText,
    responsePreview: truncateForStatus(responseText),
    durationMs: Number.isFinite(record.durationMs) ? Number(record.durationMs) : 0,
    capturedAt: Date.now(),
  };
  const stored = await chrome.storage.local.get(RESPONSE_LOG_STORAGE_KEY);
  const existing = Array.isArray(stored?.[RESPONSE_LOG_STORAGE_KEY])
    ? stored[RESPONSE_LOG_STORAGE_KEY]
    : [];
  const next = [safeRecord, ...existing]
    .filter((item, index, arr) => {
      if (!item?.promptId) return true;
      return arr.findIndex((candidate) => candidate?.promptId === item.promptId) === index;
    })
    .slice(0, RESPONSE_RECORD_LIMIT);
  await chrome.storage.local.set({ [RESPONSE_LOG_STORAGE_KEY]: next });
  return true;
}

function getStatus() {
  const parallel = state.parallel || {};
  const timing = buildTimingStatus({
    running: state.running,
    processing: state.processing,
    promptStartTime: state.promptStartTime,
    currentIndex: state.currentIndex,
    total: state.prompts.length,
    responseDurations: state.responseDurations,
  });
  return {
    running: state.running,
    paused: state.paused,
    total: state.prompts.length,
    currentIndex: state.currentIndex,
    mode: state.mode || 'sequential',
    tabId: state.tabId,
    options: state.options,
    recoveryAttempts: state.recoveryAttempts,
    currentRetryCount: state.currentRetryCount || 0,
    stableCountdownMs: state.stableCountdownMs,
    currentPromptPreview: state.running ? truncateForStatus(state.prompts[state.currentIndex]) : '',
    ...timing,
    parallelLaunched: parallel.launched || 0,
    parallelCompleted: parallel.completed || 0,
    parallelFailed: parallel.failed || 0,
    parallelActive: parallel.active || 0,
    parallelLastFailure: parallel.lastFailure || null,
  };
}

// ============ STATE PERSISTENCE ============

function createEmptyParallelState() {
  return {
    launchInProgress: false,
    launchToken: null,
    launchDone: false,
    launchCursor: 0,
    launched: 0,
    completed: 0,
    failed: 0,
    active: 0,
    lastFailure: null,
    dispatchCursor: 0,
    prelaunchCursor: 0,
    workersById: {},
    workersByPromptId: {},
  };
}

async function saveState() {
  const persistentState = {
    prompts: state.prompts,
    currentIndex: state.currentIndex,
    mode: state.mode,
    running: state.running,
    paused: state.paused,
    tabId: state.tabId,
    options: state.options,
    lastActivityTime: state.lastActivityTime,
    lastRecoveryTime: state.lastRecoveryTime,
    recoveryAttempts: state.recoveryAttempts,
    processing: state.processing,
    currentPromptId: state.currentPromptId,
    currentRetryCount: state.currentRetryCount,
    promptStartTime: state.promptStartTime,
    responseDurations: state.responseDurations,
    savedAt: Date.now(),
    stableCountdownMs: state.stableCountdownMs,
    parallel: state.parallel,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE || 'aiTaskSequencerState']: persistentState });
}

async function loadState() {
  const stateKey = STORAGE_KEYS.STATE || 'aiTaskSequencerState';
  const storedState = await chrome.storage.local.get(stateKey);
  const aiTaskSequencerState = storedState?.[stateKey];
  hasHydratedPersistentState = true;
  if (aiTaskSequencerState) {
    const oldState = { running: state.running, currentIndex: state.currentIndex, prompts: state.prompts.length };
    state.prompts = aiTaskSequencerState.prompts || [];
    state.currentIndex = aiTaskSequencerState.currentIndex || 0;
    state.mode = aiTaskSequencerState.mode || state.mode || 'sequential';
    state.running = aiTaskSequencerState.running || state.running || false;
    state.tabId = aiTaskSequencerState.tabId || state.tabId || null;
    state.options = aiTaskSequencerState.options || state.options;
    state.lastActivityTime = aiTaskSequencerState.lastActivityTime || state.lastActivityTime || Date.now();
    state.lastRecoveryTime = aiTaskSequencerState.lastRecoveryTime || state.lastRecoveryTime || 0;
    state.recoveryAttempts = aiTaskSequencerState.recoveryAttempts || state.recoveryAttempts || 0;
    state.stableCountdownMs = aiTaskSequencerState.stableCountdownMs || state.stableCountdownMs || 0;
    state.paused = aiTaskSequencerState.paused || false;
    // Prefer in-memory processing state if already true to avoid reverting to stale persisted false.
    state.processing = state.processing || aiTaskSequencerState.processing || false;
    state.currentPromptId = aiTaskSequencerState.currentPromptId || state.currentPromptId || null;
    state.currentRetryCount = aiTaskSequencerState.currentRetryCount || state.currentRetryCount || 0;
    state.promptStartTime = aiTaskSequencerState.promptStartTime || state.promptStartTime || (state.processing ? state.lastActivityTime : 0);
    state.responseDurations = Array.isArray(aiTaskSequencerState.responseDurations) ? aiTaskSequencerState.responseDurations.slice(-20) : [];
    if (state.mode === 'parallel') {
      const restoredParallel = aiTaskSequencerState.parallel || {};
      state.parallel = {
        ...createEmptyParallelState(),
        ...restoredParallel,
        workersById: restoredParallel.workersById || {},
        workersByPromptId: restoredParallel.workersByPromptId || {},
      };
    } else {
      state.parallel = null;
    }
    console.log('[LoadState] State loaded from storage', {
      oldState,
      newState: { 
        running: state.running, 
        currentIndex: state.currentIndex, 
        prompts: state.prompts.length,
        mode: state.mode,
        processing: state.processing,
        currentPromptId: state.currentPromptId,
        currentRetryCount: state.currentRetryCount,
        promptStartTime: state.promptStartTime,
        lastActivityTime: state.lastActivityTime,
        lastRecoveryTime: state.lastRecoveryTime,
      }
    });
    return true;
  }
  return false;
}

async function clearState() {
  await chrome.storage.local.remove(STORAGE_KEYS.STATE || 'aiTaskSequencerState');
  if (sequentialRetryTimer) {
    clearTimeout(sequentialRetryTimer);
    sequentialRetryTimer = null;
  }
  for (const [, waiter] of parallelSubmissionWaiters.entries()) {
    clearTimeout(waiter.timeoutId);
    try {
      waiter.reject(new Error('Automation stopped'));
    } catch (_) {}
  }
  parallelSubmissionWaiters.clear();
  state.mode = 'sequential';
  state.running = false;
  state.paused = false;
  state.prompts = [];
  state.currentIndex = 0;
  state.tabId = null;
  state.recoveryAttempts = 0;
  state.processing = false;
  state.currentPromptId = null;
  state.currentRetryCount = 0;
  state.promptStartTime = 0;
  state.responseDurations = [];
  state.stableCountdownMs = 0;
  state.parallel = null;
}

const TAB_SESSIONS_STORAGE_KEY = STORAGE_KEYS.TAB_SESSIONS || 'aiTaskSequencerTabSessions';
const tabSessions = new Map();
const tabSessionRetryTimers = new Map();
let hasHydratedTabSessions = false;

function createIdleStatusForTab(tabId, options = state.options) {
  return {
    running: false,
    paused: false,
    total: 0,
    currentIndex: 0,
    mode: 'sequential',
    tabId: Number.isInteger(Number(tabId)) ? Number(tabId) : null,
    options: options || state.options,
    recoveryAttempts: 0,
    currentRetryCount: 0,
    stableCountdownMs: 0,
    parallelLaunched: 0,
    parallelCompleted: 0,
    parallelFailed: 0,
    parallelActive: 0,
    parallelLastFailure: null,
  };
}

function buildTabSessionStatus(session) {
  if (!session) return createIdleStatusForTab(null);
  const total = Array.isArray(session.prompts) ? session.prompts.length : 0;
  const currentIndex = Number.isFinite(session.currentIndex) ? Number(session.currentIndex) : 0;
  const timing = buildTimingStatus({
    running: session.running === true,
    processing: session.processing === true,
    promptStartTime: session.promptStartTime,
    currentIndex,
    total,
    responseDurations: session.responseDurations,
  });
  return {
    running: session.running === true,
    paused: session.paused === true,
    total,
    currentIndex,
    mode: 'sequential',
    tabId: session.tabId,
    options: session.options || state.options,
    recoveryAttempts: Number(session.recoveryAttempts || 0),
    currentRetryCount: Number(session.currentRetryCount || 0),
    stableCountdownMs: Number(session.stableCountdownMs || 0),
    currentPromptPreview: session.running ? truncateForStatus(session.prompts?.[currentIndex]) : '',
    ...timing,
    parallelLaunched: 0,
    parallelCompleted: 0,
    parallelFailed: 0,
    parallelActive: 0,
    parallelLastFailure: null,
  };
}

function cloneTabSessionForStorage(session) {
  return {
    prompts: Array.isArray(session.prompts) ? session.prompts.slice() : [],
    currentIndex: Number(session.currentIndex || 0),
    running: session.running === true,
    paused: session.paused === true,
    tabId: session.tabId,
    options: session.options || state.options,
    lastActivityTime: Number(session.lastActivityTime || Date.now()),
    processing: session.processing === true,
    currentPromptId: session.currentPromptId || null,
    currentRetryCount: Number(session.currentRetryCount || 0),
    promptStartTime: Number(session.promptStartTime || 0),
    responseDurations: Array.isArray(session.responseDurations) ? session.responseDurations.slice(-20) : [],
    stableCountdownMs: Number(session.stableCountdownMs || 0),
    recoveryAttempts: Number(session.recoveryAttempts || 0),
    savedAt: Date.now(),
  };
}

async function saveTabSessions() {
  const serialized = {};
  for (const [tabId, session] of tabSessions.entries()) {
    serialized[String(tabId)] = cloneTabSessionForStorage(session);
  }
  await chrome.storage.local.set({ [TAB_SESSIONS_STORAGE_KEY]: serialized });
}

async function loadTabSessions() {
  if (hasHydratedTabSessions) return;
  hasHydratedTabSessions = true;
  try {
    const stored = await chrome.storage.local.get([TAB_SESSIONS_STORAGE_KEY]);
    const raw = stored?.[TAB_SESSIONS_STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return;
    for (const [rawTabId, rawSession] of Object.entries(raw)) {
      const tabId = Number(rawTabId);
      if (!Number.isInteger(tabId) || !rawSession || typeof rawSession !== 'object') continue;
      tabSessions.set(tabId, {
        prompts: Array.isArray(rawSession.prompts) ? rawSession.prompts.slice() : [],
        currentIndex: Number(rawSession.currentIndex || 0),
        running: rawSession.running === true,
        paused: rawSession.paused === true,
        tabId,
        options: validateSettings(rawSession.options || state.options),
        lastActivityTime: Number(rawSession.lastActivityTime || Date.now()),
        processing: rawSession.processing === true,
        currentPromptId: rawSession.currentPromptId || null,
        currentRetryCount: Number(rawSession.currentRetryCount || 0),
        promptStartTime: Number(rawSession.promptStartTime || 0),
        responseDurations: Array.isArray(rawSession.responseDurations) ? rawSession.responseDurations.slice(-20) : [],
        stableCountdownMs: Number(rawSession.stableCountdownMs || 0),
        recoveryAttempts: Number(rawSession.recoveryAttempts || 0),
      });
    }
  } catch (e) {
    console.error('[TabSession] Failed to hydrate sessions:', e);
  }
}

async function pruneClosedTabSessions() {
  let changed = false;
  for (const [tabId] of tabSessions.entries()) {
    try {
      await chrome.tabs.get(tabId);
    } catch (_) {
      clearTabSessionRetryTimer(tabId);
      tabSessions.delete(tabId);
      changed = true;
    }
  }
  if (changed) {
    await saveTabSessions();
  }
}

function clearTabSessionRetryTimer(tabId) {
  const timerId = tabSessionRetryTimers.get(tabId);
  if (timerId) {
    clearTimeout(timerId);
    tabSessionRetryTimers.delete(tabId);
  }
}

function buildMessageTextWithOptions(text, options = {}) {
  const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt.trim() : '';
  const appendPromptText = typeof options.appendPromptText === 'string' ? options.appendPromptText.trim() : '';
  const prependSystemPrompt = options.prependSystemPrompt !== false;
  const appendSystemPrompt = options.appendSystemPrompt === true;

  if (!(prependSystemPrompt && systemPrompt) && !(appendSystemPrompt && appendPromptText)) {
    return text;
  }

  let out = text;
  if (prependSystemPrompt && systemPrompt) {
    out = `${systemPrompt}\n\n${out}`;
  }
  if (appendSystemPrompt && appendPromptText) {
    out = `${out}\n\n${appendPromptText}`;
  }
  return out;
}

async function emitTabSessionProgress(tabId) {
  const session = tabSessions.get(tabId);
  if (!session) return;
  try {
    chrome.runtime.sendMessage({
      type: 'AUTOMATION_PROGRESS',
      tabId,
      status: buildTabSessionStatus(session),
    });
  } catch (_) {}
}

async function emitTabSessionError(tabId, error) {
  const session = tabSessions.get(tabId);
  const message = String(error?.message || error);
  const details = typeof error === 'object' && error !== null
    ? (typeof error.details === 'string'
      ? error.details
      : (error.snapshot ? JSON.stringify(error.snapshot, null, 2) : null))
    : null;
  try {
    chrome.runtime.sendMessage({
      type: 'AUTOMATION_ERROR',
      tabId,
      error: message,
      details,
      stack: typeof error?.stack === 'string' ? error.stack : null,
      status: session ? buildTabSessionStatus(session) : createIdleStatusForTab(tabId),
    });
  } catch (_) {}
}

async function emitTabSessionComplete(tabId, status, reason) {
  try {
    chrome.runtime.sendMessage({
      type: 'AUTOMATION_COMPLETE',
      tabId,
      status: status || createIdleStatusForTab(tabId),
      reason,
    });
  } catch (_) {}
}

async function stopTabSession(tabId, { reason = 'stoppedByUser', emitComplete = false } = {}) {
  const session = tabSessions.get(tabId);
  if (!session) return false;
  clearTabSessionRetryTimer(tabId);
  const completionStatus = {
    ...buildTabSessionStatus(session),
    running: false,
    paused: false,
  };
  tabSessions.delete(tabId);
  await saveTabSessions();
  if (emitComplete) {
    await emitTabSessionComplete(tabId, completionStatus, reason);
  }
  return true;
}

async function scheduleTabSessionRetry(tabId, errorMessage, source) {
  const session = tabSessions.get(tabId);
  if (!session || !session.running) return false;
  const retryPolicy = getRetryPolicy(session.options);
  if (!retryPolicy.enabled || retryPolicy.maxRetries <= 0) return false;
  if (session.currentRetryCount >= retryPolicy.maxRetries) return false;

  session.currentRetryCount += 1;
  session.processing = false;
  session.promptStartTime = 0;
  session.currentPromptId = null;
  session.lastActivityTime = Date.now();
  await saveTabSessions();
  await emitTabSessionProgress(tabId);

  console.warn('[Retry][TabSession] Scheduling retry', {
    source,
    tabId,
    promptIndex: session.currentIndex,
    retryAttempt: session.currentRetryCount,
    maxRetries: retryPolicy.maxRetries,
    retryDelayMs: retryPolicy.retryDelayMs,
    error: errorMessage,
  });

  clearTabSessionRetryTimer(tabId);
  const timerId = setTimeout(() => {
    tabSessionRetryTimers.delete(tabId);
    (async () => {
      const liveSession = tabSessions.get(tabId);
      if (!liveSession || !liveSession.running || liveSession.paused) return;
      try {
        await sendNextPromptForTabSession(tabId);
      } catch (retryErr) {
        console.error('[Retry][TabSession] Retry send failed', {
          tabId,
          promptIndex: liveSession.currentIndex,
          retryAttempt: liveSession.currentRetryCount,
          error: retryErr?.message || String(retryErr),
        });
      }
    })();
  }, retryPolicy.retryDelayMs);
  tabSessionRetryTimers.set(tabId, timerId);
  return true;
}

async function sendNextPromptForTabSession(tabId) {
  const session = tabSessions.get(tabId);
  if (!session || !session.running) return;
  if (session.paused || session.processing) return;

  if (session.currentIndex >= session.prompts.length) {
    const finalStatus = {
      ...buildTabSessionStatus(session),
      running: false,
      paused: false,
      currentIndex: session.prompts.length,
    };
    tabSessions.delete(tabId);
    clearTabSessionRetryTimer(tabId);
    await saveTabSessions();
    await emitTabSessionComplete(tabId, finalStatus);
    return;
  }

  const basePromptText = session.prompts[session.currentIndex];
  const promptText = buildMessageTextWithOptions(basePromptText, session.options);
  const stableMin = session.options?.stableMinMs ?? DEFAULT_SETTINGS.stableMinMs;
  const stableMax = session.options?.stableMaxMs ?? DEFAULT_SETTINGS.stableMaxMs;
  const stableMs = Math.max(stableMin, Math.min(stableMax, Math.random() * (stableMax - stableMin) + stableMin));

  session.options = { ...session.options, stableMs };
  session.stableCountdownMs = stableMs;
  session.lastActivityTime = Date.now();
  session.promptStartTime = Date.now();
  session.processing = true;
  session.currentPromptId = `tab_${tabId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await saveTabSessions();
  await emitTabSessionProgress(tabId);

  try {
    if (session.options?.openNewChatPerPrompt) {
      const tab = await chrome.tabs.get(tabId);
      const site = detectSiteFromUrl(tab?.url);
      const baseUrl = baseUrlForSite(site);
      const targetUrl = session.options.openNewChatPerPromptUrl || baseUrl;
      if (!targetUrl) {
        throw new Error('Active tab not supported for new chat navigation.');
      }
      await waitForTriggeredTabLoad(tabId, () => chrome.tabs.update(tabId, { url: targetUrl }));
      await ensureContentScriptReady(tabId);
    } else if (session.options?.refreshTabBeforeEachPrompt) {
      await refreshTabInBackgroundBeforeSend(tabId);
    }

    await sendToContent(tabId, {
      type: 'SEND_PROMPT',
      text: promptText,
      index: session.currentIndex,
      total: session.prompts.length,
      options: session.options,
      promptId: session.currentPromptId,
    });
  } catch (err) {
    const rawSendError = String(err?.message || err);
    const sendError = buildBackgroundDispatchFailureMessage(tabId, rawSendError);
    console.error('[TabSession] Error sending prompt:', {
      tabId,
      promptIndex: session.currentIndex,
      error: rawSendError,
      surfacedError: sendError,
    });
    const retried = await scheduleTabSessionRetry(tabId, sendError, 'sendNextPromptForTabSession');
    if (retried) {
      return;
    }
    await emitTabSessionError(tabId, sendError);
    await stopTabSession(tabId, { reason: 'completedWithErrors', emitComplete: true });
  }
}

async function startTabSession({ prompts, tabId, options }) {
  if (!Number.isInteger(tabId)) {
    throw new Error('Missing tabId for tab session.');
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }
  const session = {
    prompts: Array.isArray(prompts) ? prompts.slice() : [],
    currentIndex: 0,
    running: true,
    paused: false,
    tabId,
    options: validateSettings(options || state.options),
    lastActivityTime: Date.now(),
    processing: false,
    currentPromptId: null,
    currentRetryCount: 0,
    promptStartTime: 0,
    responseDurations: [],
    stableCountdownMs: 0,
    recoveryAttempts: 0,
  };
  tabSessions.set(tabId, session);
  await saveTabSessions();
  await emitTabSessionProgress(tabId);
  await injectContentScript(tabId);
  await sendNextPromptForTabSession(tabId);
}

function resolveTabSessionForMessage(message, sender) {
  const senderTabId = sender?.tab?.id;
  if (Number.isInteger(senderTabId) && tabSessions.has(senderTabId)) {
    return { tabId: senderTabId, session: tabSessions.get(senderTabId) };
  }
  const promptId = message?.promptId ? String(message.promptId) : '';
  if (!promptId) return { tabId: null, session: null };
  for (const [tabId, session] of tabSessions.entries()) {
    if (String(session.currentPromptId || '') === promptId) {
      return { tabId, session };
    }
  }
  return { tabId: null, session: null };
}

// ============ TAB & CONNECTION HEALTH ============

async function isTabAlive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && !tab.discarded && isSupportedUrl(tab.url);
  } catch {
    return false;
  }
}

async function testContentScriptConnection(tabId) {
  return new Promise((resolve) => {
    try {
      const timeoutId = setTimeout(() => {
        console.log('[TestConnection] Timeout reached');
        resolve(false);
      }, 2000);

      chrome.tabs.sendMessage(
        tabId,
        { type: "PING" },
        (response) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            console.error('[TestConnection] Error:', chrome.runtime.lastError);
            resolve(false);
          } else {
            resolve(response?.ok === true);
          }
        }
      );
    } catch (e) {
      console.error('[TestConnection] Error:', e);
      resolve(false);
    }
  });
}

async function ensureContentScriptReady(tabId) {
  const isConnected = await testContentScriptConnection(tabId);
  if (!isConnected) {
    await injectContentScript(tabId);
    // Wait a bit for injection
    await new Promise(resolve => setTimeout(resolve, 500));
    const stillConnected = await testContentScriptConnection(tabId);
    return stillConnected;
  }
  return true;
}

// ============ RECOVERY LOGIC ============

async function attemptRecovery() {
  if (state.mode === 'parallel') {
    console.log('[Recovery] Parallel mode active; skipping sequential recovery path');
    return false;
  }
  console.log('[Recovery] Attempting recovery...', {
    currentIndex: state.currentIndex,
    attempts: state.recoveryAttempts,
    processing: state.processing,
  });

  if (!state.running || !state.tabId) {
    console.log('[Recovery] Not running or no tab, clearing state');
    await clearState();
    return false;
  }
  
  // Don't recover if a prompt is already being processed - just update activity time
  if (state.processing) {
    console.log('[Recovery] Already processing a prompt, just refreshing activity time');
    state.lastActivityTime = Date.now();
    await saveState();
    return true;
  }

  if (state.recoveryAttempts >= RECOVERY_CONFIG.maxRecoveryAttempts) {
    console.log('[Recovery] Max attempts reached, stopping automation');
    state.running = false;
    await saveState();
    try {
      chrome.runtime.sendMessage({ 
        type: "AUTOMATION_ERROR", 
        error: "Failed to recover after sleep/wake. Please restart.", 
        status: getStatus() 
      });
    } catch (_) {}
    return false;
  }

  state.recoveryAttempts += 1;
  
  // Exponential backoff delay
  const backoffDelay = Math.min(
    RECOVERY_CONFIG.recoveryDelayMs * Math.pow(RECOVERY_CONFIG.recoveryBackoffMultiplier, state.recoveryAttempts - 1),
    10000 // Cap at 10 seconds
  );

  await saveState();

  const tabAlive = await isTabAlive(state.tabId);
  if (!tabAlive) {
    console.log('[Recovery] Tab no longer exists or not supported');
    state.running = false;
    await saveState();
    try {
      chrome.runtime.sendMessage({ 
        type: "AUTOMATION_ERROR", 
        error: "Tab was closed or navigated away. Automation stopped.", 
        status: getStatus() 
      });
    } catch (_) {}
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, backoffDelay));
  const ready = await ensureContentScriptReady(state.tabId);
  
  if (!ready) {
    console.log('[Recovery] Could not establish connection to content script');
    return false;
  }

  console.log('[Recovery] Connection restored, resuming automation');
  state.lastActivityTime = Date.now();
  state.promptStartTime = Date.now();
  await saveState();
  
  try {
    await sendNextPrompt();
  } catch (e) {
    console.error('[Recovery] Error resuming automation:', e);
    return false;
  }
  return true;
}

async function healthCheck() {
  if (!state.running || state.paused) return;

  const now = Date.now();
  const timeSinceActivity = now - state.lastActivityTime;
  const timeSinceLastRecovery = now - state.lastRecoveryTime;
  console.log('[Health] Tick', {
    running: state.running,
    processing: state.processing,
    promptStartTime: state.promptStartTime,
    timeSinceActivity,
    timeSinceLastRecovery,
    recoveryAttempts: state.recoveryAttempts,
    staleThreshold: RECOVERY_CONFIG.staleThresholdMs,
  });

  if (state.mode === 'parallel') {
    await maybeFinalizeParallelRun();
    return;
  }

  // If we're actively processing a prompt and still within the per-prompt timeout window,
  // treat the flow as healthy and refresh activity to avoid premature recovery.
  if (state.processing && state.promptStartTime) {
    const processingElapsed = now - state.promptStartTime;
    const maxPerPrompt = state.options?.maxWaitMs || DEFAULT_SETTINGS.maxWaitMs;
    if (processingElapsed < maxPerPrompt) {
      console.log('[Health] Processing in-flight prompt; refreshing activity and skipping recovery', {
        processingElapsed,
        maxPerPrompt,
      });
      state.lastActivityTime = now;
      saveState(); // fire-and-forget; best effort to keep state fresh
      return;
    }
    console.warn('[Health] Processing elapsed exceeded maxPerPrompt; recovery allowed', {
      processingElapsed,
      maxPerPrompt,
    });
  }

  if (timeSinceLastRecovery < RECOVERY_CONFIG.minRecoveryIntervalMs) {
    console.log('[Health] Skipping recovery due to min interval guard', { timeSinceLastRecovery });
    return;
  }

  if (timeSinceActivity > RECOVERY_CONFIG.staleThresholdMs) {
    console.log('[Health] Detected stale state (no activity for ' + timeSinceActivity + 'ms), attempting recovery');
    state.lastRecoveryTime = now;
    await attemptRecovery();
  }
}

setInterval(healthCheck, RECOVERY_CONFIG.healthCheckIntervalMs);

// ============ SETTINGS ============

async function loadSettings() {
  let rawSettings = null;
  try {
    const localResult = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    rawSettings = localResult?.[SETTINGS_STORAGE_KEY] || null;
    if (!rawSettings) {
      // One-time fallback for older builds that stored settings in sync.
      const syncResult = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
      rawSettings = syncResult?.[SETTINGS_STORAGE_KEY] || null;
      if (rawSettings) {
        await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: rawSettings });
      }
    }
  } catch (e) {
    console.warn('[LoadSettings] Failed to read settings storage, using defaults:', e?.message || e);
  }
  const merged = validateSettings({ ...DEFAULT_SETTINGS, ...(rawSettings || {}) });
  state.options = merged;
  applyDebugLoggingSetting(state.options?.debugLoggingEnabled === true);
}

async function saveSettings(newSettings) {
  const currentMemory = state.options?.memory || DEFAULT_MEMORY_SETTINGS;
  const incomingMemory = newSettings?.memory || {};
  const nextMemory = { ...currentMemory, ...incomingMemory };
  if (!Object.prototype.hasOwnProperty.call(incomingMemory, 'storedToken')) {
    nextMemory.storedToken = currentMemory.storedToken || '';
  }
  const merged = validateSettings({ ...state.options, ...newSettings, memory: nextMemory }, { strict: true });
  state.options = merged;
  applyDebugLoggingSetting(state.options?.debugLoggingEnabled === true);
  try {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
  } catch (e) {
    console.error('[SaveSettings] Failed to persist settings:', e);
    throw e;
  }
  await broadcastSettingsUpdate();
  await ensureAutoConfirmContentScript();
}

if (self.__PROMPT_QUEUE_TEST__) {
  self.PromptQueueBackgroundTest = {
    DEFAULT_SETTINGS,
    saveSettings,
    validateSettings,
    validateTargetSelectors,
    waitForTriggeredTabLoad,
  };
}

async function broadcastSettingsUpdate() {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
      if (tab?.id && isSupportedUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: publicSettings() }, () => {
          // Read lastError to avoid unchecked runtime errors
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (_) {}
}

async function callNativeMemory(type, payload = {}) {
  const memory = state.options?.memory || DEFAULT_MEMORY_SETTINGS;
  const response = await chrome.runtime.sendNativeMessage(memory.nativeHostName, {
    type,
    ...payload,
  });
  if (!response) {
    throw new Error('Native memory host returned no response');
  }
  if (response.ok === false || response.type === 'error') {
    throw new Error(response.error || response.message || 'Native memory host error');
  }
  if (response.body !== undefined) return response.body;
  if (response.result !== undefined) return response.result;
  return response;
}

async function callDirectBridge(path, options = {}) {
  const memory = state.options?.memory || DEFAULT_MEMORY_SETTINGS;
  if (!memory.storedToken) {
    throw new Error('Memory token missing. Use native host or set stored-token fallback.');
  }
  const headers = {
    ...(options.headers || {}),
    'X-Memory-Token': memory.storedToken,
  };
  const response = await fetch(`${memory.bridgeBaseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {}
  if (!response.ok) {
    const detail = typeof body === 'object' ? (body.detail || body.error || response.statusText) : (body || response.statusText);
    throw new Error(`Memory bridge ${response.status}: ${detail}`);
  }
  return body;
}

async function callMemoryPack(body) {
  await loadSettings();
  const memory = state.options?.memory || DEFAULT_MEMORY_SETTINGS;
  if (memory.authMode === 'native_host') {
    try {
      return await callNativeMemory('memory_pack_browser', body);
    } catch (err) {
      if (!memory.storedToken) throw err;
      console.warn('[MemoryPack] Native host failed; using stored-token fallback', { error: err?.message || String(err) });
    }
  }
  return await callDirectBridge('/pack/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function memoryHealthCheck() {
  await loadSettings();
  const memory = state.options?.memory || DEFAULT_MEMORY_SETTINGS;
  const result = {
    ok: false,
    authMode: memory.authMode,
    bridgeBaseUrl: memory.bridgeBaseUrl,
    nativeHostName: memory.nativeHostName,
    hasStoredToken: Boolean(memory.storedToken),
    projects: [],
  };
  if (memory.authMode === 'native_host') {
    try {
      const native = await callNativeMemory('memory_healthz', {});
      result.ok = true;
      result.native = true;
      result.health = native;
      try {
        const projects = await callNativeMemory('memory_projects', {});
        result.projects = Array.isArray(projects?.projects) ? projects.projects : (Array.isArray(projects) ? projects : []);
      } catch (_) {}
      return result;
    } catch (err) {
      result.nativeError = err?.message || String(err);
      if (!memory.storedToken) {
        result.error = result.nativeError;
        return result;
      }
    }
  }
  try {
    const healthResponse = await fetch(`${memory.bridgeBaseUrl}/healthz`);
    result.health = await healthResponse.json().catch(() => ({}));
    result.ok = healthResponse.ok;
    if (memory.storedToken) {
      try {
        const projects = await callDirectBridge('/memory/projects');
        result.projects = Array.isArray(projects?.projects) ? projects.projects : [];
      } catch (_) {}
    }
    if (!result.ok) {
      result.error = `Memory bridge ${healthResponse.status}`;
    }
  } catch (err) {
    result.error = err?.message || String(err);
  }
  return result;
}

async function ensureAutoConfirmContentScript() {
  if (!state.options?.autoConfirmDialogs) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (tab?.id && isSupportedUrl(tab.url)) {
      await ensureContentScriptReady(tab.id);
    }
  } catch (_) {}
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_STORAGE_KEY]) {
    const next = validateSettings({ ...state.options, ...(changes[SETTINGS_STORAGE_KEY].newValue || {}) });
    state.options = next;
    applyDebugLoggingSetting(state.options?.debugLoggingEnabled === true);
  }
});

// ============ CONTENT SCRIPT INJECTION ============

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content-targets.js", "content.js"],
    });
  } catch (err) {
    console.error("Failed to inject content script:", err);
    throw err;
  }
}

function isSupportedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return (
      /(^|\.)chatgpt\.com$/.test(u.hostname) ||
      /(^|\.)chat\.openai\.com$/.test(u.hostname) ||
      /(^|\.)gemini\.google\.com$/.test(u.hostname) ||
      /(^|\.)grok\.x\.ai$/.test(u.hostname) ||
      /(^|\.)claude\.ai$/.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function detectSiteFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if ((/(^|\.)chatgpt\.com$/i.test(host)) || (/(^|\.)chat\.openai\.com$/i.test(host))) return 'chatgpt';
    if ((/gemini\.google\.com$/i.test(host))) return 'gemini';
    if ((/grok\.x\.ai$/i.test(host))) return 'grok';
    if ((/claude\.ai$/i.test(host))) return 'claude';
  } catch {
    return null;
  }
  return null;
}

function baseUrlForSite(site) {
  switch (site) {
    case 'chatgpt':
      return 'https://chatgpt.com/';
    case 'gemini':
      return 'https://gemini.google.com/app';
    case 'grok':
      return 'https://grok.x.ai/';
    case 'claude':
      return 'https://claude.ai/new';
    default:
      return null;
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        resolve(true);
        return;
      }
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }, 20000);
    });
  });
}

function waitForTriggeredTabLoad(tabId, triggerLoad, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let triggerStarted = false;
    let sawLoading = false;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || !triggerStarted) return;
      if (changeInfo.status === 'loading') {
        sawLoading = true;
        return;
      }
      if (changeInfo.status === 'complete' && sawLoading) {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    timeoutId = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve()
      .then(async () => {
        triggerStarted = true;
        await triggerLoad();
      })
      .catch(fail);
  });
}

async function refreshTabInBackgroundBeforeSend(tabId) {
  const before = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(before?.url)) {
    throw new Error('Target tab not supported for refresh. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }

  console.log('[BackgroundRefresh] Reloading tab before send', {
    tabId,
    url: before.url,
    active: before.active,
    status: before.status,
    discarded: before.discarded === true,
  });

  const loaded = await waitForTriggeredTabLoad(tabId, () => chrome.tabs.reload(tabId));
  if (!loaded) {
    throw new Error('Timed out waiting for background tab reload.');
  }

  // Give the SPA one beat to hydrate after "complete".
  await new Promise((r) => setTimeout(r, 1200));

  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    throw new Error('Content script not ready after background refresh.');
  }

  const after = await chrome.tabs.get(tabId);
  console.log('[BackgroundRefresh] Reload complete', {
    tabId,
    url: after?.url,
    active: after?.active,
    status: after?.status,
    discarded: after?.discarded === true,
  });
}

function resolveParallelLaunchUrl(baseTabUrl, options) {
  return resolveParallelLaunchUrlWithHelpers(baseTabUrl, options, {
    sanitizeUrlOrEmpty,
    isSupportedUrl,
  });
}

function shouldContinueParallelLaunch(token) {
  return !!(
    state.running &&
    state.mode === 'parallel' &&
    state.parallel &&
    state.parallel.launchInProgress &&
    state.parallel.launchToken === token
  );
}

async function waitWhileParallelPaused(token) {
  while (shouldContinueParallelLaunch(token) && state.paused) {
    await new Promise((resolve) => setTimeout(resolve, PARALLEL_CONFIG.launchPausePollMs));
  }
}

function getRetryPolicy(options = state.options) {
  const enabled = options?.enableRetryOnFailure === true;
  const maxRetries = Number.isFinite(Number(options?.maxRetriesPerPrompt))
    ? Math.max(0, Number(options.maxRetriesPerPrompt))
    : DEFAULT_SETTINGS.maxRetriesPerPrompt;
  const retryDelayMs = Number.isFinite(Number(options?.retryDelayMs))
    ? Math.max(0, Number(options.retryDelayMs))
    : DEFAULT_SETTINGS.retryDelayMs;
  return { enabled, maxRetries, retryDelayMs };
}

async function waitForParallelTabLoaded(tabId, launchToken, workerId) {
  let attempt = 0;
  while (shouldContinueParallelLaunch(launchToken)) {
    attempt += 1;
    const loaded = await waitForTabLoad(tabId);
    if (loaded) {
      return true;
    }

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('Parallel tab was closed before it finished loading.');
    }
    if (!isSupportedUrl(tab?.url)) {
      throw new Error('Parallel tab navigated to an unsupported URL before loading.');
    }

    console.warn('[Parallel] Tab load timed out, waiting and retrying', {
      workerId,
      tabId,
      attempt,
      status: tab?.status,
      url: tab?.url,
    });

    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function waitForParallelContentScriptReady(tabId, launchToken, workerId) {
  let attempt = 0;
  while (shouldContinueParallelLaunch(launchToken)) {
    attempt += 1;
    try {
      const ready = await ensureContentScriptReady(tabId);
      if (ready) {
        return true;
      }
      console.warn('[Parallel] Content script not ready yet, retrying', { workerId, tabId, attempt });
    } catch (err) {
      const message = String(err?.message || err || '');
      if (/blocked/i.test(message)) {
        throw new Error(`Content script injection blocked: ${message}`);
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (!isSupportedUrl(tab?.url)) {
          throw new Error('Parallel tab navigated to an unsupported URL while preparing content script.');
        }
      } catch (tabErr) {
        throw new Error('Parallel tab was closed while preparing content script.');
      }

      console.warn('[Parallel] Content script preparation failed, retrying', {
        workerId,
        tabId,
        attempt,
        error: message,
      });
    }

    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  return false;
}

async function emitParallelProgress() {
  try {
    chrome.runtime.sendMessage({ type: 'AUTOMATION_PROGRESS', status: getStatus() });
  } catch (_) {}
}

async function getParallelTabSnapshot(tabId) {
  if (!tabId) return { tabExists: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    return {
      tabExists: true,
      tabId,
      url: tab?.url || null,
      title: tab?.title || null,
      status: tab?.status || null,
      discarded: tab?.discarded === true,
      active: tab?.active === true,
    };
  } catch (err) {
    return {
      tabExists: false,
      tabId,
      tabError: String(err?.message || err),
    };
  }
}

function getParallelDispatchOptions() {
  return {
    ...state.options,
    openNewChatPerPrompt: false,
    refreshTabBeforeEachPrompt: false,
    parallelOneTabPerPrompt: false,
    enableMaxWaitTimeout: false,
    parallelDispatchMode: true,
  };
}

function getParallelMappingDebugSummary() {
  if (!state.parallel) {
    return { hasParallelState: false };
  }
  const workers = Object.values(state.parallel.workersById || {});
  const activeWorkers = workers
    .filter((worker) => worker && worker.status !== 'completed' && worker.status !== 'failed')
    .map((worker) => ({
      workerId: worker.workerId,
      workerIndex: worker.index,
      tabId: worker.tabId || null,
      status: worker.status,
      nextPromptIndex: worker.nextPromptIndex,
      inFlightPromptId: worker.inFlightPromptId || null,
      inFlightPromptIndex: Number.isFinite(worker.inFlightPromptIndex)
        ? Number(worker.inFlightPromptIndex)
        : null,
      nextRetryAt: worker.nextRetryAt || 0,
    }));
  const inFlightWorkers = activeWorkers
    .filter((worker) => !!worker.inFlightPromptId)
    .map((worker) => ({
      workerId: worker.workerId,
      tabId: worker.tabId,
      promptId: worker.inFlightPromptId,
      nextPromptIndex: worker.nextPromptIndex,
      inFlightPromptIndex: worker.inFlightPromptIndex ?? null,
      status: worker.status,
    }));
  return {
    hasParallelState: true,
    mode: state.mode,
    running: state.running,
    mappedPromptCount: Object.keys(state.parallel.workersByPromptId || {}).length,
    activeWorkerCount: activeWorkers.length,
    inFlightWorkerCount: inFlightWorkers.length,
    inFlightWorkers: inFlightWorkers.slice(0, 10),
    activeWorkers: activeWorkers.slice(0, 10),
  };
}

function resolveParallelPromptRef(promptId, senderTabId) {
  if (!state.parallel) return null;
  if (promptId && state.parallel.workersByPromptId[promptId]) {
    const mapped = state.parallel.workersByPromptId[promptId];
    console.log('[Parallel][PromptRef] Resolved via promptId map', {
      promptId,
      senderTabId,
      workerId: mapped?.workerId || null,
      promptIndex: mapped?.promptIndex,
    });
    return mapped;
  }
  // Never remap an explicit promptId via tab fallback; treat it as stale/missing mapping.
  if (promptId) return null;
  if (!senderTabId) return null;

  const fallbackWorker = Object.values(state.parallel.workersById || {}).find((worker) => (
    worker?.tabId === senderTabId &&
    worker?.status !== 'completed' &&
    worker?.status !== 'failed' &&
    !!worker?.inFlightPromptId
  ));
  if (!fallbackWorker) return null;

  const fallbackPromptId = fallbackWorker.inFlightPromptId;
  const fallbackPromptIndex = Number.isFinite(fallbackWorker.inFlightPromptIndex)
    ? Math.max(0, Number(fallbackWorker.inFlightPromptIndex))
    : Number.isFinite(fallbackWorker.nextPromptIndex)
      ? Math.max(0, Number(fallbackWorker.nextPromptIndex))
      : 0;
  const promptRef = {
    workerId: fallbackWorker.workerId,
    promptIndex: fallbackPromptIndex,
  };
  if (fallbackPromptId && !state.parallel.workersByPromptId[fallbackPromptId]) {
    state.parallel.workersByPromptId[fallbackPromptId] = promptRef;
  }
  console.warn('[Parallel][PromptRef] Resolved via tab fallback', {
    promptId,
    senderTabId,
    fallbackPromptId: fallbackPromptId || null,
    workerId: promptRef.workerId,
    promptIndex: promptRef.promptIndex,
  });
  return promptRef;
}

function createParallelSubmissionWaiter(promptId, timeoutMs = 30000) {
  const existing = parallelSubmissionWaiters.get(promptId);
  if (existing) {
    clearTimeout(existing.timeoutId);
    parallelSubmissionWaiters.delete(promptId);
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      parallelSubmissionWaiters.delete(promptId);
      console.warn('[Parallel][SubmissionWaiter] Timed out', {
        promptId,
        timeoutMs,
        mappingSummary: getParallelMappingDebugSummary(),
      });
      reject(new Error(`Timed out waiting for prompt submission: ${promptId}`));
    }, timeoutMs);

    parallelSubmissionWaiters.set(promptId, {
      timeoutId,
      resolve: (payload) => {
        clearTimeout(timeoutId);
        parallelSubmissionWaiters.delete(promptId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        parallelSubmissionWaiters.delete(promptId);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    });
    console.log('[Parallel][SubmissionWaiter] Registered', {
      promptId,
      timeoutMs,
      activeWaiters: parallelSubmissionWaiters.size,
    });
  });
}

function getParallelSubmissionTimeoutMs(options = state.options) {
  const configuredMaxWaitMs = Number(options?.maxWaitMs || DEFAULT_SETTINGS.maxWaitMs);
  const baseMaxWaitMs = Number.isFinite(configuredMaxWaitMs)
    ? configuredMaxWaitMs
    : DEFAULT_SETTINGS.maxWaitMs;
  // Allow time for in-tab queueing (previous prompt still finishing) before stream start.
  return Math.min(Math.max(baseMaxWaitMs + 30000, 90000), 600000);
}

function settleParallelSubmission(promptId, payload) {
  if (!promptId) return false;
  const waiter = parallelSubmissionWaiters.get(promptId);
  if (!waiter) {
    console.warn('[Parallel][SubmissionWaiter] No waiter to settle', {
      promptId,
      payload: payload || null,
      mappingSummary: getParallelMappingDebugSummary(),
    });
    return false;
  }
  console.log('[Parallel][SubmissionWaiter] Settled', {
    promptId,
    payload: payload || null,
    activeWaitersBeforeSettle: parallelSubmissionWaiters.size,
  });
  waiter.resolve(payload);
  return true;
}

function rejectParallelSubmission(promptId, error) {
  if (!promptId) return false;
  const waiter = parallelSubmissionWaiters.get(promptId);
  if (!waiter) {
    console.warn('[Parallel][SubmissionWaiter] No waiter to reject', {
      promptId,
      error: String(error?.message || error),
      mappingSummary: getParallelMappingDebugSummary(),
    });
    return false;
  }
  console.warn('[Parallel][SubmissionWaiter] Rejected', {
    promptId,
    error: String(error?.message || error),
    activeWaitersBeforeReject: parallelSubmissionWaiters.size,
  });
  waiter.reject(error instanceof Error ? error : new Error(String(error)));
  return true;
}

function buildBackgroundDispatchFailureMessage(tabId, errorMessage) {
  const detail = String(errorMessage || 'Unknown background dispatch error').trim();
  if (detail.toLowerCase().startsWith('background send/check failed')) {
    return detail;
  }
  const tabLabel = Number.isInteger(tabId) ? `tab ${tabId}` : 'this tab';
  return `Background send/check failed in ${tabLabel}. Inspect that tab manually. ${detail}`;
}

async function prepareParallelWorkerBackgroundDispatch(tabId, workerId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    throw new Error(`Worker tab is unavailable (${workerId}): ${String(err?.message || err)}`);
  }

  const backgroundReady = tab?.discarded !== true && tab?.status === 'complete';
  const snapshot = {
    workerId,
    tabId,
    windowId: tab?.windowId,
    active: tab?.active === true,
    discarded: tab?.discarded === true,
    status: tab?.status || null,
    url: tab?.url || null,
  };

  if (!backgroundReady) {
    console.warn('[Parallel] Worker tab not fully ready for background dispatch; continuing without focus fallback', snapshot);
  } else {
    console.log('[Parallel] Worker tab ready for background dispatch', snapshot);
  }

  return {
    activated: false,
    alreadyActive: tab?.active === true,
    fallbackUsed: !backgroundReady,
    backgroundReady,
  };
}

function getRandomPrelaunchGapMs() {
  return 1000 + Math.floor(Math.random() * 1001);
}

async function scheduleSequentialRetry(errorMessage, source) {
  if (!state.running || state.mode === 'parallel') return false;
  const retryPolicy = getRetryPolicy(state.options);
  if (!retryPolicy.enabled || retryPolicy.maxRetries <= 0) return false;
  if (state.currentRetryCount >= retryPolicy.maxRetries) return false;

  state.currentRetryCount += 1;
  state.processing = false;
  state.promptStartTime = 0;
  state.currentPromptId = null;
  state.lastActivityTime = Date.now();
  await saveState();
  try {
    chrome.runtime.sendMessage({ type: 'AUTOMATION_PROGRESS', status: getStatus() });
  } catch (_) {}

  console.warn('[Retry][Sequential] Scheduling retry', {
    source,
    promptIndex: state.currentIndex,
    retryAttempt: state.currentRetryCount,
    maxRetries: retryPolicy.maxRetries,
    retryDelayMs: retryPolicy.retryDelayMs,
    error: errorMessage,
  });

  if (sequentialRetryTimer) {
    clearTimeout(sequentialRetryTimer);
  }
  sequentialRetryTimer = setTimeout(() => {
    sequentialRetryTimer = null;
    (async () => {
      if (!state.running || state.mode !== 'sequential') return;
      if (state.paused) return;
      try {
        await sendNextPrompt();
      } catch (retryErr) {
        console.error('[Retry][Sequential] Retry send failed', {
          promptIndex: state.currentIndex,
          retryAttempt: state.currentRetryCount,
          error: retryErr?.message || String(retryErr),
        });
      }
    })();
  }, retryPolicy.retryDelayMs);

  return true;
}

async function scheduleParallelPromptRetry(workerId, promptIndex, errorMessage, source) {
  if (state.mode !== 'parallel' || !state.running || !state.parallel) return false;
  const worker = state.parallel.workersById?.[workerId];
  if (!worker || worker.status === 'completed' || worker.status === 'failed') return false;

  const retryPolicy = getRetryPolicy(state.options);
  if (!retryPolicy.enabled || retryPolicy.maxRetries <= 0) return false;

  worker.promptRetryCounts = worker.promptRetryCounts || {};
  const currentRetries = worker.promptRetryCounts[promptIndex] || 0;
  if (currentRetries >= retryPolicy.maxRetries) return false;

  const nextRetryAttempt = currentRetries + 1;
  worker.promptRetryCounts[promptIndex] = nextRetryAttempt;
  worker.status = 'retrying';
  worker.nextRetryAt = Date.now() + retryPolicy.retryDelayMs;
  worker.lastRetryError = errorMessage || null;
  state.lastActivityTime = Date.now();
  await saveState();
  await emitParallelProgress();

  console.warn('[Retry][Parallel] Scheduling retry', {
    source,
    workerId,
    workerIndex: worker.index,
    tabId: worker.tabId,
    promptIndex,
    retryAttempt: nextRetryAttempt,
    maxRetries: retryPolicy.maxRetries,
    retryDelayMs: retryPolicy.retryDelayMs,
    error: errorMessage,
    mappingSummary: getParallelMappingDebugSummary(),
  });
  return true;
}

async function maybeFinalizeParallelRun(reason) {
  if (state.mode !== 'parallel' || !state.parallel || !state.running) return false;
  const total = state.prompts.length;
  const done = (state.parallel.completed || 0) + (state.parallel.failed || 0);
  if (state.parallel.launchInProgress) return false;
  if ((state.parallel.active || 0) > 0) return false;
  if (done < total) return false;

  const completionStatus = { ...getStatus(), running: false, paused: false };
  const finalReason = reason || ((state.parallel.failed || 0) > 0 ? 'completedWithErrors' : undefined);
  await clearState();
  try {
    chrome.runtime.sendMessage({ type: 'AUTOMATION_COMPLETE', status: completionStatus, reason: finalReason });
  } catch (_) {}
  return true;
}

async function stopAutomationByStopWord() {
  const completionStatus = { ...getStatus(), running: false, paused: false };
  state.running = false;
  state.paused = false;
  await clearState();
  try {
    chrome.runtime.sendMessage({
      type: "AUTOMATION_COMPLETE",
      status: completionStatus,
      reason: "stoppedByStopWord",
    });
  } catch (_) {}
}

async function finalizeParallelWorker(workerId, { failed, errorMessage } = {}) {
  if (state.mode !== 'parallel' || !state.parallel) return;
  const worker = state.parallel.workersById?.[workerId];
  if (!worker || worker.status === 'completed' || worker.status === 'failed') return;

  if (worker.inFlightPromptId) {
    const waiter = parallelSubmissionWaiters.get(worker.inFlightPromptId);
    if (waiter) {
      waiter.reject(new Error(errorMessage || 'Worker finalized before submission confirmation'));
    }
    delete state.parallel.workersByPromptId[worker.inFlightPromptId];
    worker.inFlightPromptId = null;
  }
  worker.inFlightPromptIndex = null;

  const resolvedError = failed ? (errorMessage || 'Unknown parallel worker failure') : null;
  worker.status = failed ? 'failed' : 'completed';
  worker.error = resolvedError;

  if (worker.isActive && state.parallel.active > 0) {
    state.parallel.active = Math.max(0, state.parallel.active - 1);
    worker.isActive = false;
  }

  if (failed) {
    state.parallel.failed += 1;
    const failureSnapshot = {
      workerId: worker.workerId,
      workerIndex: worker.index,
      tabId: worker.tabId || null,
      nextPromptIndex: worker.nextPromptIndex,
      inFlightPromptIndex: worker.inFlightPromptIndex,
      error: resolvedError,
      at: Date.now(),
      tab: await getParallelTabSnapshot(worker.tabId),
    };
    worker.failure = failureSnapshot;
    state.parallel.lastFailure = failureSnapshot;
    console.error('[Parallel] Worker failed', failureSnapshot);
  } else {
    state.parallel.completed += 1;
  }

  state.currentIndex = state.parallel.completed;
  state.lastActivityTime = Date.now();
  state.recoveryAttempts = 0;
  await saveState();
  await emitParallelProgress();
  await maybeFinalizeParallelRun(failed ? 'completedWithErrors' : undefined);
}

async function markParallelWorkerFailed(workerId, errorMessage) {
  await finalizeParallelWorker(workerId, { failed: true, errorMessage });
}

async function dispatchParallelWorkerPrompt(workerId) {
  if (state.mode !== 'parallel' || !state.parallel || !state.running) return false;
  const worker = state.parallel.workersById?.[workerId];
  if (!worker || worker.status === 'completed' || worker.status === 'failed') return false;
  if (!worker.tabId || worker.inFlightPromptId) return false;
  if (worker.nextPromptIndex >= worker.prompts.length) return false;
  if (Number.isFinite(worker.nextRetryAt) && worker.nextRetryAt > Date.now()) return false;

  const promptIndex = worker.nextPromptIndex;
  const basePromptText = worker.prompts[promptIndex];
  const promptText = buildMessageText(basePromptText);
  const promptId = buildParallelPromptId(worker.index, promptIndex);
  const dispatchStartedAt = Date.now();
  console.log('[Parallel] Built prompt payload', {
    workerId,
    promptIndex,
    baseLength: typeof basePromptText === 'string' ? basePromptText.length : 0,
    finalLength: typeof promptText === 'string' ? promptText.length : 0,
    workerStatus: worker.status,
    workerTabId: worker.tabId || null,
    inFlightPromptIdBeforeSet: worker.inFlightPromptId || null,
    retriesForPrompt: worker.promptRetryCounts?.[promptIndex] || 0,
  });

  worker.inFlightPromptId = promptId;
  worker.inFlightPromptIndex = promptIndex;
  worker.promptStartTime = dispatchStartedAt;
  worker.status = 'dispatching';
  state.parallel.workersByPromptId[promptId] = { workerId, promptIndex };
  state.lastActivityTime = Date.now();
  await saveState();

  try {
    const launchToken = state.parallel.launchToken;
    const loaded = await waitForParallelTabLoaded(worker.tabId, launchToken, workerId);
    if (!loaded) {
      throw new Error('Tab did not finish loading before dispatch');
    }
    console.log('[Parallel] Worker tab reported loaded', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      promptId,
      elapsedMs: Date.now() - dispatchStartedAt,
    });

    const ready = await waitForParallelContentScriptReady(worker.tabId, launchToken, workerId);
    if (!ready) {
      throw new Error('Content script was not ready before dispatch');
    }
    console.log('[Parallel] Worker tab content script ready', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      promptId,
      elapsedMs: Date.now() - dispatchStartedAt,
    });

    const dispatchPreparation = await prepareParallelWorkerBackgroundDispatch(worker.tabId, workerId);
    if (dispatchPreparation?.fallbackUsed) {
      console.warn('[Parallel] Background dispatch proceeding without a fully ready worker tab', {
        workerId,
        tabId: worker.tabId,
        promptIndex,
        promptId,
        backgroundReady: dispatchPreparation.backgroundReady === true,
      });
    }
    const submissionTimeoutMs = getParallelSubmissionTimeoutMs(state.options);
    console.log('[Parallel] Waiting for prompt submission', {
      workerId,
      promptIndex,
      promptId,
      submissionTimeoutMs,
    });
    const submissionWait = createParallelSubmissionWaiter(
      promptId,
      submissionTimeoutMs,
    );

    const sendAck = await sendToContent(worker.tabId, {
      type: 'SEND_PROMPT',
      text: promptText,
      index: promptIndex,
      total: worker.prompts.length,
      options: getParallelDispatchOptions(),
      promptId,
    });
    console.log('[Parallel] SEND_PROMPT acknowledged by content script', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      promptId,
      sendAck: sendAck || null,
      elapsedMs: Date.now() - dispatchStartedAt,
    });

    const submissionMeta = await submissionWait;
    console.log('[Parallel] Submission waiter resolved', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      promptId,
      submissionMeta: submissionMeta || null,
      elapsedMs: Date.now() - dispatchStartedAt,
    });
    const liveWorker = state.parallel?.workersById?.[workerId];
    if (!liveWorker || liveWorker.status === 'completed' || liveWorker.status === 'failed') {
      return true;
    }
    if (liveWorker.inFlightPromptId === promptId) {
      liveWorker.status = 'running';
      liveWorker.nextRetryAt = 0;
      liveWorker.lastSubmission = {
        promptId,
        promptIndex,
        at: Date.now(),
        reason: submissionMeta?.reason || null,
      };
      if (liveWorker.promptRetryCounts && Number.isFinite(promptIndex)) {
        delete liveWorker.promptRetryCounts[promptIndex];
      }
    } else {
      console.warn('[Parallel] Submission resolved for non-current in-flight prompt', {
        workerId,
        promptId,
        inFlightPromptId: liveWorker.inFlightPromptId || null,
        inFlightPromptIndex: Number.isFinite(liveWorker.inFlightPromptIndex)
          ? Number(liveWorker.inFlightPromptIndex)
          : null,
        promptIndex,
      });
    }
    state.lastActivityTime = Date.now();
    await saveState();
    await emitParallelProgress();
    return true;
  } catch (err) {
    const liveWorker = state.parallel?.workersById?.[workerId];
    if (liveWorker && liveWorker.inFlightPromptId === promptId) {
      liveWorker.inFlightPromptId = null;
      liveWorker.inFlightPromptIndex = null;
    } else if (worker.inFlightPromptId === promptId) {
      worker.inFlightPromptId = null;
      worker.inFlightPromptIndex = null;
    }
    if (state.parallel?.workersByPromptId) {
      delete state.parallel.workersByPromptId[promptId];
    }
    const rawDispatchError = String(err?.message || err);
    const dispatchError = buildBackgroundDispatchFailureMessage(
      liveWorker?.tabId || worker.tabId,
      rawDispatchError,
    );
    const tabSnapshot = await getParallelTabSnapshot(liveWorker?.tabId || worker.tabId);
    console.error('[Parallel] Failed to dispatch prompt to worker tab', {
      workerId,
      tabId: liveWorker?.tabId || worker.tabId,
      promptIndex,
      promptId,
      error: rawDispatchError,
      surfacedError: dispatchError,
      elapsedMs: Date.now() - dispatchStartedAt,
      tabSnapshot,
      mappingSummary: getParallelMappingDebugSummary(),
    });
    if (liveWorker) {
      liveWorker.status = 'retrying';
    } else {
      worker.status = 'retrying';
    }
    const retried = await scheduleParallelPromptRetry(workerId, promptIndex, dispatchError, 'dispatchParallelWorkerPrompt');
    if (!retried) {
      await markParallelWorkerFailed(workerId, dispatchError);
    } else {
      await saveState();
      await emitParallelProgress();
    }
    return false;
  }
}

async function waitForParallelWorkerReady(workerId, launchToken, maxWaitMs = 120000) {
  const startedAt = Date.now();
  while (shouldContinueParallelLaunch(launchToken)) {
    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) return false;

    const worker = state.parallel?.workersById?.[workerId];
    if (!worker) return false;
    if (worker.status === 'completed' || worker.status === 'failed') return false;
    if (worker.tabId && ['ready', 'running', 'retrying', 'dispatching'].includes(worker.status)) {
      return true;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn('[Parallel] Worker readiness wait timed out', {
        workerId,
        maxWaitMs,
        waitedMs: Date.now() - startedAt,
        workerStatus: worker.status,
        workerTabId: worker.tabId || null,
        prelaunchCursor: state.parallel?.prelaunchCursor,
        launchInProgress: state.parallel?.launchInProgress === true,
      });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function runParallelPrelaunchLoop({ workerIds, launchUrl, launchToken }) {
  for (let index = 0; index < workerIds.length; index += 1) {
    if (!shouldContinueParallelLaunch(launchToken)) break;
    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;

    const workerId = workerIds[index];
    const worker = state.parallel?.workersById?.[workerId];
    if (!worker || worker.status === 'completed' || worker.status === 'failed') continue;

    let createdTabId = null;
    try {
      worker.status = 'launching';
      state.parallel.prelaunchCursor = index;
      state.lastActivityTime = Date.now();
      await saveState();

      const tab = await chrome.tabs.create({ url: launchUrl, active: false });
      createdTabId = tab?.id || null;
      if (!createdTabId) {
        throw new Error('Failed to create worker tab');
      }

      worker.tabId = createdTabId;
      // Mark worker dispatch-ready immediately; prompt dispatch does its own load/readiness waiting.
      worker.status = 'ready';
      worker.isActive = true;
      state.parallel.active += 1;
      state.parallel.launched += 1;
      state.parallel.prelaunchCursor = index + 1;
      state.lastActivityTime = Date.now();
      await saveState();
      await emitParallelProgress();
      console.log('[Parallel] Worker tab prelaunched', {
        workerId,
        workerIndex: index,
        tabId: createdTabId,
        launchUrl,
      });
    } catch (err) {
      if (!shouldContinueParallelLaunch(launchToken)) break;
      console.error('[Parallel] Worker prelaunch failed', {
        workerId,
        workerIndex: index,
        tabId: createdTabId,
        error: String(err?.message || err),
      });
      await markParallelWorkerFailed(workerId, String(err?.message || err));
    }

    if (index < workerIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, getRandomPrelaunchGapMs()));
    }
  }
}

async function runParallelDispatchLoop({ workerIds, launchToken }) {
  while (shouldContinueParallelLaunch(launchToken)) {
    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;

    let hasPendingWork = false;
    let sentAnyPrompt = false;

    for (let cursor = 0; cursor < workerIds.length; cursor += 1) {
      if (!shouldContinueParallelLaunch(launchToken)) break;
      await waitWhileParallelPaused(launchToken);
      if (!shouldContinueParallelLaunch(launchToken)) break;

      const workerId = workerIds[cursor];
      const worker = state.parallel?.workersById?.[workerId];
      if (!worker || worker.status === 'completed' || worker.status === 'failed') continue;

      if (worker.nextPromptIndex >= worker.prompts.length) {
        await finalizeParallelWorker(workerId, { failed: false });
        continue;
      }

      hasPendingWork = true;
      state.parallel.dispatchCursor = cursor;

      if (worker.inFlightPromptId) continue;
      if (worker.status === 'retrying' && Number.isFinite(worker.nextRetryAt) && worker.nextRetryAt > Date.now()) {
        continue;
      }

      const ready = await waitForParallelWorkerReady(workerId, launchToken);
      if (!ready) {
        const liveWorker = state.parallel?.workersById?.[workerId];
        if (liveWorker && liveWorker.status !== 'completed' && liveWorker.status !== 'failed') {
          await markParallelWorkerFailed(workerId, 'Timed out waiting for worker tab readiness');
        }
        continue;
      }

      const dispatched = await dispatchParallelWorkerPrompt(workerId);
      if (dispatched) {
        sentAnyPrompt = true;
      }
    }

    if (!hasPendingWork) break;
    if (!sentAnyPrompt) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function runParallelFanoutLaunch({ promptGroups, launchUrl }) {
  const launchToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.parallel = createEmptyParallelState();
  state.parallel.launchInProgress = true;
  state.parallel.launchToken = launchToken;

  const workerIds = [];
  for (let index = 0; index < promptGroups.length; index += 1) {
    const workerId = buildParallelWorkerId(index);
    workerIds.push(workerId);
    state.parallel.workersById[workerId] = {
      workerId,
      index,
      tabId: null,
      prompts: promptGroups[index],
      nextPromptIndex: 0,
      inFlightPromptId: null,
      inFlightPromptIndex: null,
      promptStartTime: 0,
      responseDurations: [],
      promptRetryCounts: {},
      nextRetryAt: 0,
      status: 'queued',
      error: null,
      isActive: false,
    };
  }

  state.lastActivityTime = Date.now();
  await saveState();
  await emitParallelProgress();

  try {
    await Promise.all([
      runParallelPrelaunchLoop({ workerIds, launchUrl, launchToken }),
      runParallelDispatchLoop({ workerIds, launchToken }),
    ]);
  } finally {
    if (state.mode === 'parallel' && state.parallel && state.parallel.launchToken === launchToken) {
      state.parallel.launchInProgress = false;
      state.parallel.launchDone = true;
      state.lastActivityTime = Date.now();
      await saveState();
      await emitParallelProgress();
    }
  }

  await maybeFinalizeParallelRun();
}

async function sendToContent(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }
  
  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    console.error('[SendToContent] Content script not ready', { tabId, messageType: message?.type });
    throw new Error('Could not establish connection to content script');
  }

  console.log('[SendToContent] Sending message to content', { tabId, messageType: message?.type });
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        message,
        (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError?.message || String(chrome.runtime.lastError);
            console.error('[SendToContent] Error', { tabId, messageType: message?.type, error: errMsg });
            reject(new Error(errMsg));
          } else {
            const safeResponse = message?.type === 'GET_MEMORY_SOURCE'
              ? { ok: response?.ok !== false, source: response?.source, textLength: response?.textLength || 0 }
              : response;
            console.log('[SendToContent] Response received from content', { tabId, messageType: message?.type, response: safeResponse });
            resolve(response);
          }
        }
      );
    } catch (err) {
      console.error('[SendToContent] Exception:', err);
      reject(err);
    }
  });
}

// ============ AUTOMATION LOGIC ============

async function startAutomation({ prompts, tabId, options, tabPromptGroups }) {
  if (sequentialRetryTimer) {
    clearTimeout(sequentialRetryTimer);
    sequentialRetryTimer = null;
  }
  await loadSettings();
  if (options) {
    await saveSettings(options);
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }

  const useParallel = shouldUseParallelMode(state.options, tabPromptGroups);
  const parallelPromptGroups = useParallel ? resolveParallelPromptGroups(prompts, tabPromptGroups) : [];
  if (useParallel && parallelPromptGroups.length > PARALLEL_CONFIG.maxTabs) {
    throw new Error(`Parallel mode supports up to ${PARALLEL_CONFIG.maxTabs} prompts at a time.`);
  }

  state.prompts = useParallel
    ? parallelPromptGroups.map((group, idx) => `Tab ${idx + 1}: ${group.length} prompt${group.length === 1 ? '' : 's'}`)
    : prompts;
  state.currentIndex = 0;
  state.mode = useParallel ? 'parallel' : 'sequential';
  state.running = true;
  state.paused = false;
  state.tabId = tabId;
  state.lastActivityTime = Date.now();
  state.recoveryAttempts = 0;
  state.processing = false;
  state.currentPromptId = null;
  state.currentRetryCount = 0;
  state.promptStartTime = 0;
  state.responseDurations = [];
  state.stableCountdownMs = 0;
  state.parallel = useParallel ? createEmptyParallelState() : null;

  await saveState();

  chrome.action.setBadgeText({ text: '' });
  try {
    chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() });
  } catch (_) {}

  if (useParallel) {
    const launchUrl = resolveParallelLaunchUrl(tab?.url, state.options);
    if (!launchUrl) {
      throw new Error('Parallel tab URL is invalid or unsupported.');
    }
    console.log('[Parallel] Starting fan-out run', {
      tabs: parallelPromptGroups.length,
      maxTabs: PARALLEL_CONFIG.maxTabs,
      launchUrl,
      launchStrategy: 'pre-open tabs with 1-2s gap, then foreground round-robin send with submit confirmation',
    });
    await runParallelFanoutLaunch({ promptGroups: parallelPromptGroups, launchUrl });
    return;
  }

  await injectContentScript(tabId);
  await sendNextPrompt();
}

function buildMessageText(text) {
  const {
    systemPrompt,
    appendPromptText,
    prependSystemPrompt,
    appendSystemPrompt,
  } = state.options;

  const prependText = typeof systemPrompt === 'string' ? systemPrompt.trim() : '';
  const explicitAppendText = typeof appendPromptText === 'string' ? appendPromptText.trim() : '';
  const appendText = explicitAppendText;
  const shouldAppend = appendSystemPrompt === true && appendText.length > 0;

  console.log('[BuildMessageText] Applying prompt wrappers', {
    prependEnabled: prependSystemPrompt === true,
    appendEnabled: appendSystemPrompt === true,
    appendEffective: shouldAppend,
    prependLength: prependText.length,
    appendLength: appendText.length,
    baseLength: typeof text === 'string' ? text.length : 0,
  });

  if (!(prependSystemPrompt && prependText) && !shouldAppend) return text;
  let out = text;
  if (prependSystemPrompt && prependText) {
    out = `${prependText}\n\n${out}`;
  }
  if (shouldAppend) {
    out = `${out}\n\n${appendText}`;
  }
  return out;
}

function isPaused() {
  return state.paused === true;
}

async function sendNextPrompt() {
  console.log('[SendNextPrompt] Called', { 
    running: state.running, 
    mode: state.mode,
    paused: state.paused,
    currentIndex: state.currentIndex, 
    totalPrompts: state.prompts.length,
    currentRetryCount: state.currentRetryCount,
    processing: state.processing 
  });
  
  if (!state.running) {
    console.log('[SendNextPrompt] Not running, returning early');
    return;
  }
  if (state.mode === 'parallel') {
    console.log('[SendNextPrompt] Parallel mode active; sequential sender will not run');
    return;
  }
  if (isPaused()) {
    console.log('[SendNextPrompt] Paused, deferring prompt send');
    return;
  }
  if (state.currentIndex >= state.prompts.length) {
    console.log('[SendNextPrompt] All prompts done, completing automation', {
      currentIndex: state.currentIndex,
      totalPrompts: state.prompts.length
    });
    state.running = false;
    await clearState();
    try {
      chrome.runtime.sendMessage({ type: "AUTOMATION_COMPLETE", status: getStatus() });
    } catch (_) {}
    return;
  }

  const basePromptText = state.prompts[state.currentIndex];
  const promptText = buildMessageText(basePromptText);
  console.log('[SendNextPrompt] Built prompt payload', {
    currentIndex: state.currentIndex,
    baseLength: typeof basePromptText === 'string' ? basePromptText.length : 0,
    finalLength: typeof promptText === 'string' ? promptText.length : 0,
  });
  state.lastActivityTime = Date.now();
  state.promptStartTime = Date.now();
  state.processing = true;
  state.currentPromptId = Math.random();
  console.log('[SendNextPrompt] Marking processing=true and saving state', {
    currentPromptId: state.currentPromptId,
    currentIndex: state.currentIndex,
    currentRetryCount: state.currentRetryCount,
  });
  await saveState();
  
  try {
    const stableMin = state.options?.stableMinMs ?? DEFAULT_SETTINGS.stableMinMs;
    const stableMax = state.options?.stableMaxMs ?? DEFAULT_SETTINGS.stableMaxMs;
    const stableMs = Math.max(stableMin, Math.min(stableMax, Math.random() * (stableMax - stableMin) + stableMin));
    state.options = { ...state.options, stableMs };
    state.stableCountdownMs = stableMs;
    chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() });
  } catch (_) {}

  try {
    if (state.options?.openNewChatPerPrompt) {
      const tab = await chrome.tabs.get(state.tabId);
      const site = detectSiteFromUrl(tab?.url);
      const baseUrl = baseUrlForSite(site);
      const targetUrl = state.options.openNewChatPerPromptUrl || baseUrl;
      if (!targetUrl) {
        throw new Error('Active tab not supported for new chat navigation.');
      }
      await waitForTriggeredTabLoad(state.tabId, () => chrome.tabs.update(state.tabId, { url: targetUrl }));
      await ensureContentScriptReady(state.tabId);
    } else if (state.options?.refreshTabBeforeEachPrompt) {
      await refreshTabInBackgroundBeforeSend(state.tabId);
    }

    await sendToContent(state.tabId, { 
      type: "SEND_PROMPT", 
      text: promptText, 
      index: state.currentIndex, 
      total: state.prompts.length, 
      options: state.options,
      promptId: state.currentPromptId,
    });
  } catch (err) {
    const sendError = String(err?.message || err);
    console.error("Error sending prompt to content:", sendError);
    const retried = await scheduleSequentialRetry(sendError, 'sendNextPrompt');
    if (retried) {
      return;
    }
    state.processing = false;
    state.lastActivityTime = Date.now() - RECOVERY_CONFIG.staleThresholdMs - 1000;
    console.warn('[SendNextPrompt] Marking processing=false due to send error', {
      currentIndex: state.currentIndex,
      promptId: state.currentPromptId,
      retryCount: state.currentRetryCount,
    });
    await saveState();
    try {
      chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: sendError, status: getStatus() });
    } catch (_) {}
  }
}

function makeHistorySignature(item) {
  const normalized = {
    prompts: (item.prompts || []).map((p) => p.trim()),
    settings: {
      stableMs: item.settings?.stableMs || undefined,
      maxWaitMs: item.settings?.maxWaitMs || undefined,
      pollIntervalMs: item.settings?.pollIntervalMs || undefined,
      systemPrompt: item.settings?.systemPrompt || '',
      appendPromptText: item.settings?.appendPromptText || '',
      prependSystemPrompt: item.settings?.prependSystemPrompt !== false,
      appendSystemPrompt: item.settings?.appendSystemPrompt === true,
      theme: item.settings?.theme === 'light' ? 'light' : 'dark',
      autoConfirmDialogs: item.settings?.autoConfirmDialogs === true,
      enableWatchedElementGate: item.settings?.enableWatchedElementGate === true,
      watchedElementSelector: typeof item.settings?.watchedElementSelector === 'string'
        ? item.settings.watchedElementSelector.trim()
        : DEFAULT_SETTINGS.watchedElementSelector,
      refreshTabBeforeEachPrompt: item.settings?.refreshTabBeforeEachPrompt === true,
      parallelOneTabPerPrompt: item.settings?.parallelOneTabPerPrompt === true,
      enableRetryOnFailure: item.settings?.enableRetryOnFailure !== false,
      maxRetriesPerPrompt: coerceNumber(item.settings?.maxRetriesPerPrompt, 0, 10, DEFAULT_SETTINGS.maxRetriesPerPrompt),
      retryDelayMs: coerceNumber(item.settings?.retryDelayMs, 0, 60000, DEFAULT_SETTINGS.retryDelayMs),
      debugLoggingEnabled: item.settings?.debugLoggingEnabled === true,
      enableMaxWaitTimeout: item.settings?.enableMaxWaitTimeout !== false,
      enableStopWord: item.settings?.enableStopWord === true,
      stopWord: typeof item.settings?.stopWord === 'string' ? item.settings.stopWord.trim() : '',
      stopWordCaseSensitive: item.settings?.stopWordCaseSensitive === true,
      openNewChatPerPrompt: item.settings?.openNewChatPerPrompt === true,
      openNewChatPerPromptUrl: sanitizeUrlOrEmpty(item.settings?.openNewChatPerPromptUrl),
      memory: sanitizeSettingsForHistory(item.settings || {}).memory,
    },
  };
  return JSON.stringify(normalized);
}

// ============ MESSAGE HANDLERS ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!hasHydratedTabSessions) {
        await loadTabSessions();
        await pruneClosedTabSessions();
      }
      // Rehydrate state on demand. Replacing in-memory state during active runs can
      // invalidate worker references held by launch/dispatch loops.
      if (!state.running && !hasHydratedPersistentState) {
        await loadState();
      }

      switch (message?.type) {
        case "CONTENT_READY": {
          const senderTabId = sender?.tab?.id;
          if (Number.isInteger(senderTabId) && tabSessions.has(senderTabId)) {
            const session = tabSessions.get(senderTabId);
            session.lastActivityTime = Date.now();
            await saveTabSessions();
            return;
          }
          state.lastActivityTime = Date.now();
          await saveState();
          return;
        }
        case "SIDE_PANEL_OPENED": {
          if (sender?.tab?.id) {
            openSidePanels.add(sender.tab.id);
          }
          return;
        }
        case "SIDE_PANEL_CLOSED": {
          if (sender?.tab?.id) {
            openSidePanels.delete(sender.tab.id);
          } else if (message?.tabId) {
            openSidePanels.delete(message.tabId);
          }
          return;
        }
        case "START_AUTOMATION": {
          console.log('[StartAutomation] Received request', {
            running: state.running,
            processing: state.processing,
            currentIndex: state.currentIndex,
            promptsInRequest: message.prompts?.length,
            tabGroupsInRequest: message.tabPromptGroups?.length,
            activeTabSessions: tabSessions.size,
          });
          
          const prompts = Array.isArray(message.prompts) ? message.prompts.filter((p) => typeof p === "string" && p.trim().length > 0) : [];
          const tabPromptGroups = Array.isArray(message.tabPromptGroups) ? message.tabPromptGroups : null;
          const tabId = message.tabId;
          const options = message.options || {};
          const effectiveOptions = validateSettings({ ...state.options, ...options });
          if (!tabId || prompts.length === 0) {
            sendResponse({ ok: false, error: "Missing tabId or prompts." });
            return;
          }
          try {
            const tab = await chrome.tabs.get(tabId);
            if (!isSupportedUrl(tab?.url)) {
              sendResponse({ ok: false, error: 'Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.' });
              return;
            }
            const useParallel = shouldUseParallelMode(effectiveOptions, tabPromptGroups);
            const parallelPromptGroups = useParallel ? resolveParallelPromptGroups(prompts, tabPromptGroups) : [];
            if (useParallel && parallelPromptGroups.length > PARALLEL_CONFIG.maxTabs) {
              sendResponse({ ok: false, error: `Parallel mode supports up to ${PARALLEL_CONFIG.maxTabs} prompts at a time.` });
              return;
            }
            if (useParallel) {
              const launchUrl = resolveParallelLaunchUrl(tab.url, effectiveOptions);
              if (!launchUrl) {
                sendResponse({ ok: false, error: 'Parallel launch URL is invalid or unsupported.' });
                return;
              }
            }
          } catch (e) {
            sendResponse({ ok: false, error: 'Unable to read active tab.' });
            return;
          }

          const useParallel = shouldUseParallelMode(effectiveOptions, tabPromptGroups);

          if (!useParallel) {
            const existingTabSession = tabSessions.get(tabId);
            if (existingTabSession?.running) {
              sendResponse({ ok: false, error: "Automation is already running in this tab. Stop the current automation first." });
              return;
            }
            if (state.running) {
              sendResponse({ ok: false, error: "A global automation run is active. Stop it before starting tab-scoped automation." });
              return;
            }
            sendResponse({ ok: true });
            try {
              await startTabSession({ prompts, tabId, options: effectiveOptions });
            } catch (e) {
              console.error('[StartAutomation][TabSession] Error:', e);
              await emitTabSessionError(tabId, e);
            }
            return;
          }

          if (tabSessions.size > 0) {
            sendResponse({ ok: false, error: "Tab-scoped automations are already running. Stop them before starting a tab-group parallel run." });
            return;
          }
          if (state.running) {
            console.log('[StartAutomation] Automation already running, REJECTING new start request');
            sendResponse({ ok: false, error: "Automation is already running. Stop the current automation first." });
            return;
          }

          sendResponse({ ok: true });
          try {
            await startAutomation({ prompts, tabId, options: effectiveOptions, tabPromptGroups });
          } catch (e) {
            console.error('[StartAutomation] Error:', e);
            state.running = false;
            await saveState();
            try {
              chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: String(e), status: getStatus() });
            } catch (_) {}
          }
          return;
        }
        case "STOP_AUTOMATION": {
          const targetTabId = Number.isInteger(Number(message?.tabId))
            ? Number(message.tabId)
            : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null);
          if (Number.isInteger(targetTabId) && tabSessions.has(targetTabId)) {
            await stopTabSession(targetTabId);
            sendResponse({ ok: true });
            return;
          }
          if (Number.isInteger(targetTabId) && state.running && state.tabId !== targetTabId) {
            sendResponse({ ok: false, error: "No automation is running in this tab." });
            return;
          }
          state.running = false;
          state.paused = false;
          await clearState();
          sendResponse({ ok: true });
          return;
        }
        case "PAUSE_AUTOMATION": {
          const targetTabId = Number.isInteger(Number(message?.tabId))
            ? Number(message.tabId)
            : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null);
          if (Number.isInteger(targetTabId) && tabSessions.has(targetTabId)) {
            const session = tabSessions.get(targetTabId);
            if (!session.running) {
              sendResponse({ ok: false, error: "Automation not running" });
              return;
            }
            session.paused = true;
            session.lastActivityTime = Date.now();
            await saveTabSessions();
            await emitTabSessionProgress(targetTabId);
            sendResponse({ ok: true });
            return;
          }
          if (Number.isInteger(targetTabId) && state.running && state.tabId !== targetTabId) {
            sendResponse({ ok: false, error: "No automation is running in this tab." });
            return;
          }
          if (!state.running) {
            sendResponse({ ok: false, error: "Automation not running" });
            return;
          }
          state.paused = true;
          await saveState();
          chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() });
          sendResponse({ ok: true });
          return;
        }
        case "RESUME_AUTOMATION": {
          const targetTabId = Number.isInteger(Number(message?.tabId))
            ? Number(message.tabId)
            : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null);
          if (Number.isInteger(targetTabId) && tabSessions.has(targetTabId)) {
            const session = tabSessions.get(targetTabId);
            if (!session.running) {
              sendResponse({ ok: false, error: "Automation not running" });
              return;
            }
            session.paused = false;
            session.lastActivityTime = Date.now();
            await saveTabSessions();
            await emitTabSessionProgress(targetTabId);
            if (!session.processing) {
              await sendNextPromptForTabSession(targetTabId);
            }
            sendResponse({ ok: true });
            return;
          }
          if (Number.isInteger(targetTabId) && state.running && state.tabId !== targetTabId) {
            sendResponse({ ok: false, error: "No automation is running in this tab." });
            return;
          }
          if (!state.running) {
            sendResponse({ ok: false, error: "Automation not running" });
            return;
          }
          state.paused = false;
          state.lastActivityTime = Date.now();
          await saveState();
          chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() });
          if (state.mode === 'parallel') {
            sendResponse({ ok: true });
            return;
          }
          if (!state.processing) {
            await sendNextPrompt();
          }
          sendResponse({ ok: true });
          return;
        }
        case "AUTOMATION_STATUS_REQUEST": {
          await loadSettings();
          const targetTabId = Number.isInteger(Number(message?.tabId))
            ? Number(message.tabId)
            : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null);
          if (Number.isInteger(targetTabId) && tabSessions.has(targetTabId)) {
            sendResponse({ ok: true, status: buildTabSessionStatus(tabSessions.get(targetTabId)) });
            return;
          }
          if (Number.isInteger(targetTabId)) {
            if (state.running && state.tabId === targetTabId) {
              sendResponse({ ok: true, status: getStatus() });
              return;
            }
            sendResponse({ ok: true, status: createIdleStatusForTab(targetTabId, state.options) });
            return;
          }
          sendResponse({ ok: true, status: getStatus() });
          return;
        }
        case "PROMPT_SUBMITTED": {
          sendResponse({ ok: true });
          if (state.mode !== 'parallel' || !state.running || !state.parallel) {
            return;
          }

          const promptId = message.promptId ? String(message.promptId) : '';
          const senderTabId = sender?.tab?.id || null;
          const promptRef = resolveParallelPromptRef(promptId, senderTabId);
          if (!promptRef) {
            console.warn('[PromptSubmitted][Parallel] Unknown prompt mapping, ignoring', {
              promptId,
              senderTabId,
              reason: message.reason || null,
              mappingSummary: getParallelMappingDebugSummary(),
            });
            return;
          }

          const worker = state.parallel.workersById?.[promptRef.workerId];
          if (!worker || worker.status === 'completed' || worker.status === 'failed') {
            settleParallelSubmission(promptId, { ignored: true });
            return;
          }

          const resolvedPromptId = promptId || worker.inFlightPromptId || '';
          const resolvedPromptIndex = Number.isFinite(promptRef.promptIndex)
            ? Number(promptRef.promptIndex)
            : Number.isFinite(worker.inFlightPromptIndex)
              ? Number(worker.inFlightPromptIndex)
              : Math.max(0, Number(worker.nextPromptIndex || 0));

          if (!resolvedPromptId) {
            console.warn('[PromptSubmitted][Parallel] Missing resolved prompt id, ignoring', {
              promptId,
              senderTabId,
              workerId: worker.workerId,
              mappingSummary: getParallelMappingDebugSummary(),
            });
            return;
          }

          if (worker.inFlightPromptId !== resolvedPromptId) {
            console.warn('[PromptSubmitted][Parallel] Late/stale submission observed, not mutating worker state', {
              promptId: resolvedPromptId,
              senderTabId,
              workerId: worker.workerId,
              inFlightPromptId: worker.inFlightPromptId || null,
              inFlightPromptIndex: Number.isFinite(worker.inFlightPromptIndex)
                ? Number(worker.inFlightPromptIndex)
                : null,
              resolvedPromptIndex,
            });
            settleParallelSubmission(resolvedPromptId, {
              ignored: true,
              stale: true,
              workerId: worker.workerId,
              promptIndex: resolvedPromptIndex,
            });
            return;
          }

          worker.status = 'running';
          worker.nextRetryAt = 0;
          if (worker.promptRetryCounts && Number.isFinite(resolvedPromptIndex)) {
            delete worker.promptRetryCounts[resolvedPromptIndex];
          }
          worker.lastSubmission = {
            promptId: resolvedPromptId,
            promptIndex: resolvedPromptIndex,
            at: Date.now(),
            reason: message.reason || null,
          };

          state.lastActivityTime = Date.now();
          await saveState();
          await emitParallelProgress();
          settleParallelSubmission(resolvedPromptId, {
            workerId: worker.workerId,
            promptIndex: resolvedPromptIndex,
            reason: message.reason || null,
          });
          console.log('[PromptSubmitted][Parallel] Submission confirmed', {
            promptId: resolvedPromptId,
            workerId: worker.workerId,
            promptIndex: resolvedPromptIndex,
            reason: message.reason || null,
            senderTabId,
            mappingSummary: getParallelMappingDebugSummary(),
          });
          return;
        }
        case "RESPONSE_COMPLETE": {
          console.log('[ResponseComplete] Received', {
            messagePromptId: message.promptId,
            statePromptId: state.currentPromptId,
            running: state.running,
            mode: state.mode,
            processing: state.processing,
            currentIndex: state.currentIndex,
            totalPrompts: state.prompts.length,
            stoppedByStopWord: message.stoppedByStopWord,
            error: message.error
          });
          sendResponse({ ok: true });

          const tabSessionRef = resolveTabSessionForMessage(message, sender);
          if (tabSessionRef.session) {
            const tabId = tabSessionRef.tabId;
            const session = tabSessionRef.session;
            if (!session.running || !session.processing) {
              return;
            }
            if (message.promptId && session.currentPromptId && String(message.promptId) !== String(session.currentPromptId)) {
              return;
            }

            const completedAt = Date.now();
            const completedPromptIndex = Number(session.currentIndex || 0);
            const durationMs = pushPromptDuration(session, session.promptStartTime, completedAt);
            if (!message.error && message.stoppedByStopWord !== true) {
              await recordCapturedResponse({
                promptId: session.currentPromptId,
                promptIndex: completedPromptIndex,
                tabId,
                mode: 'tab-session',
                promptText: session.prompts?.[completedPromptIndex] || '',
                responseText: message.responseText || '',
                site: message.site || '',
                url: message.url || sender?.tab?.url || '',
                durationMs,
              });
            }
            session.processing = false;
            session.promptStartTime = 0;
            session.lastActivityTime = Date.now();
            session.recoveryAttempts = 0;

            if (message.error) {
              const retried = await scheduleTabSessionRetry(tabId, String(message.error), 'RESPONSE_COMPLETE');
              if (retried) {
                return;
              }
              await emitTabSessionError(tabId, message.error);
              await stopTabSession(tabId, { reason: 'completedWithErrors', emitComplete: true });
              return;
            }

            if (message.stoppedByStopWord) {
              await stopTabSession(tabId, { reason: 'stoppedByStopWord', emitComplete: true });
              return;
            }

            session.currentRetryCount = 0;
            session.currentIndex += 1;
            await saveTabSessions();
            await emitTabSessionProgress(tabId);
            if (session.paused) {
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
            await sendNextPromptForTabSession(tabId);
            return;
          }

          if (state.mode === 'parallel') {
            if (!state.running || !state.parallel) {
              console.log('[ResponseComplete][Parallel] Not running or no parallel state, ignoring');
              return;
            }
            const promptId = message.promptId ? String(message.promptId) : '';
            const senderTabId = sender?.tab?.id || null;
            const promptRef = resolveParallelPromptRef(promptId, senderTabId);
            if (!promptRef) {
              console.warn('[ResponseComplete][Parallel] Unknown prompt mapping, ignoring', {
                promptId,
                senderTabId,
                error: message.error || null,
                stoppedByStopWord: message.stoppedByStopWord === true,
                mappingSummary: getParallelMappingDebugSummary(),
              });
              return;
            }

            const worker = state.parallel.workersById?.[promptRef.workerId];
            if (!worker || worker.status === 'completed' || worker.status === 'failed') return;

            const hasStopWord = message.stoppedByStopWord === true;
            if (hasStopWord) {
              console.log('[ResponseComplete][Parallel] Stop phrase detected, stopping full automation');
              await stopAutomationByStopWord();
              return;
            }

            const resolvedPromptId = promptId || worker.inFlightPromptId || '';
            const resolvedPromptIndex = Number.isFinite(promptRef.promptIndex)
              ? Number(promptRef.promptIndex)
              : Number.isFinite(worker.inFlightPromptIndex)
                ? Number(worker.inFlightPromptIndex)
                : Math.max(0, Number(worker.nextPromptIndex || 0));
            const isCurrentInFlight = !!resolvedPromptId && worker.inFlightPromptId === resolvedPromptId;
            const hasPendingSubmissionWaiter = !!resolvedPromptId && parallelSubmissionWaiters.has(resolvedPromptId);

            if (!resolvedPromptId) {
              console.warn('[ResponseComplete][Parallel] Missing resolved prompt id, ignoring', {
                promptId,
                senderTabId,
                workerId: worker.workerId,
                mappingSummary: getParallelMappingDebugSummary(),
              });
              return;
            }

            if (message.error) {
              const completionError = String(message.error);

              if (!isCurrentInFlight && !hasPendingSubmissionWaiter) {
                console.warn('[ResponseComplete][Parallel] Stale completion error ignored', {
                  promptId: resolvedPromptId,
                  workerId: worker.workerId,
                  error: completionError,
                  senderTabId,
                  inFlightPromptId: worker.inFlightPromptId || null,
                  inFlightPromptIndex: Number.isFinite(worker.inFlightPromptIndex)
                    ? Number(worker.inFlightPromptIndex)
                    : null,
                  resolvedPromptIndex,
                });
                delete state.parallel.workersByPromptId[resolvedPromptId];
                return;
              }

              if (hasPendingSubmissionWaiter) {
                rejectParallelSubmission(resolvedPromptId, new Error(completionError));
                state.lastActivityTime = Date.now();
                await saveState();
                await emitParallelProgress();
                console.warn('[ResponseComplete][Parallel] Submission-stage error forwarded to waiter', {
                  promptId: resolvedPromptId,
                  workerId: worker.workerId,
                  error: completionError,
                  senderTabId,
                  mappingSummary: getParallelMappingDebugSummary(),
                });
                return;
              }

              if (isCurrentInFlight) {
                worker.inFlightPromptId = null;
                worker.inFlightPromptIndex = null;
              }
              delete state.parallel.workersByPromptId[resolvedPromptId];

              const retried = await scheduleParallelPromptRetry(
                worker.workerId,
                resolvedPromptIndex,
                completionError,
                'RESPONSE_COMPLETE',
              );
              if (!retried) {
                await markParallelWorkerFailed(worker.workerId, completionError);
              } else {
                await saveState();
                await emitParallelProgress();
              }
              console.warn('[ResponseComplete][Parallel] Completion error observed after send attempt', {
                promptId: resolvedPromptId,
                workerId: worker.workerId,
                error: completionError,
                senderTabId,
                workerStatus: worker.status,
                inFlightPromptId: worker.inFlightPromptId || null,
                inFlightPromptIndex: Number.isFinite(worker.inFlightPromptIndex)
                  ? Number(worker.inFlightPromptIndex)
                  : null,
                resolvedPromptIndex,
                nextPromptIndex: worker.nextPromptIndex,
                mappingSummary: getParallelMappingDebugSummary(),
              });
              return;
            }

            // Successful completion in parallel mode.
            if (!isCurrentInFlight && !hasPendingSubmissionWaiter) {
              console.warn('[ResponseComplete][Parallel] Stale completion ignored', {
                promptId: resolvedPromptId,
                workerId: worker.workerId,
                senderTabId,
                inFlightPromptId: worker.inFlightPromptId || null,
                inFlightPromptIndex: Number.isFinite(worker.inFlightPromptIndex)
                  ? Number(worker.inFlightPromptIndex)
                  : null,
                resolvedPromptIndex,
              });
              delete state.parallel.workersByPromptId[resolvedPromptId];
              return;
            }

            if (hasPendingSubmissionWaiter) {
              settleParallelSubmission(resolvedPromptId, {
                workerId: worker.workerId,
                promptIndex: resolvedPromptIndex,
                reason: 'response-complete-fallback',
              });
            }
            const durationMs = pushPromptDuration(worker, worker.promptStartTime, Date.now());
            await recordCapturedResponse({
              promptId: resolvedPromptId,
              promptIndex: resolvedPromptIndex,
              tabId: worker.tabId,
              mode: 'parallel',
              promptText: worker.prompts?.[resolvedPromptIndex] || '',
              responseText: message.responseText || '',
              site: message.site || '',
              url: message.url || sender?.tab?.url || '',
              durationMs,
            });
            if (isCurrentInFlight) {
              worker.inFlightPromptId = null;
              worker.inFlightPromptIndex = null;
              worker.promptStartTime = 0;
            }
            delete state.parallel.workersByPromptId[resolvedPromptId];
            worker.nextPromptIndex = Math.max(worker.nextPromptIndex || 0, resolvedPromptIndex + 1);
            worker.status = 'ready';
            worker.nextRetryAt = 0;
            if (worker.promptRetryCounts && Number.isFinite(resolvedPromptIndex)) {
              delete worker.promptRetryCounts[resolvedPromptIndex];
            }
            worker.lastCompletion = {
              promptId: resolvedPromptId,
              promptIndex: resolvedPromptIndex,
              at: Date.now(),
            };
            state.lastActivityTime = Date.now();
            await saveState();
            await emitParallelProgress();
            if (worker.nextPromptIndex >= worker.prompts.length) {
              await finalizeParallelWorker(worker.workerId, { failed: false });
            }
            return;
          }

          if (!state.running || !state.processing) {
            console.log('[ResponseComplete] Not running or not processing, ignoring', {
              running: state.running,
              processing: state.processing
            });
            return;
          }
          if (message.promptId && message.promptId !== state.currentPromptId) {
            console.log('[ResponseComplete] Stale prompt response, ignoring', {
              messagePromptId: message.promptId,
              statePromptId: state.currentPromptId
            });
            return;
          }
          console.log('[ResponseComplete] Clearing processing and advancing index', {
            currentIndex: state.currentIndex,
            totalPrompts: state.prompts.length,
            error: message.error
          });
          const completedAt = Date.now();
          const completedPromptIndex = Number(state.currentIndex || 0);
          const durationMs = pushPromptDuration(state, state.promptStartTime, completedAt);
          if (!message.error && message.stoppedByStopWord !== true) {
            await recordCapturedResponse({
              promptId: state.currentPromptId,
              promptIndex: completedPromptIndex,
              tabId: state.tabId || sender?.tab?.id || null,
              mode: 'sequential',
              promptText: state.prompts?.[completedPromptIndex] || '',
              responseText: message.responseText || '',
              site: message.site || '',
              url: message.url || sender?.tab?.url || '',
              durationMs,
            });
          }
          state.processing = false;
          state.promptStartTime = 0;
          state.lastActivityTime = Date.now();
          state.recoveryAttempts = 0;

          if (message.error) {
            const retried = await scheduleSequentialRetry(String(message.error), 'RESPONSE_COMPLETE');
            if (retried) {
              return;
            }
          }

          if (message.stoppedByStopWord) {
            console.log('[ResponseComplete] Stopped by stop phrase, ending automation');
            await stopAutomationByStopWord();
            return;
          }

          state.currentRetryCount = 0;
          state.currentIndex += 1;

          await saveState();
          try {
            chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() });
          } catch (_) {}
          
          // If paused, do not advance until resumed
          if (state.paused) {
            console.log('[ResponseComplete] Paused; waiting for resume to send next prompt');
            return;
          }

          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            await sendNextPrompt();
          } catch (e) {
            console.error('[ResponseComplete] Error sending next prompt:', e);
            state.running = false;
            await saveState();
            try {
              chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: String(e), status: getStatus() });
            } catch (_) {}
          }
          return;
        }
        case "SAVE_PROMPT_HISTORY": {
          const historyItem = message.item;
          if (historyItem && typeof historyItem === 'object') {
            const storedHistory = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
            const aiTaskSequencerHistory = Array.isArray(storedHistory?.[HISTORY_STORAGE_KEY]) ? storedHistory[HISTORY_STORAGE_KEY] : [];
            const safeHistoryItem = {
              ...historyItem,
              settings: sanitizeSettingsForHistory(historyItem.settings || {}),
            };
            const sig = makeHistorySignature(safeHistoryItem);
            const exists = aiTaskSequencerHistory.some((h) => h.__sig === sig);
            if (!exists) {
              aiTaskSequencerHistory.unshift({ ...safeHistoryItem, savedAt: Date.now(), __sig: sig });
              const trimmed = aiTaskSequencerHistory.slice(0, 50);
              await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: trimmed });
            }
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Invalid history item' });
          }
          return;
        }
        case "GET_PROMPT_HISTORY": {
          const storedHistory = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
          const aiTaskSequencerHistory = Array.isArray(storedHistory?.[HISTORY_STORAGE_KEY]) ? storedHistory[HISTORY_STORAGE_KEY] : [];
          sendResponse({ ok: true, history: aiTaskSequencerHistory });
          return;
        }
        case "GET_CAPTURED_RESPONSES": {
          const storedResponses = await chrome.storage.local.get(RESPONSE_LOG_STORAGE_KEY);
          const responses = Array.isArray(storedResponses?.[RESPONSE_LOG_STORAGE_KEY]) ? storedResponses[RESPONSE_LOG_STORAGE_KEY] : [];
          sendResponse({ ok: true, responses });
          return;
        }
        case "CLEAR_CAPTURED_RESPONSES": {
          await chrome.storage.local.set({ [RESPONSE_LOG_STORAGE_KEY]: [] });
          sendResponse({ ok: true });
          return;
        }
        case "DELETE_PROMPT_HISTORY": {
          const index = message.index;
          const storedHistory = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
          const aiTaskSequencerHistory = Array.isArray(storedHistory?.[HISTORY_STORAGE_KEY]) ? storedHistory[HISTORY_STORAGE_KEY] : [];
          if (typeof index === 'number' && index >= 0 && index < aiTaskSequencerHistory.length) {
            aiTaskSequencerHistory.splice(index, 1);
            await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: aiTaskSequencerHistory });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Invalid index' });
          }
          return;
        }
        case "SAVE_SETTINGS": {
          try {
            await saveSettings(message.settings || {});
            sendResponse({ ok: true, settings: publicSettings() });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error?.message || 'Failed to save settings',
              validationErrors: error?.validationErrors || null,
            });
          }
          return;
        }
        case "GET_SETTINGS": {
          await loadSettings();
          sendResponse({ ok: true, settings: publicSettings() });
          return;
        }
        case "GET_MEMORY_SOURCE": {
          const tabId = Number(message?.tabId);
          if (!Number.isInteger(tabId)) {
            sendResponse({ ok: false, error: 'Missing tabId' });
            return;
          }
          const result = await sendToContent(tabId, {
            type: 'GET_MEMORY_SOURCE',
            source: message.source || 'prompt_box',
          });
          sendResponse({ ok: result?.ok !== false, result });
          return;
        }
        case "PREVIEW_MEMORY_PACK": {
          const result = await callMemoryPack(message.body || {});
          sendResponse({ ok: true, result });
          return;
        }
        case "INSERT_MEMORY_PACK": {
          const tabId = Number(message?.tabId);
          if (!Number.isInteger(tabId)) {
            sendResponse({ ok: false, error: 'Missing tabId' });
            return;
          }
          const result = await sendToContent(tabId, {
            type: 'INSERT_MEMORY_PACK',
            markdown: String(message.markdown || ''),
            behavior: message.behavior || 'prepend_or_replace_managed_block',
          });
          sendResponse({ ok: result?.ok !== false, result });
          return;
        }
        case "START_TARGET_PICKER": {
          const tabId = Number(message?.tabId);
          if (!Number.isInteger(tabId)) {
            sendResponse({ ok: false, error: 'Missing tabId' });
            return;
          }
          const result = await sendToContent(tabId, {
            type: 'START_TARGET_PICKER',
            role: message.role || 'promptInput',
          });
          sendResponse(result);
          return;
        }
        case "CANCEL_TARGET_PICKER": {
          const tabId = Number(message?.tabId);
          if (!Number.isInteger(tabId)) {
            sendResponse({ ok: false, error: 'Missing tabId' });
            return;
          }
          const result = await sendToContent(tabId, {
            type: 'CANCEL_TARGET_PICKER',
            role: message.role || '',
          });
          sendResponse(result);
          return;
        }
        case "MEMORY_HEALTH_CHECK": {
          const result = await memoryHealthCheck();
          sendResponse({ ok: result.ok === true, result, error: result.error || result.nativeError || null });
          return;
        }
        case "START_TRANSCRIPTION_MONITORING": {
          try {
            await startTranscriptionMonitoring(message.folder);
            sendResponse({ success: true });
          } catch (e) {
            console.error('[Transcription] Start failed:', e);
            sendResponse({ success: false, error: String(e?.message || e) });
          }
          return;
        }
        case "STOP_TRANSCRIPTION_MONITORING": {
          try {
            await stopTranscriptionMonitoring();
            sendResponse({ success: true });
          } catch (e) {
            console.error('[Transcription] Stop failed:', e);
            sendResponse({ success: false, error: String(e?.message || e) });
          }
          return;
        }
        case "GET_TRANSCRIPTION_STATE": {
          sendResponse({
            success: true,
            isEnabled: transcriptionState.isEnabled,
            watchFolder: transcriptionState.watchFolder,
            processedCount: transcriptionState.processedFiles.size
          });
          return;
        }
        default:
          return;
      }
    } catch (e) {
      console.error('[MessageHandler] Unhandled error:', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// ============ STARTUP & RECOVERY ============

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Startup] Service worker started');
  await loadTabSessions();
  await pruneClosedTabSessions();
  const restored = await loadState();
  await loadTranscriptionState();
  if (transcriptionState.isEnabled && transcriptionState.watchFolder) {
    startTranscriptionPolling();
  }
  if (restored && state.running) {
    console.log('[Startup] Found running automation, attempting recovery');
    state.lastActivityTime = Date.now() - RECOVERY_CONFIG.staleThresholdMs - 1000;
    await saveState();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Install] Extension installed/updated');
  await loadTabSessions();
  await pruneClosedTabSessions();
  await loadState();
  await loadTranscriptionState();
  if (transcriptionState.isEnabled && transcriptionState.watchFolder) {
    startTranscriptionPolling();
  }
});

// ============ NOTIFICATIONS ============

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'AUTOMATION_COMPLETE') {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('images/icon.png'),
        title: 'Auto-Prompt: Done',
        message: 'All prompts have been processed.'
      });
    } catch (_) {}
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      chrome.action.setBadgeText({ text: 'DONE' });
    } catch (_) {}
  }
});

// Auto-inject content script when auto-confirm is enabled
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  (async () => {
    await loadSettings();
    if (!state.options?.autoConfirmDialogs) return;
    if (!isSupportedUrl(tab?.url)) return;
    await ensureContentScriptReady(tabId);
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    openSidePanels.delete(tabId);
    if (tabSessions.has(tabId)) {
      await stopTabSession(tabId);
    }
  })();
});

// ============ TRANSCRIPTION MONITORING ============

const transcriptionState = {
  isEnabled: false,
  watchFolder: '',
  processedFiles: new Set(),
  checkInterval: null,
  lastCheckTime: 0,
  automationStarted: false,
  stateFile: 'transcription_state.json'
};

// Load transcription state from local file
async function loadTranscriptionState() {
  try {
    // Try to read from native host
    const response = await chrome.runtime.sendNativeMessage(
      'com.aipromptqueue.transcription',
      {
        type: 'read_state_file',
        stateFile: transcriptionState.stateFile
      }
    );
    
    if (response && response.type === 'file_content' && response.content) {
      const stateData = JSON.parse(response.content);
      transcriptionState.isEnabled = stateData.isEnabled || false;
      transcriptionState.watchFolder = stateData.watchFolder || '';
      transcriptionState.processedFiles = new Set(stateData.processedFiles || []);
      transcriptionState.lastCheckTime = stateData.lastCheckTime || 0;
      transcriptionState.automationStarted = stateData.automationStarted || false;
      console.log('[Transcription] Loaded state from file:', stateData);
    }
  } catch (error) {
    console.error('[Transcription] Failed to load state from file:', error);
    // Fallback to Chrome storage
    const result = await chrome.storage.local.get(['transcriptionState']);
    if (result.transcriptionState) {
      transcriptionState.isEnabled = result.transcriptionState.isEnabled || false;
      transcriptionState.watchFolder = result.transcriptionState.watchFolder || '';
      transcriptionState.processedFiles = new Set(result.transcriptionState.processedFiles || []);
      transcriptionState.lastCheckTime = result.transcriptionState.lastCheckTime || 0;
    }
  }
}

// Save transcription state to local file
async function saveTranscriptionState() {
  try {
    const stateData = {
      isEnabled: transcriptionState.isEnabled,
      watchFolder: transcriptionState.watchFolder,
      processedFiles: Array.from(transcriptionState.processedFiles),
      lastCheckTime: transcriptionState.lastCheckTime,
      automationStarted: transcriptionState.automationStarted
    };
    
    // Save to local file via native host
    const response = await chrome.runtime.sendNativeMessage(
      'com.aipromptqueue.transcription',
      {
        type: 'save_state_file',
        stateFile: transcriptionState.stateFile,
        content: JSON.stringify(stateData, null, 2)
      }
    );
    
    if (response && response.type === 'success') {
      console.log('[Transcription] Saved state to file');
    } else {
      throw new Error('Failed to save to file');
    }
  } catch (error) {
    console.error('[Transcription] Failed to save state to file:', error);
    // Fallback to Chrome storage
    await chrome.storage.local.set({
      transcriptionState: {
        isEnabled: transcriptionState.isEnabled,
        watchFolder: transcriptionState.watchFolder,
        processedFiles: Array.from(transcriptionState.processedFiles),
        lastCheckTime: transcriptionState.lastCheckTime
      }
    });
  }
}

// Check for new transcription files
async function checkForNewTranscriptionFiles() {
  if (!transcriptionState.isEnabled || !transcriptionState.watchFolder) {
    return;
  }

  try {
    // Send message to native host
    const response = await chrome.runtime.sendNativeMessage(
      'com.aipromptqueue.transcription',
      {
        type: 'check_files',
        folder: transcriptionState.watchFolder,
        processedFiles: Array.from(transcriptionState.processedFiles)
      }
    );

    if (response && response.type === 'files_found' && response.new_files) {
      for (const file of response.new_files) {
        await processTranscriptionFile(file);
      }
    } else if (response && response.type === 'error') {
      console.error('[Transcription] Native host error:', response.message);
    }
  } catch (error) {
    console.error('[Transcription] Error checking files:', error);
  }
}

async function verifyTranscriptionFolder(folder) {
  if (!folder || typeof folder !== 'string' || !folder.trim()) {
    throw new Error('Folder path is required.');
  }
  const response = await chrome.runtime.sendNativeMessage(
    'com.aipromptqueue.transcription',
    {
      type: 'check_files',
      folder: folder.trim(),
      processedFiles: []
    }
  );
  if (response?.type === 'error') {
    throw new Error(response.message || 'Native host error');
  }
}

// Process a new transcription file
async function processTranscriptionFile(filePath) {
  try {
    console.log('[Transcription] Processing file:', filePath);
    
    // Check if already processed to avoid duplicates
    if (transcriptionState.processedFiles.has(filePath)) {
      console.log('[Transcription] File already processed, skipping:', filePath);
      return;
    }
    
    // Get file content from native host
    const response = await chrome.runtime.sendNativeMessage(
      'com.aipromptqueue.transcription',
      {
        type: 'read_file',
        filePath: filePath
      }
    );

    if (response && response.type === 'file_content' && response.content) {
      const transcriptionData = JSON.parse(response.content);
      const transcriptText = transcriptionData.groq_response?.text || transcriptionData.text || '';
      
      if (transcriptText) {
        // Mark as processed FIRST to avoid duplicates
        transcriptionState.processedFiles.add(filePath);
        await saveTranscriptionState();
        
        // Add to prompt queue
        await addTranscriptToQueue(transcriptText, filePath);
        
        console.log('[Transcription] Added transcript to queue:', transcriptText.substring(0, 100) + '...');
        
        // Show notification
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('images/icon.png'),
            title: 'New Transcription Detected',
            message: `Added transcript from ${filePath.split('\\').pop()}`
          });
        } catch (_) {}
      }
    } else if (response && response.type === 'error') {
      console.error('[Transcription] Error reading file:', response.message);
    }
  } catch (error) {
    console.error('[Transcription] Error processing file:', error);
  }
}

// Add transcript text to prompt queue
async function addTranscriptToQueue(text, filePath) {
  const prompt = `Transcript from ${filePath.split('\\').pop()}: ${text}`;
  
  // Get current state and add to prompts
  const currentState = await chrome.storage.local.get(['state']);
  const stateData = currentState.state || { prompts: [] };
  
  stateData.prompts.push(prompt);
  
  await chrome.storage.local.set({ state: stateData });
  
  // Notify popup to update
  try {
    chrome.runtime.sendMessage({ type: 'PROMPTS_UPDATED' });
  } catch (_) {}
  
  // Auto-start automation if not already running (only once per session)
  if (!transcriptionState.automationStarted) {
    try {
      // Get status directly instead of message passing
      await loadSettings();
      const currentStatus = getStatus();
      console.log('[Transcription] Current automation status:', currentStatus);
      
      if (!currentStatus.running) {
        // Get current prompts from storage
        const currentState = await chrome.storage.local.get(['state']);
        const stateData = currentState.state || { prompts: [] };
        console.log('[Transcription] Current prompts:', stateData.prompts);
        
        if (stateData.prompts.length > 0) {
          // Get active tab
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tabs?.[0]?.id;
          console.log('[Transcription] Active tab ID:', tabId);
          
          if (tabId) {
            // Get current settings directly
            const currentSettings = state.options || {};
            console.log('[Transcription] Settings:', currentSettings);
            
            await startAutomation({ prompts: stateData.prompts, tabId, options: currentSettings });
            transcriptionState.automationStarted = true;
            console.log('[Transcription] Auto-started automation for new transcript');
          } else {
            console.error('[Transcription] No active tab found');
          }
        } else {
          console.log('[Transcription] No prompts in queue to automate');
        }
      } else {
        console.log('[Transcription] Automation already running');
      }
    } catch (error) {
      console.error('[Transcription] Failed to auto-start automation:', error);
    }
  }
}

// Start transcription monitoring
async function startTranscriptionMonitoring(folder) {
  const normalizedFolder = typeof folder === 'string' ? folder.trim() : '';
  console.log('[Transcription] Starting monitoring for:', normalizedFolder);
  
  await verifyTranscriptionFolder(normalizedFolder);
  
  transcriptionState.isEnabled = true;
  transcriptionState.watchFolder = normalizedFolder;
  transcriptionState.lastCheckTime = Date.now();
  transcriptionState.automationStarted = false; // Reset flag
  
  // Clear processed files to start fresh
  transcriptionState.processedFiles.clear();
  console.log('[Transcription] Cleared processed files list');
  
  await saveTranscriptionState();
  
  startTranscriptionPolling();
}

// Stop transcription monitoring
async function stopTranscriptionMonitoring() {
  console.log('[Transcription] Stopping monitoring');
  
  transcriptionState.isEnabled = false;
  transcriptionState.automationStarted = false; // Reset flag
  
  if (transcriptionState.checkInterval) {
    clearInterval(transcriptionState.checkInterval);
    transcriptionState.checkInterval = null;
  }
  
  await saveTranscriptionState();
}

function startTranscriptionPolling() {
  if (transcriptionState.checkInterval) {
    clearInterval(transcriptionState.checkInterval);
  }

  transcriptionState.checkInterval = setInterval(checkForNewTranscriptionFiles, 5000);

  // Initial check
  checkForNewTranscriptionFiles();
}

// Transcription monitoring messages handled in main message handler above.
