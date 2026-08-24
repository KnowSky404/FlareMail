# FlareMail proposed SLO and release thresholds

These are proposed RC-1 objectives, not evidence that alerts or production
monitors exist. Establish baselines in an isolated Preview, adjust thresholds
for the actual Cloudflare plan and traffic, then configure production alerts
through a separately approved operation.

All logs and evidence must exclude credentials, session/cookie values, email
addresses, subjects, bodies, raw headers/MIME, filenames, complete R2 keys, and
provider response bodies. Prefer request/correlation ID, internal entity/job
ID, object kind, bounded byte/count totals, phase, duration, status, and stable
error category.

## Objectives

| Signal | Proposed objective | Warning | Release/incident block | Primary evidence |
| --- | --- | --- | --- | --- |
| Public health availability | 99.9% successful probes over 30 days | two failures in 10 minutes | sustained failure for 5 minutes | external uptime probe plus Workers logs |
| Authenticated mailbox request | 99% successful non-user-error requests; p95 under 1 s | p95 over 1 s or error rate over 0.5% | p95 over 2 s or error rate over 1% in release window | Workers traces/logs, D1 dashboard |
| Inbound ingest | 99.9% accepted messages persist or deduplicate | retry/storage error over 0.1% | any unexplained loss, cross-owner write, or sustained failure | Email Routing/Workers logs, D1/R2 evidence |
| Expected inbound reject | 100% controlled and categorized | unusual volume/rate shift | unbounded processing or accepted over-limit input | Workers structured reject events |
| MIME parse failure | below 0.1% excluding known malformed mail | over 0.1% | over 1% or near-limit crash/resource outcome | Workers logs and fixture evidence |
| R2 persist failure | below 0.1%, no finalized D1 pointer to missing object | any retry/rollback failure | dangling finalized metadata or lost canonical bytes | Workers logs, R2 metrics, cleanup report |
| Outbound submission | 99.5% provider-accepted excluding validation/user errors | provider/transient rate over 0.5% | duplicate submission, BCC leak, or sustained provider failure | Workers logs and Resend dashboard |
| Webhook reconciliation | 99.9% valid events reconciled within 5 minutes | lag over 2 minutes or duplicates rising | terminal-state regression, invalid signature accepted, or lag over 5 minutes | Workers logs, D1 delivery timeline, Resend dashboard |
| Cleanup backlog | oldest retryable under 1 hour; no unexplained manual review | oldest over 15 minutes or backlog rising 3 samples | oldest over 1 hour, unsafe key, lost claim, or unbounded growth | maintenance report and D1 counts |
| Attachment integrity | zero bytes served after missing/size/hash failure | legacy size-only backlog not decreasing | any corrupt response, cross-owner access, or new checksum omission | integrity events, repair report, R2/D1 evidence |
| FTS consistency | zero missing and zero orphan projections | non-zero transient count during controlled rebuild | any unexplained non-zero count after verify/rebuild | search verify JSON and D1 counts |
| Login rejection | all invalid attempts generic, rate limiting effective | rejection/limit anomaly | user enumeration, bypass, or D1-unavailable fail-open | Workers logs and auth tests |
| D1/R2 latency | Preview baseline plus 50% warning margin | p95 exceeds approved margin | timeouts/resource outcomes or repeated p95 over release budget | Cloudflare dashboard and Workers traces |

Percentages need enough volume to be meaningful. During a low-volume release
window, one security, ownership, integrity, duplicate-send, or data-loss event
is a blocker even if a percentage target appears satisfied.

## Required structured events

Keep or add PII-free events for these outcomes:

- health/config/schema readiness and authenticated API failures;
- inbound raw read, MIME parse, R2 persist, D1 persist, controlled rejection,
  rollback failure, duplicate, and claim contention;
- outbound preparation/provider result and webhook verification/reconciliation;
- attachment object missing, size mismatch, checksum mismatch, and legacy
  size-only access;
- `cleanup_claimed`, `cleanup_completed`, `cleanup_retry_scheduled`,
  `cleanup_manual_review`, and `cleanup_backlog_summary`;
- search expected/projected/missing/orphan summary;
- login rejection/rate limit category without login identity.

Never make a healthy status indicator depend solely on delivery metrics. The UI
must degrade when the runtime, D1, R2, schema, authentication, or API is
unavailable and expose a screen-reader-readable state.

## Evidence sources

- Workers Logs/Traces: request/invocation status, `cpuTime`, wall time, startup,
  phase duration, controlled application outcomes, exceeded CPU/memory.
- Cloudflare dashboard: invocation outcome, plan limits, D1 query/latency and
  storage, R2 operations/errors, Email Routing delivery, Worker versions.
- Resend dashboard: provider acceptance/delivery, domain state, webhook
  delivery/retry, bounce/complaint/suppression. Do not copy provider bodies.
- External uptime probe: public `/api/health` from outside Cloudflare. It cannot
  replace authenticated mailbox, inbound, outbound, or integrity probes.
- Operator reports: release preflight, search verify, cleanup backlog,
  attachment repair, deterministic fixture hashes, and exact-SHA CI.

## Preview measurement record

For every scenario, record:

| Field | Value |
| --- | --- |
| Commit SHA | |
| Preview Worker | |
| UTC timestamp | |
| Cloudflare plan | |
| Compatibility date | |
| Fixture name and SHA-256 | |
| Fixture/request bytes | |
| Correlation ID | |
| Invocation outcome | |
| `cpuTime` / wall time / startup time | |
| Memory or exceeded-memory outcome | |
| Subrequest / D1 / R2 operation counts | |
| Parser / upload / download / send-preparation phase | |
| Result and notes | |

The local runtime measurement command may report local parser wall duration,
process RSS/heap/external deltas, fixture bytes, phase, and correlation ID.
Label it `local_harness`; never
copy those values into the Workers `cpuTime`, isolate-memory, subrequest, D1,
or R2 fields.

## Release decision

- Pass: all exact-SHA CI gates pass; Preview has no blocker; proposed warning
  thresholds are understood; integrity/search/cleanup reports are clean or
  explicitly accepted with bounded remediation; rollback evidence exists.
- Warn: a proposed latency/backlog threshold is exceeded without correctness or
  security impact. Document owner, deadline, and approved risk before release.
- Block: any secret/PII exposure, ownership failure, corrupt attachment served,
  data loss, duplicate send, fail-open auth/config/schema, unsafe cleanup key,
  unexplained search drift, Workers resource failure at the approved limits,
  failed exact-SHA CI, missing rollback, or unverified required manual gate.
