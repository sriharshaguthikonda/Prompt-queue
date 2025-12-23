// Console prefix patch - extracted for popup entry
export function applyConsolePatch(prefix = '[AI Prompt Queue]') {
  if (console.__aiPromptQueuePatched) return;
  console.__aiPromptQueuePatched = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
    const original = console[method]?.bind(console);
    if (original) {
      console[method] = (...args) => {
        const first = args[0];
        if (typeof first === 'string') {
          original(`${prefix} ${first}`, ...args.slice(1));
        } else {
          original(prefix, ...args);
        }
      };
    }
  });
}
