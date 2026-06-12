describe('content-chat-state', () => {
  const chatState = () => window.PromptQueueChatState;

  function setVisible(el) {
    el.getBoundingClientRect = () => ({ width: 120, height: 24 });
    return el;
  }

  it('treats stale loading shimmer with a response action marker as non-blocking completion evidence', () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
      <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
      <main>
        <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
        <article data-testid="conversation-turn-2" data-message-author-role="assistant">
          <div class="loading-shimmer">Loading</div>
          Assistant answer
          <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
        </article>
      </main>
    `;
    setVisible(document.querySelector('.loading-shimmer'));
    setVisible(document.querySelector('button[data-testid="copy-turn-action-button"]'));

    const result = chatState().classifyChatGPTDomActivity({
      responseScope: document.querySelector('article[data-testid="conversation-turn-2"]'),
      responseText: 'Assistant answer',
      responseStableForMs: 600,
      stableMs: 500,
    });

    expect(result.loadingShimmer).toBe(true);
    expect(result.loadingShimmerHardBlock).toBe(false);
    expect(result.staleLoadingShimmer).toBe(true);
    expect(result.responseCompletionEvidence).toBe(true);
    expect(result.active).toBe(false);
  });

  it('keeps visible loading shimmer hard-blocking when no completion marker is present', () => {
    document.body.innerHTML = `
      <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
      <main>
        <article data-testid="conversation-turn-1" data-message-author-role="assistant">
          <div class="loading-shimmer">Loading</div>
          Assistant answer
        </article>
      </main>
    `;
    setVisible(document.querySelector('.loading-shimmer'));

    const result = chatState().classifyChatGPTDomActivity({
      responseScope: document.querySelector('article[data-testid="conversation-turn-1"]'),
      responseText: 'Assistant answer',
      responseStableForMs: 600,
      stableMs: 500,
    });

    expect(result.loadingShimmer).toBe(true);
    expect(result.loadingShimmerHardBlock).toBe(true);
    expect(result.blockingReasons).toContain('loadingShimmer');
    expect(result.active).toBe(true);
  });

  it('treats a send-labeled composer with stale stop test id as send-ready, not stop-active', () => {
    document.body.innerHTML = `
      <button id="composer-submit-button" data-testid="stop-button" aria-label="Send prompt">Send</button>
    `;
    const button = setVisible(document.getElementById('composer-submit-button'));

    const role = chatState().getComposerActionRole(button);
    const stopActive = chatState().isActiveStopButton(button);

    expect(role.role).toBe('send-ready');
    expect(stopActive).toBe(false);
  });

  it('does not treat a disabled empty send composer as active generation', () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
      <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
    `;
    setVisible(document.getElementById('composer-submit-button'));

    const result = chatState().classifyChatGPTDomActivity();

    expect(result.composerRole.role).toBe('send-disabled');
    expect(result.stopPresent).toBe(false);
    expect(result.active).toBe(false);
    expect(result.blockingReasons).toEqual([]);
  });

  it('includes sanitized activity diagnostics for stale shimmer and composer role decisions', () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
      <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled class="composer-button">Send</button>
      <main>
        <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
        <article data-testid="conversation-turn-2" data-message-author-role="assistant">
          <div class="loading-shimmer status-node">Loading</div>
          Assistant answer
          <button data-testid="copy-turn-action-button" aria-label="Copy response" class="response-action">Copy response</button>
        </article>
      </main>
    `;
    setVisible(document.getElementById('composer-submit-button'));
    setVisible(document.querySelector('.loading-shimmer'));
    setVisible(document.querySelector('button[data-testid="copy-turn-action-button"]'));

    const result = chatState().classifyChatGPTDomActivity({
      stopButtonSelector: 'button[data-testid="stop-button"]',
      responseScope: document.querySelector('article[data-testid="conversation-turn-2"]'),
      responseText: 'Assistant answer',
      responseStableForMs: 600,
      stableMs: 500,
    });

    expect(result.activityDiagnostics.selectorUsed).toBe('button[data-testid="stop-button"]');
    expect(result.activityDiagnostics.composerAction).toMatchObject({
      ariaLabel: 'Send prompt',
      dataTestId: 'send-button',
      roleDecision: 'send-disabled',
      roleReason: 'send-disabled-label',
      disabled: true,
      visible: true,
      classSnippet: 'composer-button',
    });
    expect(result.activityDiagnostics.loadingShimmer).toMatchObject({
      textLength: 7,
      stale: true,
      visible: true,
      classSnippet: 'loading-shimmer status-node',
    });
    expect(result.activityDiagnostics.responseCompletionMarkers[0]).toMatchObject({
      selector: 'button[data-testid="copy-turn-action-button"]',
      label: 'Copy response',
    });
    expect(result.activityDiagnostics.responseCompletionMarkers[0].node).toMatchObject({
      ariaLabel: 'Copy response',
      dataTestId: 'copy-turn-action-button',
      textLength: 13,
      visible: true,
      classSnippet: 'response-action',
    });
    expect(result.activityDiagnostics.finalDecisionReason).toBe('inactive:stableResponseMarkers');
  });
});
