async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id;
}

function parsePrompts(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function setStatus(text) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = text;
}

function setProgress(current, total) {
  const bar = document.getElementById('progressBar');
  if (!bar || !total) return;
  const pct = Math.min(100, Math.max(0, Math.round(((current) / total) * 100)));
  bar.style.width = `${pct}%`;
}

function secToMs(v) { return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v * 1000) : undefined; }
function msToSec(v) { return typeof v === 'number' && !Number.isNaN(v) ? (v / 1000) : ''; }

const MEMORY_CLASSES = [
  'beliefs_preferences',
  'world_facts',
  'entity_observations',
  'agent_experiences',
  'reflections',
];

let currentSettings = null;
let lastMemoryPack = null;

function setMemoryStatus(text) {
  const el = document.getElementById('memoryStatus');
  if (el) el.textContent = text;
}

function setActiveTab(name) {
  const panels = {
    queue: document.getElementById('queuePanel'),
    memory: document.getElementById('memoryPanel'),
    settings: document.getElementById('settingsPanel'),
  };
  const buttons = {
    queue: document.getElementById('tabQueue'),
    memory: document.getElementById('tabMemory'),
    settings: document.getElementById('tabSettings'),
  };
  Object.entries(panels).forEach(([key, panel]) => {
    if (panel) panel.hidden = key !== name;
  });
  Object.entries(buttons).forEach(([key, button]) => {
    if (button) button.classList.toggle('active', key === name);
  });
}

function getMemorySettingsFromUI(includeToken = false) {
  const selectedClasses = Array.from(document.querySelectorAll('[data-memory-class]:checked'))
    .map((el) => el.dataset.memoryClass)
    .filter(Boolean);
  const allSelected = selectedClasses.length === MEMORY_CLASSES.length;
  const memory = {
    bridgeBaseUrl: document.getElementById('memoryBridgeBaseUrl')?.value || 'http://127.0.0.1:5599',
    authMode: document.getElementById('memoryAuthMode')?.value || 'native_host',
    querySource: document.getElementById('memorySource')?.value || 'prompt_box',
    project: document.getElementById('memoryProject')?.value || document.getElementById('memoryDefaultProject')?.value || 'global',
    mode: document.getElementById('memoryMode')?.value || 'smart',
    maxTokens: Number(document.getElementById('memoryMaxTokens')?.value || 800),
    topK: Number(document.getElementById('memoryTopK')?.value || 8),
    minScore: Number(document.getElementById('memoryMinScore')?.value || 0.2),
    pinnedPolicy: document.getElementById('memoryPinnedPolicy')?.value || 'relevant_only',
    includeClasses: allSelected ? [] : selectedClasses,
    insertBehavior: document.getElementById('memoryInsertBehavior')?.value || 'prepend_or_replace_managed_block',
    debug: document.getElementById('memoryDebug')?.checked === true,
  };
  const token = document.getElementById('memoryStoredToken')?.value?.trim();
  if (includeToken && token) {
    memory.storedToken = token;
  }
  return memory;
}

function applyMemorySettingsToUI(memory = {}) {
  const source = memory.querySource || 'prompt_box';
  document.getElementById('memorySource').value = source;
  document.getElementById('memoryDefaultSource').value = source;
  document.getElementById('memoryProject').value = memory.project || 'global';
  document.getElementById('memoryDefaultProject').value = memory.project || 'global';
  document.getElementById('memoryMode').value = memory.mode || 'smart';
  document.getElementById('memoryMaxTokens').value = String(memory.maxTokens || 800);
  document.getElementById('memoryTopK').value = String(memory.topK || 8);
  document.getElementById('memoryMinScore').value = String(memory.minScore ?? 0.2);
  document.getElementById('memoryMinScoreValue').textContent = Number(memory.minScore ?? 0.2).toFixed(2);
  document.getElementById('memoryPinnedPolicy').value = memory.pinnedPolicy || 'relevant_only';
  document.getElementById('memoryBridgeBaseUrl').value = memory.bridgeBaseUrl || 'http://127.0.0.1:5599';
  document.getElementById('memoryAuthMode').value = memory.authMode || 'native_host';
  document.getElementById('memoryInsertBehavior').value = memory.insertBehavior || 'prepend_or_replace_managed_block';
  document.getElementById('memoryDebug').checked = memory.debug === true;
  document.getElementById('memoryStoredToken').value = '';
  document.getElementById('memoryTokenStatus').textContent = memory.hasStoredToken ? 'Stored token present' : 'No stored token';
  const included = new Set(memory.includeClasses?.length ? memory.includeClasses : MEMORY_CLASSES);
  document.querySelectorAll('[data-memory-class]').forEach((el) => {
    el.checked = included.has(el.dataset.memoryClass);
  });
}

