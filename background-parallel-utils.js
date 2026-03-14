(function registerBackgroundParallelUtils() {
  if (self.BackgroundParallelUtils) {
    return;
  }

  const PARALLEL_CONFIG = {
    maxTabs: 10,
    launchPausePollMs: 250,
  };

  function buildParallelPromptId(workerIndex, promptIndex) {
    return `parallel_${Date.now()}_${workerIndex}_${promptIndex}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildParallelWorkerId(index) {
    return `worker_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function resolveParallelLaunchUrl(baseTabUrl, options, helpers = {}) {
    const sanitizeUrlOrEmpty = helpers.sanitizeUrlOrEmpty || ((value) => (typeof value === 'string' ? value.trim() : ''));
    const isSupportedUrl = helpers.isSupportedUrl || (() => true);
    const customUrl = sanitizeUrlOrEmpty(options?.openNewChatPerPromptUrl);
    const targetUrl = customUrl || baseTabUrl || '';
    if (!isSupportedUrl(targetUrl)) {
      return null;
    }
    return targetUrl;
  }

  function shouldUseParallelMode(options) {
    return options?.parallelOneTabPerPrompt === true;
  }

  function sanitizeParallelPromptGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];
    const sanitized = [];
    for (const group of rawGroups) {
      if (!Array.isArray(group)) continue;
      const normalizedGroup = group
        .filter((prompt) => typeof prompt === 'string')
        .map((prompt) => prompt.trim())
        .filter((prompt) => prompt.length > 0);
      if (normalizedGroup.length > 0) {
        sanitized.push(normalizedGroup);
      }
    }
    return sanitized;
  }

  function resolveParallelPromptGroups(prompts, rawGroups) {
    const explicitGroups = sanitizeParallelPromptGroups(rawGroups);
    if (explicitGroups.length > 0) {
      return explicitGroups;
    }
    return prompts.map((prompt) => [prompt]);
  }

  self.BackgroundParallelUtils = {
    PARALLEL_CONFIG,
    buildParallelPromptId,
    buildParallelWorkerId,
    resolveParallelLaunchUrl,
    shouldUseParallelMode,
    sanitizeParallelPromptGroups,
    resolveParallelPromptGroups,
  };
})();
