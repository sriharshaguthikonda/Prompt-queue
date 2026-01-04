// DOM + UI helpers used by popup.js

export const PROMPT_SEPARATOR = [
  '---------------------------------------------------',
  '------------------Next prompt------------------',
  '---------------------------------------------------',
].join('\n');

export function parsePrompts(text, separator = PROMPT_SEPARATOR) {
  if (typeof text !== 'string') return [];
  const chosenSeparator = typeof separator === 'string' && separator.length > 0
    ? separator
    : PROMPT_SEPARATOR;
  // Prefer explicit separator blocks for multi-line prompts; fall back to per-line
  const separatorChunks = text.split(chosenSeparator);
  const chunks = separatorChunks.length > 1
    ? separatorChunks
    : text.split(/\r?\n/);

  return chunks
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function applyTheme(theme) {
  const body = document.body;
  body.classList.remove('theme-dark', 'theme-light');
  body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme === 'light' ? 'light' : 'dark';
}

export function setStatus(text, type = 'idle') {
  const statusEl = document.getElementById('status');
  const badge = statusEl?.querySelector('.status-badge');
  if (!statusEl) return;

  if (badge) {
    badge.className = `status-badge status-${type}`;
    badge.innerHTML = `<span class="status-dot ${type}"></span><span>${text}</span>`;
  } else {
    statusEl.textContent = text;
  }
}

export function setProgress(current, total) {
  const bar = document.getElementById('progressBar');
  if (!bar || !total) return;
  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  bar.style.width = `${pct}%`;
}

export function showToast(message, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast show ${type}`;

  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

export function showError(message, details = null, stack = null) {
  const errorPanel = document.getElementById('errorPanel');
  if (!errorPanel) return;

  const errorMessage = errorPanel.querySelector('.error-message');
  const errorStack = errorPanel.querySelector('.error-stack');
  const toggleBtn = errorPanel.querySelector('.error-toggle-details');

  errorMessage.textContent = message;

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

  errorPanel.classList.remove('hidden');

  setTimeout(() => {
    hideError();
  }, 10000);
}

export function hideError() {
  const errorPanel = document.getElementById('errorPanel');
  if (errorPanel) {
    errorPanel.classList.add('hidden');
  }
}

export function clearError() {
  const errorPanel = document.getElementById('errorPanel');
  if (errorPanel) {
    errorPanel.querySelector('.error-message').textContent = '';
    errorPanel.querySelector('.error-stack').textContent = '';
    errorPanel.querySelector('.error-details').classList.add('hidden');
    errorPanel.querySelector('.error-toggle-details').textContent = 'Show Details';
  }
}

export function setButtonsDisabled(disabled) {
  const shouldDisable = disabled && document.getElementById('disableButtonsDuringAutomation')?.checked;
  document.querySelectorAll('button:not(#disableButtonsDuringAutomation)').forEach((btn) => {
    btn.disabled = shouldDisable;
  });
}

export function showHistoryLoading(show = true) {
  const loading = document.getElementById('historyLoading');
  const history = document.getElementById('history');
  if (show) {
    loading?.classList.remove('hidden');
    if (history) history.innerHTML = '';
  } else {
    loading?.classList.add('hidden');
  }
}

export function secToMs(v) {
  return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v * 1000) : undefined;
}

export function msToSec(v) {
  return typeof v === 'number' && !Number.isNaN(v) ? v / 1000 : '';
}
