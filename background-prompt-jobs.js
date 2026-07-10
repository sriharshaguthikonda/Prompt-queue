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
    const promptId = stringOrNull(source.promptId || opts.promptId);
    return {
      jobId: stringOrNull(source.jobId || source.id),
      wantResult: isWantResult(source.wantResult) || isWantResult(source.want_result),
      promptId: promptId || null,
      claimedFile: stringOrNull(source.claimedFile),
      folder: stringOrNull(source.folder || opts.folder),
      source: stringOrNull(source.source),
      conversationKey: normalizeConversationKey(source.conversationKey || source.conversation_key || opts.conversationKey),
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
    if (status === 'error' && input.error !== undefined && input.error !== null) {
      message.error = normalizePromptJobError(input.error);
    }
    return message;
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

  self.BackgroundPromptJobs = {
    normalizePromptJobCorrelation,
    normalizeConversationKey,
    shouldDeferFinish,
    buildFinishMessage,
    isEmptyResponse,
    composerTextMatches,
    normalizePromptJobError,
  };
})();
