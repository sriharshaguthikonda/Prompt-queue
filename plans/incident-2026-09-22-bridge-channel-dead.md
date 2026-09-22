# Incident Plan: Model Bridge ChatGPT Channel Dead (2026-09-22)

Date: 2026-09-22
Status: DONE for this repo (2026-09-22 21:33 IST). S8.1–S8.4b, S8.3b, S8.3c done; S8.5 live gate passed (new chat, same-tab follow-up, L9, L10). Open elsewhere: S8.7c detector and S8.8 user config (bridge).
Coordination plan (authority for ranking, QA matrix, work packages): [Tampermonkey S8-bridge-recovery.md](file:///C:/Windows_software/Tampermonkey/docs/plans/chatgpt-2026-09-churn/S8-bridge-recovery.md).
Sibling plans:
- bridge [browser-channel-recovery-2026-09.md](file:///C:/AI/mcp-model-bridge/docs/plans/browser-channel-recovery-2026-09.md)
- driftwatch [ROADMAP](file:///C:/Windows_software/driftwatch/docs/ROADMAP.md)
- earlier incident: [incident-2026-05-31-chatgpt-send-native-host.md](incident-2026-05-31-chatgpt-send-native-host.md)

## Goal

Prompt Queue serves bridge jobs on the September 2026 chatgpt.com DOM again: the job path resolves the composer and the reply through the vendored driftwatch pack, and a consumer contract test guards that routing.

## Evidence (VERIFIED unless marked)

- Edge **Profile 2** (the bridge profile; its LevelDB holds claimant `d42ce029-…`) has this extension disabled since 2026-09-22 12:38:12.794 IST with `disable_reasons: [1]` (user action). That was 2½ min after an agent asked the user to switch off *TTS Reader* in the same profile. There is no service worker, so no native port, so the host exits silently and no heartbeat is written.
- `background.js`, `native_host.py`, `run_host.bat` and `manifest.json` are byte-identical to last-known-good `8cf6a02`. `8cf6a02..HEAD` touches only `content-chat-state.js`, the two vendor files and ROADMAP.md.
- Composer-ready: `waitForComposerReady()` (`content.js:375-395`) needs a positive-size candidate. The lazy new-chat page has only a zero-size `textarea#pending-home-input`, so it throws `"Composer did not become ready before timeout"` after 10 s. This matches the 2026-09-21 job errors (`20260921T061500Z_…`, `…061530Z_…` with newChat=true, `…083617Z_…`).
- Reply capture: `responseCandidateSelectors()` (`content.js:589-597`) matches 0 on every Sept fixture and on the live page. Bridge jobs require a captured response (`content.js:1346,1388,2206`), so they can never complete.
- Prompt input: `content-targets.js:15-31` ordered fallbacks. The first Sept match of `div[contenteditable][role="textbox"]` is the negative-oracle `Edit code` editor, not the composer (fixtures; live layout unmeasured).
- Pack health: the vendored pack audits ok 11–12 / broken 0 on Sept fixtures; lazy new-chat resolves `pendingComposerInput`. Only `content-chat-state.js:115,237,503` route through it.
- Error text is lost: the host finish log line holds id + status only (`native_host.py:386`); `run()` never logs its exit (`native_host.py:915-929`).

## Sub-phases (IDs shared with the coordination plan)

### S8.1 Re-enable (ops)

- Enable "AI Prompt Queue" (unpacked, `C:\Windows_software\Chrome_extensions\Prompt-queue`, id `fmhpbbcgcpcacndbeldedphdcfnombfn`) in Edge Profile 2 only.
- Evidence required:
  - a new `watch start` line in `C:/AI/bridge_jobs/chatgpt_browser/logs/native_host_d42ce029-….log`;
  - `heartbeats/d42ce029-….json` mtime advancing every ≤15 s;
  - `bridge_health` → `chatgpt_browser.reachable=true`.
- Expected afterwards: bridge jobs still fail (S8.3 not done yet).
- DONE 2026-09-22 14:17:59. The user enabled it in the Edge profile whose display name is **"Electronics"** (folder `Profile 2`; folder `Default` shows as "Profile 1"). Evidence: `watch start` → `port_lifecycle connected`, heartbeat advancing, `bridge_health` reachable with 1 instance, `disable_reasons` none.
- Open: the user reports this profile keeps switching the extension off by itself (possibly Edge Workspaces). The bridge-side detector is S8.7c in the coordination plan.

### S8.2 RED consumer contract test

- New `tests/consumer-selector-audit.test.js` (~65 LOC, existing jest + jsdom, vendored pack).
- Fixtures are read by path from `C:/Windows_software/driftwatch/fixtures/chatgpt.com/{current/*,2026-09-21-synthetic-*}` and never copied here. Raw captures never enter this repo.
- Routes under test: composer (insert target), send, stop, reply capture. For each fixture + `state.json` the test fails when:
  - the first ordered match is `data-oracle-negative`;
  - a required state has no match;
  - a pending composer exists but no activation route handles it;
  - the reply-candidate union is empty on a fixture with a completed exchange.
- Output is page-text-free: route, fixture, selector, count, reason.
- Must be RED on today's code for all three causes (composer-ready, reply capture, `Edit code`).

### S8.3 Composer + reply capture through the pack

- Composer: resolve the pack `composer` (form-scoped) first; the literal chain stays as fallback, never first. That removes the `Edit code` decoy.
- Lazy new chat: when `composer` is absent and `pendingComposerInput` resolves, write the prompt into the stub through the native `HTMLTextAreaElement` value setter plus a bubbling `input` event, then wait for the real composer. This reuses the live-verified technique in Tampermonkey `edge-extension/modules/25-prompt-send-part1.js:173-199`; copy it, don't reinvent it.
- Reply capture: `assistantUnit` / `assistantMarkdownRoot` from the pack first, then legacy selectors.
- No behavioural change outside these two paths. S8.2 goes green; full `npx jest --silent` green; `node --check` on touched files.
- DONE 2026-09-22 (Z Code GLM-5.3, which timed out at 1794 s after finishing S8.2 and S8.3; reviewed by the orchestrator).
  - Pack-first routes: `findPromptInputForSite`, `findSendButtonForSite` (state `composing`), `collectResponseCandidates` (per-exchange `assistantMarkdownRoot` / `assistantUnit`), and `getResponseScope` with `[data-turn-key]`.
  - Lazy stub: `maybeActivatePendingComposer` runs before `waitForComposerReady`, with no second insert when the carried-over text already matches.
  - `content-input.js` strips trailing newlines before ProseMirror insertion.
  - Evidence: `consumer-selector-audit.test.js` has 4/8 failing on `a1b448f` and 8/8 passing after. Full jest 227/227 (`NODE_OPTIONS=--experimental-vm-modules`); `node --check` ok.

### S8.3b Hidden job tabs never mount the lazy composer (found in the S8.5 live gate)

- Live job `20260922T095555Z_da3fcb241f99c9fe` failed with `error_code=composer_not_ready`. Verified on the live page:
  - bridge job tabs are `active:false`, so hidden, and `requestAnimationFrame` never fires in them;
  - the stub write alone does not mount the composer, and a page-side rAF shim does not either;
  - one CDP `Page.captureScreenshot` mounted it at once, with the text carried over.
- Fix: in the lazy-stub path, while the tab is hidden, the content script asks background to attach `chrome.debugger` and capture a throwaway frame every 400 ms until `waitForComposerReady` settles (at most 10 s), then detach. This adds the `debugger` permission; Edge shows its "debugging" bar for about 1–2 s per new-chat job.
- Rejected: activating the job tab, because it steals the user's focus.
- Lane: Claude Sonnet fallback (codex and Z Code both at quota). The orchestrator fixed a STOP-during-attach race. jest 235/235.
- S8.3c (found by the S8.5 existing-conversation job, `composer_not_ready`): a hidden chatgpt conversation page renders nothing at all (0 forms, 0 exchanges, no stub), so force render now runs for any hidden chatgpt tab, not only after the stub write. Lane: ornith `test-automator` with byte-exact edits; jest 236/236.
- Also found: a temporary chat cannot be reopened by `/c/<id>` URL (the page redirects off `/c/`). So the existing-conversation job reuses the job-1 tab: same `conversation_key`, no `target_url` (`preparePromptJobsBridgeTab` then leaves the tab where it is).

### S8.4 Diagnosable failures

- `native_host.py:386` finish log adds the job's error string. Log only fixed code strings or reason codes: never prompt/response text, URLs or DOM text (whitelist rule from the bridge completion-wait plan).
- `run()` logs one `exit reason=<stdin_eof|exception>` line.
- Test: `tests/test_native_host_jobs.py::test_native_host_logs_exit_and_error`.
- Refinement (2026-09-22): job errors are sentences, so the host maps known job-path messages (prefix match) to fixed codes; a value already matching `^[a-z0-9_]{1,48}$` passes through, and anything else becomes `unrecognized`. The code goes to the finish log line and to the result JSON as `error_code`, which the bridge's S8.7b keeps.
- S8.4b dev self-reload: a `<jobs>/control/reload` sentinel makes the host post `{"type":"dev_reload"}`. `background.js` then calls `chrome.runtime.reload()` only when the manifest has no `update_url`, i.e. only for unpacked installs. This lets the S8.5 gate and L9 reload without a human on `edge://extensions`.
- DONE 2026-09-22 (codex gpt-5.6-terra, reviewed). The orchestrator reverted one deviation: the result `error` keeps the original string and `error_code` sits beside it. The log line carries only `error_code=`. Tests: `test_native_host_logs_exit_and_error` and `test_native_host_dev_reload_sentinel_fires_once`; pytest 31/31, jest 227/227.

### S8.5 Live gate (orchestrator, synthetic prompts, temporary chat only)

- One job with `target_url=https://chatgpt.com/?temporary-chat=true`, then one against an existing conversation.
- Required: `announce → claim → send → stop_observed → completion_decision → finish → result`, `status=done`, `text_chars>0`, `conversation_url` present.
- Once: disable → enable the extension and require a heartbeat within 15 s (L9 reconnect).
- DONE 2026-09-22 21:30–21:33 IST, after `ccaa2c2` (S8.3c):
  - L9: `control/reload` sentinel → `dev_reload requested` 21:30:23.296 → `exit reason=stdin_eof` → `watch start` 21:30:25.245 (1.9 s), heartbeat written the same second. This is the S8.4b self-reload path, not a manual toggle.
  - New temp chat `20260922T160052Z_c3d0455ed71723dc`: `status=done`, `text_chars=14`, `conversation_url` present, 38 s.
  - Existing conversation `20260922T160134Z_145e9c858dd5776a` (same `conversation_key`, no `target_url`): `status=done`, `text_chars=14`, same `conversation_url`, 29 s.
  - Both host traces: `announce → job_recv → claim ok → claimed → send → completion_transition… → completion_decision → finish`.
  - L10: `ask_chatgpt fallback=false` (temp chat) returned the real answer, `ok=true`, 22.5 s.

## Owners and lanes

Routing rules as of 2026-09-21:

| Step | Lane |
|---|---|
| S8.1 | orchestrator via Claude in Chrome (user click only if `edge://extensions` is unreachable) |
| S8.2 | Z Code `flash-worker` |
| S8.3 | Z Code GLM-5.3 main |
| S8.4 | one ornith edit agent with byte-exact blocks |
| S8.5 | orchestrator |
| Review | codex gpt-6-astra |

## Rollback

- S8.3: revert its commit; the literal chain returns. It is still broken on the Sept DOM, so prefer a forward fix.
- S8.2 is test-only.
- S8.4: revert two log lines.
