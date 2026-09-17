# Domain Model — FreelancePaymentProtection

Version: 0.1.0 (Session 01)
Companion: `docs/product-requirements.md`, `docs/user-flows.md`, `docs/security-principles.md`
Principle: **Model events, not just current status.**

## 1. Design Rules (normative)

1. **Events are source of truth.** `Event` log determines Work / Payment / Delivery state via projection. Mutable status columns (if any) are caches, never authority.
2. **Three independent dimensions.** `WORK ≠ PAYMENT ≠ DELIVERY`. Never collapse to a single `status`.
   - Work: `draft, submitted, viewed, revision_requested, approved, disputed`
   - Payment: `unpaid, requested, claimed_unverified, paid, overdue, plan_active, refunded, disputed`
   - Delivery: `locked, preview_shared, unlocked_ready, released`
3. **Approval is version-specific.** `Approval → DeliverableVersion`, not `→ Milestone` alone.
4. **Verified provider events determine payment state.** `PaymentReceived` only from signed provider webhook. `PaymentClaimed` (client assertion) never marks paid.
5. **Historical records immutable.** Payments, Events, Approvals, Agreement versions: append-only. Corrections = new reversing records.
6. **Tenants cannot access one another's resources.** Every row carries `workspace_id`; all queries scoped; tests must prove it.
7. **Final deliverables cannot bypass configured release conditions** except via explicit `ManualReleaseOverride` with reason + actor (flagged in evidence).
8. **Historical evidence cannot be silently rewritten.** No UPDATE/DELETE on event/financial tables from app role; hash-chain (future) or at minimum monotonic `seq` + `occurred_at`.

## 2. Entities

### 2.1 User
- Represents a freelancer (MVP: 1 user = 1 workspace owner; future: multi-seat).
- Fields: `id (uuid), email (unique), display_name, password_hash (argon2/bcrypt via auth lib) | oauth_subject, created_at, last_login_at`.
- Relations: owns/joins Workspaces via `WorkspaceMember`.

### 2.2 Workspace
- Tenant boundary. MVP: one workspace per freelancer.
- Fields: `id, name, owner_user_id, default_currency, reminder_defaults (jsonb), trust_defaults, created_at`.
- Relations: `WorkspaceMember(user_id, workspace_id, role: owner|member|accountant_readonly[future])`.

### 2.3 Client
- Fields: `id, workspace_id (FK, indexed), name, email, company, phone?, trust_tier: low|standard|high (default low for new), notes, created_at, archived_at?`.
- Invariant: email uniqueness scoped to workspace, not global.
- Trust tier changes logged as events.

### 2.4 Project
- Fields: `id, workspace_id, client_id, title, description?, currency, total_value_cents, trust_tier_override?, pause_state: active|paused, pause_reason?, agreement_version_id (current), created_at, archived_at?`.
- Derived (projection, not stored as truth): `work_state, payment_state, delivery_state, outstanding_cents, overdue_cents`.
- Relations: `Milestone[]`, `Agreement[]`, `Deliverable[]`, `Event[]`.

### 2.5 Milestone
- The unit of progress + money. UI label: "Milestone N — {title} — $X". Never "Deposit".
- Fields: `id, workspace_id, project_id, order_index, title, description?, amount_cents, due_date, work_state, payment_state (cached projections), release_gate: current_paid|all_paid|manual (denormalized from agreement at creation, overridable), created_at`.
- Money rule: sum(milestones) vs project total → warn on mismatch, require explicit confirm.
- State machines:
  - Work: `draft → submitted → viewed → approved ⇄ revision_requested (loop) → approved; any → disputed`.
  - Payment: `unpaid → requested → (claimed_unverified) → paid; requested/unpaid → overdue → plan_active → paid; paid → refunded/disputed (via provider)` .

### 2.6 Agreement (versioned)
- Fields: `id, workspace_id, project_id, version (int), terms_text, payment_due_days, grace_days, pause_after_overdue_days, release_condition: current_milestone_paid|all_milestones_paid|manual_release, reminder_policy (jsonb), late_fee_policy? (nullable, jurisdiction-flagged), hash (sha256 of canonical terms), supersedes_id?, created_at, accepted_at?, accepted_by? (client identifier), accept_ip_hash?, accept_ua_hash?`.
- Only one `is_current=true` per project. Edits → new version. Acceptance event references version + hash.
- Disclaimer: acceptance is a workflow record, not a legal opinion.

