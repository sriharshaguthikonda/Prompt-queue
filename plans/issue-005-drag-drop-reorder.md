# Issue 005: Drag-and-drop prompt reordering

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/5

## Status

Implemented in separate `popup-queue.js` module to avoid growing `popup.js`.

## Goal

The side panel can reorder parsed prompts before starting a run without making `popup.js` larger.

## Targets

- `popup.html`: add a compact queue preview list below the prompt textarea.
- `popup-queue.js`: own rendering and drag/drop reorder behavior.
- `popup.js`: initialize the queue module and refresh it when prompt text/settings change.
- `styles.css`: add small list/drag states.

## Acceptance

- Reordering updates the prompt textarea.
- Multi-line separator mode is preserved by joining reordered prompts with the active separator.
- The reorder list is not rendered while prompt parsing yields no prompts.
- `node --check popup-queue.js popup.js` passes.
