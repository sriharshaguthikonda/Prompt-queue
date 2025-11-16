/**
 * Jest Setup File
 * Global test configuration and mocks
 */

// Mock Chrome API
global.chrome = {
  runtime: {
    sendMessage: jest.fn((message, callback) => {
      if (callback) {
        callback({ ok: true });
      }
      return Promise.resolve({ ok: true });
    }),
    onMessage: {
      addListener: jest.fn(),
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
