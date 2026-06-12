import { showToast } from './popup-dom-utils.js';

const PQ_CONSTANTS = globalThis.PromptQueueConstants || {};
const MESSAGE_TYPES = PQ_CONSTANTS.MESSAGE_TYPES || {};

const MEMORY_CLASSES = [
  'beliefs_preferences',
  'world_facts',
  'entity_observations',
  'agent_experiences',
  'reflections',
];

const DEFAULT_MEMORY_SETTINGS = {
  bridgeBaseUrl: 'http://127.0.0.1:5599',
  authMode: 'native_host',
  nativeHostName: 'com.aipromptqueue.transcription',
  storedToken: '',
  querySource: 'prompt_box',
  project: 'global',
  mode: 'smart',
  maxTokens: 800,
  topK: 8,
  minScore: 0.2,
  pinnedPolicy: 'relevant_only',
  includeClasses: MEMORY_CLASSES.slice(),
  excludeClasses: [],
  insertBehavior: 'prepend_or_replace_managed_block',
  debug: false,
};

let getContextTabId = null;
let lastMemoryPack = null;

function el(id) {
  return document.getElementById(id);
}

function setMemoryStatus(text) {
  const target = el('memoryStatus');
  if (target) target.textContent = text || 'Idle';
}

function getSelectedClasses() {
  return Array.from(document.querySelectorAll('[data-memory-class]:checked'))
    .map((node) => node.dataset.memoryClass)
    .filter((name) => MEMORY_CLASSES.includes(name));
}

function getMemorySettingsFromUI(includeToken = false) {
  const memory = {
    bridgeBaseUrl: el('memoryBridgeBaseUrl')?.value || 'http://127.0.0.1:5599',
    authMode: el('memoryAuthMode')?.value || 'native_host',
    nativeHostName: el('memoryNativeHostName')?.value || 'com.aipromptqueue.transcription',
    querySource: el('memorySource')?.value || 'prompt_box',
    project: el('memoryProject')?.value || el('memoryDefaultProject')?.value || 'global',
    mode: el('memoryMode')?.value || 'smart',
    maxTokens: Number(el('memoryMaxTokens')?.value || 800),
    topK: Number(el('memoryTopK')?.value || 8),
    minScore: Number(el('memoryMinScore')?.value || 0.2),
    pinnedPolicy: el('memoryPinnedPolicy')?.value || 'relevant_only',
    includeClasses: getSelectedClasses(),
    excludeClasses: [],
    insertBehavior: el('memoryInsertBehavior')?.value || 'prepend_or_replace_managed_block',
    debug: el('memoryDebug')?.checked === true,
  };
  const token = el('memoryStoredToken')?.value?.trim();
  if (includeToken && token) {
    memory.storedToken = token;
  }
  return memory;
}

function applyMemorySettingsToUI(memory = {}) {
  if (el('memorySource')) el('memorySource').value = memory.querySource || 'prompt_box';
  if (el('memoryProject')) el('memoryProject').value = memory.project || 'global';
  if (el('memoryDefaultProject')) el('memoryDefaultProject').value = memory.project || 'global';
  if (el('memoryMode')) el('memoryMode').value = memory.mode || 'smart';
  if (el('memoryMaxTokens')) el('memoryMaxTokens').value = String(memory.maxTokens || 800);
  if (el('memoryTopK')) el('memoryTopK').value = String(memory.topK || 8);
  if (el('memoryMinScore')) el('memoryMinScore').value = String(memory.minScore ?? 0.2);
  if (el('memoryMinScoreValue')) el('memoryMinScoreValue').textContent = Number(memory.minScore ?? 0.2).toFixed(2);
  if (el('memoryPinnedPolicy')) el('memoryPinnedPolicy').value = memory.pinnedPolicy || 'relevant_only';
  if (el('memoryInsertBehavior')) el('memoryInsertBehavior').value = memory.insertBehavior || 'prepend_or_replace_managed_block';
  if (el('memoryBridgeBaseUrl')) el('memoryBridgeBaseUrl').value = memory.bridgeBaseUrl || 'http://127.0.0.1:5599';
  if (el('memoryAuthMode')) el('memoryAuthMode').value = memory.authMode || 'native_host';
  if (el('memoryNativeHostName')) el('memoryNativeHostName').value = memory.nativeHostName || 'com.aipromptqueue.transcription';
  if (el('memoryDebug')) el('memoryDebug').checked = memory.debug === true;
  if (el('memoryStoredToken')) el('memoryStoredToken').value = '';
  if (el('memoryTokenStatus')) el('memoryTokenStatus').textContent = memory.hasStoredToken ? 'Stored token present' : 'No stored token';
  const included = new Set(memory.includeClasses?.length ? memory.includeClasses : MEMORY_CLASSES);
  document.querySelectorAll('[data-memory-class]').forEach((node) => {
    node.checked = included.has(node.dataset.memoryClass);
  });
}

