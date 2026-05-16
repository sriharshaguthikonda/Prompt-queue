# Issue 007: Shared constants

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/7

## Goal

Reduce duplicated message/storage constants without risky service-worker module conversion.

## Targets

- `prompt-queue-constants.js`: classic-script shared constants attached to `globalThis`.
- `background.js`: load constants with `importScripts()`.
- `popup.html`: load constants before `popup.js`.
- `popup.js`/`popup-memory.js`: use shared message constants where touched.

## Acceptance

- No manifest conversion to background ES module.
- Existing popup ES module imports keep working.
- `node --check prompt-queue-constants.js background.js popup.js popup-memory.js` passes.
