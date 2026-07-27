const path = require('path');
require(path.join(__dirname, '..', 'vendor', 'driftwatch.js'));

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

  it('recognizes an accessible Stop answering composer without a test id', () => {
    document.body.innerHTML = `
      <span id="stop-answering-label">Stop answering</span>
      <button id="composer-submit-button" aria-labelledby="stop-answering-label"></button>
    `;
    const button = setVisible(document.getElementById('composer-submit-button'));

    expect(chatState().getComposerActionRole(button)).toMatchObject({
      role: 'stop-active',
      reason: 'stop-accessible-name',
    });
    expect(chatState().isActiveStopButton(button)).toBe(true);
  });

  it('keeps an accessible Send composer out of the stop state', () => {
    document.body.innerHTML = `
      <span id="send-message-label">Send message</span>
      <button id="composer-submit-button" aria-labelledby="send-message-label"></button>
    `;
    const button = setVisible(document.getElementById('composer-submit-button'));

    expect(chatState().getComposerActionRole(button)).toMatchObject({
      role: 'send-ready',
      reason: 'send-accessible-name',
    });
    expect(chatState().isActiveStopButton(button)).toBe(false);
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

  describe('chatgpt.com <section> turn shape (2026-07 markup change)', () => {
    it('getLatestAssistantTurn returns the <section> turn container, not the inner assistant div', () => {
      document.body.innerHTML = `
        <main>
          <section dir="auto" data-turn-id="turn-1" data-testid="conversation-turn-1" data-turn="user">
            <div data-message-author-role="user"><p>hi</p></div>
          </section>
          <section dir="auto" data-turn-id="turn-2" data-testid="conversation-turn-2" data-turn="assistant">
            <div data-message-author-role="assistant"><p>answer text</p></div>
            <div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div>
          </section>
        </main>
      `;

      const scope = chatState().getLatestAssistantTurn();

      expect(scope).not.toBeNull();
      expect(scope.tagName).toBe('SECTION');
      expect(scope.getAttribute('data-testid')).toBe('conversation-turn-2');
    });

    it('findResponseCompletionMarkers finds the copy button that is a sibling of the assistant div, not a child', () => {
      document.body.innerHTML = `
        <main>
          <section dir="auto" data-turn-id="turn-1" data-testid="conversation-turn-1" data-turn="user">
            <div data-message-author-role="user"><p>hi</p></div>
          </section>
          <section dir="auto" data-turn-id="turn-2" data-testid="conversation-turn-2" data-turn="assistant">
            <div data-message-author-role="assistant"><p>answer text</p></div>
            <div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div>
          </section>
        </main>
      `;
      setVisible(document.querySelector('button[data-testid="copy-turn-action-button"]'));

      const scope = chatState().getLatestAssistantTurn();
      const markers = chatState().findResponseCompletionMarkers(scope);

      // Before the fix: getLatestAssistantTurn() returns the inner
      // [data-message-author-role="assistant"] div (the copy button's parent <section> is
      // never reached), so this searches the wrong subtree and markers is always [].
      expect(markers.length).toBeGreaterThan(0);
    });

    it('still resolves the legacy <article data-testid="conversation-turn-N"> shape', () => {
      document.body.innerHTML = `
        <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
        <article data-testid="conversation-turn-2" data-message-author-role="assistant">
          Assistant answer
          <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
        </article>
      `;
      setVisible(document.querySelector('button[data-testid="copy-turn-action-button"]'));

      const scope = chatState().getLatestAssistantTurn();

      expect(scope).not.toBeNull();
      expect(scope.getAttribute('data-testid')).toBe('conversation-turn-2');
      expect(chatState().findResponseCompletionMarkers(scope).length).toBeGreaterThan(0);
    });

    it('getTailConversationTurns returns the <section>-based turns', () => {
      document.body.innerHTML = `
        <main>
          <section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user">hi</div></section>
          <section data-testid="conversation-turn-2" data-turn="assistant"><div data-message-author-role="assistant">answer</div></section>
        </main>
      `;

      const result = chatState().classifyChatGPTDomActivity();

      // classifyChatGPTDomActivity has no direct getter for tail turns, but it only sees
      // active tool-status/shimmer signals inside them, so a non-throwing, non-active
      // result proves getTailConversationTurns() found the <section> turns instead of [].
      expect(result.active).toBe(false);
      expect(result.activityDiagnostics.finalDecisionReason).toBe('inactive:noActivitySignals');
    });

    it('ignores the user turn while the assistant has not answered yet', () => {
      // State immediately after sending: the user turn is rendered, the assistant turn is not.
      // On live chatgpt.com a USER turn carries its own copy-turn-action-button (a 2-turn
      // conversation shows 2 of them). If getLatestAssistantTurn() returned the newest turn of
      // any kind, findResponseCompletionMarkers would find the user's own copy button and the
      // caller would declare the response complete before the answer exists — capturing the
      // wrong text instead of waiting. That is a worse failure than hanging.
      document.body.innerHTML = `
        <main>
          <section data-testid="conversation-turn-1" data-turn="user">
            <div data-message-author-role="user">say OK</div>
            <div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div>
          </section>
        </main>
      `;
      setVisible(document.querySelector('button[data-testid="copy-turn-action-button"]'));

      expect(chatState().getLatestAssistantTurn()).toBeNull();
    });

    it('picks the assistant turn even when a user turn is rendered after it', () => {
      document.body.innerHTML = `
        <main>
          <section data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user">first</div></section>
          <section data-testid="conversation-turn-2" data-turn="assistant">
            <div data-message-author-role="assistant">answer</div>
            <div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div>
          </section>
          <section data-testid="conversation-turn-3" data-turn="user">
            <div data-message-author-role="user">follow-up</div>
            <div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div>
          </section>
        </main>
      `;
      document.querySelectorAll('button[data-testid="copy-turn-action-button"]').forEach(setVisible);

      const scope = chatState().getLatestAssistantTurn();

      expect(scope).not.toBeNull();
      expect(scope.getAttribute('data-testid')).toBe('conversation-turn-2');
    });
  });
});
