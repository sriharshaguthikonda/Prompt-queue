# Issue 002: Escape-to-stop

GitHub: https://github.com/sriharshaguthikonda/Prompt-queue/issues/2

## Goal

Pressing Escape in the side panel stops the current automation for the panel's context tab.

## Targets

- `popup.js`: document-level keydown handling near `initInfoPopovers()`.
- `popup.js`: reuse the same stop path used by `stopBtn`.
- `background.js`: existing `STOP_AUTOMATION` handler remains the authority.

## Acceptance

- Escape closes open info popovers.
- Escape stops running automation when status says `running`.
- Escape does not throw when idle or when no context tab exists.
- `node --check popup.js` passes.
