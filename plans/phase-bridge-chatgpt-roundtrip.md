# Phase: Bridge → ChatGPT Round-Trip (result return path)

Status: in progress (2026-07-08)
Counterpart: `C:\AI\mcp-model-bridge\docs\plans\browser-channel-chatgpt.md`

## Aim

External agents (via the `mcp-model-bridge` MCP server) can ask the user's ChatGPT web account a question through Prompt Queue and receive the captured response back. ChatGPT's account-side memory/chat history makes this channel uniquely valuable; no API or local memory system reproduces it.

## What already exists (reuse, don't reinvent)

- File job pipeline: producer atomically writes `job_<id>.json` `{id, text, ts}` to the jobs dir (default `C:\Windows_software\openai whisper\prompt_jobs`); `native_host.py` watches and pushes `job_found`; extension claims via atomic rename; producer sees `job_<id>.claimed.*`. Proven by the voice path (`whisper-keyboard/wkey/ask_ai_bridge.py`).
- Response capture: `content.js` captures the assistant turn and posts `RESPONSE_COMPLETE` with `responseText`; background stores it in `aiTaskSequencerResponses`.
- Gap: captured response is never correlated to the job or written to disk. `finishPromptJob` sends status only, and fires too early.

## Protocol (v1)

Job file (producer → extension), unchanged for voice; bridge adds:

```json
{ "id": "<id>", "text": "<prompt>", "ts": "<iso>", "source": "model_bridge", "want_result": true }
```

Result file (native host → producer), written atomically (tmp + rename) as `result_<id>.json` — deliberately NOT `job_*.json` so `ask_ai_bridge.py`'s cleanup glob never matches it:

```json
{ "id": "<id>", "status": "done|error", "text": "<response>", "error": null, "truncated": false, "text_chars": 1234, "ts": "<iso>" }
```

## Tasks

- [ ] A1 Job schema: accept optional `want_result` + `source`; voice jobs unchanged (fire-and-forget).
- [ ] A2 Deferred finish: for `want_result` jobs do NOT finish after `startAutomationForTab` returns; finish only from the matching `RESPONSE_COMPLETE`/error handler with `{id, status, responseText, error?}`.
- [ ] A3 Durable correlation: persist `{jobId, wantResult, promptId, claimedFile}` to `chrome.storage.local` before send so MV3 service-worker restart/sleep recovery can still finish the job.
- [ ] A4 Capture correctness: baseline assistant-turn set before send; accept only a new stable turn. Empty/missing response ⇒ `status:"error"`, never empty success.
- [ ] A5 Insertion verification: composer text must match job text before submit; mismatch ⇒ error result, no partial send.
- [ ] A6 Host result writer: `finish_job` writes `result_<id>.json` atomically when the claimed job had `want_result`, then removes the claimed marker. Voice jobs keep delete behavior.
- [ ] A7 Orphan backstop: host writes `status:"error"` (`reason:"claim_expired"`) result for claimed-without-result jobs older than TTL (default: response timeout + slack) so callers never hang on a crashed browser.
- [ ] A8 Truncation: cap `text` at 20k chars (existing capture cap), report `truncated`/`text_chars`. Age-based stale-result cleanup.
- [ ] A9 Tests (`tests/test_native_host_jobs.py`): result written for want_result happy/error/claim-expired; absent for voice jobs; atomic (no partial JSON readable).

## Done when

Bridge test harness (fake claim + result) round-trips, pytest + jest + `node --check background.js` green, and a live prompt from the MCP `ask_chatgpt` tool returns ChatGPT's answer to the calling agent.