function checkedHitIds() {
  return Array.from(document.querySelectorAll('[data-hit-id]'))
    .filter((el) => el.checked)
    .map((el) => el.dataset.hitId);
}

function composeMarkdownFromCheckedHits() {
  if (!lastMemoryPack) return '';
  const selected = new Set(checkedHitIds());
  const hits = (lastMemoryPack.hits || []).filter((hit) => selected.has(hit.memory_id));
  if (hits.length === (lastMemoryPack.hits || []).length) {
    return document.getElementById('memoryPackMarkdown').value || lastMemoryPack.markdown || '';
  }
  const lines = [
    '<!-- BEGIN C_MEMORY_BROWSER_PACK -->',
    '## Relevant memory for this prompt',
  ];
  if (hits.length) {
    hits.forEach((hit) => {
      lines.push(`- [${hit.memory_id}] ${hit.snippet || ''} (class: ${hit.class}, score: ${Number(hit.score || 0).toFixed(2)}, source: ${hit.source || ''})`);
    });
  } else {
    lines.push('- <none>');
  }
  lines.push('', 'Use these as context only. Verify against current repo/files before acting.', '<!-- END C_MEMORY_BROWSER_PACK -->', '');
  return lines.join('\n');
}

async function refreshStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AUTOMATION_STATUS_REQUEST' });
    if (res?.ok && res.status) {
      const { running, currentIndex, total } = res.status;
      setProgress(running ? currentIndex : total, total);
      if (running) {
        setStatus(`Running prompt ${currentIndex + 1} of ${total}...`);
      } else if (total > 0 && currentIndex >= total) {
        setStatus('Complete');
      } else {
        setStatus('Idle');
      }
    }
  } catch (e) {
    // ignore
  }
}

function applyTheme(theme) {
  const body = document.body;
  body.classList.remove('theme-dark', 'theme-light');
  body.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = theme === 'light' ? 'light' : 'dark';
}

async function loadSettingsIntoUI() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (res?.ok && res.settings) {
      const s = res.settings;
      currentSettings = s;
      applyTheme(s.theme || 'dark');
      document.getElementById('maxWaitSec').value = msToSec(s.maxWaitMs);
      document.getElementById('stableSec').value = msToSec(s.stableMs);
      document.getElementById('pollSec').value = msToSec(s.pollIntervalMs);
      document.getElementById('systemPrompt').value = s.systemPrompt || '';
      document.getElementById('prependSystemPrompt').checked = s.prependSystemPrompt !== false;
      applyMemorySettingsToUI(s.memory || {});
    }
  } catch (_) {}
}

async function saveSettingsFromUI() {
  const maxWaitSec = Number(document.getElementById('maxWaitSec').value);
  const stableSec = Number(document.getElementById('stableSec').value);
  const pollSec = Number(document.getElementById('pollSec').value);
  const settings = {
    maxWaitMs: secToMs(maxWaitSec),
    stableMs: secToMs(stableSec),
    pollIntervalMs: secToMs(pollSec),
    systemPrompt: document.getElementById('systemPrompt').value || '',
    prependSystemPrompt: document.getElementById('prependSystemPrompt').checked,
  };
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
}

