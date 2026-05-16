# Memory Pack UI Phase Plan

Aim: Prompt Queue previews and inserts prompt-relevant memory packs from the local `C:\.memory` bridge.

Done when:

- Popup has a top-level Memory Pack tab.
- Popup has Memory Settings controls.
- Prompt box text is the default query source.
- Selected text and clipboard are alternate query sources.
- Preview shows memory id, class/type, score, source, snippet, and include checkbox.
- Insert replaces an existing `C_MEMORY_BROWSER_PACK` block instead of duplicating it.
- User can copy the pack without insertion.
- Settings persist in `chrome.storage.local`.
- Raw prompt text, clipboard text, tokens, and memory contents are not stored in history or logs.

## Existing Architecture

- MV3 extension.
- `background.js`: service worker, settings, history, queue state, prompt dispatch.
- `content.js`: prompt insertion, editable detection, response completion waiting.
- `popup.html` / `popup.js`: popup UI.
- No build step and no package manifest in this branch. Validation is `node --check` plus manual reload as unpacked extension.

## T1. Storage and Settings

- [x] Move settings persistence from `chrome.storage.sync` to `chrome.storage.local`.
- [x] Add defaults for memory pack settings:
  - enabled,
  - bridge base URL,
  - auth mode,
  - stored token fallback,
  - query source,
  - project,
  - mode,
  - max tokens,
  - top-K,
  - minimum score,
  - pinned policy,
  - class filters,
  - insert behavior.
- [x] Do not include token or memory text in history signatures.
- [x] Add one-time migration from existing sync settings when present.

Exit: queue settings and memory settings load/save from `chrome.storage.local`.

Evidence (2026-05-16): `background.js` stores `aiTaskSequencerSettings` in `chrome.storage.local`, migrates from sync, and redacts memory token from prompt history.

## T2. Memory Pack Bridge Client

- [x] Add background message handlers:
  - `GET_MEMORY_SETTINGS`
  - `SAVE_MEMORY_SETTINGS`
  - `MEMORY_HEALTH_CHECK`
  - `PREVIEW_MEMORY_PACK`
  - `INSERT_MEMORY_PACK`
  - `COPY_MEMORY_PACK`
- [x] Implement direct loopback fallback using `POST /pack/browser`.
- [x] Preferred native host path remains planned; fallback token uses `chrome.storage.local`.
- [x] Redact errors before returning them to popup.

Exit: popup can call health check and preview without logging raw query/token content.

Evidence (2026-05-16): `background.js` handlers call native host first when selected, then stored-token loopback fallback; no query/token text is added to history.

## T3. Popup UI

- [x] Add tabs: Queue, Memory Pack, Memory Settings.
- [x] Add Memory Pack controls:
  - query source selector,
  - manual query field,
  - project field,
  - mode selector,
  - token budget,
  - top-K,
  - min score,
  - pinned policy,
  - class toggles,
  - preview/insert/copy/health buttons.
- [x] Add preview list with checkboxes and metadata.
- [x] Add Memory Settings controls:
  - bridge URL,
  - auth mode,
  - stored token fallback,
  - default options,
  - insert behavior,
  - reset defaults.

Exit: user can configure and preview memory pack without editing files.

Evidence (2026-05-16): `popup.html` and `popup.js` add Memory Pack/Memory Settings tabs, preview list, editable markdown, include checkboxes, and copy/insert controls.

## T4. Prompt Extraction and Insertion

- [x] Add content script request for prompt-box text.
- [x] Detection priority:
  1. focused contenteditable or textarea,
  2. ChatGPT `#prompt-textarea`,
  3. Claude/Gemini/Grok editable selectors,
  4. generic contenteditable,
  5. textarea.
- [x] Add selected text source.
- [x] Add clipboard source only after user action.
- [x] Insert pack with native setter / bubbled input event where required.
- [x] Replace existing managed block when present.
- [x] Preserve the typed prompt after the memory block.
- [x] Copy fallback when no prompt box exists.

Exit: ChatGPT and Claude prompt boxes support preview -> insert -> replace previous pack.

Evidence (2026-05-16): `content.js` handles `GET_MEMORY_SOURCE` and `INSERT_MEMORY_PACK`; `popup.js` copies fallback when insertion fails.

## T5. Verification

- [x] `node --check background.js`
- [x] `node --check content.js`
- [x] `node --check popup.js`
- [ ] Manual smoke: ChatGPT prompt-box source -> preview -> insert -> second insert replaces old block.
- [ ] Manual smoke: selected text source.
- [ ] Manual smoke: clipboard source.
- [ ] Manual smoke: bridge down and wrong token show clean errors.

## Borrowed Ideas, No Copied Code

- Input detection/injection: priority selectors and native setter/event pattern from public extension examples.
- Settings UX: searchable/settings panel patterns from public prompt-snippet/macro extensions.
- Queue loop: keep current state-machine pattern; add cancel/timeout/retry later if needed.
- RAG API shape: metadata-rich scored hits, no local vector store in extension.

License note: no external code copied in this phase. If code is copied later, preserve upstream copyright/license notices.
