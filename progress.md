# Project Progress — FreelancePaymentProtection

> Persistent memory across sessions. READ THIS FILE BEFORE doing anything else in future sessions. Do not delete historical progress — append/update carefully.

## Product
Name: FreelancePaymentProtection
Current Version: 0.1.0 (PRD/architecture draft, no code)
Current Stage: Session 01 — Product architecture & requirements (no implementation)

## Core Product Thesis
Freelancers know they should use deposits, milestones, approvals, payment deadlines and final-delivery locks, but in practice the workflow is fragmented across email, spreadsheets, invoices, cloud storage and manual reminders. This product is a **payment-protection workflow** (not an invoice generator, CRM, contract-template site, or reminder app) that ties payment to project progress, retains freelancer leverage until contractual conditions are met, treats clients professionally, and maintains a provable financial state for every project. North-star direction: Protected Project Value + honestly-measured payment leakage collected — not invoice counts.

## Current Architecture
Frontend: TBD (to be selected Session 02; candidates: Next.js / Astro+HTMX — see Important Decisions)
Backend: TBD (to be selected Session 02; candidates: Node/TS + Postgres, or full-stack framework)
Database: TBD — Postgres-first planned (required for append-only events, idempotency, money integrity). No DB yet.
Authentication: TBD — freelancer session TBD; client via scoped expiring magic links (principle decided, not implemented).
Payments: TBD — default candidate Stripe (PaymentIntents + webhooks as verified source of truth). No integration yet. No escrow ever in MVP.
Storage: TBD — abstraction over local/S3-compatible, private-by-default. No bucket yet.
Email: TBD — provider TBD; neutral automation voice required.
AI: None in MVP (explicitly not a differentiator; no AI dispute/contract adjudication).

## Completed

### 2026-09-17 — Session 01 (Lead product architect — PRD, no code)
- Inspected repo: confirmed empty directory (no files, no git, no progress.md). Stack: git 2.55, node v24.6.0, npm 11.5.1 available.
- Created `docs/product-requirements.md` v0.1.0: thesis, users (freelancer primary, client secondary), 7 JTBD, 18 MVP capability areas, out-of-MVP list, functional reqs FR-1..FR-36, normative 3-dimension state model, trust ladder, UX principles, NFRs, provider deps, legal boundaries, edge/failure/abuse analysis, MVP-vs-future, open questions.
- Created `docs/domain-model.md` v0.1.0: events-as-truth, entities (User, Workspace, Client, Project, Milestone, Agreement-versioned, Payment-immutable, Deliverable+Version, Approval-version-pinned, Event-append-only, Notification, EvidencePack, PaymentPlan), canonical event vocabulary, transitions, money-integrity rules (minor units), release gates, trust mapping.
- Created `docs/user-flows.md` v0.1.0: Flows 0–10 (onboard, project+agreement, approval, payment→release, late→pause, plan, delivery, evidence export, freelancer dashboard, client portal, trust progression) + failure/abuse paths.
- Created `docs/security-principles.md` v0.1.0: tenant isolation, magic-link rules, webhook verify+idempotency, append-only guards, signed-URL gating, abuse matrix, MVP security checklist, disclaimer requirements.
- Created this `progress.md` per required structure.
- Initialized git + committed (see Last Session).

## Current Database Model
Planned only — NOT implemented (Session 01 was docs-only):
- User (freelancer; argon2id/bcrypt; future MFA hook)
- Workspace (+ WorkspaceMember roles; tenant boundary)
- Client (trust_tier low|standard|high)
- Project (3-dimension projection: work/payment/delivery; pause_state)
- Milestone (order, amount_cents, due_date, work_state + payment_state projections, release_gate)
- Agreement (versioned, hash, single current, acceptance record)
- Payment (immutable, provider-verified, idempotency_key, partial/refund via new rows)
- Deliverable (+ DeliverableVersion with preview_ref/private final_ref + sha256)
- Approval (version-pinned, non-null deliverable_version_id)
- Event (append-only: seq, actor, type, payload, occurred_at UTC, ip/ua hash)
- Notification (queued→sent/delivered/failed + ReminderSent events)
- EvidencePack (snapshot per generation + sha256 + disclaimer_version)
- PaymentPlan (offered/accepted/active/completed/defaulted + installments)
No migrations exist yet. No ORM selected yet.

