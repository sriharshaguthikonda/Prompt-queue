
// Console prefix patch - runs in popup context
// NOTE: This patch exists in all 3 JS files because Chrome extensions have separate
// JavaScript contexts (service worker, popup, page). Each context needs its own patch.
(function () {
  if (console.__aiPromptQueuePatched) return;
  const PREFIX = '[AI Prompt Queue]';
  console.__aiPromptQueuePatched = true;
  ['log', 'info', 'warn', 'error', 'debug'].forEach((method) => {
    const original = console[method]?.bind(console);
    if (original) {
      console[method] = (...args) => {
        const first = args[0];
        if (typeof first === 'string') {
          original(`${PREFIX} ${first}`, ...args.slice(1));
        } else {
          original(PREFIX, ...args);
        }
      };
    }
  });
})();

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

function setStatus(text, type = 'idle') {
  const statusEl = document.getElementById('status');
  const badge = statusEl.querySelector('.status-badge');
  const dot = statusEl.querySelector('.status-dot');
  
  if (badge) {
    badge.className = `status-badge status-${type}`;
    badge.innerHTML = `<span class="status-dot ${type}"></span><span>${text}</span>`;
  } else {
    statusEl.textContent = text;
  }
}

function setProgress(current, total) {
  const bar = document.getElementById('progressBar');
  if (!bar || !total) return;
  const pct = Math.min(100, Math.max(0, Math.round(((current) / total) * 100)));
  bar.style.width = `${pct}%`;
}

// Toast Notifications
function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// Error Handling
function showError(message, details = null, stack = null) {
  const errorPanel = document.getElementById('errorPanel');
  if (!errorPanel) return;
  
  const errorMessage = errorPanel.querySelector('.error-message');
  const errorStack = errorPanel.querySelector('.error-stack');
  const errorDetailsDiv = errorPanel.querySelector('.error-details');
  const toggleBtn = errorPanel.querySelector('.error-toggle-details');
  
  // Set error message
  errorMessage.textContent = message;
  
  // Set error details
  if (details || stack) {
    const detailsText = [
      details ? `Details: ${details}` : '',
      stack ? `Stack: ${stack}` : ''
    ].filter(Boolean).join('\n\n');
    
    errorStack.textContent = detailsText;
    toggleBtn.style.display = 'inline-block';
  } else {
    toggleBtn.style.display = 'none';
  }
  
  // Show error panel
  errorPanel.classList.remove('hidden');
  
  // Auto-hide after 10 seconds
  setTimeout(() => {
    hideError();
  }, 10000);
}

function hideError() {
  const errorPanel = document.getElementById('errorPanel');
  if (errorPanel) {
    errorPanel.classList.add('hidden');
  }
}

function clearError() {
  const errorPanel = document.getElementById('errorPanel');
  if (errorPanel) {
    errorPanel.querySelector('.error-message').textContent = '';
    errorPanel.querySelector('.error-stack').textContent = '';
    errorPanel.querySelector('.error-details').classList.add('hidden');
    errorPanel.querySelector('.error-toggle-details').textContent = 'Show Details';
  }
}

// Button State Management
function setButtonsDisabled(disabled) {
  const shouldDisable = disabled && document.getElementById('disableButtonsDuringAutomation')?.checked;
  const buttons = document.querySelectorAll('button:not(#disableButtonsDuringAutomation)');
  buttons.forEach(btn => {
    btn.disabled = shouldDisable;
  });
}

// Loading Skeleton
function showHistoryLoading(show = true) {
  const loading = document.getElementById('historyLoading');
  const history = document.getElementById('history');
  if (show) {
    loading?.classList.remove('hidden');
    history.innerHTML = '';
  } else {
    loading?.classList.add('hidden');
  }
}

