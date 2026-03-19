import { parsePrompts, applyTypoVariantsToExactDuplicates, PROMPT_SEPARATOR } from './popup-dom-utils.js';

export const NEW_TAB_MARKER = '---new tab---';
export const APPEND_MARKER = '---append here---';
export const PREPEND_MARKER = '---prepend here---';
export const LINE_PROMPT_MODE_MARKER = '---line prompt mode---';

export function resolveSeparator(raw) {
  if (!raw || typeof raw !== 'string') return PROMPT_SEPARATOR;
  // Support literal "\n" sequences entered by the user.
  return raw.replace(/\\n/g, '\n');
}

function normalizeNewlines(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n');
}

function isNewTabMarker(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  // Match dash format variations like ---new tab---, ----new tab----, etc.
  return /^-+new\s+tab-+$/.test(trimmed);
}

function isAppendMarker(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  // Match dash format variations like ---append here---, ----append here----, etc.
  return /^-+append\s+here-+$/.test(trimmed);
}

function isPrependMarker(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  // Match dash format variations like ---prepend here---, ----prepend here----, etc.
  return /^-+prepend\s+here-+$/.test(trimmed);
}

function isLinePromptModeMarker(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  // Match dash format variations like ---line prompt mode---, ----line prompt mode----, etc.
  return /^-+line\s+prompt\s+mode-+$/.test(trimmed);
}

function isDividerLine(value) {
  if (typeof value !== 'string') return false;
  return /^-{3,}$/.test(value.trim());
}

function isInlineNextPromptSeparatorLine(value) {
  if (typeof value !== 'string') return false;
  return /^-+next\s+prompt-+$/.test(value.trim().toLowerCase());
}

function appendToPrompt(text, appendText) {
  const base = typeof text === 'string' ? text.trim() : '';
  const append = typeof appendText === 'string' ? appendText.trim() : '';
  if (!append) return base;
  if (!base) return append;
  return `${base}\n\n${append}`;
}

function prependToPrompt(text, prependText) {
  const base = typeof text === 'string' ? text.trim() : '';
  const prepend = typeof prependText === 'string' ? prependText.trim() : '';
  if (!prepend) return base;
  if (!base) return prepend;
  return `${prepend}\n\n${base}`;
}

function buildParallelPromptGroupsFromTaggedPrompts(promptsWithMarkers) {
  const groups = [];
  let currentGroup = [];
  for (const prompt of promptsWithMarkers) {
    if (isNewTabMarker(prompt)) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [];
      continue;
    }
    currentGroup.push(prompt);
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  return groups;
}

function hasExplicitLinePromptMode(rawText, parsedPrompts) {
  if (typeof rawText === 'string' && rawText.trim()) {
    const lines = normalizeNewlines(rawText).split('\n');
    if (lines.some((line) => isLinePromptModeMarker(line))) {
      return true;
    }
  }
  return parsedPrompts.some((prompt) => isLinePromptModeMarker(prompt));
}

function expandPromptsForLinePromptMode(parsedPrompts) {
  const expanded = [];
  for (const prompt of parsedPrompts) {
    const normalizedPrompt = normalizeNewlines(prompt);
    const lines = normalizedPrompt.split('\n');
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate) continue;
      if (isDividerLine(candidate)) continue;
      if (isInlineNextPromptSeparatorLine(candidate)) continue;
      expanded.push(candidate);
    }
  }
  return expanded;
}

function getLastPromptItem(processedPrompts) {
  for (let i = processedPrompts.length - 1; i >= 0; i -= 1) {
    const item = processedPrompts[i];
    if (item?.type === 'prompt') {
      return item;
    }
    if (item?.type === 'marker' && item.marker === 'tab') {
      return null;
    }
  }
  return null;
}

