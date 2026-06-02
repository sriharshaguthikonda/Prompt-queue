# Phase: Content/Send-Path Modularization

Status: proposed

## Goal

Stop growing `content.js` as a catch-all file. Split send-path behavior into focused modules while preserving current extension behavior.

## Constraints

- Keep Manifest V3 loading simple. If classic content scripts are kept, load modules in deterministic order.
- Do not combine refactor with broad feature work unless a small extraction is required for a bug fix.
- Preserve existing test hooks or replace them with equivalent module-level test access.
- Preserve privacy rules: no raw prompt, response, token, clipboard, or memory text in logs.

## Proposed Modules

- `content-targets.js`: selector defaults, picker, selector sanitization, target resolution. Already exists; keep it as owner.
- `content-input.js`: composer detection, editor population, input events, send-button click primitives.
- `content-response-detect.js`: rendered user prompt detection, assistant response extraction, copy-action/stability detection.
- `content-chat-state.js`: ChatGPT readiness, pre-send quiet window, stream/stop detection, completion wait.
- `content-runner.js`: message listener and prompt orchestration only.
- `content-debug.js`: sanitized logging/status event helpers.

## Tasks

### T1. Extract Input Helpers

- Move editor population and input readback helpers out of `content.js`.
- Keep ChatGPT ProseMirror handling covered by tests.
- Export the minimum test surface needed by `tests/integration.test.js`.

### T2. Extract Response/Completion Detection

- Move rendered prompt matching and assistant response stability helpers into a response module.
- Keep stable-response completion independent from send-button enabled state.

### T3. Extract Runner Orchestration

- Leave high-level prompt run flow in one small runner module.
- Keep the runner responsible for status events and error shape only, not DOM selector details.

### T4. Wire Injection Order

- Update background content-script injection to load new files before the runner.
- Update manifest/content script entries if they are used for direct page injection.

### T5. Verification

- Run `node --check` on every content module.
- Run full Jest suite or at least integration tests that load content modules.
- Do a no-reload ChatGPT smoke after extraction.

## Acceptance

- `content.js` becomes a small compatibility/loader or is replaced by focused content modules.
- Selector, input, response detection, and runner code each have a clear owner file.
- Existing send behavior is unchanged except for bugs deliberately fixed in the hardening phase.
- Tests cover module load order and exposed test hooks.
