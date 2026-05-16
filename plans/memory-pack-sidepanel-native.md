# Memory Pack Sidepanel + Native Host Phase Plan

Aim: build the Phase 9B memory-pack feature on the current Prompt Queue sidepanel branch, not the older clean popup worktree.

Done when:

- Side panel exposes Memory Pack preview, edit, insert, copy, and settings controls.
- Default query is the actual typed prompt in the active chat page.
- Selected text, clipboard, page context, manual query, and combined prompt+selection work.
- Native messaging host proxies read-only memory bridge calls using `C:\.memory\config\local_token`.
- Stored-token mode remains fallback only.
- Insert replaces an existing `C_MEMORY_BROWSER_PACK` managed block.
- ChatGPT and Claude manual smokes pass.
- Existing queue automation, sidepanel lifecycle, and transcription monitor still work.

## Existing Architecture

- `manifest.json` already uses `side_panel.default_path = popup.html`.
- `background.js` already opens/closes sidepanel from toolbar clicks and owns queue state.
- `popup.html` is the sidepanel document.
- `popup.js` coordinates UI modules.
- `popup-settings.js` owns settings load/save controls.
- `content.js` already has prompt-box detection and robust text insertion helpers.
- `native_host.py` exists for transcription monitoring and can be extended with memory operations.

User dirty files at phase start:

- `AGENTS.md` modified by user.
- `TODO.md` untracked by user.

Do not stage or overwrite these unless explicitly asked.

## T1. Plan Backfill

- [x] Add `ROADMAP.md`.
- [x] Add this phase plan.
- [ ] Sync `.memory` Phase 9B docs to say current sidepanel branch is authoritative.
- [ ] Sync `.memory` external Prompt Queue notes.

Exit: repo-local plan and mother/phase docs all name the sidepanel/native-host target.

## T2. Native Host Memory Proxy

- [ ] Extend `native_host.py` with read-only memory operations:
  - `memory_healthz`
  - `memory_pack_browser`
  - `memory_projects`
  - `memory_get`
- [ ] Read token from `C:\.memory\config\local_token` at request time.
- [ ] Allow override via message field only for tests, not normal extension UI.
- [ ] Reject unknown/write-like operations.
- [ ] Do not log raw prompt, clipboard, token, or memory content to stdout/stderr.
- [ ] Update install docs/manifest example for native host reuse.
- [ ] Add a host self-test that frames native messaging requests over stdin/stdout.

Exit: native host can call `/healthz`, `/pack/browser`, and project/list read APIs without browser-stored token.

## T3. Background Bridge Client

- [ ] Add memory settings defaults under existing `DEFAULT_SETTINGS`.
- [ ] Keep existing timing/retry/sidepanel settings intact.
- [ ] Sanitize `GET_SETTINGS` so raw stored token is not returned to UI.
- [ ] Preserve stored token on settings saves where token field is omitted.
- [ ] Add native-first memory bridge calls with direct loopback fallback.
- [ ] Add message handlers:
  - `GET_MEMORY_SOURCE`
  - `PREVIEW_MEMORY_PACK`
  - `INSERT_MEMORY_PACK`
  - `MEMORY_HEALTH_CHECK`

Exit: sidepanel can request previews through native host, and fallback direct mode only when configured.

## T4. Content Script Source and Insert

- [ ] Add prompt-box/selection/page source extraction.
- [ ] Use existing input detection/selectors; do not replace current queue send logic.
- [ ] Add managed block insertion/replacement.
- [ ] Implement append and copy-only paths.
- [ ] Do not auto-submit after memory insertion.

Exit: prompt text remains editable after insert, and second insert replaces the old pack.

## T5. Sidepanel UI

- [ ] Add a collapsible `Memory Pack` card in `popup.html`.
- [ ] Add compact controls for source, project, mode, token budget, top-K, min score, pinned policy, class filters, and insert behavior.
- [ ] Add preview list with checkbox, id, class/type, score, source, snippet.
- [ ] Add editable markdown textarea.
- [ ] Add health, preview, insert, copy, save settings, clear token controls.
- [ ] Put UI logic in `popup-memory.js` and import it from `popup.js`.
- [ ] Add styles to `styles.css`.

Exit: memory flow stays in sidepanel, no popup reopen loop.

## T6. Verification

- [ ] `node --check background.js`
- [ ] `node --check content.js`
- [ ] `node --check popup.js`
- [ ] `node --check popup-memory.js`
- [ ] Native host self-test.
- [ ] `npm test` or explain missing dependency blocker.
- [ ] Live bridge health smoke.
- [ ] ChatGPT prompt-box source -> preview -> insert -> second insert replaces old pack.
- [ ] ChatGPT selected text source -> preview.
- [ ] Clipboard source -> preview.
- [ ] Claude prompt-box source -> preview -> insert.
- [ ] Bridge down -> clean sidepanel error.
- [ ] Wrong token -> auth error.

## T7. Closeout

- [ ] Update README / TESTING with native-host and sidepanel memory-pack flow.
- [ ] Update `.memory` handoff.
- [ ] Commit roadmap/plan separately from implementation.
- [ ] Commit implementation after tests.
- [ ] Push branch.
