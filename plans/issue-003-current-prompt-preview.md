# Issue 003: Current prompt preview

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/3

## Goal

The side panel shows a short preview of the prompt currently being processed.

## Targets

- `background.js`: include a sanitized `currentPromptPreview` in status objects.
- `popup.js`: render the preview in the running status text.

## Acceptance

- Sequential runs show the current prompt preview.
- Tab-scoped runs show the current prompt preview.
- Parallel runs do not expose full prompt text in noisy logs.
- Preview is truncated before crossing process boundaries.
