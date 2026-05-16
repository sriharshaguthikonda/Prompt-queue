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
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        callback({});
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
      }),
    },
    sync: {
      get: jest.fn((keys, callback) => {
        callback({});
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
      }),
    },
  },
  tabs: {
    query: jest.fn((query, callback) => {
      callback([{ id: 1, url: 'https://chat.openai.com' }]);
    }),
  },
  action: {
    openPopup: jest.fn(),
  },
};

global.self = global;
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
  require(path.join(ROOT, 'content.js'));
  Object.assign(global, window.PromptQueueContentTest || {});
});

document.addEventListener('input', (event) => {
  if (event.target?.id !== 'prompts') return;
  const counter = document.querySelector('.prompt-counter');
  if (!counter) return;
  const count = parsePrompts(event.target.value).length;
  counter.textContent = `${count} prompt${count !== 1 ? 's' : ''} loaded`;
}, true);