export async function loadMemorySettingsIntoUI() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS || 'GET_SETTINGS' });
    if (res?.ok && res.settings?.memory) {
      applyMemorySettingsToUI(res.settings.memory);
    }
  } catch (err) {
    setMemoryStatus(`Settings load failed: ${err?.message || err}`);
  }
}

async function saveMemorySettings(includeToken = false) {
  const memory = getMemorySettingsFromUI(includeToken);
  const defaultProject = el('memoryDefaultProject')?.value?.trim();
  if (defaultProject) memory.project = defaultProject;
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SAVE_SETTINGS || 'SAVE_SETTINGS', settings: { memory } });
  if (!res?.ok) throw new Error(res?.error || 'Memory settings save failed');
  applyMemorySettingsToUI(res.settings.memory || {});
  setMemoryStatus('Settings saved');
  return res.settings.memory || memory;
}

async function getTabId() {
  if (typeof getContextTabId === 'function') return getContextTabId();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

async function getMemorySourceText(source) {
  if (source === 'manual') {
    return el('memoryManualQuery')?.value?.trim() || '';
  }
  if (source === 'clipboard') {
    return (await navigator.clipboard.readText()).trim();
  }
  const tabId = await getTabId();
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_MEMORY_SOURCE || 'GET_MEMORY_SOURCE', tabId, source });
  if (!res?.ok) throw new Error(res?.error || res?.result?.error || 'Could not read source');
  return res.result?.text || '';
}

function composeMarkdownFromCheckedHits() {
  if (!lastMemoryPack) return '';
  const textarea = el('memoryPackMarkdown');
  const selected = new Set(Array.from(document.querySelectorAll('[data-memory-hit]:checked')).map((node) => node.dataset.memoryHit));
  const hits = (lastMemoryPack.hits || []).filter((hit) => selected.has(hit.memory_id));
  if (!lastMemoryPack.hits || hits.length === lastMemoryPack.hits.length) {
    return textarea?.value || lastMemoryPack.markdown || '';
  }
  const lines = [
    '<!-- BEGIN C_MEMORY_BROWSER_PACK -->',
    '## Relevant memory for this prompt',
    '',
  ];
  hits.forEach((hit) => {
    lines.push(`- [${hit.memory_id}] ${hit.snippet || ''} (class: ${hit.class}, score: ${Number(hit.score || 0).toFixed(2)}, source: ${hit.source || ''})`);
  });
  lines.push('', 'Use these as context only. Verify against current repo/files before acting.', '<!-- END C_MEMORY_BROWSER_PACK -->', '');
  return lines.join('\n');
}

function renderMemoryPreview(result) {
  lastMemoryPack = result || null;
  const preview = el('memoryPreview');
  const markdown = el('memoryPackMarkdown');
  if (!preview || !markdown) return;
  preview.innerHTML = '';
  (result?.hits || []).forEach((hit) => {
    const item = document.createElement('div');
    item.className = 'memory-preview-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.memoryHit = hit.memory_id;
    checkbox.addEventListener('change', () => {
      markdown.value = composeMarkdownFromCheckedHits();
    });
    const body = document.createElement('div');
    body.className = 'memory-preview-body';
    const title = document.createElement('div');
    title.className = 'memory-preview-title';
    title.textContent = `${hit.memory_id} - ${hit.class}/${hit.type}`;
    const meta = document.createElement('div');
    meta.className = 'memory-preview-meta';
    meta.textContent = `score ${Number(hit.score || 0).toFixed(2)} | ${hit.project || 'global'} | ${hit.source || ''}`;
    const snippet = document.createElement('div');
    snippet.className = 'memory-preview-snippet';
    snippet.textContent = hit.snippet || '';
    body.append(title, meta, snippet);
    item.append(checkbox, body);
    preview.appendChild(item);
  });
  markdown.value = result?.markdown || '';
}

async function previewMemoryPack() {
  setMemoryStatus('Reading source...');
  const includeToken = Boolean(el('memoryStoredToken')?.value?.trim());
  const memory = await saveMemorySettings(includeToken);
  const source = el('memorySource')?.value || memory.querySource || 'prompt_box';
  const query = await getMemorySourceText(source);
  if (el('memoryManualQuery')) el('memoryManualQuery').value = query;
  if (!query.trim()) {
    setMemoryStatus('No query text found');
    return;
  }
  setMemoryStatus('Fetching preview...');
  const body = {
    query,
    query_source: source,
    project: memory.project || 'global',
    max_tokens: memory.maxTokens,
    top_k: memory.topK,
    min_score: memory.minScore,
    mode: memory.mode,
    pinned_policy: memory.pinnedPolicy,
    include_classes: memory.includeClasses,
    exclude_classes: memory.excludeClasses || [],
    return_format: 'json',
  };
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.PREVIEW_MEMORY_PACK || 'PREVIEW_MEMORY_PACK', body });
  if (!res?.ok) throw new Error(res?.error || 'Preview failed');
  renderMemoryPreview(res.result);
  setMemoryStatus(`Preview ready: ${(res.result?.hits || []).length} hits, ${res.result?.estimated_tokens || 0} tokens`);
}

