# Prompt Queue Roadmap

## Current Product

Prompt Queue is a Manifest V3 browser extension for sending queued prompts to ChatGPT, Claude, Gemini, and Grok. Current implementation is popup-first with:

- `manifest.json` for MV3 permissions and supported hosts.
- `background.js` for settings, queue state, history, and prompt dispatch.
- `content.js` for prompt-box insertion and response-completion waiting.
- `popup.html` / `popup.js` for queue UI.

## Active Phase

| Phase | Plan | Status |
|---|---|---|
| Memory Pack UI | [plans/memory-pack-ui.md](plans/memory-pack-ui.md) | in progress |

## Memory Pack Direction

Prompt Queue is the canonical browser UI for `C:\.memory` memory packing. Tampermonkey remains fallback only.

Success target:

- Use actual typed prompt as default retrieval query.
- Support selected text, clipboard, page context, and manual query sources.
- Preview scored memory hits before insertion.
- Let user include/exclude individual memories.
- Configure token budget, top-K, project, pinned policy, class filters, and insertion behavior from the UI.
- Insert a managed `C_MEMORY_BROWSER_PACK` block into the prompt box without duplicating previous packs.
- Store private extension settings in `chrome.storage.local`, not `chrome.storage.sync`.
- Never log raw prompt text, clipboard text, selected text, tokens, or memory contents.

## Backend Contract

Primary backend route:

`POST http://127.0.0.1:5599/pack/browser`

Fallback route:

`GET http://127.0.0.1:5599/pack` remains compatible for older flows.

Preferred token path is a native messaging helper that reads `C:\.memory\config\local_token`. Stored-token mode is fallback only.
