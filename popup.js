import { applyConsolePatch } from './popup-console-patch.js';
import { parsePrompts, setStatus, setProgress, showToast, showError, hideError, clearError, setButtonsDisabled, secToMs, PROMPT_SEPARATOR } from './popup-dom-utils.js';
import { loadSettingsIntoUI, saveSettingsFromUI, initSettingsUI } from './popup-settings.js';
import { loadHistoryIntoUI, importHistoryItems, clearHistory, exportHistory, saveHistoryItem } from './popup-history.js';

applyConsolePatch();

const separatorInput = document.getElementById('separatorInput');
const resolveSeparator = (raw) => {
  if (!raw || typeof raw !== 'string') return PROMPT_SEPARATOR;
  // Support literal "\n" sequences entered by the user
  return raw.replace(/\\n/g, '\n');
};

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (res?.ok && res.status) {
      const { running, currentIndex, total, recoveryAttempts } = res.status;
      setProgress(running ? currentIndex : total, total);
      setButtonsDisabled(running);
      if (running) {
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

initSettingsUI();

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
    const separatorInput = document.getElementById('separatorInput');
    const separator = resolveSeparator(separatorInput?.value);
    const prompts = parsePrompts(textarea.value, separator);
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
      const separatorInput = document.getElementById('separatorInput');
      const separator = resolveSeparator(separatorInput?.value);
      const prompts = parsePrompts(textarea.value, separator);
      if (prompts.length === 0) {
        showToast('No prompts to save', 'error');
        return;
      }
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await saveHistoryItem(prompts, settings?.settings);
      // Immediately refresh the history list
      await loadHistoryIntoUI(updatePromptCount);
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
      const exportData = await exportHistory();
      if (!exportData) return;
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
      showToast(`✓ Exported ${exportData.history.length} items`, 'success');
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
      
      const result = await importHistoryItems(importData);
      await loadHistoryIntoUI(updatePromptCount);

      let message = `✓ Imported ${result.imported} item${result.imported !== 1 ? 's' : ''}`;
      if (result.duplicates > 0) message += ` (${result.duplicates} duplicate${result.duplicates !== 1 ? 's' : ''} skipped)`;
      if (result.invalid > 0) message += ` (${result.invalid} invalid skipped)`;
      showToast(message, result.imported > 0 ? 'success' : 'error');
    } catch (e) {
      console.error('[ImportFile] Error:', e);
      showToast(`Import failed: ${e.message}`, 'error');
    }
    
    // Reset file input
    importFile.value = '';
  });
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

// Check for sample-export.json and prompt to load
async function checkForSampleExport() {
  try {
    const sampleUrl = chrome.runtime.getURL('sample-export.json');
    const response = await fetch(sampleUrl);
    if (!response.ok) return;
    
    const data = await response.json();
    if (!data.history || !Array.isArray(data.history) || data.history.length === 0) return;
    
    // Check if history is empty (no point prompting if user already has data)
    const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
    if (res?.history && res.history.length > 0) return; // Already has history
    
    // Show confirmation toast
    if (confirm(`Found sample-export.json with ${data.history.length} saved prompt(s). Load it?`)) {
      await importSampleData(data);
    }
  } catch (e) {
    // File doesn't exist or can't be read - that's fine
    console.log('[SampleExport] No sample-export.json found or error:', e.message);
  }
}

async function importSampleData(importData) {
  try {
    const validItems = importData.history.filter(item => {
      if (!item || typeof item !== 'object') return false;
      if (!Array.isArray(item.prompts) || item.prompts.length === 0) return false;
      return true;
    });
    
    if (validItems.length === 0) {
      showToast('No valid items in sample file', 'error');
      return;
    }
    
    const itemsWithTimestamp = validItems.map(item => ({
      ...item,
      savedAt: item.savedAt || Date.now()
    }));
    
    await chrome.storage.local.set({ aiTaskSequencerHistory: itemsWithTimestamp.slice(0, 50) });
    await loadHistoryIntoUI();
    showToast(`✓ Loaded ${validItems.length} item(s) from sample`, 'success');
  } catch (e) {
    console.error('[ImportSample] Error:', e);
    showToast('Failed to load sample', 'error');
    
  }
}

// Start auto-refresh when popup opens
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadSettingsIntoUI();
    await loadHistoryIntoUI(updatePromptCount);
    await refreshStatus();
    startAutoRefresh();
    startCountdownTimer();
    await checkForSampleExport();
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
  if (!promptsTextarea) return;
  const separator = resolveSeparator(separatorInput?.value);
  const prompts = parsePrompts(promptsTextarea.value, separator);
  const counter = document.querySelector('.prompt-counter');
  if (counter) {
    counter.textContent = `${prompts.length} prompt${prompts.length !== 1 ? 's' : ''} loaded`;
  }
};

function autoResizeTextarea(el, { active = false } = {}) {
  if (!el) return;
  const maxHeight = Math.floor(window.innerHeight * 0.7);
  const minHeight = 120;
  const collapsed = 80;
  el.classList.toggle('is-active', active);
  if (!active && document.activeElement !== el) {
    el.style.height = `${collapsed}px`;
    return;
  }
  el.style.height = 'auto';
  const nextHeight = Math.min(Math.max(minHeight, el.scrollHeight + 8), maxHeight);
  el.style.height = `${nextHeight}px`;
}

if (promptsTextarea) {
  const handleActiveResize = () => autoResizeTextarea(promptsTextarea, { active: true });
  promptsTextarea.addEventListener('input', () => {
    updatePromptCount();
    handleActiveResize();
  });
  promptsTextarea.addEventListener('focus', handleActiveResize);
  promptsTextarea.addEventListener('blur', () => autoResizeTextarea(promptsTextarea, { active: false }));
  updatePromptCount();
  autoResizeTextarea(promptsTextarea, { active: false });
  window.addEventListener('resize', handleActiveResize);
}

if (separatorInput) {
  separatorInput.addEventListener('input', updatePromptCount);
}

const insertSeparatorBtn = document.getElementById('insertSeparatorBtn');
if (insertSeparatorBtn && promptsTextarea) {
  // Prevent mousedown from stealing focus/selection before we insert
  insertSeparatorBtn.addEventListener('mousedown', (e) => e.preventDefault());

  insertSeparatorBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const separatorBlock = `${resolveSeparator(separatorInput?.value)}\n`;
    const { selectionStart, selectionEnd, value } = promptsTextarea;
    const before = value.slice(0, selectionStart);
    const after = value.slice(selectionEnd);
    const needsLeadingNewline = before && !before.endsWith('\n');
    const needsTrailingNewline = after && !after.startsWith('\n');
    const insertText = `${needsLeadingNewline ? '\n' : ''}${separatorBlock}${needsTrailingNewline ? '\n' : ''}`;
    const nextValue = `${before}${insertText}${after}`;
    const caretPos = before.length + insertText.length;
    promptsTextarea.value = nextValue;
    promptsTextarea.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      promptsTextarea.setSelectionRange(caretPos, caretPos);
    });
    updatePromptCount();
    autoResizeTextarea(promptsTextarea);
  });
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
        await clearHistory();
        await loadHistoryIntoUI(updatePromptCount);
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