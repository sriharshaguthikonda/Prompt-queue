# TODO — Prompt Queue

Source of truth: [GitHub Issues](https://github.com/sriharshaguthikonda/Prompt-queue/issues).
Branch: `codex/sidepanel-multisession`.
Regenerate: `gh issue list --repo sriharshaguthikonda/Prompt-queue --state open`

## P0 — Critical
- Verify/fix ChatGPT no-reload composer population against the visible ProseMirror editor, not hidden fallback textarea.
- Verify/fix ChatGPT queue advancement after assistant response completion when stale hard activity signals remain but copy/good/bad response actions prove completion.

## P1 — Important
- Modularize `content.js` send path into focused content modules; keep selector logic, editor insertion, response detection, and runner orchestration separate.
- Add configurable post-populate/pre-send delay. Default: random 0.5-1.5 seconds.
- Add cross-tab send lease so concurrent tabs wait a UI-configurable random delay before sending. Initial default wait: 3-12 seconds.
- Add color-coded step/timer UI for waiting, populating, pre-send delay, sending, waiting for response, retry, pause, and error.
- Put duplicate-prompt typo variation behind a checkbox and disable it by default.
- Move debugging controls/status into the bottom debug collapsible panel, including live selector health, dry-run populate-without-send, and per-step console logging.

## P2 — Nice to have
- Q&A approval candidate still pending: debug bundle export.
- [#2](https://github.com/sriharshaguthikonda/Prompt-queue/issues/2) [ENH] Add Escape-to-stop keyboard shortcut
- [#3](https://github.com/sriharshaguthikonda/Prompt-queue/issues/3) [ENH] Show current prompt progress (truncated preview)
- [#4](https://github.com/sriharshaguthikonda/Prompt-queue/issues/4) [ENH] Estimated time remaining based on avg response time
- [#5](https://github.com/sriharshaguthikonda/Prompt-queue/issues/5) [ENH] Drag-and-drop prompt reordering
- [#6](https://github.com/sriharshaguthikonda/Prompt-queue/issues/6) [ENH] Response capture/export option
- [#7](https://github.com/sriharshaguthikonda/Prompt-queue/issues/7) [DX] Extract shared constants to module
- [#8](https://github.com/sriharshaguthikonda/Prompt-queue/issues/8) [DX] Improve unit test coverage

---
Historical completed/in-progress notes: see [TODO.txt](TODO.txt).