async function insertMemoryPack() {
  const markdown = composeMarkdownFromCheckedHits() || el('memoryPackMarkdown')?.value?.trim();
  if (!markdown) {
    setMemoryStatus('No pack to insert');
    return;
  }
  const behavior = el('memoryInsertBehavior')?.value || 'prepend_or_replace_managed_block';
  if (behavior === 'copy_only') {
    await navigator.clipboard.writeText(markdown);
    setMemoryStatus('Copied pack');
    return;
  }
  const tabId = await getTabId();
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.INSERT_MEMORY_PACK || 'INSERT_MEMORY_PACK', tabId, markdown, behavior });
  if (res?.ok) {
    setMemoryStatus(res.result?.replaced ? 'Replaced existing pack' : 'Inserted pack');
    return;
  }
  await navigator.clipboard.writeText(markdown);
  setMemoryStatus(`Insert failed; copied pack. ${res?.error || res?.result?.error || ''}`.trim());
}

async function copyMemoryPack() {
  const markdown = composeMarkdownFromCheckedHits() || el('memoryPackMarkdown')?.value?.trim();
  if (!markdown) {
    setMemoryStatus('No pack to copy');
    return;
  }
  await navigator.clipboard.writeText(markdown);
  setMemoryStatus('Copied pack');
}

async function healthCheckMemory() {
  setMemoryStatus('Checking...');
  const includeToken = Boolean(el('memoryStoredToken')?.value?.trim());
  await saveMemorySettings(includeToken);
  const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.MEMORY_HEALTH_CHECK || 'MEMORY_HEALTH_CHECK' });
  const result = res?.result || {};
  const projects = Array.isArray(result.projects) ? result.projects : [];
  const datalist = el('memoryProjects');
  if (datalist) {
    datalist.innerHTML = '';
    projects.forEach((project) => {
      const option = document.createElement('option');
      option.value = project;
      datalist.appendChild(option);
    });
  }
  setMemoryStatus(res?.ok ? `Healthy${result.native ? ' via native' : ''}` : `Health failed: ${res?.error || result.error || 'unknown'}`);
}

function wrap(handler) {
  return async () => {
    try {
      await handler();
    } catch (err) {
      setMemoryStatus(err?.message || String(err));
      showToast(err?.message || String(err), 'error', 5000);
    }
  };
}

export function initMemoryPackUI(options = {}) {
  getContextTabId = options.getContextTabId || getContextTabId;
  el('memoryMinScore')?.addEventListener('input', (event) => {
    if (el('memoryMinScoreValue')) el('memoryMinScoreValue').textContent = Number(event.target.value || 0).toFixed(2);
  });
  ['memorySource', 'memoryProject', 'memoryMode', 'memoryPinnedPolicy', 'memoryMaxTokens', 'memoryTopK', 'memoryMinScore', 'memoryInsertBehavior', 'memoryBridgeBaseUrl', 'memoryAuthMode', 'memoryNativeHostName', 'memoryDefaultProject', 'memoryDebug']
    .forEach((id) => el(id)?.addEventListener('change', () => saveMemorySettings(false).catch((err) => setMemoryStatus(err?.message || String(err)))));
  document.querySelectorAll('[data-memory-class]').forEach((node) => {
    node.addEventListener('change', () => saveMemorySettings(false).catch((err) => setMemoryStatus(err?.message || String(err))));
  });
  el('memoryHealthBtn')?.addEventListener('click', wrap(healthCheckMemory));
  el('memoryPreviewBtn')?.addEventListener('click', wrap(previewMemoryPack));
  el('memoryInsertBtn')?.addEventListener('click', wrap(insertMemoryPack));
  el('memoryCopyBtn')?.addEventListener('click', wrap(copyMemoryPack));
  el('memorySaveSettingsBtn')?.addEventListener('click', wrap(() => saveMemorySettings(Boolean(el('memoryStoredToken')?.value?.trim()))));
  el('memoryClearTokenBtn')?.addEventListener('click', wrap(async () => {
    const memory = getMemorySettingsFromUI(false);
    memory.storedToken = '';
    const res = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SAVE_SETTINGS || 'SAVE_SETTINGS', settings: { memory } });
    if (!res?.ok) throw new Error(res?.error || 'Clear token failed');
    applyMemorySettingsToUI(res.settings.memory || {});
    setMemoryStatus('Token cleared');
  }));
  el('memoryResetDefaultsBtn')?.addEventListener('click', wrap(async () => {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SAVE_SETTINGS || 'SAVE_SETTINGS',
      settings: { memory: { ...DEFAULT_MEMORY_SETTINGS, includeClasses: MEMORY_CLASSES.slice() } },
    });
    if (!res?.ok) throw new Error(res?.error || 'Reset failed');
    applyMemorySettingsToUI(res.settings.memory || {});
    setMemoryStatus('Memory defaults restored');
  }));
}