### 2.7 Payment
- Immutable financial fact. One row per verified charge + adjustments.
- Fields: `id, workspace_id, project_id, milestone_id?, provider: stripe|manual_pending[never paid]|other, provider_payment_id (unique per provider), amount_cents, currency, state: pending|received|partial|refunded|disputed|failed, claimed_by_client_at? (for claimed_unverified tracking), received_at? (provider timestamp), idempotency_key (unique), raw_webhook_ref?, created_at`.
- Rules:
  - `received` only via verified webhook handler.
  - Partial: multiple Payment rows can satisfy one milestone; milestone `paid` when sum(received) ≥ amount.
  - Corrections: new row with `reverses_id`, never UPDATE.
  - Client "mark as paid" creates `PaymentClaimed` event + optional `pending` row flagged unverified — never `received`.

### 2.8 Deliverable + DeliverableVersion
- Separation of preview vs final is load-bearing for leverage.
- Deliverable: `id, workspace_id, project_id, milestone_id, title, delivery_state (projection cache), created_at`.
- DeliverableVersion: `id, deliverable_id, version_no, preview_artifact_ref (watermarked/low-res/view-only), final_artifact_ref (private until release), sha256_preview?, sha256_final?, created_by, created_at, supersedes_id?`.
- New version resets release eligibility (prior approvals remain in history but do not authorize new version).

### 2.9 Approval
- Fields: `id, workspace_id, project_id, milestone_id, deliverable_version_id (NOT NULL), approver_ref (client id / magic-link subject), note?, created_at`.
- Uniqueness: one approval per version per approver (allow re-approval after revision = new version row).
- `RevisionRequested(milestone_id, version_id, note)` does not delete approval; it appends and moves work state.

### 2.10 Event (append-only log — the moat)
- Fields: `id (uuid), seq (bigserial per project? global + project_seq), workspace_id, project_id, milestone_id?, deliverable_id?, actor_type: freelancer|client|system|provider, actor_id?, type (enum, see §3), payload (jsonb), occurred_at (timestamptz, UTC), recorded_at (timestamptz), ip_hash?, ua_hash?, idempotency_key? (unique where from webhooks/scheduler)`.
- DB guards (to implement in migration): `REVOKE UPDATE, DELETE ON events, payments, approvals FROM app_role` (or app-level guard + test if RLS complexity deferred); `CHECK (occurred_at IS NOT NULL)`; monotonic seq.
- Projections: materialized or query-time reducer `reduce(events) → {work, payment, delivery}` per milestone/project. Stored status columns must be updated only by the reducer (single writer function), tested.

### 2.11 Notification
- Fields: `id, workspace_id, project_id?, milestone_id?, channel: email|sms[future]|inapp, template, to_ref, state: queued|sent|delivered|failed|bounced, provider_msg_id?, scheduled_for, sent_at?, created_at`.
- Every send also writes an `Event(ReminderSent / NotificationSent)`.

### 2.12 EvidencePack
- Export snapshot, not live data.
- Fields: `id, workspace_id, project_id, generated_at, generated_by, agreement_version_hashes[], event_range (seq from/to), artifact_ref (pdf/json), sha256, disclaimer_version`.
- Regenerable; each generation is a new row (never overwrite).

### 2.13 PaymentPlan (MVP basic)
- Fields: `id, workspace_id, milestone_id, original_amount_cents, installments: [{amount_cents, due_date, state}] (or child table Installment), state: offered|accepted|active|completed|defaulted, offered_at, accepted_at?, created_at`.
- Original milestone debt preserved; installments reference plan. Missed installment → `PaymentOverdue` + escalation.

## 3. Canonical Event Types (minimum vocabulary)

```
AgreementCreated, AgreementAccepted, AgreementSuperseded
MilestoneCreated, MilestoneSubmitted, MilestoneViewed,
RevisionRequested, RevisionSubmitted, MilestoneApproved,
PaymentRequested, PaymentClaimed, PaymentReceived, PaymentPartial,
PaymentOverdue, PaymentPlanOffered, PaymentPlanAccepted, PaymentPlanDefaulted,
PaymentRefunded, PaymentDisputed
DeliverableLocked, DeliverablePreviewShared, DeliverableViewed,
DeliverableUnlockReady, DeliverableReleased, ManualReleaseOverride
ReminderScheduled, ReminderSent, ReminderDelivered, ReminderFailed
ProjectPaused, ProjectUnpaused, TrustTierChanged, DisputeFlagged, EvidencePackGenerated
```

