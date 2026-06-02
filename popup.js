import { applyConsolePatch } from './popup-console-patch.js';
import { setStatus, setProgress, showToast, showError, hideError, clearError, setButtonsDisabled, secToMs } from './popup-dom-utils.js';
import { loadSettingsIntoUI, saveSettingsFromUI, initSettingsUI } from './popup-settings.js';
import { loadHistoryIntoUI, importHistoryItems, clearHistory, exportHistory, exportHistoryMarkdown, saveHistoryItem } from './popup-history.js';
import { NEW_TAB_MARKER, resolveSeparator, buildPromptLaunchPlan } from './popup-prompt-plan.js';
import { initMemoryPackUI, loadMemorySettingsIntoUI } from './popup-memory.js';
import { initPromptQueueReorder, refreshPromptQueueReorder } from './popup-queue.js';
import { renderSelectorHealth, renderStepStatus } from './popup-send-settings.js';

applyConsolePatch();

const PQ_CONSTANTS = globalThis.PromptQueueConstants || {};
const MESSAGE_TYPES = PQ_CONSTANTS.MESSAGE_TYPES || {};
const STORAGE_KEYS = PQ_CONSTANTS.STORAGE_KEYS || {};
const separatorInput = document.getElementById('separatorInput');
let latestAutomationStatus = null;
let currentPanelTabId = null;
let lastParallelFailureSignature = null;
let hasInitializedParallelFailureState = false;

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

async function getContextTabId() {
  const tabId = await getActiveTabId();
  if (Number.isInteger(tabId)) {
    currentPanelTabId = tabId;
  }
  return tabId;
}

function shouldHandleAutomationMessage(message) {
  const messageTabId = Number(message?.tabId);
  if (!Number.isInteger(messageTabId)) return true;
  if (!Number.isInteger(currentPanelTabId)) return true;
  return messageTabId === currentPanelTabId;
}

function getParallelFailureSignature(status = {}) {
  const failure = status?.parallelLastFailure;
  if (!failure) return null;
  return [
    failure.at || '',
    failure.workerId || '',
    failure.tabId || '',
    failure.error || '',
  ].join(':');
}

function syncParallelFailureNotice(status = {}, { silent = false } = {}) {
  const signature = getParallelFailureSignature(status);
  if (!signature) {
    return;
  }
  if (signature === lastParallelFailureSignature) {
    return;
  }
  lastParallelFailureSignature = signature;
  if (!silent) {
    showToast(status.parallelLastFailure.error || 'A worker tab failed. Inspect it manually.', 'info', 7000);
  }
}

const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const parallelWalkthrough = document.getElementById('parallelWalkthrough');
const toggleParallelWalkthroughBtn = document.getElementById('toggleParallelWalkthroughBtn');
const PARALLEL_WALKTHROUGH_VISIBILITY_KEY = 'parallelWalkthroughVisible';

function setParallelWalkthroughVisibility(visible) {
  if (!parallelWalkthrough || !toggleParallelWalkthroughBtn) return;
  parallelWalkthrough.hidden = !visible;
  toggleParallelWalkthroughBtn.textContent = visible ? 'Hide guide' : 'Show guide';
}

function closeOpenInfoPopovers(exceptWrap = null) {
  document.querySelectorAll('.info-wrap.is-open').forEach((wrap) => {
    if (exceptWrap && wrap === exceptWrap) return;
    wrap.classList.remove('is-open');
    const btn = wrap.querySelector('.info-trigger');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
}

function initInfoPopovers() {
  const infoButtons = document.querySelectorAll('.info-trigger');
  infoButtons.forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wrap = btn.closest('.info-wrap');
      if (!wrap) return;
      const willOpen = !wrap.classList.contains('is-open');
      closeOpenInfoPopovers(wrap);
      wrap.classList.toggle('is-open', willOpen);
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
  });

  document.addEventListener('click', () => closeOpenInfoPopovers());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeOpenInfoPopovers();
      if (latestAutomationStatus?.running === true) {
        event.preventDefault();
      }
      stopAutomationFromUI({ reason: 'escape' });
    }
  });
}

