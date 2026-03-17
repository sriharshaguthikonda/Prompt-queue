import { parsePrompts, applyTypoVariantsToExactDuplicates, PROMPT_SEPARATOR } from './popup-dom-utils.js';

export const NEW_TAB_MARKER = '---new tab---';
export const APPEND_MARKER = '---append here---';

export function resolveSeparator(raw) {
  if (!raw || typeof raw !== 'string') return PROMPT_SEPARATOR;
  // Support literal "\n" sequences entered by the user.
  return raw.replace(/\\n/g, '\n');
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

export function buildPromptLaunchPlan(rawText, separatorRaw, appendText = '') {
  const separator = resolveSeparator(separatorRaw);
  const parsedPrompts = parsePrompts(rawText, separator);
  
  // Process prompts to handle append markers
  const processedPrompts = [];
  let appendNext = false;
  
  for (const prompt of parsedPrompts) {
    if (isNewTabMarker(prompt)) {
      processedPrompts.push({ type: 'marker', marker: 'tab', original: prompt });
      appendNext = false;
    } else if (isAppendMarker(prompt)) {
      processedPrompts.push({ type: 'marker', marker: 'append', original: prompt });
      appendNext = true;
    } else {
      // Regular prompt - apply append if flag is set
      const finalPrompt = appendNext && appendText ? `${prompt} ${appendText}` : prompt;
      processedPrompts.push({ type: 'prompt', text: finalPrompt, original: prompt });
      appendNext = false; // Reset after use
    }
  }
  
  // Extract just the prompt texts for processing
  const promptTexts = processedPrompts.filter(item => item.type === 'prompt').map(item => item.text);
  const duplicateAdjusted = applyTypoVariantsToExactDuplicates(promptTexts);
  
  // Build the final structure with markers
  const promptsWithMarkers = [];
  let adjustedIndex = 0;
  
  for (const item of processedPrompts) {
    if (item.type === 'marker') {
      promptsWithMarkers.push(item.marker === 'tab' ? NEW_TAB_MARKER : APPEND_MARKER);
    } else {
      promptsWithMarkers.push(duplicateAdjusted.prompts[adjustedIndex] || item.text);
      adjustedIndex += 1;
    }
  }
  
  const prompts = processedPrompts.filter(item => item.type === 'prompt').map(item => item.text);
  const hasTabMarkers = processedPrompts.some(item => item.marker === 'tab');
  const hasAppendMarkers = processedPrompts.some(item => item.marker === 'append');
  
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
    duplicateChanged: duplicateAdjusted.changed,
  };
}