function secToMs(v) { return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v * 1000) : undefined; }
function msToSec(v) { return typeof v === 'number' && !Number.isNaN(v) ? (v / 1000) : ''; }

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (res?.ok && res.status) {
      const { running, currentIndex, total, recoveryAttempts } = res.status;
      setProgress(running ? currentIndex : total, total);
      setButtonsDisabled(running);
      if (running) {
        // Show recovery status if attempting recovery
        if (recoveryAttempts > 0) {
          setStatus(`Recovering... (attempt ${recoveryAttempts}/3) - Prompt ${currentIndex + 1} of ${total}`, 'running');
        } else {
          setStatus(`Running prompt ${currentIndex + 1} of ${total}...`, 'running');
        }
      } else if (total > 0 && currentIndex >= total) {
        setStatus('Complete', 'idle');
      } else {
        setStatus('Idle', 'idle');
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
      document.getElementById('enableStopWord').checked = s.enableStopWord === true;
      document.getElementById('stopWord').value = s.stopWord || '';
      document.getElementById('stopWordCaseSensitive').checked = s.stopWordCaseSensitive === true;
      
      // Show/hide stop word container based on checkbox
      const stopWordContainer = document.getElementById('stopWordContainer');
      if (s.enableStopWord === true) {
        stopWordContainer.classList.remove('hidden');
      } else {
        stopWordContainer.classList.add('hidden');
      }
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
      enableStopWord: document.getElementById('enableStopWord').checked,
      stopWord: document.getElementById('stopWord').value || '',
      stopWordCaseSensitive: document.getElementById('stopWordCaseSensitive').checked,
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

// Max wait timeout toggle
const enableMaxWaitTimeoutCheckbox = document.getElementById('enableMaxWaitTimeout');
if (enableMaxWaitTimeoutCheckbox) {
  enableMaxWaitTimeoutCheckbox.addEventListener('change', saveSettingsFromUI);
}

// Stop word toggle and container
const enableStopWordCheckbox = document.getElementById('enableStopWord');
const stopWordContainer = document.getElementById('stopWordContainer');
const stopWordInput = document.getElementById('stopWord');
const stopWordCaseSensitiveCheckbox = document.getElementById('stopWordCaseSensitive');

if (enableStopWordCheckbox) {
  enableStopWordCheckbox.addEventListener('change', () => {
    if (enableStopWordCheckbox.checked) {
      stopWordContainer.classList.remove('hidden');
      stopWordInput.focus();
    } else {
      stopWordContainer.classList.add('hidden');
    }
    saveSettingsFromUI();
  });
}

if (stopWordInput) {
  stopWordInput.addEventListener('input', saveSettingsFromUI);
}

if (stopWordCaseSensitiveCheckbox) {
  stopWordCaseSensitiveCheckbox.addEventListener('change', saveSettingsFromUI);
}

document.getElementById('startBtn').addEventListener('click', async () => {
  try {
    // Check if automation is already running
    const statusRes = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (statusRes?.ok && statusRes.status?.running) {
      showToast('Automation is already running. Stop it first.', 'error');
      setStatus(`Running prompt ${statusRes.status.currentIndex + 1} of ${statusRes.status.total}...`, 'running');
      return;
    }
    
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
    hideError(); // Clear any previous error
    // Get current settings and include them in START_AUTOMATION to avoid race conditions
    await saveSettingsFromUI();
    const settingsRes = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const currentSettings = settingsRes?.settings || {};
    const res = await chrome.runtime.sendMessage({ type: 'START_AUTOMATION', prompts, tabId, options: currentSettings });
    if (res?.ok) {
      setStatus(`Running prompt 1 of ${prompts.length}...`, 'running');
      setProgress(0, prompts.length);
      await chrome.runtime.sendMessage({ type: 'SAVE_PROMPT_HISTORY', item: { prompts, settings: currentSettings } });
    } else {
      setStatus(`Failed to start: ${res?.error || 'Unknown error'}`, 'error');
      showToast(res?.error || 'Failed to start', 'error');
    }
  } catch (e) {
    console.error('[StartBtn] Error:', e);
    setStatus(`Failed to start: ${e}`, 'error');
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
        showToast('No prompts to save', 'error');
        return;
      }
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({ 
        type: 'SAVE_PROMPT_HISTORY', 
        item: { prompts, settings: settings?.settings } 
      });
      // Immediately refresh the history list
      await loadHistoryIntoUI();
      showToast('✓ Saved to history', 'success');
    } catch (e) {
      console.error('[SaveHistoryBtn] Error:', e);
      showToast('Failed to save history', 'error');
    }
  });
}

