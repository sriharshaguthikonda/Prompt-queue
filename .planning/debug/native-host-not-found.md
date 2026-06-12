---
status: investigating
trigger: "CWD: C:\\Windows_software\\Chrome_extensions\\Prompt-queue. Use GSD-style scientific debugging. Diagnose root cause first, then apply a fix only if the evidence is clear and the edit scope is bounded. You are not alone in the codebase; preserve unrelated changes and do not revert user work. Do not commit or push. Bug report from user: `[AI Prompt Queue] [Transcription] Failed to load state from file: Error: Specified native messaging host not found.` Context: `extension://fmhpbbcgcpcacndbeldedphdcfnombfn/background.js` Stack: `background.js:35 (anonymous function)` Recent memory hint: native host installer was changed to generate `native_host.json` for `run_host.bat`, validate exact Chrome/Edge extension IDs, and register HKCU NativeMessagingHosts. Live install still required real extension ID in `allowed_origins`."
created: 2026-06-01T11:59:26.3937003+05:30
updated: 2026-06-01T12:09:45.0000000+05:30
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: Root cause is a stale live native messaging registration: HKCU Chrome/Edge keys point to C:\Windows_software\Chrome_extensions\Prompt-queue\native_host.json, but that manifest file is absent.
test: Re-run user-level installer with the exact extension ID to recreate native_host.json and preserve HKCU NativeMessagingHosts registration.
expecting: Installer should create native_host.json with allowed_origins containing chrome-extension://fmhpbbcgcpcacndbeldedphdcfnombfn/ and keep HKCU Chrome/Edge keys pointed at that file.
next_action: On continuation, run the bounded HKCU repair command if user permits: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install_native_host.ps1 -EdgeExtensionId fmhpbbcgcpcacndbeldedphdcfnombfn

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Extension background transcription state load should connect to the registered native messaging host and load state.
actual: Background page logs a failure while loading state from file.
errors: "[AI Prompt Queue] [Transcription] Failed to load state from file: Error: Specified native messaging host not found."
reproduction: Load/run extension with ID fmhpbbcgcpcacndbeldedphdcfnombfn; background.js line 35 attempts native messaging and throws the Chrome native messaging host-not-found error.
started: Unknown; recent context says native host installer changed and live install still required the real extension ID in allowed_origins.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-06-01T12:03:12+05:30
  checked: GSD common bug patterns and local memory index/Q and A.md context.
  found: Symptom maps to Environment/Config. Memory index says native host manifest should point to run_host.bat, installer should write HKCU Chrome/Edge keys, and install cannot finish without real unpacked extension ID in allowed_origins. Q and A.md records prior install command using -EdgeExtensionId fmhpbbcgcpcacndbeldedphdcfnombfn with installer output showing allowed origin chrome-extension://fmhpbbcgcpcacndbeldedphdcfnombfn/.
  implication: Strong initial candidate is live native messaging registration/manifest state, not extension UI send selectors.

- timestamp: 2026-06-01T12:03:12+05:30
  checked: git status before investigation.
  found: Worktree is already dirty, including background.js and multiple UI/test files; .planning is untracked from this debug session.
  implication: Any fix must avoid reverting unrelated user/agent changes.

- timestamp: 2026-06-01T12:08:30+05:30
  checked: Repo native host files.
  found: install_native_host.ps1 uses host name com.aipromptqueue.transcription, writes native_host.json, validates 32-character a-p extension IDs, sets HKCU Chrome/Edge NativeMessagingHosts keys, and points the manifest path to run_host.bat. run_host.bat launches native_host.py. native_host.json is currently not present in the repo.
  implication: The repo installer design matches the expected host name, but the live install artifact is missing.

- timestamp: 2026-06-01T12:09:00+05:30
  checked: Live registry with reg query for com.aipromptqueue.transcription.
  found: HKCU Chrome and HKCU Edge NativeMessagingHosts keys both exist and both default to C:\Windows_software\Chrome_extensions\Prompt-queue\native_host.json. HKLM Chrome/Edge and WOW6432Node Chrome/Edge keys are absent.
  implication: User-level registration exists, but it points to a missing manifest file; no admin/HKLM repair path is needed.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause:
fix:
verification:
files_changed: []
