# User Flows — FreelancePaymentProtection

Version: 0.1.0 (Session 01)
Companion: `docs/product-requirements.md`, `docs/domain-model.md`
Notation: `→` step, `[Event]` appended to evidence timeline, `[Gate]` rule check.

## Flow 0. Onboarding (freelancer)

1. Sign up → create Workspace (name, currency default).
2. Add Client (name, email) — default `trust_tier=low` for new clients.
3. Empty-state CTA: "Protect your first project" → Flow 1.
4. No credit card, no provider connection required to explore; provider connect required before `PaymentRequested`.

## Flow 1. Create project + agreement + milestones (freelancer)

1. New Project: title, client, currency, total value.
2. Agreement: pick template (MVP: 1 neutral template + free text), set `due_days, grace_days, pause_after_days, release_condition, reminder_policy`. Preview client-facing summary.
3. Milestones: add ≥1. First row UI title: "Milestone 1 — e.g., Discovery & Initial Build — $500" (guidance text: frame as progress, not suspicion; forbid label "Deposit" in default templates).
4. Review "Client will see" summary: paid/remaining logic, release conditions, reminder note ("Automated reminders come from the workflow, not personal chasing").
5. Send agreement link (magic-link, expiring) → `[AgreementCreated]`.
6. Client opens → views → clicks Accept → `[AgreementAccepted(version, hash)]`.
7. Edge: client never accepts → reminder (freelancer nudge) → project stays `draft`; no work submission blocked yet but dashboard flags "Awaiting acceptance".

## Flow 2. Work → Preview → Approval (happy path)

Actors: Freelancer (F), Client (C).

1. F uploads deliverable version N (preview + private final) → `[DeliverableLocked, DeliverablePreviewShared]`. Work=`submitted`, Delivery=`preview_shared`.
2. C receives "Ready for review" email → opens portal → `[MilestoneViewed]` (best-effort receipt).
3. C either:
   a. Approves version N (+ optional note) → `[MilestoneApproved(version N)]`. Work=`approved`.
   b. Requests revision (note required) → `[RevisionRequested]` → F submits N+1 → `[RevisionSubmitted]` → loop to step 2. Prior approval preserved but no longer authorizes release.
4. UI guard: Approve button labels the exact version ("Approve version 3"); revision box requires note.

## Flow 3. Payment request → verified payment → release

1. On approval (or per agreement: on submit), F/system creates payment request via provider → `[PaymentRequested]` (Payment=`requested`).
2. C pays through provider (Stripe Checkout/Elements). Provider webhook → verify signature → idempotent ingest → `[PaymentReceived]` (Payment=`paid`).
3. Release gate `canRelease()` evaluated:
   - Pass → `[DeliverableReleased]` + "Files ready" notice. Delivery=`released`.
   - Fail (partial/unpaid) → show remaining + offer plan (Flow 5). No silent release.
4. Claim path: C clicks "I've paid" without provider match → `[PaymentClaimed]` → Payment=`claimed_unverified` → banner: "Awaiting provider confirmation". Never auto-paid. F sees claim + verify CTA.
5. Refund/chargeback later → provider webhook → `[PaymentRefunded/Disputed]` → payment flagged; delivery stays `released` (history); project flagged for review.

## Flow 4. Late payment → reminders → escalation → pause

Scheduler (idempotent, quiet hours, frequency cap):

1. T-3: polite upcoming notice. T+0: due notice. T+3/T+7/T+14: staged firmness, always neutral system voice ("Automated reminder from {Workspace} workflow"). Each → `[ReminderSent/Delivered/Failed]`.
2. After `pause_after_overdue_days` with outstanding > 0 → warn ("Work will pause in 48h unless paid or plan agreed") → `[ProjectPaused]` if unmet. Pause blocks new submissions/releases; portal explains why + single CTA (Pay / Request plan).
3. Unpause: on `[PaymentReceived]` (auto) or manual override with reason (logged, flagged).
4. Dispute flag: either party can flag → `[DisputeFlagged]` → Work/Payment=`disputed` (evidence preserved, automation paused except receipts).

