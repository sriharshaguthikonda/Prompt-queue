describe('popup tab context', () => {
  let mod;

  beforeAll(async () => {
    const path = require('path');
    mod = await global.loadEsmModule(path.join(__dirname, '..', 'popup-tab-context.js'));
  });

  it('tracks active tab changes and filters scoped automation messages', async () => {
    let activatedListener = null;
    const refreshStatus = jest.fn();
    const chromeApi = {
      tabs: {
        query: jest.fn(async () => [{ id: 11 }]),
        onActivated: {
          addListener: jest.fn((listener) => {
            activatedListener = listener;
          }),
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: { addListener: jest.fn() },
      },
    };
    const controller = mod.createTabContextController({ chromeApi, refreshStatus });

    await expect(controller.getContextTabId()).resolves.toBe(11);
    expect(controller.shouldHandleAutomationMessage({ type: 'AUTOMATION_PROGRESS', tabId: 11 })).toBe(true);
    expect(controller.shouldHandleAutomationMessage({ type: 'AUTOMATION_PROGRESS', tabId: 22 })).toBe(false);
    expect(controller.shouldHandleAutomationMessage({ type: 'PROMPT_STEP_STATUS' })).toBe(false);

    controller.bindActiveTabRefresh();
    activatedListener({ tabId: 22 });
    expect(controller.getCurrentPanelTabId()).toBe(22);
    expect(refreshStatus).toHaveBeenCalledTimes(1);

    expect(controller.shouldHandleAutomationMessage({ type: 'AUTOMATION_PROGRESS', status: { tabId: 22 } })).toBe(true);
    expect(controller.shouldHandleAutomationMessage({ type: 'AUTOMATION_PROGRESS', status: { tabId: 11 } })).toBe(false);
  });

  it('falls back when active tab is not in the current window query', async () => {
    const chromeApi = {
      tabs: {
        query: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 33 }]),
      },
    };
    const controller = mod.createTabContextController({ chromeApi });

    await expect(controller.getActiveTabId()).resolves.toBe(33);
    expect(chromeApi.tabs.query).toHaveBeenNthCalledWith(1, { active: true, currentWindow: true });
    expect(chromeApi.tabs.query).toHaveBeenNthCalledWith(2, { active: true, lastFocusedWindow: true });
  });
});
