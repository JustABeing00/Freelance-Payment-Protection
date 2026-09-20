# FreelancePaymentProtection

Payment-protection workflow for freelancers: milestones framed as progress (never
"Deposit"), version-pinned approvals, provider-verified payments, rule-based release,
neutral reminders, and an append-only evidence timeline.

> Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.
> No escrow, no guaranteed-payment promises (see `docs/product-requirements.md` §12).

## Stack (chosen Session 02 — rationale in `progress.md`)

| Concern        | Choice                               | Why (boring technology)                                  |
| -------------- | ------------------------------------ | -------------------------------------------------------- |
| API            | Fastify 5 + TypeScript (strict)      | typed routes, built-in logging hooks, `inject()` tests   |
| DB             | Postgres 16 + Prisma 6               | append-only events, idempotency uniques, money integrity |
| Validation     | Zod                                  | one schema style for env, HTTP, webhooks, domain         |
| Logging        | Pino (JSON)                          | Fastify-native, redaction for secrets                    |
| Tests          | Vitest                               | fast TS-native unit + HTTP integration                   |
| Headers/limits | @fastify/helmet, @fastify/rate-limit | CSP/HSTS/nosniff + abuse caps                            |

Frontend (Next.js or similar) arrives in a later session and consumes this API.
No UI screens are built in the foundation.

## Launch site (Session 24)

Public pages: `/` (marketing homepage; JSON for API clients via content
negotiation), `/pricing`, `/faq`, `/privacy`, `/terms`, `/contact`,
`/onboarding` (public guide) + `/app/onboarding?workspaceId=…` (live
checklist). Feedback: `POST /api/v1/feedback
{message, name?, email?, page?, category?}` → `201` receipt. Copy makes no
payment, enforcement, or anti-misuse promises.

## Quickstart

```bash
cp .env.example .env        # then fill SESSION_SECRET (openssl rand -hex 32)
docker compose up -d db     # local Postgres 16
npm install
npx prisma migrate dev      # applies prisma/migrations/0001_foundation
npm run dev                 # http://localhost:3000 (GET /health)
```

## Commands

| Command                                            | Purpose                                    |
| -------------------------------------------------- | ------------------------------------------ |
| `npm run dev`                                      | watch-mode API (`tsx watch src/server.ts`) |
| `npm run build` / `npm start`                      | compile to `dist/` / run compiled server   |
| `npm test`                                         | Vitest unit + integration suite            |
| `npm run typecheck`                                | `tsc --noEmit` (strict)                    |
| `npm run lint`                                     | ESLint (typed rules, zero warnings)        |
| `npm run format`                                   | Prettier check                             |
| `npm run checks`                                   | typecheck + lint + format + test           |
| `npx prisma validate` / `generate` / `migrate dev` | schema checks, client gen, migrations      |

## Architecture (foundation)

```
src/
  server.ts            # fail-closed boot (env → app → listen)
  config/env.ts        # zod env schema, throws on missing/invalid
  config/app.ts        # helmet, rate-limit, error envelope, routes
  routes/health.ts     # /health, /api/v1/disclaimer (+ / root)
  routes/auth.ts       # signup/signin/signout, GET+PATCH /me (session cookie + Bearer)
  routes/workspaces.ts # workspace CRUD + owner-only member invites
  routes/resources.ts  # tenant clients + projects (server-side IDOR guards)
  routes/agreements.ts # payment-terms drafts → send → accept (immutable versions)
  routes/deliverables.ts # controlled delivery: versions → preview → approve → paid → release (+ portal)
  routes/evidencePacks.ts # factual evidence-pack exports: generate/list/detail + printable HTML
   routes/protection.ts # project protection checks: observable conditions, evidence-cited, no scores
   routes/aiAssist.ts # AI-assisted drafts: extractive terms/messages/reminders/summary/consistency, review-required
  routes/requestAuth.ts # requireAuth: identity always from verified session
  db/prisma.ts         # Prisma singleton + checkDatabase()
   domain/              # pure, DB-free business rules (the moat)
     types.ts           # branded ids, 3-dimension states, event vocabulary
     agreement.ts       # payment-terms validation, lifecycle, sha256 fingerprints
    money.ts           # integer-cents math, paid/outstanding/overdue
    events.ts          # reduce(events) → {work,payment,delivery}
      release.ts         # canRelease() + version-pinned approval
      deliverables.ts    # controlled-delivery states, review-vs-final, staging, release gates
      evidencePack.ts    # factual snapshot builder, stable hash, printable export
    trust.ts           # trust-ladder defaults/transitions
  lib/
    errors.ts          # AppError + stable {error:{code,message,requestId}}
    logger.ts          # pino + secret redaction + scoped child loggers
    validate.ts        # zod boundary helper
    tenant.ts          # assertSameWorkspace / tenantScope (403, no oracle leak)
    session.ts         # HMAC session tokens: Bearer + HttpOnly cookie, 7d TTL
    authz.ts           # membership/role/IDOR gates (owner>member>accountant_readonly)
    store.ts           # Store seam: InMemoryStore (tests/dev) + PrismaStore (prod)
    magicLink.ts       # HMAC magic links: scope+expiry+rotation, sha256 store
    webhook.ts         # Stripe-style verify + IdempotencyStore
    auth.ts            # scrypt hashing, telemetry hashing
    providers.ts       # Payment/Storage/Email seams + Noop/Fake impls
    artifacts.ts       # safe file/link/version validation, UUID keys, TTL clamps
prisma/
  schema.prisma        # User→Workspace→Client→Project→Milestone→…→Event
  migrations/0001_foundation/migration.sql  # DDL + append-only triggers
tests/
  unit/                # money, events, release, tenant, magicLink, webhook, foundation, session
  integration/         # HTTP: health/headers/envelope/disclaimer + auth/ownership/IDOR/roles
```

