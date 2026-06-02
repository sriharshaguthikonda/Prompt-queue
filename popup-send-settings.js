import { msToSec, secToMs } from './popup-dom-utils.js';

const FIELD_CONFIG = [
  { id: 'postPopulateDelayMinSec', label: 'Post-populate min (sec)', min: 0, step: 0.1, defaultMs: 500 },
  { id: 'postPopulateDelayMaxSec', label: 'Post-populate max (sec)', min: 0, step: 0.1, defaultMs: 1500 },
  { id: 'crossTabSendLockMinWaitSec', label: 'Cross-tab wait min (sec)', min: 0, step: 0.5, defaultMs: 3000 },
  { id: 'crossTabSendLockMaxWaitSec', label: 'Cross-tab wait max (sec)', min: 0, step: 0.5, defaultMs: 12000 },
];

function makeInlineCheckbox(id, labelText, checked = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'inline';
  wrapper.style.marginTop = '8px';
  const input = document.createElement('input');
  input.id = id;
  input.type = 'checkbox';
  input.checked = checked === true;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  wrapper.append(input, label);
  return wrapper;
}

function makeNumberField(config) {
  const wrapper = document.createElement('div');
  const label = document.createElement('label');
  label.htmlFor = config.id;
  label.textContent = config.label;
  const input = document.createElement('input');
  input.id = config.id;
  input.type = 'number';
  input.min = String(config.min);
  input.step = String(config.step);
  input.placeholder = String(msToSec(config.defaultMs));
  wrapper.append(label, input);
  return wrapper;
}

export function ensureSendTimingSettingsUI() {
  const optionsContent = document.getElementById('optionsContent');
  if (optionsContent && !document.getElementById('sendTimingSettingsSection')) {
    const section = document.createElement('div');
    section.id = 'sendTimingSettingsSection';
    section.className = 'send-timing-settings';
    section.innerHTML = '<div class="section-title compact-title">Send timing</div>';
    section.appendChild(makeInlineCheckbox('enableDuplicateTypoVariants', 'Typo-variant exact duplicate prompts'));
    section.appendChild(makeInlineCheckbox('crossTabSendLockEnabled', 'Cross-tab send lock', true));
    const row = document.createElement('div');
    row.className = 'row';
    FIELD_CONFIG.forEach((config) => row.appendChild(makeNumberField(config)));
    section.appendChild(row);
    optionsContent.appendChild(section);
  }
  ensureDebugPanelUI();
}

export function ensureDebugPanelUI() {
  let panel = document.getElementById('debugPanelCard');
  if (panel) return panel;
  const container = document.querySelector('.container') || document.body;
  panel = document.createElement('div');
  panel.id = 'debugPanelCard';
  panel.className = 'card debug-panel-card';
  panel.innerHTML = `
    <div class="collapsible-header" id="debugPanelHeader">
      <span class="collapsible-toggle">▼</span>
      <span class="section-title" style="margin: 0;">Debug</span>
      <span id="debugStepBadge" class="debug-step-badge">Idle</span>
    </div>
    <div class="collapsible-content" id="debugPanelContent">
      <div id="debugControls" class="debug-controls"></div>
      <div id="stepStatusTimeline" class="step-status-timeline" aria-live="polite"></div>
      <div id="selectorHealthPanel" class="selector-health-panel">Selector health idle</div>
    </div>
  `;
  const toast = document.getElementById('toast');
  if (toast?.parentElement === container) {
    container.insertBefore(panel, toast);
  } else {
    container.appendChild(panel);
  }

  const controls = panel.querySelector('#debugControls');
  controls.appendChild(makeInlineCheckbox('perStepConsoleLogging', 'Per-step console logging'));
  controls.appendChild(makeInlineCheckbox('dryRunPopulateOnly', 'Dry-run populate without send'));

  const existingDebug = document.getElementById('debugLoggingEnabled');
  if (existingDebug) {
    const row = document.createElement('div');
    row.className = 'inline';
    row.style.marginTop = '8px';
    const label = document.querySelector(`label[for="${existingDebug.id}"]`);
    const info = label?.nextElementSibling?.classList?.contains('info-wrap') ? label.nextElementSibling : null;
    row.appendChild(existingDebug);
    if (label) row.appendChild(label);
    if (info) row.appendChild(info);
    controls.insertBefore(row, controls.firstChild);
  }

  panel.querySelector('#debugPanelHeader')?.addEventListener('click', () => {
    const content = panel.querySelector('#debugPanelContent');
    if (!content) return;
    content.classList.toggle('hidden');
  });
  return panel;
}

function setNumberValue(id, valueMs, fallbackMs) {
  const input = document.getElementById(id);
  if (input) input.value = msToSec(Number.isFinite(Number(valueMs)) ? Number(valueMs) : fallbackMs);
}

