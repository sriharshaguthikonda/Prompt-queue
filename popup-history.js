import { showHistoryLoading, showToast } from './popup-dom-utils.js';
import { loadSettingsIntoUI } from './popup-settings.js';

const PQ_CONSTANTS = globalThis.PromptQueueConstants || {};
const MESSAGE_TYPES = PQ_CONSTANTS.MESSAGE_TYPES || {};
const STORAGE_KEYS = PQ_CONSTANTS.STORAGE_KEYS || {};
const HISTORY_STORAGE_KEY = STORAGE_KEYS.HISTORY || 'aiTaskSequencerHistory';

function makeSignature(item) {
  return JSON.stringify((item.prompts || []).map((p) => p.trim()));
}

function settingsWithoutTheme(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const { theme: _theme, ...rest } = settings;
  return rest;
}

export function createHistoryRow(item, index, { onLoadPrompts } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'history-item';
  const title = item.title || (item.prompts?.slice(0, 1)?.[0] || '').slice(0, 80);
  const date = new Date(item.savedAt || Date.now()).toLocaleString();

  const row = document.createElement('div');
  row.className = 'history-row';

  const left = document.createElement('div');
  left.className = 'history-main';

  const titleEl = document.createElement('div');
  titleEl.className = 'history-item-title';
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
    const queueSettings = settingsWithoutTheme(item.settings);
    if (queueSettings) {
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SAVE_SETTINGS || 'SAVE_SETTINGS', settings: queueSettings });
      await loadSettingsIntoUI();
    }
    if (typeof onLoadPrompts === 'function') {
      onLoadPrompts();
    }
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DELETE_PROMPT_HISTORY', index });
    await loadHistoryIntoUI(onLoadPrompts);
  });

  ctrls.appendChild(loadBtn);
  ctrls.appendChild(delBtn);

  row.appendChild(left);
  row.appendChild(ctrls);
  wrapper.appendChild(row);
  return wrapper;
}

export async function loadHistoryIntoUI(onLoadPrompts) {
  try {
    const list = document.getElementById('history');
    const countBadge = document.getElementById('historyCount');
    const clearBtn = document.getElementById('clearHistoryBtn');

    if (!list) {
      console.error('[LoadHistory] History list element not found');
      return;
    }

    showHistoryLoading(true);

    await new Promise((r) => setTimeout(r, 300));

    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_PROMPT_HISTORY || 'GET_PROMPT_HISTORY' });
    if (res?.ok) {
      const history = res.history || [];
      if (countBadge) {
        countBadge.textContent = `${history.length} item${history.length !== 1 ? 's' : ''}`;
      }
      if (clearBtn) {
        clearBtn.style.display = history.length > 0 ? 'block' : 'none';
      }
      history.forEach((item, idx) => {
        list.appendChild(createHistoryRow(item, idx, { onLoadPrompts }));
      });
    }

    showHistoryLoading(false);
  } catch (e) {
    console.error('[LoadHistory] Error:', e);
    showHistoryLoading(false);
  }
}

export async function importHistoryItems(importData) {
  if (!importData?.history || !Array.isArray(importData.history)) {
    throw new Error('Invalid JSON format');
  }

  const validItems = importData.history.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    if (!Array.isArray(item.prompts) || item.prompts.length === 0) return false;
    return true;
  });

  const invalidCount = importData.history.length - validItems.length;
  if (validItems.length === 0) {
    return { imported: 0, duplicates: 0, invalid: invalidCount };
  }

  const storedHistory = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  const aiTaskSequencerHistory = Array.isArray(storedHistory?.[HISTORY_STORAGE_KEY]) ? storedHistory[HISTORY_STORAGE_KEY] : [];
  const existingSignatures = new Set(aiTaskSequencerHistory.map(makeSignature));

  const newItems = validItems.filter((item) => !existingSignatures.has(makeSignature(item)));
  const itemsWithTimestamp = newItems.map((item) => ({
    ...item,
    savedAt: item.savedAt || Date.now(),
  }));

  const mergedHistory = [...itemsWithTimestamp, ...aiTaskSequencerHistory].slice(0, 50);
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: mergedHistory });

  return { imported: newItems.length, duplicates: validItems.length - newItems.length, invalid: invalidCount };
}

export async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [] });
  await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURED_RESPONSES' }).catch(() => {});
}

export async function exportHistory() {
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_PROMPT_HISTORY || 'GET_PROMPT_HISTORY' });
  if (!res?.ok || !res.history) return null;
  const responseRes = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_CAPTURED_RESPONSES || 'GET_CAPTURED_RESPONSES' }).catch(() => null);
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    history: res.history,
    responses: responseRes?.ok && Array.isArray(responseRes.responses) ? responseRes.responses : [],
  };
  return exportData;
}

function mdEscape(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

export function exportHistoryMarkdown(exportData) {
  if (!exportData) return '';
  const lines = [
    '# Prompt Queue Export',
    '',
    `Exported: ${exportData.exportedAt || new Date().toISOString()}`,
    '',
    '## Prompt Sets',
    '',
  ];
  const history = Array.isArray(exportData.history) ? exportData.history : [];
  if (history.length === 0) {
    lines.push('_No saved prompt sets._', '');
  } else {
    history.forEach((item, index) => {
      lines.push(`### Prompt Set ${index + 1}`, '');
      (item.prompts || []).forEach((prompt, promptIndex) => {
        lines.push(`#### Prompt ${promptIndex + 1}`, '', '```text', mdEscape(prompt), '```', '');
      });
    });
  }

  lines.push('## Captured Responses', '');
  const responses = Array.isArray(exportData.responses) ? exportData.responses : [];
  if (responses.length === 0) {
    lines.push('_No captured responses._', '');
  } else {
    responses.forEach((item, index) => {
      lines.push(`### Response ${index + 1}`, '');
      if (item.promptPreview) lines.push(`Prompt: ${mdEscape(item.promptPreview)}`, '');
      if (item.durationMs) lines.push(`Duration: ${Math.round(item.durationMs / 1000)}s`, '');
      lines.push('```text', mdEscape(item.responseText), '```', '');
    });
  }
  return `${lines.join('\n').trim()}\n`;
}

export async function saveHistoryItem(prompts, settings) {
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SAVE_PROMPT_HISTORY || 'SAVE_PROMPT_HISTORY',
    item: { prompts, settings },
  });
}
