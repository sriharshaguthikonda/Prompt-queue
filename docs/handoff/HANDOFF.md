<!-- codex-handoff session_id=019e844b-1563-7323-9d36-41140067cae2 -->
# Handoff

## Status

- Repo: `C:\Windows_software\Chrome_extensions\Prompt-queue`
- Branch: `codex/memory-pack-sidepanel-native`
- Usage at stop: 5-hour 96.0%, weekly 78.0%, context 50.5%.
- Normal work stopped by usage hook; only this handoff was written.
- Latest task before stop: roadmap/phase-plan update for ChatGPT send hardening, modularization, configurable timing, cross-tab send wait, debug panel, and no-reload ProseMirror population.
- Validation already run before handoff: `git diff --check` passed for docs touched in that planning update.

## What changed

- Updated roadmap/planning docs:
  - `ROADMAP.md`
  - `TODO.md`
  - `plans/incident-2026-05-31-chatgpt-send-native-host.md`
  - `plans/phase-chatgpt-send-hardening.md`
  - `plans/phase-content-script-modularization.md`
  - `plans/phase-send-timing-status-controls.md`
  - `.planning/debug/reload-required-population.md`
  - `Q and A.md`
- Added phase ownership:
  - ChatGPT no-reload send reliability: `plans/phase-chatgpt-send-hardening.md`
  - Content/send-path modularization: `plans/phase-content-script-modularization.md`
  - Send timing/cross-tab/status controls: `plans/phase-send-timing-status-controls.md`
- Folded Q&A answers into plans:
  - Cross-tab random wait must be configurable in UI.
  - Agent can choose status colors.
  - Bottom debug collapsible panel owns live selector health, dry-run populate-without-send, and per-step console logging.
- Repo maps verified live enough for navigation:
  - `repo-map context slice --repo C:\Windows_software\Chrome_extensions\Prompt-queue --path content.js --json`
  - Also verified slices for `background.js`, `popup-prompt-plan.js`, and `content-targets.js`.
  - Caveat: repo-map reports `staleness: dirty` because worktree has uncommitted changes.

## Current files

- Dirty tracked files from current `git status`:
  - `AGENTS.md`
  - `ROADMAP.md`
  - `console.log`
  - `plans/incident-2026-05-31-chatgpt-send-native-host.md`
  - `popup.html`
  - `tampermonkey-automation-core.user.js`
- Untracked relevant files/directories:
  - `.agent-reports/`
  - `.planning/`
  - `.repo-intel/`
  - `Q and A.md`
  - `TODO.md`
  - `docs/handoff/HANDOFF.md`
  - `plans/phase-chatgpt-send-hardening.md`
  - `plans/phase-content-script-modularization.md`
  - `plans/phase-send-timing-status-controls.md`
- Other untracked user/local files present:
  - `Plab 2 Feedback v22 - Speculum Examination Teaching.html`
  - `Prompts/`
  - `popup.html.bak`

## Open issues

- ChatGPT no-reload send path still needs implementation/live verification:
  - Visible ProseMirror editor must populate without reload.
  - Send click must start stream.
  - Queue must advance after assistant completion even when composer is empty and send button is disabled.
- `content.js` remains large; modularization is planned, not implemented in this handoff turn.
- Duplicate-prompt typo variation currently exists and is always-on; plan says checkbox-controlled and default-off.
- Post-populate/pre-send waits are still hard-coded in source; plan says UI-configurable random delay.
- Existing parallel random delays are not a true global cross-tab send lease.
- Debug panel work is planned: selector health, dry-run, per-step logging.
- Worktree has unrelated/user changes; do not revert or overwrite without inspecting.

## Next steps

1. Read latest `Q and A.md` before editing; user uses it as live coordination.
2. Inspect current diffs before source changes:
   - `git diff -- ROADMAP.md TODO.md plans`
   - `git diff -- content.js content-targets.js background.js popup.js popup-settings.js popup.html styles.css`
3. Continue with `plans/phase-chatgpt-send-hardening.md` first:
   - no-reload visible composer population
   - completion/advance unblock
   - selector health in bottom debug panel
4. Then implement `plans/phase-send-timing-status-controls.md`:
   - duplicate typo checkbox default-off
   - configurable post-populate/pre-send delay
   - UI-configurable cross-tab send lease wait
   - step/timer status colors
5. Keep implementation modular; avoid growing catch-all files.

## Resume commands

```powershell
cd C:\Windows_software\Chrome_extensions\Prompt-queue
git status --short --branch
Get-Content -LiteralPath 'Q and A.md' -Tail 140
repo-map context slice --repo C:\Windows_software\Chrome_extensions\Prompt-queue --path content.js --json
repo-map context slice --repo C:\Windows_software\Chrome_extensions\Prompt-queue --path background.js --json
git diff -- ROADMAP.md TODO.md plans .planning "Q and A.md"
```

Useful checks after implementation:

```powershell
node --check content.js
node --check content-targets.js
node --check background.js
npm test -- --runInBand tests/integration.test.js
```

## Risks

- Usage was high when stopped; avoid broad exploration before re-establishing current diffs.
- Repo-map artifact is useful but dirty/stale relative to uncommitted changes; verify exact lines with file reads.
- `console.log` is a captured repo log, not terminal output; treat it as evidence but do not commit noisy logs unless requested.
- Native host and extension ID work was previously fixed for Edge ID `fmhpbbcgcpcacndbeldedphdcfnombfn`, but live browser reload/smoke may still be needed.
- Debug/status logs must stay sanitized: no raw prompt text, response text, memory contents, tokens, credentials, or private transcripts.
