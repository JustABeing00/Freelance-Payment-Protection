# Security audit — hostile review (Session 19, v0.18.0 → v0.18.1)

Method: read `progress.md`, inventoried every route (`src/routes/*`), auth/session/
tenant/magic-link/webhook/unsubscribe/provider/store libs, then **attempted live
exploitation** via throwaway `app.inject` probes (deleted afterwards) before fixing.
Permanent exploit-regression tests live in `tests/integration/securityAudit.test.ts`
(7 tests, all green; full suite 332/332).

Scope: the whole HTTP application — authentication, authorization/IDOR, CSRF, XSS,
webhook spoofing/replay, payment tampering, duplicate processing, race conditions,
privilege escalation, sessions, secrets, logging, PII, tenant isolation, rate
limiting/abuse, enumeration, portal-token leakage, signed-URL abuse, file upload,
path traversal, audit-log manipulation. No new product features were added; every
change below is a vulnerability fix or a hardening fix with no behaviour change
for legitimate callers.

## Verdict on the session's attack questions

| Question | Answer |
|---|---|
| Can User A access User B's project/payment/deliverable by changing an ID? | **No**, except VULN-001 (fixed). Every other IDOR probe returned generic 403/404. |
| Can a malicious browser claim a payment succeeded? | **No.** Claim → `claimed_unverified` only; success page is read-only; `paid` requires a signature-verified provider event or server-side retrieve. |
| Can a client access another client's deliverable? | **No.** Portal tokens are single-project scoped (401 cross-project); deliverable rows are re-scoped per request; final keys never leak pre-release. |
| Can an attacker replay a webhook? | **No effect.** Persistent `WebhookReceived` UNIQUE marker + in-memory fast path → replay is a safe `duplicate: true` no-op. |
| Can a freelancer modify historical evidence? | **No.** Append-only triggers + idempotency uniques; timeline URLs answer 405 to every write-shaped method. |
| Can an unpaid deliverable be downloaded? | **No.** Preview/final gates return 423 LOCKED until released; release requires approval + verified payment (or an audited manual override). |

## Confirmed + fixed

### VULN-001 — Checkout idempotency-key cross-tenant payment disclosure (medium)
`POST …/milestones/:mid/checkout` looked up the caller-supplied `idempotencyKey`
**globally** (`findPaymentByIdempotencyKey` has no workspace scope) and returned the
found row as `duplicate: true` **without re-scoping it**. Proven: attacker in
workspace B reused victim workspace A's key `predictable-key-001` and received
HTTP 200 containing the victim's payment id, workspace/project/milestone ids,
`providerPaymentId`, and `amountCents: 77700`. Impact: cross-tenant financial/PII
read + UUID harvesting for follow-up IDOR probes. (The global UNIQUE still
prevented any double-charge.)
Fix (`src/routes/payments.ts`): the duplicate shortcut now returns the row only
when `existing.workspaceId` **and** `existing.projectId` match the URL scope;
otherwise it throws a bare 409 with no row data. Remaining key-existence oracle
(409 vs 201) is inherent to global idempotency keys — Stripe behaves identically —
and leaks no amounts or ids. Regression test pins 409 + absence of victim ids/amount.
Note: `Idempotency-Key` header and body key share this path; both are covered.
The portal `pay` path uses deterministic per-milestone keys inside an already
project-scoped authorizer, so it was not exploitable the same way (verified).

### VULN-002 — Non-web redirect targets accepted on checkout (low)
`successUrl`/`cancelUrl` used bare `z.string().url()`, which accepts
`javascript:`/`data:` schemes (proven: `javascript:alert(1)` → 201). Today the
values are only forwarded to the payment provider (Stripe validates; fake/noop
ignore them) and never reflected, so impact was nil — but any future echo would
be stored-XSS fuel.
Fix (`src/routes/payments.ts`): new `httpUrlSchema` requires `http://`/`https://`;
`javascript:`/`data:` now get 422. Legitimate `https://` + local `http://`
redirects still pass (pinned by test).

