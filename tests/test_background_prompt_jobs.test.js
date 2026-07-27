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

describe('BackgroundPromptJobs.migratePromptJobsFolder', () => {
  let helpers;

  beforeAll(() => {
    delete global.BackgroundPromptJobs;
    jest.resetModules();
    require('../background-prompt-jobs.js');
    helpers = global.BackgroundPromptJobs;
  });

  test('migrates the exact legacy whisper folder to the bridge jobs root', () => {
    expect(helpers.migratePromptJobsFolder('C:\\Windows_software\\openai whisper\\prompt_jobs'))
      .toBe('C:\\AI\\bridge_jobs\\chatgpt_browser');
  });

  test('migrates case-insensitively and with surrounding whitespace', () => {
    expect(helpers.migratePromptJobsFolder(' c:\\windows_software\\openai whisper\\prompt_jobs '))
      .toBe('C:\\AI\\bridge_jobs\\chatgpt_browser');
  });

  test('leaves custom, empty, and new folders untouched', () => {
    expect(helpers.migratePromptJobsFolder('D:\\my\\jobs')).toBe('D:\\my\\jobs');
    expect(helpers.migratePromptJobsFolder('')).toBe('');
    expect(helpers.migratePromptJobsFolder('C:\\AI\\bridge_jobs\\chatgpt_browser'))
      .toBe('C:\\AI\\bridge_jobs\\chatgpt_browser');
    expect(helpers.migratePromptJobsFolder(undefined)).toBe(undefined);
  });
});

describe('BackgroundPromptJobs metadata logging', () => {
  let helpers;

  beforeAll(() => {
    delete global.BackgroundPromptJobs;
    jest.resetModules();
    require('../background-prompt-jobs.js');
    helpers = global.BackgroundPromptJobs;
  });

  test('whitelists metadata and coalesces consecutive identical events', () => {
    const first = helpers.normalizePromptJobLogEvent({
      timestamp: '2026-07-27T00:00:00Z', event: 'job_recv', job_id: 'job-1',
      claimant_id: 'worker-1', status: 'pending', reason_code: 'ok', attempts: 0,
      busy: false, port_state: 'connected', prompt: 'never persist this',
      responseText: 'nor this', url: 'https://private.example/', credentials: 'nope',
    });
    const events = helpers.coalescePromptJobLogEvents([first, {
      ...first, timestamp: '2026-07-27T00:00:01Z', prompt: 'also forbidden',
    }]);

    expect(first).toEqual({
      timestamp: '2026-07-27T00:00:00Z', event: 'job_recv', job_id: 'job-1',
      claimant_id: 'worker-1', status: 'pending', reason_code: 'ok', attempts: 0,
      busy: false, port_state: 'connected',
    });
    expect(events).toEqual([{ ...first, repeat_count: 2 }]);
  });

  test('keeps a 250-event ring buffer and flushes it after reconnect', () => {
    const events = Array.from({ length: 252 }, (_, index) => ({ event: 'job_recv', job_id: String(index) }));
    const buffered = helpers.appendPromptJobLogEvents([], events);
    expect(buffered).toHaveLength(250);
    expect(buffered[0].job_id).toBe('2');
    expect(helpers.takePromptJobLogEvents(buffered)).toEqual({ events: buffered, remaining: [] });
  });
});

describe('BackgroundPromptJobs send lifecycle logging', () => {
  let helpers;

  beforeAll(() => {
    delete global.BackgroundPromptJobs;
    jest.resetModules();
    require('../background-prompt-jobs.js');
    helpers = global.BackgroundPromptJobs;
  });

  test('builds one metadata-only send-click event for the matching result job', () => {
    expect(helpers.buildPromptJobSendEvent({
      promptJobCorrelation: { wantResult: true, jobId: 'job-1', promptId: 'prompt-1' },
      currentPromptId: 'prompt-1',
    }, 'prompt-1', 'send-click-dispatched')).toEqual({
      event: 'send',
      stage: 'send',
      job_id: 'job-1',
      status: 'accepted',
      reason_code: 'send_click_dispatched',
    });
    expect(helpers.buildPromptJobSendEvent({
      promptJobCorrelation: { wantResult: true, jobId: 'job-1', promptId: 'other' },
      currentPromptId: 'other',
    }, 'prompt-1', 'send-click-dispatched')).toBeNull();
  });
});
