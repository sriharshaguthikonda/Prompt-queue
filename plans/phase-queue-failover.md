# Phase: Queue Hardening + Priority Failover + Dedicated Bridge Tab

Status: IMPLEMENTED 2026-07-14 — P1 `2dec636`, P2 `e251b78`, fixes (legacy-folder migration, requeue-skip-when-result-exists) `a4a16e2`; 170 jest + 34 pytest green. Live E2E pending. Counterpart plan: `C:/AI/mcp-model-bridge/docs/plans/queue-failover-hardening.md` (bridge side). This file owns the shared file-protocol spec.

## Why

The prompt-jobs channel is flaky and multi-browser failover does not work:

1. Whisper's `ask_ai_bridge.py` deletes `job_*.json` / `*.claimed.*` / `*.error.json` older than 10 min in the shared folder — kills long jobs. Fix: move to a dedicated jobs root.
2. Priority is only a claim-delay stagger (`background.js:4699-4728`, `priority*1500ms`). A browser with a dead tab still claims; stale claims become `claim_expired` errors and are never requeued (`native_host.py:525-552`); the watcher announces each job once (`native_host.py:419-431`) so a busy profile that ignores `job_found` never sees it again. Result: priority-1 browser never takes over.
3. Tab pick falls back to the user's most-recently-used chatgpt.com tab and replaces the composer content (`background.js:4888-4904`) — clobbers the user.
4. Conversation URL is captured (`content.js:662,1033,1821`) but dropped before `write_result_file` (`native_host.py:471-499`).
5. No liveness signal, no logs (native host cannot use stdout — framed protocol; file log required).

Verified non-problems: cross-process claim rename is atomic (one winner); result writes are tmp+replace atomic.

## Protocol spec (v2 — shared with bridge; single source of truth)

Jobs root: `C:\AI\bridge_jobs\chatgpt_browser\` (configurable; popup folder setting / bridge TOML `jobs_dir`). Whisper channel can later adopt `C:\AI\bridge_jobs\whisper\` with the same protocol.

Files (flat, rename-based — unchanged shape, new fields):

- `job_<id>.json` — pending job:
  `{ id, text, ts, source, want_result, conversation_key?, target_url?, new_chat?, attempts? (default 0) }`
  - `target_url`: `https://chatgpt.com/c/<uuid>` — navigate the bridge tab to this conversation before typing.
  - `new_chat`: true — force a fresh chat (bridge tab at chatgpt.com root).
- `job_<id>.claimed.<claimantId>.json` — claimed (atomic `os.rename`); claimantId = per-profile UUID (existing).
- `result_<id>.json` — `{ id, status: done|error, text?, error?, truncated?, conversation_url?, claimed_by?, attempts?, ts }`
- `heartbeats/<claimantId>.json` — `{ claimant_id, priority, busy, ts }`; written by native host every watch tick, min interval 15 s. Alive = file mtime < 45 s.
- `logs/native_host_<claimantId>.log` — RotatingFileHandler, maxBytes=1_000_000, backupCount=1.

Claim rule (extension side, replaces blind stagger): on `job_found`, claim unless heartbeats show an alive, non-busy instance with a strictly lower priority number. Keep a small stagger (`priority*250ms`) as tiebreak. Busy instances no longer block others.

Requeue (native host sweep, any surviving host): claimed `want_result` file older than claim TTL (3600 s) → if `attempts+1 >= 2`: write error result `claim_expired` (include `claimed_by`, `attempts`) and unlink claim; else write `job_<id>.json` back (tmp+replace, `attempts+1`) then unlink the claimed file. Voice (`want_result:false`) claimed files older than TTL: delete (fire-and-forget).

Re-announce: unclaimed `want_result` jobs are re-announced on every poll while they exist (drop the announce-once dedupe for them); voice jobs keep the 300 s stale-skip and announce-once behavior.

## Tasks

### P1 — native_host.py (pytest)
- [ ] Heartbeats: accept `priority` in `watch_jobs` message; write `heartbeats/<claimantId>.json` each tick (≥15 s apart); accept `{type:"heartbeat", busy}` updates from extension; include alive-instances snapshot in `job_found` pushes so the extension needs no extra round trip.
- [ ] Re-announce unclaimed want_result jobs every poll.
- [ ] Requeue sweep per spec (attempts cap 2) replacing `claim_expired`-on-first-expiry; sweep voice claimed files.
- [ ] Rotating log (`logging.handlers.RotatingFileHandler`) in `<jobs_root>/logs/`; log watch start/stop, announce, claim ok/lost, finish, requeue, sweeps, exceptions. New `{type:"log", line}` message appends extension lines.
- [ ] Default folder → `C:\AI\bridge_jobs\chatgpt_browser` (extension still sends folder explicitly; default is fallback).
- [ ] Tests: heartbeat freshness/interval, job_found carries alive list, re-announce, requeue cycle + attempts cap, voice sweep, log rotation at 1 MB, existing 17 protocol tests stay green.

### P2 — extension (jest)
- [ ] Claim rule vs heartbeat snapshot from `job_found` (no claim when lower-priority alive+non-busy exists).
- [ ] Send `priority` with `watch_jobs`; send `{type:"heartbeat", busy}` on automation start/stop.
- [ ] Dedicated bridge tabs: track extension-created job tabs in `chrome.storage.local` (`promptJobsBridgeTabs`); `findOrCreatePromptJobsTab` may only return members (conversation_key map entries validated against it); NEVER the most-recent-user-tab fallback — create a new inactive tab instead. If the chosen bridge tab is active in a focused window, use/create another bridge tab.
- [ ] `target_url` / `new_chat` handling: navigate bridge tab to `target_url` (validate `https://chatgpt.com/...`) or to chatgpt.com root for `new_chat`, wait for load + content-script handshake, then type.
- [ ] Conversation URL: thread captured `url` through `finishPromptJobCorrelation` → `buildFinishMessage` → native `finish_job` → result payload `conversation_url`.
- [ ] Forward claim/send/capture/finish/error log points (`background.js:4717,4746,4757,4782,4808`) via `{type:"log", line}`.
- [ ] Popup folder default → new jobs root.
- [ ] Tests: tab-pick never returns non-bridge tab; claim rule matrix (alive/busy/priority); finish message carries url; target_url validation.

## Out of scope
Whisper code changes, L2 desktop send-lease, multi-account, non-ChatGPT sites.

## Verification
`pytest` + `npm test` green; simulated failover via fake heartbeat files; live E2E (2 browsers, priority 0/1, kill-browser-0 mid-job → requeue → browser 1 finishes; long 10+ min job; user-tab untouched; conversation_url round-trip) — coordinated in bridge repo `Q and A.md`.
