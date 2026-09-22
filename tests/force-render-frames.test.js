// S8.3b: hidden bridge job tabs never fire requestAnimationFrame, so chatgpt.com's lazy
// new-chat composer stub never mounts the real composer on its own. background.js forces
// render frames via discarded CDP screenshots while content.js's lazy-stub wait is pending.

describe('S8.3b background: force-render frame loop (chrome.debugger)', () => {
  let bg;

  beforeAll(() => {
    require('../background.js');
    global.__setRuntimeListenerBaseline?.();
    bg = global.PromptQueueBackgroundTest;
  });

  beforeEach(() => {
    chrome.debugger.attach.mockReset().mockImplementation(async () => {});
    chrome.debugger.detach.mockReset().mockImplementation(async () => {});
    chrome.debugger.sendCommand.mockReset().mockImplementation(async () => ({}));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('attaches, captures at least one discarded frame every 400ms, and detaches on STOP', async () => {
    jest.useFakeTimers();
    await bg.startForceRenderFrames(101);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 101 }, '1.3');

    await jest.advanceTimersByTimeAsync(400);
    expect(chrome.debugger.sendCommand.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 },
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 1 },
    );

    await bg.stopForceRenderFrames(101, 'stop');
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 101 });
    expect(bg.forceRenderLoopsForTest().has(101)).toBe(false);
  });

  test('tolerates an "already attached" error from chrome.debugger.attach and still runs', async () => {
    jest.useFakeTimers();
    chrome.debugger.attach.mockImplementationOnce(async () => {
      throw new Error('Cannot attach: already attached to this target');
    });

    await bg.startForceRenderFrames(202);
    expect(bg.forceRenderLoopsForTest().has(202)).toBe(true);

    await bg.stopForceRenderFrames(202, 'stop');
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 202 });
  });

  test('stops and detaches on its own after the 10s max', async () => {
    jest.useFakeTimers();
    await bg.startForceRenderFrames(303);

    await jest.advanceTimersByTimeAsync(10000);
    await Promise.resolve();

    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 303 });
    expect(bg.forceRenderLoopsForTest().has(303)).toBe(false);
  });

  test('never logs or stores captured screenshot data', async () => {
    // background.js wraps console.log with a debug-gated prefixer (patched once at module
    // load), so spy above that wrapper to see every call regardless of the debug flag.
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.useFakeTimers();
    const secretPayload = 'BASE64_JPEG_SHOULD_NEVER_BE_LOGGED';
    chrome.debugger.sendCommand.mockImplementation(async () => ({ data: secretPayload }));

    await bg.startForceRenderFrames(404);
    await jest.advanceTimersByTimeAsync(800);
    await bg.stopForceRenderFrames(404, 'stop');

    const loggedText = logSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(loggedText).not.toContain(secretPayload);
    logSpy.mockRestore();
  });
});

describe('S8.3b content: force-render messaging around the lazy stub wait', () => {
  function setVisibility(value) {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
  }

  afterEach(() => {
    setVisibility('visible');
  });

  test('hidden tab with an activated stub sends FORCE_RENDER then STOP once the composer is ready', async () => {
    setVisibility('hidden');
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox" style="display:none"></div>';
    const hiddenComposer = document.getElementById('prompt-textarea');
    hiddenComposer.getBoundingClientRect = jest.fn(() => ({ width: 0, height: 0 }));

    const readyPromise = waitForComposerReadyWithForceRender(true, {
      site: 'chatgpt',
      maxWaitMs: 1000,
      stableWindowMs: 50,
      pollMs: 10,
    });

    const visibleComposer = document.createElement('div');
    visibleComposer.id = 'prompt-textarea';
    visibleComposer.setAttribute('contenteditable', 'plaintext-only');
    visibleComposer.setAttribute('role', 'textbox');
    visibleComposer.getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));

    setTimeout(() => {
      hiddenComposer.remove();
      document.body.appendChild(visibleComposer);
    }, 10);

    await expect(readyPromise).resolves.toBe(visibleComposer);

    const types = chrome.runtime.sendMessage.mock.calls.map(([message]) => message?.type);
    const framesIndex = types.indexOf('PQ_FORCE_RENDER_FRAMES');
    const stopIndex = types.indexOf('PQ_FORCE_RENDER_STOP');
    expect(framesIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(framesIndex);
  });

  test('hidden tab without an activated stub sends no force-render messages', async () => {
    setVisibility('hidden');
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>';
    document.getElementById('prompt-textarea').getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));

    await waitForComposerReadyWithForceRender(false, {
      site: 'chatgpt',
      maxWaitMs: 500,
      stableWindowMs: 20,
      pollMs: 10,
    });

    const types = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message?.type)
      .filter((type) => type === 'PQ_FORCE_RENDER_FRAMES' || type === 'PQ_FORCE_RENDER_STOP');
    expect(types).toEqual([]);
  });

  test('visible tab sends no force-render messages even when the stub was activated', async () => {
    setVisibility('visible');
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>';
    document.getElementById('prompt-textarea').getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));

    await waitForComposerReadyWithForceRender(true, {
      site: 'chatgpt',
      maxWaitMs: 500,
      stableWindowMs: 20,
      pollMs: 10,
    });

    const types = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message?.type)
      .filter((type) => type === 'PQ_FORCE_RENDER_FRAMES' || type === 'PQ_FORCE_RENDER_STOP');
    expect(types).toEqual([]);
  });
});
