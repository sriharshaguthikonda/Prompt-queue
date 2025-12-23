import { showHistoryLoading, showToast } from './popup-dom-utils.js';
import { loadSettingsIntoUI } from './popup-settings.js';

function makeSignature(item) {
  return JSON.stringify((item.prompts || []).map((p) => p.trim()));
}

export function createHistoryRow(item, index, { onLoadPrompts } = {}) {
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

  const { aiTaskSequencerHistory = [] } = await chrome.storage.local.get('aiTaskSequencerHistory');
  const existingSignatures = new Set(aiTaskSequencerHistory.map(makeSignature));

  const newItems = validItems.filter((item) => !existingSignatures.has(makeSignature(item)));
  const itemsWithTimestamp = newItems.map((item) => ({
    ...item,
    savedAt: item.savedAt || Date.now(),
  }));

  const mergedHistory = [...itemsWithTimestamp, ...aiTaskSequencerHistory].slice(0, 50);
  await chrome.storage.local.set({ aiTaskSequencerHistory: mergedHistory });

  return { imported: newItems.length, duplicates: validItems.length - newItems.length, invalid: invalidCount };
}

export async function clearHistory() {
  await chrome.storage.local.set({ aiTaskSequencerHistory: [] });
}

export async function exportHistory() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
  if (!res?.ok || !res.history) return null;
  const exportData = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    history: res.history,
  };
  return exportData;
}

export async function saveHistoryItem(prompts, settings) {
  await chrome.runtime.sendMessage({
    type: 'SAVE_PROMPT_HISTORY',
    item: { prompts, settings },
  });
}
