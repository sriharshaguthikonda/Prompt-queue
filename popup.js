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

const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');

function updateControlButtons(status = {}) {
  const running = !!status.running;
  const paused = !!status.paused;

  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');

  if (startBtn) startBtn.disabled = running;
  if (stopBtn) stopBtn.disabled = !running;

  if (pauseBtn) {
    pauseBtn.style.display = running && !paused ? 'inline-block' : 'none';
    pauseBtn.disabled = !running || paused;
  }
  if (resumeBtn) {
    resumeBtn.style.display = running && paused ? 'inline-block' : 'none';
    resumeBtn.disabled = !running || !paused;
  }
}

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (res?.ok && res.status) {
      const { running, paused, currentIndex, total, recoveryAttempts } = res.status;
      setProgress(running ? currentIndex : total, total);
      setButtonsDisabled(running && !paused);
      updateControlButtons(res.status);
      if (paused) {
        setStatus(`Paused at prompt ${currentIndex + 1} of ${total}`, 'paused');
      } else if (running) {
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

async function startAutomation() {
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
      updateControlButtons({ running: true, paused: false });
      await chrome.runtime.sendMessage({ type: 'SAVE_PROMPT_HISTORY', item: { prompts, settings: currentSettings } });
    } else {
      setStatus(`Failed to start: ${res?.error || 'Unknown error'}`, 'error');
      showToast(res?.error || 'Failed to start', 'error');
    }
  } catch (e) {
    console.error('[StartAutomation] Error:', e);
    setStatus(`Failed to start: ${e}`, 'error');
  }
}

document.getElementById('startBtn').addEventListener('click', startAutomation);

if (pauseBtn) {
  pauseBtn.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'PAUSE_AUTOMATION' });
      if (res?.ok) {
        setStatus('Paused', 'paused');
        updateControlButtons({ running: true, paused: true });
      } else {
        showToast(res?.error || 'Failed to pause', 'error');
      }
    } catch (e) {
      console.error('[PauseBtn] Error:', e);
      showToast('Failed to pause', 'error');
    }
  });
}

if (resumeBtn) {
  resumeBtn.addEventListener('click', async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'RESUME_AUTOMATION' });
      if (res?.ok) {
        setStatus('Resuming...', 'running');
        updateControlButtons({ running: true, paused: false });
      } else {
        showToast(res?.error || 'Failed to resume', 'error');
      }
    } catch (e) {
      console.error('[ResumeBtn] Error:', e);
      showToast('Failed to resume', 'error');
    }
  });
}

document.getElementById('stopBtn').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION' });
    setStatus('Stopped');
    updateControlButtons({ running: false, paused: false });
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
      const { currentIndex, total, recoveryAttempts, paused, running } = message.status;
      lastActivityTime = Date.now();
      setButtonsDisabled(running && !paused);
      clearError();
      updateControlButtons(message.status);
      // Show recovery status if attempting recovery
      if (paused) {
        setStatus(`Paused at prompt ${currentIndex + 1} of ${total}`, 'paused');
      } else if (recoveryAttempts > 0) {
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
      updateControlButtons({ running: false, paused: false });
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
      updateControlButtons({ running: false, paused: false });
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
      if (res?.ok && res.status?.running && !res.status?.paused) {
        const stableMs =
          res.status.stableCountdownMs ||
          res.status.options?.stableMs ||
          secToMs(Number(document.getElementById('stableMaxSec')?.value)) ||
          1200;
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
    try {
      chrome.runtime.sendMessage({ type: 'SIDE_PANEL_OPENED' });
    } catch (_) {}

    await loadSettingsIntoUI();
    await loadHistoryIntoUI(updatePromptCount);
    await loadStateIntoUI();
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

async function loadStateIntoUI() {
  try {
    const { state: storedState } = await chrome.storage.local.get(['state']);
    if (!storedState || !Array.isArray(storedState.prompts)) return;
    if (!promptsTextarea) return;
    promptsTextarea.value = storedState.prompts.join('\n');
    updatePromptCount();
    autoResizeTextarea(promptsTextarea, { active: false });
  } catch (e) {
    console.error('[LoadStateIntoUI] Error:', e);
  }
}

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
  promptsTextarea.addEventListener('keydown', (e) => {
    const isEnter = e.key === 'Enter';
    const withModifier = e.ctrlKey || e.metaKey;
    if (isEnter && withModifier) {
      e.preventDefault();
      startAutomation();
    }
  });
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
  fast: { maxWait: 60, stableMin: 2, stableMax: 4, poll: 0.5 },
  balanced: { maxWait: 180, stableMin: 8, stableMax: 12, poll: 1.5 },
  thorough: { maxWait: 300, stableMin: 12, stableMax: 18, poll: 2 }
};

document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.preset;
    const config = presets[preset];
    if (config) {
      document.getElementById('maxWaitSec').value = config.maxWait;
      document.getElementById('stableMinSec').value = config.stableMin;
      document.getElementById('stableMaxSec').value = config.stableMax;
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
  try {
    chrome.runtime.sendMessage({ type: 'SIDE_PANEL_CLOSED' });
  } catch (_) {}
  stopAutoRefresh();
  stopCountdownTimer();
});

