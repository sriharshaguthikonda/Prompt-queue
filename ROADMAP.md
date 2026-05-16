# Prompt Queue Roadmap

## Current Product

Prompt Queue is a Manifest V3 side panel extension for sending queued prompts to ChatGPT, Claude, Gemini, and Grok.

Current sidepanel branch:

- Branch: `codex/sidepanel-multisession`
- Working branch for this phase: `codex/memory-pack-sidepanel-native`
- UI entry: `manifest.json` -> `side_panel.default_path = popup.html`
- Main files: `background.js`, `content.js`, `popup.html`, `popup.js`, `popup-settings.js`, `popup-history.js`, `styles.css`
- Native messaging scaffold already exists for transcription monitoring: `native_host.py`, `install_native_host.bat`, `native_host.example.json`

## Active Phase

| Phase | Plan | Status |
|---|---|---|
| Memory Pack Sidepanel + Native Host | [plans/memory-pack-sidepanel-native.md](plans/memory-pack-sidepanel-native.md) | implemented; automated tests pass; manual browser smokes pending |

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

## Backend Contract

Primary backend route:

`POST http://127.0.0.1:5599/pack/browser`

Preferred auth path:

`chrome.runtime.sendNativeMessage("com.aipromptqueue.transcription", { type: "memory_pack_browser", ... })`

Fallback auth path:

Direct loopback `fetch()` with a token stored only in `chrome.storage.local`.
