/**
 * Integration Tests for Content Script
 * Tests for content.js functions and message handling
 */

describe('Content Script Integration', () => {

  describe('detectSite', () => {
    it('should detect ChatGPT', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chat.openai.com/c/abc123' },
        writable: true
      });

      const site = detectSite();
      expect(site).toBe('chatgpt');
    });

    it('should detect Gemini', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://gemini.google.com/app/abc123' },
        writable: true
      });

      const site = detectSite();
      expect(site).toBe('gemini');
    });

    it('should detect Grok', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://grok.x.ai/chat/abc123' },
        writable: true
      });

      const site = detectSite();
      expect(site).toBe('grok');
    });

    it('should detect Claude', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://claude.ai/chat/abc123' },
        writable: true
      });

      const site = detectSite();
      expect(site).toBe('claude');
    });

    it('should return unknown for unsupported sites', () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://example.com' },
        writable: true
      });

      const site = detectSite();
      expect(site).toBe('unknown');
    });
  });

  describe('isButtonEnabled', () => {
    it('should return true for enabled button', () => {
      const button = document.createElement('button');
      button.textContent = 'Send';

      const result = isButtonEnabled(button);
      expect(result).toBe(true);
    });

    it('should return false for disabled button', () => {
      const button = document.createElement('button');
      button.disabled = true;

      const result = isButtonEnabled(button);
      expect(result).toBe(false);
    });

    it('should return false for button with aria-disabled', () => {
      const button = document.createElement('button');
      button.setAttribute('aria-disabled', 'true');

      const result = isButtonEnabled(button);
      expect(result).toBe(false);
    });

    it('should return false for button with low opacity', () => {
      const button = document.createElement('button');
      button.style.opacity = '0.3';

      const result = isButtonEnabled(button);
      expect(result).toBe(false);
    });

    it('should return true for button with normal opacity', () => {
      const button = document.createElement('button');
      button.style.opacity = '1';

      const result = isButtonEnabled(button);
      expect(result).toBe(true);
    });
  });

  describe('waitForStreamsToStop', () => {
    let logSpy;

    beforeEach(() => {
      jest.useFakeTimers();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      logSpy.mockRestore();
      document.body.innerHTML = '';
    });

    it('should resolve when stop button is not present', async () => {
      const promise = waitForStreamsToStop({
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 10000,
        enableTimeout: true
      });

      jest.advanceTimersByTime(3000);

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should wait for stop button to disappear', async () => {
      document.body.innerHTML = '<button class="stop-btn">Stop</button>';

      const promise = waitForStreamsToStop({
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 10000,
        enableTimeout: true
      });

      // Button is present, should not resolve yet
      jest.advanceTimersByTime(500);

      // Remove button
      document.querySelector('.stop-btn').remove();

      jest.advanceTimersByTime(3000);

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should timeout when stop button persists', async () => {
      document.body.innerHTML = '<button class="stop-btn">Stop</button>';

      const promise = waitForStreamsToStop({
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 1000,
        enableTimeout: true
      });

      jest.advanceTimersByTime(2000);

      await expect(promise).rejects.toThrow();
    });

    it('should wait indefinitely when timeout disabled', async () => {
      document.body.innerHTML = '<button class="stop-btn">Stop</button>';

      const promise = waitForStreamsToStop({
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 1000,
        enableTimeout: false
      });

      jest.advanceTimersByTime(10000);

      // Should still be pending
      expect(promise).toBePending();

      // Remove button
      document.querySelector('.stop-btn').remove();

      jest.advanceTimersByTime(3000);

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('logs sanitized ChatGPT stop-detected diagnostics while waiting for streams to stop', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <button class="stop-btn btn-primary" data-testid="stop-button" aria-label="Stop generating">Stop</button>
        <button id="composer-submit-button" data-testid="stop-button" aria-label="Stop answering" class="composer-stop">Stop</button>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="assistant">
            <div class="loading-shimmer shimmer-live">Loading</div>
          </article>
        </main>
      `;

      const stopBtn = document.querySelector('.stop-btn');
      const composerBtn = document.getElementById('composer-submit-button');
      const shimmer = document.querySelector('.loading-shimmer');
      stopBtn.getBoundingClientRect = jest.fn(() => ({ x: 5, y: 10, width: 90, height: 32 }));
      composerBtn.getBoundingClientRect = jest.fn(() => ({ x: 10, y: 20, width: 88, height: 32 }));
      shimmer.getBoundingClientRect = jest.fn(() => ({ x: 12, y: 40, width: 120, height: 20 }));

      const promise = waitForStreamsToStop({
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 5000,
        enableTimeout: false,
      });

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      const stopDetectedLog = logSpy.mock.calls.find(([message]) =>
        message === '[WaitForStreamsToStop] Stop button detected, resetting counter'
      );
      expect(stopDetectedLog).toBeTruthy();
      expect(stopDetectedLog[1]).toMatchObject({
        site: 'chatgpt',
        stopButtonSelector: '.stop-btn',
        elapsed: expect.any(Number),
        enableTimeout: false,
        noStopButtonCount: 0,
        requiredNoStopChecks: 3,
        stopPresent: true,
        stillStreaming: true,
        hardBlockingReasons: expect.arrayContaining(['stopButton', 'loadingShimmer']),
        staleActivityReasons: [],
        finalDecisionReason: 'blocked:active:stopButton,loadingShimmer',
        candidateCounts: expect.objectContaining({
          stopButtonCandidates: 1,
          fallbackStopCandidates: expect.any(Number),
        }),
        explicitStop: expect.objectContaining({
          ariaLabel: 'Stop generating',
          dataTestId: 'stop-button',
          textLength: 4,
          visible: true,
        }),
        fallbackStop: expect.any(Object),
        composerAction: expect.objectContaining({
          ariaLabel: 'Stop answering',
          roleDecision: 'stop-active',
          roleReason: 'stop-label',
          visible: true,
        }),
        activityDiagnostics: expect.objectContaining({
          selectorUsed: '.stop-btn',
          hardBlockingReasons: expect.arrayContaining(['stopButton', 'loadingShimmer']),
          counts: expect.objectContaining({
            stopButtonCandidates: 1,
            responseCompletionMarkers: expect.any(Number),
          }),
          stopButtonCandidates: expect.objectContaining({
            count: 1,
            candidates: expect.arrayContaining([
              expect.objectContaining({
                ariaLabel: 'Stop generating',
                dataTestId: 'stop-button',
                textLength: 4,
                visible: true,
              }),
            ]),
          }),
          loadingShimmer: expect.objectContaining({
            textLength: 7,
            visible: true,
          }),
        }),
      });

      document.querySelector('.stop-btn').remove();
      document.getElementById('composer-submit-button').remove();
      document.querySelector('.loading-shimmer').remove();
      jest.advanceTimersByTime(3000);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('waitForChatGPTSendWindow', () => {
    let logSpy;

    beforeEach(() => {
      jest.useFakeTimers();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      document.body.innerHTML = `
        <textarea id="prompt-textarea">Queued prompt</textarea>
        <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt">Send</button>
      `;
      document.getElementById('prompt-textarea').getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));
      document.getElementById('composer-submit-button').getBoundingClientRect = jest.fn(() => ({ width: 96, height: 32 }));
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      logSpy.mockRestore();
      document.body.innerHTML = '';
    });

    it('resolves immediately when the configured quiet window is zero', async () => {
      const promise = waitForChatGPTSendWindow({
        sendButton: document.getElementById('composer-submit-button'),
        inputEl: document.getElementById('prompt-textarea'),
        maxWaitMs: 10000,
        quietWindowMs: 0,
        pollMs: 250,
      });

      await expect(promise).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith('[PreSendGuard] Quiet send window reached', expect.objectContaining({
        preSendQuietWindowMs: 0,
        quietWindowMs: 0,
        reason: 'disabledQuietWindow',
      }));
    });
  });

  describe('waitForCompletion', () => {
    let logSpy;

    beforeEach(() => {
      jest.useFakeTimers();
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      document.body.innerHTML = `
        <button class="send-btn">Send</button>
        <button class="stop-btn">Stop</button>
        <div class="messages"></div>
      `;
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      logSpy.mockRestore();
      document.body.innerHTML = '';
    });

    it('should resolve when conditions are met', async () => {
      const sendBtn = document.querySelector('.send-btn');
      const messagesContainer = document.querySelector('.messages');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: '.stop-btn',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 10000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false
      });

      // Remove stop button
      document.querySelector('.stop-btn').remove();

      // Wait for stability
      jest.advanceTimersByTime(1000);

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should timeout after max wait', async () => {
      const sendBtn = document.querySelector('.send-btn');
      const messagesContainer = document.querySelector('.messages');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: '.stop-btn',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 1000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false
      });

      jest.advanceTimersByTime(2000);

      const result = await promise;
      expect(result).toMatchObject({ timedOut: true, error: 'waitForCompletion timeout' });
    });

    it('should keep waiting past max wait when infinite response wait is enabled', async () => {
      const sendBtn = document.querySelector('.send-btn');
      const messagesContainer = document.querySelector('.messages');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: '.stop-btn',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 1000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: true
      });

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      let resolved = false;
      promise.then(() => {
        resolved = true;
      });
      await Promise.resolve();

      expect(resolved).toBe(false);
      document.querySelector('.stop-btn').remove();
      jest.advanceTimersByTime(1000);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should detect DOM changes', async () => {
      const sendBtn = document.querySelector('.send-btn');
      const messagesContainer = document.querySelector('.messages');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: '.stop-btn',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 10000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: true
      });

      // Simulate DOM changes
      jest.advanceTimersByTime(200);
      messagesContainer.innerHTML = '<div>New message</div>';

      jest.advanceTimersByTime(200);
      messagesContainer.innerHTML += '<div>Another message</div>';

      // Remove stop button
      document.querySelector('.stop-btn').remove();

      // Wait for stability after last change
      jest.advanceTimersByTime(1000);

      const result = await promise;
      expect(result).toBeUndefined();
    });

    it('should complete from a stable captured ChatGPT response despite unrelated DOM churn', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <button class="send-btn" data-testid="send-button">Send</button>
        <main>
          <div class="messages">
            <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
            <article data-testid="conversation-turn-2" data-message-author-role="assistant">Assistant answer</article>
          </div>
          <div class="churn"></div>
        </main>
      `;
      const sendBtn = document.querySelector('.send-btn');
      const messagesContainer = document.querySelector('main');
      const churn = document.querySelector('.churn');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
      });

      for (let i = 0; i < 8; i += 1) {
        churn.textContent = `noise ${i}`;
        jest.advanceTimersByTime(100);
        await Promise.resolve();
      }

      await expect(promise).resolves.toBeUndefined();
    });

    it('should complete from a stable ChatGPT response when the empty composer keeps send disabled', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
        <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
          <article data-testid="conversation-turn-2" data-message-author-role="assistant">
            Assistant answer
            <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
          </article>
        </main>
      `;
      const sendBtn = document.querySelector('#composer-submit-button');
      const messagesContainer = document.querySelector('main');

      const promise = waitForCompletion({
        sendButton: sendBtn,
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
        inputEl: document.getElementById('prompt-textarea'),
      });

      jest.advanceTimersByTime(700);
      await expect(promise).resolves.toBeUndefined();
    });

    it('should wait while the composer action is stop-active, then complete after it leaves that role', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
        <button id="composer-submit-button" data-testid="stop-button" aria-label="Stop answering">Stop</button>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
          <article data-testid="conversation-turn-2" data-message-author-role="assistant">
            Assistant answer
            <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
          </article>
        </main>
      `;
      const composerButton = document.querySelector('#composer-submit-button');
      const messagesContainer = document.querySelector('main');

      const promise = waitForCompletion({
        sendButton: composerButton,
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer,
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
        inputEl: document.getElementById('prompt-textarea'),
      });

      let resolved = false;
      promise.then(() => {
        resolved = true;
      });

      jest.advanceTimersByTime(700);
      await Promise.resolve();
      expect(resolved).toBe(false);

      composerButton.setAttribute('disabled', '');
      composerButton.setAttribute('aria-disabled', 'true');
      jest.advanceTimersByTime(700);
      await expect(promise).resolves.toBeUndefined();
    });

    it('should complete from Good response or Bad response action markers', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });

      for (const label of ['Good response', 'Bad response']) {
        document.body.innerHTML = `
          <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
          <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
          <main>
            <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
            <article data-testid="conversation-turn-2" data-message-author-role="assistant">
              Assistant answer
              <button aria-label="${label}">${label}</button>
            </article>
          </main>
        `;

        const promise = waitForCompletion({
          sendButton: document.querySelector('#composer-submit-button'),
          stopButtonSelector: 'button[data-testid="stop-button"]',
          messagesContainer: document.querySelector('main'),
          stableMs: 500,
          maxWaitMs: 5000,
          pollIntervalMs: 100,
          enableMaxWaitTimeout: false,
          promptText: 'Queued prompt',
          inputEl: document.getElementById('prompt-textarea'),
        });

        jest.advanceTimersByTime(700);
        await expect(promise).resolves.toBeUndefined();
      }
    });

    it('should complete when stale hard activity remains but response actions prove completion', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
        <button id="composer-submit-button" data-testid="send-button" aria-label="Send prompt">Send</button>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
          <article data-testid="conversation-turn-2" data-message-author-role="assistant">
            <span data-testid="thinking-indicator">Thinking</span>
            Assistant answer
            <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
          </article>
        </main>
      `;

      const promise = waitForCompletion({
        sendButton: document.querySelector('#composer-submit-button'),
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer: document.querySelector('main'),
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
        inputEl: document.getElementById('prompt-textarea'),
      });

      jest.advanceTimersByTime(700);
      await expect(promise).resolves.toBeUndefined();
    });

    it('should not treat a send-labeled composer with stale stop test id as active generation', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
        <button id="composer-submit-button" data-testid="stop-button" aria-label="Send prompt">Send</button>
        <main>
          <article data-testid="conversation-turn-1" data-message-author-role="user">Queued prompt</article>
          <article data-testid="conversation-turn-2" data-message-author-role="assistant">
            Assistant answer
            <button data-testid="copy-turn-action-button" aria-label="Copy response">Copy response</button>
          </article>
        </main>
      `;

      const promise = waitForCompletion({
        sendButton: document.querySelector('#composer-submit-button'),
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer: document.querySelector('main'),
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
        inputEl: document.getElementById('prompt-textarea'),
      });

      jest.advanceTimersByTime(700);
      await expect(promise).resolves.toBeUndefined();
    });

    it('logs sanitized completion decision diagnostics for stale shimmer resolution', async () => {
      Object.defineProperty(window, 'location', {
        value: { href: 'https://chatgpt.com/c/test' },
        writable: true,
      });
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
      document.getElementById('composer-submit-button').getBoundingClientRect = jest.fn(() => ({ x: 10, y: 20, width: 88, height: 32 }));
      document.querySelector('.loading-shimmer').getBoundingClientRect = jest.fn(() => ({ x: 12, y: 40, width: 120, height: 20 }));
      document.querySelector('button[data-testid="copy-turn-action-button"]').getBoundingClientRect = jest.fn(() => ({ x: 30, y: 45, width: 100, height: 24 }));

      const promise = waitForCompletion({
        sendButton: document.querySelector('#composer-submit-button'),
        stopButtonSelector: 'button[data-testid="stop-button"]',
        messagesContainer: document.querySelector('main'),
        stableMs: 500,
        maxWaitMs: 5000,
        pollIntervalMs: 100,
        enableMaxWaitTimeout: false,
        promptText: 'Queued prompt',
        inputEl: document.getElementById('prompt-textarea'),
      });

      jest.advanceTimersByTime(700);
      await expect(promise).resolves.toBeUndefined();

      const completionLog = logSpy.mock.calls.find(([message]) =>
        message === '[WaitForCompletion] Completion condition met'
      );
      expect(completionLog).toBeTruthy();
      expect(completionLog[1]).toMatchObject({
        staleActivityReasons: ['staleLoadingShimmer'],
        finalDecisionReason: 'chatgptResponseComplete',
      });
      expect(completionLog[1].responseCompletionMarkers).toEqual(expect.arrayContaining(['Copy response']));
      expect(completionLog[1].activityDiagnostics).toMatchObject({
        selectorUsed: 'button[data-testid="stop-button"]',
        staleActivityReasons: ['staleLoadingShimmer'],
        finalDecisionReason: 'inactive:stableResponseMarkers',
        counts: expect.objectContaining({
          responseCompletionMarkers: expect.any(Number),
        }),
        composerAction: expect.objectContaining({
          ariaLabel: 'Send prompt',
          roleDecision: 'send-disabled',
          roleReason: 'send-disabled-label',
        }),
        loadingShimmer: expect.objectContaining({
          textLength: 7,
          stale: true,
          visible: true,
        }),
      });
      expect(completionLog[1].activityDiagnostics.responseCompletionMarkers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          selector: 'button[data-testid="copy-turn-action-button"]',
          label: 'Copy response',
          node: expect.objectContaining({
            ariaLabel: 'Copy response',
            textLength: 13,
            visible: true,
          }),
        }),
      ]));
    });
  });

  describe('Message Listener', () => {
    it('should handle PING message', (done) => {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'PING') {
          sendResponse({ ok: true, timestamp: expect.any(Number) });
          done();
        }
      });

      chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
        expect(response.ok).toBe(true);
      });
    });

    it('should handle SEND_PROMPT message', async () => {
      jest.useFakeTimers();
      try {
        document.body.innerHTML = `
          <textarea id="prompt-textarea" style="display:block"></textarea>
          <button data-testid="send-button" type="button">Send</button>
          <main></main>
        `;

        const input = document.getElementById('prompt-textarea');
        const sendButton = document.querySelector('button[data-testid="send-button"]');

        input.getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));
        sendButton.getBoundingClientRect = jest.fn(() => ({ width: 96, height: 32 }));

        sendButton.addEventListener('click', () => {
          const stopButton = document.createElement('button');
          stopButton.setAttribute('data-testid', 'stop-button');
          stopButton.textContent = 'Stop';
          document.body.appendChild(stopButton);

          setTimeout(() => {
            document.querySelector('button[data-testid="stop-button"]')?.remove();
          }, 1000);
        });

        await expect(
          chrome.runtime.sendMessage({
            type: 'SEND_PROMPT',
            text: 'Test prompt',
            promptId: '123',
            options: {
              stableMs: 50,
              maxWaitMs: 5000,
              pollIntervalMs: 50,
              enableMaxWaitTimeout: true,
              postPopulateDelayMinMs: 0,
              postPopulateDelayMaxMs: 0,
            },
          }),
        ).resolves.toMatchObject({ ok: true, accepted: true, promptId: '123' });

        await jest.advanceTimersByTimeAsync(7000);

        expect(input.value).toBe('Test prompt');
        const runtimeMessages = chrome.runtime.sendMessage.mock.calls.map(([message]) => message);
        const submittedIndex = runtimeMessages.findIndex((message) =>
          message?.type === 'PROMPT_SUBMITTED'
          && message?.promptId === '123'
          && message?.reason === 'send-click-dispatched'
        );
        const completeIndex = runtimeMessages.findIndex((message) =>
          message?.type === 'RESPONSE_COMPLETE'
          && message?.promptId === '123'
        );
        expect(submittedIndex).toBeGreaterThan(-1);
        expect(completeIndex === -1 || submittedIndex < completeIndex).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should not leave completion polling active after finite PromptQueue timeout', async () => {
      jest.useFakeTimers();
      const logSpy = jest.spyOn(console, 'log');
      try {
        Object.defineProperty(window, 'location', {
          value: { href: 'https://chatgpt.com/c/finite-timeout-test' },
          writable: true,
        });
        document.body.innerHTML = `
          <textarea id="prompt-textarea" style="display:block"></textarea>
          <button data-testid="send-button" type="button">Send</button>
          <main></main>
        `;

        const input = document.getElementById('prompt-textarea');
        const sendButton = document.querySelector('button[data-testid="send-button"]');

        input.getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));
        sendButton.getBoundingClientRect = jest.fn(() => ({ width: 96, height: 32 }));

        sendButton.addEventListener('click', () => {
          const main = document.querySelector('main');
          main.insertAdjacentHTML('beforeend', `
            <article data-testid="conversation-turn-1" data-message-author-role="user">Finite timeout prompt</article>
            <article data-testid="conversation-turn-2" data-message-author-role="assistant">Still working</article>
          `);
          const stopButton = document.createElement('button');
          stopButton.setAttribute('data-testid', 'stop-button');
          stopButton.setAttribute('aria-label', 'Stop answering');
          stopButton.textContent = 'Stop';
          document.body.appendChild(stopButton);
        });

        await expect(
          chrome.runtime.sendMessage({
            type: 'SEND_PROMPT',
            text: 'Finite timeout prompt',
            promptId: 'finite-timeout',
            options: {
              stableMs: 50,
              maxWaitMs: 500,
              pollIntervalMs: 50,
              enableMaxWaitTimeout: false,
              postPopulateDelayMinMs: 0,
              postPopulateDelayMaxMs: 0,
              preSendQuietWindowMs: 0,
            },
          }),
        ).resolves.toMatchObject({ ok: true, accepted: true, promptId: 'finite-timeout' });

        await jest.advanceTimersByTimeAsync(8000);

        const runtimeMessages = chrome.runtime.sendMessage.mock.calls.map(([message]) => message);
        const finiteErrors = runtimeMessages.filter((message) =>
          message?.type === 'RESPONSE_COMPLETE'
          && message?.promptId === 'finite-timeout'
          && String(message?.error || '').includes('waitForCompletion timeout')
        );
        expect(finiteErrors).toHaveLength(1);
        expect(runtimeMessages).not.toContainEqual(expect.objectContaining({
          type: 'RESPONSE_COMPLETE',
          promptId: 'finite-timeout',
          error: 'Prompt processing timeout',
        }));

        const statusLogsAtTimeout = logSpy.mock.calls.filter(([message]) => message === '[WaitForCompletion] Waiting status').length;
        await jest.advanceTimersByTimeAsync(12000);
        const statusLogsAfterMoreTime = logSpy.mock.calls.filter(([message]) => message === '[WaitForCompletion] Waiting status').length;

        expect(statusLogsAfterMoreTime).toBe(statusLogsAtTimeout);
      } finally {
        logSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('should reject unknown message types', (done) => {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'UNKNOWN') {
          // Should log unknown message type
          sendResponse({ ok: false });
          done();
        }
      });

      chrome.runtime.sendMessage({ type: 'UNKNOWN' });
    });
  });

  describe('setTextInInput', () => {
    it('should set text in textarea', () => {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      setTextInInput(textarea, 'Test text');

      expect(textarea.value).toBe('Test text');
      expect(textarea.selectionStart).toBe('Test text'.length);
      expect(textarea.selectionEnd).toBe('Test text'.length);
      document.body.removeChild(textarea);
    });

    it('should set text in contenteditable', () => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      document.body.appendChild(div);

      setTextInInput(div, 'Test text');

      expect(div.textContent).toBe('Test text');
      document.body.removeChild(div);
    });

    it('should replace selected text in plain contenteditable using editor input semantics', () => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.textContent = 'old text';
      document.body.appendChild(div);
      const originalExecCommand = document.execCommand;
      document.execCommand = jest.fn(() => false);
      let inputEventFired = false;
      div.addEventListener('input', () => {
        inputEventFired = true;
      });

      try {
        setTextInInput(div, 'new text');
      } finally {
        document.execCommand = originalExecCommand;
      }

      expect(div.textContent).toBe('new text');
      expect(inputEventFired).toBe(true);
      document.body.removeChild(div);
    });

    it('should set text in plaintext-only contenteditable', () => {
      const div = document.createElement('div');
      div.id = 'prompt-textarea';
      div.setAttribute('contenteditable', 'plaintext-only');
      document.body.appendChild(div);

      setTextInInput(div, 'Test text');

      expect(div.textContent).toBe('Test text');
      document.body.removeChild(div);
    });

    it('should wait for a stable visible composer before resolving readiness', async () => {
      document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox" style="display:none"></div>';
      const hiddenComposer = document.getElementById('prompt-textarea');
      hiddenComposer.getBoundingClientRect = jest.fn(() => ({ width: 0, height: 0 }));

      const readinessPromise = waitForComposerReady({
        site: 'chatgpt',
        maxWaitMs: 1000,
        stableWindowMs: 50,
        pollMs: 10,
      });

      const visibleComposer = document.createElement('div');
      visibleComposer.id = 'prompt-textarea';
      visibleComposer.setAttribute('contenteditable', 'plaintext-only');
      visibleComposer.setAttribute('role', 'textbox');
      visibleComposer.style.display = 'block';
      visibleComposer.getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));

      setTimeout(() => {
        hiddenComposer.remove();
        document.body.appendChild(visibleComposer);
      }, 10);

      await expect(readinessPromise).resolves.toBe(visibleComposer);
    });

    it('should ignore a connected hidden fallback textarea while waiting for visible composer', async () => {
      document.body.innerHTML = '<textarea id="prompt-textarea" style="display:none"></textarea>';
      const hiddenFallback = document.getElementById('prompt-textarea');
      hiddenFallback.getBoundingClientRect = jest.fn(() => ({ width: 0, height: 0 }));

      const readinessPromise = waitForComposerReady({
        site: 'chatgpt',
        inputEl: hiddenFallback,
        maxWaitMs: 1000,
        stableWindowMs: 50,
        pollMs: 10,
      });

      const visibleComposer = document.createElement('div');
      visibleComposer.id = 'prompt-textarea';
      visibleComposer.className = 'ProseMirror';
      visibleComposer.setAttribute('contenteditable', 'true');
      visibleComposer.setAttribute('role', 'textbox');
      visibleComposer.getBoundingClientRect = jest.fn(() => ({ width: 320, height: 48 }));

      setTimeout(() => {
        document.body.appendChild(visibleComposer);
      }, 10);

      await expect(readinessPromise).resolves.toBe(visibleComposer);
    });

    it('should trigger input event', () => {
      const textarea = document.createElement('textarea');
      let eventFired = false;

      textarea.addEventListener('input', () => {
        eventFired = true;
      });

      document.body.appendChild(textarea);
      setTextInInput(textarea, 'Test');

      expect(eventFired).toBe(true);
      document.body.removeChild(textarea);
    });
  });

  describe('clickSend', () => {
    it('should click button', () => {
      const button = document.createElement('button');
      let clicked = false;

      button.addEventListener('click', () => {
        clicked = true;
      });

      document.body.appendChild(button);
      clickSend(button, null);

      expect(clicked).toBe(true);
      document.body.removeChild(button);
    });

    it('should dispatch Enter key for contenteditable', () => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      let keyEventFired = false;

      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          keyEventFired = true;
        }
      });

      document.body.appendChild(div);
      clickSend(null, div);

      expect(keyEventFired).toBe(true);
      document.body.removeChild(div);
    });
  });