### Invariants enforced (with tests)

- Historical payments/events/approvals/agreements/evidence are append-only
  (Postgres triggers reject UPDATE/DELETE; corrections = new rows).
- Client payment claims never mark paid — only verified provider webhooks do.
- Approval is pinned to a deliverable version; old approval ≠ new version release.
- Tenant isolation: every row carries `workspace_id`; mismatches → generic 403.
- Amounts are integer minor units; timestamps UTC; UUIDs in URLs.
- Final files stay private until `canRelease()` passes or a flagged manual override
  with reason is recorded.

## Environment

Required: `DATABASE_URL`, `SESSION_SECRET` (32+ chars), `APP_BASE_URL`.
Optional: `STRIPE_*`, `STORAGE_*`, `EMAIL_*`, `MAGIC_LINK_TTL_HOURS`, `PORT`, `LOG_LEVEL`.
Boot is fail-closed: invalid env throws before listen. See `.env.example`
(placeholders only — never commit secrets).

## Health

- `GET /health` → `{ status:"ok", version, uptimeSeconds, db:"up"|"down" }`.
  Unauthenticated, no internals leaked. `db:"down"` means the API serves but the
  database is unreachable (distinguishes liveness from readiness).
- `GET /api/v1/disclaimer` → legal-boundary copy (also on `/` and evidence exports later).

## Identity & ownership (Session 03)

- `POST /api/v1/auth/signup {email, displayName, password≥12, workspaceName?}`
  → creates user + default workspace (owner) + session (`token` + HttpOnly cookie).
- `POST /api/v1/auth/signin` → generic `401 Invalid credentials` for unknown
  email and wrong password alike (no enumeration oracle). Stricter per-route
  rate limit on signup/signin.
- `POST /api/v1/auth/signout` (auth) → clears cookie; sessions are stateless
  HMAC tokens (`s1.{userId}.{iat}.{exp}.{nonce}.{sig}`, 7-day TTL).
- `GET /api/v1/me`, `PATCH /api/v1/me` → account settings; password rotation
  requires `currentPassword`.
- Workspaces: `POST/GET /api/v1/workspaces`, `GET /api/v1/workspaces/:id`,
  `GET` + owner-only `POST /api/v1/workspaces/:id/members {email, role}`.
  Roles: `owner` (full) > `member` (write, no member mgmt) >
  `accountant_readonly` (read-only).
- Tenant resources (all membership + role + IDOR checked server-side):
  `POST/GET /api/v1/workspaces/:wid/clients`, `GET .../clients/:cid`,
  `POST/GET /api/v1/workspaces/:wid/projects`, `GET .../projects/:pid`.
  Swapping an ID from another workspace yields generic `403`, never the row.

## Clients & projects (Session 04)

- Clients: `name, email, company?, phone?, billingEmail?, billingAddress?,
timezone?, country (ISO-2)?, notes?, status (active|inactive|archived)`.
  `POST/GET .../clients?search=&status=`, `GET .../clients/:cid`
  (includes its projects + count), `PATCH .../clients/:cid`.
- Projects: `client, title, description?, currency (ISO-3), totalValueCents
(integer), startDate?, expectedCompletion? (must be ≥ start), paymentTerms?,
status (draft|active|on_hold|completed|cancelled)`.
  `POST/GET .../projects?search=&status=&clientId=`, `GET/PATCH
.../projects/:pid`, `GET .../projects/:pid/summary`.
- Summary (command center, no payments created here): `totalValueCents,
amountPaidCents` (verified `received`/`partial` only — claims never count),
  `outstandingCents, progressPercent, projectStatus, paymentStatus
(unpaid|partial|paid|overdue|disputed), currentMilestone, nextAction,
milestoneCount, paidMilestoneCount, recentActivity[8]`.
- Pages (same session + ownership checks, calm server-rendered HTML):
  `/app/projects`, `/app/projects/:pid` (command center: value / paid /
  outstanding, current milestone, next action, statuses, recent activity),
  `/app/clients`, `/app/clients/:cid`, plus `/app/styles.css` + `/app/app.js`
  (create/edit forms POST/PATCH as JSON, CSP-safe, no inline script/style).