async function saveMemorySettings(includeToken = false) {
  const memory = getMemorySettingsFromUI(includeToken);
  const defaultSource = document.getElementById('memoryDefaultSource')?.value;
  const defaultProject = document.getElementById('memoryDefaultProject')?.value;
  if (defaultSource) memory.querySource = defaultSource;
  if (defaultProject) memory.project = defaultProject;
  const res = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { memory } });
  if (res?.ok) {
    currentSettings = res.settings;
    applyMemorySettingsToUI(res.settings.memory || {});
    setMemoryStatus('Memory settings saved');
  } else {
    setMemoryStatus(`Save failed: ${res?.error || 'unknown error'}`);
  }
}

async function getMemorySourceText(source) {
  if (source === 'manual') {
    return document.getElementById('memoryManualQuery').value.trim();
  }
  if (source === 'clipboard') {
    const text = await navigator.clipboard.readText();
    return (text || '').trim();
  }
  const tabId = await getActiveTabId();
  if (!tabId) throw new Error('No active tab found.');
  if (source === 'combined') {
    const promptRes = await chrome.runtime.sendMessage({ type: 'GET_MEMORY_SOURCE', tabId, source: 'prompt_box' });
    const selectionRes = await chrome.runtime.sendMessage({ type: 'GET_MEMORY_SOURCE', tabId, source: 'selection' });
    const promptText = promptRes?.result?.text || '';
    const selectedText = selectionRes?.result?.text || '';
    return [promptText, selectedText].filter(Boolean).join('\n\n');
  }
  const res = await chrome.runtime.sendMessage({ type: 'GET_MEMORY_SOURCE', tabId, source });
  if (!res?.ok) throw new Error(res?.error || 'Could not read page source.');
  return (res.result?.text || '').trim();
}

function renderMemoryPreview(result) {
  lastMemoryPack = result;
  const preview = document.getElementById('memoryPreview');
  preview.innerHTML = '';
  (result.hits || []).forEach((hit) => {
    const item = document.createElement('label');
    item.className = 'preview-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.hitId = hit.memory_id;
    checkbox.addEventListener('change', () => {
      document.getElementById('memoryPackMarkdown').value = composeMarkdownFromCheckedHits();
    });

    const body = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = `${hit.memory_id}  ${hit.class}/${hit.type}`;
    const meta = document.createElement('div');
    meta.className = 'preview-meta';
    meta.textContent = `score ${Number(hit.score || 0).toFixed(2)} | ${hit.source || ''}`;
    const snippet = document.createElement('div');
    snippet.textContent = hit.snippet || '';
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(snippet);
    item.appendChild(checkbox);
    item.appendChild(body);
    preview.appendChild(item);
  });
  if (!result.hits?.length) {
    const empty = document.createElement('div');
    empty.className = 'history-item';
    empty.textContent = 'No hits returned.';
    preview.appendChild(empty);
  }
  document.getElementById('memoryPackMarkdown').value = result.markdown || '';
}

async function previewMemoryPack() {
  setMemoryStatus('Reading query source...');
  await saveMemorySettings(Boolean(document.getElementById('memoryStoredToken').value.trim()));
  const memory = getMemorySettingsFromUI(false);
  const source = document.getElementById('memorySource').value;
  const query = await getMemorySourceText(source);
  document.getElementById('memoryManualQuery').value = query;
  if (!query) {
    setMemoryStatus('No query text found.');
    return;
  }
  setMemoryStatus('Fetching memory preview...');
  const body = {
    query,
    query_source: source,
    project: memory.project || 'global',
    scope: 'global',
    max_tokens: memory.maxTokens,
    top_k: memory.topK,
    min_score: memory.minScore,
    mode: memory.mode,
    pinned_policy: memory.pinnedPolicy,
    include_classes: memory.includeClasses,
    exclude_classes: memory.excludeClasses || [],
    return_format: 'json',
  };
  const res = await chrome.runtime.sendMessage({ type: 'PREVIEW_MEMORY_PACK', body });
  if (!res?.ok) {
    setMemoryStatus(`Preview failed: ${res?.error || 'unknown error'}`);
    return;
  }
  renderMemoryPreview(res.result);
  setMemoryStatus(`Preview ready: ${(res.result.hits || []).length} hits, ${res.result.estimated_tokens || 0} tokens`);
}

