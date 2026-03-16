// Background service worker for AI Task Sequencer with sleep/wake support

// Console prefix patch - runs in service worker context
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

importScripts('background-parallel-utils.js');
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
    refreshTabBeforeEachPrompt: false,
    parallelOneTabPerPrompt: false,
    parallelActivateTabBeforeSend: true,
    enableRetryOnFailure: true,
    maxRetriesPerPrompt: 2,
    retryDelayMs: 2000,
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
  parallel: null,
};
let sequentialRetryTimer = null;
let stateHydrated = false;
let lastHealthLogAt = 0;

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
  refreshTabBeforeEachPrompt: false,
  parallelOneTabPerPrompt: false,
  parallelActivateTabBeforeSend: true,
  enableRetryOnFailure: true,
  maxRetriesPerPrompt: 2,
  retryDelayMs: 2000,
  enableMaxWaitTimeout: true,
  enableStopWord: false,
  stopWord: 'end of feedback',
  stopWordCaseSensitive: false,
  openNewChatPerPrompt: false,
  openNewChatPerPromptUrl: '',
};

const SETTINGS_STORAGE_KEY = 'aiTaskSequencerSettings';
const SETTINGS_MIGRATIONS_STORAGE_KEY = 'aiTaskSequencerSettingsMigrations';

const RECOVERY_CONFIG = {
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 2000,
  staleThresholdMs: 60000, // Increased to 60 seconds for slower AI responses
  healthCheckIntervalMs: 5000,
  minRecoveryIntervalMs: 3000,
  recoveryBackoffMultiplier: 1.5, // Exponential backoff
};

const PARALLEL_RUNTIME_CONFIG = {
  backgroundMaxWaitMultiplier: 4,
  backgroundMaxWaitFloorMs: 300000,
  backgroundPollFloorMs: 2000,
  connectionFailureCircuitBreaker: 3,
};

function stringifyLogDetails(details) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (typeof value === 'bigint') {
        return String(value);
      }
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return `[unserializable:${String(err?.message || err)}]`;
  }
}

function logWithDetails(level, message, details) {
  if (details === undefined) {
    console[level](message);
    return;
  }
  console[level](`${message} ${stringifyLogDetails(details)}`);
}

function buildPromptFingerprint(text) {
  const normalized = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    length: normalized.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

function getRuntimeErrorMessage(err) {
  if (!err) return '';
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  return String(err);
}

function coerceNumber(v, min, max, fallback) {
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (typeof min === 'number' && n < min) return fallback;
    if (typeof max === 'number' && n > max) return fallback;
    return n;
  }
  return fallback;
}

function validateSettings(input = {}) {
  const sanitizedUrl = sanitizeUrlOrEmpty(input.openNewChatPerPromptUrl);
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
    watchedElementSelector: typeof input.watchedElementSelector === 'string'
      ? input.watchedElementSelector.trim()
      : DEFAULT_SETTINGS.watchedElementSelector,
    refreshTabBeforeEachPrompt: input.refreshTabBeforeEachPrompt === true,
    parallelOneTabPerPrompt: input.parallelOneTabPerPrompt === true,
    parallelActivateTabBeforeSend: input.parallelActivateTabBeforeSend !== false,
    enableRetryOnFailure: input.enableRetryOnFailure !== false,
    maxRetriesPerPrompt: coerceNumber(input.maxRetriesPerPrompt, 0, 10, DEFAULT_SETTINGS.maxRetriesPerPrompt),
    retryDelayMs: coerceNumber(input.retryDelayMs, 0, 60000, DEFAULT_SETTINGS.retryDelayMs),
    enableMaxWaitTimeout: input.enableMaxWaitTimeout !== false,
    enableStopWord: input.enableStopWord === true,
    stopWord: typeof input.stopWord === 'string' ? input.stopWord.trim() : DEFAULT_SETTINGS.stopWord,
    stopWordCaseSensitive: input.stopWordCaseSensitive === true,
    openNewChatPerPrompt: input.openNewChatPerPrompt === true,
    openNewChatPerPromptUrl: sanitizedUrl,
  };
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

function getStatus() {
  const parallel = state.parallel || {};
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
    parallelLaunched: parallel.launched || 0,
    parallelCompleted: parallel.completed || 0,
    parallelUncertain: parallel.uncertain || 0,
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
    uncertain: 0,
    failed: 0,
    active: 0,
    lastFailure: null,
    tabAutoDiscardableByTabId: {},
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
    savedAt: Date.now(),
    stableCountdownMs: state.stableCountdownMs,
    parallel: state.parallel,
  };
  await chrome.storage.local.set({ aiTaskSequencerState: persistentState });
}

async function loadState() {
  const { aiTaskSequencerState } = await chrome.storage.local.get('aiTaskSequencerState');
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
    if (state.mode === 'parallel') {
      const restoredParallel = aiTaskSequencerState.parallel || {};
      state.parallel = {
        ...createEmptyParallelState(),
        ...restoredParallel,
        tabAutoDiscardableByTabId: restoredParallel.tabAutoDiscardableByTabId || {},
        workersById: restoredParallel.workersById || {},
        workersByPromptId: restoredParallel.workersByPromptId || {},
      };
    } else {
      state.parallel = null;
    }
    logWithDetails('log', '[LoadState] State loaded from storage', {
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

async function ensureStateHydrated() {
  if (stateHydrated) return;
  await loadState();
  stateHydrated = true;
}

function normalizeErrorMessage(value) {
  return String(value || '').trim();
}

function isConnectionOrInjectionError(errorMessage) {
  const msg = normalizeErrorMessage(errorMessage).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('could not establish connection') ||
    msg.includes('receiving end does not exist') ||
    msg.includes('content script') ||
    msg.includes('inject') ||
    msg.includes('cannot access') ||
    msg.includes('no tab with id')
  );
}

function isLikelyCompletionTimeoutError(errorMessage) {
  const msg = normalizeErrorMessage(errorMessage).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('waitforcompletion')
  );
}

async function setTabAutoDiscardable(tabId, autoDiscardable) {
  if (!tabId || typeof autoDiscardable !== 'boolean') return false;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable });
    return true;
  } catch (_) {
    return false;
  }
}

