/**
 * Provider interfaces (boring-technology seams). MVP wires one provider behind
 * each interface; multi-provider comes later. No custodial money ever flows
 * through these — providers settle directly to the freelancer (PRD §5.2).
 */

export interface CreateCheckoutSessionArgs {
  paymentId: string;
  workspaceId: string;
  projectId: string;
  milestoneId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
}

export interface CheckoutSession {
  providerPaymentId: string;
  checkoutUrl: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentRequest(args: {
    milestoneId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ providerPaymentId: string; checkoutUrl?: string }>;
  /** Hosted checkout: card entry happens on the provider page, never here. */
  createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<CheckoutSession>;
  /** Reverse a verified payment (refunds settle via the provider). */
  refundPayment(args: {
    providerPaymentId: string;
    amountCents?: number | undefined;
  }): Promise<{ refundId: string }>;
  /** Verified read-back for reconciliation (no state change by itself). */
  retrievePayment(args: { providerPaymentId: string }): Promise<{
    status: string;
    amountCents: number;
    currency: string;
  }>;
}

export interface StorageProvider {
  readonly name: string;
  /** Returns an opaque object key (UUID-based, never user-controlled paths). */
  putObject(args: {
    key: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<{ key: string }>;
  /** Signed, short-lived URL. Finals only issued after release. */
  signedUrl(args: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
}

export interface EmailProvider {
  readonly name: string;
  send(args: { to: string; subject: string; text: string; html?: string }): Promise<{
    providerMessageId: string;
  }>;
}

/** No-op implementations keep dev/test running without credentials. */
export class NoopPaymentProvider implements PaymentProvider {
  readonly name = "noop";
  createPaymentRequest(args: {
    milestoneId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ providerPaymentId: string }> {
    return Promise.resolve({
      providerPaymentId: `noop_${args.milestoneId}_${args.idempotencyKey}`,
    });
  }
  createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<CheckoutSession> {
    const pid = `noop_${args.milestoneId}_${args.idempotencyKey}`;
    return Promise.resolve({
      providerPaymentId: pid,
      checkoutUrl: `noop://checkout/${pid}?amount=${args.amountCents}&currency=${args.currency}`,
    });
  }
  refundPayment(args: {
    providerPaymentId: string;
    amountCents?: number | undefined;
  }): Promise<{ refundId: string }> {
    return Promise.resolve({ refundId: `noop_re_${args.providerPaymentId}` });
  }
  retrievePayment(args: { providerPaymentId: string }): Promise<{
    status: string;
    amountCents: number;
    currency: string;
  }> {
    return Promise.resolve({ status: "unknown", amountCents: 0, currency: "USD", ...args });
  }
}

/**
 * Deterministic fake provider for tests/dev (no network, no secrets).
 * Returns stable hosted-checkout URLs and remembers sessions so
 * retrieve/refund behave like a real provider ledger.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake";
  private readonly sessions = new Map<
    string,
    { amountCents: number; currency: string; status: string }
  >();

  createPaymentRequest(args: {
    milestoneId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ providerPaymentId: string; checkoutUrl?: string }> {
    const providerPaymentId = `fake_${args.milestoneId}_${args.idempotencyKey}`;
    this.sessions.set(providerPaymentId, {
      amountCents: args.amountCents,
      currency: args.currency.toUpperCase(),
      status: "pending",
    });
    return Promise.resolve({
      providerPaymentId,
      checkoutUrl: `https://checkout.example/pay/${providerPaymentId}`,
    });
  }

  createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<CheckoutSession> {
    // Idempotent by paymentId: same payment → same provider session.
    const providerPaymentId = `fake_pi_${args.paymentId.replace(/-/g, "").slice(0, 12)}_${args.idempotencyKey.slice(0, 8)}`;
    const existing = this.sessions.get(providerPaymentId);
    if (!existing) {
      this.sessions.set(providerPaymentId, {
        amountCents: args.amountCents,
        currency: args.currency.toUpperCase(),
        status: "pending",
      });
    }
    return Promise.resolve({
      providerPaymentId,
      checkoutUrl: `https://checkout.example/pay/${providerPaymentId}?amount=${args.amountCents}&currency=${args.currency.toUpperCase()}`,
    });
  }

  refundPayment(args: {
    providerPaymentId: string;
    amountCents?: number | undefined;
  }): Promise<{ refundId: string }> {
    const session = this.sessions.get(args.providerPaymentId);
    if (!session) throw new Error(`Unknown provider payment ${args.providerPaymentId}`);
    session.status = "refunded";
    return Promise.resolve({ refundId: `fake_re_${args.providerPaymentId}` });
  }

  retrievePayment(args: { providerPaymentId: string }): Promise<{
    status: string;
    amountCents: number;
    currency: string;
  }> {
    const session = this.sessions.get(args.providerPaymentId);
    if (!session) throw new Error(`Unknown provider payment ${args.providerPaymentId}`);
    return Promise.resolve({ ...session });
  }

  /** Test seam: drive the fake ledger to a provider-side status. */
  setStatus(providerPaymentId: string, status: string): void {
    const session = this.sessions.get(providerPaymentId);
    if (session) session.status = status;
  }
}

/**
 * Stripe provider (reputable payment provider, no escrow, no card storage).
 * Cards are entered on Stripe-hosted Checkout; this class only creates
 * checkout sessions / refunds / verified reads via the Stripe REST API.
 * No Stripe SDK dependency — plain fetch keeps the install lean.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe";
  constructor(private readonly secretKey: string) {
    if (!secretKey) throw new Error("Stripe secret key is required (fail-closed)");
  }

  createPaymentRequest(args: {
    milestoneId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ providerPaymentId: string; checkoutUrl?: string }> {
    return this.createCheckoutSession({
      paymentId: args.milestoneId,
      workspaceId: "",
      projectId: "",
      milestoneId: args.milestoneId,
      amountCents: args.amountCents,
      currency: args.currency,
      idempotencyKey: args.idempotencyKey,
    });
  }

  async createCheckoutSession(args: CreateCheckoutSessionArgs): Promise<CheckoutSession> {
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("line_items[0][price_data][currency]", args.currency.toLowerCase());
    params.set("line_items[0][price_data][product_data][name]", `Milestone payment`);
    params.set("line_items[0][price_data][unit_amount]", String(args.amountCents));
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[paymentId]", args.paymentId);
    params.set("metadata[workspaceId]", args.workspaceId);
    params.set("metadata[projectId]", args.projectId);
    params.set("metadata[milestoneId]", args.milestoneId);
    if (args.successUrl) params.set("success_url", args.successUrl);
    if (args.cancelUrl) params.set("cancel_url", args.cancelUrl);
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": args.idempotencyKey,
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Stripe checkout creation failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      id?: string;
      url?: string;
      payment_intent?: string;
    };
    const providerPaymentId =
      typeof body.payment_intent === "string" && body.payment_intent.length > 0
        ? body.payment_intent
        : (body.id ?? `stripe_${args.paymentId}`);
    return {
      providerPaymentId,
      checkoutUrl: body.url ?? `https://checkout.stripe.com/pay/${providerPaymentId}`,
    };
  }

  async refundPayment(args: {
    providerPaymentId: string;
    amountCents?: number | undefined;
  }): Promise<{ refundId: string }> {
    const params = new URLSearchParams();
    params.set("payment_intent", args.providerPaymentId);
    if (args.amountCents !== undefined) params.set("amount", String(args.amountCents));
    const res = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Stripe refund failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as { id?: string };
    return { refundId: body.id ?? `re_${args.providerPaymentId}` };
  }

  async retrievePayment(args: { providerPaymentId: string }): Promise<{
    status: string;
    amountCents: number;
    currency: string;
  }> {
    const res = await fetch(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(args.providerPaymentId)}`,
      { headers: { authorization: `Bearer ${this.secretKey}` } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Stripe retrieve failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      status?: string;
      amount?: number;
      currency?: string;
    };
    return {
      status: typeof body.status === "string" ? body.status : "unknown",
      amountCents: typeof body.amount === "number" ? body.amount : 0,
      currency: typeof body.currency === "string" ? body.currency.toUpperCase() : "USD",
    };
  }
}

/** Resolve the provider from env: live Stripe when keyed, else fake/noop. */
export function resolvePaymentProvider(env: {
  STRIPE_SECRET_KEY?: string | undefined;
  NODE_ENV?: string | undefined;
}): PaymentProvider {
  if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.length > 0) {
    return new StripePaymentProvider(env.STRIPE_SECRET_KEY);
  }
  if (env.NODE_ENV === "test") return new FakePaymentProvider();
  return new NoopPaymentProvider();
}

export class NoopStorageProvider implements StorageProvider {
  readonly name = "noop";
  putObject(args: { key: string; contentType: string; sizeBytes: number }): Promise<{
    key: string;
  }> {
    return Promise.resolve({ key: args.key });
  }
  signedUrl(args: { key: string; expiresInSeconds: number }): Promise<{ url: string }> {
    return Promise.resolve({ url: `noop://signed/${args.key}?exp=${args.expiresInSeconds}` });
  }
}

/**
 * Deterministic fake object store for tests/dev (no network, no bucket).
 * Records puts in memory and mints fake signed URLs carrying the key +
 * expiry so tests can assert gating without real credentials.
 */
export class FakeStorageProvider implements StorageProvider {
  readonly name = "fake";
  private readonly objects = new Map<string, { contentType: string; sizeBytes: number }>();

  putObject(args: { key: string; contentType: string; sizeBytes: number }): Promise<{
    key: string;
  }> {
    this.objects.set(args.key, { contentType: args.contentType, sizeBytes: args.sizeBytes });
    return Promise.resolve({ key: args.key });
  }

  signedUrl(args: { key: string; expiresInSeconds: number }): Promise<{ url: string }> {
    if (!this.objects.has(args.key)) {
      return Promise.resolve({
        url: `https://storage.example/signed/${encodeURIComponent(args.key)}?exp=${args.expiresInSeconds}`,
      });
    }
    return Promise.resolve({
      url: `https://storage.example/signed/${encodeURIComponent(args.key)}?exp=${args.expiresInSeconds}`,
    });
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

/** Resolve the storage seam: fake in tests, noop otherwise (no bucket yet). */
export function resolveStorageProvider(env: { NODE_ENV?: string | undefined }): StorageProvider {
  if (env.NODE_ENV === "test") return new FakeStorageProvider();
  return new NoopStorageProvider();
}

export class NoopEmailProvider implements EmailProvider {
  readonly name = "noop";
  send(args: { to: string; subject: string; text: string }): Promise<{
    providerMessageId: string;
  }> {
    return Promise.resolve({ providerMessageId: `noop_${args.to}_${Date.now()}` });
  }
}

/**
 * Deterministic fake mailer for tests/dev (no network, no credentials).
 * Records every send so integration tests can assert recipient / subject /
 * template rendering without SMTP. `failNext()` makes the next send throw,
 * exercising the retry-safe path (`failed` + `lastError` + `attemptCount`).
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  readonly sent: { to: string; subject: string; text: string; html?: string }[] = [];
  private failuresLeft = 0;

  /** Test seam: the next `count` sends throw instead of delivering. */
  failNext(count = 1): void {
    this.failuresLeft += count;
  }

  async send(args: { to: string; subject: string; text: string; html?: string }): Promise<{
    providerMessageId: string;
  }> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("FakeEmailProvider simulated delivery failure");
    }
    this.sent.push({ ...args });
    // Await a resolved promise so the method stays genuinely async.
    await Promise.resolve();
    return { providerMessageId: `fake_msg_${this.sent.length}` };
  }

  clear(): void {
    this.sent.length = 0;
    this.failuresLeft = 0;
  }
}

/** Resolve the email seam: fake in tests, noop otherwise (no SMTP yet). */
export function resolveEmailProvider(env: { NODE_ENV?: string | undefined }): EmailProvider {
  if (env.NODE_ENV === "test") return new FakeEmailProvider();
  return new NoopEmailProvider();
}
