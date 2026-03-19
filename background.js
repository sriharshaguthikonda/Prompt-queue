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
const parallelSubmissionWaiters = new Map();

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
  await chrome.storage.local.remove('aiTaskSequencerState');
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
  state.stableCountdownMs = 0;
  state.parallel = null;
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
  };
}

function resolveParallelPromptRef(promptId, senderTabId) {
  if (!state.parallel) return null;
  if (promptId && state.parallel.workersByPromptId[promptId]) {
    return state.parallel.workersByPromptId[promptId];
  }
  if (!senderTabId) return null;

  const fallbackWorker = Object.values(state.parallel.workersById || {}).find((worker) => (
    worker?.tabId === senderTabId &&
    worker?.status !== 'completed' &&
    worker?.status !== 'failed' &&
    !!worker?.inFlightPromptId
  ));
  if (!fallbackWorker) return null;

  const fallbackPromptId = promptId || fallbackWorker.inFlightPromptId;
  const promptRef = {
    workerId: fallbackWorker.workerId,
    promptIndex: Number.isFinite(fallbackWorker.nextPromptIndex)
      ? Math.max(0, Number(fallbackWorker.nextPromptIndex))
      : 0,
  };
  if (fallbackPromptId) {
    state.parallel.workersByPromptId[fallbackPromptId] = promptRef;
  }
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
  });
}

function settleParallelSubmission(promptId, payload) {
  if (!promptId) return false;
  const waiter = parallelSubmissionWaiters.get(promptId);
  if (!waiter) return false;
  waiter.resolve(payload);
  return true;
}

function rejectParallelSubmission(promptId, error) {
  if (!promptId) return false;
  const waiter = parallelSubmissionWaiters.get(promptId);
  if (!waiter) return false;
  waiter.reject(error instanceof Error ? error : new Error(String(error)));
  return true;
}