// Add reload history button listener
const reloadHistoryBtn = document.getElementById('reloadHistoryBtn');
if (reloadHistoryBtn) {
  reloadHistoryBtn.addEventListener('click', async () => {
    try {
      await loadHistoryIntoUI();
      showToast('✓ History reloaded', 'success');
    } catch (e) {
      console.error('[ReloadHistoryBtn] Error:', e);
      showToast('Failed to reload history', 'error');
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
        showToast(`✓ Exported ${res.history.length} items`, 'success');
      }
    } catch (e) {
      console.error('[ExportBtn] Error:', e);
      showToast('Export failed', 'error');
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
        showToast('Invalid JSON format', 'error');
        return;
      }
      
      // Validate each item has required fields
      const validItems = importData.history.filter(item => {
        if (!item || typeof item !== 'object') return false;
        if (!Array.isArray(item.prompts) || item.prompts.length === 0) return false;
        return true;
      });
      
      if (validItems.length === 0) {
        showToast('No valid history items found', 'error');
        return;
      }
      
      const invalidCount = importData.history.length - validItems.length;
      if (invalidCount > 0) {
        console.warn(`[Import] Skipped ${invalidCount} invalid items`);
      }
      
      // Create signature for deduplication
      const makeSignature = (item) => JSON.stringify((item.prompts || []).map(p => p.trim()));
      
      // Get existing history
      const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
      const existingHistory = res?.history || [];
      
      // Build set of existing signatures for deduplication
      const existingSignatures = new Set(existingHistory.map(makeSignature));
      
      // Filter out duplicates from imported items
      const newItems = validItems.filter(item => !existingSignatures.has(makeSignature(item)));
      
      // Ensure imported items have savedAt timestamp
      const itemsWithTimestamp = newItems.map(item => ({
        ...item,
        savedAt: item.savedAt || Date.now()
      }));
      
      // Merge: new imports first, then existing
      const mergedHistory = [...itemsWithTimestamp, ...existingHistory].slice(0, 50);
      
      // Save merged history
      await chrome.storage.local.set({ aiTaskSequencerHistory: mergedHistory });
      
      // Reload UI
      await loadHistoryIntoUI();
      
      const dupeCount = validItems.length - newItems.length;
      let message = `✓ Imported ${newItems.length} item${newItems.length !== 1 ? 's' : ''}`;
      if (dupeCount > 0) message += ` (${dupeCount} duplicate${dupeCount !== 1 ? 's' : ''} skipped)`;
      if (invalidCount > 0) message += ` (${invalidCount} invalid skipped)`;
      showToast(message, 'success');
    } catch (e) {
      console.error('[ImportFile] Error:', e);
      showToast(`Import failed: ${e.message}`, 'error');
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
  
  const titleEl = document.createElement('div');
  titleEl.style.whiteSpace = 'nowrap';
  titleEl.style.overflow = 'hidden';
  titleEl.style.textOverflow = 'ellipsis';
  titleEl.textContent = title;
  titleEl.title = (item.prompts || []).join('\n');
  
  const dateEl = document.createElement('div');
  dateEl.className = 'history-item-date';
  dateEl.textContent = date;
  
  left.appendChild(titleEl);
  left.appendChild(dateEl);

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
    updatePromptCount();
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
    const countBadge = document.getElementById('historyCount');
    const clearBtn = document.getElementById('clearHistoryBtn');
    
    if (!list) {
      console.error('[LoadHistory] History list element not found');
      return;
    }
    
    showHistoryLoading(true);
    
    // Simulate loading delay for better UX
    await new Promise(r => setTimeout(r, 300));
    
    const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
    if (res?.ok) {
      const history = res.history || [];
      if (countBadge) {
        countBadge.textContent = `${history.length} item${history.length !== 1 ? 's' : ''}`;
      }
      if (clearBtn) {
        clearBtn.style.display = history.length > 0 ? 'block' : 'none';
      }
      history.forEach((item, idx) => {
        list.appendChild(createHistoryRow(item, idx));
      });
    }
    
    showHistoryLoading(false);
  } catch (e) {
    console.error('[LoadHistory] Error:', e);
    showHistoryLoading(false);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  try {
    if (message?.type === 'AUTOMATION_PROGRESS' && message.status) {
      const { currentIndex, total, recoveryAttempts } = message.status;
      lastActivityTime = Date.now();
      setButtonsDisabled(true);
      clearError();
      // Show recovery status if attempting recovery
      if (recoveryAttempts > 0) {
        setStatus(`Recovering... (attempt ${recoveryAttempts}/3) - Prompt ${currentIndex + 1} of ${total}`, 'running');
      } else {
        setStatus(`Running prompt ${currentIndex + 1} of ${total}...`, 'running');
      }
      setProgress(currentIndex, total);
    } else if (message?.type === 'AUTOMATION_COMPLETE') {
      const reason = message.reason;
      const status = message.status;
      if (reason === 'stoppedByStopWord') {
        setStatus('Stopped by stop phrase', 'idle');
      } else {
        setStatus('Complete', 'idle');
      }
      if (status?.total && typeof status.currentIndex === 'number') {
        setProgress(status.currentIndex, status.total);
      } else {
        setProgress(1, 1);
      }
      setButtonsDisabled(false);
      clearError();
      const toastMessage = reason === 'stoppedByStopWord'
        ? '✓ Automation stopped by stop phrase'
        : '✓ Automation complete!';
      showToast(toastMessage, 'success');
      stopCountdownTimer();
    } else if (message?.type === 'AUTOMATION_ERROR') {
      setStatus(`Error: ${message.error}`, 'error');
      setButtonsDisabled(false);
      showToast(`✗ Error: ${message.error}`, 'error', 5000);
      showError(
        `Automation Error: ${message.error}`,
        message.details || 'No additional details available',
        message.stack || 'No stack trace available'
      );
      stopCountdownTimer();
      // Refresh status after error to show proper state
      setTimeout(refreshStatus, 1000);
    }
  } catch (e) {
    console.error('[MessageListener] Error handling message:', e);
    showError('Failed to handle message', e.message, e.stack);
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

// Collapsible sections
document.getElementById('promptsHeader')?.addEventListener('click', () => {
  const toggle = document.querySelector('#promptsHeader .collapsible-toggle');
  const content = document.getElementById('promptsContent');
  toggle.classList.toggle('collapsed');
  content.classList.toggle('collapsed');
});

document.getElementById('optionsHeader')?.addEventListener('click', () => {
  const toggle = document.querySelector('#optionsHeader .collapsible-toggle');
  const content = document.getElementById('optionsContent');
  toggle.classList.toggle('collapsed');
  content.classList.toggle('collapsed');
});


// Prompt counter
const promptsTextarea = document.getElementById('prompts');
const updatePromptCount = () => {
  const prompts = parsePrompts(promptsTextarea.value);
  const counter = document.querySelector('.prompt-counter');
  if (counter) {
    counter.textContent = `${prompts.length} prompt${prompts.length !== 1 ? 's' : ''} loaded`;
  }
};

if (promptsTextarea) {
  promptsTextarea.addEventListener('input', updatePromptCount);
  updatePromptCount();
}

// Preset buttons
const presets = {
  fast: { maxWait: 60, stable: 3, poll: 0.5 },
  balanced: { maxWait: 180, stable: 10, poll: 1.5 },
  thorough: { maxWait: 300, stable: 15, poll: 2 }
};

document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    const config = presets[preset];
    if (config) {
      document.getElementById('maxWaitSec').value = config.maxWait;
      document.getElementById('stableSec').value = config.stable;
      document.getElementById('pollSec').value = config.poll;
      saveSettingsFromUI();
      
      // Visual feedback
      document.querySelectorAll('.preset-btn[data-preset]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
  });
});

// History search
const historySearch = document.getElementById('historySearch');
if (historySearch) {
  historySearch.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll('.history-item').forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(query) ? '' : 'none';
    });
  });
}

