# Security Principles — FreelancePaymentProtection

Version: 0.1.0 (Session 01 — normative for all future sessions)
Companion: `docs/product-requirements.md`, `docs/domain-model.md`

## 1. Core Tenets

1. **Tenant isolation is load-bearing.** `workspace_id` on every row; every query scoped; every test proves cross-tenant denial. Object-level authz (not just route guards).
2. **Verified provider events determine payment state.** Client assertions never mark paid. Webhooks signature-verified, timestamp-tolerated, idempotent, logged.
3. **Append-only financial + evidence history.** No silent rewrites. Corrections are new rows. App DB role has no UPDATE/DELETE on `events, payments, approvals, agreements` (enforce in migration; fallback: single-writer + tests).
4. **Least privilege + explicit release.** Final files private by default; release is a gated event, not a URL guess. Manual override requires reason and is flagged.
5. **No custodial money, no guaranteed-payment claims.** Reduces money-transmitter + fraud surface and legal risk.
6. **Neutral, non-threatening automation.** No auto legal threats; no dark patterns.
7. **Minimal PII, hashed telemetry.** Hash IP/UA for receipts; retention policy defined before launch.

## 2. Authentication & Sessions (freelancer)

- Password hashing: argon2id (preferred) or bcrypt with work factor ≥12 via vetted auth library; never custom crypto.
- Session: httpOnly, Secure, SameSite=Lax cookies (or provider session); short access + rotating refresh; logout invalidates server-side.
- MFA: TOTP post-MVP; architecture must leave hook (e.g., `mfa_secret` nullable from day one — decided Session 01, implement later).
- Rate-limit login + magic-link issuance; constant-time token compare; lockout with backoff + audit event.
- OAuth (future): allowlist providers, verify `aud/iss/exp`, bind to existing email only with verification.

## 3. Client Portal Access (magic links)

- Tokens: CSPRNG ≥256-bit, stored as hash (sha256), single-project scope (`project_id` bound), expiring (default 7d, max 30d), single-use-optional + rotation.
- Transport: HTTPS only; link sent to client email on file; portal shows minimal data (that project only).
- Forwarding risk: expiry + scope + rotation + view logging. "Revoke link" action rotates immediately.
- No client password in MVP; no cross-project enumeration (random UUIDs, no sequential IDs in URLs).

## 4. Authorization Model

- Roles MVP: `workspace_owner` (full), future `member`, `accountant_readonly`.
- Enforcement: server-side policy function per resource (`can(user, action, resource)`), called on every handler; client-side hiding is UX only.
- Tenant check order: authenticate → load workspace membership → scope query by `workspace_id` → object check.
- Tests required: cross-workspace read/write/list must 403/404 (no oracle leak — use 404 for existence hiding on client portal, 403 internally with log).

## 5. Payment Security

- No raw card data touches our servers. Use provider Elements/Checkout; PCI scope = provider.
- Webhooks: verify signature (e.g., `Stripe-Signature`), enforce timestamp tolerance, idempotency-key dedupe, persist raw event id + type before side effects; return 200 only after durable ingest; background projection after.
- Amount validation: webhook amount must match expected milestone/request within tolerance; mismatch → flag `needs_review`, never auto-release.
- Refund/dispute webhooks: transition payment only, never auto-unrelease delivered files; flag for human review.

## 6. Evidence Integrity

- Events: `seq` monotonic per project + `occurred_at` (UTC) + `recorded_at` + actor + payload hash. Future: `prev_hash` chain + periodic anchoring (do not build in MVP, but keep column plan).
- File artifacts: store sha256 of preview + final at upload; export includes hashes so tampering is detectable.
- No UPDATE/DELETE grants for app role on evidence tables (migration-level). Admin/backfill path separate, logged, never used for history edits.
- Export signing: MVP includes sha256 manifest; future: detached signature / third-party timestamp.

## 7. File Storage & Delivery

- Storage abstraction (local/S3-compatible). Private bucket by default; no public-read.
- Final files: signed, short-lived URLs only after `DeliverableReleased` (or override). Preview: signed URLs with watermark/low-res variant; `Content-Disposition: inline` for view-only where feasible.
- Upload validation: size caps, MIME allowlist, extension check, virus-scan hook (future), random object keys (UUID), no user-controlled paths.
- Download/view logging: best-effort receipts marked as such (proxy-open caveat).

