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
  memory: {
    enabled: true,
    bridgeBaseUrl: 'http://127.0.0.1:5599',
    authMode: 'native_host',
    nativeHostName: 'com.prompt_queue.memory',
    storedToken: '',
    querySource: 'prompt_box',
    project: 'global',
    mode: 'smart',
    maxTokens: 800,
    topK: 8,
    minScore: 0.2,
    pinnedPolicy: 'relevant_only',
    includeClasses: [],
    excludeClasses: [],
    insertBehavior: 'prepend_or_replace_managed_block',
    debug: false,
  },
};

const MEMORY_CLASSES = [
  'beliefs_preferences',
  'world_facts',
  'entity_observations',
  'agent_experiences',
  'reflections',
];

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
  const memoryInput = input.memory || {};
  const defaultMemory = DEFAULT_SETTINGS.memory;
  const authMode = memoryInput.authMode === 'stored_token' ? 'stored_token' : 'native_host';
  const pinnedPolicy = ['core_only', 'relevant_only', 'all', 'none'].includes(memoryInput.pinnedPolicy)
    ? memoryInput.pinnedPolicy
    : defaultMemory.pinnedPolicy;
  const mode = ['smart', 'compact_hits', 'full_pack', 'debug'].includes(memoryInput.mode)
    ? memoryInput.mode
    : defaultMemory.mode;
  const querySource = ['prompt_box', 'selection', 'clipboard', 'page', 'manual', 'combined'].includes(memoryInput.querySource)
    ? memoryInput.querySource
    : defaultMemory.querySource;
  const insertBehavior = ['prepend_or_replace_managed_block', 'append', 'replace_selected_text', 'copy_only'].includes(memoryInput.insertBehavior)
    ? memoryInput.insertBehavior
    : defaultMemory.insertBehavior;
  const includeClasses = Array.isArray(memoryInput.includeClasses)
    ? memoryInput.includeClasses.filter((c) => MEMORY_CLASSES.includes(c))
    : [];
  const excludeClasses = Array.isArray(memoryInput.excludeClasses)
    ? memoryInput.excludeClasses.filter((c) => MEMORY_CLASSES.includes(c))
    : [];
  return {
    stableMs: coerceNumber(input.stableMs, 100, 60000, DEFAULT_SETTINGS.stableMs),
    maxWaitMs: coerceNumber(input.maxWaitMs, 5000, 600000, DEFAULT_SETTINGS.maxWaitMs),
    pollIntervalMs: coerceNumber(input.pollIntervalMs, 50, 5000, DEFAULT_SETTINGS.pollIntervalMs),
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : DEFAULT_SETTINGS.systemPrompt,
    prependSystemPrompt: input.prependSystemPrompt !== false,
    theme: input.theme === 'light' ? 'light' : 'dark',
    memory: {
      enabled: memoryInput.enabled !== false,
      bridgeBaseUrl: typeof memoryInput.bridgeBaseUrl === 'string' && memoryInput.bridgeBaseUrl.trim()
        ? memoryInput.bridgeBaseUrl.replace(/\/+$/, '')
        : defaultMemory.bridgeBaseUrl,
      authMode,
      nativeHostName: typeof memoryInput.nativeHostName === 'string' && memoryInput.nativeHostName.trim()
        ? memoryInput.nativeHostName.trim()
        : defaultMemory.nativeHostName,
      storedToken: typeof memoryInput.storedToken === 'string' ? memoryInput.storedToken.trim() : '',
      querySource,
      project: typeof memoryInput.project === 'string' && memoryInput.project.trim() ? memoryInput.project.trim() : defaultMemory.project,
      mode,
      maxTokens: coerceNumber(memoryInput.maxTokens, 300, 3000, defaultMemory.maxTokens),
      topK: coerceNumber(memoryInput.topK, 3, 20, defaultMemory.topK),
      minScore: coerceNumber(memoryInput.minScore, 0, 1, defaultMemory.minScore),
      pinnedPolicy,
      includeClasses,
      excludeClasses,
      insertBehavior,
      debug: memoryInput.debug === true,
    },
  };
}

function publicSettings(settings) {
  const safe = JSON.parse(JSON.stringify(settings || state.options));
  if (safe.memory) {
    safe.memory.hasStoredToken = Boolean(safe.memory.storedToken);
    safe.memory.storedToken = '';
  }
  return safe;
}

