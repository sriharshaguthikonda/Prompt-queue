# Issue 006: Response capture/export

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/6

## Status

Implemented as best-effort response capture plus JSON and Markdown history exports.

## Goal

Capture completed assistant responses and export prompt history plus response records to JSON and Markdown.

## Targets

- `content.js`: capture a best-effort latest assistant response after completion.
- `background.js`: persist bounded response records in `chrome.storage.local`.
- `popup-history.js`: include responses in JSON export and provide Markdown rendering.
- `popup.html`/`popup.js`: expose Markdown export next to existing JSON export.

## Acceptance

- Queue flow still advances through `RESPONSE_COMPLETE`.
- Captured response text is capped before storage.
- JSON export includes `responses`.
- Markdown export includes prompts and captured responses.
- `node --check content.js background.js popup-history.js popup.js` passes.
