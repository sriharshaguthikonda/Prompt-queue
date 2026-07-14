describe('BackgroundPromptJobs', () => {
  let helpers;

  beforeAll(() => {
    delete global.BackgroundPromptJobs;
    jest.resetModules();
    require('../background-prompt-jobs.js');
    helpers = global.BackgroundPromptJobs;
  });

  test('normalizes prompt job correlations with optional prompt id', () => {
    expect(helpers.normalizePromptJobCorrelation({
      id: ' job-1 ',
      wantResult: true,
      claimedFile: ' job_1.claimed.json ',
      source: ' model_bridge ',
      target_url: ' https://chatgpt.com/c/abc ',
      new_chat: true,
    }, {
      folder: ' C:/jobs ',
      allowMissingPromptId: true,
    })).toEqual({
      jobId: 'job-1',
      wantResult: true,
      promptId: null,
      claimedFile: 'job_1.claimed.json',
      folder: 'C:/jobs',
      source: 'model_bridge',
      conversationKey: 'default',
      targetUrl: 'https://chatgpt.com/c/abc',
      newChat: true,
    });
    expect(helpers.normalizePromptJobCorrelation({
      id: 'job-2',
      want_result: true,
      payload: {
        target_url: 'https://chat.openai.com/c/raw',
        new_chat: true,
      },
    }).targetUrl).toBe('https://chat.openai.com/c/raw');
  });

  test('detects deferred finish only for want_result jobs', () => {
    expect(helpers.shouldDeferFinish({ wantResult: true })).toBe(true);
    expect(helpers.shouldDeferFinish({ want_result: true })).toBe(true);
    expect(helpers.shouldDeferFinish({ wantResult: false })).toBe(false);
    expect(helpers.shouldDeferFinish(null)).toBe(false);
  });

  test('builds finish_job messages with response and error payloads', () => {
    expect(helpers.buildFinishMessage({
      folder: 'C:/jobs',
      claimedFile: 'job.claimed.json',
      status: 'done',
      responseText: 'answer',
      conversationUrl: 'https://chatgpt.com/c/abc',
    })).toEqual({
      type: 'finish_job',
      folder: 'C:/jobs',
      claimedFile: 'job.claimed.json',
      status: 'done',
      responseText: 'answer',
      conversationUrl: 'https://chatgpt.com/c/abc',
    });

    expect(helpers.buildFinishMessage({
      folder: 'C:/jobs',
      claimedFile: 'job.claimed.json',
      status: 'error',
      error: new Error('insertion_mismatch'),
    })).toMatchObject({
      type: 'finish_job',
      status: 'error',
      error: 'insertion_mismatch',
    });
  });

  test('detects empty responses', () => {
    expect(helpers.isEmptyResponse('')).toBe(true);
    expect(helpers.isEmptyResponse('   \n')).toBe(true);
    expect(helpers.isEmptyResponse(null)).toBe(true);
    expect(helpers.isEmptyResponse('answer')).toBe(false);
  });

  test('matches composer text with normalized equality', () => {
    expect(helpers.composerTextMatches('hello   world', 'hello world')).toBe(true);
    expect(helpers.composerTextMatches(' hello\r\nworld ', 'hello world')).toBe(true);
    expect(helpers.composerTextMatches('hello world!', 'hello world')).toBe(false);
  });

  test('claim rule respects lower-priority idle live instances only', () => {
    expect(helpers.shouldClaimPromptJob([
      { claimant_id: 'other', priority: 0, busy: false },
    ], 'self', 1)).toBe(false);
    expect(helpers.shouldClaimPromptJob([
      { claimant_id: 'other', priority: 0, busy: true },
    ], 'self', 1)).toBe(true);
    expect(helpers.shouldClaimPromptJob([
      { claimant_id: 'self', priority: 0, busy: false },
    ], 'self', 1)).toBe(true);
    expect(helpers.shouldClaimPromptJob([
      { claimant_id: 'other', priority: 1, busy: false },
    ], 'self', 1)).toBe(true);
  });

  test('validates prompt job target URLs', () => {
    expect(helpers.isAllowedPromptJobTargetUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(helpers.isAllowedPromptJobTargetUrl('https://chat.openai.com/c/abc')).toBe(true);
    expect(helpers.isAllowedPromptJobTargetUrl('http://chatgpt.com/c/abc')).toBe(false);
    expect(helpers.isAllowedPromptJobTargetUrl('https://chatgpt.com.evil/c/abc')).toBe(false);
  });

  test('bridge tab chooser never returns a non-member tab', () => {
    expect(helpers.chooseBridgeTab([
      { id: 10, url: 'https://chatgpt.com/', lastAccessed: 10 },
      { id: 20, url: 'https://chatgpt.com/', lastAccessed: 20 },
    ], [10])).toEqual({ action: 'reuse', tabId: 10 });
    expect(helpers.chooseBridgeTab([
      { id: 20, url: 'https://chatgpt.com/', lastAccessed: 20 },
    ], [10])).toEqual({ action: 'create' });
    expect(helpers.chooseBridgeTab([
      { id: 10, url: 'https://chatgpt.com/', active: true, windowFocused: true },
      { id: 11, url: 'https://chatgpt.com/', active: false, windowFocused: true },
    ], [10, 11], { preferredTabId: 10 })).toEqual({ action: 'reuse', tabId: 11 });
  });
});
