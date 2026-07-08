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
    });
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
    })).toEqual({
      type: 'finish_job',
      folder: 'C:/jobs',
      claimedFile: 'job.claimed.json',
      status: 'done',
      responseText: 'answer',
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
});