Each event: `actor + timestamp + reason/note` where meaningful. Unknown future types must be forward-compatible (projection ignores unknown, export includes raw).

## 4. State Transitions (core paths)

### 4.1 Happy path (standard trust)
`MilestoneCreated(unpaid, draft, locked)` → `MilestoneSubmitted` → `DeliverablePreviewShared` → `MilestoneViewed` → `MilestoneApproved(version N)` → `PaymentRequested` → `PaymentReceived(provider)` → `DeliverableReleased` (gate: current paid) → milestone done.

### 4.2 Revision loop
`...Submitted → RevisionRequested(note) → RevisionSubmitted(version N+1) → Viewed → Approved(version N+1)`. Prior approval of version N stays in log but does not release N+1.

### 4.3 Late payment
`PaymentRequested → (due+grace passes) → PaymentOverdue → ReminderSent×N → ProjectPaused (rule) → PaymentPlanOffered → PaymentPlanAccepted → installments → PaymentReceived → ProjectUnpaused → DeliverableReleased`.

### 4.4 Client claims payment
`PaymentClaimed` → state `claimed_unverified` (UI shows "Client says paid — awaiting provider confirmation") → either `PaymentReceived` (confirm) or stays overdue with reminder noting claim. Never auto-paid.

### 4.5 Manual override (flagged)
Freelancer with reason: `ManualReleaseOverride(reason)` → `DeliverableReleased` with `overridden=true` flag. Visible in evidence + dashboard.

### 4.6 Refund / dispute after release
`PaymentRefunded/Disputed (provider)` → payment `refunded/disputed`; delivery stays `released` (history fact); project flagged for review. No auto file-clawback claim.

## 5. Money Integrity

- All amounts integer minor units (`amount_cents`) + `currency` (ISO-4217). No floats.
- Milestone paid ⟺ `sum(payments.received where milestone_id) >= milestone.amount_cents` (refunds subtract via adjustment rows).
- Project outstanding = `sum(milestones.amount) − sum(payments.received)` (plan installments do not reduce outstanding until received).
- Overdue ⟺ `now_utc > due_date + grace_days AND outstanding > 0 AND state not in (paid, refunded)`.

## 6. Release Gates (configurable per agreement)

- `current_milestone_paid`: release deliverable when its milestone fully paid.
- `all_milestones_paid`: final deliverable requires entire project paid.
- `manual_release`: freelancer must click release with reason (still logged).
- Evaluation is a pure function `canRelease(project, milestone, payments, approvals) → bool + reasons[]`. UI shows reasons to both freelancer and client upfront (no surprise locks).

## 7. Trust Ladder Mapping

- `low`: small Milestone 1, `current_milestone_paid` gate, short pause window (e.g., 3d), strict preview-only.
- `standard`: normal milestones, same gate default, standard reminder cadence, pause e.g., 7d.
- `high`: optional Net terms (due_days 30/45), relaxed gate (release on approval + grace period with auto-reminder), lighter cadence.
- Tier stored on Client + optional Project override; every change = `TrustTierChanged` event with reason.

## 8. Edge Cases (domain-level)

- Approval of superseded version: ignored for release, preserved for history.
- Partial payment: no release until gate met; UI shows remaining.
- Overpayment: flag for review, do not auto-apply to next milestone without explicit allocation event (future).
- Duplicate webhooks: idempotency_key dedupe → single `PaymentReceived`.
- Out-of-order events (webhook delayed): projection uses `occurred_at` ordering + `recorded_at` tiebreak; export notes late-arriving provider confirmation.
- Timezone: store UTC; render localized.

## 9. What We Deliberately Do NOT Model (MVP)

- Escrow balances / custodial ledger (would imply money-transmission).
- Interest accrual engine (late-fee is a configurable note, not auto-compounding ledger).
- Legal case / court entities (dispute = flag + evidence, not legal workflow).
- Multi-currency conversion (store currency per project; no FX engine).

## 10. Future Model Extensions (do not build now)

- `Retainer`, `Installment` child table, `WorkspaceMember` roles expansion, `ApiKey`, `WebhookEndpoint`, hash-chain column `prev_hash` on events, `ViewReceipt` detail table.