## Milestones (Session 05)

- Model: five explicit dimensions, no booleans — `work
(draft|in_progress|submitted|viewed|revision_requested|approved|disputed)`,
  `payment
(unpaid|payment_pending|funded|paid|overdue|claimed_unverified|plan_active|refunded|disputed)`,
  `approval (none|pending|approved|revision_requested|rejected, version-pinned)`,
  `deliverable (locked|preview_shared|unlocked_ready|released)`,
  `unlock (locked|available|unlocked, derived from siblings)`.
  Full table + guards in `docs/milestone-workflow.md`; source of truth is
  `src/domain/milestone.ts` (`ALLOWED_TRANSITIONS`).
- Canonical set: Discovery $500 → Design $1,000 → Development $1,500 →
  Launch $1,000 (one currency, contiguous `orderIndex`, `"Deposit"` titles
  rejected). Configurable workflows: `DEFAULT` (funding-first, sequential
  `previous_paid`), `FLEXIBLE` (parallel), `STRICT`.
- Routes (same membership + write-role + IDOR gates):
  `POST/GET .../projects/:pid/milestones`,
  `GET/PATCH .../milestones/:mid` (descriptive fields freeze after funding;
  version linkage stays editable), `POST .../milestones/:mid/amount`
  (audited changes only after funding: `reason ≥ 8 chars`),
  `POST .../milestones/:mid/transitions {action, paymentId?, …}`
  (17 guarded actions; repeats of a `paymentId` → `409`; illegal moves → `422`),
  `POST .../milestones/reorder {order[], reason?}` (frozen after funding
  without audit). Every transition appends an event row (payment actions carry
  `${milestoneId}:${paymentId}` idempotency keys).

## Agreements (Session 06)

- Terms (11 sections, `docs/agreement-terms.md`): total amount, deposit =
  first milestone, milestone schedule (sums to total, `"Deposit"` titles
  rejected), payment deadline + grace days, accepted methods, late-payment,
  work-pause, final-delivery gate, ownership mode, revision limits,
  cancellation terms + optional custom clauses.
- Not a law firm: every response and every rendered draft carries the
  jurisdiction-dependent-enforceability disclaimer (`disclaimerVersion: v1`).
- Versions are content-immutable: `POST .../projects/:pid/agreements`
  (auto-incremented draft), `POST .../agreements/:aid/send`
  (`draft → pending_acceptance`), `POST .../agreements/:aid/accept
{acceptedBy}` (pins `{hash, version, acceptedBy, acceptedAt}` + hashed
  IP/UA refs; supersedes older accepted versions),
  `POST .../agreements/:aid/void` (drafts/sent only). No PATCH — corrections
  are new versions. Detail includes the `auditTrail`
  (`AgreementCreated/Sent/Accepted/Superseded/Voided`). The DB guard trigger
  rejects content UPDATEs/DELETEs so accepted history stays reconstructable
  for the evidence system.

## Client portal (Session 07)

- Freelancer (session auth): `POST .../projects/:pid/portal-links`
  (issues a single-project `v1.{project}.{exp}.{nonce}.{sig}` magic link;
  raw token returned once, sha256 stored; `GET .../portal-links` lists
  without hashes; `POST .../portal-links/:lid/revoke`). Every issuance /
  revocation appends a project event.
- Client (magic-link auth, no session): `GET /api/v1/portal/:pid/overview?token=…`
  answers what am I buying / cost / paid / due / delivered / needs approval /
  next / locked-why (verified receipts only; notes + billing contacts never
  leave the server) and `GET /portal/:pid?token=…` renders the same view as
  calm HTML (`/portal/app.js` handles approve / revision / pay / accept).
- Actions are project-scoped and guarded: `POST .../portal/:pid/approve`,
  `.../request-revision {note}`, `.../pay` (intent only — records
  `PaymentRequested`, never marks paid), `.../agreements/:aid/accept
{acceptedBy}` (hash re-verified, supersedes older accepted versions).
  Foreign `milestoneId`/`agreementId` → generic 404; bad/expired/revoked
  links → generic 401. Language stays professional ("ready for review").

## Payments (Session 08 — Stripe behind a seam, no escrow, no card storage)

- Provider: `PaymentProvider` seam (`StripePaymentProvider` when
  `STRIPE_SECRET_KEY` is set, `FakePaymentProvider` in tests,
  `NoopPaymentProvider` otherwise). Cards are entered on hosted checkout
  only — raw card data never touches this API.
