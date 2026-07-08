# Prompt Queue Roadmap

## Current Product

Prompt Queue is a Manifest V3 side panel extension for sending queued prompts to ChatGPT, Claude, Gemini, and Grok.

Current sidepanel branch:

- Branch: `codex/sidepanel-multisession`
- Working branch for this phase: `codex/memory-pack-sidepanel-native`
- UI entry: `manifest.json` -> `side_panel.default_path = popup.html`
- Main files: `background.js`, `content.js`, `content-targets.js`, `popup.html`, `popup.js`, `popup-settings.js`, `popup-history.js`, `styles.css`
- Native messaging scaffold already exists for transcription monitoring: `native_host.py`, `install_native_host.bat`, `native_host.example.json`

## Active Phase

| Phase | Plan | Status |
|---|---|---|
| ChatGPT send regression + native host install incident | [plans/incident-2026-05-31-chatgpt-send-native-host.md](plans/incident-2026-05-31-chatgpt-send-native-host.md) | implemented in code; live verify + residual hardening pending |
| ChatGPT send hardening + composer visibility | [plans/phase-chatgpt-send-hardening.md](plans/phase-chatgpt-send-hardening.md) | in progress |
| Memory Pack Sidepanel + Native Host | [plans/memory-pack-sidepanel-native.md](plans/memory-pack-sidepanel-native.md) | implemented; automated tests pass; manual browser smokes pending |
| Bridge → ChatGPT round-trip (result return path) | [plans/phase-bridge-chatgpt-roundtrip.md](plans/phase-bridge-chatgpt-roundtrip.md) | implemented; native host + extension tests green; live browser E2E pending |
| Sidepanel visual hierarchy polish (accents, button tiers) | this file, see UI Direction below | implemented |

## Planned Hardening Phases

| Phase | Plan | Status |
|---|---|---|
| Content/send-path modularization | [plans/phase-content-script-modularization.md](plans/phase-content-script-modularization.md) | proposed |
| Send timing + cross-tab coordination + status controls | [plans/phase-send-timing-status-controls.md](plans/phase-send-timing-status-controls.md) | in progress |
| Send-lock escalation ladder: L2 desktop-level (next, separate session) → L3 LAN coordinator → L4 router-level | [plans/phase-send-lock-escalation.md](plans/phase-send-lock-escalation.md) | proposed |
| Multi-account ChatGPT support | [plans/phase-send-lock-escalation.md](plans/phase-send-lock-escalation.md) (related items) | roadmap only |
| Bridge targets beyond ChatGPT: Claude, Gemini, Grok, other chat sites | [plans/phase-send-lock-escalation.md](plans/phase-send-lock-escalation.md) (related items) | roadmap only |

Default choices for the timing/status phase unless overridden in `Q and A.md`:

- Post-populate/pre-send delay: configurable random window, default 0.5-1.5 seconds.
- Duplicate prompt typo variation: behind `enableDuplicateTypoVariants`, default off.
- Cross-tab send lease: enabled for concurrent tab sends, with UI-configurable random wait range. Initial default: 3-12 seconds.
- Tab-scoped side panel state: switching active browser tabs must refresh queue/status to that tab and ignore other tabs' scoped progress.
- Step status colors: gray idle, blue waiting/timer, green active send, amber retry/pause, red error.
- ChatGPT composer insertion: prefer visible ProseMirror/contenteditable editor and do not rely on hidden fallback textarea for success.
- Lifecycle diagnostics: require sanitized, detailed signals for stop/send composer state, copy/good/bad buttons, loading shimmer, thinking/tool status, confirm dialog, watched selector state, pre-send quiet window, stream start/stop, and completion decision.
- Future controls: expose monitored-signal selection and lifecycle-behavior tuning in settings later, without hard-coding the current diagnostic contract.

User-approved debug-panel follow-ups captured in `Q and A.md`: move debugging controls/status into the bottom debug collapsible panel, add per-step console logging, add live selector health there, and add dry-run populate-without-send there. Debug bundle export remains a later candidate.

