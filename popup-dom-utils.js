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

function flipCharCase(ch) {
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
  if (ch >= 'A' && ch <= 'Z') return ch.toLowerCase();
  return ch;
}

function replaceWithNearbyKey(ch) {
  const keyMap = {
    a: 's', b: 'v', c: 'x', d: 's', e: 'w', f: 'd', g: 'f', h: 'g', i: 'u', j: 'h',
    k: 'j', l: 'k', m: 'n', n: 'b', o: 'i', p: 'o', q: 'w', r: 'e', s: 'a', t: 'r',
    u: 'y', v: 'c', w: 'q', x: 'z', y: 't', z: 'x'
  };
  const lower = ch.toLowerCase();
  const mapped = keyMap[lower] || lower;
  return ch === lower ? mapped : mapped.toUpperCase();
}

function letterIndexes(chars) {
  const indexes = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (/[A-Za-z]/.test(chars[i])) indexes.push(i);
  }
  return indexes;
}

function makeTypoVariant(text, seed = 1) {
  const chars = Array.from(text);
  if (chars.length === 0) return text;

  const letters = letterIndexes(chars);
  if (letters.length === 0) {
    return `${text}.`;
  }

  const pick = letters[(seed * 7) % letters.length];
  const op = seed % 5;

  // 0: duplicate char (double key)
  if (op === 0) {
    chars.splice(pick, 0, chars[pick]);
    return chars.join('');
  }

  // 1: drop char
  if (op === 1 && chars.length > 1) {
    chars.splice(pick, 1);
    return chars.join('');
  }

  // 2: swap adjacent chars
  if (op === 2 && pick < chars.length - 1 && /[A-Za-z]/.test(chars[pick + 1])) {
    const temp = chars[pick];
    chars[pick] = chars[pick + 1];
    chars[pick + 1] = temp;
    return chars.join('');
  }

  // 3: nearby keyboard replacement
  if (op === 3) {
    chars[pick] = replaceWithNearbyKey(chars[pick]);
    return chars.join('');
  }

  // 4: wrong capitalization
  chars[pick] = flipCharCase(chars[pick]);
  return chars.join('');
}

export function applyTypoVariantsToExactDuplicates(prompts = []) {
  if (!Array.isArray(prompts) || prompts.length === 0) {
    return { prompts: [], changed: 0 };
  }

  const counts = new Map();
  const used = new Map();
  const out = [];
  let changed = 0;

  for (const prompt of prompts) {
    const base = typeof prompt === 'string' ? prompt : String(prompt ?? '');
    const currentCount = counts.get(base) || 0;

    if (currentCount === 0) {
      counts.set(base, 1);
      used.set(base, new Set([base]));
      out.push(base);
      continue;
    }

    const usedSet = used.get(base) || new Set([base]);
    let candidate = base;
    let attempt = 0;

    while ((candidate === base || usedSet.has(candidate)) && attempt < 10) {
      candidate = makeTypoVariant(base, currentCount + attempt + 1);
      attempt += 1;
    }

    if (candidate === base || usedSet.has(candidate)) {
      candidate = `${base}${base.endsWith('.') ? ',' : '.'}`;
    }

    usedSet.add(candidate);
    used.set(base, usedSet);
    counts.set(base, currentCount + 1);
    out.push(candidate);
    changed += 1;
  }

  return { prompts: out, changed };
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
