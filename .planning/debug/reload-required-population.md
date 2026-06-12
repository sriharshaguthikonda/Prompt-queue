---
status: promoted_to_roadmap_followup
trigger: "CWD: C:\\Windows_software\\Chrome_extensions\\Prompt-queue.\n\nUse GSD/systematic debugging. You may edit only if root cause is clear and fix is bounded. Do not commit/push. You are not alone; preserve unrelated changes.\n\nBug A: User says messages populate into ChatGPT textbox only when `reload option before sending` checkbox is selected. With that option selected, sends now work. Need determine why reload is required for population.\n\nContext/memory:\n- Recent fix broadened ChatGPT input detection to contenteditable/plaintext-only variants, refreshed send button lookup before clicks, used `insertText` for plaintext-only composer, broadened rendered user-message verification.\n- User attached screenshot of target settings: Prompt input selector `div#prompt-textarea`; Send button selector `button#composer-submit-button`; Stop button selector `data-testid#stop-button` (likely wrong CSS); action buttons text `button[data-testid=\"copy-turn-action-button\"]`.\n- There is a `console.log` file in repo; user says new console log. Inspect it."
created: 2026-06-01T12:49:46.1605566+05:30
updated: 2026-06-01T13:18:00+05:30
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: "Confirmed: reload-before-send could send into the old ChatGPT document because the tab-load wait accepted stale `complete` status."
test: "Targeted syntax checks and Jest regression passed; remaining verification is live Edge extension behavior."
expecting: "After reloading the extension, reload-before-send should wait through the actual page reload before populating, so the typed prompt should not disappear at reload completion."
next_action: "User reloads the unpacked extension in Edge and re-runs the same queue flow; report whether the prompt remains and sends."

reasoning_checkpoint:
  hypothesis: "Reload-before-send sends the prompt into the old ChatGPT document because `waitForTabLoad()` accepts the tab's pre-reload `complete` status as proof that the post-reload page is loaded."
  confirming_evidence:
    - "User observed the textbox is populated only briefly while the page is reloading, then the text disappears when reload finishes."
    - "background.js:1481-1488 calls `chrome.tabs.reload()`, then `waitForTabLoad()`, then sleeps 1200ms before content injection."
    - "background.js:1445-1450 resolves `waitForTabLoad()` immediately when `chrome.tabs.get()` reports `status === 'complete'`, which can still describe the old document just after reload starts."
  falsification_test: "If a wait registered before reload and requiring a new `loading` then `complete` cycle still populates the old disappearing composer, this hypothesis is wrong or incomplete."
  fix_rationale: "Waiting for the navigation cycle triggered by reload prevents `SEND_PROMPT` from reaching the old content script/document; content injection then happens only after the new ChatGPT page reaches complete and hydrates."
  blind_spots: "This does not directly fix the separate picker `className.split` error or possible no-reload pre-send quiet-window failures; those are adjacent unless they remain after the reload race is fixed."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: "Prompt Queue should populate queued messages into the ChatGPT textbox and send without requiring the reload-before-sending option."
actual: "Messages populate into the ChatGPT textbox only when `reload option before sending` is selected. With reload selected, sends work."
errors: "Unknown until console.log is inspected."
reproduction: "On ChatGPT target settings using prompt input selector `div#prompt-textarea` and send selector `button#composer-submit-button`, run queued send with reload-before-sending disabled; textbox is not populated. Enable reload-before-sending; population and send work."
started: "After recent ChatGPT send-path fixes; exact start unknown."

## Eliminated
<!-- APPEND only - prevents re-investigating -->


## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-06-01T12:49:46.1605566+05:30
  checked: "Initial git status"
  found: "Worktree already dirty on branch codex/memory-pack-sidepanel-native; modified files include background.js, content.js, popup-settings.js, tests/integration.test.js, console.log, and multiple untracked files including content-targets.js and popup-target-settings.js."
  implication: "Must preserve unrelated changes and inspect diffs before touching files."
