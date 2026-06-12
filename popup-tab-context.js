export function getMessageTabId(message = {}) {
  const directTabId = Number(message?.tabId);
  if (Number.isInteger(directTabId)) return directTabId;

  const statusTabId = Number(message?.status?.tabId);
  if (Number.isInteger(statusTabId)) return statusTabId;

  return null;
}

export function createTabContextController({ chromeApi = globalThis.chrome, refreshStatus, refreshDelayMs = 0 } = {}) {
  let currentPanelTabId = null;
  let refreshTimer = null;

  async function queryActiveTab(query) {
    if (!chromeApi?.tabs?.query) return null;
    const tabs = await chromeApi.tabs.query(query);
    const tabId = Number(tabs?.[0]?.id);
    return Number.isInteger(tabId) ? tabId : null;
  }

  async function getActiveTabId() {
    return (
      await queryActiveTab({ active: true, currentWindow: true })
      ?? await queryActiveTab({ active: true, lastFocusedWindow: true })
      ?? await queryActiveTab({ active: true })
    );
  }

  function setCurrentPanelTabId(tabId) {
    const numericTabId = Number(tabId);
    if (Number.isInteger(numericTabId)) {
      currentPanelTabId = numericTabId;
    }
    return currentPanelTabId;
  }

  async function getContextTabId() {
    return setCurrentPanelTabId(await getActiveTabId());
  }

  function getCurrentPanelTabId() {
    return currentPanelTabId;
  }

  function shouldHandleAutomationMessage(message = {}) {
    const messageTabId = getMessageTabId(message);
    if (!Number.isInteger(messageTabId)) return false;
    if (!Number.isInteger(currentPanelTabId)) return true;
    return messageTabId === currentPanelTabId;
  }

  function shouldCloseForMessage(message = {}) {
    const messageTabId = Number(message?.tabId);
    if (!Number.isInteger(messageTabId)) return true;
    if (!Number.isInteger(currentPanelTabId)) return true;
    return messageTabId === currentPanelTabId;
  }

  function scheduleRefresh() {
    if (typeof refreshStatus !== 'function') return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max(0, Number(refreshDelayMs) || 0);
    if (delay <= 0) {
      refreshStatus();
      return;
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshStatus();
    }, delay);
  }

  function bindActiveTabRefresh() {
    chromeApi?.tabs?.onActivated?.addListener?.((activeInfo = {}) => {
      setCurrentPanelTabId(activeInfo.tabId);
      scheduleRefresh();
    });

    chromeApi?.windows?.onFocusChanged?.addListener?.((windowId) => {
      if (windowId === chromeApi.windows.WINDOW_ID_NONE) return;
      getContextTabId().then(() => scheduleRefresh()).catch(() => {});
    });
  }

  return {
    bindActiveTabRefresh,
    getActiveTabId,
    getContextTabId,
    getCurrentPanelTabId,
    setCurrentPanelTabId,
    shouldCloseForMessage,
    shouldHandleAutomationMessage,
  };
}
