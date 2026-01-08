import { applyConsolePatch } from './popup-console-patch.js';
import { msToSec, secToMs, applyTheme } from './popup-dom-utils.js';

// Initialization and helpers for settings UI
export async function loadSettingsIntoUI() {
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
      document.getElementById('openNewChatPerPrompt').checked = s.openNewChatPerPrompt === true;
      document.getElementById('openNewChatPerPromptUrl').value = s.openNewChatPerPromptUrl || '';

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

export async function saveSettingsFromUI() {
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
      openNewChatPerPrompt: document.getElementById('openNewChatPerPrompt').checked,
      openNewChatPerPromptUrl: (document.getElementById('openNewChatPerPromptUrl').value || '').trim(),
    };
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
  } catch (e) {
    console.error('[SaveSettings] Error:', e);
  }
}

export function initSettingsUI() {
  applyConsolePatch();

  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.addEventListener('change', async (e) => {
      const val = e.target.value;
      applyTheme(val);
      try {
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { theme: val } });
      } catch (err) {
        console.error('[ThemeChange] Error:', err);
      }
    });
  }

  ['maxWaitSec', 'stableSec', 'pollSec', 'systemPrompt', 'prependSystemPrompt', 'enableMaxWaitTimeout'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettingsFromUI);
  });

  const enableMaxWaitTimeoutCheckbox = document.getElementById('enableMaxWaitTimeout');
  if (enableMaxWaitTimeoutCheckbox) {
    enableMaxWaitTimeoutCheckbox.addEventListener('change', saveSettingsFromUI);
  }

  const enableStopWordCheckbox = document.getElementById('enableStopWord');
  const stopWordContainer = document.getElementById('stopWordContainer');
  const stopWordInput = document.getElementById('stopWord');
  const stopWordCaseSensitiveCheckbox = document.getElementById('stopWordCaseSensitive');
  const openNewChatPerPromptCheckbox = document.getElementById('openNewChatPerPrompt');
  const openNewChatPerPromptUrlInput = document.getElementById('openNewChatPerPromptUrl');

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

  if (openNewChatPerPromptCheckbox) {
    openNewChatPerPromptCheckbox.addEventListener('change', saveSettingsFromUI);
  }

  if (openNewChatPerPromptUrlInput) {
    openNewChatPerPromptUrlInput.addEventListener('change', saveSettingsFromUI);
    openNewChatPerPromptUrlInput.addEventListener('blur', saveSettingsFromUI);
  }
}
