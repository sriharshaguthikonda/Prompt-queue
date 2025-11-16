async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

function parsePrompts(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function setStatus(text) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = text;
}

function setProgress(current, total) {
  const bar = document.getElementById('progressBar');
  if (!bar || !total) return;
  const pct = Math.min(100, Math.max(0, Math.round(((current) / total) * 100)));
  bar.style.width = `${pct}%`;
}

function secToMs(v) { return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v * 1000) : undefined; }
function msToSec(v) { return typeof v === 'number' && !Number.isNaN(v) ? (v / 1000) : ''; }

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (res?.ok && res.status) {
      const { running, currentIndex, total, recoveryAttempts } = res.status;
      setProgress(running ? currentIndex : total, total);
      if (running) {
        // Show recovery status if attempting recovery
        if (recoveryAttempts > 0) {
          setStatus(`Recovering... (attempt ${recoveryAttempts}/3) - Prompt ${currentIndex + 1} of ${total}`);
        } else {
          setStatus(`Running prompt ${currentIndex + 1} of ${total}...`);
        }
      } else if (total > 0 && currentIndex >= total) {
        setStatus('Complete');
      } else {
        setStatus('Idle');
      }
    }
  } catch (e) {
    console.error('[RefreshStatus] Error:', e);
  }
}

function applyTheme(theme) {
  const body = document.body;
  body.classList.remove('theme-dark', 'theme-light');
  body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme === 'light' ? 'light' : 'dark';
}

async function loadSettingsIntoUI() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.ok && res.settings) {
      const s = res.settings;
      applyTheme(s.theme || 'dark');
      document.getElementById('maxWaitSec').value = msToSec(s.maxWaitMs);
      document.getElementById('stableSec').value = msToSec(s.stableMs);
      document.getElementById('pollSec').value = msToSec(s.pollIntervalMs);
      document.getElementById('systemPrompt').value = s.systemPrompt || '';
      document.getElementById('prependSystemPrompt').checked = s.prependSystemPrompt !== false;
      document.getElementById('enableMaxWaitTimeout').checked = s.enableMaxWaitTimeout !== false;
    }
  } catch (e) {
    console.error('[LoadSettings] Error:', e);
  }
}

async function saveSettingsFromUI() {
  try {
    const maxWaitSec = Number(document.getElementById('maxWaitSec').value);
    const stableSec = Number(document.getElementById('stableSec').value);
    const pollSec = Number(document.getElementById('pollSec').value);
    const settings = {
      maxWaitMs: secToMs(maxWaitSec),
      stableMs: secToMs(stableSec),
      pollIntervalMs: secToMs(pollSec),
      systemPrompt: document.getElementById('systemPrompt').value || '',
      prependSystemPrompt: document.getElementById('prependSystemPrompt').checked,
      enableMaxWaitTimeout: document.getElementById('enableMaxWaitTimeout').checked,
    };
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  } catch (e) {
    console.error('[SaveSettings] Error:', e);
  }
}

document.getElementById('themeSelect').addEventListener('change', async (e) => {
  const val = e.target.value;
  applyTheme(val);
  try {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { theme: val } });
  } catch (e) {
    console.error('[ThemeChange] Error:', e);
  }
});

['maxWaitSec','stableSec','pollSec','systemPrompt','prependSystemPrompt','enableMaxWaitTimeout'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveSettingsFromUI);
});

document.getElementById('startBtn').addEventListener('click', async () => {
  try {
    const textarea = document.getElementById('prompts');
    const prompts = parsePrompts(textarea.value);
    if (prompts.length === 0) {
      setStatus('Please enter at least one prompt.');
      return;
    }
    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus('No active tab found.');
      return;
    }
    setStatus('Starting...');
    const res = await chrome.runtime.sendMessage({ type: 'START_AUTOMATION', prompts, tabId });
    if (res?.ok) {
      setStatus(`Running prompt 1 of ${prompts.length}...`);
      setProgress(0, prompts.length);
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({ type: 'SAVE_PROMPT_HISTORY', item: { prompts, settings: settings?.settings } });
    } else {
      setStatus(`Failed to start: ${res?.error || 'Unknown error'}`);
    }
  } catch (e) {
    console.error('[StartBtn] Error:', e);
    setStatus(`Failed to start: ${e}`);
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION' });
    setStatus('Stopped');
    // Refresh to clear any recovery status
    await refreshStatus();
  } catch (e) {
    console.error('[StopBtn] Error:', e);
    setStatus('Stop failed');
  }
});