async function rememberParallelTabDiscardPolicy(tabId) {
  if (!state.parallel || !tabId) return;
  const key = String(tabId);
  if (state.parallel.tabAutoDiscardableByTabId?.[key] !== undefined) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const original = typeof tab?.autoDiscardable === 'boolean' ? tab.autoDiscardable : true;
    state.parallel.tabAutoDiscardableByTabId[key] = original;
    const changed = await setTabAutoDiscardable(tabId, false);
    if (!changed) {
      console.warn('[Parallel] Could not set tab autoDiscardable=false', { tabId });
    }
  } catch (e) {
    console.warn('[Parallel] Could not capture tab discard policy', { tabId, error: String(e?.message || e) });
  }
}

async function restoreParallelTabDiscardPolicy(parallelState) {
  const map = parallelState?.tabAutoDiscardableByTabId || {};
  const entries = Object.entries(map);
  if (!entries.length) return;
  for (const [tabIdRaw, original] of entries) {
    const tabId = Number(tabIdRaw);
    if (!Number.isFinite(tabId)) continue;
    await setTabAutoDiscardable(tabId, original === true);
  }
}

async function clearState() {
  const parallelSnapshot = state.parallel ? {
    tabAutoDiscardableByTabId: { ...(state.parallel.tabAutoDiscardableByTabId || {}) },
  } : null;
  await restoreParallelTabDiscardPolicy(parallelSnapshot);
  await chrome.storage.local.remove('aiTaskSequencerState');
  if (sequentialRetryTimer) {
    clearTimeout(sequentialRetryTimer);
    sequentialRetryTimer = null;
  }
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
  state.stableCountdownMs = 0;
  state.parallel = null;
  stateHydrated = true;
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

async function testContentScriptConnection(tabId, { suppressFailureLog = false } = {}) {
  return new Promise((resolve) => {
    try {
      const timeoutId = setTimeout(() => {
        if (!suppressFailureLog) {
          logWithDetails('log', '[TestConnection] Timeout reached', { tabId });
        }
        resolve(false);
      }, 2000);

      chrome.tabs.sendMessage(
        tabId,
        { type: "PING" },
        (response) => {
          clearTimeout(timeoutId);
          if (chrome.runtime.lastError) {
            if (!suppressFailureLog) {
              logWithDetails('log', '[TestConnection] Ping failed', {
                tabId,
                error: getRuntimeErrorMessage(chrome.runtime.lastError),
              });
            }
            resolve(false);
          } else {
            resolve(response?.ok === true);
          }
        }
      );
    } catch (e) {
      if (!suppressFailureLog) {
        logWithDetails('log', '[TestConnection] Ping threw', {
          tabId,
          error: getRuntimeErrorMessage(e),
        });
      }
      resolve(false);
    }
  });
}

async function ensureContentScriptReady(tabId) {
  const isConnected = await testContentScriptConnection(tabId, { suppressFailureLog: true });
  if (!isConnected) {
    await injectContentScript(tabId);
    // Wait a bit for injection
    await new Promise(resolve => setTimeout(resolve, 500));
    const stillConnected = await testContentScriptConnection(tabId, { suppressFailureLog: false });
    if (!stillConnected) {
      try {
        const tab = await chrome.tabs.get(tabId);
        logWithDetails('warn', '[EnsureContentScriptReady] Unreachable after injection', {
          tabId,
          url: tab?.url || null,
          status: tab?.status || null,
          discarded: tab?.discarded === true,
          active: tab?.active === true,
        });
      } catch (tabErr) {
        logWithDetails('warn', '[EnsureContentScriptReady] Unreachable after injection', {
          tabId,
          tabLookupError: getRuntimeErrorMessage(tabErr),
        });
      }
    }
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
  const shouldLogHealth =
    state.processing ||
    timeSinceActivity > RECOVERY_CONFIG.staleThresholdMs ||
    (now - lastHealthLogAt >= 30000);
  if (shouldLogHealth) {
    lastHealthLogAt = now;
    logWithDetails('log', '[Health] Tick', {
      running: state.running,
      processing: state.processing,
      promptStartTime: state.promptStartTime,
      timeSinceActivity,
      timeSinceLastRecovery,
      recoveryAttempts: state.recoveryAttempts,
      staleThreshold: RECOVERY_CONFIG.staleThresholdMs,
    });
  }

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
  let migrations = {};
  let shouldPersistMigration = false;
  try {
    const localResult = await chrome.storage.local.get([SETTINGS_STORAGE_KEY, SETTINGS_MIGRATIONS_STORAGE_KEY]);
    rawSettings = localResult?.[SETTINGS_STORAGE_KEY] || null;
    migrations = localResult?.[SETTINGS_MIGRATIONS_STORAGE_KEY] || {};
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

  if (!migrations?.parallelActivateTabBeforeSendDefaultTrue) {
    rawSettings = { ...(rawSettings || {}), parallelActivateTabBeforeSend: true };
    migrations = { ...(migrations || {}), parallelActivateTabBeforeSendDefaultTrue: true };
    shouldPersistMigration = true;
  }

  const merged = validateSettings({ ...DEFAULT_SETTINGS, ...(rawSettings || {}) });
  state.options = merged;
  if (shouldPersistMigration) {
    try {
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: merged,
        [SETTINGS_MIGRATIONS_STORAGE_KEY]: migrations,
      });
    } catch (e) {
      console.warn('[LoadSettings] Failed to persist settings migration:', e?.message || e);
    }
  }
}

async function saveSettings(newSettings) {
  const merged = validateSettings({ ...state.options, ...newSettings });
  state.options = merged;
  try {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
  } catch (e) {
    console.error('[SaveSettings] Failed to persist settings:', e);
    throw e;
  }
  await broadcastSettingsUpdate();
  await ensureAutoConfirmContentScript();
}

async function broadcastSettingsUpdate() {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach((tab) => {
      if (tab?.id && isSupportedUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: state.options }, () => {
          // Read lastError to avoid unchecked runtime errors
          void chrome.runtime.lastError;
        });
      }
    });
  } catch (_) {}
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
  }
});

