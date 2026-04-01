// Console prefix patch - extracted for popup entry
function getRoot() {
  return typeof globalThis !== 'undefined' ? globalThis : window;
}

export function applyConsolePatch(prefix = '[AI Prompt Queue]', initialDebugLoggingEnabled = false) {
  const root = getRoot();
  const setDebugEnabled = (enabled) => {
    root.__aiPromptQueueDebugLoggingEnabled = enabled === true;
  };

  if (console.__aiPromptQueuePatched) {
    setDebugEnabled(initialDebugLoggingEnabled);
    root.__aiPromptQueueSetDebugLogging = setDebugEnabled;
    return;
  }

  setDebugEnabled(initialDebugLoggingEnabled);
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
        original(`${prefix} ${first}`, ...args.slice(1));
      } else {
        original(prefix, ...args);
      }
    };
  });
}

export function setDebugLoggingEnabled(enabled) {
  const root = getRoot();
  if (typeof root.__aiPromptQueueSetDebugLogging === 'function') {
    root.__aiPromptQueueSetDebugLogging(enabled === true);
    return;
  }
  root.__aiPromptQueueDebugLoggingEnabled = enabled === true;
}
