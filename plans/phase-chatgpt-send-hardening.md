# Phase: ChatGPT Send Hardening + Composer Visibility

Status: in progress

## Goal

Make the current ChatGPT no-reload send path reliable: populate the visible prompt editor, click the current send button, detect assistant completion, and advance the queue without needing a page reload.

## Evidence

- Current ChatGPT DOM includes a hidden fallback textarea and a visible `div#prompt-textarea.ProseMirror[contenteditable="true"]`.
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
- Treat stable assistant output/copy-action evidence as completion even when the empty composer keeps the send button disabled.
- Ensure `RESPONSE_COMPLETE` advances the next prompt or ends the run.

### T4. Selector Health

- Keep selector lookup in `content-targets.js`.
- Canonicalize picked prompt children to the editable composer.
- Fix selector-builder non-string `className` handling.
- Report when custom selectors fall back because no visible match exists.
- Surface selector health in the bottom debug collapsible panel.

### T5. Tests + Live Closeout

- Run `node --check content.js content-targets.js background.js`.
- Run targeted Jest integration tests for composer visibility, selector fallback, and completion advance.
- Reload the Edge extension and run one no-reload ChatGPT queue smoke.

## Acceptance

- With reload-before-send unchecked, ChatGPT visible prompt editor shows the injected prompt without page reload.
- Send button click starts ChatGPT streaming.
- Queue advances after assistant response completion.
- Side panel shows the wait step instead of looking idle during hidden timers.
- Debug panel shows selector health and no-reload dry-run outcome.
- No raw prompt or response text is logged.