describe('ChatGPT selectors', () => {
    it('should find the current ChatGPT plaintext composer', () => {
      document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>';

      const selector = selectorsForSite('chatgpt').inputCandidates.find((candidate) => document.querySelector(candidate));

      expect(selector).toBeDefined();
      expect(document.querySelector(selector).id).toBe('prompt-textarea');
    });

    it('should find ChatGPT CodeMirror fallback textarea', () => {
      document.body.innerHTML = '<textarea class="wcDTda_fallbackTextarea" name="prompt-textarea"></textarea>';

      const selector = selectorsForSite('chatgpt').inputCandidates.find((candidate) => document.querySelector(candidate));

      expect(selector).toBeDefined();
      expect(document.querySelector(selector).classList.contains('wcDTda_fallbackTextarea')).toBe(true);
    });

    it('should find unscoped ChatGPT send buttons', () => {
      document.body.innerHTML = '<button aria-label="Send prompt"></button>';

      const button = findSendButtonForSite('chatgpt', null);

      expect(button).toBe(document.querySelector('button'));
    });

    it('should treat a typed draft as send-ready even when the button is recreated late', () => {
      document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only">hello</div>';

      expect(isChatGPTReadyToSend(document.getElementById('prompt-textarea'))).toBe(true);
    });

    it('should verify rendered user messages without whitespace-pre-wrap', () => {
      document.body.innerHTML = '<article data-testid="conversation-turn-1"><div data-message-author-role="user">Hello from queued prompt</div></article>';

      const match = findRenderedMessageMatch('Hello from queued prompt');

      expect(match).not.toBeNull();
    });

    it('should prefer a custom prompt selector when it matches a visible element', () => {
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>
        <textarea class="custom-prompt-target"></textarea>
      `;
      document.querySelector('textarea.custom-prompt-target').getBoundingClientRect = () => ({ width: 120, height: 24 });

      const input = findPromptInputForSite('chatgpt', {
        targetSelectors: {
          promptInput: 'textarea.custom-prompt-target',
        },
      });

      expect(input).toBe(document.querySelector('textarea.custom-prompt-target'));
    });

    it('should fall back when a custom prompt selector is invalid', () => {
      document.body.innerHTML = '<div id="prompt-textarea" contenteditable="plaintext-only" role="textbox"></div>';

      const input = findPromptInputForSite('chatgpt', {
        targetSelectors: {
          promptInput: 'div[',
        },
      });

      expect(input).toBe(document.getElementById('prompt-textarea'));
    });

    it('should prefer a custom send button selector when it matches', () => {
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox">hello</div>
        <button aria-label="Send prompt"></button>
        <button class="custom-send-target" aria-label="Queue send"></button>
      `;
      document.querySelector('button.custom-send-target').getBoundingClientRect = () => ({ width: 48, height: 24 });

      const button = findSendButtonForSite('chatgpt', document.getElementById('prompt-textarea'), {
        targetSelectors: {
          sendButton: 'button.custom-send-target',
        },
      });

      expect(button).toBe(document.querySelector('button.custom-send-target'));
    });

    it('should normalize common data-testid mistakes for button selectors', () => {
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox">hello</div>
        <button data-testid="send-button" aria-label="Send prompt"></button>
      `;
      const input = document.getElementById('prompt-textarea');
      const button = findSendButtonForSite('chatgpt', input, {
        targetSelectors: {
          sendButton: 'data-testid#send-button',
        },
      });

      expect(button).toBe(document.querySelector('button[data-testid="send-button"]'));
    });

    it('should accept valid attribute selectors for prompt input', () => {
      document.body.innerHTML = '<textarea data-testid="prompt-textarea"></textarea>';

      const input = findPromptInputForSite('chatgpt', {
        targetSelectors: {
          promptInput: '[data-testid="prompt-textarea"]',
        },
      });

      expect(input).toBe(document.querySelector('textarea[data-testid="prompt-textarea"]'));
    });

    it('should canonicalize picked prompt children to the editable composer', () => {
      document.body.innerHTML = `
        <div id="prompt-textarea" contenteditable="plaintext-only" role="textbox">
          <p>picked child text</p>
        </div>
      `;
      document.querySelector('p').getBoundingClientRect = () => ({ width: 160, height: 24 });

      const input = findPromptInputForSite('chatgpt', {
        targetSelectors: {
          promptInput: 'p:nth-of-type(1)',
        },
      });

      expect(input).toBe(document.getElementById('prompt-textarea'));
    });
  });

describe('Background settings sanitization', () => {
  beforeAll(() => {
    require('../background.js');
    global.__setRuntimeListenerBaseline?.();
  });

  it('should keep the targetSelectors shape while normalizing watched element legacy state', () => {
    const settings = global.PromptQueueBackgroundTest.validateSettings({
      watchedElementSelector: ' button[data-testid="copy-turn-action-button"] ',
      targetSelectors: {
        promptInput: '  textarea.custom-prompt-target  ',
        sendButton: 7,
        stopButton: ' button.custom-stop-target ',
      },
    });

    expect(settings.targetSelectors).toEqual({
      promptInput: 'textarea.custom-prompt-target',
      sendButton: '',
      stopButton: 'button.custom-stop-target',
      watchedElement: 'button[data-testid="copy-turn-action-button"]',
    });
    expect(settings.watchedElementSelector).toBe('button[data-testid="copy-turn-action-button"]');
  });

  it('should reject invalid target selectors in strict mode', () => {
    expect(() => {
      global.PromptQueueBackgroundTest.validateSettings(
        {
          targetSelectors: {
            promptInput: 'div[',
            sendButton: 'button[data-testid="send-button"]',
            stopButton: '',
            watchedElement: 'button[data-testid="copy-turn-action-button"]',
          },
        },
        { strict: true },
      );
    }).toThrow('Invalid target selector');
  });

  it('should accept valid selectors when no selector engine exists', () => {
    const originalDocument = global.document;
    const originalCss = global.CSS;
    global.document = undefined;
    global.CSS = undefined;

    try {
      const settings = global.PromptQueueBackgroundTest.validateSettings(
        {
          targetSelectors: {
            promptInput: 'textarea.custom-prompt-target',
            sendButton: 'button.custom-send-target',
            stopButton: 'button[data-testid="stop-button"]',
            watchedElement: 'main [data-testid="copy-turn-action-button"]',
          },
        },
        { strict: true },
      );

      expect(settings.targetSelectors).toEqual({
        promptInput: 'textarea.custom-prompt-target',
        sendButton: 'button.custom-send-target',
        stopButton: 'button[data-testid="stop-button"]',
        watchedElement: 'main [data-testid="copy-turn-action-button"]',
      });
    } finally {
      global.document = originalDocument;
      global.CSS = originalCss;
    }
  });

  it('should reject malformed selectors without a selector engine', () => {
    const originalDocument = global.document;
    const originalCss = global.CSS;
    global.document = undefined;
    global.CSS = undefined;

    try {
      expect(() => {
        global.PromptQueueBackgroundTest.validateSettings(
          {
            targetSelectors: {
              promptInput: 'div[',
              sendButton: 'button[data-testid="send-button"]',
              stopButton: '',
              watchedElement: 'button[data-testid="copy-turn-action-button"]',
            },
          },
          { strict: true },
        );
      }).toThrow('Invalid target selector');
    } finally {
      global.document = originalDocument;
      global.CSS = originalCss;
    }
  });

  it('should normalize data-testid mistakes in strict mode', () => {
    const settings = global.PromptQueueBackgroundTest.validateSettings(
      {
        targetSelectors: {
          promptInput: 'data-testid="prompt-textarea"',
          sendButton: 'data-testid#send-button',
          stopButton: 'data-testid="stop-button"',
          watchedElement: 'data-testid#copy-turn-action-button',
        },
      },
      { strict: true },
    );

    expect(settings.targetSelectors).toEqual({
      promptInput: '[data-testid="prompt-textarea"]',
      sendButton: 'button[data-testid="send-button"]',
      stopButton: 'button[data-testid="stop-button"]',
      watchedElement: 'button[data-testid="copy-turn-action-button"]',
    });
  });

  it('should default duplicate typo variants off and normalize send delay windows', () => {
    const settings = global.PromptQueueBackgroundTest.validateSettings({
      theme: 'system',
      preSendQuietWindowMs: 100000,
      postPopulateDelayMinMs: 2000,
      postPopulateDelayMaxMs: 500,
      crossTabSendLockMinWaitMs: 12000,
      crossTabSendLockMaxWaitMs: 3000,
    });

    expect(settings.theme).toBe('system');
    expect(settings.preSendQuietWindowMs).toBe(60000);
    expect(settings.chatgptPreSendQuietWindowMs).toBe(60000);
    expect(settings.enableDuplicateTypoVariants).toBe(false);
    expect(settings.postPopulateDelayMinMs).toBe(500);
    expect(settings.postPopulateDelayMaxMs).toBe(2000);
    expect(settings.crossTabSendLockEnabled).toBe(true);
    expect(settings.crossTabSendLockMinWaitMs).toBe(3000);
    expect(settings.crossTabSendLockMaxWaitMs).toBe(12000);
  });

  it('should fall back to the default ChatGPT pre-send quiet window when invalid', () => {
    const settings = global.PromptQueueBackgroundTest.validateSettings({
      preSendQuietWindowMs: 'nope',
    });

    expect(settings.preSendQuietWindowMs).toBe(1200);
    expect(settings.chatgptPreSendQuietWindowMs).toBe(1200);
  });

  it('should sanitize invalid theme values to dark', () => {
    const settings = global.PromptQueueBackgroundTest.validateSettings({
      theme: 'sepia',
    });

    expect(settings.theme).toBe('dark');
  });

  it('should reinject when an already-open tab has a stale content script version', async () => {
    const sendResponses = [
      { ok: true, version: 'old-version' },
      { ok: true, version: '2026-06-04.completion-stop-role-v2' },
    ];
    chrome.tabs.sendMessage.mockImplementation((_tabId, _message, callback) => {
      callback(sendResponses.shift() || { ok: true, version: global.PromptQueueBackgroundTest.CONTENT_SCRIPT_VERSION });
      return Promise.resolve();
    });
    chrome.scripting.executeScript.mockResolvedValue([]);

    try {
      await expect(global.PromptQueueBackgroundTest.ensureContentScriptReady(7)).resolves.toBe(true);

      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 7, allFrames: false },
        files: ['background-prompt-jobs.js', 'content-targets.js', 'content-input.js', 'content-status.js', 'content-chat-state.js', 'content.js'],
      });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        7,
        { type: 'PING_CURRENT', expectedVersion: global.PromptQueueBackgroundTest.CONTENT_SCRIPT_VERSION },
        expect.any(Function),
      );
    } finally {
      chrome.tabs.sendMessage.mockReset();
      chrome.scripting.executeScript.mockReset();
    }
  });

  it('should wait for a fresh tab load cycle after a triggered reload', async () => {
    jest.useFakeTimers();

    const updateListeners = [];
    chrome.tabs.onUpdated.addListener.mockImplementation((listener) => {
      updateListeners.push(listener);
    });
    chrome.tabs.onUpdated.removeListener.mockImplementation((listener) => {
      const index = updateListeners.indexOf(listener);
      if (index >= 0) updateListeners.splice(index, 1);
    });
    chrome.tabs.reload.mockResolvedValue(undefined);

    try {
      const waitPromise = global.PromptQueueBackgroundTest.waitForTriggeredTabLoad(
        7,
        () => chrome.tabs.reload(7),
        { timeoutMs: 5000 },
      );

      await Promise.resolve();
      expect(chrome.tabs.reload).toHaveBeenCalledWith(7);
      expect(updateListeners).toHaveLength(1);

      let resolved = false;
      waitPromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      updateListeners[0](7, { status: 'complete' });
      await Promise.resolve();
      expect(resolved).toBe(false);

      updateListeners[0](7, { status: 'loading' });
      await Promise.resolve();
      expect(resolved).toBe(false);

      updateListeners[0](7, { status: 'complete' });
      await expect(waitPromise).resolves.toBe(true);
      expect(resolved).toBe(true);
      expect(updateListeners).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      chrome.tabs.onUpdated.addListener.mockReset();
      chrome.tabs.onUpdated.removeListener.mockReset();
      chrome.tabs.reload.mockReset();
    }
  });

  it('should release cross-tab send lease on prompt submission instead of response completion', async () => {
    const helpers = global.PromptQueueBackgroundTest;
    helpers.releaseSendLease(null, 'test-reset');

    await helpers.acquireSendLease({
      tabId: 101,
      promptId: 'prompt-a',
      options: {
        crossTabSendLockEnabled: true,
        crossTabSendLockMinWaitMs: 3000,
        crossTabSendLockMaxWaitMs: 12000,
      },
    });

    expect(helpers.getSendLeaseSnapshot()).toMatchObject({
      tabId: 101,
      promptId: 'prompt-a',
    });
    expect(helpers.releaseSendLease('wrong-prompt', 'prompt-submitted')).toBe(false);
    expect(helpers.getSendLeaseSnapshot()).toMatchObject({
      tabId: 101,
      promptId: 'prompt-a',
    });

    expect(helpers.releaseSendLease('prompt-a', 'prompt-submitted')).toBe(true);
    expect(helpers.getSendLeaseSnapshot()).toBeNull();
  });

  it('should not allow in-flight recovery only because max wait elapsed in infinite mode', () => {
    const helpers = global.PromptQueueBackgroundTest;
    expect(helpers.shouldAllowInFlightRecovery({
      options: { enableMaxWaitTimeout: true, maxWaitMs: 500 },
      processingElapsed: 5000,
    })).toBe(false);
    expect(helpers.shouldAllowInFlightRecovery({
      options: { enableMaxWaitTimeout: false, maxWaitMs: 500 },
      processingElapsed: 5000,
    })).toBe(true);
  });

  it('should use prompt-only history signatures', () => {
    const helpers = global.PromptQueueBackgroundTest;
    const first = helpers.makeHistorySignatureForTest({
      prompts: ['Prompt A'],
      settings: { enableMaxWaitTimeout: false, maxWaitMs: 180000, theme: 'light' },
    });
    const second = helpers.makeHistorySignatureForTest({
      prompts: ['Prompt A'],
      settings: { enableMaxWaitTimeout: true, maxWaitMs: 3600000, theme: 'system' },
    });

    expect(first).toBe(second);
  });

  it('should match legacy stored history duplicates by prompt text only', () => {
    const helpers = global.PromptQueueBackgroundTest;
    const promptOnlySignature = helpers.makeHistorySignatureForTest({
      prompts: ['Prompt A'],
      settings: { enableMaxWaitTimeout: true, maxWaitMs: 3600000, theme: 'system' },
    });
    const legacyStoredHistory = [{
      prompts: ['Prompt A'],
      settings: { enableMaxWaitTimeout: false, maxWaitMs: 180000, theme: 'light' },
      __sig: JSON.stringify({
        prompts: ['Prompt A'],
        settings: { enableMaxWaitTimeout: false, maxWaitMs: 180000, theme: 'light' },
      }),
    }];

    expect(helpers.hasHistorySignatureForTest(legacyStoredHistory, promptOnlySignature)).toBe(true);
  });
});
});
