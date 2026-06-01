import { showToast } from './popup-dom-utils.js';

const ROLE_CONFIG = [
  { key: 'promptInput', label: 'Prompt input selector', placeholder: 'CSS selector for the prompt textbox' },
  { key: 'sendButton', label: 'Send button selector', placeholder: 'CSS selector for the send button' },
  { key: 'stopButton', label: 'Stop button selector', placeholder: 'CSS selector for the stop button' },
];
const BUTTON_CONTEXT_ROLES = new Set(['sendButton', 'stopButton', 'watchedElement']);

function targetInputId(role) {
  return `targetSelector_${role}`;
}

function buildRow(role) {
  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '8px';

  const label = document.createElement('label');
  label.htmlFor = targetInputId(role.key);
  label.textContent = role.label;
  label.style.display = 'block';
  label.style.marginBottom = '4px';
  label.style.fontSize = '12px';

  const controls = document.createElement('div');
  controls.style.display = 'grid';
  controls.style.gridTemplateColumns = '1fr auto auto';
  controls.style.gap = '6px';
  controls.style.alignItems = 'center';

  const input = document.createElement('input');
  input.id = targetInputId(role.key);
  input.type = 'text';
  input.placeholder = role.placeholder;
  input.className = 'stop-word-input';
  input.style.width = '100%';
  input.style.padding = '8px';
  input.style.border = '1px solid var(--border)';
  input.style.borderRadius = '6px';
  input.style.background = 'var(--input-bg)';
  input.style.color = 'var(--text)';
  input.style.fontSize = '12px';

  const pickButton = document.createElement('button');
  pickButton.type = 'button';
  pickButton.className = 'preset-btn';
  pickButton.textContent = 'Pick';
  pickButton.dataset.targetRole = role.key;

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'preset-btn';
  clearButton.textContent = 'Clear';
  clearButton.dataset.clearTargetRole = role.key;

  controls.append(input, pickButton, clearButton);
  wrapper.append(label, controls);
  return wrapper;
}

function getTargetInput(role) {
  const targetId = role === 'watchedElement' ? 'watchedElementSelector' : targetInputId(role);
  return document.getElementById(targetId);
}

function setFieldError(role, message) {
  const input = getTargetInput(role);
  if (!input) return;
  input.dataset.selectorError = message || '';
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  input.style.borderColor = message ? '#e65054' : 'var(--border)';
  input.title = message || '';
}