// Save current prompts to history
const saveHistoryBtn = document.getElementById('saveHistoryBtn');
if (saveHistoryBtn) {
  saveHistoryBtn.addEventListener('click', async () => {
    try {
      const textarea = document.getElementById('prompts');
      const prompts = parsePrompts(textarea.value);
      if (prompts.length === 0) {
        setStatus('No prompts to save.');
        return;
      }
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({ 
        type: 'SAVE_PROMPT_HISTORY', 
        item: { prompts, settings: settings?.settings } 
      });
      // Immediately refresh the history list
      await loadHistoryIntoUI();
      setStatus('Saved to history');
      // Clear status after 2 seconds
      setTimeout(() => setStatus('Idle'), 2000);
    } catch (e) {
      console.error('[SaveHistoryBtn] Error:', e);
      setStatus('Failed to save history');
    }
  });
}

// Add reload history button listener
const reloadHistoryBtn = document.getElementById('reloadHistoryBtn');
if (reloadHistoryBtn) {
  reloadHistoryBtn.addEventListener('click', async () => {
    try {
      await loadHistoryIntoUI();
      setStatus('History reloaded');
      setTimeout(() => setStatus('Idle'), 1500);
    } catch (e) {
      console.error('[ReloadHistoryBtn] Error:', e);
      setStatus('Failed to reload history');
    }
  });
}