## Important Decisions
- Model events, not just current status: `MilestoneSubmitted/Viewed/RevisionRequested/RevisionSubmitted/Approved/PaymentRequested/Received/DeliverableReleased` etc. are source of truth; status columns (if any) are projections. Reason: evidence timeline is the eventual moat — "what happened", not "current DB value".
- Approval and payment are separate states; delivery is a third dimension. Never collapse to `status="approved"`. Approval ≠ paid ≠ released.
- Trust ladder required: low (small Milestone 1, strict preview-only) → standard → high (Net 30/45, relaxed). Never force "50% deposit or nothing". Downgrade on missed payment with logged reason.
- First-payment UX framing: "Milestone 1 — Discovery & Initial Build — $500", never "Deposit". Progress, not suspicion. Forbid "Deposit" label in default templates.
- Two dashboards: freelancer attention-first (Outstanding / Needs Attention / Overdue / In Progress + money-at-risk sorting + per-project financial card) and client single-next-step portal (Paid/Remaining, current milestone, one CTA, upcoming).
- Differentiator: provable financial state at every lifecycle point (Contract/Money/Work/Delivery/Client/Timeline/Evidence card). Not AI, not invoices, not contracts.
- No self-built escrow / money-transmission in MVP (licensing + risk). Use established provider (Stripe candidate). Never promise guaranteed payment.
- Only verified provider webhooks write `PaymentReceived/Refunded`. `PaymentClaimed` (client assertion) stays `claimed_unverified`.
- Final deliverables cannot bypass release conditions except explicit `ManualReleaseOverride(reason)` flagged in evidence. Previews watermarked/view-only; finals private + signed URLs.
- Amounts in integer minor units + ISO currency; UTC timestamps; UUIDs in URLs (no enumeration).
- Stack intentionally UNDECIDED in Session 01 (docs-only per task). Session 02 must pick and record rationale here.
- Architectural principles above must persist; fresh agents must not rediscover "why no escrow" — it is licensing/risk, recorded here.

## Invariants
These must NEVER be violated:
- Historical payment records are immutable (corrections via new reversing rows).
- Verified provider events determine payment state (client claims never mark paid).
- Tenants cannot access one another's resources (workspace_id scoping + tests).
- Approval is version-specific (old-version approval never releases new version).
- Final deliverables cannot bypass configured release conditions (except flagged manual override with reason).
- Historical evidence cannot be silently rewritten (append-only events; no UPDATE/DELETE from app role).

## Known Issues
- None in code (no code yet). Docs-only stage.

## Security Concerns
- All Session-01 security items are prospective (see `docs/security-principles.md` §14 checklist). No code to audit yet.
- Watch items for Session 02: tenant scoping, webhook verify, append-only migration grants, magic-link hash/scope/expiry, signed-URL gating, claim≠paid, version-pinned approval, rate limits + headers, fail-closed config, disclaimer copy.

## Product Questions
1. Refund/chargeback post-release UX prominence?
2. GDPR erasure vs evidence immutability exact rule (current direction: anonymize PII, preserve facts+hashes)?
3. Agreement template jurisdictions first + counsel review?
4. PPV/"prevented" methodology without overclaim?
5. MVP file size/type limits for previews/finals?
6. Email-only reminders MVP confirmed? SMS later?
7. Single-currency MVP first?
(Also in PRD §15.)

## Technical Debt
- None (no code). Debt risk: stack unselected — must be decided Session 02 before migrations.

## Environment
Required variables (planned, none wired yet):
- `DATABASE_URL, SESSION_SECRET, APP_BASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STORAGE_* (endpoint/bucket/key), EMAIL_* (provider/key/from), MAGIC_LINK_TTL`
Commands (no package manager project yet — Session 02 to define; placeholders only):
- install: TBD
- dev: TBD
- test: TBD (must include tenant-isolation, webhook-idempotency, append-only, claim≠paid, version-pinned-approval tests)
- lint: TBD
- typecheck: TBD
- build: TBD
Toolchain observed 2026-09-17: git 2.55.0.windows.5, node v24.6.0, npm 11.5.1.

## Last Session
What was done:
- Session 01 docs-only: inspected empty repo; authored docs/product-requirements.md, docs/domain-model.md, docs/user-flows.md, docs/security-principles.md; created progress.md; git init + initial commit. No application code written per task.
What failed:
- Nothing. No blockers (empty repo expected).
Files changed:
- Added: `docs/product-requirements.md`, `docs/domain-model.md`, `docs/user-flows.md`, `docs/security-principles.md`, `progress.md`
- No modifications/deletions (nothing pre-existed).

## NEXT SESSION
Objective:
- Session 02: select stack (frontend/backend/DB/auth/payments/storage/email) with rationale; scaffold repo; add `.env.example` (placeholders only) + README run instructions; implement migration for core entities + append-only `events` table with immutability guards (revoke UPDATE/DELETE or documented equivalent); wire minimal health-check + test harness proving: cross-tenant denial, webhook-signature+idempotency stub, claim≠paid, version-pinned approval, private-final-until-release. Do NOT build full UI/dashboards yet.
Important context:
- Read this progress.md + all four docs/ files first. Preserve invariants (§Invariants) and event vocabulary. Trust ladder + 3-dimension state model are normative.
- Amounts integer cents; timestamps UTC; UUIDs in URLs; neutral reminder copy; disclaimers required in portal/export later.
Do not repeat:
- Do not re-debate escrow (decided: no MVP escrow, use provider). Do not collapse work/payment/delivery into single status. Do not start full UI before data+event foundation + security tests. Do not write secrets into repo.

## Future
- V1.1: retainers, Net-terms automation, trust-tier automation, accountant read-only seat.
- V2: multi-seat workspaces, hash-chained evidence (`prev_hash`) + third-party timestamping, PPV/leakage analytics (honest methodology), additional payment providers, SMS channels.
- Ops: SPF/DKIM/DMARC, secret rotation runbook, retention/GDPR-anonymization rule with counsel sign-off, accessibility (WCAG 2.2 AA) audit, perf budgets (dashboard p95 <2s, portal <1.5s) validation.
