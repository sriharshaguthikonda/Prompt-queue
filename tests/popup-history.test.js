describe('popup history UI', () => {
  let mod;

  beforeAll(async () => {
    const path = require('path');
    mod = await global.loadEsmModule(path.join(__dirname, '..', 'popup-history.js'));
  });

  function renderHistoryDom() {
    document.body.innerHTML = `
      <textarea id="prompts"></textarea>
      <div id="history"></div>
      <span id="historyCount"></span>
      <button id="clearHistoryBtn"></button>
      <div id="historyLoading" class="hidden"></div>
      <div id="toast"></div>
    `;
  }

  it('loads saved prompts without restoring saved theme', async () => {
    renderHistoryDom();
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'SAVE_SETTINGS') return { ok: true, settings: message.settings };
      return { ok: true };
    });

    const row = mod.createHistoryRow({
      prompts: ['Prompt A', 'Prompt B'],
      settings: {
        theme: 'light',
        maxWaitMs: 300000,
        enableMaxWaitTimeout: true,
        systemPrompt: 'system',
      },
      savedAt: Date.now(),
    }, 0);
    document.getElementById('history').appendChild(row);

    row.querySelector('button').click();
    await Promise.resolve();

    expect(document.getElementById('prompts').value).toBe('Prompt A\nPrompt B');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SAVE_SETTINGS',
      settings: expect.objectContaining({
        maxWaitMs: 300000,
        enableMaxWaitTimeout: true,
        systemPrompt: 'system',
      }),
    });
    const saveCall = chrome.runtime.sendMessage.mock.calls.find(([message]) => message?.type === 'SAVE_SETTINGS');
    expect(saveCall[0].settings).not.toHaveProperty('theme');
  });
});