function sanitizeSettingsForHistory(settings) {
  const safe = JSON.parse(JSON.stringify(settings || {}));
  if (safe.memory) {
    safe.memory.storedToken = safe.memory.storedToken ? '<stored>' : '';
  }
  return safe;
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
  const local = await chrome.storage.local.get('aiTaskSequencerSettings');
  let stored = local.aiTaskSequencerSettings;
  if (!stored) {
    const sync = await chrome.storage.sync.get('aiTaskSequencerSettings');
    if (sync.aiTaskSequencerSettings) {
      stored = sync.aiTaskSequencerSettings;
      await chrome.storage.local.set({ aiTaskSequencerSettings: stored });
    }
  }
  const merged = validateSettings({ ...DEFAULT_SETTINGS, ...(stored || {}) });
  state.options = merged;
}

async function saveSettings(newSettings) {
  const currentMemory = state.options.memory || DEFAULT_SETTINGS.memory;
  const incomingMemory = newSettings?.memory || {};
  const memory = {
    ...currentMemory,
    ...incomingMemory,
  };
  if (!Object.prototype.hasOwnProperty.call(incomingMemory, 'storedToken')) {
    memory.storedToken = currentMemory.storedToken || '';
  }
  const merged = validateSettings({ ...state.options, ...newSettings, memory });
  state.options = merged;
  await chrome.storage.local.set({ aiTaskSequencerSettings: merged });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.aiTaskSequencerSettings) {
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

async function sendToContentForResponse(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab?.url)) {
    throw new Error('Active tab not supported. Open ChatGPT/Gemini/Grok/Claude and try again.');
  }
  await injectContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
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

async function callNativeMemory(operation, payload) {
  return chrome.runtime.sendNativeMessage(
    state.options.memory.nativeHostName,
    { operation, payload },
  );
}

async function callDirectBridge(path, options = {}) {
  const memory = state.options.memory || DEFAULT_SETTINGS.memory;
  if (!memory.storedToken) {
    throw new Error('Memory token missing. Set stored-token fallback or install native host.');
  }
  const headers = {
    ...(options.headers || {}),
    'X-Memory-Token': memory.storedToken,
  };
  const response = await fetch(`${memory.bridgeBaseUrl}${path}`, { ...options, headers });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body?.detail?.error || body?.error || JSON.stringify(body);
    } catch (_) {}
    throw new Error(`Memory bridge ${response.status}: ${detail}`);
  }
  return response;
}

async function callMemoryPack(body) {
  await loadSettings();
  const memory = state.options.memory || DEFAULT_SETTINGS.memory;
  if (memory.authMode === 'native_host') {
    try {
      const nativeResult = await callNativeMemory('pack_browser', body);
      if (nativeResult?.ok) return nativeResult.result;
      if (!memory.storedToken) {
        throw new Error(nativeResult?.error || 'Native host unavailable');
      }
    } catch (err) {
      if (!memory.storedToken) throw err;
    }
  }
  const response = await callDirectBridge('/pack/browser', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function memoryHealthCheck() {
  await loadSettings();
  const memory = state.options.memory || DEFAULT_SETTINGS.memory;
  let health = null;
  try {
    const response = await fetch(`${memory.bridgeBaseUrl}/healthz`);
    health = await response.json();
  } catch (err) {
    return { ok: false, error: `Health check failed: ${String(err)}` };
  }
  let projects = [];
  if (memory.storedToken) {
    try {
      const response = await callDirectBridge('/memory/projects');
      const data = await response.json();
      projects = data.projects || [];
    } catch (_) {}
  }
  return { ok: true, health, projects };
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
          const safeHistoryItem = {
            ...historyItem,
            settings: sanitizeSettingsForHistory(historyItem.settings),
          };
          const sig = makeHistorySignature(safeHistoryItem);
          const exists = aiTaskSequencerHistory.some((h) => h.__sig === sig);
          if (!exists) {
            aiTaskSequencerHistory.unshift({ ...safeHistoryItem, savedAt: Date.now(), __sig: sig });
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
        sendResponse({ ok: true, settings: publicSettings(state.options) });
        return;
      }
      case "GET_SETTINGS": {
        await loadSettings();
        sendResponse({ ok: true, settings: publicSettings(state.options) });
        return;
      }
      case "GET_MEMORY_SOURCE": {
        try {
          const result = await sendToContentForResponse(message.tabId, {
            type: 'GET_MEMORY_SOURCE',
            source: message.source,
          });
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      case "PREVIEW_MEMORY_PACK": {
        try {
          const result = await callMemoryPack(message.body || {});
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      case "INSERT_MEMORY_PACK": {
        try {
          const result = await sendToContentForResponse(message.tabId, {
            type: 'INSERT_MEMORY_PACK',
            markdown: message.markdown,
            behavior: message.behavior,
          });
          sendResponse({ ok: true, result });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }
      case "MEMORY_HEALTH_CHECK": {
        const result = await memoryHealthCheck();
        sendResponse(result);
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
