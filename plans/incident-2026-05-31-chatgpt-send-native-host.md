# Incident Plan: ChatGPT Send Regression + Native Host Install

Date: 2026-05-31

## Goal

Restore Prompt Queue sending into current ChatGPT web UI and make native messaging host installation deterministic for Chrome/Edge.

Current scope extension: close the no-reload ChatGPT composer path and the queue-advance path on current ChatGPT DOM. Native host repair is implemented; remaining work is send-path hardening and live browser verification.

## Evidence

- User-provided HAR was inspected locally and is not committed.
- HAR summary: ChatGPT conversation POSTs return 200/202; no network-level 4xx/5xx blocker found in metadata.
- Current unit/integration suite passed before changes: 99 tests.
- Native host installer generated `native_host.json` with `path` pointing at `native_host.py` and placeholder extension IDs.
- Send path relies on `content.js` ChatGPT selectors and a captured send-button reference.
- Current ChatGPT composer DOM uses a visible `div#prompt-textarea.ProseMirror[contenteditable="true"]` and a hidden fallback `textarea[name="prompt-textarea"]`.
- Existing code already has `content-targets.js`; future send-path changes should keep selector/editing logic modular instead of growing `content.js`.

## Sub-phases

### Phase 1: Native Host Install Repair

- Add a PowerShell installer that writes `native_host.json`, validates extension IDs, and registers HKCU Chrome/Edge native messaging keys.
- Keep the batch file as the user-facing entrypoint.
- Point the manifest at `run_host.bat`, not directly at `native_host.py`.
- Make `run_host.bat` path-relative and Python-discovery based.

### Phase 2: ChatGPT Send Path Repair

- Broaden ChatGPT input selectors for `contenteditable="plaintext-only"` and current composer variants.
- Broaden send-button detection for unscoped `data-testid`, `aria-label`, and submit buttons.
- Refresh send-button lookup after text insertion and immediately before clicking.
- Make rendered-prompt verification tolerate newer message DOM markers.

### Phase 2B: No-Reload Composer Visibility + Completion Hardening

- Prefer the visible ProseMirror/contenteditable composer over the hidden fallback textarea.
- Populate the editor using browser/editor-native input semantics, then verify visible editor text, not only a hidden textarea value.
- Keep the no-reload path active: if reload-before-send is unchecked, do not require page reload to populate or send.
- Close the queue-advance blocker where completion waits on `canSend` after the assistant response is stable but the composer is empty and the send button is disabled.
- Surface pre-send quiet-window waits and completion waits as status events so the side panel shows what is happening during timers.
- Preserve privacy: debug status can include step names, selectors, durations, and prompt lengths, but not raw prompt or response text.

### Phase 2C: Selector/Pick UI Hardening

- Keep custom selector support in `content-targets.js`/`popup-target-settings.js`, not inline in `content.js`.
- Canonicalize picked prompt children to the editable composer.
- Fix selector-builder edge cases such as non-string `className`.
- Show selector health in UI when a custom selector has no visible match and a fallback is used.

### Phase 3: Verification

- Run JavaScript tests.
- Run Python native host tests.
- Run static extension checks.
- Verify installer script can fail cleanly without an extension ID and can generate the expected manifest with a supplied ID.
- Add or keep targeted regressions for:
  - no-reload ChatGPT composer population
  - visible composer selection over hidden fallback textarea
  - completion from stable assistant response with disabled empty composer
  - selector picker canonicalization
  - status event emission during waits

### Phase 4: Live Edge Closeout

- Reload the unpacked Edge extension ID `fmhpbbcgcpcacndbeldedphdcfnombfn`.
- Run a no-reload send on current ChatGPT and confirm visible textbox population, send click, stream start, completion detection, and next-prompt advance.
- Run a reload-before-send smoke only to confirm the prior stale-reload race stays fixed.
- Capture sanitized console evidence in `console.log` or `Q and A.md`; do not log raw prompt/response text.

## User Coordination

- Use `Q and A.md` as bidirectional status.
- User should provide Chrome/Edge extension ID if installer auto-detection cannot find the unpacked extension.
- User should reload extension after native host install.
- New Q&A approval items live under `2026-06-01 23:25 IST`; defaults are used unless user overrides.

## Follow-Up Phase Plans

- [ChatGPT send hardening + composer visibility](phase-chatgpt-send-hardening.md)
- [Content/send-path modularization](phase-content-script-modularization.md)
- [Send timing + cross-tab coordination + status controls](phase-send-timing-status-controls.md)