- Lifecycle (pure `src/domain/payments.ts`):
  `created → pending → processing → paid`, plus `failed | cancelled`, and
  `paid → refunded | disputed` (`received`/`partial` kept as legacy verified
  aliases). Every transition maps to an auditable `Payment*` event.
- Freelancer (session + write-role + IDOR):
  `POST .../milestones/:mid/checkout {amountCents?, currency?,
idempotencyKey?, successUrl?, cancelUrl?}` (idempotent; validates
  amount ≤ outstanding + currency match; returns `checkoutUrl`),
  `GET .../projects/:pid/payments` (ledger + `verifiedPaidCents /
outstandingCents / byState` summary),
  `GET .../payments/:pid` (detail + `auditTrail`),
  `POST .../payments/:pid/refund` (verified-paid only, via provider),
  `POST .../payments/:pid/cancel` (pending only),
  `POST .../payments/:pid/reconcile` (verified server-to-server read-back;
  drifts never silently overwrite `paid`).
- Client (magic link): `POST .../portal/:pid/pay` now returns a hosted
  `checkoutUrl` + `paymentId` but stays intent-only (never marks paid);
  `GET .../portal/:pid/payments/:paymentId/status?token=…` polls verified
  state; `GET /portal/:pid/success?token=…&paymentId=…` is a READ-ONLY
  receipt page that explicitly states it proves nothing.
- Webhook (public, signature is the credential):
  `POST /api/v1/webhooks/payments` verifies the Stripe-style `t,v1` HMAC
  (fail-closed `502` without a secret), ignores unknown event types,
  dedupes by provider event id (`webhook:stripe:<id>:<state>` UNIQUE — replay
  → `200 {duplicate:true}`), validates amount/currency exactly (mismatch →
  `200 {needsReview:true}` + `PaymentAmountMismatched`, never paid), and only
  then transitions state + appends the auditable event + projects the
  milestone (`paid` needs verified coverage; release still needs approval).
- DB: `prisma/migrations/0006_payment_lifecycle` expands `PaymentState`
  (`created/processing/paid/cancelled` + legacy aliases) and replaces the
  blanket no-update trigger with `guard_payment_immutability()` (money /
  provider linkage write-once; `state/received_at/raw_webhook_ref` advance;
  DELETEs rejected).

## Payment trust (Session 09 — reconciliation, no history rewrites)

- Reconciliation (pure `src/domain/reconciliation.ts`, recomputed on every
  call): compares internal rows vs provider-verified receipts vs
  milestone invoices vs the project total. Reports `totals`,
  `perMilestone` coverage, `mismatches` (`overpaid_milestone/project`,
  `orphan_payment`, `currency_mismatch`, `missing_provider_linkage`,
  `unapplied_verified`, `duplicate_applied_payment`,
  `milestone_total_mismatch`, `partial_uncovered`, `claimed_without_payment`,
  `initiated_without_confirmation`, `failed_payment`, `dispute_open`,
  `refunded_payment`, `needs_review`, `out_of_order`), plus `balanced`
  (true when no error remains).
- Verification tiers on every payment: `claimed` (client assertion, never
  counts) / `initiated` (checkout exists, no money moved) /
  `provider_confirmed` (verified receipt — the only tier that counts) /
  `settled` (funds-settled leg where a provider exposes it; Stripe card
  captures settle on confirmation, documented per row) / `failed` /
  `reversed`. No tier is ever conflated in totals or copy.
- Freelancer: `GET .../payments/reconciliation` (full report + tiered ledger
  - history), `GET .../payments/history` (plain-language timeline: claims
    always read "NOT verified"), `GET .../payments/diagnostics`
    (`balanced`, `errors / warnings / info`, per-milestone status),
    `POST .../payments/reconciliation/run` (project-wide provider read-back;
    converges drift and late confirmations; illegal jumps recorded, never
    forced), `POST .../milestones/:mid/claim` (records "client says paid" as
    `claimed_unverified` + `PaymentClaimed`, never paid).
- Client: `POST .../portal/:pid/claim {token, milestoneId, note?}` files an
  "I've paid" note — recorded, totals unchanged until the provider confirms.
- Webhooks now persist delivery markers (`WebhookReceived`,
  `webhook:stripe:<eventId>` UNIQUE) so replay stays a no-op across
  restarts; reversals that arrive before their confirmation keep local state
  with an out-of-order note for the reconciliation run to converge. Failed
  / cancelled attempts read "no money moved, safe to retry"; disputes read
  "do not release finals until this clears". Financial history is
  append-only — resolving a mismatch always means a new event, never an
  edit.

## Deliverables (Session 10 — controlled delivery, review ≠ own)

