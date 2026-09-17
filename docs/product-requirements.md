# Product Requirements Document — FreelancePaymentProtection

Version: 0.1.0 (Session 01 — Architecture / PRD only, no implementation)
Status: Draft for implementation planning
Date: 2026-09-17

## 1. Product Thesis

Independent freelancers know they should use deposits, milestones, approvals, payment deadlines, and final-delivery locks — but in practice the workflow is fragmented across email, spreadsheets, invoices, cloud storage, and manual reminders.

**FreelancePaymentProtection is a payment-protection workflow, not a generic invoice generator, CRM, contract-template site, or reminder app.**

Central problem:

> "Freelancers know they should use deposits, milestones, approvals, payment deadlines and final-delivery locks, but in practice the workflow is fragmented across email, spreadsheets, invoices, cloud storage and manual reminders."

The product makes payment part of the project workflow rather than an afterthought, lets freelancers retain appropriate leverage until contractual payment conditions are satisfied, and maintains a provable financial state for every project at every point in its lifecycle.

North-star direction (not MVP commitment):

- **Protected Project Value (PPV):** sum of contracted value under protected workflows.
- **Payment Leakage Prevented / Collected through protected workflows:** only claim what measurement supports.

What this product is NOT:

- Not a generic invoice generator.
- Not a generic CRM.
- Not a contract-template website.
- Not a simple reminder app.
- Not a guaranteed-payment / insurance product.
- Not an escrow / regulated money-transmitter (explicitly out of MVP).

## 2. Users

### 2.1 Primary user: Freelancer (independent / solo / small studio)

Goals:

- Get paid on time for approved work.
- Avoid delivering final files then losing leverage.
- Stop awkward personal payment chasing.
- Handle cash-flow-strapped but honest clients without burning the relationship.
- Have clean evidence if a dispute arises.

Segments:

- New freelancer, no reputation (needs trust ladder, low-friction onboarding).
- Established freelancer with repeat clients (needs low-overhead automation).
- High-ticket project freelancer (needs milestone + delivery-lock rigor).

### 2.2 Secondary user: Client (buyer of freelance work)

The client must also feel safe. The client portal must feel professional and protective for BOTH parties:

- Clear what was paid / remaining.
- Clear what the current milestone status is.
- Clear single next step (e.g., "Review deliverable").
- No surprise locks; release conditions visible upfront.

### 2.3 Tertiary / future users (out of MVP)

- Studio admin / multi-seat workspace owner.
- Accountant / bookkeeper (read-only export).
- Mediator / arbitrator / platform dispute reviewer (evidence-pack consumer).
- Payment-plan co-signer (rare, future).

Non-users the system must still consider:

- Payment providers (Stripe, etc.) as verified event sources.
- Email providers as delivery channel, not source of truth.

## 3. Core Jobs-to-be-Done (JTBD)

Freelancer JTBD:

1. "When I start a project, help me set terms so payment is tied to progress, not hope."
2. "When I deliver work, help me get explicit approval tied to a specific version."
3. "When work is approved, help me get paid without begging."
4. "When payment is late, help me escalate neutrally and pause correctly."
5. "When final files are ready, help me hold them until payment conditions are met — without surprising the client."
6. "When a client says cash-flow is tight, help me offer a payment plan instead of losing everything."
7. "When there is a dispute, help me show what happened with timestamps."

Client JTBD:

1. "Help me understand what I'm paying for and what happens next."
2. "Let me review and approve work simply."
3. "Let me pay through a trusted provider and see it reflected."
4. "If I need more time, let me request it formally rather than ghosting."

## 4. User Journeys (summary; full flows in `docs/user-flows.md`)

1. **Onboard → Create client → Create project → Define agreement + milestones.**
2. **Milestone 1 framing:** first payment is presented as "Milestone 1 — Discovery & Initial Build — $500", never as suspicious "Deposit". Progress, not suspicion.
3. **Work → Preview → Approval (version-specific) → Payment request → Verified payment → Release.**
4. **Late payment:** automated neutral reminders → escalation → project pause → payment plan option.
5. **Dispute:** continuous evidence timeline → exportable evidence pack.
6. **Repeat client:** trust ladder relaxes restrictions (Net 30/45, lighter locks).

## 5. Scope

### 5.1 MVP must support (18 capability areas, MVP slice)

1. Projects
2. Clients
3. Agreements / terms (lightweight, no unsupported legal claims)
4. Milestones
5. Payment schedules
6. Deliverables (preview vs final separation)
7. Client approval (version-specific)
8. Payment status (provider-verified, separate from approval)
9. Payment reminders (neutral-tone automation)
10. Escalation workflows (staged, non-aggressive default)
11. Project pause when payment conditions are violated
12. Controlled delivery / unlock (rule-based release)
13. Evidence timeline (append-only events)
14. Payment-plan / installment handling (basic)
15. Evidence export (basic PDF/JSON pack)
16. Dispute documentation (timeline + attachments, no legal advice)
17. Client-side portal (magic-link, minimal)
18. Freelancer-side dashboard (attention-first)