async function insertMemoryPack() {
  const markdown = composeMarkdownFromCheckedHits() || document.getElementById('memoryPackMarkdown').value.trim();
  if (!markdown) {
    setMemoryStatus('No pack to insert.');
    return;
  }
  const behavior = document.getElementById('memoryInsertBehavior').value;
  if (behavior === 'copy_only') {
    await navigator.clipboard.writeText(markdown);
    setMemoryStatus('Copied pack');
    return;
  }
  const tabId = await getActiveTabId();
  const res = await chrome.runtime.sendMessage({ type: 'INSERT_MEMORY_PACK', tabId, markdown, behavior });
  if (res?.ok && res.result?.ok !== false) {
    setMemoryStatus(res.result?.replaced ? 'Replaced existing memory pack' : 'Inserted memory pack');
  } else {
    await navigator.clipboard.writeText(markdown);
    setMemoryStatus(`Insert failed; copied pack instead. ${res?.error || res?.result?.error || ''}`.trim());
  }
}

async function copyMemoryPack() {
  const markdown = composeMarkdownFromCheckedHits() || document.getElementById('memoryPackMarkdown').value.trim();
  if (!markdown) {
    setMemoryStatus('No pack to copy.');
    return;
  }
  await navigator.clipboard.writeText(markdown);
  setMemoryStatus('Copied pack');
}

async function healthCheckMemory() {
  setMemoryStatus('Checking memory bridge...');
  await saveMemorySettings(Boolean(document.getElementById('memoryStoredToken').value.trim()));
  const res = await chrome.runtime.sendMessage({ type: 'MEMORY_HEALTH_CHECK' });
  if (!res?.ok) {
    setMemoryStatus(res?.error || 'Health check failed');
    return;
  }
  const sha = res.health?.token_sha8 ? ` token ${res.health.token_sha8}` : '';
  document.getElementById('memoryTokenStatus').textContent = sha ? `Bridge${sha}` : 'Bridge reachable';
  const projectList = document.getElementById('memoryProjectList');
  projectList.innerHTML = '';
  (res.projects || []).forEach((project) => {
    const option = document.createElement('option');
    option.value = project.project || project.name || project;
    projectList.appendChild(option);
  });
  setMemoryStatus(`Bridge reachable${sha}`);
}

document.getElementById('themeSelect').addEventListener('change', async (e) => {
  const val = e.target.value;
  applyTheme(val);
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { theme: val } });
});

document.getElementById('tabQueue').addEventListener('click', () => setActiveTab('queue'));
document.getElementById('tabMemory').addEventListener('click', () => setActiveTab('memory'));
document.getElementById('tabSettings').addEventListener('click', () => setActiveTab('settings'));
document.getElementById('memoryOpenPackBtn').addEventListener('click', () => setActiveTab('memory'));
document.getElementById('memorySource').addEventListener('change', (e) => {
  document.getElementById('memoryDefaultSource').value = e.target.value;
});
document.getElementById('memoryDefaultSource').addEventListener('change', (e) => {
  document.getElementById('memorySource').value = e.target.value;
});

['maxWaitSec','stableSec','pollSec','systemPrompt','prependSystemPrompt'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', saveSettingsFromUI);
});

[
  'memorySource',
  'memoryProject',
  'memoryMode',
  'memoryMaxTokens',
  'memoryTopK',
  'memoryPinnedPolicy',
  'memoryBridgeBaseUrl',
  'memoryAuthMode',
  'memoryDefaultSource',
  'memoryDefaultProject',
  'memoryInsertBehavior',
  'memoryDebug',
].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => saveMemorySettings(false));
});