- Model: a freelancer submits **files + links + previews + descriptions**
  as numbered **versions** of a per-milestone deliverable. Lifecycle
  (pure `src/domain/deliverables.ts`):
  `draft → submitted → preview_available → client_review → approved →
payment_pending → paid → released`.
- The conceptual core is a separation the API enforces everywhere:
  **CLIENT CAN REVIEW** (watermarked/low-resolution previews, staging URLs,
  restricted downloads — available early) vs **CLIENT OWNS/RECEIVES FINAL
  ASSET** (source files, production credentials, final archives — only when
  `released`). No technical DRM is promised: every preview response carries
  the honest notice that a browser cannot prevent screenshots or copying;
  previews are a speed bump, not a lock.
- Safe file handling (`src/lib/artifacts.ts` + `StorageProvider` seam with
  `FakeStorageProvider` in tests): server-minted UUID object keys (never
  user paths), allowlisted content types, 100 MB / 10-files-per-version /
  20-links caps, `https://`-only URLs, 64-hex `sha256` checks, and at least
  one content item per version.
- Downloads are signed, expiring, and access-checked: previews (≤1 h TTL)
  once reviewable; finals (≤15 min TTL) only after release — otherwise
  `423 LOCKED` with a plain-language lock reason. Release needs
  version-pinned client approval **and** verified provider payment (claims
  never count), except a flagged manual override with a ≥8-char reason that
  is recorded in the evidence timeline.
- Web projects: a `stagingUrl` can go `staging_live` for early review while
  production handoff stays a separate transfer state
  (`none → staging_live → transfer_pending → transferred`) that requires
  release first.
- Freelancer (session + write-role + IDOR):
  `POST .../milestones/:mid/deliverables`,
  `POST .../deliverables/:did/versions`,
  `.../submit`, `.../share-preview`, `.../mark-review`,
  `.../mark-payment-pending`, `.../mark-paid` (verified only),
  `.../release` (gated), `.../staging` + `.../staging/transfer-request` +
  `.../staging/transfer-complete`,
  `GET .../files/preview` / `GET .../files/final` (final → 423 pre-release).
- Client (magic link): `GET .../portal/:pid/deliverables` (review-safe
  projection — final object keys never leak pre-release),
  `GET .../deliverables/:did/preview` (signed review URL),
  `GET .../deliverables/:did/final` (423 until released),
  `POST .../deliverables/:did/approve {versionNo}` (pins current version).
- DB: `prisma/migrations/0007_deliverables` adds the lifecycle, staging,
  and mixed-payload columns (status CHECK, staging CHECK, optional
  preview/final refs).

## Approvals (Session 11 — formal client approval, not a boolean)

- Model: a client decision is an **append-only event pinned to ONE version**
  (pure `src/domain/approvals.ts`): who (`approverRef` portal identity +
  actor), what (milestone + deliverable), which version (`versionNo` for
  deliverables, `versionRef` for milestone-only approvals), when (UTC
  timestamp), the decision
  (`approved | revision_requested | rejected | disputed`), and an optional /
  required note (revision / rejection / dispute need ≥3 chars so the
  freelancer always knows what to change). Device metadata is hashed
  (`ipHash`/`uaHash`, sha256) — raw IPs and user-agents are never stored.
- Stale approvals are impossible by construction: uploading a new version
  after approval moves the deliverable back to `submitted` (milestone
  version changes reset `approvalState` to `pending`) while the old
  `Approval` row stays historically true for its version. Only the latest
  decision pinning the CURRENT version authorizes release
  (`deriveApprovalEffect()`); `checkRelease()` additionally needs verified
  payment. Approvals are immutable in Postgres (existing
  `no_update_approvals` trigger) plus version-pin and decision CHECKs in
  `prisma/migrations/0008_formal_approvals`.
- Freelancer (session + IDOR):
  `GET .../deliverables/:did/approvals` and
  `GET .../milestones/:mid/approvals` (full trail + `effective`
  `{isCurrent, isApproved, reason}` — never ambiguous).
- Client (magic link, project-scoped 404s, generic 401s): milestone
  `POST .../portal/:pid/approve` (idempotent repeat),
  `.../request-revision {note}`, `.../reject {note}`, `.../dispute {note}`;
  deliverable `POST .../portal/:pid/deliverables/:did/approve {versionNo}`,
  `.../revision`, `.../reject`, `.../dispute` (each `{versionNo, note}`),
  plus review-safe `GET .../deliverables/:did/approvals`. Every decision
  writes an `Approval` row and a timeline event (`MilestoneApproved` /
  `RevisionRequested` / `ApprovalRejected` / `DisputeFlagged`) carrying
  `{decision, approvalId, approverRef, version}`.

## Reminders (Session 12 — configurable engine, never a universal schedule)

- Model: no hard-coded cadence. Every milestone resolves an explicit
  **configurable policy** (pure `src/domain/reminders.ts`): per-project
  override → workspace defaults → built-in default (T-3 friendly, T+0 due,
  T+3 first overdue, T+7 firmer, T+14 escalation, T+21 work-paused/manual).
  Freelancers reorder, retime, disable, or replace steps; the engine only
  schedules what the resolved policy says.
