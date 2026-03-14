import { parsePrompts, applyTypoVariantsToExactDuplicates, PROMPT_SEPARATOR } from './popup-dom-utils.js';

export const NEW_TAB_MARKER = '(new tab)';

export function resolveSeparator(raw) {
  if (!raw || typeof raw !== 'string') return PROMPT_SEPARATOR;
  // Support literal "\n" sequences entered by the user.
  return raw.replace(/\\n/g, '\n');
}

function isNewTabMarker(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === NEW_TAB_MARKER;
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

export function buildPromptLaunchPlan(rawText, separatorRaw) {
  const separator = resolveSeparator(separatorRaw);
  const parsedPrompts = parsePrompts(rawText, separator);
  const promptCandidates = parsedPrompts.filter((prompt) => !isNewTabMarker(prompt));
  const duplicateAdjusted = applyTypoVariantsToExactDuplicates(promptCandidates);

  const promptsWithMarkers = [];
  let adjustedIndex = 0;
  for (const prompt of parsedPrompts) {
    if (isNewTabMarker(prompt)) {
      promptsWithMarkers.push(NEW_TAB_MARKER);
      continue;
    }
    promptsWithMarkers.push(duplicateAdjusted.prompts[adjustedIndex] || prompt);
    adjustedIndex += 1;
  }

  const prompts = promptsWithMarkers.filter((prompt) => !isNewTabMarker(prompt));
  const hasTabMarkers = promptsWithMarkers.some((prompt) => isNewTabMarker(prompt));
  const tabPromptGroups = hasTabMarkers
    ? buildParallelPromptGroupsFromTaggedPrompts(promptsWithMarkers)
    : prompts.map((prompt) => [prompt]);

  return {
    separator,
    prompts,
    promptsWithMarkers,
    tabPromptGroups,
    hasTabMarkers,
    duplicateChanged: duplicateAdjusted.changed,
  };
}
