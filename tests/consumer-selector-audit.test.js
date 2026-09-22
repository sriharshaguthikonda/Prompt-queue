// S8.2 consumer contract test: Prompt Queue's REAL route functions must resolve the
// composer / send / stop / reply-capture anchors on the 2026-09 chatgpt.com DOM, driven
// by the vendored driftwatch pack, and must never take a data-oracle-negative decoy as
// their first match.
//
// Fixtures are read BY ABSOLUTE PATH from the driftwatch repo and are never copied into
// this repository (incident plan S8.2; no raw page captures may enter this repo).
// Output contract: every failure string carries route / fixture / reason / count only —
// never page text, never DOM text, never URLs.

const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'vendor', 'driftwatch.js'));

const FIXTURES_ROOT = 'C:/Windows_software/driftwatch/fixtures/chatgpt.com';
const PROBE = 'pq-audit-synthetic-probe-v1'; // synthetic, not fixture text

const FIXTURE_DIRS = [
  'current/desktop',
  'current/composing',
  'current/streaming',
  'current/streaming-early',
  '2026-09-21-synthetic-composer-decoys',
  '2026-09-21-synthetic-new-chat',
  '2026-09-21-synthetic-sidebar-stop',
];

function loadFixture(dir) {
  const html = fs.readFileSync(path.join(FIXTURES_ROOT, dir, 'conversation.html'), 'utf8');
  document.body.innerHTML = html;
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, dir, 'state.json'), 'utf8'));
}

// jsdom lays out nothing: every attached node would be invisible to the rect-based
// visibility gates. Model the live page instead: positive rect for everything, EXCEPT
// the pre-hydration stub textarea, which is a zero-size element on the real lazy
// new-chat page.
let rectSpy;
beforeAll(() => {
  rectSpy = jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const zeroSize = this.matches?.('textarea#pending-home-input, textarea[data-pending-input-initialized]') === true;
    return zeroSize
      ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 }
      : { width: 640, height: 480, top: 0, left: 0, right: 640, bottom: 480, x: 0, y: 0 };
  });
});
afterAll(() => rectSpy.mockRestore());

function dwSite() {
  return window.driftwatch.use(window.driftwatch.packs['chatgpt.com']);
}

function composerOracle() {
  return document.querySelector('[data-oracle="composer"]')
    || document.querySelector('[data-composer-markdown][contenteditable="true"]');
}