Copy rule: factual, non-threatening. No legal threats. Late-fee line only if configured + jurisdiction disclaimer shown.

## Flow 5. Payment plan (cash-flow, non-malicious client)

1. F offers plan (or C requests via portal) on overdue milestone: amounts + dates → `[PaymentPlanOffered]`.
2. C accepts → `[PaymentPlanAccepted]` → Payment=`plan_active` (original debt preserved).
3. Installments paid via provider → partial `[PaymentReceived]` rows; plan progress shown.
4. Missed installment → `[PaymentPlanDefaulted]` + re-enter Flow 4 at firm stage.
5. Completed → Payment=`paid` → release gate re-evaluated.

## Flow 6. Controlled delivery / unlock

- Release conditions visible to C from Flow 1 (no surprise locks).
- Preview: watermarked/low-res/view-only (format-dependent; MVP: at minimum banner + no final download).
- Final: private URL/ref released only on `[DeliverableReleased]` or `[ManualReleaseOverride(reason)]` (flagged, F-only, requires typing reason).
- Post-release: "Files ready to release/download" state on F dashboard; download logged (`DeliverableViewed` continued).

## Flow 7. Evidence timeline + export

1. F or C views project timeline (chronological events with actor + UTC timestamp).
2. F clicks Export → generates `EvidencePack` (JSON + readable PDF/HTML) → `[EvidencePackGenerated]` with hash.
3. Pack contents: agreement versions+hashes, milestone history, version-pinned approvals, verified vs claimed payments, reminders, releases/overrides, view receipts (marked best-effort), disclaimer ("Informational record; enforcement jurisdiction-dependent; not legal advice").
4. Pack is a snapshot (new row per generation, never overwrite).

## Flow 8. Freelancer dashboard (attention-first)

Top cards: Total Outstanding | Projects Needing Attention | Payments Overdue | Milestones In Progress.

Attention list (sorted money-at-risk × days-overdue), example rows:

- "Acme Website — $1,200 overdue · 5 days — [Send reminder] [Offer plan] [Pause]"
- "Brand Identity — Awaiting client approval (v2, 2d) — [Nudge]"
- "Video Project — Payment received · files ready to release — [Release]"

Per-project financial card: Contract (accepted vN) | Money ($X received / $Y outstanding) | Work (M1 approved, M2 submitted) | Delivery (final locked) | Client (viewed 2h ago) | Timeline (87 events) | Evidence (complete/partial).

## Flow 9. Client portal (single-project, magic-link)

- Header: Project name + total. Blocks: Paid / Remaining. Current milestone card (status, preview, version). Single Next Step CTA: [Review] / [Pay $X] / [Choose plan]. Upcoming milestones list. Footer: release conditions + neutral help copy.
- Scope: one project only, expiring link, no cross-project nav. Forwarded-link blast radius limited by expiry + rotation.
- Client-feels-safe copy: "You're protected too — you only release payment for work you've approved, and every step is recorded."

## Flow 10. Trust-ladder progression

1. New client: `low` → small Milestone 1, strict gate, short pause window.
2. After 1–2 on-time paid milestones: F upgrades to `standard` → `[TrustTierChanged]` (normal milestones).
3. Recurring on-time client: `high` → Net 30/45 option, relaxed release (approval + grace), lighter reminders.
4. Missed payment: downgrade with reason → stricter gate re-applies to future milestones (history unchanged).

## Failure / Abuse Paths (cross-flow)

- Ghost after preview: view receipt + escalation run; final stays locked.
- Old-version approval: ignored for new version release.
- Webhook delay/outage: state stays `requested` + "pending confirmation" banner; no manual mark-paid.
- Duplicate webhook/reminder: idempotency dedupe, single event effect.
- Cross-tenant URL tampering: deny + log (test in Session 02+).
- Magic-link forward: scope+expiry limits; rotation on demand.
