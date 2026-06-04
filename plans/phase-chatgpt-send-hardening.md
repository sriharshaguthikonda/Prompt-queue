# Phase: ChatGPT Send Hardening + Composer Visibility

Status: in progress

## Goal

Make the current ChatGPT no-reload send path reliable: populate the visible prompt editor, click the current send button, detect assistant completion, and advance the queue without needing a page reload.

Lifecycle reference: [ChatGPT + Extension Lifecycle Flow](../docs/chatgpt-extension-lifecycle-flow.md).

## Evidence

- Current ChatGPT DOM includes a hidden fallback textarea and a visible `div#prompt-textarea.ProseMirror[contenteditable="true"]`.
- Current ChatGPT composer action uses `button#composer-submit-button`, whose attributes change between send, stop, and disabled states.
- Latest console evidence showed `responseCaptured: true`, `responseStableFor` over 600 seconds, `canSend: true`, and no stop button, but stale hard activity signals still blocked completion.
- `content-targets.js` already has visible ChatGPT composer candidates and selector sanitization.
- `content.js` still owns too much behavior: input population, send readiness, response detection, completion waiting, and runner orchestration.
- `.planning/debug/reload-required-population.md` resolved one reload race but left no-reload composer and wait-state blind spots.

## Tasks

### T1. Live Reproduction Matrix

- Verify Edge no-reload flow on the current ChatGPT page.
- Record only sanitized evidence: selectors, step names, durations, prompt lengths, and error names.
- Confirm whether the visible editor text changes before send without page reload.

### T2. Visible Composer Insertion

- Prefer visible contenteditable/ProseMirror candidates over hidden fallback textarea.
- Use editor-native insertion semantics for ChatGPT contenteditable fields.
- Verify visible editor text after insertion and before send.
- Do not treat hidden fallback textarea value as enough proof that the user-visible textbox is populated.

### T3. Send Click + Completion Advance

- Refresh the send button after insertion and immediately before click.
- Keep support for `button#composer-submit-button`, `button[data-testid="send-button"]`, and `aria-label` send variants.
- Treat `button#composer-submit-button` as a role-changing composer action, not a stable send-only button.
- Drive completion from stable latest assistant output plus response action markers: copy response, good response, or bad response.
- Scope response action markers to the assistant turn after the rendered queued prompt so older copy buttons cannot satisfy a new completion wait.
- Do not let stale hard activity signals block completion when a stable response and response action marker are present and the composer action is not actively stop-role.
- Log sanitized completion diagnostics: composer role, response marker names, and activity blocker reason names.
- Ensure `RESPONSE_COMPLETE` advances the next prompt or ends the run.

### T4. Selector Health

- Keep selector lookup in `content-targets.js`.
- Canonicalize picked prompt children to the editable composer.
- Fix selector-builder non-string `className` handling.
- Report when custom selectors fall back because no visible match exists.
- Surface selector health in the bottom debug collapsible panel.
- Keep lifecycle selector roles synchronized with `docs/chatgpt-extension-lifecycle-flow.md`.

### T5. Tests + Live Closeout

- Run `node --check content.js content-targets.js content-input.js content-status.js content-chat-state.js background.js`.
- Run targeted Jest integration tests for composer visibility, selector fallback, and completion advance.
- Reload the Edge extension and run one no-reload ChatGPT queue smoke.

## Acceptance

- With reload-before-send unchecked, ChatGPT visible prompt editor shows the injected prompt without page reload.
- Send button click starts ChatGPT streaming.
- Queue advances after assistant response completion when copy/good/bad response actions appear and no active stop-role composer button remains.
- Side panel shows the wait step instead of looking idle during hidden timers.
- Debug panel shows selector health and no-reload dry-run outcome.
- No raw prompt or response text is logged.
