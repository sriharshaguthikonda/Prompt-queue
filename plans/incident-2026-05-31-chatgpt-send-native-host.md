# Incident Plan: ChatGPT Send Regression + Native Host Install

Date: 2026-05-31

## Goal

Restore Prompt Queue sending into current ChatGPT web UI and make native messaging host installation deterministic for Chrome/Edge.

## Evidence

- User-provided HAR was inspected locally and is not committed.
- HAR summary: ChatGPT conversation POSTs return 200/202; no network-level 4xx/5xx blocker found in metadata.
- Current unit/integration suite passed before changes: 99 tests.
- Native host installer generated `native_host.json` with `path` pointing at `native_host.py` and placeholder extension IDs.
- Send path relies on `content.js` ChatGPT selectors and a captured send-button reference.

## Sub-phases

### Phase 1: Native Host Install Repair

- Add a PowerShell installer that writes `native_host.json`, validates extension IDs, and registers HKCU Chrome/Edge native messaging keys.
- Keep the batch file as the user-facing entrypoint.
- Point the manifest at `run_host.bat`, not directly at `native_host.py`.
- Make `run_host.bat` path-relative and Python-discovery based.

### Phase 2: ChatGPT Send Path Repair

- Broaden ChatGPT input selectors for `contenteditable="plaintext-only"` and current composer variants.
- Broaden send-button detection for unscoped `data-testid`, `aria-label`, and submit buttons.
- Refresh send-button lookup after text insertion and immediately before clicking.
- Make rendered-prompt verification tolerate newer message DOM markers.

### Phase 3: Verification

- Run JavaScript tests.
- Run Python native host tests.
- Run static extension checks.
- Verify installer script can fail cleanly without an extension ID and can generate the expected manifest with a supplied ID.

## User Coordination

- Use `Q and A.md` as bidirectional status.
- User should provide Chrome/Edge extension ID if installer auto-detection cannot find the unpacked extension.
- User should reload extension after native host install.
