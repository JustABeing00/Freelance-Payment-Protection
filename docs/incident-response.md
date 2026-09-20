# Incident response — FreelancePaymentProtection

> Stay calm. Money state is append-only and provider-verified, so almost
> everything is recoverable. **Rule 0: never hand-edit production rows.**
> Record corrections as new events/rows — history is the product.

## 1. Severity levels

| Level | Meaning | Response |
| ----- | ------- | -------- |
| SEV-1 | Money wrong or data at risk (wrong paid state, suspected breach, DB down) | Act now, then write up |
| SEV-2 | Degraded (mail/provider down, scheduler stuck, elevated errors) | Act today |
| SEV-3 | Cosmetic / single-user confusion | Normal support flow |

## 2. First 5 minutes (every incident)

1. Check `GET /health` — note `db:"up"|"down"` + `dbLatencyMs`.
2. Pull recent error logs; collect `requestId`s from affected users.
3. Determine severity (table above) and scope (one project? all? money?).
4. For SEV-1: pause risky actions (tell the freelancer not to release
   finals until the money state is confirmed).
5. Preserve evidence: export the project's evidence pack
   (`POST .../evidence-packs`) **before** changing anything.

## 3. Runbooks

### A. Database unreachable (`db:"down"`)

- The API still serves; reads/writes needing Postgres fail. Do not restart
  blindly — check the DB provider status first.
- Verify connectivity (`pg_isready` / provider dashboard), then restart the
  app only if the DB is healthy and `/health` still says down.
- After recovery: confirm `/health` → `db:"up"`, run one signup→project
  smoke test, check the scheduler backlog (re-run the ticks in
  `docs/operations.md` §3 — they are idempotent).

### B. Payment shows paid but client didn't pay (or vice versa)

- Source of truth: **verified provider receipts**, never claims or success
  pages. Open `GET .../payments/reconciliation` + `.../payments/history`
  for the project.
- `claimed_unverified` ≠ paid (by design). A success-page visit never marks
  paid (by design). If a webhook arrived with a wrong amount/currency, it is
  recorded as `needs_review` + `PaymentAmountMismatched` and the milestone
  stays unpaid — resolve via a new verified receipt, then
  `POST .../payments/reconciliation/run` to converge.
- Out-of-order reversal (refund/dispute before confirmation) keeps local
  state with a note — the reconciliation run converges it. Do not edit the
  payment row.

### C. Webhook failures / replays

- `400` on bad signature: expected for forgeries; cross-check the Stripe
  dashboard event log. `502` missing secret: set `STRIPE_WEBHOOK_SECRET`.
- Replays return `200 {duplicate:true}` and change nothing (persistent
  `WebhookReceived` markers + idempotency uniques). Duplicate delivery is
  safe — do not "clean up" duplicate rows; there are none.
- If Stripe reports undelivered events, replay them from the dashboard —
  idempotency makes this safe.

### D. Client dispute / chargeback (`paid → disputed`)

- Do not release finals (`disputed` blocks release; diagnostics flag
  `dispute_open`). Tell the freelancer: pause work via
  `POST .../projects/:pid/pause`, offer a payment plan if appropriate, and
  generate an evidence pack for records/mediation.
- Copy must stay system-voiced and factual — no threats, no client labels
  (the app's templates already enforce this).

### E. Suspected breach / leaked token or secret

1. Portal magic link suspected: `POST .../portal-links/:linkId/revoke` and
   issue a fresh link. Links are single-project, expiring, hash-stored —
   revocation is instant.
2. Session suspected: rotate `SESSION_SECRET` (invalidates all sessions;
   users sign in again) — see `docs/operations.md` §5.
3. Stripe key suspected: rotate in Stripe dashboard, update env, restart,
   verify webhook signature checks.
4. Database credential suspected: rotate at the provider, update
   `DATABASE_URL`, restart, confirm `db:"up"`.
5. Write down what happened (timestamps, scope) before notifying affected
   users — factual, no speculation.

### F. Email or storage outage

- Email down: reminder/notification rows stay `queued`/`failed` with
  `attemptCount`/`lastError`; retry via `POST .../notifications/:id/retry`
  after the provider recovers. Nothing is lost — the outbox pattern holds
  the work.
- Storage down: previews/finals fail to mint URLs but no state changes;
  retry after recovery. Finals stay gated (423 LOCKED) until release
  regardless.

### G. Scheduler stuck (reminders/notifications not going out)

- Check the cron host ran the ticks; re-run them manually (idempotent —
  repeats return `duplicate`, never resend).
- Manual-only escalation steps pending is **normal** — they require an
  explicit send with jurisdiction, never auto-send.

## 4. What NEVER to do

- Never UPDATE/DELETE rows in `events`, `payments`, `approvals`,
  `agreements`, or `evidence_packs` (triggers reject it anyway) — resolve
  via new events (`reconcile`, `mark-paid` with verified receipts, new plan
  versions, new agreement versions).
- Never mark a milestone paid from a claim, a success page, or a
  screenshot — only verified provider receipts count.
- Never paste secrets into tickets, chat, or the repo. Redact before sharing
  logs (`[REDACTED]` is automatic for known fields — double-check the rest).

## 5. Post-incident (within 48h, one page)

- What happened (timeline, scope, severity) · What fixed it · Money impact
  (reconciliation `balanced`? before/after totals) · What prevents repeat
  (config, monitor, doc change) · Follow-ups with owners.
- Append a line to `progress.md` (Known Issues / Last Session) so the next
  session inherits the lesson.
