import { PROMPT_SEPARATOR } from './popup-dom-utils.js';
import { buildPromptLaunchPlan, resolveSeparator } from './popup-prompt-plan.js';

let state = {
  textarea: null,
  separatorInput: null,
  appendInput: null,
  prependInput: null,
  list: null,
  draggedIndex: null,
  onChange: null,
};

function promptSummary(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 90) return normalized;
  return `${normalized.slice(0, 87)}...`;
}

function joinPromptsWithSeparator(prompts, separator) {
  const chosen = separator || PROMPT_SEPARATOR;
  if (chosen === '\n' || chosen === '\r\n') {
    return prompts.join(chosen);
  }
  const glue = chosen.includes('\n') ? `\n${chosen}\n` : `\n${chosen}\n`;
  return prompts.join(glue);
}

function reorder(items, fromIndex, toIndex) {
  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function renderDisabled(message) {
  if (!state.list) return;
  state.list.innerHTML = '';
  if (!message) {
    state.list.classList.add('hidden');
    return;
  }
  state.list.classList.remove('hidden');
  const note = document.createElement('div');
  note.className = 'prompt-reorder-note';
  note.textContent = message;
  state.list.appendChild(note);
}

function renderRows(prompts, separator) {
  if (!state.list) return;
  state.list.innerHTML = '';
  state.list.classList.remove('hidden');
  prompts.forEach((prompt, index) => {
    const row = document.createElement('div');
    row.className = 'prompt-reorder-row';
    row.draggable = true;
    row.dataset.index = String(index);

    const handle = document.createElement('span');
    handle.className = 'prompt-reorder-handle';
    handle.textContent = '::';

    const number = document.createElement('span');
    number.className = 'prompt-reorder-number';
    number.textContent = String(index + 1);

    const text = document.createElement('span');
    text.className = 'prompt-reorder-text';
    text.textContent = promptSummary(prompt);

    row.append(handle, number, text);
    row.addEventListener('dragstart', (event) => {
      state.draggedIndex = index;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    });
    row.addEventListener('dragend', () => {
      state.draggedIndex = null;
      row.classList.remove('is-dragging');
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('is-drop-target');
      const from = Number(event.dataTransfer.getData('text/plain') || state.draggedIndex);
      const to = index;
      if (!Number.isInteger(from) || from === to) return;
      const nextPrompts = reorder(prompts, from, to);
      state.textarea.value = joinPromptsWithSeparator(nextPrompts, separator);
      state.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof state.onChange === 'function') state.onChange();
      refreshPromptQueueReorder();
    });
    state.list.appendChild(row);
  });
}

export function refreshPromptQueueReorder() {
  if (!state.textarea || !state.list) return;
  const separator = resolveSeparator(state.separatorInput?.value);
  const appendText = state.appendInput?.value?.trim() || '';
  const prependText = state.prependInput?.value?.trim() || '';
  const plan = buildPromptLaunchPlan(state.textarea.value, separator, appendText, prependText);
  if (plan.prompts.length < 2) {
    renderDisabled('');
    return;
  }
  if (plan.hasTabMarkers || plan.hasAppendMarkers || plan.hasPrependMarkers || plan.linePromptModeEnabled) {
    renderDisabled('Drag reorder is available for plain prompt lists without tab or inline edit markers.');
    return;
  }
  renderRows(plan.prompts, separator);
}

export function initPromptQueueReorder(options = {}) {
  state = {
    textarea: options.textarea || document.getElementById('prompts'),
    separatorInput: options.separatorInput || document.getElementById('separatorInput'),
    appendInput: options.appendInput || document.getElementById('appendPromptText'),
    prependInput: options.prependInput || document.getElementById('systemPrompt'),
    list: options.list || document.getElementById('promptQueueReorder'),
    draggedIndex: null,
    onChange: options.onChange || null,
  };
  [state.textarea, state.separatorInput, state.appendInput, state.prependInput]
    .filter(Boolean)
    .forEach((node) => node.addEventListener('input', refreshPromptQueueReorder));
  refreshPromptQueueReorder();
}