## 8. Email & Notification Safety

- SPF/DKIM/DMARC before production reminders (ops checklist).
- Templates: no executable content; escape all user input; no sensitive links beyond scoped magic-link.
- Unsubscribe + bounce handling; frequency caps + quiet hours to avoid spam classification.
- Reminder sender: system address (`no-reply@` / workflow address), neutral voice.

## 9. Input Validation & Injection

- Server-side validation on all inputs (zod/equivalent schema per route); reject unknown fields.
- SQL: parameterized ORM only; no string-concatenated queries.
- XSS: framework auto-escaping + CSP header; client portal especially hardened (untrusted freelancer content rendered to client).
- CSRF: SameSite + token for cookie sessions; magic-link portal uses GET-view but POST-mutations require token.
- SSRF: no user-fetched URLs in MVP (no link-preview fetcher); if added later, egress allowlist.

## 10. Secrets & Environment

- Required vars (to be finalized Session 02): `DATABASE_URL, SESSION_SECRET, APP_BASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STORAGE_* (endpoint/bucket/key), EMAIL_* (provider/key/from), MAGIC_LINK_TTL`.
- Never commit secrets. `.env.example` with placeholders only. Fail-closed boot if required vars missing.
- Secret rotation: documented procedure (future ops doc).

## 11. Logging & Privacy

- Log: actor, action, resource id, timestamp, outcome. Do NOT log: passwords, full tokens, card data, full IPs beyond hashed form (store `ip_hash` salted).
- Retention: auth audit ≥12mo; view receipts ≤12mo or per policy; financial events per legal retention (to be confirmed with counsel).
- GDPR/data-deletion tension: evidence immutability vs erasure — default direction: anonymize PII (hash/drop) while preserving financial facts + hashes; exact rule is an open product question (see PRD §15). Do not implement deletion until decided.

## 12. Abuse Scenarios & Mitigations

| Abuse | Mitigation |
|-------|------------|
| Freelancer edits history to fake approval/payment | Append-only + no UPDATE grants + hash manifest; override flagged |
| Client scrapes other projects via URL tampering | UUIDs + scope check + deny+log + tests |
| Client claims "I paid" to unlock files | Claim ≠ paid; gate requires provider event |
| Replay webhook to double-credit | Idempotency keys + provider id dedupe |
| Reminder spam / harassment via automation | Caps, quiet hours, neutral copy, unsubscribe, audit |
| Magic-link forward to third party | Expiry, scope, rotation, minimal data |
| Malicious file upload | MIME allowlist, size cap, random keys, private bucket, scan hook |
| Credential stuffing | Rate limit, backoff, breach-password screening (future) |
| Insider (freelancer) early release then dispute | Override requires reason, flagged in export |

## 13. Compliance Boundaries (repeat — must appear in code + copy)

- No guaranteed-payment / insurance language anywhere in UI, email, or export.
- Evidence pack header: "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent."
- Late-fee feature: behind explicit opt-in + disclaimer ("Confirm compliance with your local law").
- No escrow/custody: never hold client funds; provider settles directly.

## 14. MVP Security Checklist (for Session 02+ implementers)

- [ ] Tenant-scoped queries + cross-tenant tests.
- [ ] Webhook signature verify + idempotency tests.
- [ ] Append-only migration guards (revoke UPDATE/DELETE) + attempt-to-mutate test.
- [ ] Magic-link hash/scope/expiry + revoke test.
- [ ] Signed-URL gating test (final unreachable before release).
- [ ] Version-pinned approval test (old approval ≠ new version release).
- [ ] Claim-≠-paid test.
- [ ] Rate-limit + security headers (CSP, HSTS, X-Content-Type-Options) test.
- [ ] `.env.example` + fail-closed config test.
- [ ] Disclaimer copy present in portal + export templates.

## 15. Deferred (explicitly not MVP)

- MFA enforcement, SSO, full RBAC matrix, hash-chained anchoring, KMS envelope encryption, SOC2 audit trail export, WAF/rate-limit distributed store.
