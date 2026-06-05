# Phase: Send Timing + Cross-Tab Coordination + Status Controls

Status: in progress

## Goal

Make send timing visible and configurable. Prevent simultaneous tab sends from stepping on each other. Disable duplicate-prompt typo mutation by default.

Lifecycle reference: [ChatGPT + Extension Lifecycle Flow](../docs/chatgpt-extension-lifecycle-flow.md).

## Current Gaps

- Duplicate-prompt typo variation exists and is always applied by `popup-prompt-plan.js`.
- Post-populate/pre-send controls now exist in the injected send-timing UI; keep end-to-end regression coverage so the loaded extension cannot drift back to hard-coded timing.
- Parallel tab launch has random gaps, but there is no global cross-tab send lease around actual send dispatch.
- Status badges exist, but timer/status UI does not show each wait step with clear color and countdown.
- Side panel queue/status rendering can follow the previously selected tab because popup tab context was only refreshed by polling and queue text was loaded from the global `state` blob instead of the per-tab session store.
- Lifecycle diagnostics are still too coarse unless they explain monitored signals for the stop/send composer, copy/good/bad buttons, loading shimmer, thinking/tool status, confirm dialog, watched selector state, pre-send quiet window, stream start/stop, and completion decision.

## Default Settings

- `enableDuplicateTypoVariants`: `false`
- `postPopulateDelayMinMs`: `500`
- `postPopulateDelayMaxMs`: `1500`
- `crossTabSendLockEnabled`: `true`
- `crossTabSendLockMinWaitMs`: `3000`
- `crossTabSendLockMaxWaitMs`: `12000`

Use the existing settings blob unless a durable live send-lock key is required.
Future settings should also let the user choose which monitored signals participate in lifecycle gating and how aggressively the extension treats completion, after the current hardening work lands.

## Tasks

### T1. Duplicate Prompt Variation Toggle

- Add a checkbox in settings/options UI.
- Default unchecked.
- Thread the setting into `buildPromptLaunchPlan`.
- Apply typo variants only when enabled.
- Update prompt-plan tests for enabled and disabled behavior.

### T2. Configurable Post-Populate/Pre-Send Delay

- Add min/max delay controls.
- Validate min <= max and clamp to safe bounds.
- Pick a random delay per prompt after visible editor verification and before send click.
- Show the countdown in the side panel.

### T3. Global Cross-Tab Send Lease

- Add UI controls for cross-tab random wait min/max.
- Implement a background-owned send lease around actual `SEND_PROMPT` dispatch/start confirmation.
- If another tab owns the lease, wait a random configurable delay before retrying lease acquisition.
- Release the lease after send click is confirmed or after a timeout/error.
- Avoid deadlocks when a tab closes, content script crashes, or automation stops.

### T4. Step Status Timeline

- Emit sanitized step updates: `waiting_for_tab`, `populating`, `post_populate_delay`, `pre_send_quiet_window`, `sending`, `waiting_for_response`, `completion_wait`, `retry_wait`, `paused`, `error`.
- Include countdown/end timestamp when a timer is active.
- Keep the step sequence aligned with `docs/chatgpt-extension-lifecycle-flow.md`.
- Move debugging controls/status into the bottom debug collapsible panel.
- Add per-step console logging toggle in the debug panel.
- Add dry-run populate-without-send mode in the debug panel.
- Add live selector health in the debug panel.
- Add sanitized lifecycle diagnostics for monitored signals and lifecycle decisions, with no raw prompt or response text.
- Render colors:
  - gray: idle/complete
  - blue: waiting/timer
  - green: active send/populate
  - amber: retry/pause
  - red: error

### T5. Later Candidate

- Debug bundle export.

### T6. Tab-Scoped Panel State

- Refresh popup tab context immediately on browser tab activation/focus changes.
- Filter progress, completion, error, selector-health, and step-status updates by the currently selected tab.
- Load the prompt textarea from the active tab's `aiTaskSequencerTabSessions` entry while that tab has a session.
- Do not let unscoped direct content messages repaint the panel for a different tab; use background re-broadcasts with tab ids.
- Keep a focused regression test for tab filtering and queue-state lookup.

## Acceptance

- User can configure the post-populate/pre-send delay without editing code.
- Duplicate prompts are not modified unless the checkbox is enabled.
- Concurrent sending tabs do not click send at the same moment.
- During every timer/wait, the side panel shows the current step and countdown.
- Switching tabs updates the side panel to that tab's queue/status instead of preserving the previous tab's session.
- Bottom debug panel owns selector health, dry-run, and per-step logging controls.
- Tests cover settings validation, duplicate toggle, cross-tab lease timeout/release, and status rendering.
- Monitored-signal diagnostics explain what blocked or allowed progression without exposing content.
