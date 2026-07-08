# Phase: Send-Lock Escalation Ladder (roadmap)

Status: proposed (2026-07-08). L2 is the next step, planned for a separate Prompt Queue agent session. Nothing here is implemented in the bridge-roundtrip run.

## Current state (L1 — shipped)

Cross-tab send lease: in-memory `sendLease` in `background.js` (`acquireSendLease`/`releaseSendLease`), settings `crossTabSendLockEnabled/MinWaitMs/MaxWaitMs` (default on, 3–12 s random wait). Scope: one browser profile only — the lease dies with the service worker and is invisible to other browsers/machines.

## L2 — Desktop-level lock (cross-browser, one machine) — NEXT

- Reuse the native host's atomic-file primitive (same `os.rename` claim used for prompt jobs): a machine-wide lease file, e.g. `send_lease.lock` with `{owner, acquired_ts, expires_ts}`.
- `acquireSendLease`/`releaseSendLease` become pluggable: `memory` backend (today) or `native_host` backend.
- Every browser/profile running the extension on the machine competes for the same file; TTL expiry handles crashed owners.
- Settings surface already exists (`crossTabSendLock*`); add `sendLockScope: "profile" | "machine"`.

## L3 — Cross-network lock (LAN)

- Small lease-coordinator HTTP service on one machine (same loopback-service pattern as the `127.0.0.1:5599` memory bridge; bind LAN address).
- Endpoints: `POST /lease/acquire`, `POST /lease/release`, `GET /lease/status`; lease record with TTL; single flat JSON state, no DB.
- Extension (or native host as proxy) acquires from the coordinator URL; `sendLockScope: "network"`, plus coordinator URL setting.
- Failure mode: coordinator unreachable ⇒ fall back to L2 behavior + surface a status warning (never hard-block sends silently).

## L4 — Router-level enforcement (future, documented options)

Router-level is enforcement (nothing on the network can hit ChatGPT during a lease), not coordination. Options by infrastructure:

| Infra | Mechanism | Feasibility |
|---|---|---|
| Pi-hole / AdGuard Home | Toggle a DNS block rule for `chatgpt.com`/`chat.openai.com` via their HTTP APIs while another device holds the lease | Good — clean API, DNS TTL caveats |
| OpenWrt / DD-WRT | Firewall rule toggle via SSH/ubus/LuCI RPC | Good on flashed routers |
| Stock ISP router | No API | Not feasible |

Caveats to solve before implementing: DNS caching makes DNS blocks laggy; blocking mid-conversation can kill an in-flight response; needs allowlist for the lease-holder device (DNS blocks are network-wide, so L4 likely pairs with per-device firewall rules rather than DNS). Decision: revisit after L3 exists; current network = stock/undecided, so document-only.

## Related roadmap-only items (same decision, 2026-07-08)

- **Multi-account support**: multiple ChatGPT accounts/profiles as distinct send targets with per-account leases.
- **More bridge targets**: Claude, Gemini, Grok, and other chat sites as bridge round-trip channels (the job/result protocol is site-agnostic; per-site capture selectors already partially exist in `content-targets.js`).
