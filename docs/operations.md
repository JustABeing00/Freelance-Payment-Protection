# Operations runbook — FreelancePaymentProtection

> For the solo founder, week to week. What to watch, what to run, what to
> back up, and when to act. No internals required.

## 1. Health checks

- **Liveness/readiness:** `GET /health` → `{status:"ok", db:"up"|"down"}`.
  `db:"down"` means the app serves but Postgres is unreachable — treat as
  an incident (see `docs/incident-response.md`). The response also carries
  `dbLatencyMs` when the DB is up; a sustained jump (e.g. >500ms p95) means
  investigate the database, not the app.
- **Uptime monitor:** ping `/health` every 1–5 min from an external monitor
  (UptimeRobot, BetterStack, etc.) and alert on non-200 or `db:"down"`.

## 2. Logging & monitoring

- Logs are **Pino JSON** on stdout — collect them with your host's log
  driver. Secrets (passwords, tokens, cookies, `*_SECRET`, `DATABASE_URL`,
  API keys) are redacted to `[REDACTED]` at the logger and at Fastify
  request logging.
- Every error response is `{error:{code,message,details?,requestId}}`.
  In production, 500s hide internals; use `requestId` to correlate a client
  report with your logs.
- There is **no error-reporting vendor** yet. Baseline monitoring =
  uptime monitor + log search for `"level":50` (errors) + weekly glance at
  `GET .../payments/diagnostics` per active project (surfaces `failed`,
  `disputed`, `needs_review` states). Add Sentry (or equivalent) when error
  volume exceeds eyeballing — hook it in `src/lib/errors.ts`
  `registerErrorHandler` (the single unhandled-error choke point).
- Backups of logs: keep 30 days (or your provider default).

## 3. Scheduled ticks (you must cron these)

The app has **no built-in cron**. These endpoints do the automatic work —
call them on a schedule with a freelancer session token (or a service
token with workspace membership):

| Job | Endpoint | Suggested cadence |
| --- | -------- | ----------------- |
| Send due reminders | `POST .../projects/:pid/reminders/run-due` | every 15–60 min |
| Dispatch notification outbox | `POST .../projects/:pid/notifications/dispatch-due` | every 5–15 min |
| Daily overdue check | `POST .../projects/:pid/notifications/check-overdue` | daily |
| Payment-plan due scan | `POST .../payment-plans/:planId/run-due` | daily per active plan |

Notes:

- Manual-only escalation steps are **never** auto-sent (the tick skips them
  as `skippedManual`) — they need an explicit send with jurisdiction.
- Paid milestones auto-cancel stale reminders (paid-stop). Disputed
  milestones pause overdue mail.
- Example (cron + curl):
  ```bash
  curl -X POST -H "Authorization: Bearer $FPP_TOKEN" \
    "$APP_BASE_URL/api/v1/workspaces/$WID/projects/$PID/reminders/run-due"
  ```

## 4. Backups & restore

- **Database:** nightly `pg_dump` (custom format) + retain 30 days, test a
  restore quarterly. Example:
  ```bash
  pg_dump -Fc "$DATABASE_URL" -f "fpp-$(date +%F).dump"
  # restore to a scratch DB first:
  pg_restore -d "$SCRATCH_URL" "fpp-2026-01-01.dump"
  ```
- **What matters most:** the `events`, `payments`, `approvals`,
  `agreements`, and `evidence_packs` tables are append-only (DB triggers
  reject UPDATE/DELETE). A backup preserves the evidence trail; never
  "fix" production by editing rows — record a new event/row instead.
- **Object storage (once wired):** enable bucket versioning + cross-region
  replication per your provider's docs.
- **Secrets:** store `SESSION_SECRET`, `STRIPE_*`, `DATABASE_URL` in your
  host's secret manager (not in git, not in chat). Rotate per §5.

## 5. Secret rotation

- `SESSION_SECRET`: rotating invalidates **all** sessions (stateless HMAC
  tokens) — users sign in again. Announce, rotate, restart.
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`: rotate in Stripe dashboard
  first, then update env, then restart; verify with a test webhook signature
  check (`400` on bad signature, `200 duplicate:true` on replay).
- `DATABASE_URL` password: rotate in the DB provider, update env, restart,
  confirm `/health` → `db:"up"`.

## 6. Limits & abuse signals (when to tighten)

- Rate limits today: **120 req/min global**, **30 req/min** on
  signup/signin. Client portal and webhook endpoints share the global cap.
- Watch for: signup bursts from one IP (add CAPTCHA), repeated `401`s on
  portal URLs (token probing — revoke the link, issue a fresh one),
  webhook `400` storms (misconfigured or forged — check the Stripe dashboard
  event log). Next steps when abuse appears: CAPTCHA + account lockout on
  auth, server-side session revocation list, per-IP portal-link limits.

## 7. Email / storage / provider status

- Until real providers are wired, the app uses Noop seams in production:
  mail rows stay `queued`, storage URLs are `noop://` placeholders, and
  checkout/refund fail closed with `502`. This is **safe but not useful** —
  the deployment checklist (`docs/deployment.md` §5) tells you what to wire.
- After wiring Stripe: reconcile weekly via
  `POST .../payments/reconciliation/run` per active project and confirm the
  report is `balanced`. Investigate any `needs_review` / `out_of_order`
  entries before releasing finals.

## 8. Performance & data notes (audited, no action needed at solo scale)

- **Pagination:** timeline (`limit≤200` + `cursor`) and notification inbox
  (`limit≤200`) are bounded; event reads are capped (30 portal / 500
  freelancer). Workspace list endpoints (clients/projects/milestones) are
  unbounded but workspace-scoped — fine for solo-founder volumes; add cursor
  pagination if any workspace exceeds ~1k rows per table.
- **Indexes:** every business table is indexed on `(workspaceId)` and the
  hot scopes (`(workspaceId, projectId)`, `(workspaceId, milestoneId)`,
  payment idempotency/provider uniques, event idempotency unique,
  `notification (state, scheduledFor)`). No full-table scans on hot paths.
- **Query efficiency:** detail pages and portal overviews fan out with
  `Promise.all` (no N+1); money math is integer-cents in the app, not in
  SQL; no per-request aggregations beyond one workspace scope.
- **Caching:** static assets (`/app/styles.css`, `/app/app.js`,
  `/portal/app.js`) carry `Cache-Control: public, max-age=300`. All HTML
  and API responses are per-user and intentionally **not** cached. No
  Redis/memcached needed at this scale.
- **Frontend:** server-rendered HTML + one tiny deferred script per surface
  (no framework, no tracking); CSS/JS are inline-served single files.

## 9. Weekly checklist (15 min)

- [ ] `/health` → `db:"up"`; uptime monitor green.
- [ ] Error-log scan (`level:50`) — any new `requestId` clusters?
- [ ] Backups ran (check timestamp + size).
- [ ] Active projects: `diagnostics` balanced? Any `needs_review`?
- [ ] Scheduler (cron) ran the ticks — any `failed_retry_scheduled` rows?
- [ ] Dependency audit monthly: `npm audit` + `npm outdated`.