- Each automation is **auditable** (`ReminderScheduled/Sent/Delivered/Failed/
Cancelled` project events with notification/step/template/idempotency refs),
  **idempotent** (stable `reminder:{milestone}:{step}:{day}` keys — repeats
  return the existing row as `duplicate`, never a resend), **retry-safe**
  (only `queued`/`failed` rows send; `attemptCount` + `lastError` recorded;
  `502 PROVIDER_ERROR` means "safe to retry"), **cancelable** (`canceledAt`
  stops future sends without deleting history), and **configurable** (workspace
  `PUT .../reminder-policy`, project `PUT .../reminders/policy`, `null` clears
  back to inheritance).
- Every row tracks `scheduled_at`, `sent_at`, delivery `state`, `recipient`,
  `template` + `templateVersion`, rendered subject/snapshot, `result_error`,
  and `next_scheduled_action`. Milestone and project views return a handling
  summary ("The system is handling this — the next reminder is scheduled.")
  so the freelancer never feels they must beg the client again.
- Templates (`GET /api/v1/reminder-templates`, v1) speak as the system
  ("Automated reminder from {workspace}"), never as personal chasing; custom
  templates are validated (no legal threats, no "Deposit" label).
- **No automatic legal threats**: escalation / work-paused steps are
  `requiresManual` — the scheduler tick (`POST .../reminders/run-due`) skips
  them always. They send only manually with `acknowledgeManualStep: true`
  plus a `jurisdiction`, and their language is jurisdiction-aware
  (`JURISDICTION_NOTICE`: informational reminder, not a legal claim).
  Scheduling stops with `422` once the milestone is paid/funded/refunded.
- Freelancer (session + write-role + IDOR): policy GET/PUT (workspace +
  project), `POST .../milestones/:mid/reminders/plan` (dry-run preview),
  `.../schedule` (201, idempotent), milestone/project `GET .../reminders`
  (audit + summary), `POST .../reminders/:rid/send|retry|cancel`.
- DB: `prisma/migrations/0009_reminder_engine` (notification audit columns +
  idempotency unique index, `projects.reminder_policy`).

## Payment plans (Session 13 — humane path for late payers)

- Model: a client who is late may have a genuine cash-flow problem. The
  freelancer proposes a restructured schedule for the outstanding milestone
  balance (pure `src/domain/paymentPlans.ts`): e.g. $2,400 as 4 × $600
  weekly, or $1,000 + $700 + $700. Installments must sum **exactly** to the
  outstanding obligation — no silent forgiveness, no silent surcharge.
- Lifecycle: `offered → active → completed` (plus `accepted`, `defaulted`,
  `superseded`). The client accepts in the magic-link portal (or the
  freelancer records acceptance); the milestone moves to `plan_active`.
  A modified schedule is a **new plan version** that supersedes the old one —
  the original obligation row + its events are never edited.
- Each installment is tracked (`scheduled / paid / missed / canceled`).
  `POST .../payment-plans/:planId/run-due` flags missed rows and sends
  automatic system-voiced reminders (one `Notification` audit row per
  installment per day, idempotent — repeats skip as duplicates). Only
  **verified** provider receipts settle installments
  (`POST .../installments/:seq/mark-paid {paymentId}`); pending/claimed
  payments are refused with `422`. Full settlement completes the plan and
  pays the milestone. `POST .../default {reason≥8}` marks a stalled plan
  defaulted and the milestone overdue.
- Every view shows three numbers side by side: the **original obligation**
  (frozen snapshot), the **agreed modification** (installment schedule), and
  the **current outstanding** (live verified math — plans never reduce what
  is owed until paid), plus a **timeline** of exactly what changed and when
  (`PaymentPlanOffered/Accepted/Modified/InstallmentPaid/InstallmentMissed/
ReminderSent/Completed/Defaulted`).
- Freelancer (session + write-role + IDOR): `POST .../milestones/:mid/
payment-plans` (201; `409` while a plan is live unless `supersedesPlanId`
  names it), milestone `GET .../payment-plans`, `GET .../payment-plans/
:planId`, `POST .../:planId/accept`, `POST .../:planId/installments/:seq/
mark-paid`, `POST .../:planId/run-due {now?}`, `POST .../:planId/default`,
  project `GET .../payment-plans` (full version history).
- Client (magic link): `GET /api/v1/portal/:pid/payment-plans` (+ detail)
  and `POST .../payment-plans/:planId/accept {token}`.
- DB: `prisma/migrations/0010_payment_plans` (`currency`, `version`,
  `supersedesId` self-reference, `note`, `updatedAt`, `PlanState.superseded`,
  `original_amount_cents > 0` CHECK, project index).

## Evidence timeline (Session 14 — "what actually happened?")