// Route 1 — composer insert target: the pack composer, never a decoy editor.
describe('S8.2 consumer selector audit: composer insert target', () => {
  const withComposer = FIXTURE_DIRS.filter((dir) => dir !== '2026-09-21-synthetic-new-chat');
  it('resolves the oracle composer on every fixture that has one', () => {
    const failures = [];
    for (const dir of withComposer) {
      loadFixture(dir);
      const oracle = composerOracle();
      const el = window.PromptQueueContentTest.findPromptInputForSite('chatgpt', {});
      if (!oracle) {
        failures.push(`route=composer fixture=${dir} reason=fixture_has_no_composer_oracle`);
        continue;
      }
      if (!el) {
        failures.push(`route=composer fixture=${dir} reason=no_match count=0`);
        continue;
      }
      if (el.hasAttribute('data-oracle-negative')) {
        failures.push(`route=composer fixture=${dir} reason=first_match_is_negative tag=${el.tagName.toLowerCase()}`);
        continue;
      }
      if (el !== oracle) {
        failures.push(`route=composer fixture=${dir} reason=first_match_is_not_oracle_composer tag=${el.tagName.toLowerCase()}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('never treats the zero-size pending stub as the composer (lazy new chat)', () => {
    loadFixture('2026-09-21-synthetic-new-chat');
    const el = window.PromptQueueContentTest.findPromptInputForSite('chatgpt', {});
    expect(el === null || el === undefined).toBe(true);
  });
});

// Route 2 — pending composer activation: a stub page must have an activation route.
describe('S8.2 consumer selector audit: pending composer activation', () => {
  it('handles the pending composer stub on the lazy new-chat fixture', async () => {
    const state = loadFixture('2026-09-21-synthetic-new-chat');
    const failures = [];
    const stub = dwSite().resolve('pendingComposerInput', document)?.el || null;
    if (!stub || state.state !== 'idle') {
      throw new Error(`route=activation fixture=2026-09-21-synthetic-new-chat reason=stub_unexpected`);
    }

    const tools = window.PromptQueueContentTest;
    const findFn = typeof tools.findPendingComposerInput === 'function' ? tools.findPendingComposerInput : null;
    const writeFn = typeof tools.writePendingComposerInput === 'function' ? tools.writePendingComposerInput : null;
    if (!findFn || !writeFn) {
      failures.push(`route=activation reason=pending_composer_unhandled findFn=${!!findFn} writeFn=${!!writeFn}`);
      expect(failures).toEqual([]);
      return;
    }

    if (findFn() !== stub) {
      failures.push('route=activation reason=find_does_not_return_oracle_stub');
    }
    let inputEvents = 0;
    stub.addEventListener('input', () => { inputEvents += 1; });
    const wrote = writeFn(PROBE);
    if (wrote !== true) {
      failures.push(`route=activation reason=write_returned_false wrote=${String(wrote)}`);
    }
    if (stub.value !== PROBE) {
      failures.push(`route=activation reason=stub_value_not_set valueLen=${String(stub.value || '').length}`);
    }
    if (inputEvents < 1) {
      failures.push('route=activation reason=no_bubbling_input_event');
    }
    expect(failures).toEqual([]);
  });

  it('waitForComposerReady still times out on an unhydrated stub page (documented hazard)', async () => {
    loadFixture('2026-09-21-synthetic-new-chat');
    await expect(window.PromptQueueContentTest.waitForComposerReady({
      site: 'chatgpt',
      maxWaitMs: 150,
      pollMs: 50,
      stableWindowMs: 20,
    })).rejects.toThrow('Composer did not become ready before timeout');
  });
});

// Route 3 — send: on a composing page the pack send, never a decoy submit control.
describe('S8.2 consumer selector audit: send route', () => {
  it('resolves the oracle send button on composing fixtures', () => {
    const failures = [];
    for (const dir of FIXTURE_DIRS) {
      const state = loadFixture(dir);
      const oracle = document.querySelector('[data-oracle="sendButton"]');
      if (state.state !== 'composing' || !oracle) continue;
      const btn = window.PromptQueueContentTest.findSendButtonForSite('chatgpt', composerOracle(), {});
      if (!btn) {
        failures.push(`route=send fixture=${dir} reason=no_match count=0`);
      } else if (btn.hasAttribute('data-oracle-negative')) {
        failures.push(`route=send fixture=${dir} reason=first_match_is_negative`);
      } else if (btn !== oracle) {
        failures.push(`route=send fixture=${dir} reason=first_match_is_not_oracle_send`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// Route 4 — stop: on a streaming page the composer Stop, never a sidebar decoy.
describe('S8.2 consumer selector audit: stop route', () => {
  it('resolves the oracle stop button as an active stop on streaming fixtures', () => {
    const failures = [];
    for (const dir of FIXTURE_DIRS) {
      const state = loadFixture(dir);
      const oracle = document.querySelector('[data-oracle="stopButton"]');
      if (state.state !== 'streaming' || !oracle) continue;
      const btn = window.PromptQueueChatState.getComposerActionButton();
      const role = window.PromptQueueChatState.getComposerActionRole(btn).role;
      if (!btn) {
        failures.push(`route=stop fixture=${dir} reason=no_match count=0`);
      } else if (btn.hasAttribute('data-oracle-negative')) {
        failures.push(`route=stop fixture=${dir} reason=first_match_is_negative`);
      } else if (btn !== oracle) {
        failures.push(`route=stop fixture=${dir} reason=first_match_is_not_oracle_stop`);
      } else if (role !== 'stop-active') {
        failures.push(`route=stop fixture=${dir} reason=role_not_stop_active role=${role || 'none'}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// Route 5 — reply capture: a completed exchange must yield reply candidates. The
// driftwatch fixtures are sanitized (zero text nodes), so the observable contract is the
// candidate UNION (route function collectResponseCandidates), not captured text.
describe('S8.2 consumer selector audit: reply capture route', () => {
  it('finds reply candidates on every fixture with a completed exchange', () => {
    const failures = [];
    for (const dir of FIXTURE_DIRS) {
      loadFixture(dir);
      const completed = document.querySelectorAll('[data-oracle-exchange="copyResponseButton"]').length;
      const assistantRoots = document.querySelectorAll('[data-oracle-exchange="assistantMarkdownRoot"]').length;
      if (completed < 1 || assistantRoots < 1) continue;
      const unionFn = window.PromptQueueContentTest.collectResponseCandidates;
      if (typeof unionFn !== 'function') {
        failures.push(`route=reply fixture=${dir} reason=candidate_route_missing`);
        continue;
      }
      const union = unionFn.call(window.PromptQueueContentTest, 'chatgpt');
      if (union.length === 0) {
        failures.push(`route=reply fixture=${dir} reason=candidate_union_empty count=0`);
        continue;
      }
      const oracleMarkdown = union.some((el) => el.getAttribute?.('data-oracle-exchange') === 'assistantMarkdownRoot');
      if (!oracleMarkdown) {
        failures.push(`route=reply fixture=${dir} reason=union_has_no_oracle_assistant_markdown count=${union.length}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('captures through the pack union: captureLatestAssistantResponse consumes the union without error', () => {
    for (const dir of FIXTURE_DIRS) {
      loadFixture(dir);
      const captured = window.PromptQueueContentTest.captureLatestAssistantResponse(PROBE, {});
      expect(typeof captured.ok).toBe('boolean');
      expect(typeof captured.responseLength).toBe('number');
    }
  });
});
