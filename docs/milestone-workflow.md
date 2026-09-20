# Milestone workflow (Session 05)

> Source of truth: `src/domain/milestone.ts` (`ALLOWED_TRANSITIONS` + guards).
> This file is a human-readable rendering — do not diverge from the code.

A project holds an ordered milestone set, e.g.
Discovery $500 → Design $1,000 → Development $1,500 → Launch $1,000
(total $4,000, one currency, contiguous `orderIndex` 0..n−1).

## Dimensions (no booleans)

| Dimension | Values |
|---|---|
| work | `draft → in_progress → submitted → viewed → revision_requested → approved`, plus `disputed` |
| payment | `unpaid → payment_pending → funded → payment_pending → paid`, plus `claimed_unverified` (client assertion, never paid), `overdue`, `plan_active`, `refunded`, `disputed` |
| approval | `none → pending → approved / revision_requested / rejected` (version-pinned) |
| deliverable | `locked → preview_shared → unlocked_ready → released` |
| unlock | `locked → available → unlocked` (derived from siblings, never set directly) |

Two paid phases are intentional: `funded` = verified money received so work
may start; `paid` = payout settled after approval. The example chain
`draft → payment_pending → funded → in_progress → submitted →
revision_requested → submitted → approved → payment_pending → paid →
unlocked → next_milestone_available` maps onto these dimensions instead of a
single status (a single status would allow impossible combos like
"approved + unpaid + released").

## Allowed transitions

```
WORK:        draft→in_progress, in_progress→submitted,
             submitted→viewed, submitted→revision_requested,
             viewed→revision_requested, revision_requested→submitted,
             submitted→approved, viewed→approved, any→disputed
PAYMENT:     unpaid→payment_pending, payment_pending→funded,
             payment_pending→claimed_unverified, claimed_unverified→funded,
             funded→payment_pending, overdue→payment_pending,
             payment_pending→paid, *→overdue (except paid/refunded),
             funded|paid→refunded, any→disputed
APPROVAL:    none→pending, pending→approved, pending→revision_requested,
             pending→rejected, revision_requested→pending
DELIVERABLE: locked→preview_shared, locked→unlocked_ready,
             preview_shared→unlocked_ready, unlocked_ready→released
UNLOCK:      locked→available, available→unlocked
```

## Cross-dimension guards

- Work starts only on `available` milestones; default workflow also requires
  `funded` first (`FLEXIBLE_WORKFLOW` relaxes both).
- Only `submitted`/`viewed` work can be approved, and only when
  `approvedVersionId === currentVersionId` (old-version approvals never count).
- Payout requires `funded` + `work=approved` + `approval=approved` (default;
  `requireApprovalForPayout=false` relaxes the approval half).
- Release requires verified `paid` (+ approval by default) and flips
  `unlock` to `unlocked`.
- `paymentId` is the idempotency key: the same receipt applied twice, or any
  second payout on a `paid` milestone, is rejected (`DUPLICATE_PAYMENT`, HTTP
  409). The event write uses `${milestoneId}:${paymentId}` so the DB UNIQUE
  enforces it too.
- Amount changes after funding/payment (or any applied receipt) require an
  audit `{reason ≥ 8 chars, actorId}`; history is preserved in
  `amountHistory` (`AUDIT_REQUIRED`, HTTP 422 otherwise).
- Reorders must include every id exactly once with no gaps/duplicates, keep
  one currency and non-decreasing due dates; reordering funded/paid rows
  needs the same audit. DB UNIQUE `(project_id, order_index)` backs this.
- Unlocks are recomputed across siblings after every mutation: milestone N
  is `available` only when all predecessors satisfy `unlockPolicy`
  (`previous_paid` default, `previous_approved`, or `open`).

## Compatibility

`toLegacyProjection()` maps `funded`/`paid → paid` and
`payment_pending → requested` onto the canonical 3-dimension vocabulary in
`src/domain/types.ts`, so the event reducer (`events.ts`), money math
(`money.ts`) and release gates (`release.ts`) keep working unchanged.
