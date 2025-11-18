// Background service worker for AI Task Sequencer with sleep/wake support

const state = {
  prompts: [],
  currentIndex: 0,
  running: false,
  tabId: null,
  options: {
    stableMs: undefined,
    maxWaitMs: undefined,
    pollIntervalMs: undefined,
    systemPrompt: '',
    prependSystemPrompt: true,
    theme: 'dark',
  },
  lastActivityTime: Date.now(),
  recoveryAttempts: 0,
  processing: false,
};

const DEFAULT_SETTINGS = {
  stableMs: 1200,
  maxWaitMs: 180000,
  pollIntervalMs: 300,
  systemPrompt: '',
  prependSystemPrompt: true,
  theme: 'dark',
};

const RECOVERY_CONFIG = {
  maxRecoveryAttempts: 3,
  recoveryDelayMs: 2000,
  staleThresholdMs: 10000, // Consider stale if no activity for 10s
  healthCheckIntervalMs: 5000,
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
  return {
    stableMs: coerceNumber(input.stableMs, 100, 60000, DEFAULT_SETTINGS.stableMs),
    maxWaitMs: coerceNumber(input.maxWaitMs, 5000, 600000, DEFAULT_SETTINGS.maxWaitMs),
    pollIntervalMs: coerceNumber(input.pollIntervalMs, 50, 5000, DEFAULT_SETTINGS.pollIntervalMs),
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
    prependSystemPrompt: input.prependSystemPrompt !== false,
    theme: input.theme === 'light' ? 'light' : 'dark',
  };
}

function getStatus() {
  return {
    running: state.running,
    total: state.prompts.length,
    currentIndex: state.currentIndex,
    tabId: state.tabId,
    options: state.options,
    recoveryAttempts: state.recoveryAttempts,
  };
}

// ============ STATE PERSISTENCE ============

async function saveState() {
  const persistentState = {
    prompts: state.prompts,
    currentIndex: state.currentIndex,
    running: state.running,
    tabId: state.tabId,
    options: state.options,
    lastActivityTime: state.lastActivityTime,
    recoveryAttempts: state.recoveryAttempts,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ aiTaskSequencerState: persistentState });
}

async function loadState() {
  const { aiTaskSequencerState } = await chrome.storage.local.get('aiTaskSequencerState');
  if (aiTaskSequencerState) {
    state.prompts = aiTaskSequencerState.prompts || [];
    state.currentIndex = aiTaskSequencerState.currentIndex || 0;
    state.running = aiTaskSequencerState.running || false;
    state.tabId = aiTaskSequencerState.tabId || null;
    state.options = aiTaskSequencerState.options || state.options;
    state.lastActivityTime = aiTaskSequencerState.lastActivityTime || Date.now();
    state.recoveryAttempts = aiTaskSequencerState.recoveryAttempts || 0;
    return true;
  }
  return false;
}

async function clearState() {
  await chrome.storage.local.remove('aiTaskSequencerState');
  state.running = false;
  state.prompts = [];
  state.currentIndex = 0;
  state.tabId = null;
  state.recoveryAttempts = 0;
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
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
        } else {
          resolve(response?.ok === true);
        }
      });
      // Timeout after 2 seconds
      setTimeout(() => resolve(false), 2000);
    } catch {
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
  console.log('[Recovery] Attempting recovery...', {
    currentIndex: state.currentIndex,
    attempts: state.recoveryAttempts,
  });

  if (!state.running || !state.tabId) {
    console.log('[Recovery] Not running or no tab, clearing state');
    await clearState();
    return false;
  }

  if (state.recoveryAttempts >= RECOVERY_CONFIG.maxRecoveryAttempts) {
    console.log('[Recovery] Max attempts reached, stopping automation');
    state.running = false;
    await saveState();
    chrome.runtime.sendMessage({ 
      type: "AUTOMATION_ERROR", 
      error: "Failed to recover after sleep/wake. Please restart.", 
      status: getStatus() 
    }).catch(() => {});
    return false;
  }

  state.recoveryAttempts += 1;
  await saveState();

  // Check if tab is still alive
  const tabAlive = await isTabAlive(state.tabId);
  if (!tabAlive) {
    console.log('[Recovery] Tab no longer exists or not supported');
    state.running = false;
    await saveState();
    chrome.runtime.sendMessage({ 
      type: "AUTOMATION_ERROR", 
      error: "Tab was closed or navigated away. Automation stopped.", 
      status: getStatus() 
    }).catch(() => {});
    return false;
  }

  // Try to reconnect content script
  await new Promise(resolve => setTimeout(resolve, RECOVERY_CONFIG.recoveryDelayMs));
  const ready = await ensureContentScriptReady(state.tabId);
  
  if (!ready) {
    console.log('[Recovery] Could not establish connection to content script');
    // Will retry on next health check
    return false;
  }

  console.log('[Recovery] Connection restored, resuming automation');
  state.lastActivityTime = Date.now();
  await saveState();
  
  // Resume from current prompt
  await sendNextPrompt();
  return true;
}

async function healthCheck() {
  if (!state.running) return;

  const now = Date.now();
  const timeSinceActivity = now - state.lastActivityTime;

  // If we haven't seen activity in a while and we're supposed to be running, something is wrong
  if (timeSinceActivity > RECOVERY_CONFIG.staleThresholdMs) {
    console.log('[Health] Detected stale state, attempting recovery');
    await attemptRecovery();
  }
}