export function buildPromptLaunchPlan(
  rawText,
  separatorRaw,
  appendText = '',
  appendCheckboxChecked = false,
  prependText = '',
  prependCheckboxChecked = false,
) {
  const separator = resolveSeparator(separatorRaw);
  const normalizedRawText = normalizeNewlines(typeof rawText === 'string' ? rawText : '');
  const normalizedSeparator = normalizeNewlines(separator);
  const parsedPrompts = parsePrompts(normalizedRawText, normalizedSeparator);
  const linePromptModeEnabled = hasExplicitLinePromptMode(normalizedRawText, parsedPrompts);
  const promptCandidates = linePromptModeEnabled
    ? expandPromptsForLinePromptMode(parsedPrompts)
    : parsedPrompts
      .map((prompt) => normalizeNewlines(prompt).trim())
      .filter((prompt) => prompt.length > 0);

  const effectiveAppendText = typeof appendText === 'string' ? appendText.trim() : '';
  const effectivePrependText = typeof prependText === 'string' ? prependText.trim() : '';
  const canUseAppendMarker = appendCheckboxChecked && effectiveAppendText.length > 0;
  const canUsePrependMarker = prependCheckboxChecked && effectivePrependText.length > 0;

  const processedPrompts = [];
  let pendingAppendToNextPrompt = false;
  let pendingPrependToNextPrompt = false;
  let hasTabMarkers = false;
  let hasAppendMarkers = false;
  let hasPrependMarkers = false;

  for (const prompt of promptCandidates) {
    if (isLinePromptModeMarker(prompt)) {
      continue;
    }

    if (isNewTabMarker(prompt)) {
      hasTabMarkers = true;
      pendingAppendToNextPrompt = false;
      pendingPrependToNextPrompt = false;
      processedPrompts.push({ type: 'marker', marker: 'tab', original: prompt });
      continue;
    }

    if (isAppendMarker(prompt)) {
      hasAppendMarkers = true;
      if (canUseAppendMarker) {
        const lastPromptItem = getLastPromptItem(processedPrompts);
        if (lastPromptItem) {
          lastPromptItem.text = appendToPrompt(lastPromptItem.text, effectiveAppendText);
        } else {
          pendingAppendToNextPrompt = true;
        }
      }
      continue;
    }

    if (isPrependMarker(prompt)) {
      hasPrependMarkers = true;
      if (canUsePrependMarker) {
        const lastPromptItem = getLastPromptItem(processedPrompts);
        if (lastPromptItem) {
          lastPromptItem.text = prependToPrompt(lastPromptItem.text, effectivePrependText);
        } else {
          pendingPrependToNextPrompt = true;
        }
      }
      continue;
    }

    let promptText = prompt;
    if (pendingPrependToNextPrompt && canUsePrependMarker) {
      promptText = prependToPrompt(promptText, effectivePrependText);
      pendingPrependToNextPrompt = false;
    }
    if (pendingAppendToNextPrompt && canUseAppendMarker) {
      promptText = appendToPrompt(promptText, effectiveAppendText);
      pendingAppendToNextPrompt = false;
    }
    processedPrompts.push({ type: 'prompt', text: promptText, original: prompt });
  }

  const promptTexts = processedPrompts
    .filter((item) => item.type === 'prompt')
    .map((item) => item.text);
  const duplicateAdjusted = applyTypoVariantsToExactDuplicates(promptTexts);

  const promptsWithMarkers = [];
  const prompts = [];
  let adjustedIndex = 0;
  for (const item of processedPrompts) {
    if (item.type === 'marker' && item.marker === 'tab') {
      promptsWithMarkers.push(NEW_TAB_MARKER);
      continue;
    }
    const adjustedText = duplicateAdjusted.prompts[adjustedIndex] || item.text;
    promptsWithMarkers.push(adjustedText);
    prompts.push(adjustedText);
    adjustedIndex += 1;
  }

  const tabPromptGroups = hasTabMarkers
    ? buildParallelPromptGroupsFromTaggedPrompts(promptsWithMarkers)
    : prompts.map((prompt) => [prompt]);

  return {
    separator,
    prompts,
    promptsWithMarkers,
    tabPromptGroups,
    hasTabMarkers,
    hasAppendMarkers,
    hasPrependMarkers,
    linePromptModeEnabled,
    duplicateChanged: duplicateAdjusted.changed,
  };
}
