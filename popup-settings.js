import { applyConsolePatch, setDebugLoggingEnabled } from './popup-console-patch.js';
import { msToSec, secToMs, applyTheme, showToast } from './popup-dom-utils.js';
import {
  applyTargetSelectorErrors,
  ensureTargetSettingsUI,
  initTargetSettingsUI,
  loadTargetSettingsIntoUI,
  validateAndNormalizeTargetSettingsFromUI,
} from './popup-target-settings.js';
import {
  ensureSendTimingSettingsUI,
  initSendTimingSettingsUI,
  loadSendTimingSettingsIntoUI,
  readSendTimingSettingsFromUI,
} from './popup-send-settings.js';

function applyMaxWaitSemanticsText() {
  const checkbox = document.getElementById('enableMaxWaitTimeout');
  if (!checkbox) return;
  const label = document.querySelector('label[for="enableMaxWaitTimeout"]');
  if (label) {
    label.textContent = 'Wait indefinitely for response';
  }
  const helpText = checkbox.parentElement?.querySelector('.info-popover');
  if (helpText) {
    helpText.textContent = 'When checked, the extension monitors until the response completes. When unchecked, Max wait is the per-prompt response timeout.';
  }
}

// Initialization and helpers for settings UI
export async function loadSettingsIntoUI() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.ok && res.settings) {
      const s = res.settings;
      ensureTargetSettingsUI();
      ensureSendTimingSettingsUI();
      applyMaxWaitSemanticsText();
      applyTheme(s.theme || 'dark');
      document.getElementById('maxWaitSec').value = msToSec(s.maxWaitMs);
      document.getElementById('stableMinSec').value = msToSec(s.stableMinMs ?? s.stableMs);
      document.getElementById('stableMaxSec').value = msToSec(s.stableMaxMs ?? s.stableMs);
      document.getElementById('pollSec').value = msToSec(s.pollIntervalMs);
      document.getElementById('enableRetryOnFailure').checked = s.enableRetryOnFailure !== false;
      document.getElementById('maxRetriesPerPrompt').value = Number.isFinite(Number(s.maxRetriesPerPrompt)) ? Number(s.maxRetriesPerPrompt) : 2;
      document.getElementById('retryDelaySec').value = msToSec(s.retryDelayMs);
      document.getElementById('systemPrompt').value = s.systemPrompt || '';
      document.getElementById('appendPromptText').value = s.appendPromptText || '';
      document.getElementById('prependSystemPrompt').checked = s.prependSystemPrompt !== false;
      document.getElementById('appendSystemPrompt').checked = s.appendSystemPrompt === true;
      document.getElementById('enableMaxWaitTimeout').checked = s.enableMaxWaitTimeout !== false;
      document.getElementById('autoConfirmDialogs').checked = s.autoConfirmDialogs === true;
      document.getElementById('enableWatchedElementGate').checked = s.enableWatchedElementGate === true;
      document.getElementById('watchedElementSelector').value = s.watchedElementSelector || '';
      document.getElementById('enableStopWord').checked = s.enableStopWord === true;
      document.getElementById('stopWord').value = s.stopWord || '';
      document.getElementById('stopWordCaseSensitive').checked = s.stopWordCaseSensitive === true;
      document.getElementById('refreshTabBeforeEachPrompt').checked = s.refreshTabBeforeEachPrompt === true;
      const parallelOneTabPerPrompt = document.getElementById('parallelOneTabPerPrompt');
      if (parallelOneTabPerPrompt) {
        parallelOneTabPerPrompt.checked = s.parallelOneTabPerPrompt === true;
      }
      document.getElementById('debugLoggingEnabled').checked = s.debugLoggingEnabled === true;
      document.getElementById('openNewChatPerPrompt').checked = s.openNewChatPerPrompt === true;
      document.getElementById('openNewChatPerPromptUrl').value = s.openNewChatPerPromptUrl || '';
      loadSendTimingSettingsIntoUI(s);
      loadTargetSettingsIntoUI(s);
      setDebugLoggingEnabled(s.debugLoggingEnabled === true);

      const stopWordContainer = document.getElementById('stopWordContainer');
      const watchedElementContainer = document.getElementById('watchedElementContainer');
      if (s.enableStopWord === true) {
        stopWordContainer.classList.remove('hidden');
      } else {
        stopWordContainer.classList.add('hidden');
      }
      if (s.enableWatchedElementGate === true) {
        watchedElementContainer.classList.remove('hidden');
      } else {
        watchedElementContainer.classList.add('hidden');
      }
    }
  } catch (e) {
    console.error('[LoadSettings] Error:', e);
  }
}