// Clear history button
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all saved histories? This cannot be undone.')) {
      try {
        await chrome.storage.local.set({ aiTaskSequencerHistory: [] });
        await loadHistoryIntoUI();
        showToast('✓ History cleared', 'success');
      } catch (e) {
        console.error('[ClearHistory] Error:', e);
        showToast('Failed to clear history', 'error');
      }
    }
  });
}

// Error Panel Event Listeners
const errorPanel = document.getElementById('errorPanel');
if (errorPanel) {
  // Close button
  const closeBtn = errorPanel.querySelector('.error-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', hideError);
  }
  
  // Toggle details button
  const toggleBtn = errorPanel.querySelector('.error-toggle-details');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const details = errorPanel.querySelector('.error-details');
      const isHidden = details.classList.contains('hidden');
      
      if (isHidden) {
        details.classList.remove('hidden');
        toggleBtn.textContent = 'Hide Details';
      } else {
        details.classList.add('hidden');
        toggleBtn.textContent = 'Show Details';
      }
    });
  }
  
  // Copy error button
  const copyBtn = errorPanel.querySelector('.error-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const message = errorPanel.querySelector('.error-message').textContent;
      const stack = errorPanel.querySelector('.error-stack').textContent;
      const fullError = `${message}\n\n${stack}`;
      
      navigator.clipboard.writeText(fullError).then(() => {
        showToast('✓ Error copied to clipboard', 'success', 2000);
      }).catch(() => {
        showToast('Failed to copy error', 'error');
      });
    });
  }
}

// Stop auto-refresh when popup closes
window.addEventListener('unload', () => {
  stopAutoRefresh();
  stopCountdownTimer();
});

// Initialization is handled by DOMContentLoaded event listener above