- Model: every important project event lives in one chronological,
  append-only trail — project created, agreement created/accepted, milestone
  created, payment requested/received, deliverable uploaded, preview viewed,
  revision requested/submitted, milestone approved, payment overdue, reminder
  sent, payment-plan proposed/accepted, work paused/resumed, final asset
  unlocked. Pure `src/domain/timeline.ts` describes each row
  (category/label/headline/detail); unknown future types stay visible under
  `system` instead of being dropped.
- Immutability: the `events` table is guarded by the `no_update_events`
  trigger + idempotency uniques. The timeline API is **read-only by
  design** — `POST/PUT/PATCH/DELETE` on any timeline URL returns an
  explicit `405 IMMUTABLE_HISTORY`. Corrections arrive as new events
  (new agreement version, new plan version, `ProjectUnpaused`), so a
  freelancer never has to reconstruct three months of emails.
- Freelancer (session + membership + IDOR): `GET .../projects/:pid/timeline`
  (`types`, `category`, `actorType`, `milestoneId`, `from`, `to`, `search`,
  `limit` ≤ 200, `cursor`, `order=asc|desc`; each event carries
  category/label/headline/detail/actor/milestone/occurredAt/metadata plus
  `prevEventId/nextEventId` for chronological walks; response adds
  `summary` counts, `pagination`, and the disclaimer) and
  `GET .../timeline/:eventId` (single event detail).
- Work pause is event-sourced too: `POST .../projects/:pid/pause
{reason?}` → `ProjectPaused` (+ status `paused`), `POST .../unpause` →
  `ProjectUnpaused` (+ status `active`). Pausing never edits history.
- Client (magic link): `GET /api/v1/portal/:pid/timeline` (+ `/:eventId`
  detail) shows only client-safe rows (freelancer-only automation,
  portal-link hashes, webhook/provider internals hidden) with stripped
  allowlisted metadata.
- UI: the project page links to `/app/projects/:id/timeline`
  (server-rendered, category/actor/search/order filters) and each row links
  to `/app/projects/:id/timeline/:eventId` (what happened + recorded facts
  - integrity note).

## Evidence pack (Session 15 — factual export for overdue/disputed projects)

- Model: a freelancer generates a professional export for an overdue or
  disputed project — parties, project information, agreement version,
  payment terms, milestone structure, invoices/payment records,
  deliverables, approvals, revisions, timeline, reminder history,
  payment-plan history, and project messages/events. Pure
  `src/domain/evidencePack.ts` builds a canonical snapshot with stable
  key ordering and a sha256 pin.
- Factual only: every statement says what happened, when, and who recorded
  it ("On 2026-03-13, the client approved Deliverable Version 4"). The
  builder rejects legal conclusions (`assertFactualCopy()` guards against
  fraud/liable/breach/sue phrasing), and every rendering carries the
  disclaimer plus a no-guarantee notice — the pack does not predict or
  guarantee any dispute, mediation, collections, or court/tribunal outcome.
  Suitable for freelancer records, accountant, mediator, collections
  professional, lawyer, or court/tribunal review where appropriate.
- Money: integer cents + ISO currency; only provider-confirmed receipts
  count as paid (claims never do), stated explicitly in the financial
  summary.
- Immutability: each generation is a NEW row (the `no_update_evidence`
  guard rejects edits/deletes); regenerating pins a fresh hash. Detail
  reads rebuild the snapshot from live records and compare against the
  generation-time pins (agreement hashes, event count, canonical sha256),
  so later activity is reported factually as drift with a regenerate path.
- Freelancer (session + membership + IDOR; generate needs a write role):
  `POST .../projects/:pid/evidence-packs` (201: pack meta + snapshot +
  sha256 + disclaimer), `GET .../evidence-packs` (list),
  `GET .../evidence-packs/:packId` (meta + rebuilt snapshot +
  `consistency {matchesGeneration, reasons}`), `...?format=html` for the
  clean printable export (print → "Save as PDF" for the PDF copy).
- UI: the project page links to `/app/projects/:id/evidence` (pack list +
  generate form) and `/app/projects/:id/evidence/:packId` (integrity card
  - JSON/printable export links).

## Project health (Session 16 — protection checks, observable conditions only)

- Model: pure `src/domain/protection.ts` recomputes 12 observable workflow
  conditions from live project data — payment method not configured,
  deposit missing, milestone overdue, contract unsigned, deliverable
  approved but unpaid, client requested final files before payment,
  payment deadline unclear, multiple payment failures, repeated missed
  installment dates, no recent client activity, large unpaid balance,
  final deliverable currently unlocked.
- Professional by construction: never labels the client (no
  scammer/bad/dishonest/fraudulent phrasing — `assertProfessionalCopy()`
  rejects it), every `needs_attention` row carries an `evidence` object
  with ids/dates/amounts, and there is no opaque risk score — only
  `attentionCount/clearCount` plus the factual list and a next step.