### VULN-003 — Portal timeline authorizer missed the workspace-drift check (low, defense in depth)
`registerPortalTimelineRoutes.loadPortal` (`src/routes/timeline.ts`) verified
scope/expiry/revocation but — unlike every other portal authorizer
(`portal.ts`, `paymentPlans.ts`, deliverables) — never compared
`link.workspaceId` to `project.workspaceId`. Unreachable today (links are minted
with the project's workspace), but a single inconsistent row would have bypassed
tenant checks. Fixed to match the other authorizers (generic 401, no oracle).

### VULN-004 — Final-download endpoints could resolve non-final files by name (low, hygiene)
Freelancer `signedDownload(…, "final")` matched `?file=` against **all** version
files, and the portal final endpoint fell back through review files
(`finals[0] ?? version.files[0]`). Pre-release this was unreachable (the 423 lock
runs first — proven by probe), but post-release a `?file=<review-name>` request
served a review object as the "final". Fix (`src/routes/deliverables.ts`): both
endpoints now select strictly within `visibility === "final"` files; a released
version with no final file is 404, never a review file in disguise. Existing
deliverable tests (423 pre-release, 200 post-release, key non-leak) still pass.

## Attempted, did not break (invariants re-pinned by tests)

- **Auth/session:** scrypt passwords; stateless HMAC `s1.*` tokens with 32-char
  secret floor, expiry, constant-time compare; identity only from verified
  session; generic "Invalid credentials" on signin (no oracle); 12→256 char
  password floor on signup; password change requires current password.
- **Authz/IDOR:** membership → write-role → `assertResourceInWorkspace` on every
  handler probed (projects, timelines, payments, notifications, deliverables,
  evidence packs, payment plans, approvals, milestones); cross-tenant reads give
  generic 403/404. `createProject`/`updateProject` re-validate `client.workspaceId`
  in the store (no tenant escape via `clientId`).
- **Privilege escalation:** `accountant_readonly` blocked from writes and member
  management (403, probed); member invite is owner-only and checked before the
  email lookup (no user-enumeration oracle there).
- **Portal tokens:** HMAC-SHA256, project-bound, expiring, sha256-stored,
  revocation-checked; cross-project use → 401 (probed, incl. timeline);
  token-in-URL is by design (clients have no accounts) and never logged
  (pino redact paths cover token/cookie/authorization).
- **Payments:** claim ≠ paid; success page read-only; checkout caps amount at
  outstanding, enforces milestone currency, never marks paid; webhook requires
  `t,v1` HMAC within 300 s, amount/currency mismatch → `needs-review` (no
  release), illegal/out-of-order transitions keep local state with an audit note;
  refund/cancel/reconcile are write-role + verified-state gated.
- **Deliverables/release:** `checkRelease` needs approval + verified-paid; empty
  and blank manual overrides are rejected (probed); overrides are flagged audit
  events, never silent; milestone amount edits freeze after funding (audited
  amount route instead); new versions reset stale approvals.
- **Uploads/traversal:** object keys are server-minted UUID paths (never user
  input); filenames sanitized; content-types allowlisted; sizes/counts capped;
  links + staging URLs must be `https://` (no `javascript:`/`data:` smuggling);
  signed TTLs clamped (preview ≤ 1 h, final ≤ 15 min).
- **XSS:** every server-rendered page escapes via `escapeHtml` (portal, app
  pages, evidence HTML); email HTML is escaped text (no `href` injection —
  `portalUrl` renders as text); CSP (`default/script/style/connect 'self'`,
  `frame-ancestors 'none'`), no inline script/style; portal JS is a static file.
- **SSRF:** the server never fetches user-supplied URLs (no fetch on
  success/cancel/staging/link inputs); only Stripe API + provider page are
  contacted. None found.
- **Audit log:** DB no-update triggers + idempotency uniques; write-shaped
  timeline requests → explicit 405 `IMMUTABLE_HISTORY`; evidence packs are new
  immutable rows with sha256 pins and factual drift reporting.
- **Secrets/logging:** `.env` gitignored, `.env.example` placeholders only;
  fail-closed env validation; webhook endpoints fail closed without a secret;
  no secrets in repo; 500s hide internals in production; device metadata stored
  as sha256 hashes only; error envelope carries `requestId`, not internals.

## Accepted risks / follow-ups (deliberately NOT changed this session)

1. **Signup email oracle (low):** duplicate signup returns 409 "Email already
   registered", letting a rate-limited (30/min) attacker test email existence.
   True fix (fake-success) would wreck UX; industry-standard tradeoff. Mitigated
   by per-route rate limiting + generic signin errors. Revisit with CAPTCHA/
   abuse detection if signup abuse appears.
2. **No server-side session revocation (low):** sign-out is client discard +
   cookie clear (documented in code). Stolen tokens live ≤ 7 d. Follow-up: token
   version/denylist column.
3. **CSRF posture (low):** no anti-CSRF tokens, but state changes require
   `application/json` (simple form POSTs fail parsing) **and** the session
   cookie is `SameSite=Lax` (+ `Secure`/`HttpOnly` in prod), so cross-site POST
   CSRF is blocked at the cookie layer. Revisit with explicit CSRF tokens if
   cookie-authenticated writes ever accept form encodings.
4. **Public-endpoint rate limits:** unsubscribe confirm, portal reads, and the
   webhook rely on the global 120/min limiter. All require unforgeable
   credentials (signed token / magic link / webhook HMAC), so they cannot be
   leveraged for spam or spoofing; per-route tightening is optional.
5. **Concurrent opposing webhooks (low):** two different provider events racing
   (e.g. succeeded vs refunded) both pass their own idempotency markers; last
   writer wins the payment row but **both** events stay in the audit trail and
   the reconciliation run converges drift. A compare-and-swap on payment state
   would narrow the window — future work, not a silent-corruption bug.
6. **Single-process webhook fast path:** `seenWebhookIds` is in-memory; across
   restarts/processes the DB `WebhookReceived` UNIQUE marker is authoritative
   (by design). Multi-instance deployments must keep relying on the DB marker.
7. **Storage XSS when a real bucket is wired:** `text/html` and `image/svg+xml`
   are in the upload allowlist. Files are only served via signed URLs, so the
   production bucket **must** serve with `Content-Disposition: attachment` +
   `X-Content-Type-Options: nosniff` (and ideally a separate domain); otherwise
   an uploaded SVG/HTML opened inline could script in the bucket origin.
8. **Workspace-roster PII (by design):** member list and notification audit rows
   (incl. client emails) are visible to workspace members incl. read-only roles
   — required for the audit use-case. No change; noted for future per-role
   redaction if workspaces grow beyond trusted teams.
9. **Evidence packs are freelancer-only** (contain client PII such as billing
   email) and have no portal route — correct; keep it that way.

## Files changed (session 19)

- `src/routes/payments.ts` — VULN-001 scoping + `httpUrlSchema` (VULN-002).
- `src/routes/timeline.ts` — portal `loadPortal` workspace-drift check (VULN-003).
- `src/routes/deliverables.ts` — finals-only resolution on both final endpoints (VULN-004).
- `tests/integration/securityAudit.test.ts` — new, 7 exploit-regression tests.
- `docs/security-audit.md` — this file.
- `progress.md` — session entry.
