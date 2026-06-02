(function () {
  const STATUS_VERSION = '2026-06-02.status-v1';
  if (window.PromptQueueStatus?.version === STATUS_VERSION) return;

  const STEP_META = Object.freeze({
    waiting_for_tab: { label: 'Waiting for tab', color: 'waiting' },
    populating: { label: 'Populating prompt box', color: 'active' },
    post_populate_delay: { label: 'Post-populate delay', color: 'waiting' },
    pre_send_quiet_window: { label: 'Pre-send quiet window', color: 'waiting' },
    sending: { label: 'Sending prompt', color: 'active' },
    waiting_for_response: { label: 'Waiting for response', color: 'waiting' },
    completion_wait: { label: 'Completion wait', color: 'waiting' },
    retry_wait: { label: 'Retry wait', color: 'paused' },
    paused: { label: 'Paused', color: 'paused' },
    error: { label: 'Error', color: 'error' },
    complete: { label: 'Step complete', color: 'idle' },
  });

  function getStepMeta(step) {
    return STEP_META[step] || { label: String(step || 'Working'), color: 'active' };
  }

  function emitStepUpdate({
    step,
    promptId = null,
    detail = '',
    durationMs = 0,
    endAt = 0,
    source = 'content',
    log = false,
  } = {}) {
    const meta = getStepMeta(step);
    const payload = {
      type: 'PROMPT_STEP_STATUS',
      promptId,
      status: {
        step,
        label: meta.label,
        color: meta.color,
        detail: String(detail || '').slice(0, 120),
        durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : 0,
        endAt: Number.isFinite(Number(endAt)) ? Math.max(0, Math.round(Number(endAt))) : 0,
        startedAt: Date.now(),
        source,
      },
    };
    try {
      chrome.runtime.sendMessage(payload);
    } catch (_) {}
    if (log) {
      console.log('[StepStatus]', {
        step: payload.status.step,
        label: payload.status.label,
        color: payload.status.color,
        durationMs: payload.status.durationMs,
        hasEndAt: payload.status.endAt > 0,
        promptId,
      });
    }
    return payload.status;
  }

  function delayWithStatus({
    step,
    promptId = null,
    durationMs = 0,
    detail = '',
    pollMs = 250,
    log = false,
  } = {}) {
    const ms = Math.max(0, Math.round(Number(durationMs) || 0));
    if (ms <= 0) return Promise.resolve();
    const endAt = Date.now() + ms;
    emitStepUpdate({ step, promptId, detail, durationMs: ms, endAt, log });
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (Date.now() >= endAt) {
          clearInterval(timer);
          emitStepUpdate({ step: 'complete', promptId, detail: `${step} complete`, log });
          resolve();
        }
      }, Math.max(50, Number(pollMs) || 250));
    });
  }

  window.PromptQueueStatus = Object.freeze({
    version: STATUS_VERSION,
    delayWithStatus,
    emitStepUpdate,
    getStepMeta,
  });
})();