- Money: integer cents; only provider-confirmed receipts count (claims
  never reduce outstanding).
- Freelancer (session + membership + IDOR, read-only):
  `GET .../projects/:pid/protection` (report + disclaimer + no-score note).
- UI: the project page links to `/app/projects/:id/protection`
  ("Protection checks" / "Project health": each row shows status, detail,
  next step; JSON link for the API view).

## AI drafts (Session 17 — assistive only, no chatbot)

- Model: pure `src/domain/aiAssist.ts` (`assistive-v1`, extractive and
  local) — five workflow-scoped helpers, nothing else: contract/terms
  extraction (payment terms, milestones, deadlines, late-fee language,
  revision terms, final-delivery conditions), communication extraction
  (approval, revision request, promised payment date, payment-plan
  discussion, deliverable acceptance), reminder drafting from live project
  facts, factual evidence summarization, and agreement consistency checks
  (amount mismatches, missing due dates, missing final-delivery condition).
- Safety by construction: extractors return verbatim quotes (substrings of
  the pasted text) and report `found: false` instead of inventing; drafts
  never invent payments, never label anyone, never give legal advice, and
  never change financial records. Every response carries
  `reviewRequired: true`, `financialRecordsChanged: false`, the engine
  label, and the disclaimer — recording or sending still requires the
  normal flows (portal approval, verified receipt, manual reminder send).
- Freelancer (session + membership + IDOR, read-only/draft-only):
  `POST .../projects/:pid/ai/extract-terms {sourceText}`,
  `POST .../ai/extract-communications {sourceText}`,
  `POST .../ai/draft-reminder {milestoneId, tone?, portalUrl?}` (amounts and
  dates loaded from live rows),
  `POST .../ai/summarize {maxEvents?}` (restates the recorded trail),
  `GET .../ai/consistency?agreementId?` (recomputed contradictions).
- UI: the project page links to `/app/projects/:id/ai` (one card per
  helper with forms; consistency via JSON link).

## Notifications (Session 18 � production-grade, email + in-app)

- Model: pure `src/domain/notifications.ts` � 18 transactional kinds across
  7 categories (payments, approvals, reminders, overdue, pauses, plans,
  deliverables), professional system-voiced templates (subject + text +
  HTML, workspace footer with a manage-preferences link), a banned-phrasing
  guard (no legal threats, labels, guarantees, or "Deposit" label), stable
  idempotency keys (`notify:<kind>:<scope>:<dedupe>`), paid-stop guards
  (`paid`/`funded`/`refunded` settle; `disputed` pauses), and exponential
  backoff (`2^attempt` minutes, capped at 4h, 5 attempts max).
- Reliability: `src/lib/notify.ts` (`NotificationService`) is the single
  abstraction � idempotent queue (repeats return `duplicate: true`),
  preference + opt-out + paid-stop gates before every send, per-row delivery
  status (`queued`/`sent`/`failed_retry_scheduled`/`failed_exhausted`/
  `canceled`), attempt/error/next-retry bookkeeping, and instant in-app
  delivery honouring per-user prefs. Notifications never break the
  underlying workflow (hooks are best-effort; repeats can never become
  duplicate payment reminders).
- Preferences & unsubscribe: per-user category x channel prefs
  (`GET`/`PUT .../notification-preferences`, absent = enabled, you-only
  scope); client opt-outs (`GET`/`POST`/`DELETE
  .../notification-opt-outs`, `all` or per-category); public signed-token
  flow `GET` (preview, no state change) + `POST /api/v1/notifications/
  unsubscribe {token}` (idempotent confirm, no login required).
- Freelancer (session + membership + IDOR; ticks/retry/cancel need a write
  role): `GET .../notifications?channel?&category?&state?&limit?` (inbox +
  `summary {unreadInapp, failedCount, queuedCount}`),
  `GET .../notifications/:id` (full delivery status),
  `POST .../:id/read` (in-app, idempotent),
  `POST .../:id/retry` (failed email only, paid-stop aware),
  `POST .../:id/cancel` (queued only, history preserved),
  `POST .../projects/:pid/notifications/dispatch-due {now?}` (outbox tick:
  sends due rows, auto-cancels settled/opted-out rows),
  `POST .../projects/:pid/notifications/check-overdue {now?, portalUrl?,
  detail?}` (one notice per open milestone per day, idempotent).
- Lifecycle fan-out (one client email + one in-app row per member, each
  honouring prefs; a `NotificationQueued` timeline event is appended):
  verified payment webhook (received/refunded/disputed/failed), portal
  approval decisions (received/revision/rejected/disputed), deliverable
  approve + release, pause/unpause, plan propose/accept/complete/default.
  Plan run-due keeps its own idempotent per-installment reminders (no
  double-mail).
- UI: `/app/notifications?workspaceId=�` (your inbox, preference matrix,
  opt-out list); the project page links to it.