// ============ CONTENT SCRIPT INJECTION ============

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content.js"],
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

function waitForTabActive(tabId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        if (tab?.active === true) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 120);
      });
    };

    check();
  });
}

async function activateParallelTabBeforeSend(worker, tabSnapshot) {
  if (!worker?.tabId) {
    throw new Error('Parallel worker tab missing while trying to activate before send.');
  }

  const currentTab = tabSnapshot || await chrome.tabs.get(worker.tabId);

  if (!isSupportedUrl(currentTab?.url)) {
    throw new Error('Parallel worker tab became unsupported before activation.');
  }

  const windowId = currentTab?.windowId;
  if (Number.isFinite(windowId)) {
    try {
      await chrome.windows.update(windowId, { focused: true });
    } catch (focusErr) {
      console.warn('[Parallel] Could not focus worker window before send', {
        workerId: worker.workerId,
        tabId: worker.tabId,
        windowId,
        error: String(focusErr?.message || focusErr),
      });
    }
  }

  await chrome.tabs.update(worker.tabId, { active: true });
  const active = await waitForTabActive(worker.tabId, 4000);
  if (!active) {
    throw new Error('Parallel worker tab did not become active before send.');
  }

  // Allow a short settle window so UI picks up active state before content interaction.
  await new Promise((resolve) => setTimeout(resolve, 350));
  const refreshed = await chrome.tabs.get(worker.tabId);
  if (!isSupportedUrl(refreshed?.url)) {
    throw new Error('Parallel worker tab became unsupported after activation.');
  }
  return refreshed;
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

  await chrome.tabs.reload(tabId);
  const loaded = await waitForTabLoad(tabId);
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

    logWithDetails('warn', '[Parallel] Tab load timed out, waiting and retrying', {
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

async function waitForParallelInitialDispatchOutcome(workerId, launchToken, promptIndex = 0) {
  const start = Date.now();
  while (shouldContinueParallelLaunch(launchToken)) {
    const worker = state.parallel?.workersById?.[workerId];
    if (!worker) return false;
    if (worker.status === 'failed') return false;
    if (worker.status === 'completed' || worker.status === 'completed_uncertain') return true;
    if (worker.promptSubmittedByIndex?.[promptIndex]) {
      return true;
    }
    if (Date.now() - start > (state.options?.maxWaitMs || DEFAULT_SETTINGS.maxWaitMs)) {
      console.warn('[Parallel] Timed out waiting for initial dispatch outcome', {
        workerId,
        tabId: worker.tabId,
        promptIndex,
        dispatchAccepted: !!worker.submittedPromptByIndex?.[promptIndex],
        promptSubmitted: !!worker.promptSubmittedByIndex?.[promptIndex],
        inFlightPromptId: worker.inFlightPromptId || null,
      });
      return false;
    }
    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
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

async function ensureParallelTabReadyForDispatch(worker) {
  if (!worker?.tabId) {
    throw new Error('Parallel worker tab is missing.');
  }

  let tab;
  try {
    tab = await chrome.tabs.get(worker.tabId);
  } catch {
    throw new Error('Parallel worker tab was closed.');
  }
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Parallel worker tab is on an unsupported URL.');
  }

  if (tab.discarded === true || tab.frozen === true) {
    console.warn('[Parallel] Worker tab is discarded/frozen; reloading before dispatch', {
      workerId: worker.workerId,
      tabId: worker.tabId,
      discarded: tab.discarded === true,
      frozen: tab.frozen === true,
    });
    await chrome.tabs.reload(worker.tabId);
    const loaded = await waitForTabLoad(worker.tabId);
    if (!loaded) {
      throw new Error('Timed out reloading discarded/frozen worker tab.');
    }
    tab = await chrome.tabs.get(worker.tabId);
    if (!isSupportedUrl(tab?.url)) {
      throw new Error('Worker tab became unsupported after reload.');
    }
  }

  const ready = await ensureContentScriptReady(worker.tabId);
  if (!ready) {
    throw new Error('Could not establish connection to content script');
  }

  return tab;
}

function getParallelDispatchOptions(tabSnapshot) {
  const foregroundSend = state.options?.parallelActivateTabBeforeSend === true;
  const options = {
    ...state.options,
    openNewChatPerPrompt: false,
    refreshTabBeforeEachPrompt: false,
    parallelOneTabPerPrompt: false,
    parallelDispatch: true,
    allowBackgroundSendWithoutStream: !foregroundSend,
    skipRenderVerification: !foregroundSend,
  };
  if (tabSnapshot?.active !== true) {
    const baseMaxWait = Number(options.maxWaitMs) || DEFAULT_SETTINGS.maxWaitMs;
    const basePoll = Number(options.pollIntervalMs) || DEFAULT_SETTINGS.pollIntervalMs;
    options.maxWaitMs = Math.max(
      PARALLEL_RUNTIME_CONFIG.backgroundMaxWaitFloorMs,
      Math.floor(baseMaxWait * PARALLEL_RUNTIME_CONFIG.backgroundMaxWaitMultiplier),
    );
    options.pollIntervalMs = Math.max(basePoll, PARALLEL_RUNTIME_CONFIG.backgroundPollFloorMs);
  }
  return options;
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
  if (!worker || worker.status === 'completed' || worker.status === 'completed_uncertain' || worker.status === 'failed') return false;

  const retryPolicy = getRetryPolicy(state.options);
  if (!retryPolicy.enabled || retryPolicy.maxRetries <= 0) return false;

  worker.promptRetryCounts = worker.promptRetryCounts || {};
  const currentRetries = worker.promptRetryCounts[promptIndex] || 0;
  if (currentRetries >= retryPolicy.maxRetries) return false;

  const nextRetryAttempt = currentRetries + 1;
  worker.promptRetryCounts[promptIndex] = nextRetryAttempt;
  worker.status = 'retrying';
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
  });

  setTimeout(() => {
    (async () => {
      if (!state.running || state.mode !== 'parallel' || !state.parallel) return;
      const liveWorker = state.parallel.workersById?.[workerId];
      if (!liveWorker || liveWorker.status === 'completed' || liveWorker.status === 'completed_uncertain' || liveWorker.status === 'failed') return;
      if (liveWorker.inFlightPromptId) return;
      if (liveWorker.nextPromptIndex !== promptIndex) return;
      if (liveWorker.submittedPromptByIndex?.[promptIndex]) return;

      liveWorker.status = 'running';
      state.lastActivityTime = Date.now();
      await saveState();
      await emitParallelProgress();
      await dispatchParallelWorkerPrompt(workerId);
    })().catch(async (retryErr) => {
      console.error('[Retry][Parallel] Retry dispatch failed', {
        workerId,
        promptIndex,
        error: retryErr?.message || String(retryErr),
      });
      await markParallelWorkerFailed(workerId, String(retryErr?.message || retryErr));
    });
  }, retryPolicy.retryDelayMs);

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

async function finalizeParallelWorker(workerId, { failed, uncertain, errorMessage } = {}) {
  if (state.mode !== 'parallel' || !state.parallel) return;
  const worker = state.parallel.workersById?.[workerId];
  if (!worker || worker.status === 'completed' || worker.status === 'completed_uncertain' || worker.status === 'failed') return;

  if (worker.inFlightPromptId) {
    delete state.parallel.workersByPromptId[worker.inFlightPromptId];
    worker.inFlightPromptId = null;
  }

  const resolvedError = failed || uncertain ? (errorMessage || 'Unknown parallel worker issue') : null;
  worker.status = failed ? 'failed' : (uncertain ? 'completed_uncertain' : 'completed');
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
      error: resolvedError,
      at: Date.now(),
      tab: await getParallelTabSnapshot(worker.tabId),
    };
    worker.failure = failureSnapshot;
    state.parallel.lastFailure = failureSnapshot;
    logWithDetails('log', '[Parallel] Worker failed', failureSnapshot);
  } else {
    if (uncertain) {
      state.parallel.uncertain += 1;
      worker.warning = resolvedError;
      logWithDetails('log', '[Parallel] Worker completed with uncertainty', {
        workerId: worker.workerId,
        workerIndex: worker.index,
        tabId: worker.tabId || null,
        warning: resolvedError,
      });
    }
    state.parallel.completed += 1;
  }

  state.currentIndex = (state.parallel.completed || 0) + (state.parallel.failed || 0);
  state.lastActivityTime = Date.now();
  state.recoveryAttempts = 0;
  await saveState();
  await emitParallelProgress();
  await maybeFinalizeParallelRun((failed || uncertain) ? 'completedWithErrors' : undefined);
}

async function markParallelWorkerFailed(workerId, errorMessage) {
  await finalizeParallelWorker(workerId, { failed: true, errorMessage });
}

async function dispatchParallelWorkerPrompt(workerId) {
  if (state.mode !== 'parallel' || !state.parallel || !state.running) return false;
  const worker = state.parallel.workersById?.[workerId];
  if (!worker || worker.status === 'completed' || worker.status === 'completed_uncertain' || worker.status === 'failed') return false;
  if (!worker.tabId || worker.inFlightPromptId) return false;
  if (worker.nextPromptIndex >= worker.prompts.length) return false;

  const promptIndex = worker.nextPromptIndex;
  worker.submittedPromptByIndex = worker.submittedPromptByIndex || {};
  if (worker.submittedPromptByIndex[promptIndex]) {
    console.warn('[Parallel] Idempotency guard blocked duplicate resend', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      submittedPromptId: worker.submittedPromptByIndex[promptIndex]?.promptId,
    });
    worker.nextPromptIndex = Math.max(worker.nextPromptIndex, promptIndex + 1);
    state.lastActivityTime = Date.now();
    await saveState();
    return false;
  }

  let tabSnapshot = null;
  try {
    tabSnapshot = await ensureParallelTabReadyForDispatch(worker);
    logWithDetails('log', '[Parallel] Activating worker tab before dispatch', {
      workerId,
      tabId: worker.tabId,
      workerIndex: worker.index,
    });
    tabSnapshot = await activateParallelTabBeforeSend(worker, tabSnapshot);
  } catch (prepErr) {
    const prepError = normalizeErrorMessage(prepErr?.message || prepErr);
    console.error('[Parallel] Worker tab not ready for dispatch', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      error: prepError,
    });
    const retried = await scheduleParallelPromptRetry(workerId, promptIndex, prepError, 'ensureParallelTabReadyForDispatch');
    if (!retried) {
      await markParallelWorkerFailed(workerId, prepError);
    }
    return false;
  }

  const basePromptText = worker.prompts[promptIndex];
  const promptText = buildMessageText(basePromptText);
  const promptId = buildParallelPromptId(worker.index, promptIndex);
  const baseFingerprint = buildPromptFingerprint(basePromptText);
  const finalFingerprint = buildPromptFingerprint(promptText);
  logWithDetails('log', '[Parallel] Built prompt payload', {
    workerId,
    promptIndex,
    baseLength: typeof basePromptText === 'string' ? basePromptText.length : 0,
    finalLength: typeof promptText === 'string' ? promptText.length : 0,
    baseFingerprint,
    finalFingerprint,
  });
  worker.inFlightPromptId = promptId;
  worker.status = 'running';
  state.parallel.workersByPromptId[promptId] = { workerId, promptIndex };
  state.lastActivityTime = Date.now();
  await saveState();

  try {
    const dispatchOptions = {
      ...getParallelDispatchOptions(tabSnapshot),
      skipCompletionWait: worker.prompts.length === 1 && state.options?.parallelActivateTabBeforeSend !== true,
    };
    await sendToContent(worker.tabId, {
      type: 'SEND_PROMPT',
      text: promptText,
      index: promptIndex,
      total: worker.prompts.length,
      options: dispatchOptions,
      promptId,
    });
    worker.nextPromptIndex = promptIndex + 1;
    worker.submittedPromptByIndex[promptIndex] = { promptId, sentAt: Date.now() };
    worker.connectionFailureStreak = 0;
    state.lastActivityTime = Date.now();
    await saveState();
    return true;
  } catch (err) {
    delete state.parallel.workersByPromptId[promptId];
    worker.inFlightPromptId = null;
    const dispatchError = String(err?.message || err);
    if (isConnectionOrInjectionError(dispatchError)) {
      worker.connectionFailureStreak = (worker.connectionFailureStreak || 0) + 1;
    } else {
      worker.connectionFailureStreak = 0;
    }
    console.error('[Parallel] Failed to dispatch prompt to worker tab', {
      workerId,
      tabId: worker.tabId,
      promptIndex,
      error: dispatchError,
      connectionFailureStreak: worker.connectionFailureStreak || 0,
    });
    if ((worker.connectionFailureStreak || 0) >= PARALLEL_RUNTIME_CONFIG.connectionFailureCircuitBreaker) {
      await markParallelWorkerFailed(workerId, `Connection failures exceeded limit (${PARALLEL_RUNTIME_CONFIG.connectionFailureCircuitBreaker})`);
      return false;
    }
    const retried = await scheduleParallelPromptRetry(workerId, promptIndex, dispatchError, 'dispatchParallelWorkerPrompt');
    if (!retried) {
      await markParallelWorkerFailed(workerId, dispatchError);
    }
    return false;
  }
}

