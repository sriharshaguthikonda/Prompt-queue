describe('popup settings UI', () => {
  let mod;

  beforeAll(async () => {
    const path = require('path');
    mod = await global.loadEsmModule(path.join(__dirname, '..', 'popup-settings.js'));
  });

  function renderSettingsDom() {
    document.body.innerHTML = `
      <div id="toast"></div>
      <select id="themeSelect"><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select>
      <input id="maxWaitSec" />
      <input id="stableMinSec" />
      <input id="stableMaxSec" />
      <input id="pollSec" />
      <input id="enableRetryOnFailure" type="checkbox" />
      <input id="maxRetriesPerPrompt" />
      <input id="retryDelaySec" />
      <textarea id="systemPrompt"></textarea>
      <textarea id="appendPromptText"></textarea>
      <input id="prependSystemPrompt" type="checkbox" />
      <input id="appendSystemPrompt" type="checkbox" />
      <input id="enableMaxWaitTimeout" type="checkbox" />
      <label for="enableMaxWaitTimeout">Old timeout label</label>
      <span class="info-popover">Old timeout help</span>
      <input id="autoConfirmDialogs" type="checkbox" />
      <input id="enableWatchedElementGate" type="checkbox" />
      <div id="watchedElementContainer"><input id="watchedElementSelector" /><div class="history-buttons"></div></div>
      <input id="enableStopWord" type="checkbox" />
      <div id="stopWordContainer"></div>
      <input id="stopWord" />
      <input id="stopWordCaseSensitive" type="checkbox" />
      <input id="refreshTabBeforeEachPrompt" type="checkbox" />
      <input id="parallelOneTabPerPrompt" type="checkbox" />
      <input id="debugLoggingEnabled" type="checkbox" />
      <input id="openNewChatPerPrompt" type="checkbox" />
      <input id="openNewChatPerPromptUrl" />
      <div id="optionsContent"></div>
    `;
  }

  it('round-trips the pre-send quiet window through the injected send timing UI', async () => {
    renderSettingsDom();
    const settings = {
      theme: 'system',
      maxWaitMs: 180000,
      stableMinMs: 8000,
      stableMaxMs: 12000,
      pollIntervalMs: 1500,
      retryDelayMs: 5000,
      maxRetriesPerPrompt: 2,
      preSendQuietWindowMs: 4321,
      targetSelectors: {},
    };
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'GET_SETTINGS') return { ok: true, settings };
      if (message.type === 'SAVE_SETTINGS') return { ok: true, settings: message.settings };
      return { ok: true };
    });

    await mod.loadSettingsIntoUI();
    expect(document.getElementById('preSendQuietWindowMs').value).toBe('4321');

    document.getElementById('preSendQuietWindowMs').value = '9876';
    const saved = await mod.saveSettingsFromUI();

    expect(saved.preSendQuietWindowMs).toBe(9876);
    expect(Object.prototype.hasOwnProperty.call(saved, 'chatgptPreSendQuietWindowMs')).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'SAVE_SETTINGS',
      settings: expect.objectContaining({ preSendQuietWindowMs: 9876 }),
    }));
  });

  it('round-trips checked max wait as infinite response wait', async () => {
    renderSettingsDom();
    const settings = {
      maxWaitMs: 190000,
      stableMinMs: 8000,
      stableMaxMs: 12000,
      pollIntervalMs: 1500,
      retryDelayMs: 5000,
      maxRetriesPerPrompt: 2,
      targetSelectors: {},
    };
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === 'GET_SETTINGS') return { ok: true, settings };
      if (message.type === 'SAVE_SETTINGS') return { ok: true, settings: message.settings };
      return { ok: true };
    });

    await mod.loadSettingsIntoUI();

    expect(document.querySelector('label[for="enableMaxWaitTimeout"]').textContent).toBe('Wait indefinitely for response');
    expect(document.querySelector('.info-popover').textContent).toContain('When checked');
    expect(document.getElementById('enableMaxWaitTimeout').checked).toBe(true);

    document.getElementById('enableMaxWaitTimeout').checked = false;
    const finiteSettings = await mod.saveSettingsFromUI();
    expect(finiteSettings.enableMaxWaitTimeout).toBe(false);

    document.getElementById('enableMaxWaitTimeout').checked = true;
    const infiniteSettings = await mod.saveSettingsFromUI();
    expect(infiniteSettings.enableMaxWaitTimeout).toBe(true);
  });
});