### 5.2 Explicitly OUT of MVP

- Self-built escrow / holding client funds / money-transmitter behavior.
- Guaranteed payment / insurance / collections enforcement promises.
- AI contract generation with legal effect; AI invoice dispute adjudication.
- Native mobile apps; multi-currency settlement; crypto settlement.
- Full accounting / tax filing; e-signature with legal attestation weight.
- Automated legal letters threatening action.
- Marketplace / client discovery.

### 5.3 Future (post-MVP) candidates

- Recurring retainers, Net 30/45 automation for trusted clients.
- Deeper provider reconciliation (partial refunds, disputes/chargebacks).
- Advanced evidence pack (hash-chained export, third-party timestamping).
- Team workspaces / roles; accountant read-only seats.
- PPV analytics, leakage analytics with honest methodology.
- Template library for agreements + jurisdiction-aware disclaimers.

## 6. Functional Requirements

### 6.1 Projects & Clients

- FR-1: Freelancer can create/edit/archive Clients (name, email, company, notes, trust tier).
- FR-2: Freelancer can create Projects linked to one Client, with currency, total value, start/end, trust tier override.
- FR-3: Project has three independent state dimensions (see §7): Work, Payment, Delivery. No single collapsed `status`.
- FR-4: Dashboard surfaces "needs attention" sorted by money-at-risk × days-overdue, not just recency.

### 6.2 Agreements / Terms

- FR-5: Each Project has one active Agreement version (terms text + release rule + reminder policy + pause rule).
- FR-6: Agreement records: payment due days, late fee policy (if legally permitted + disclosed as configurable, no auto legal claim), pause-after-overdue-days, release condition (e.g., `all_milestones_paid`, `current_milestone_paid`, `manual_release`).
- FR-7: Agreement acceptance event recorded (client clicked accept + timestamp + IP/UA hash + version hash). Not claimed as e-signature with legal weight in MVP.
- FR-8: Editing terms creates a new Agreement version; history immutable.

### 6.3 Milestones

- FR-9: Milestones have: title, description, amount, due date, order, work state, payment state. First milestone framed in UI as "Milestone 1", never "Deposit".
- FR-10: Milestone amounts sum validation vs project total (warn, allow flexible if over/under with explicit confirm).
- FR-11: Trust ladder: per-client/project policy — `strict` (preview-only until paid), `standard`, `relaxed` (Net terms, auto-release with grace). Default `standard` for new clients.
- FR-12: Milestone work-state machine and payment-state machine are separate (see §7).

### 6.4 Deliverables & Approval

- FR-13: Deliverables have versions. Each version: file/link reference, preview artifact, final artifact pointer, hash, created-by, timestamp.
- FR-14: Approval is version-specific: `Approval(milestone_id, deliverable_version_id, approver, timestamp)`. New version invalidates prior "approved" for release purposes (prior approval remains in history).
- FR-15: Client can Request Revision with note; freelancer can Submit Revision (new version).
- FR-16: Final files are never exposed to client until release conditions satisfied. Preview is watermarked / low-res / view-only where feasible.
- FR-17: Release is an explicit event `DeliverableReleased` gated by configured rule, not by setting a boolean.

### 6.5 Payments

- FR-18: Payment intent/request is separate from payment confirmation.
- FR-19: Only verified provider events (e.g., Stripe webhook `payment_intent.succeeded`) may transition payment state to `paid`. Client "I paid" claims create `PaymentClaimed` event, never `paid`.
- FR-20: Support partial payments, overpayments (flag), refunds (provider-verified), overdue computation (due_date + grace vs now, unpaid).
- FR-21: Historical payment records immutable; corrections via reversing/adjustment records, not edits.
- FR-22: No escrow holding in MVP; funds go via established provider directly to freelancer (or provider-managed invoice flow). System tracks state; never custodies.

### 6.6 Reminders & Escalation

- FR-23: Reminder policy per project: schedule (e.g., T-3, T+0, T+3, T+7, T+14), neutral templates, quiet hours, max frequency cap.
- FR-24: Reminders sent as system/neutral voice ("Automated reminder from {Workspace} workflow"), not as personal begging. Log `ReminderSent`, `ReminderDelivered`, `ReminderFailed` events.
- FR-25: Escalation stages: `nudge` → `firm` → `pause_warning` → `paused` → `payment_plan_offer` → `dispute_flag`. Each stage is an event; transitions require either automation rule firing or explicit freelancer action (no silent auto-legal threats).
- FR-26: Project pause blocks new work submission / release but preserves evidence + client view. Unpause requires payment or explicit override with reason logged.