document.getElementById('memoryMinScore').addEventListener('input', (e) => {
  document.getElementById('memoryMinScoreValue').textContent = Number(e.target.value || 0).toFixed(2);
});
document.getElementById('memoryMinScore').addEventListener('change', () => saveMemorySettings(false));
document.querySelectorAll('[data-memory-class]').forEach((el) => {
  el.addEventListener('change', () => saveMemorySettings(false));
});
document.getElementById('memorySaveSettingsBtn').addEventListener('click', () => saveMemorySettings(true));
document.getElementById('memoryClearTokenBtn').addEventListener('click', async () => {
  document.getElementById('memoryStoredToken').value = '';
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { memory: { storedToken: '' } } });
  await loadSettingsIntoUI();
  setMemoryStatus('Stored token cleared');
});
document.getElementById('memoryResetSettingsBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: {
      memory: {
        bridgeBaseUrl: 'http://127.0.0.1:5599',
        authMode: 'native_host',
        querySource: 'prompt_box',
        project: 'global',
        mode: 'smart',
        maxTokens: 800,
        topK: 8,
        minScore: 0.2,
        pinnedPolicy: 'relevant_only',
        includeClasses: [],
        excludeClasses: [],
        insertBehavior: 'prepend_or_replace_managed_block',
        debug: false,
      },
    },
  });
  await loadSettingsIntoUI();
  setMemoryStatus('Memory settings reset');
});
document.getElementById('memoryHealthBtn').addEventListener('click', healthCheckMemory);
document.getElementById('memoryPreviewBtn').addEventListener('click', () => previewMemoryPack().catch((e) => setMemoryStatus(`Preview failed: ${e}`)));
document.getElementById('memoryInsertBtn').addEventListener('click', () => insertMemoryPack().catch((e) => setMemoryStatus(`Insert failed: ${e}`)));
document.getElementById('memoryCopyBtn').addEventListener('click', () => copyMemoryPack().catch((e) => setMemoryStatus(`Copy failed: ${e}`)));

document.getElementById('startBtn').addEventListener('click', async () => {
  const textarea = document.getElementById('prompts');
  const prompts = parsePrompts(textarea.value);
  if (prompts.length === 0) {
    setStatus('Please enter at least one prompt.');
    return;
  }
  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus('No active tab found.');
    return;
  }
  setStatus('Starting...');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'START_AUTOMATION', prompts, tabId });
    if (res?.ok) {
      setStatus(`Running prompt 1 of ${prompts.length}...`);
      setProgress(0, prompts.length);
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      await chrome.runtime.sendMessage({ type: 'SAVE_PROMPT_HISTORY', item: { prompts, settings: settings?.settings } });
    } else {
      setStatus(`Failed to start: ${res?.error || 'Unknown error'}`);
    }
  } catch (e) {
    setStatus(`Failed to start: ${e}`);
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION' });
    setStatus('Stopped');
  } catch (e) {
    setStatus('Stop failed');
  }
});

function createHistoryRow(item, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'history-item';
  const title = item.title || (item.prompts?.slice(0, 1)?.[0] || '').slice(0, 80);
  const date = new Date(item.savedAt || Date.now()).toLocaleString();

  const row = document.createElement('div');
  row.className = 'history-row';

  const left = document.createElement('div');
  left.style.flex = '1';
  left.style.whiteSpace = 'nowrap';
  left.style.overflow = 'hidden';
  left.style.textOverflow = 'ellipsis';
  left.textContent = `${date}: ${title}`;
  left.title = (item.prompts || []).join('\n');

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
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DELETE_PROMPT_HISTORY', index });
    await loadHistoryIntoUI();
  });

  ctrls.appendChild(loadBtn);
  ctrls.appendChild(delBtn);

  row.appendChild(left);
  row.appendChild(ctrls);
  wrapper.appendChild(row);
  return wrapper;
}

async function loadHistoryIntoUI() {
  const list = document.getElementById('history');
  list.innerHTML = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PROMPT_HISTORY' });
    if (res?.ok) {
      (res.history || []).forEach((item, idx) => {
        list.appendChild(createHistoryRow(item, idx));
      });
    }
  } catch (_e) {}
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'AUTOMATION_PROGRESS' && message.status) {
    const { currentIndex, total } = message.status;
    setStatus(`Running prompt ${currentIndex + 1} of ${total}...`);
    setProgress(currentIndex, total);
  } else if (message?.type === 'AUTOMATION_COMPLETE') {
    setStatus('Complete');
    setProgress(1, 1);
  } else if (message?.type === 'AUTOMATION_ERROR') {
    setStatus(`Error: ${message.error}`);
  }
});

(async function init() {
  await loadSettingsIntoUI();
  await loadHistoryIntoUI();
  await refreshStatus();
})();
