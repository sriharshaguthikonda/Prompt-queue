// Background service worker for AI Task Sequencer

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
};

const DEFAULT_SETTINGS = {
  stableMs: 1200,
  maxWaitMs: 180000,
  pollIntervalMs: 300,
  systemPrompt: '',
  prependSystemPrompt: true,
  theme: 'dark',
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
  };
}

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
  await injectContentScript(tabId);
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
    chrome.runtime.sendMessage({ type: "AUTOMATION_COMPLETE", status: getStatus() }).catch(() => {});
    return;
  }

  const promptText = buildMessageText(state.prompts[state.currentIndex]);
  chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() }).catch(() => {});

  try {
    await sendToContent(state.tabId, { type: "SEND_PROMPT", text: promptText, index: state.currentIndex, total: state.prompts.length, options: state.options });
  } catch (err) {
    console.error("Error sending prompt to content:", err);
    state.running = false;
    chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: String(err), status: getStatus() }).catch(() => {});
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
        // respond early
        sendResponse({ ok: true });
        try {
          await startAutomation({ prompts, tabId, options });
        } catch (e) {
          state.running = false;
          chrome.runtime.sendMessage({ type: "AUTOMATION_ERROR", error: String(e), status: getStatus() }).catch(() => {});
        }
        return;
      }
      case "STOP_AUTOMATION": {
        state.running = false;
        sendResponse({ ok: true });
        return;
      }
      case "AUTOMATION_STATUS_REQUEST": {
        await loadSettings();
        sendResponse({ ok: true, status: getStatus() });
        return;
      }
      case "RESPONSE_COMPLETE": {
        // respond immediately
        sendResponse({ ok: true });
        if (!state.running) {
          return;
        }
        state.currentIndex += 1;
        chrome.runtime.sendMessage({ type: "AUTOMATION_PROGRESS", status: getStatus() }).catch(() => {});
        await sendNextPrompt();
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

// Notify on completion
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
    // Badge fallback
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
      chrome.action.setBadgeText({ text: 'DONE' });
    } catch (_) {}
  }
});

function setActionIconForTab(tabId) {
  // Rely on manifest action.default_icon; avoid dynamic setIcon to prevent fetch errors in some contexts
  return;
}

chrome.runtime.onInstalled.addListener(() => {
  // No-op: manifest icons will be used automatically
});

chrome.runtime.onStartup.addListener(() => {
  // No-op: manifest icons will be used automatically
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  // No-op
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // No-op
}); 