export async function saveSettingsFromUI() {
  let settings = null;
  try {
    const maxWaitSec = Number(document.getElementById('maxWaitSec').value);
    const stableMinSec = Number(document.getElementById('stableMinSec').value);
    const stableMaxSec = Number(document.getElementById('stableMaxSec').value);
    const stableMinOrdered = Math.min(stableMinSec, stableMaxSec || stableMinSec);
    const stableMaxOrdered = Math.max(stableMinSec || stableMaxSec, stableMaxSec || stableMinSec);
    const pollSec = Number(document.getElementById('pollSec').value);
    const targetValidation = validateAndNormalizeTargetSettingsFromUI({ applyNormalized: true });
    applyTargetSelectorErrors(targetValidation.errors);
    if (Object.keys(targetValidation.errors).length > 0) {
      throw new Error('Invalid selector in custom targets');
    }

    settings = {
      theme: document.getElementById('themeSelect')?.value || 'dark',
      maxWaitMs: secToMs(maxWaitSec),
      stableMinMs: secToMs(stableMinOrdered),
      stableMaxMs: secToMs(stableMaxOrdered),
      pollIntervalMs: secToMs(pollSec),
      enableRetryOnFailure: document.getElementById('enableRetryOnFailure').checked,
      maxRetriesPerPrompt: Number(document.getElementById('maxRetriesPerPrompt').value),
      retryDelayMs: secToMs(Number(document.getElementById('retryDelaySec').value)),
      systemPrompt: document.getElementById('systemPrompt').value || '',
      appendPromptText: document.getElementById('appendPromptText').value || '',
      prependSystemPrompt: document.getElementById('prependSystemPrompt').checked,
      appendSystemPrompt: document.getElementById('appendSystemPrompt').checked,
      enableMaxWaitTimeout: document.getElementById('enableMaxWaitTimeout').checked,
      autoConfirmDialogs: document.getElementById('autoConfirmDialogs').checked,
      enableWatchedElementGate: document.getElementById('enableWatchedElementGate').checked,
      watchedElementSelector: (document.getElementById('watchedElementSelector').value || '').trim(),
      enableStopWord: document.getElementById('enableStopWord').checked,
      stopWord: document.getElementById('stopWord').value || '',
      stopWordCaseSensitive: document.getElementById('stopWordCaseSensitive').checked,
      refreshTabBeforeEachPrompt: document.getElementById('refreshTabBeforeEachPrompt').checked,
      parallelOneTabPerPrompt: document.getElementById('parallelOneTabPerPrompt')?.checked === true,
      debugLoggingEnabled: document.getElementById('debugLoggingEnabled').checked,
      openNewChatPerPrompt: document.getElementById('openNewChatPerPrompt').checked,
      openNewChatPerPromptUrl: (document.getElementById('openNewChatPerPromptUrl').value || '').trim(),
      targetSelectors: targetValidation.targetSelectors,
      ...readSendTimingSettingsFromUI(),
    };
    settings.watchedElementSelector = settings.targetSelectors.watchedElement || settings.watchedElementSelector;
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (!response?.ok) {
      if (response?.validationErrors) {
        applyTargetSelectorErrors(response.validationErrors);
      }
      throw new Error(response?.error || 'Failed to save settings');
    }
    return settings;
  } catch (e) {
    console.error('[SaveSettings] Error:', e);
    showToast(e?.message || 'Failed to save settings', 'error');
    return settings;
  }
}

export function initSettingsUI() {
  applyConsolePatch(undefined, false);
  ensureTargetSettingsUI();
  ensureSendTimingSettingsUI();
  applyMaxWaitSemanticsText();

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

  ['maxWaitSec', 'stableMinSec', 'stableMaxSec', 'pollSec', 'enableRetryOnFailure', 'maxRetriesPerPrompt', 'retryDelaySec', 'systemPrompt', 'appendPromptText', 'prependSystemPrompt', 'appendSystemPrompt', 'enableMaxWaitTimeout', 'autoConfirmDialogs', 'enableWatchedElementGate', 'watchedElementSelector', 'refreshTabBeforeEachPrompt', 'parallelOneTabPerPrompt'].forEach((id) => {
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
  const enableWatchedElementGateCheckbox = document.getElementById('enableWatchedElementGate');
  const watchedElementContainer = document.getElementById('watchedElementContainer');
  const watchedElementSelectorInput = document.getElementById('watchedElementSelector');
  const useChatgptActionSelectorBtn = document.getElementById('useChatgptActionSelector');
  const debugLoggingEnabledCheckbox = document.getElementById('debugLoggingEnabled');
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

  if (enableWatchedElementGateCheckbox) {
    enableWatchedElementGateCheckbox.addEventListener('change', () => {
      if (enableWatchedElementGateCheckbox.checked) {
        watchedElementContainer.classList.remove('hidden');
        watchedElementSelectorInput.focus();
      } else {
        watchedElementContainer.classList.add('hidden');
      }
      saveSettingsFromUI();
    });
  }

  if (watchedElementSelectorInput) {
    watchedElementSelectorInput.addEventListener('input', saveSettingsFromUI);
  }

  if (useChatgptActionSelectorBtn) {
    useChatgptActionSelectorBtn.addEventListener('click', () => {
      watchedElementSelectorInput.value = 'button[data-testid="copy-turn-action-button"]';
      if (enableWatchedElementGateCheckbox && !enableWatchedElementGateCheckbox.checked) {
        enableWatchedElementGateCheckbox.checked = true;
        watchedElementContainer.classList.remove('hidden');
      }
      saveSettingsFromUI();
    });
  }

  if (debugLoggingEnabledCheckbox) {
    debugLoggingEnabledCheckbox.addEventListener('change', () => {
      setDebugLoggingEnabled(debugLoggingEnabledCheckbox.checked);
      saveSettingsFromUI();
    });
  }

  if (openNewChatPerPromptCheckbox) {
    openNewChatPerPromptCheckbox.addEventListener('change', saveSettingsFromUI);
  }

  if (openNewChatPerPromptUrlInput) {
    openNewChatPerPromptUrlInput.addEventListener('change', saveSettingsFromUI);
    openNewChatPerPromptUrlInput.addEventListener('blur', saveSettingsFromUI);
  }

  initTargetSettingsUI({ onSettingsChanged: saveSettingsFromUI });
  initSendTimingSettingsUI({ onSettingsChanged: saveSettingsFromUI });
}
