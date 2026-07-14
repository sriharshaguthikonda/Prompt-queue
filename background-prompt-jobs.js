(function registerBackgroundPromptJobs() {
  if (self.BackgroundPromptJobs) {
    return;
  }

  function stringOrNull(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  function isWantResult(value) {
    return value === true || value === 'true' || value === 1;
  }

  function normalizeConversationKey(value) {
    const key = stringOrNull(value);
    return key || 'default';
  }

  function normalizePromptJobCorrelation(job, opts = {}) {
    const source = job && typeof job === 'object' ? job : {};
    const rawPayload = source.payload && typeof source.payload === 'object' ? source.payload : {};
    const promptId = stringOrNull(source.promptId || opts.promptId);
    return {
      jobId: stringOrNull(source.jobId || source.id),
      wantResult: isWantResult(source.wantResult) || isWantResult(source.want_result),
      promptId: promptId || null,
      claimedFile: stringOrNull(source.claimedFile),
      folder: stringOrNull(source.folder || opts.folder),
      source: stringOrNull(source.source),
      conversationKey: normalizeConversationKey(source.conversationKey || source.conversation_key || opts.conversationKey),
      targetUrl: stringOrNull(source.targetUrl || source.target_url || rawPayload.target_url || rawPayload.targetUrl),
      newChat: source.newChat === true || source.new_chat === true || rawPayload.new_chat === true || rawPayload.newChat === true,
    };
  }

  function shouldDeferFinish(job) {
    const source = job && typeof job === 'object' ? job : {};
    return isWantResult(source.wantResult) || isWantResult(source.want_result);
  }

  function buildFinishMessage(input = {}) {
    const status = input.status === 'error' ? 'error' : 'done';
    const message = {
      type: 'finish_job',
      folder: input.folder,
      claimedFile: input.claimedFile,
      status,
    };
    if (status === 'done' && typeof input.responseText === 'string') {
      message.responseText = input.responseText;
    }
    if (typeof input.conversationUrl === 'string') {
      message.conversationUrl = input.conversationUrl;
    }
    if (status === 'error' && input.error !== undefined && input.error !== null) {
      message.error = normalizePromptJobError(input.error);
    }
    return message;
  }

  function shouldClaimPromptJob(instances, ownClaimantId, ownPriority) {
    const ownId = stringOrNull(ownClaimantId);
    const priority = Number.isFinite(Number(ownPriority)) ? Number(ownPriority) : 0;
    const aliveInstances = Array.isArray(instances) ? instances : [];
    return !aliveInstances.some((instance) => {
      if (!instance || typeof instance !== 'object') return false;
      const claimantId = stringOrNull(instance.claimant_id || instance.claimantId);
      if (ownId && claimantId === ownId) return false;
      if (instance.busy === true) return false;
      const instancePriority = Number(instance.priority);
      return Number.isFinite(instancePriority) && instancePriority < priority;
    });
  }

  function isAllowedPromptJobTargetUrl(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'https:'
        && (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'chat.openai.com')
        && (trimmed === parsed.origin || trimmed.startsWith(`${parsed.protocol}//${parsed.hostname}/`));
    } catch (_) {
      return false;
    }
  }

  function chooseBridgeTab(candidates, bridgeTabIds, opts = {}) {
    const bridgeIds = new Set(Array.isArray(bridgeTabIds) ? bridgeTabIds.map(Number).filter(Number.isInteger) : []);
    const preferredId = Number(opts.preferredTabId);
    const validCandidates = (Array.isArray(candidates) ? candidates : [])
      .filter((tab) => tab && Number.isInteger(Number(tab.id)) && bridgeIds.has(Number(tab.id)))
      .filter((tab) => !tab.discarded)
      .filter((tab) => isAllowedPromptJobTargetUrl(tab.url || 'https://chatgpt.com/'))
      .sort((a, b) => {
        if (Number(a.id) === preferredId) return -1;
        if (Number(b.id) === preferredId) return 1;
        return (b.lastAccessed || 0) - (a.lastAccessed || 0);
      });
    const usable = validCandidates.find((tab) => !(tab.active === true && tab.windowFocused === true));
    if (usable) {
      return { action: 'reuse', tabId: Number(usable.id) };
    }
    return { action: 'create' };
  }

  function isEmptyResponse(value) {
    return typeof value !== 'string' || value.trim().length === 0;
  }

  function normalizeComparableText(value) {
    return String(value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function composerTextMatches(actual, expected) {
    const actualText = normalizeComparableText(actual);
    const expectedText = normalizeComparableText(expected);
    if (actualText === expectedText) return true;
    if (!actualText || !expectedText) return false;
    // ponytail: cheap guard only; avoid storing or diffing prompt contents.
    return actualText.length === expectedText.length
      && actualText.slice(0, 160) === expectedText.slice(0, 160);
  }

  function normalizePromptJobError(error) {
    const message = String(error?.message || error || 'prompt_job_failed').trim();
    return message.replace(/^Error:\s*/i, '') || 'prompt_job_failed';
  }

  const LEGACY_PROMPT_JOBS_FOLDER = 'C:\\Windows_software\\openai whisper\\prompt_jobs';
  const CURRENT_PROMPT_JOBS_FOLDER = 'C:\\AI\\bridge_jobs\\chatgpt_browser';

  // One-time migration off the folder shared with whisper (its 10-min GC
  // deletes long-running bridge jobs). Only the exact legacy path migrates;
  // custom folders are the user's choice and stay untouched.
  function migratePromptJobsFolder(folder) {
    if (typeof folder !== 'string') return folder;
    if (folder.trim().toLowerCase() === LEGACY_PROMPT_JOBS_FOLDER.toLowerCase()) {
      return CURRENT_PROMPT_JOBS_FOLDER;
    }
    return folder;
  }

  self.BackgroundPromptJobs = {
    normalizePromptJobCorrelation,
    normalizeConversationKey,
    shouldDeferFinish,
    buildFinishMessage,
    shouldClaimPromptJob,
    isAllowedPromptJobTargetUrl,
    chooseBridgeTab,
    isEmptyResponse,
    composerTextMatches,
    normalizePromptJobError,
    migratePromptJobsFolder,
  };
})();