async function loadParallelWalkthroughVisibility() {
  if (!parallelWalkthrough || !toggleParallelWalkthroughBtn) return;
  let visible = true;
  try {
    const result = await chrome.storage.local.get([PARALLEL_WALKTHROUGH_VISIBILITY_KEY]);
    if (typeof result?.[PARALLEL_WALKTHROUGH_VISIBILITY_KEY] === 'boolean') {
      visible = result[PARALLEL_WALKTHROUGH_VISIBILITY_KEY];
    }
  } catch (e) {
    console.error('[ParallelWalkthrough] Failed to load visibility:', e);
  }
  setParallelWalkthroughVisibility(visible);
}

if (toggleParallelWalkthroughBtn && parallelWalkthrough) {
  toggleParallelWalkthroughBtn.addEventListener('click', async () => {
    const currentlyVisible = !parallelWalkthrough.hidden;
    const nextVisible = !currentlyVisible;
    setParallelWalkthroughVisibility(nextVisible);
    try {
      await chrome.storage.local.set({ [PARALLEL_WALKTHROUGH_VISIBILITY_KEY]: nextVisible });
    } catch (e) {
      console.error('[ParallelWalkthrough] Failed to save visibility:', e);
    }
  });
}

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

function getRunningStatusText(status = {}) {
  const {
    mode = 'sequential',
    paused,
    currentIndex = 0,
    total = 0,
    recoveryAttempts = 0,
    currentRetryCount = 0,
    options = {},
    parallelLaunched = 0,
    parallelCompleted = 0,
    parallelFailed = 0,
    parallelActive = 0,
    currentPromptPreview = '',
    etaMs = 0,
  } = status;

  if (mode === 'parallel') {
    if (paused) {
      return `Paused launches - launched ${parallelLaunched}/${total}, active ${parallelActive}, done ${parallelCompleted}, failed ${parallelFailed}`;
    }
    return `Parallel running - launched ${parallelLaunched}/${total}, active ${parallelActive}, done ${parallelCompleted}, failed ${parallelFailed}`;
  }

  const details = [];
  if (Number(etaMs || 0) > 0 && !paused) {
    details.push(`ETA ${formatDuration(etaMs)}`);
  }
  if (currentPromptPreview) {
    details.push(`Now: ${currentPromptPreview}`);
  }
  const suffix = details.length > 0 ? ` - ${details.join(' - ')}` : '';

  if (paused) {
    return `Paused at prompt ${currentIndex + 1} of ${total}${suffix}`;
  }
  if (recoveryAttempts > 0) {
    return `Recovering... (attempt ${recoveryAttempts}/3) - Prompt ${currentIndex + 1} of ${total}${suffix}`;
  }
  if (currentRetryCount > 0) {
    const maxRetries = Number(options?.maxRetriesPerPrompt || 0);
    return `Retrying prompt ${currentIndex + 1} of ${total} (${currentRetryCount}/${maxRetries || '?'})${suffix}`;
  }
  return `Running prompt ${currentIndex + 1} of ${total}${suffix}`;
}