function isValidCssSelector(selector) {
  if (!selector) return true;
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeCommonDataTestIdPattern(rawValue, role) {
  const trimmed = String(rawValue || '').trim();
  if (!trimmed) return { value: '', normalized: false };

  const hashMatch = trimmed.match(/^data-testid#([a-zA-Z0-9_.:-]+)$/);
  if (hashMatch) {
    const base = `[data-testid="${hashMatch[1]}"]`;
    return { value: BUTTON_CONTEXT_ROLES.has(role) ? `button${base}` : base, normalized: true };
  }

  const equalsMatch = trimmed.match(/^data-testid\s*=\s*["']?([a-zA-Z0-9_.:-]+)["']?$/);
  if (equalsMatch) {
    const base = `[data-testid="${equalsMatch[1]}"]`;
    return { value: BUTTON_CONTEXT_ROLES.has(role) ? `button${base}` : base, normalized: true };
  }

  return { value: trimmed, normalized: false };
}

function normalizeAndValidateRoleSelector(role, rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!trimmed) return { value: '', error: null, normalized: false };

  const normalized = normalizeCommonDataTestIdPattern(trimmed, role);
  if (!isValidCssSelector(normalized.value)) {
    return { value: trimmed, error: 'Invalid CSS selector', normalized: false };
  }
  return { value: normalized.value, error: null, normalized: normalized.normalized };
}

export function ensureTargetSettingsUI() {
  const container = document.getElementById('watchedElementContainer');
  if (!container) return null;

  const existingWatchedButtons = container.querySelector('.history-buttons');
  if (existingWatchedButtons && !document.getElementById('pickWatchedElementSelector')) {
    const pickWatched = document.createElement('button');
    pickWatched.id = 'pickWatchedElementSelector';
    pickWatched.type = 'button';
    pickWatched.className = 'preset-btn';
    pickWatched.textContent = 'Pick watched element';
    pickWatched.dataset.targetRole = 'watchedElement';
    existingWatchedButtons.appendChild(pickWatched);
  }

  let section = document.getElementById('targetSelectorsSection');
  if (section) return section;

  section = document.createElement('div');
  section.id = 'targetSelectorsSection';
  section.style.marginTop = '10px';
  section.style.paddingTop = '10px';
  section.style.borderTop = '1px solid var(--border)';

  const title = document.createElement('div');
  title.textContent = 'Optional custom targets';
  title.style.fontSize = '12px';
  title.style.fontWeight = '600';
  title.style.marginBottom = '6px';
  section.appendChild(title);

  ROLE_CONFIG.forEach((role) => section.appendChild(buildRow(role)));
  container.appendChild(section);
  return section;
}

export function loadTargetSettingsIntoUI(settings = {}) {
  ensureTargetSettingsUI();
  const targetSelectors = settings?.targetSelectors || {};
  ROLE_CONFIG.forEach((role) => {
    const input = document.getElementById(targetInputId(role.key));
    if (input) input.value = targetSelectors[role.key] || '';
  });

  const watchedInput = document.getElementById('watchedElementSelector');
  if (watchedInput) {
    watchedInput.value = targetSelectors.watchedElement || settings?.watchedElementSelector || watchedInput.value || '';
  }
}

export function readTargetSettingsFromUI() {
  return validateAndNormalizeTargetSettingsFromUI({ applyNormalized: true }).targetSelectors;
}

export function validateAndNormalizeTargetSettingsFromUI({ applyNormalized = false } = {}) {
  ensureTargetSettingsUI();
  const targetSelectors = {};
  const errors = {};

  ROLE_CONFIG.forEach((role) => {
    const input = getTargetInput(role.key);
    const result = normalizeAndValidateRoleSelector(role.key, input?.value || '');
    targetSelectors[role.key] = result.value;
    if (result.error) errors[role.key] = result.error;
    if (applyNormalized && input && result.value !== input.value) input.value = result.value;
    setFieldError(role.key, result.error);
  });

  const watchedInput = getTargetInput('watchedElement');
  const watchedResult = normalizeAndValidateRoleSelector('watchedElement', watchedInput?.value || '');
  targetSelectors.watchedElement = watchedResult.value;
  if (watchedResult.error) errors.watchedElement = watchedResult.error;
  if (applyNormalized && watchedInput && watchedResult.value !== watchedInput.value) watchedInput.value = watchedResult.value;
  setFieldError('watchedElement', watchedResult.error);

  return { targetSelectors, errors };
}

export function applyTargetSelectorErrors(errorMap = {}) {
  const allRoles = [...ROLE_CONFIG.map((role) => role.key), 'watchedElement'];
  allRoles.forEach((role) => setFieldError(role, errorMap?.[role] || ''));
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

async function runPicker(role, onSettingsChanged) {
  const tabId = await getActiveTabId();
  if (!Number.isInteger(tabId)) {
    showToast('No active tab for picker', 'error');
    return;
  }

  const buttons = Array.from(document.querySelectorAll(`[data-target-role="${role}"]`));
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = 'Picking...';
  });

  try {
    showToast(`Click the ${role} element in the page`, 'info', 2500);
    const response = await chrome.runtime.sendMessage({ type: 'START_TARGET_PICKER', tabId, role });
    if (!response?.ok || !response.selector) {
      if (!response?.cancelled) {
        showToast(response?.error || 'Picker failed', 'error');
      }
      return;
    }

    const targetId = role === 'watchedElement' ? 'watchedElementSelector' : targetInputId(role);
    const input = document.getElementById(targetId);
    if (input) {
      input.value = response.selector;
      await onSettingsChanged?.();
      showToast('Selector captured', 'success');
    }
  } catch (error) {
    showToast(error?.message || String(error), 'error');
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.textContent = button.id === 'pickWatchedElementSelector' ? 'Pick watched element' : 'Pick';
    });
  }
}

export function initTargetSettingsUI({ onSettingsChanged }) {
  ensureTargetSettingsUI();

  ROLE_CONFIG.forEach((role) => {
    const input = document.getElementById(targetInputId(role.key));
    if (input && !input.dataset.targetInitDone) {
      input.dataset.targetInitDone = 'true';
      input.addEventListener('input', () => setFieldError(role.key, ''));
      input.addEventListener('change', () => onSettingsChanged?.());
      input.addEventListener('blur', () => onSettingsChanged?.());
    }
  });

  const watchedInput = document.getElementById('watchedElementSelector');
  if (watchedInput && !watchedInput.dataset.targetInitDone) {
    watchedInput.dataset.targetInitDone = 'true';
    watchedInput.addEventListener('input', () => setFieldError('watchedElement', ''));
    watchedInput.addEventListener('blur', () => onSettingsChanged?.());
  }

  document.querySelectorAll('[data-target-role]').forEach((button) => {
    if (button.dataset.targetPickerInitDone) return;
    button.dataset.targetPickerInitDone = 'true';
    button.addEventListener('click', () => runPicker(button.dataset.targetRole, onSettingsChanged));
  });

  document.querySelectorAll('[data-clear-target-role]').forEach((button) => {
    if (button.dataset.targetClearInitDone) return;
    button.dataset.targetClearInitDone = 'true';
    button.addEventListener('click', async () => {
      const role = button.dataset.clearTargetRole;
      const input = document.getElementById(targetInputId(role));
      if (input) {
        input.value = '';
        await onSettingsChanged?.();
      }
    });
  });
}
