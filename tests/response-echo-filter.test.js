const path = require('path');
window.__PROMPT_QUEUE_TEST__ = true;
require(path.join(__dirname, '..', 'vendor', 'driftwatch.js'));
require(path.join(__dirname, '..', 'content-targets.js'));
require(path.join(__dirname, '..', 'content-input.js'));
require(path.join(__dirname, '..', 'content-status.js'));
require(path.join(__dirname, '..', 'content-chat-state.js'));
require(path.join(__dirname, '..', 'content.js'));

describe('captureLatestAssistantResponse: short-reply echo false positive', () => {
  const capture = (promptText) => window.PromptQueueContentTest.captureLatestAssistantResponse(promptText);

  it('does not mistake a short assistant reply for an echo of its own prompt (regression: "say OK" -> "OK")', () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="conversation-turn-1" data-turn="user">
          <div data-message-author-role="user">say OK</div>
        </section>
        <section data-testid="conversation-turn-2" data-turn="assistant">
          <div data-message-author-role="assistant">OK</div>
        </section>
      </main>
    `;

    const result = capture('say OK');

    // Before the fix: fuzzyIncludes("OK", "say OK") is true (substring containment), so
    // promptIndex was computed from ALL candidates including the assistant's own reply,
    // pointing promptIndex at the assistant candidate itself and excluding it by position;
    // the redundant per-candidate fuzzyIncludes check would have excluded it a second time
    // even without that. ok stayed false forever, so responseStableEnough could never latch
    // and the completion wait ran until the 180s timeout (which is itself disabled by
    // default) — an unbounded hang for any answer textually contained in its own prompt.
    expect(result.ok).toBe(true);
    expect(result.responseText).toBe('OK');
  });

  it('still resolves a long assistant reply that shares no text with the prompt', () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="conversation-turn-1" data-turn="user">
          <div data-message-author-role="user">what is the capital of France</div>
        </section>
        <section data-testid="conversation-turn-2" data-turn="assistant">
          <div data-message-author-role="assistant">The capital of France is Paris.</div>
        </section>
      </main>
    `;

    const result = capture('what is the capital of France');

    expect(result.ok).toBe(true);
    expect(result.responseText).toBe('The capital of France is Paris.');
  });

  it('still excludes the true echoed prompt turn when no assistant turn exists yet', () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="conversation-turn-1" data-turn="user">
          <div data-message-author-role="user">say OK</div>
        </section>
      </main>
    `;

    const result = capture('say OK');

    expect(result.ok).toBe(false);
  });
});