function getProgressPosition(status = {}) {
  if (status.mode === 'parallel') {
    const completed = Number(status.parallelCompleted || 0);
    const failed = Number(status.parallelFailed || 0);
    return completed + failed;
  }
  return Number(status.currentIndex || 0);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

async function refreshStatus() {
  try {
    const tabId = await getContextTabId();
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST', tabId });
    if (res?.ok && res.status) {
      latestAutomationStatus = res.status;
      syncParallelFailureNotice(res.status, { silent: !hasInitializedParallelFailureState });
      hasInitializedParallelFailureState = true;
      const { running, paused, total, currentIndex } = res.status;
      const progressPos = getProgressPosition(res.status);
      setProgress(running ? progressPos : total, total);
      setButtonsDisabled(running && !paused);
      updateControlButtons(res.status);
      if (running) {
        setStatus(getRunningStatusText(res.status), res.status.paused ? 'paused' : 'running');
        renderStepStatus(res.status.stepStatus || null);
      } else if (total > 0 && currentIndex >= total) {
        setStatus('Complete', 'idle');
        renderStepStatus(null);
      } else {
        setStatus('Idle', 'idle');
        renderStepStatus(null);
      }
    }
  } catch (e) {
    console.error('[RefreshStatus] Error:', e);
  }
}

initSettingsUI();

async function startAutomation() {
  try {
    const textarea = document.getElementById('prompts');
    const separatorInput = document.getElementById('separatorInput');
    const separator = resolveSeparator(separatorInput?.value);
    const appendText = document.getElementById('appendPromptText')?.value?.trim() || '';
    const prependText = document.getElementById('systemPrompt')?.value?.trim() || '';
    const uiSettings = await saveSettingsFromUI();
    let currentSettings = { ...(uiSettings || {}) };
    if (!uiSettings) {
      const settingsRes = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      currentSettings = { ...(settingsRes?.settings || {}) };
    }
    const launchPlan = buildPromptLaunchPlan(textarea.value, separator, appendText, prependText, currentSettings);
    const prompts = launchPlan.prompts;
    if (prompts.length === 0) {
      setStatus('Please enter at least one prompt.');
      return;
    }
    if (launchPlan.duplicateChanged > 0) {
      showToast(`Adjusted ${launchPlan.duplicateChanged} duplicate prompt(s) with typo-like variations`, 'info', 4000);
    }
    const tabId = await getContextTabId();
    if (!tabId) {
      setStatus('No active tab found.');
      return;
    }

    // Check only this tab's session status; other tabs are allowed to run concurrently.
    const statusRes = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST', tabId });
    const runningStatus = statusRes?.ok ? statusRes.status : null;
    if (runningStatus?.running === true) {
      showToast('Automation is already running in this tab. Stop it first.', 'error');
      setStatus(getRunningStatusText(runningStatus), runningStatus.paused ? 'paused' : 'running');
      return;
    }

    setStatus('Starting...');
    hideError(); // Clear any previous error
    const parallelTabCount = launchPlan.hasTabMarkers ? launchPlan.tabPromptGroups.length : 0;
    if (launchPlan.hasTabMarkers) {
      showToast(`Detected ${parallelTabCount} tab group(s) using ${NEW_TAB_MARKER}`, 'info', 3000);
    }
    const res = await chrome.runtime.sendMessage({
      type: 'START_AUTOMATION',
      prompts,
      tabPromptGroups: launchPlan.hasTabMarkers ? launchPlan.tabPromptGroups : null,
      tabId,
      options: currentSettings,
    });
    if (res?.ok) {
      const initialStatus = launchPlan.hasTabMarkers
        ? { mode: 'parallel', running: true, paused: false, total: parallelTabCount, parallelLaunched: 0, parallelCompleted: 0, parallelFailed: 0, parallelActive: 0 }
        : { mode: 'sequential', running: true, paused: false, currentIndex: 0, total: prompts.length };
      setStatus(getRunningStatusText(initialStatus), 'running');
      renderStepStatus({ step: 'waiting_for_tab', label: 'Starting', color: 'active' });
      setProgress(getProgressPosition(initialStatus), initialStatus.total);
      updateControlButtons({ running: true, paused: false });
      await chrome.runtime.sendMessage({
        type: 'SAVE_PROMPT_HISTORY',
        item: { prompts: launchPlan.promptsWithMarkers, settings: currentSettings },
      });
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
      const tabId = await getContextTabId();
      const res = await chrome.runtime.sendMessage({ type: 'PAUSE_AUTOMATION', tabId });
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
      const tabId = await getContextTabId();
      const res = await chrome.runtime.sendMessage({ type: 'RESUME_AUTOMATION', tabId });
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

async function stopAutomationFromUI({ reason = 'button' } = {}) {
  try {
    if (reason === 'escape' && latestAutomationStatus?.running !== true) {
      return;
    }
    const tabId = await getContextTabId();
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.STOP_AUTOMATION || 'STOP_AUTOMATION', tabId });
    setStatus(reason === 'escape' ? 'Stopped by Escape' : 'Stopped');
    renderStepStatus(null);
    updateControlButtons({ running: false, paused: false });
    // Refresh to clear any recovery status
    await refreshStatus();
  } catch (e) {
    console.error('[StopBtn] Error:', e);
    setStatus('Stop failed');
  }
}

document.getElementById('stopBtn').addEventListener('click', async () => {
  await stopAutomationFromUI({ reason: 'button' });
});

// Save current prompts to history
const saveHistoryBtn = document.getElementById('saveHistoryBtn');
if (saveHistoryBtn) {
  saveHistoryBtn.addEventListener('click', async () => {
    try {
      const textarea = document.getElementById('prompts');
      const separatorInput = document.getElementById('separatorInput');
      const separator = resolveSeparator(separatorInput?.value);
      const appendText = document.getElementById('appendPromptText')?.value?.trim() || '';
      const prependText = document.getElementById('systemPrompt')?.value?.trim() || '';
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      const launchPlan = buildPromptLaunchPlan(textarea.value, separator, appendText, prependText, settings?.settings || {});
      const prompts = launchPlan.prompts;
      if (prompts.length === 0) {
        showToast('No prompts to save', 'error');
        return;
      }
      if (launchPlan.duplicateChanged > 0) {
        showToast(`Adjusted ${launchPlan.duplicateChanged} duplicate prompt(s) before save`, 'info', 3500);
      }
      await saveHistoryItem(launchPlan.promptsWithMarkers, settings?.settings);
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
      showToast(`✓ Exported ${exportData.history.length} items and ${exportData.responses.length} responses`, 'success');
    } catch (e) {
      console.error('[ExportBtn] Error:', e);
      showToast('Export failed', 'error');
    }
  });
}

const exportMarkdownBtn = document.getElementById('exportMarkdownBtn');
if (exportMarkdownBtn) {
  exportMarkdownBtn.addEventListener('click', async () => {
    try {
      const exportData = await exportHistory();
      if (!exportData) return;
      const markdown = exportHistoryMarkdown(exportData);
      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prompt-queue-export-${Date.now()}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`✓ Exported Markdown with ${exportData.responses.length} responses`, 'success');
    } catch (e) {
      console.error('[ExportMarkdownBtn] Error:', e);
      showToast('Markdown export failed', 'error');
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
    if (!shouldHandleAutomationMessage(message)) {
      return;
    }
    if (message?.type === 'AUTOMATION_PROGRESS' && message.status) {
      latestAutomationStatus = message.status;
      syncParallelFailureNotice(message.status);
      const { total, paused, running } = message.status;
      lastActivityTime = Date.now();
      setButtonsDisabled(running && !paused);
      clearError();
      updateControlButtons(message.status);
      setStatus(getRunningStatusText(message.status), paused ? 'paused' : 'running');
      renderStepStatus(message.status.stepStatus || null);
      setProgress(getProgressPosition(message.status), total);
    } else if (message?.type === 'AUTOMATION_COMPLETE') {
      const reason = message.reason;
      const status = message.status;
      latestAutomationStatus = status || { running: false, paused: false, total: 0, currentIndex: 0 };
      const lastFailureError = status?.parallelLastFailure?.error;
      if (reason === 'stoppedByStopWord') {
        setStatus('Stopped by stop phrase', 'idle');
      } else if (reason === 'completedWithErrors') {
        setStatus(lastFailureError ? `Complete with errors: ${lastFailureError}` : 'Complete with errors', 'error');
      } else {
        setStatus('Complete', 'idle');
      }
      if (status?.total && typeof status.currentIndex === 'number') {
        const progressPos = status.mode === 'parallel'
          ? Number(status.parallelCompleted || 0) + Number(status.parallelFailed || 0)
          : status.currentIndex;
        setProgress(progressPos, status.total);
      } else {
        setProgress(1, 1);
      }
      setButtonsDisabled(false);
      clearError();
      const toastMessage = reason === 'stoppedByStopWord'
        ? '✓ Automation stopped by stop phrase'
        : reason === 'completedWithErrors'
          ? (lastFailureError ? `Finished with failures. Last error: ${lastFailureError}` : 'Finished with some failed prompts')
          : '✓ Automation complete!';
      const toastKind = reason === 'completedWithErrors' ? 'info' : 'success';
      showToast(toastMessage, toastKind);
      stopCountdownTimer();
      renderStepStatus(null);
      updateControlButtons({ running: false, paused: false });
    } else if (message?.type === 'AUTOMATION_ERROR') {
      latestAutomationStatus = { ...(latestAutomationStatus || {}), running: false, paused: false };
      setStatus(`Error: ${message.error}`, 'error');
      setButtonsDisabled(false);
      showToast(`✗ Error: ${message.error}`, 'error', 5000);
      showError(
        `Automation Error: ${message.error}`,
        message.details || 'No additional details available',
        message.stack || 'No stack trace available'
      );
      stopCountdownTimer();
      renderStepStatus({ step: 'error', label: 'Error', color: 'error', detail: message.error || '' });
      // Refresh status after error to show proper state
      setTimeout(refreshStatus, 1000);
      updateControlButtons({ running: false, paused: false });
    } else if (message?.type === 'PROMPT_STEP_STATUS') {
      renderStepStatus(message.status || null);
    } else if (message?.type === 'SELECTOR_HEALTH' || message?.type === 'SELECTOR_HEALTH_UPDATE') {
      renderSelectorHealth(message.health || null);
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

  const doCountdown = () => {
    if (signal.aborted) return;

    const countdownEl = document.getElementById('stableCountdown');
    const countdownValue = document.getElementById('countdownValue');
    if (!countdownEl || !countdownValue) return;

    const status = latestAutomationStatus;
    const running = status?.running === true && status?.paused !== true;
    if (running) {
      const stableMs =
        Number(status?.stableCountdownMs) ||
        Number(status?.options?.stableMs) ||
        secToMs(Number(document.getElementById('stableMaxSec')?.value)) ||
        1200;

      countdownEl.style.display = 'block';
      const elapsed = Date.now() - lastActivityTime;
      const remaining = Math.max(0, stableMs - elapsed);
      countdownValue.textContent = (remaining / 1000).toFixed(1);
    } else {
      countdownEl.style.display = 'none';
    }

    if (!signal.aborted) {
      setTimeout(doCountdown, 250);
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
    if (!data.history || !Array.isArray(data.history) || data.history.length === 0) {
      return;
    }

    const validItems = data.history.filter((item) => (
      item &&
      typeof item === 'object' &&
      Array.isArray(item.prompts) &&
      item.prompts.length > 0
    ));
    if (validItems.length === 0) {
      return;
    }

    const { aiTaskSequencerHistory = [] } = await chrome.storage.local.get('aiTaskSequencerHistory');
    const makeSignature = (item) => JSON.stringify((item?.prompts || []).map((p) => (typeof p === 'string' ? p.trim() : '')));
    const existingSignatures = new Set(aiTaskSequencerHistory.map(makeSignature));
    const newItems = validItems.filter((item) => !existingSignatures.has(makeSignature(item)));
    if (newItems.length === 0) {
      return;
    }

    if (confirm(`Found sample-export.json with ${newItems.length} new prompt set(s). Load now?`)) {
      await importSampleData({ history: newItems });
    }
  } catch (e) {
    // File doesn't exist or can't be read - that's fine
    console.log('[SampleExport] No sample-export.json found or error:', e.message);
  }
}

async function importSampleData(importData) {
  try {
    const result = await importHistoryItems(importData);
    if (result.imported === 0) {
      if (result.duplicates > 0) {
        showToast('Sample prompts already loaded', 'success');
      } else {
        showToast('No valid items in sample file', 'error');
      }
      return;
    }
    await loadHistoryIntoUI();
    showToast(`✓ Loaded ${result.imported} item(s) from sample`, 'success');
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

    await getContextTabId();
    initInfoPopovers();
    await loadParallelWalkthroughVisibility();
    await loadSettingsIntoUI();
    await loadMemorySettingsIntoUI();
    initMemoryPackUI({ getContextTabId });
    initPromptQueueReorder({
      textarea: promptsTextarea,
      separatorInput,
      appendInput: document.getElementById('appendPromptText'),
      prependInput: document.getElementById('systemPrompt'),
      onChange: updatePromptCount,
    });
    refreshWrapperPromptTextareaHeights();
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

document.getElementById('memoryHeader')?.addEventListener('click', () => {
  const toggle = document.querySelector('#memoryHeader .collapsible-toggle');
  const content = document.getElementById('memoryContent');
  toggle?.classList.toggle('collapsed');
  content?.classList.toggle('collapsed');
});

document.getElementById('memorySettingsHeader')?.addEventListener('click', () => {
  const toggle = document.querySelector('#memorySettingsHeader .collapsible-toggle');
  const content = document.getElementById('memorySettingsContent');
  toggle?.classList.toggle('collapsed');
  content?.classList.toggle('collapsed');
});


// Prompt counter
const promptsTextarea = document.getElementById('prompts');
const updatePromptCount = () => {
  if (!promptsTextarea) return;
  const separator = resolveSeparator(separatorInput?.value);
  const appendText = document.getElementById('appendPromptText')?.value?.trim() || '';
  const prependText = document.getElementById('systemPrompt')?.value?.trim() || '';
  const launchPlan = buildPromptLaunchPlan(promptsTextarea.value, separator, appendText, prependText, {
    enableDuplicateTypoVariants: document.getElementById('enableDuplicateTypoVariants')?.checked === true,
  });
  const prompts = launchPlan.prompts;
  const tabGroups = launchPlan.tabPromptGroups.length;
  const counter = document.querySelector('.prompt-counter');
  if (counter) {
    const base = `${prompts.length} prompt${prompts.length !== 1 ? 's' : ''} loaded`;
    counter.textContent = launchPlan.hasTabMarkers
      ? `${base} · ${tabGroups} tab set${tabGroups !== 1 ? 's' : ''}`
      : base;
  }
  refreshPromptQueueReorder();
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

function autoResizeTextarea(el, {
  active = false,
  maxViewportRatio = 0.7,
  minHeight = 120,
  collapsedHeight = 80,
  padding = 8,
} = {}) {
  if (!el) return;
  const maxHeight = Math.floor(window.innerHeight * maxViewportRatio);
  el.classList.toggle('is-active', active);
  if (!active && document.activeElement !== el) {
    el.style.height = `${collapsedHeight}px`;
    return;
  }
  el.style.height = 'auto';
  const nextHeight = Math.min(Math.max(minHeight, el.scrollHeight + padding), maxHeight);
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

const wrapperPromptTextareas = ['systemPrompt', 'appendPromptText']
  .map((id) => document.getElementById(id))
  .filter(Boolean);

function refreshWrapperPromptTextareaHeights() {
  wrapperPromptTextareas.forEach((el) => {
    autoResizeTextarea(el, {
      active: document.activeElement === el,
      maxViewportRatio: 0.45,
      minHeight: 120,
      collapsedHeight: 72,
      padding: 6,
    });
  });
}

wrapperPromptTextareas.forEach((el) => {
  const resizeActive = () => autoResizeTextarea(el, {
    active: true,
    maxViewportRatio: 0.45,
    minHeight: 120,
    collapsedHeight: 72,
    padding: 6,
  });
  const resizeInactive = () => autoResizeTextarea(el, {
    active: false,
    maxViewportRatio: 0.45,
    minHeight: 72,
    collapsedHeight: 72,
    padding: 6,
  });
  el.addEventListener('input', resizeActive);
  el.addEventListener('focus', resizeActive);
  el.addEventListener('blur', resizeInactive);
});

window.addEventListener('resize', refreshWrapperPromptTextareaHeights);
refreshWrapperPromptTextareaHeights();

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
    const messageTabId = Number(message?.tabId);
    if (!Number.isInteger(messageTabId) || !Number.isInteger(currentPanelTabId) || messageTabId === currentPanelTabId) {
      window.close();
    }
  }
});

// Load transcription state on initialization
document.addEventListener('DOMContentLoaded', () => {
  loadTranscriptionState();
});

// Initialization is handled by DOMContentLoaded event listener above
