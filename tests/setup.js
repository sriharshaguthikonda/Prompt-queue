/**
 * Jest Setup File
 * Global test configuration and mocks
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fileURLToPath, pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const runtimeListeners = [];

function resetRuntimeListeners() {
  runtimeListeners.length = global.__runtimeListenerBaseline || 0;
}

// Mock Chrome API
global.chrome = {
  runtime: {
    sendMessage: jest.fn((message, callback) => {
      let lastResponse = { ok: true };
      let responded = false;
      for (const listener of runtimeListeners) {
        const sendResponse = (response) => {
          responded = true;
          lastResponse = response;
          if (callback) callback(response);
        };
        listener(message, {}, sendResponse);
      }
      if (!responded && callback) callback(lastResponse);
      return Promise.resolve(lastResponse);
    }),
    onMessage: {
      addListener: jest.fn((listener) => {
        runtimeListeners.push(listener);
      }),
    },
    onStartup: { addListener: jest.fn() },
    onInstalled: { addListener: jest.fn() },
    sendNativeMessage: jest.fn(async () => ({ ok: true })),
    getURL: jest.fn((value) => value),
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
    },
    sync: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
    },
    onChanged: { addListener: jest.fn() },
  },
  tabs: {
    query: jest.fn((query, callback) => {
      const result = [{ id: 1, url: 'https://chat.openai.com' }];
      if (callback) callback(result);
      return Promise.resolve(result);
    }),
    get: jest.fn(async (tabId) => ({ id: tabId, url: 'https://chat.openai.com' })),
    sendMessage: jest.fn((tabId, message, callback) => {
      let response = { ok: true };
      for (const listener of runtimeListeners) {
        const maybeAsync = listener(message, { tab: { id: tabId, url: 'https://chat.openai.com' } }, (nextResponse) => {
          response = nextResponse;
          if (callback) callback(nextResponse);
        });
        if (maybeAsync === true) {
          return true;
        }
      }
      if (callback) callback(response);
      return Promise.resolve(response);
    }),
    update: jest.fn(async (tabId, updateProps) => ({ id: tabId, url: updateProps?.url || 'https://chat.openai.com' })),
    reload: jest.fn(async () => {}),
    create: jest.fn(async () => ({ id: 2, url: 'https://chat.openai.com' })),
    remove: jest.fn(async () => {}),
    onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
    onRemoved: { addListener: jest.fn() },
  },
  action: {
    openPopup: jest.fn(),
    onClicked: { addListener: jest.fn() },
    setBadgeText: jest.fn(),
    setBadgeBackgroundColor: jest.fn(),
  },
  sidePanel: {
    open: jest.fn(async () => {}),
  },
  scripting: {
    executeScript: jest.fn(async () => []),
  },
  notifications: {
    create: jest.fn(),
  },
};

global.self = global;
global.importScripts = jest.fn();
global.fetch = jest.fn(async () => ({ ok: true, text: async () => '{}', status: 200, statusText: 'OK' }));
global.__runtimeListenerBaseline = 0;
global.__resetRuntimeListeners = resetRuntimeListeners;
global.__setRuntimeListenerBaseline = () => {
  global.__runtimeListenerBaseline = runtimeListeners.length;
};
global.BackgroundParallelUtils = {
  PARALLEL_CONFIG: {},
  buildParallelPromptId: jest.fn(() => 'parallel-prompt-id'),
  buildParallelWorkerId: jest.fn(() => 'parallel-worker-id'),
  resolveParallelLaunchUrl: jest.fn(() => 'https://chat.openai.com'),
  shouldUseParallelMode: jest.fn(() => false),
  resolveParallelPromptGroups: jest.fn(() => []),
};
global.PromptQueueConstants = { STORAGE_KEYS: {}, LIMITS: {}, MESSAGE_TYPES: {} };
global.InputEvent = window.InputEvent || Event;
global.KeyboardEvent = window.KeyboardEvent;
global.Blob = window.Blob;
global.URL = window.URL;
global.navigator = window.navigator;

// Mock window.location
delete window.location;
window.location = { href: 'https://chat.openai.com' };

// Mock console methods to reduce noise
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Extend Jest matchers
expect.extend({
  toBePending(received) {
    const isPending = received instanceof Promise && 
      received.then && 
      !received._settled;
    
    return {
      pass: isPending,
      message: () => `expected promise to be pending`,
    };
  },
});

// Setup DOM
beforeEach(() => {
  document.body.innerHTML = '';
  jest.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
  jest.clearAllTimers();
  global.__resetRuntimeListeners?.();
});

const esmContext = vm.createContext({
  Blob: window.Blob,
  console,
  document,
  Event: window.Event,
  InputEvent: window.InputEvent || window.Event,
  KeyboardEvent: window.KeyboardEvent,
  navigator: window.navigator,
  setTimeout,
  clearTimeout,
  URL: window.URL,
  window,
});

async function loadEsmModule(filename, cache = new Map()) {
  const resolved = path.resolve(filename);
  if (cache.has(resolved)) return cache.get(resolved).namespace;

  const source = fs.readFileSync(resolved, 'utf8');
  const module = new vm.SourceTextModule(source, {
    context: esmContext,
    identifier: pathToFileURL(resolved).href,
  });
  cache.set(resolved, module);
  await module.link(async (specifier, referencingModule) => {
    const childPath = fileURLToPath(new URL(specifier, referencingModule.identifier));
    await loadEsmModule(childPath, cache);
    return cache.get(path.resolve(childPath));
  });
  await module.evaluate();
  return module.namespace;
}

global.loadEsmModule = loadEsmModule;

beforeAll(async () => {
  const domUtils = await loadEsmModule(path.join(ROOT, 'popup-dom-utils.js'));
  Object.assign(global, {
    parsePrompts: domUtils.parsePrompts,
    secToMs: domUtils.secToMs,
    msToSec: domUtils.msToSec,
    showToast(message, type = 'info', duration = 3000) {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.className = `toast show ${type}`;
      setTimeout(() => toast.classList.remove('show'), duration);
    },
    setButtonsDisabled: domUtils.setButtonsDisabled,
    showHistoryLoading: domUtils.showHistoryLoading,
    setStatus: domUtils.setStatus,
    setProgress: domUtils.setProgress,
  });

  window.__PROMPT_QUEUE_TEST__ = true;
  require(path.join(ROOT, 'content-targets.js'));
  require(path.join(ROOT, 'content-input.js'));
  require(path.join(ROOT, 'content-status.js'));
  require(path.join(ROOT, 'content.js'));
  Object.assign(global, window.PromptQueueContentTest || {});
  global.__setRuntimeListenerBaseline();
});

document.addEventListener('input', (event) => {
  if (event.target?.id !== 'prompts') return;
  const counter = document.querySelector('.prompt-counter');
  if (!counter) return;
  const count = parsePrompts(event.target.value).length;
  counter.textContent = `${count} prompt${count !== 1 ? 's' : ''} loaded`;
}, true);