- timestamp: 2026-06-01T12:49:46.1605566+05:30
  checked: "Memory/project context"
  found: "Memory notes say live send path is popup.js -> background.js -> content.js; ChatGPT handling must tolerate contenteditable/plaintext-only composers, broader textbox fallbacks, and send-button regeneration before submission. Main regression shield is tests/integration.test.js."
  implication: "Prior known pattern candidate: ChatGPT UI drift/content-script send path; test this against current no-reload vs reload divergence."

- timestamp: 2026-06-01T12:52:00+05:30
  checked: "Q and A.md"
  found: "User added: message is populated for a fraction of a second when the page is reloading, then disappears after full reload finishes; console.log was updated. Earlier Q&A says the current console.log proved background sent SEND_PROMPT and content returned accepted:true."
  implication: "Reload behavior likely sends too early during navigation; no-reload failure still needs content-side evidence."
- timestamp: 2026-06-01T12:52:00+05:30
  checked: "console.log keyword scan"
  found: "Log contains repeated `[Targets] Custom selector had no visible match; falling back`, `[PromptQueue] Final input verified before send`, `[PromptQueue] Waiting for ChatGPT pre-send quiet window`, `[PromptQueue] Pre-send quiet window failed`, `[PromptQueue] Error during processing`, and picker TypeError `(element.className || '').split is not a function`."
  implication: "The no-reload/send failure is observable inside content.js after input verification, around pre-send readiness or target resolution; picker error is adjacent but not yet proven causal for Bug A."
- timestamp: 2026-06-01T12:58:30+05:30
  checked: "New user evidence"
  found: "User observed the prompt text appears only briefly while the page is reloading, then disappears after reload completes."
  implication: "This directly supports a reload/navigation race where content injection happens into the old document before the new ChatGPT document is ready."
- timestamp: 2026-06-01T12:58:30+05:30
  checked: "background.js reload path"
  found: "`refreshTabInBackgroundBeforeSend()` calls `chrome.tabs.reload(tabId)`, then `waitForTabLoad(tabId)`, then sleeps 1200ms and sends to content. `waitForTabLoad()` immediately resolves true if `chrome.tabs.get(tabId).status === 'complete'`."
  implication: "Immediately after reload is initiated, Chrome can still report the old document as complete, so the code can skip waiting for the actual reload cycle."
- timestamp: 2026-06-01T13:03:00+05:30
  checked: "Test harness and exports"
  found: "`background.js` already exposes `PromptQueueBackgroundTest` only for settings sanitization; `waitForTabLoad()` and `refreshTabInBackgroundBeforeSend()` are not currently exported. Existing Jest setup stubs `chrome.tabs.reload`, `chrome.tabs.get`, and `chrome.tabs.onUpdated`."
  implication: "A focused regression can be added with a small test seam export and fake `tabs.onUpdated` listener behavior."
- timestamp: 2026-06-01T13:18:00+05:30
  checked: "Verification"
  found: "`node --check background.js`, `node --check content.js`, `node --check content-targets.js`, and `npm test -- --runInBand tests/integration.test.js` all passed. Jest result: 36 tests passed."
  implication: "Patch is syntactically valid and regression-covered locally; live browser behavior still needs user confirmation."
## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: "`refreshTabInBackgroundBeforeSend()` waited with `waitForTabLoad()`, which could resolve against the old document's `complete` tab status immediately after `chrome.tabs.reload()` started. That allowed `SEND_PROMPT` to populate the old ChatGPT composer during navigation; the text then disappeared when the real reload completed."
fix: "Added `waitForTriggeredTabLoad()` that registers `tabs.onUpdated` before triggering reload/navigation and resolves only after a fresh `loading` then `complete` cycle. Wired reload-before-send and open-new-chat navigation through it, and added a focused Jest regression."
verification: "Self-verified with node syntax checks and targeted Jest. Awaiting live Edge extension confirmation."
files_changed:
  - background.js
  - tests/integration.test.js

## Roadmap Handoff

- timestamp: 2026-06-01T23:25:00+05:30
  checked: "Roadmap and plan ownership"
  found: "Reload race fix is documented, but no-reload composer visibility, selector health, and completion/advance waits need explicit phase ownership."
  implication: "Follow-up work now belongs to `plans/phase-chatgpt-send-hardening.md`; timing/status/refactor work belongs to dedicated phase plans."