async function runParallelFanoutLaunch({ promptGroups, launchUrl }) {
  const launchToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  state.parallel = createEmptyParallelState();
  state.parallel.launchInProgress = true;
  state.parallel.launchToken = launchToken;
  state.lastActivityTime = Date.now();
  await saveState();
  await emitParallelProgress();

  for (let index = 0; index < promptGroups.length; index += 1) {
    if (!shouldContinueParallelLaunch(launchToken)) break;
    await waitWhileParallelPaused(launchToken);
    if (!shouldContinueParallelLaunch(launchToken)) break;

    const workerId = buildParallelWorkerId(index);
    const worker = {
      workerId,
      index,
      tabId: null,
      prompts: promptGroups[index],
      nextPromptIndex: 0,
      inFlightPromptId: null,
      promptRetryCounts: {},
      submittedPromptByIndex: {},
      promptSubmittedByIndex: {},
      connectionFailureStreak: 0,
      status: 'launching',
      error: null,
      isActive: false,
    };
    state.parallel.workersById[workerId] = worker;
    state.parallel.launchCursor = index + 1;
    state.lastActivityTime = Date.now();
    await saveState();

    let createdTabId = null;
    try {
      const tab = await chrome.tabs.create({ url: launchUrl, active: false });
      createdTabId = tab?.id || null;
      worker.tabId = createdTabId;
      worker.status = 'loading';
      state.parallel.launched += 1;
      state.lastActivityTime = Date.now();
      await rememberParallelTabDiscardPolicy(createdTabId);
      await saveState();

      if (!createdTabId) {
        throw new Error('Failed to create parallel tab');
      }

      const loaded = await waitForParallelTabLoaded(createdTabId, launchToken, workerId);
      if (!loaded) {
        throw new Error('Parallel launch canceled while waiting for tab load');
      }

      const ready = await waitForParallelContentScriptReady(createdTabId, launchToken, workerId);
      if (!ready) {
        throw new Error('Parallel launch canceled while waiting for content script readiness');
      }

      worker.status = 'running';
      worker.isActive = true;
      state.parallel.active += 1;
      state.lastActivityTime = Date.now();
      await saveState();
      const initialDispatchAccepted = await dispatchParallelWorkerPrompt(workerId);
      const initialOutcome = await waitForParallelInitialDispatchOutcome(workerId, launchToken, 0);
      if (!initialOutcome) {
        const latestWorker = state.parallel?.workersById?.[workerId];
        if (latestWorker?.status !== 'failed') {
          const reason = initialDispatchAccepted
            ? 'Prompt was dispatched but send was not confirmed before timeout.'
            : 'Initial parallel prompt was not dispatched successfully.';
          await markParallelWorkerFailed(workerId, reason);
        }
        continue;
      }

      logWithDetails('log', '[Parallel] Initial send confirmed; proceeding to next tab launch', {
        workerId,
        tabId: createdTabId,
        workerIndex: worker.index,
      });
    } catch (err) {
      if (!shouldContinueParallelLaunch(launchToken)) {
        console.log('[Parallel] Launch canceled while preparing worker', {
          workerId,
          index,
          tabId: createdTabId,
          error: err?.message || String(err),
        });
        break;
      }
      console.error('[Parallel] Worker launch/send failed', {
        workerId,
        index,
        tabId: createdTabId,
        error: err?.message || String(err),
      });
      await markParallelWorkerFailed(workerId, String(err?.message || err));
    } finally {
      await emitParallelProgress();
    }
  }

  if (state.mode === 'parallel' && state.parallel && state.parallel.launchToken === launchToken) {
    state.parallel.launchInProgress = false;
    state.parallel.launchDone = true;
    state.lastActivityTime = Date.now();
    await saveState();
    await emitParallelProgress();
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
    logWithDetails('error', '[SendToContent] Content script not ready', { tabId, messageType: message?.type });
    throw new Error('Could not establish connection to content script');
  }

  logWithDetails('log', '[SendToContent] Sending message to content', { tabId, messageType: message?.type });
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        message,
        (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError?.message || String(chrome.runtime.lastError);
            logWithDetails('error', '[SendToContent] Error', { tabId, messageType: message?.type, error: errMsg });
            reject(new Error(errMsg));
          } else {
            logWithDetails('log', '[SendToContent] Response received from content', {
              tabId,
              messageType: message?.type,
              response,
            });
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

  const useParallel = shouldUseParallelMode(state.options);
  const parallelPromptGroups = useParallel ? resolveParallelPromptGroups(prompts, tabPromptGroups) : [];
  if (useParallel && parallelPromptGroups.length > PARALLEL_CONFIG.maxTabs) {
    throw new Error(`Parallel mode supports up to ${PARALLEL_CONFIG.maxTabs} prompts at a time.`);
  }
  if (useParallel && state.options.parallelActivateTabBeforeSend !== true) {
    state.options = {
      ...state.options,
      parallelActivateTabBeforeSend: true,
    };
    console.log('[Parallel] Enforcing active-tab dispatch for this run');
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
    logWithDetails('log', '[Parallel] Starting fan-out run', {
      tabs: parallelPromptGroups.length,
      maxTabs: PARALLEL_CONFIG.maxTabs,
      launchUrl,
      launchStrategy: 'create tab -> activate tab -> dispatch prompt -> wait prompt-submitted -> launch next tab',
      foregroundSend: true,
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
  const shouldAppend = appendText.length > 0;

  logWithDetails('log', '[BuildMessageText] Applying prompt wrappers', {
    prependEnabled: prependSystemPrompt === true,
    appendEnabled: appendSystemPrompt === true,
    appendEffective: shouldAppend,
    prependLength: prependText.length,
    appendLength: appendText.length,
    baseLength: typeof text === 'string' ? text.length : 0,
  });

  if (!prependText && !appendText) return text;
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
      await chrome.tabs.update(state.tabId, { url: targetUrl });
      await waitForTabLoad(state.tabId);
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
      parallelActivateTabBeforeSend: item.settings?.parallelActivateTabBeforeSend === true,
      enableRetryOnFailure: item.settings?.enableRetryOnFailure !== false,
      maxRetriesPerPrompt: coerceNumber(item.settings?.maxRetriesPerPrompt, 0, 10, DEFAULT_SETTINGS.maxRetriesPerPrompt),
      retryDelayMs: coerceNumber(item.settings?.retryDelayMs, 0, 60000, DEFAULT_SETTINGS.retryDelayMs),
      enableMaxWaitTimeout: item.settings?.enableMaxWaitTimeout !== false,
      enableStopWord: item.settings?.enableStopWord === true,
      stopWord: typeof item.settings?.stopWord === 'string' ? item.settings.stopWord.trim() : '',
      stopWordCaseSensitive: item.settings?.stopWordCaseSensitive === true,
      openNewChatPerPrompt: item.settings?.openNewChatPerPrompt === true,
      openNewChatPerPromptUrl: sanitizeUrlOrEmpty(item.settings?.openNewChatPerPromptUrl),
    },
  };
  return JSON.stringify(normalized);
}

// ============ MESSAGE HANDLERS ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // Rehydrate once per service-worker lifetime; avoids stomping live in-memory state
      // while still recovering correctly after MV3 restarts.
      await ensureStateHydrated();

      switch (message?.type) {
        case "CONTENT_READY": {
          state.lastActivityTime = Date.now();
          await saveState();
          sendResponse({ ok: true });
          return;
        }
        case "SIDE_PANEL_OPENED": {
          if (sender?.tab?.id) {
            openSidePanels.add(sender.tab.id);
          }
          sendResponse({ ok: true });
          return;
        }
        case "SIDE_PANEL_CLOSED": {
          if (sender?.tab?.id) {
            openSidePanels.delete(sender.tab.id);
          } else if (message?.tabId) {
            openSidePanels.delete(message.tabId);
          }
          sendResponse({ ok: true });
          return;
        }
        case "START_AUTOMATION": {
          logWithDetails('log', '[StartAutomation] Received request', {
            running: state.running,
            processing: state.processing,
            currentIndex: state.currentIndex,
            promptsInRequest: message.prompts?.length,
            tabGroupsInRequest: message.tabPromptGroups?.length,
          });
          // Prevent starting a new automation while one is already running
          if (state.running) {
            console.log('[StartAutomation] Automation already running, REJECTING new start request');
            sendResponse({ ok: false, error: "Automation is already running. Stop the current automation first." });
            return;
          }
          
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
            const useParallel = shouldUseParallelMode(effectiveOptions);
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
          state.running = false;
          state.paused = false;
          await clearState();
          sendResponse({ ok: true });
          return;
        }
        case "PAUSE_AUTOMATION": {
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
          sendResponse({ ok: true, status: getStatus() });
          return;
        }
        case "PROMPT_SUBMITTED": {
          sendResponse({ ok: true });

          if (state.mode !== 'parallel' || !state.running || !state.parallel) {
            return;
          }

          const promptId = typeof message.promptId === 'string' ? message.promptId.trim() : '';
          if (!promptId) {
            console.log('[PromptSubmitted][Parallel] Missing promptId, ignoring');
            return;
          }

          const senderTabId = sender?.tab?.id || null;
          let promptRef = state.parallel.workersByPromptId?.[promptId] || null;
          if (!promptRef && senderTabId) {
            const fallbackWorker = Object.values(state.parallel.workersById || {}).find((candidate) => (
              candidate?.tabId === senderTabId &&
              candidate?.status !== 'completed' &&
              candidate?.status !== 'completed_uncertain' &&
              candidate?.status !== 'failed' &&
              candidate?.inFlightPromptId === promptId
            ));
            if (fallbackWorker) {
              promptRef = {
                workerId: fallbackWorker.workerId,
                promptIndex: Math.max(0, (fallbackWorker.nextPromptIndex || 1) - 1),
                recoveredFromSenderTab: true,
              };
              state.parallel.workersByPromptId[promptId] = promptRef;
              console.warn('[PromptSubmitted][Parallel] Recovered prompt mapping via sender tab', {
                promptId,
                senderTabId,
                workerId: fallbackWorker.workerId,
              });
            }
          }

          if (!promptRef) {
            console.log('[PromptSubmitted][Parallel] Unknown promptId, ignoring', {
              promptId,
              senderTabId,
              pendingPromptIds: Object.keys(state.parallel.workersByPromptId || {}),
            });
            return;
          }

          const worker = state.parallel.workersById?.[promptRef.workerId];
          if (!worker) {
            console.log('[PromptSubmitted][Parallel] Missing worker for promptId, ignoring', { promptId, promptRef });
            return;
          }
          if (worker.status === 'completed' || worker.status === 'completed_uncertain' || worker.status === 'failed') {
            console.log('[PromptSubmitted][Parallel] Worker already finalized, ignoring', {
              promptId,
              workerId: worker.workerId,
              status: worker.status,
            });
            return;
          }

          const promptIndex = Number.isFinite(Number(promptRef.promptIndex))
            ? Number(promptRef.promptIndex)
            : Math.max(0, worker.nextPromptIndex - 1);
          const note = typeof message.note === 'string' ? message.note.trim() : '';
          const shouldConfirmSubmission =
            note === '' ||
            note === 'send-stage-complete' ||
            note === 'stream-detected' ||
            note === 'legacy';
          if (!shouldConfirmSubmission) {
            logWithDetails('log', '[PromptSubmitted][Parallel] Ignoring non-confirming note', {
              workerId: worker.workerId,
              workerIndex: worker.index,
              tabId: worker.tabId,
              promptId,
              promptIndex,
              note,
            });
            return;
          }
          worker.promptSubmittedByIndex = worker.promptSubmittedByIndex || {};

          if (!worker.promptSubmittedByIndex[promptIndex]) {
            worker.promptSubmittedByIndex[promptIndex] = {
              promptId,
              at: Date.now(),
              senderTabId,
              note: note || null,
            };
            state.lastActivityTime = Date.now();
            await saveState();
            await emitParallelProgress();
            logWithDetails('log', '[PromptSubmitted][Parallel] Prompt send confirmed', {
              workerId: worker.workerId,
              workerIndex: worker.index,
              tabId: worker.tabId,
              promptId,
              promptIndex,
            });
          }
          return;
        }
        case "RESPONSE_COMPLETE": {
          logWithDetails('log', '[ResponseComplete] Received', {
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

          if (state.mode === 'parallel') {
            if (!state.running || !state.parallel) {
              console.log('[ResponseComplete][Parallel] Not running or no parallel state, ignoring');
              return;
            }
            const promptId = message.promptId ? String(message.promptId) : '';
            let promptRef = promptId ? state.parallel.workersByPromptId?.[promptId] : null;
            const senderTabId = sender?.tab?.id || null;
            if (!promptRef && senderTabId) {
              const fallbackWorker = Object.values(state.parallel.workersById || {}).find((candidate) => (
                candidate?.tabId === senderTabId &&
                candidate?.status !== 'completed' &&
                candidate?.status !== 'completed_uncertain' &&
                candidate?.status !== 'failed' &&
                !!candidate?.inFlightPromptId &&
                (!promptId || candidate.inFlightPromptId === promptId)
              ));
              if (fallbackWorker) {
                promptRef = {
                  workerId: fallbackWorker.workerId,
                  promptIndex: Math.max(0, (fallbackWorker.nextPromptIndex || 1) - 1),
                  recoveredFromSenderTab: true,
                };
                if (promptId) {
                  state.parallel.workersByPromptId[promptId] = promptRef;
                }
                console.warn('[ResponseComplete][Parallel] Recovered prompt mapping via sender tab', {
                  promptId,
                  senderTabId,
                  workerId: fallbackWorker.workerId,
                  inFlightPromptId: fallbackWorker.inFlightPromptId,
                });
              }
            }
            if (!promptRef) {
              const pendingPromptIds = Object.keys(state.parallel.workersByPromptId || {});
              console.log('[ResponseComplete][Parallel] Unknown promptId, ignoring', {
                promptId,
                senderTabId,
                pendingPromptIds,
                workerCount: Object.keys(state.parallel.workersById || {}).length,
              });
              return;
            }
            const worker = state.parallel.workersById?.[promptRef.workerId];
            if (!worker) {
              console.log('[ResponseComplete][Parallel] Missing worker for promptId, ignoring', { promptId, promptRef });
              delete state.parallel.workersByPromptId[promptId];
              await saveState();
              return;
            }
            if (worker.status === 'completed' || worker.status === 'completed_uncertain' || worker.status === 'failed') {
              console.log('[ResponseComplete][Parallel] Worker already finalized, ignoring', {
                promptId,
                workerId: worker.workerId,
                status: worker.status,
              });
              delete state.parallel.workersByPromptId[promptId];
              await saveState();
              return;
            }
            if (worker.inFlightPromptId && worker.inFlightPromptId !== promptId) {
              console.log('[ResponseComplete][Parallel] Stale worker prompt response, ignoring', {
                promptId,
                inFlightPromptId: worker.inFlightPromptId,
                workerId: worker.workerId,
              });
              return;
            }

            worker.inFlightPromptId = null;
            delete state.parallel.workersByPromptId[promptId];
            if (worker.promptRetryCounts && Number.isFinite(promptRef.promptIndex)) {
              delete worker.promptRetryCounts[Number(promptRef.promptIndex)];
            }

            const hasStopWord = message.stoppedByStopWord === true;
            const hasError = !!message.error || hasStopWord;
            if (hasError) {
              const errorMessage = normalizeErrorMessage(message.error || (hasStopWord ? 'Stopped by stop phrase' : 'Unknown error'));
              if (hasStopWord) {
                await finalizeParallelWorker(worker.workerId, {
                  failed: true,
                  errorMessage,
                });
                return;
              }

              if (isLikelyCompletionTimeoutError(errorMessage)) {
                logWithDetails('log', '[ResponseComplete][Parallel] Completion timeout from background tab; no resend will be attempted', {
                  workerId: worker.workerId,
                  tabId: worker.tabId,
                  promptId,
                  promptIndex: promptRef.promptIndex,
                  errorMessage,
                });
                await finalizeParallelWorker(worker.workerId, {
                  failed: false,
                  uncertain: true,
                  errorMessage,
                });
                return;
              }

              await finalizeParallelWorker(worker.workerId, {
                failed: true,
                errorMessage,
              });
              return;
            }

            if (worker.nextPromptIndex < worker.prompts.length) {
              console.log('[ResponseComplete][Parallel] Worker still has queued prompts; dispatching next', {
                workerId: worker.workerId,
                tabId: worker.tabId,
                nextPromptIndex: worker.nextPromptIndex,
                promptsInWorker: worker.prompts.length,
              });
              state.lastActivityTime = Date.now();
              await saveState();
              await emitParallelProgress();
              await dispatchParallelWorkerPrompt(worker.workerId);
              return;
            }

            console.log('[ResponseComplete][Parallel] Worker queue finished; finalizing worker', {
              workerId: worker.workerId,
              tabId: worker.tabId,
              promptsInWorker: worker.prompts.length,
            });
            await finalizeParallelWorker(worker.workerId, { failed: false });
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
          state.processing = false;
          state.promptStartTime = 0;
          state.lastActivityTime = Date.now();
          state.recoveryAttempts = 0;

          if (message.error) {
            console.warn('[ResponseComplete] Completion reported an error; moving on without resend', {
              currentIndex: state.currentIndex,
              error: String(message.error),
            });
          }

          state.currentRetryCount = 0;
          state.currentIndex += 1;

          if (message.stoppedByStopWord) {
            console.log('[ResponseComplete] Stopped by stop phrase, ending automation');
            state.running = false;
            await clearState();
            try {
              chrome.runtime.sendMessage({ type: "AUTOMATION_COMPLETE", status: getStatus(), reason: "stoppedByStopWord" });
            } catch (_) {}
            return;
          }

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
            const { aiTaskSequencerHistory = [] } = await chrome.storage.local.get('aiTaskSequencerHistory');
            const sig = makeHistorySignature(historyItem);
            const exists = aiTaskSequencerHistory.some((h) => h.__sig === sig);
            if (!exists) {
              aiTaskSequencerHistory.unshift({ ...historyItem, savedAt: Date.now(), __sig: sig });
              const trimmed = aiTaskSequencerHistory.slice(0, 50);
              await chrome.storage.local.set({ aiTaskSequencerHistory: trimmed });
            }
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Invalid history item' });
          }
          return;
        }
        case "GET_PROMPT_HISTORY": {
          const { aiTaskSequencerHistory = [] } = await chrome.storage.local.get('aiTaskSequencerHistory');
          sendResponse({ ok: true, history: aiTaskSequencerHistory });
          return;
        }
        case "DELETE_PROMPT_HISTORY": {
          const index = message.index;
          const { aiTaskSequencerHistory = [] } = await chrome.storage.local.get('aiTaskSequencerHistory');
          if (typeof index === 'number' && index >= 0 && index < aiTaskSequencerHistory.length) {
            aiTaskSequencerHistory.splice(index, 1);
            await chrome.storage.local.set({ aiTaskSequencerHistory });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Invalid index' });
          }
          return;
        }
        case "SAVE_SETTINGS": {
          await saveSettings(message.settings || {});
          sendResponse({ ok: true, settings: state.options });
          return;
        }
        case "GET_SETTINGS": {
          await loadSettings();
          sendResponse({ ok: true, settings: state.options });
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
  const restored = await loadState();
  stateHydrated = true;
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
  await loadState();
  stateHydrated = true;
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
