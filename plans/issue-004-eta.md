# Issue 004: ETA

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/4

## Status

Implemented with observed-duration tracking in `background.js` and compact ETA display in `popup.js`.

## Goal

The side panel shows an estimated time remaining based on observed prompt completion times.

## Targets

- `background.js`: track completed prompt durations and average response time.
- `background.js`: expose `averageResponseMs`, `elapsedPromptMs`, and `etaMs` through status.
- `popup.js`: format and display ETA compactly in the running status.

## Acceptance

- ETA is hidden until at least one prompt has completed.
- ETA updates while a prompt is running.
- Paused/parallel states do not show misleading ETA.
- `node --check background.js popup.js` passes.
