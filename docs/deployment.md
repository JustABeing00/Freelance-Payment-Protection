# Deployment guide — FreelancePaymentProtection

> Goal: a solo founder can ship this to production without reading the
> source. Follow the steps in order. You do not need to understand the
> internals — only the checklist.

## 1. What you need

- A server (or container host) with Node 24+ **or** Docker.
- Postgres 16 (managed database recommended: e.g. Neon, Supabase,
  RDS — any Postgres 16 works).
- A domain name pointing at the server (for `APP_BASE_URL` + TLS).
- Optional, for real money: a Stripe account (secret key + webhook secret).
- Optional, for real mail/files: an email provider key and an S3-compatible
  bucket (until wired, the app runs with safe Noop seams — see §5).

## 2. Environment variables

Copy `.env.example` to `.env` and fill it in. Boot is **fail-closed**:
missing/invalid values throw before the server listens.

| Variable              | Required | Notes                                                        |
| --------------------- | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`        | Yes      | Postgres connection string. Never commit it.                 |
| `SESSION_SECRET`      | Yes      | ≥32 chars. Generate: `openssl rand -hex 32`.                 |
| `APP_BASE_URL`        | Yes      | Public URL, e.g. `https://pay.example.com`. Used in links.   |
| `STRIPE_SECRET_KEY`   | No*      | *Required for real checkout/refunds. Without it, checkout and refunds return `502` in production (fail-closed) — no fake payments are created. |
| `STRIPE_WEBHOOK_SECRET` | No*   | *Required for webhooks. Without it, `POST /api/v1/webhooks/payments` returns `502` — nothing is marked paid. |
| `MAGIC_LINK_TTL_HOURS`| No       | Portal-link TTL, default `168` (7d), max `720`.              |
| `STORAGE_*`           | No       | Reserved for the production bucket (see §5).                 |
| `EMAIL_*`             | No       | Reserved for the production mailer (see §5).                 |
| `PORT`                | No       | Default `3000`.                                              |
| `LOG_LEVEL`           | No       | Default `info`. Use `warn` in production if logs are noisy.  |
| `NODE_ENV`            | No       | Set `production` in production (enables HSTS + Secure cookies + provider fail-closed). |

Placeholders in `.env.example` (`changeme…`, `fpp_changeme`,
`no-reply@example.com`) are **dev-only** — never use them in production.
The `fpp_changeme` password in `docker-compose.yml` is local-dev only.

## 3. Database

1. Create the Postgres 16 database and set `DATABASE_URL`.
2. Apply migrations (production-safe, forward-only — never `migrate dev`
   against production):
   ```bash
   npm ci
   npm run prisma:deploy   # prisma migrate deploy
   ```
   This applies `0001_foundation` → `0011_notifications` in order, including
   the append-only guard triggers (events/payments/approvals/evidence) and
   the agreement/payment lifecycle guards.
3. Verify: `npx prisma validate`.

Rollback: migrations are additive. To roll back a deploy, redeploy the
previous image — do **not** hand-edit rows (financial history is
append-only; corrections are new rows — see `docs/incident-response.md`).

## 4. Deploy options

### Option A — Docker (recommended)

```bash
docker build -t fpp .
docker run -d --name fpp --restart unless-stopped \
  -p 3000:3000 --env-file .env fpp
```

Before first traffic, run migrations from any host with `DATABASE_URL` set
(`npm run prisma:deploy`).

### Option B — Node directly

```bash
npm ci
npm run build
npm run prisma:deploy
NODE_ENV=production npm start
```

Use a process manager (systemd, pm2) with `Restart=always`, and a reverse
proxy (Caddy/Nginx) terminating TLS in front of `localhost:3000`.

## 5. Providers (money, mail, files)

- **Payments (Stripe):** set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`,
  then register the webhook endpoint
  `POST {APP_BASE_URL}/api/v1/webhooks/payments` in the Stripe dashboard.
  Until both are set, checkout/refund/webhooks fail closed with `502`
  (by design — the app never fabricates payments).
- **Email:** until a real mailer is wired (`resolveEmailProvider` currently
  returns Noop outside tests), reminder/notification sends resolve to the
  Noop seam — rows stay `queued`. Do not promise clients email delivery
  until a provider is connected; in-app notifications work regardless.
- **Storage:** until a bucket is wired (`resolveStorageProvider` returns
  Noop outside tests), signed URLs are `noop://` placeholders. Wire the
  production bucket with `Content-Disposition: attachment` + `nosniff`
  response headers before sending clients final-download links.

## 6. TLS + security headers

- Terminate TLS at the proxy; the app sets HSTS (1 year, subdomains) when
  `NODE_ENV=production`, plus CSP (`'self'` only, no inline script/style),
  `nosniff`, and `frame-ancestors 'none'` on every response.
- Session cookies are `HttpOnly` + `SameSite=Lax`, with `Secure` in
  production. Keep `APP_BASE_URL` https in production or cookies break.

## 7. Verify the deploy (do all of these)

```bash
curl https://pay.example.com/health
# expect: {"status":"ok","version":"…","db":"up", …}
```

- [ ] `/health` returns `db:"up"` (not `"down"`).
- [ ] `GET /api/v1/disclaimer` returns the disclaimer copy.
- [ ] Signup → signin → create client/project works; signout clears the cookie.
- [ ] Unknown webhook signature → `400`; missing webhook secret → `502`.
- [ ] Checkout without `STRIPE_SECRET_KEY` → `502` (no fake payment row).
- [ ] Response headers include `content-security-policy`,
      `strict-transport-security`, `x-content-type-options: nosniff`.
- [ ] Logs are JSON (Pino) with secrets redacted (`[REDACTED]`).

## 8. What is intentionally NOT in production yet

- No built-in scheduler: reminder/notification ticks (`run-due`,
  `dispatch-due`, `check-overdue`) are API calls — schedule them (see
  `docs/operations.md` §3).
- No error-reporting vendor (Sentry etc.) — logs + `/health` are the
  monitoring baseline (see `docs/operations.md` §2).
- No session revocation list (sign-out is client-side discard) and no
  CAPTCHA/lockout on auth beyond rate limits (30/min per route + 120/min
  global). Add these when abuse appears — the triggers are in
  `docs/operations.md` §6.