## Open Issue Phases

| Issue | Plan | Status |
|---|---|---|
| [#2 Escape-to-stop](https://github.com/sriharshaguthikonda/Prompt-queue/issues/2) | [plans/issue-002-escape-stop.md](plans/issue-002-escape-stop.md) | implemented; static checks passed |
| [#3 Current prompt preview](https://github.com/sriharshaguthikonda/Prompt-queue/issues/3) | [plans/issue-003-current-prompt-preview.md](plans/issue-003-current-prompt-preview.md) | implemented; static checks passed |
| [#4 ETA](https://github.com/sriharshaguthikonda/Prompt-queue/issues/4) | [plans/issue-004-eta.md](plans/issue-004-eta.md) | implemented; static checks passed |
| [#5 Drag-and-drop reorder](https://github.com/sriharshaguthikonda/Prompt-queue/issues/5) | [plans/issue-005-drag-drop-reorder.md](plans/issue-005-drag-drop-reorder.md) | implemented; static checks passed |
| [#6 Response capture/export](https://github.com/sriharshaguthikonda/Prompt-queue/issues/6) | [plans/issue-006-response-capture-export.md](plans/issue-006-response-capture-export.md) | implemented; static checks passed |
| [#7 Shared constants](https://github.com/sriharshaguthikonda/Prompt-queue/issues/7) | [plans/issue-007-shared-constants.md](plans/issue-007-shared-constants.md) | implemented; static checks passed |
| [#8 Test coverage](https://github.com/sriharshaguthikonda/Prompt-queue/issues/8) | [plans/issue-008-test-coverage.md](plans/issue-008-test-coverage.md) | implemented; Jest and Python tests passed |

## Memory Pack Direction

Prompt Queue is the canonical browser UI for `C:\.memory` memory packing. Tampermonkey is fallback only.

Success target:

- Use the actual typed prompt as default retrieval query.
- Keep the workflow in the Chrome side panel, not a click-open popup.
- Support selected text, clipboard, page context, and manual query sources.
- Preview scored memory hits before insertion.
- Let user include/exclude individual memories.
- Configure token budget, top-K, project, pinned policy, class filters, and insertion behavior from the side panel.
- Prefer native messaging for bridge auth so the browser extension does not store the memory token.
- Keep stored-token mode as fallback only.
- Insert a managed `C_MEMORY_BROWSER_PACK` block into the prompt box without duplicating previous packs.
- Store private extension settings in `chrome.storage.local`, not `chrome.storage.sync`.
- Never log raw prompt text, clipboard text, selected text, tokens, or memory contents.

## UI Direction

The side panel is a flat stack of visually equal cards with one emerald accent — hard to scan. Direction (no rainbow, no framework, `styles.css` only):

- Elevate the primary workflow: queue card visually distinct from secondary collapsible cards (Memory, Jobs, Monitoring, History).
- 2-3 hues total: existing emerald primary, one secondary hue, semantic danger/warn tokens.
- Button tiers: primary solid (Start), secondary outline (Pause/Resume/Stop), tertiary ghost (preset/utility pills).
- Clearer collapsible affordance and a stronger status/progress area.

## External Bridge Direction

Prompt Queue is the browser arm of `mcp-model-bridge`: agents submit prompts as job files, the extension drives the chat site, the native host returns captured responses as result files. ChatGPT first ([plans/phase-bridge-chatgpt-roundtrip.md](plans/phase-bridge-chatgpt-roundtrip.md)); multi-account and Claude/Gemini/Grok targets are roadmap-only ([plans/phase-send-lock-escalation.md](plans/phase-send-lock-escalation.md)).

## Backend Contract

Primary backend route:

`POST http://127.0.0.1:5599/pack/browser`

Preferred auth path:

`chrome.runtime.sendNativeMessage("com.aipromptqueue.transcription", { type: "memory_pack_browser", ... })`

Fallback auth path:

Direct loopback `fetch()` with a token stored only in `chrome.storage.local`.
