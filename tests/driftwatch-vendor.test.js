const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'vendor', 'driftwatch.js'));

// Sanitized 2026-09 chatgpt.com fixtures copied from the driftwatch repo
// (fixtures/chatgpt.com/current/<variant>/) — no page text, attributes only.
const FIXTURES = path.join(__dirname, 'fixtures', 'chatgpt-2026-09');

function loadFixture(variant) {
  document.body.innerHTML = fs.readFileSync(path.join(FIXTURES, variant, 'conversation.html'), 'utf8');
}

function site() {
  const dw = window.driftwatch;
  return dw.use(dw.packs['chatgpt.com']);
}

describe('vendored driftwatch pack v2 (2026-09 re-vendor, churn plan S6.1)', () => {
  it('vendored engine carries the S2.6 staleness stamp for pack v2', () => {
    const vendored = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'driftwatch.js'), 'utf8');
    expect(vendored).toMatch(/^\/\/\s*driftwatch-stamp:\s*chatgpt\.com@2\s+dist-sha256=[0-9a-f]{16}\s*$/m);
  });

  it('vendored pack file is the same v2 pack baked into the engine', () => {
    const packFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'driftwatch-pack-chatgpt.json'), 'utf8'));
    expect(packFile.pack).toBe('chatgpt.com');
    expect(packFile.version).toBe(2);
    expect(window.driftwatch.packs['chatgpt.com'].version).toBe(2);
    expect(window.driftwatch.packs['chatgpt.com']).toEqual(packFile);
  });

  it('pack v2 declares the v2 anchors and never scopes a strategy with inside:exchangeRoot', () => {
    const anchors = window.driftwatch.packs['chatgpt.com'].anchors;
    for (const name of [
      'exchangeRoot', 'userUnit', 'assistantUnit', 'assistantMarkdownRoot',
      'responseActionBar', 'codeBlock', 'copyResponseButton', 'composerForm',
      'composer', 'sendButton', 'stopButton',
    ]) {
      expect(anchors[name]).toBeTruthy();
    }
    for (const anchor of Object.values(anchors)) {
      for (const strategy of anchor.strategies || []) {
        expect(strategy.requires || []).not.toContain('inside:exchangeRoot');
      }
    }
  });

  it('exchanges come from resolve("exchangeRoot", document).els and match the fixture collection oracle', () => {
    loadFixture('desktop');
    const result = site().resolve('exchangeRoot', document);
    expect(result.ok).toBe(true);
    const oracleCount = fs.readFileSync(path.join(FIXTURES, 'desktop', 'conversation.html'), 'utf8')
      .split('data-oracle-collection="exchangeRoot"').length - 1;
    expect(result.els).toHaveLength(oracleCount);
    for (const exchange of result.els) {
      expect(exchange.hasAttribute('data-turn-key')).toBe(true);
    }
  });

  it('resolves assistantUnit per exchange with the exchange element as scope', () => {
    loadFixture('desktop');
    const dwSite = site();
    const exchanges = dwSite.resolve('exchangeRoot', document).els;
    expect(exchanges.length).toBeGreaterThanOrEqual(2);
    let assistantUnits = 0;
    for (const exchange of exchanges) {
      const unit = dwSite.resolve('assistantUnit', exchange);
      if (unit.ok && unit.el) {
        assistantUnits += 1;
        expect(exchange.contains(unit.el)).toBe(true);
      }
    }
    expect(assistantUnits).toBeGreaterThanOrEqual(2);
  });

  it('getLatestAssistantTurn returns the LAST assistant-bearing exchange on the Sept shape', () => {
    loadFixture('desktop');
    const dwSite = site();
    const scope = window.PromptQueueChatState.getLatestAssistantTurn();
    expect(scope).not.toBeNull();
    expect(scope.hasAttribute('data-turn-key')).toBe(true);
    const unit = dwSite.resolve('assistantUnit', scope);
    expect(unit.ok).toBe(true);
    expect(scope.contains(unit.el)).toBe(true);
    const exchanges = dwSite.resolve('exchangeRoot', document).els;
    expect(scope).toBe(exchanges[exchanges.length - 1]);
  });

  it('findResponseCompletionMarkers finds the pack-driven Copy control inside the last exchange', () => {
    loadFixture('desktop');
    const scope = window.PromptQueueChatState.getLatestAssistantTurn();
    const markers = window.PromptQueueChatState.findResponseCompletionMarkers(scope);
    const packMarker = markers.find((marker) => marker.selector === 'driftwatch:copyResponseButton');
    expect(packMarker).toBeTruthy();
    expect(scope.contains(packMarker.node)).toBe(true);
  });

  it('idle Sept fixture: Send stays mounted but disabled, so the pack send never resolves', () => {
    loadFixture('desktop');
    const dwSite = site();
    expect(dwSite.resolve('sendButton', document, { state: 'composing' }).ok).toBe(false);
    expect(dwSite.resolve('stopButton', document, { state: 'streaming' }).ok).toBe(false);
    expect(window.PromptQueueChatState.getComposerActionRole().role).toBe('send-disabled');
    expect(window.PromptQueueChatState.classifyChatGPTDomActivity().active).toBe(false);
  });

  it('composing Sept fixture: the enabled Send resolves as the composer action control', () => {
    loadFixture('composing');
    const send = site().resolve('sendButton', document, { state: 'composing' });
    expect(send.ok).toBe(true);
    const button = window.PromptQueueChatState.getComposerActionButton();
    expect(button).toBe(send.el);
    expect(window.PromptQueueChatState.getComposerActionRole(button).role).toBe('send-ready');
  });

  it('streaming Sept fixture: the composer Stop resolves and reads as active generation', () => {
    loadFixture('streaming');
    const stop = site().resolve('stopButton', document, { state: 'streaming' });
    expect(stop.ok).toBe(true);
    expect(window.PromptQueueChatState.getComposerActionButton()).toBe(stop.el);
    const result = window.PromptQueueChatState.classifyChatGPTDomActivity();
    expect(result.stopPresent).toBe(true);
    expect(result.active).toBe(true);
  });
});
