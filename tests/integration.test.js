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
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    it('should resolve when stop button is not present', async () => {
      const promise = waitForStreamsToStop({ 
        stopButtonSelector: '.stop-btn',
        maxWaitMs: 10000,
        enableTimeout: true
      });

      jest.advanceTimersByTime(1000);
      
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
      
      jest.advanceTimersByTime(1000);
      
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
      
      jest.advanceTimersByTime(1000);
      
      const result = await promise;
      expect(result).toBeUndefined();
    });
  });

  describe('waitForCompletion', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      document.body.innerHTML = `
        <button class="send-btn">Send</button>
        <button class="stop-btn">Stop</button>
        <div class="messages"></div>
      `;
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
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
        enableMaxWaitTimeout: true
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
        enableMaxWaitTimeout: true
      });

      jest.advanceTimersByTime(2000);
      
      const result = await promise;
      expect(result).toBeUndefined();
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

    it('should handle SEND_PROMPT message', (done) => {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'SEND_PROMPT') {
          expect(message.text).toBe('Test prompt');
          expect(message.promptId).toBeDefined();
          sendResponse({ ok: true });
          done();
        }
      });

      chrome.runtime.sendMessage({
        type: 'SEND_PROMPT',
        text: 'Test prompt',
        promptId: '123'
      });
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
});