// Start periodic health checks
setInterval(healthCheck, RECOVERY_CONFIG.healthCheckIntervalMs);

// ============ SETTINGS ============

async function loadSettings() {
  const { aiTaskSequencerSettings } = await chrome.storage.sync.get('aiTaskSequencerSettings');
  const merged = validateSettings({ ...DEFAULT_SETTINGS, ...(aiTaskSequencerSettings || {}) });
  state.options = merged;
}

async function saveSettings(newSettings) {
  const merged = validateSettings({ ...state.options, ...newSettings });
  state.options = merged;
  await chrome.storage.sync.set({ aiTaskSequencerSettings: merged });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.aiTaskSequencerSettings) {
    const next = validateSettings({ ...state.options, ...(changes.aiTaskSequencerSettings.newValue || {}) });
    state.options = next;
  }
});

// ============ CONTENT SCRIPT INJECTION ============

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
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

async function sendToContent(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }
  
  const ready = await ensureContentScriptReady(tabId);
  if (!ready) {
    throw new Error('Could not establish connection to content script');
  }

  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      const lastErr = chrome.runtime.lastError;
    });
  } catch (err) {
    await injectContentScript(tabId);
    chrome.tabs.sendMessage(tabId, message, () => {
      const lastErr = chrome.runtime.lastError;
    });
  }
}

// ============ AUTOMATION LOGIC ============

async function startAutomation({ prompts, tabId, options }) {
  await loadSettings();
  if (options) {
    await saveSettings(options);
  }
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }

  state.prompts = prompts;
  state.currentIndex = 0;
  state.running = true;
  state.tabId = tabId;
  state.lastActivityTime = Date.now();
  state.recoveryAttempts = 0;

  await saveState();

  chrome.action.setBadgeText({ text: '' });
  chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() }).catch(() => {});

  await injectContentScript(tabId);
  await sendNextPrompt();
}

function buildMessageText(text) {
  const { systemPrompt, prependSystemPrompt } = state.options;
  if (systemPrompt && prependSystemPrompt) {
    return `${systemPrompt}\n\n${text}`;
  }
  return text;
}

async function sendNextPrompt() {
  if (!state.running) return;
  if (state.currentIndex >= state.prompts.length) {
    state.running = false;
    await clearState();
    chrome.runtime.sendMessage({ type: "AUTOMATION_COMPLETE", status: getStatus() }).catch(() => {});
    return;
  }

  const promptText = buildMessageText(state.prompts[state.currentIndex]);
  state.lastActivityTime = Date.now();
  await saveState();
  
  chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() }).catch(() => {});

  try {
    await sendToContent(state.tabId, { 
      type: "SEND_PROMPT", 
      text: promptText, 
      index: state.currentIndex, 
      total: state.prompts.length, 
      options: state.options 
    });
  } catch (err) {
    console.error("Error sending prompt to content:", err);
    // Don't immediately fail - let recovery logic handle it
    state.lastActivityTime = Date.now() - RECOVERY_CONFIG.staleThresholdMs - 1000;
    await saveState();
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
      prependSystemPrompt: item.settings?.prependSystemPrompt !== false,
    },
  };
  return JSON.stringify(normalized);
}

// ============ MESSAGE HANDLERS ============

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "START_AUTOMATION": {
        const prompts = Array.isArray(message.prompts) ? message.prompts.filter((p) => typeof p === "string" && p.trim().length > 0) : [];
        const tabId = message.tabId;
        const options = message.options || {};
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
        } catch (e) {
          sendResponse({ ok: false, error: 'Unable to read active tab.' });
          return;
        }
        sendResponse({ ok: true });
        try {
          await startAutomation({ prompts, tabId, options });
        } catch (e) {
          await clearState();
          chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: String(e), status: getStatus() }).catch(() => {});
        }
        return;
      }
      case "STOP_AUTOMATION": {
        state.running = false;
        await clearState();
        sendResponse({ ok: true });
        return;
      }
      case "AUTOMATION_STATUS_REQUEST": {
        await loadSettings();
        sendResponse({ ok: true, status: getStatus() });
        return;
      }
      case "RESPONSE_COMPLETE": {
        sendResponse({ ok: true });
        if (!state.running) {
          return;
        }
        // Prevent duplicate completions from processing
        if (state.processing) {
          console.log('[Response] Already processing, ignoring duplicate RESPONSE_COMPLETE');
          return;
        }
        state.processing = true;
        try {
          state.currentIndex += 1;
          state.lastActivityTime = Date.now();
          state.recoveryAttempts = 0; // Reset on successful completion
          await saveState();
          chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() }).catch(() => {});
          await sendNextPrompt();
        } finally {
          state.processing = false;
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
      default:
        return;
    }
  })();
  return true;
});

// ============ STARTUP & RECOVERY ============

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Startup] Service worker started');
  const restored = await loadState();
  if (restored && state.running) {
    console.log('[Startup] Found running automation, attempting recovery');
    state.lastActivityTime = Date.now() - RECOVERY_CONFIG.staleThresholdMs - 1000;
    await saveState();
    // Health check will pick it up
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Install] Extension installed/updated');
  await loadState();
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

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // No-op
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // No-op
});