### 6.7 Payment plans

- FR-27: Overdue milestone can be split into installments (amounts + due dates). Original debt preserved; plan is new schedule linked to same milestone.
- FR-28: Missed installment re-triggers escalation; plan history immutable.

### 6.8 Evidence timeline & export

- FR-29: Every significant action appends an `Event` (actor, timestamp, type, payload hash, IP/UA where relevant). No silent rewrites; no deletes.
- FR-30: Evidence pack export (MVP: JSON + human-readable PDF/HTML) includes: agreement versions, milestone history, approvals, payments (verified vs claimed), reminders, releases, view events. Includes disclaimer: informational record, not legal advice, jurisdiction-dependent enforcement.
- FR-31: View/receipt events (`DeliverableViewed`, `ReminderViewed` via pixel/open proxy where possible, portal login) captured best-effort, marked as such.

### 6.9 Dashboards & Portals

- FR-32: Freelancer dashboard shows: Total Outstanding, Projects Needing Attention, Payments Overdue, Milestones In Progress; attention list sorted by risk; per-project financial snapshot (Contract accepted? Money received/outstanding? Work state? Delivery state? Timeline count? Evidence completeness?).
- FR-33: Client portal (magic-link, expiring, single-project scope) shows: Paid / Remaining, Current milestone, Status, single Next Step CTA, Upcoming milestones. No cross-project leakage.
- FR-34: Both dashboards must load useful state in <2s (p95) on MVP scale; exact perf budget to be set in architecture session.

### 6.10 Notifications

- FR-35: Email notifications for: milestone submitted, approval requested, approved, payment requested/received/overdue, release ready/released, paused/unpaused, plan offered. In-app + email; preferences per workspace.
- FR-36: All notifications logged as events; unsubscribe / bounce handling basic.

## 7. State Model (normative — do not collapse)

Three independent dimensions per Project (aggregated from milestones) and per Milestone:

**WORK STATE:** `draft → submitted → viewed → approved | revision_requested → (resubmitted) → approved | disputed`
**PAYMENT STATE:** `unpaid → requested → claimed_unverified → paid | overdue → (plan_active) → paid | refunded | disputed`
**DELIVERY STATE:** `locked → preview_shared → unlocked_ready → released`

Rules:

- `approved ≠ paid ≠ released`. Approval never implies payment; payment never auto-implies release unless release rule says so and event is logged.
- Release gate examples: `current_milestone_paid`, `all_milestones_paid`, `manual_release_with_reason`.
- State is derived from events (event-sourced projection), not just a mutable column. Mutable `status` columns, if present for query convenience, must be projections and never the source of truth. See `docs/domain-model.md`.

Canonical events (minimum): `MilestoneSubmitted, MilestoneViewed, RevisionRequested, RevisionSubmitted, MilestoneApproved, PaymentRequested, PaymentClaimed, PaymentReceived, PaymentOverdue, DeliverableLocked, DeliverablePreviewShared, DeliverableReleased, ReminderSent, ProjectPaused, ProjectUnpaused, PaymentPlanOffered, PaymentPlanAccepted, DisputeFlagged, AgreementAccepted`.

## 8. Trust Ladder

| Tier | When | Workflow |
|------|------|----------|
| Low-trust / new client | Default | Small Milestone 1, preview-only, strict release (`current_milestone_paid`), short pause window |
| Standard | After 1–2 paid milestones | Normal milestones, preview → approval → payment → release, automated reminders |
| High-trust / recurring | Explicit upgrade + history | Net 30/45 option, relaxed release (e.g., release on approval + grace), lighter reminders |

Requirements:

- Trust tier is explicit per client/project, change-logged.
- Downgrade on missed payment is supported (event + reason).
- UI never forces "50% deposit or nothing"; offers Milestone-1 framing.

## 9. UX Principles

- Progress, not suspicion: "Milestone 1 — Discovery & Initial Build — $500".
- Neutral automation voice for reminders.
- Client portal single-next-step clarity.
- No surprise locks: release conditions shown to client before work starts.
- Attention-first freelancer dashboard (money-at-risk sorting).
- Provable financial state card per project (Contract / Money / Work / Delivery / Client activity / Timeline count / Evidence).

## 10. Non-Functional Requirements

