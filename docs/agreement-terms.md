# Agreement terms (payment-terms layer, v0.6.0)

The product is **not a law firm**. It records configurable business terms the
freelancer defines, renders them as a readable draft, and tracks client
acceptance — so both sides see the same numbers and the same rules before
work starts. Whether the terms are enforceable depends on jurisdiction and
the actual agreement between the parties. That disclaimer ships in every
agreement API response and is embedded in every rendered `termsText`.

## Term coverage (11 sections)

Rendered by `buildAgreementText()` in `src/domain/agreement.ts`:

1. Amount (`totalAmountCents`, ISO currency)
2. Deposit / first milestone (`depositAmountCents` — must equal the first
   schedule entry; schedule titles follow the product thesis and reject the
   `"Deposit"` label, framing Milestone 1 as progress)
3. Milestone schedule (1–50 entries; amounts must sum to the total)
4. Payment deadline (`paymentDueDays` 0–90 + `graceDays` 0–30)
5. Accepted payment methods (`bank_transfer | card | paypal | stripe | wise |
   cash | check | other`, at least one)
6. Late-payment policy (`none | flat_fee | percentage_per_month | custom` +
   human-readable description)
7. Work-pause policy (`pauseAfterOverdueDays` 0–90 + description)
8. Final-delivery condition (description + gate:
   `current_milestone_paid | all_milestones_paid | manual_release`)
9. Ownership / delivery condition (mode + description:
   `on_final_payment | on_each_milestone_payment | on_project_completion |
   custom`)
10. Revision limits (`maxRevisionsPerMilestone` 0–20 + extra-revision policy)
11. Cancellation / termination (`cancellationNoticeDays` 0–90, optional kill
    fee ≤ total + policy text) plus optional `customClauses`.

## Lifecycle

```
draft → pending_acceptance → accepted → superseded
  │            │
  └────────────┴── voided
```

- There is **no PATCH/PUT**. A version row is content-immutable once written:
  corrections are a new auto-incremented version (`POST .../agreements`),
  never an edit. `isCurrent` marks the newest non-voided version.
- `send` moves `draft → pending_acceptance`; `accept` pins
  `{ hash, version, acceptedBy, acceptedAt }` plus sha256-hashed IP/UA refs
  (raw values never stored). Only sent versions can be accepted; accepted
  versions cannot be re-accepted or voided.
- Accepting v2 supersedes previously accepted versions (`accepted →
  superseded`); voided drafts withdraw without touching accepted history.
- The fingerprint is `sha256` over a canonical (key-sorted) JSON payload —
  `hashAgreementTerms()` / `verifyAgreementHash()`. The accept route
  re-verifies the stored terms against the recorded hash before pinning, so
  the exact bytes the client saw are what get recorded.

## Evidence properties

- Historical content stays reconstructable: `termsText` + `hash` are returned
  verbatim on every read, and the detail route includes an `auditTrail`
  (`AgreementCreated/Sent/Accepted/Superseded/Voided` events with
  `{ agreementId, version, hash }` payloads).
- The DB guard (`prisma/migrations/0004_agreement_terms/migration.sql`,
  `guard_agreement_immutability()`) rejects DELETEs, rejects UPDATEs that
  touch any business-content column, and rejects rewrites of the acceptance
  record. The store seam mirrors this: only `updateAgreementLifecycle()`
  (status / flags / acceptance metadata) exists — no content update method.
- Enforcement remains jurisdiction-dependent; evidence packs (later session)
  will reference `{ version, hash }` pairs rather than re-stating terms.