async function activateParallelWorkerTab(tabId, workerId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    throw new Error(`Worker tab is unavailable (${workerId}): ${String(err?.message || err)}`);
  }

  console.log('[Parallel] Activating worker tab', {
    workerId,
    tabId,
    windowId: tab?.windowId,
    currentlyActive: tab?.active === true,
    status: tab?.status,
  });

  if (Number.isInteger(tab?.windowId)) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (err) {
      console.warn('[Parallel] Could not focus worker window; continuing', {
        workerId,
        tabId,
        windowId: tab?.windowId,
        error: String(err?.message || err),
      });
    }
  }

  await chrome.tabs.update(tabId, { active: true });
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    const after = await chrome.tabs.get(tabId);
    console.log('[Parallel] Worker tab activated', {
      workerId,
      tabId,
      active: after?.active === true,
      status: after?.status,
      url: after?.url || null,
    });
  } catch (_) {}
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
  console.log('[Parallel] Built prompt payload', {
    workerId,
    promptIndex,
    baseLength: typeof basePromptText === 'string' ? basePromptText.length : 0,
    finalLength: typeof promptText === 'string' ? promptText.length : 0,
  });

  worker.inFlightPromptId = promptId;
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

    const ready = await waitForParallelContentScriptReady(worker.tabId, launchToken, workerId);
    if (!ready) {
      throw new Error('Content script was not ready before dispatch');
    }

    await activateParallelWorkerTab(worker.tabId, workerId);
    const submissionWait = createParallelSubmissionWaiter(
      promptId,
      Math.min(Math.max(state.options?.maxWaitMs || DEFAULT_SETTINGS.maxWaitMs, 15000), 60000),
    );

    await sendToContent(worker.tabId, {
      type: 'SEND_PROMPT',
      text: promptText,
      index: promptIndex,
      total: worker.prompts.length,
      options: getParallelDispatchOptions(),
      promptId,
    });

    const submissionMeta = await submissionWait;
    const liveWorker = state.parallel?.workersById?.[workerId];
    if (!liveWorker || liveWorker.status === 'completed' || liveWorker.status === 'failed') {
      return true;
    }

    if (liveWorker.inFlightPromptId === promptId) {
      liveWorker.inFlightPromptId = null;
    }
    delete state.parallel.workersByPromptId[promptId];
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
    liveWorker.nextPromptIndex = Math.max(liveWorker.nextPromptIndex || 0, promptIndex + 1);
    state.lastActivityTime = Date.now();
    await saveState();
    await emitParallelProgress();
    if (liveWorker.nextPromptIndex >= liveWorker.prompts.length) {
      await finalizeParallelWorker(liveWorker.workerId, { failed: false });
    }
    return true;
  } catch (err) {
    const liveWorker = state.parallel?.workersById?.[workerId];
    if (liveWorker && liveWorker.inFlightPromptId === promptId) {
      liveWorker.inFlightPromptId = null;
    } else if (worker.inFlightPromptId === promptId) {
      worker.inFlightPromptId = null;
    }
    delete state.parallel.workersByPromptId[promptId];
    const dispatchError = String(err?.message || err);
    console.error('[Parallel] Failed to dispatch prompt to worker tab', {
      workerId,
      tabId: liveWorker?.tabId || worker.tabId,
      promptIndex,
      error: dispatchError,
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
            console.log('[SendToContent] Response received from content', { tabId, messageType: message?.type, response });
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
      // Rehydrate state on each message so MV3 service worker restarts don't lose automation context
      await loadState();

      switch (message?.type) {
        case "CONTENT_READY": {
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

          const promptId = message.promptId ? String(message.promptId) : '';
          const senderTabId = sender?.tab?.id || null;
          const promptRef = resolveParallelPromptRef(promptId, senderTabId);
          if (!promptRef) {
            console.log('[PromptSubmitted][Parallel] Unknown prompt mapping, ignoring', { promptId, senderTabId });
            return;
          }

          const worker = state.parallel.workersById?.[promptRef.workerId];
          if (!worker || worker.status === 'completed' || worker.status === 'failed') {
            settleParallelSubmission(promptId, { ignored: true });
            return;
          }

          const resolvedPromptIndex = Number.isFinite(promptRef.promptIndex)
            ? Number(promptRef.promptIndex)
            : Math.max(0, Number(worker.nextPromptIndex || 0));

          if (worker.inFlightPromptId === promptId) {
            worker.inFlightPromptId = null;
          }
          delete state.parallel.workersByPromptId[promptId];
          worker.nextPromptIndex = Math.max(worker.nextPromptIndex || 0, resolvedPromptIndex + 1);
          worker.status = 'running';
          worker.nextRetryAt = 0;
          if (worker.promptRetryCounts && Number.isFinite(resolvedPromptIndex)) {
            delete worker.promptRetryCounts[resolvedPromptIndex];
          }
          worker.lastSubmission = {
            promptId,
            promptIndex: resolvedPromptIndex,
            at: Date.now(),
            reason: message.reason || null,
          };

          state.lastActivityTime = Date.now();
          await saveState();
          await emitParallelProgress();
          settleParallelSubmission(promptId, {
            workerId: worker.workerId,
            promptIndex: resolvedPromptIndex,
            reason: message.reason || null,
          });
          console.log('[PromptSubmitted][Parallel] Submission confirmed', {
            promptId,
            workerId: worker.workerId,
            promptIndex: resolvedPromptIndex,
            reason: message.reason || null,
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

          if (state.mode === 'parallel') {
            if (!state.running || !state.parallel) {
              console.log('[ResponseComplete][Parallel] Not running or no parallel state, ignoring');
              return;
            }
            const promptId = message.promptId ? String(message.promptId) : '';
            const senderTabId = sender?.tab?.id || null;
            const promptRef = resolveParallelPromptRef(promptId, senderTabId);
            if (!promptRef) return;

            const worker = state.parallel.workersById?.[promptRef.workerId];
            if (!worker || worker.status === 'completed' || worker.status === 'failed') return;

            const hasStopWord = message.stoppedByStopWord === true;
            if (hasStopWord) {
              await markParallelWorkerFailed(worker.workerId, 'Stopped by stop phrase');
              return;
            }

            if (message.error) {
              if (worker.inFlightPromptId === promptId) {
                rejectParallelSubmission(promptId, new Error(String(message.error)));
                worker.inFlightPromptId = null;
                delete state.parallel.workersByPromptId[promptId];
              }
              state.lastActivityTime = Date.now();
              await saveState();
              await emitParallelProgress();
              console.warn('[ResponseComplete][Parallel] Completion error observed after send attempt', {
                promptId,
                workerId: worker.workerId,
                error: message.error,
              });
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