// ============ TRANSCRIPTION MONITORING UI ============

// Transcription monitoring elements
const transcriptionFolder = document.getElementById('transcriptionFolder');
const browseFolderBtn = document.getElementById('browseFolderBtn');
const startMonitoringBtn = document.getElementById('startMonitoringBtn');
const stopMonitoringBtn = document.getElementById('stopMonitoringBtn');
const monitoringStatus = document.getElementById('monitoringStatus');
const transcriptionInfo = document.getElementById('transcriptionInfo');
const currentFolder = document.getElementById('currentFolder');
const processedCount = document.getElementById('processedCount');

// Load transcription state into UI
async function loadTranscriptionState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPTION_STATE' });
    if (response?.success) {
      updateTranscriptionUI(response.isEnabled, response.watchFolder);
      if (response.watchFolder) {
        transcriptionFolder.value = response.watchFolder;
      }
      if (typeof response.processedCount === 'number') {
        processedCount.textContent = response.processedCount;
      }
      
      // Load folder path
      const result = await chrome.storage.local.get(['transcriptionState']);
      if (result.transcriptionState && !transcriptionFolder.value) {
        transcriptionFolder.value = result.transcriptionState.watchFolder || '';
        processedCount.textContent = result.transcriptionState.processedFiles?.length || 0;
      }
    }
  } catch (error) {
    console.error('Failed to load transcription state:', error);
  }
}

// Update transcription monitoring UI
function updateTranscriptionUI(isEnabled, folder) {
  if (isEnabled) {
    startMonitoringBtn.style.display = 'none';
    stopMonitoringBtn.style.display = 'inline-block';
    monitoringStatus.innerHTML = `
      <span class="status-dot active"></span>
      <span>Monitoring</span>
    `;
    monitoringStatus.className = 'status-badge status-running';
    transcriptionInfo.style.display = 'block';
    currentFolder.textContent = folder || '-';
  } else {
    startMonitoringBtn.style.display = 'inline-block';
    stopMonitoringBtn.style.display = 'none';
    monitoringStatus.innerHTML = `
      <span class="status-dot idle"></span>
      <span>Not Monitoring</span>
    `;
    monitoringStatus.className = 'status-badge status-idle';
    transcriptionInfo.style.display = 'none';
  }
}

// Start monitoring
async function startMonitoring() {
  const folder = transcriptionFolder.value.trim();
  if (!folder) {
    showToast('Please enter a folder path', 'error');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_TRANSCRIPTION_MONITORING',
      folder: folder
    });
    
    if (response?.success) {
      updateTranscriptionUI(true, folder);
      showToast(`Started monitoring: ${folder}`, 'success', 3000);
    } else {
      showToast(response?.error || 'Failed to start monitoring', 'error');
    }
  } catch (error) {
    console.error('Failed to start monitoring:', error);
    showToast(`Error: ${error?.message || error}`, 'error');
  }
}

// Stop monitoring
async function stopMonitoring() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'STOP_TRANSCRIPTION_MONITORING'
    });
    
    if (response?.success) {
      updateTranscriptionUI(false, '');
      showToast('Stopped monitoring', 'success', 2000);
    } else {
      showToast(response?.error || 'Failed to stop monitoring', 'error');
    }
  } catch (error) {
    console.error('Failed to stop monitoring:', error);
    showToast(`Error: ${error?.message || error}`, 'error');
  }
}

// Browse for folder (placeholder - Chrome extensions can't directly browse folders)
function browseFolder() {
  showToast('Please enter the folder path manually (e.g., I:\\Transcriptions)', 'info', 5000);
}

// Event listeners for transcription monitoring
if (browseFolderBtn) {
  browseFolderBtn.addEventListener('click', browseFolder);
}

if (startMonitoringBtn) {
  startMonitoringBtn.addEventListener('click', startMonitoring);
}

if (stopMonitoringBtn) {
  stopMonitoringBtn.addEventListener('click', stopMonitoring);
}

// Listen for prompts updated messages
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'PROMPTS_UPDATED') {
    // Reload prompts to show new transcription entries
    loadStateIntoUI();
  } else if (message?.type === 'CLOSE_SIDE_PANEL') {
    window.close();
  }
});

// Load transcription state on initialization
document.addEventListener('DOMContentLoaded', () => {
  loadTranscriptionState();
});

// Initialization is handled by DOMContentLoaded event listener above