export function loadSendTimingSettingsIntoUI(settings = {}) {
  ensureSendTimingSettingsUI();
  const duplicate = document.getElementById('enableDuplicateTypoVariants');
  if (duplicate) duplicate.checked = settings.enableDuplicateTypoVariants === true;
  const lock = document.getElementById('crossTabSendLockEnabled');
  if (lock) lock.checked = settings.crossTabSendLockEnabled !== false;
  const stepLog = document.getElementById('perStepConsoleLogging');
  if (stepLog) stepLog.checked = settings.perStepConsoleLogging === true;
  const dryRun = document.getElementById('dryRunPopulateOnly');
  if (dryRun) dryRun.checked = settings.dryRunPopulateOnly === true;
  setNumberValue('postPopulateDelayMinSec', settings.postPopulateDelayMinMs, 500);
  setNumberValue('postPopulateDelayMaxSec', settings.postPopulateDelayMaxMs, 1500);
  setNumberValue('crossTabSendLockMinWaitSec', settings.crossTabSendLockMinWaitMs, 3000);
  setNumberValue('crossTabSendLockMaxWaitSec', settings.crossTabSendLockMaxWaitMs, 12000);
}

function orderedMs(minId, maxId, fallbackMin, fallbackMax) {
  const min = secToMs(Number(document.getElementById(minId)?.value));
  const max = secToMs(Number(document.getElementById(maxId)?.value));
  const safeMin = Number.isFinite(min) ? Math.max(0, min) : fallbackMin;
  const safeMax = Number.isFinite(max) ? Math.max(0, max) : fallbackMax;
  return {
    minMs: Math.min(safeMin, safeMax),
    maxMs: Math.max(safeMin, safeMax),
  };
}

export function readSendTimingSettingsFromUI() {
  ensureSendTimingSettingsUI();
  const postPopulate = orderedMs('postPopulateDelayMinSec', 'postPopulateDelayMaxSec', 500, 1500);
  const crossTab = orderedMs('crossTabSendLockMinWaitSec', 'crossTabSendLockMaxWaitSec', 3000, 12000);
  return {
    enableDuplicateTypoVariants: document.getElementById('enableDuplicateTypoVariants')?.checked === true,
    postPopulateDelayMinMs: postPopulate.minMs,
    postPopulateDelayMaxMs: postPopulate.maxMs,
    crossTabSendLockEnabled: document.getElementById('crossTabSendLockEnabled')?.checked !== false,
    crossTabSendLockMinWaitMs: crossTab.minMs,
    crossTabSendLockMaxWaitMs: crossTab.maxMs,
    perStepConsoleLogging: document.getElementById('perStepConsoleLogging')?.checked === true,
    dryRunPopulateOnly: document.getElementById('dryRunPopulateOnly')?.checked === true,
  };
}

export function initSendTimingSettingsUI({ onSettingsChanged } = {}) {
  ensureSendTimingSettingsUI();
  [
    'enableDuplicateTypoVariants',
    'postPopulateDelayMinSec',
    'postPopulateDelayMaxSec',
    'crossTabSendLockEnabled',
    'crossTabSendLockMinWaitSec',
    'crossTabSendLockMaxWaitSec',
    'perStepConsoleLogging',
    'dryRunPopulateOnly',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.sendTimingInitDone) return;
    el.dataset.sendTimingInitDone = 'true';
    el.addEventListener('change', () => onSettingsChanged?.());
    if (el.type === 'number') el.addEventListener('blur', () => onSettingsChanged?.());
  });
}

export function renderStepStatus(stepStatus = null) {
  ensureDebugPanelUI();
  const badge = document.getElementById('debugStepBadge');
  const timeline = document.getElementById('stepStatusTimeline');
  if (!stepStatus) {
    if (badge) {
      badge.textContent = 'Idle';
      badge.className = 'debug-step-badge status-idle';
    }
    return;
  }
  const label = stepStatus.label || stepStatus.step || 'Working';
  const remaining = stepStatus.endAt ? Math.max(0, stepStatus.endAt - Date.now()) : 0;
  const text = remaining > 0 ? `${label} (${(remaining / 1000).toFixed(1)}s)` : label;
  const statusClass = `status-${stepStatus.color || 'running'}`;
  if (badge) {
    badge.textContent = text;
    badge.className = `debug-step-badge ${statusClass}`;
  }
  if (timeline) {
    const row = document.createElement('div');
    row.className = `step-status-row ${statusClass}`;
    row.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    timeline.prepend(row);
    while (timeline.children.length > 8) timeline.lastElementChild?.remove();
  }
}

export function renderSelectorHealth(health = null) {
  ensureDebugPanelUI();
  const panel = document.getElementById('selectorHealthPanel');
  if (!panel) return;
  if (!health) {
    panel.textContent = 'Selector health idle';
    return;
  }
  const rows = Object.entries(health)
    .map(([role, item]) => `${role}: ${item?.source || 'unknown'} ${item?.selector ? `(${item.selector})` : ''}`)
    .join('\n');
  panel.textContent = rows || 'Selector health idle';
}