// Export history as JSON
const exportBtn = document.getElementById('exportBtn');
if (exportBtn) {
  exportBtn.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
      if (res?.ok && res.history) {
        const exportData = {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          history: res.history
        };
        const jsonString = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `prompt-queue-export-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus('Exported successfully');
        setTimeout(() => setStatus('Idle'), 2000);
      }
    } catch (e) {
      console.error('[ExportBtn] Error:', e);
      setStatus('Export failed');
    }
  });
}

// Import history from JSON
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
if (importBtn && importFile) {
  importBtn.addEventListener('click', () => {
    importFile.click();
  });
  
  importFile.addEventListener('change', async (event) => {
    try {
      const file = event.target.files?.[0];
      if (!file) return;
      
      const text = await file.text();
      const importData = JSON.parse(text);
      
      if (!importData.history || !Array.isArray(importData.history)) {
        setStatus('Invalid JSON format');
        return;
      }
      
      // Get existing history
      const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
      const existingHistory = res?.history || [];
      
      // Merge imported with existing (imported first)
      const mergedHistory = [...importData.history, ...existingHistory].slice(0, 50);
      
      // Save merged history
      await chrome.storage.local.set({ aiTaskSequencerHistory: mergedHistory });
      
      // Reload UI
      await loadHistoryIntoUI();
      setStatus(`Imported ${importData.history.length} items`);
      setTimeout(() => setStatus('Idle'), 2000);
    } catch (e) {
      console.error('[ImportFile] Error:', e);
      setStatus('Import failed: ' + e.message);
    }
    
    // Reset file input
    importFile.value = '';
  });
}

function createHistoryRow(item, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'history-item';
  const title = item.title || (item.prompts?.slice(0, 1)?.[0] || '').slice(0, 80);
  const date = new Date(item.savedAt || Date.now()).toLocaleString();

  const row = document.createElement('div');
  row.className = 'history-row';

  const left = document.createElement('div');
  left.style.flex = '1';
  left.style.whiteSpace = 'nowrap';
  left.style.overflow = 'hidden';
  left.style.textOverflow = 'ellipsis';
  left.textContent = `${date}: ${title}`;
  left.title = (item.prompts || []).join('\n');

  const ctrls = document.createElement('div');
  ctrls.className = 'mini-controls';

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load';
  loadBtn.addEventListener('click', async () => {
    document.getElementById('prompts').value = (item.prompts || []).join('\n');
    if (item.settings) {
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: item.settings });
      await loadSettingsIntoUI();
    }
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DELETE_PROMPT_HISTORY', index });
    await loadHistoryIntoUI();
  });

  ctrls.appendChild(loadBtn);
  ctrls.appendChild(delBtn);

  row.appendChild(left);
  row.appendChild(ctrls);
  wrapper.appendChild(row);
  return wrapper;
}

async function loadHistoryIntoUI() {
  try {
    const list = document.getElementById('history');
    if (!list) {
      console.error('[LoadHistory] History list element not found');
      return;
    }
    list.innerHTML = '';
    const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
    if (res?.ok) {
      (res.history || []).forEach((item, idx) => {
        list.appendChild(createHistoryRow(item, idx));
      });
    }
  } catch (e) {
    console.error('[LoadHistory] Error:', e);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'AUTOMATION_PROGRESS' && message.status) {
    const { currentIndex, total, recoveryAttempts } = message.status;
    lastActivityTime = Date.now();
    // Show recovery status if attempting recovery
    if (recoveryAttempts > 0) {
      setStatus(`Recovering... (attempt ${recoveryAttempts}/3) - Prompt ${currentIndex + 1} of ${total}`);
    } else {
      setStatus(`Running prompt ${currentIndex + 1} of ${total}...`);
    }
    setProgress(currentIndex, total);
  } else if (message?.type === 'AUTOMATION_COMPLETE') {
    setStatus('Complete');
    setProgress(1, 1);
    stopCountdownTimer();
  } else if (message?.type === 'AUTOMATION_ERROR') {
    setStatus(`Error: ${message.error}`);
    stopCountdownTimer();
    // Refresh status after error to show proper state
    setTimeout(refreshStatus, 1000);
  }
});

// Use AbortController for auto-refresh instead of setInterval
let refreshAbortController = null;
let countdownAbortController = null;
let lastActivityTime = Date.now();

function startCountdownTimer() {
  if (countdownAbortController) return;
  countdownAbortController = new AbortController();
  const signal = countdownAbortController.signal;

  const doCountdown = async () => {
    if (signal.aborted) return;
    
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
      if (res?.ok && res.status?.running) {
        const stableSecInput = document.getElementById('stableSec');
        const stableMs = secToMs(Number(stableSecInput.value)) || 1200;
        const countdownEl = document.getElementById('stableCountdown');
        const countdownValue = document.getElementById('countdownValue');
        
        // Show countdown
        countdownEl.style.display = 'block';
        
        // Simulate countdown (updates every 100ms)
        const elapsed = Date.now() - lastActivityTime;
        const remaining = Math.max(0, stableMs - elapsed);
        const remainingSec = (remaining / 1000).toFixed(1);
        countdownValue.textContent = remainingSec;
      } else {
        // Hide countdown when not running
        const countdownEl = document.getElementById('stableCountdown');
        countdownEl.style.display = 'none';
      }
    } catch (e) {
      console.error('[Countdown] Error:', e);
    }
    
    if (!signal.aborted) {
      setTimeout(doCountdown, 100);
    }
  };
  doCountdown();
}

function stopCountdownTimer() {
  if (countdownAbortController) {
    countdownAbortController.abort();
    countdownAbortController = null;
  }
}

function startAutoRefresh() {
  if (refreshAbortController) return; // Already running
  refreshAbortController = new AbortController();
  const signal = refreshAbortController.signal;

  const doRefresh = async () => {
    if (signal.aborted) return;
    await refreshStatus();
    if (!signal.aborted) {
      setTimeout(doRefresh, 2000);
    }
  };
  doRefresh();
}

function stopAutoRefresh() {
  if (refreshAbortController) {
    refreshAbortController.abort();
    refreshAbortController = null;
  }
}

// Start auto-refresh when popup opens
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSettingsIntoUI();
    await loadHistoryIntoUI();
    await refreshStatus();
    startAutoRefresh();
    startCountdownTimer();
  } catch (e) {
    console.error('[DOMContentLoaded] Error:', e);
  }
});

// Stop auto-refresh when popup closes
window.addEventListener('unload', () => {
  stopAutoRefresh();
  stopCountdownTimer();
});

(async function init() {
  await loadSettingsIntoUI();
  await loadHistoryIntoUI();
  await refreshStatus();
})();