- NFR-1 Security: tenant isolation enforced at data + query layer; magic-link tokens single-scope, expiring, hashed; provider webhooks signature-verified; append-only evidence (see `docs/security-principles.md`).
- NFR-2 Privacy: minimal PII, purpose-limited logging (hash IP/UA, retention policy).
- NFR-3 Reliability: at-least-once webhook handling with idempotency keys; reminder scheduler idempotent.
- NFR-4 Auditability: every money/work/delivery transition has an event with actor + timestamp + reason.
- NFR-5 Performance (MVP target): dashboard p95 <2s at 1k projects/workspace; portal p95 <1.5s.
- NFR-6 Accessibility: WCAG 2.2 AA for portals/dashboards (future audit).
- NFR-7 Portability: Postgres-first; storage abstraction (local/S3-compatible).

## 11. Payment-Provider Dependencies (MVP)

- Use established provider (default candidate: Stripe — PaymentIntents + Invoices + webhooks). No custom card handling; no PCI scope beyond provider Elements/Checkout.
- Webhook events are the only writers of `PaymentReceived` / `Refunded`. All webhook handlers idempotent, signature-verified, logged.
- Failure modes: webhook delay/replay → idempotency; provider outage → payment state stays `requested`, UI shows "pending confirmation"; partial/refund webhooks → adjustment records.
- Multi-provider abstraction planned but MVP may hard-code one provider behind an interface.

## 12. Legal / Compliance Boundaries (hard constraints)

- Never promise guaranteed payment, insurance, or enforcement outcomes.
- No unsupported legal claims: agreement acceptance ≠ legal advice; evidence pack is an informational record; enforcement is jurisdiction-dependent (especially international, e.g., Morocco example in research).
- No escrow / money-transmission without licensing; avoid holding funds.
- Late-fee / interest features must be opt-in, jurisdiction-flagged, and disclosed as "configure per your local law / seek advice".
- Dispute copy must be neutral, factual, non-threatening. No auto-generated legal threats.
- Data retention / deletion: evidence immutability vs GDPR erasure — resolve via retention policy + anonymization strategy (to be decided in architecture session; default: financial records retained per legal obligation, PII minimized).
- Required disclaimers in UI + exports (exact copy TBD with counsel, placeholder in templates).

## 13. Edge Cases, Failure Modes, Abuse (must design for)

- Client claims paid but provider shows nothing → stays `claimed_unverified`, freelancer sees both.
- Client pays partial → milestone stays partially paid, release gate unmet, plan offered.
- Client approves old version then freelancer ships new version → approval pinned to old version, new approval required for release.
- Client downloads preview and ghosts → preview watermarking + view events + escalation still run; final locked.
- Freelancer releases early manually → allowed only with explicit reason event (`ManualReleaseOverride`), flagged in evidence.
- Refund / chargeback after release → payment state `refunded/disputed`, delivery stays `released` (history), escalation guidance (no auto file clawback claim).
- Clock skew / timezone: all events UTC, display localized.
- Webhook replay / duplicate reminders: idempotency keys on all side-effecting handlers.
- Tenant-cross-access attempts: deny + log.
- Freelancer edits history: denied at API + DB (append-only tables, no UPDATE/DELETE grants for app role where feasible).
- Magic-link forwarding: single-project scope + expiry + rotation limits blast radius.
- Reminder fatigue / spam: frequency caps, quiet hours, unsubscribe.

## 14. MVP vs Future (build order guidance)

- MVP: single freelancer workspace, one provider, email-only notifications, local/S3 storage abstraction, basic evidence export, basic plans, pause, manual + rule-based release.
- V1.1: retainers, Net terms automation, trust-tier automation, accountant read-only.
- V2: multi-seat, hash-chained evidence, advanced analytics (PPV honestly measured), additional providers, SMS/reminder channels.

## 15. Open Product Questions

1. Refund/chargeback UX: how prominently to surface post-release payment reversal?
2. GDPR erasure vs evidence immutability: retention/anonymization exact rule?
3. Agreement template legal review: which jurisdictions first?
4. PPV/leakage methodology: what counts as "prevented" without overclaim?
5. File size/type limits for previews/finals in MVP?
6. Reminder channel scope: email-only MVP confirmed? SMS later?
7. Currency scope MVP: single-currency first?

## 16. Acceptance Criteria (Session-01)

- [x] This PRD exists at `docs/product-requirements.md`.
- [x] `docs/domain-model.md`, `docs/user-flows.md`, `docs/security-principles.md` exist and are consistent with §7 invariants.
- [x] `progress.md` updated with decisions + next session objective.
- [x] No application code written (per session task).
- [x] Git initialized + committed.

## 17. Next Session Recommendation

Session 02 should select stack + scaffold repo (frontend/backend/DB/auth/payments/storage/email) and implement migration for core entities + event table with immutability guards, plus a minimal health-check/test harness. Do NOT build full UI yet.
