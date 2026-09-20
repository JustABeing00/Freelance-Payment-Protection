import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  canCancelPayment,
  canRefundPayment,
  EVENT_BY_PAYMENT_STATE,
  isVerifiedPaymentState,
  providerEventToState,
  stripeIntentStatusToState,
  transitionPayment,
  validateWebhookMoney,
} from "../domain/payments.js";
import {
  buildPaymentHistory,
  reconcileProject,
  settlementNote,
  verificationTierForPaymentState,
  type ReconcileEventInput,
} from "../domain/reconciliation.js";
import { confirmFunding, markClaimed } from "../domain/milestone.js";
import type { MilestoneState } from "../domain/milestone.js";
import { deriveUnlockStates } from "../domain/milestone.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { FakePaymentProvider, NoopPaymentProvider } from "../lib/providers.js";
import type { PaymentRecord, Store } from "../lib/store.js";
import { verifyWebhookSignature } from "../lib/webhook.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { notifyLifecycle } from "./notifications.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Payment integration (Session 08) — Stripe behind the provider seam.
 *
 * - No escrow, no custodial money, no raw card storage. Cards are entered on
 *   the provider's hosted checkout only; this API only creates checkout
 *   sessions and reacts to verified webhooks.
 * - Authoritative state comes ONLY from verified provider events (webhook
 *   signature + timestamp tolerance) or verified server-to-server retrieve.
 *   Browser return to a success page NEVER marks paid (the success page is a
 *   read-only receipt that says "confirming").
 * - Every transition appends an auditable `Payment*` event with an
 *   idempotency key (`webhook:<provider>:<eventId>:<state>` or
 *   `pay:<paymentId>:<state>`), so webhook replay is a safe no-op.
 * - Amount/currency mismatches never mark paid — they append
 *   `PaymentAmountMismatched` for human review.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});
const workspaceProjectMilestoneParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
});
const workspaceProjectPaymentParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  paymentId: uuidSchema,
});

/** Redirect targets must be real web URLs — never `javascript:`, `data:`, etc. */
const httpUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "must be an http(s) URL",
  });

const checkoutSchema = z.object({
  amountCents: z.number().int().min(1).max(999_999_999_999).optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  // Redirect targets are forwarded to the hosted provider page only. Restrict
  // to http(s) so a non-web scheme (e.g. `javascript:`) can never be stored
  // or reflected, even if a future provider echoes it back.
  successUrl: httpUrlSchema.optional(),
  cancelUrl: httpUrlSchema.optional(),
});

function serializePayment(p: PaymentRecord): Record<string, unknown> {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    projectId: p.projectId,
    ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
    provider: p.provider,
    providerPaymentId: p.providerPaymentId,
    amountCents: p.amountCents,
    currency: p.currency,
    state: p.state,
    ...(p.receivedAt ? { receivedAt: p.receivedAt.toISOString() } : {}),
    createdAt: p.createdAt.toISOString(),
  };
}

function verifiedSumFor(payments: readonly PaymentRecord[], milestoneId: string): number {
  let sum = 0;
  for (const p of payments) {
    if (p.milestoneId === milestoneId && isVerifiedPaymentState(p.state)) sum += p.amountCents;
  }
  return sum;
}

function strField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function numField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function toDomainMilestone(r: {
  id: string;
  projectId: string;
  title: string;
  description?: string | undefined;
  amountCents: number;
  currency: string;
  orderIndex: number;
  dueDate?: Date | undefined;
  workState: string;
  paymentState: string;
  approvalState: string;
  deliverableState: string;
  unlockState: string;
  appliedPaymentIds: readonly string[];
  amountHistory: readonly Record<string, unknown>[];
  approvedVersionId?: string | undefined;
  currentVersionId?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
}): MilestoneState {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    ...(r.description !== undefined ? { description: r.description } : {}),
    amountCents: r.amountCents,
    currency: r.currency,
    orderIndex: r.orderIndex,
    ...(r.dueDate !== undefined ? { dueDate: r.dueDate } : {}),
    work: r.workState as MilestoneState["work"],
    payment: r.paymentState as MilestoneState["payment"],
    approval: r.approvalState as MilestoneState["approval"],
    deliverable: r.deliverableState as MilestoneState["deliverable"],
    unlock: r.unlockState as MilestoneState["unlock"],
    appliedPaymentIds: [...r.appliedPaymentIds],
    amountHistory: r.amountHistory.map((h) => ({
      milestoneId: strField(h.milestoneId, r.id),
      oldAmountCents: numField(h.oldAmountCents, 0),
      newAmountCents: numField(h.newAmountCents, 0),
      reason: strField(h.reason, ""),
      actorId: strField(h.actorId, ""),
      changedAt:
        h.changedAt instanceof Date
          ? h.changedAt
          : new Date(strField(h.changedAt, new Date().toISOString())),
    })),
    ...(r.approvedVersionId !== undefined
      ? { approvedVersionId: r.approvedVersionId }
      : { approvedVersionId: null }),
    ...(r.currentVersionId !== undefined
      ? { currentVersionId: r.currentVersionId }
      : { currentVersionId: null }),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Seen provider event ids (fast path); the DB UNIQUE is authoritative. */
const seenWebhookIds = new Set<string>();

export function clearSeenWebhookIdsForTests(): void {
  seenWebhookIds.clear();
}

export function registerPaymentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;
  const provider =
    deps.paymentProvider ??
    (process.env.NODE_ENV === "test" ? new FakePaymentProvider() : new NoopPaymentProvider());
  const webhookSecret = () => {
    const s = deps.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!s) {
      throw new AppError(
        "PROVIDER_ERROR",
        "Payment webhooks are not configured (missing webhook secret)",
      );
    }
    return s;
  };

  async function refreshUnlocks(projectId: string): Promise<void> {
    const rows = await store.listMilestones(projectId);
    const derived = deriveUnlockStates(rows.map(toDomainMilestone));
    for (const d of derived) {
      const current = rows.find((r) => r.id === d.id);
      if (current?.unlockState !== d.unlock) {
        await store.updateMilestone(d.id, { unlockState: d.unlock });
      }
    }
  }

  /**
   * Apply a verified receipt to a milestone. Verified money is a fact and does
   * not wait for approval; release still requires approval + paid separately.
   * Partial receipts keep payment_pending; full coverage moves to paid.
   */
  async function applyVerifiedReceipt(
    milestoneId: string,
    paymentId: string,
    receivedCents: number,
  ): Promise<void> {
    const row = await store.findMilestone(milestoneId);
    if (!row) return;
    if (row.appliedPaymentIds.includes(paymentId)) return;
    const domain = toDomainMilestone(row);
    try {
      // confirmFunding records the receipt id; full vs partial decided below
      // from the ledger sum (payment just written is included by caller order —
      // here we sum stored payments + this receipt).
      const payments = await store.listPayments(row.projectId);
      const already = payments
        .filter((p) => p.milestoneId === milestoneId && isVerifiedPaymentState(p.state))
        .reduce((s, p) => s + p.amountCents, 0);
      const covered = already >= row.amountCents;
      if (domain.appliedPaymentIds.includes(paymentId)) return;
      let next = domain;
      try {
        next = confirmFunding(domain, paymentId, receivedCents);
      } catch {
        // Already funded/paid paths: fall through to coverage check.
        next = domain;
      }
      if (covered && next.payment !== "paid") {
        await store.updateMilestone(row.id, {
          paymentState: "paid",
          appliedPaymentIds: [...next.appliedPaymentIds],
        });
      } else if (
        next.payment !== domain.payment ||
        next.appliedPaymentIds.length !== domain.appliedPaymentIds.length
      ) {
        await store.updateMilestone(row.id, {
          paymentState: next.payment,
          appliedPaymentIds: [...next.appliedPaymentIds],
        });
      }
      await refreshUnlocks(row.projectId);
    } catch {
      // Best-effort: webhook already recorded the verified payment; milestone
      // projection retries on the next verified event/reconcile.
    }
  }

  /**
   * Load the three reconciliation sources (internal rows + milestones +
   * project totals + event timeline) into the pure domain input. Reports are
   * always recomputed — reconciliation never writes financial history.
   */
  async function loadReconcileInput(projectId: string): Promise<{
    projectId: string;
    projectTotalCents: number;
    projectCurrency: string;
    milestones: {
      id: string;
      title: string;
      amountCents: number;
      currency: string;
      orderIndex: number;
      paymentState: string;
      appliedPaymentIds: readonly string[];
    }[];
    payments: {
      id: string;
      milestoneId?: string | undefined;
      amountCents: number;
      currency: string;
      state: string;
      provider: string;
      providerPaymentId: string;
      createdAt: Date;
      receivedAt?: Date | undefined;
    }[];
    events: ReconcileEventInput[];
  }> {
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    const [milestoneRows, paymentRows, eventRows] = await Promise.all([
      store.listMilestones(projectId),
      store.listPayments(projectId),
      store.listProjectEvents(projectId, 100),
    ]);
    return {
      projectId,
      projectTotalCents: project.totalValueCents,
      projectCurrency: project.currency,
      milestones: milestoneRows.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        currency: m.currency,
        orderIndex: m.orderIndex,
        paymentState: m.paymentState,
        appliedPaymentIds: [...m.appliedPaymentIds],
      })),
      payments: paymentRows.map((p) => ({
        id: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
        amountCents: p.amountCents,
        currency: p.currency,
        state: p.state,
        provider: p.provider,
        providerPaymentId: p.providerPaymentId,
        createdAt: p.createdAt,
        ...(p.receivedAt !== undefined ? { receivedAt: p.receivedAt } : {}),
      })),
      events: eventRows.map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
        payload: { ...e.payload },
      })),
    };
  }

  function serializeReconciledPayment(p: PaymentRecord): Record<string, unknown> {
    const tier = verificationTierForPaymentState(p.state);
    return {
      ...serializePayment(p),
      verificationTier: tier,
      verified: isVerifiedPaymentState(p.state),
      settlement: settlementNote(p.provider, p.state),
    };
  }

  // ---- Freelancer: record a client payment claim (claimed != paid) ----
  // "Client says they paid" is recorded as `claimed_unverified` + a
  // `PaymentClaimed` event. It NEVER counts toward totals and NEVER marks
  // paid — only a verified provider receipt does that.
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/claim",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const milestone = await store.findMilestone(params.milestoneId);
      if (milestone?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, milestone);
      const claimSchema = z.object({ note: z.string().trim().max(500).optional() });
      const claimBody = parseOrThrow(claimSchema, request.body ?? {}, "Invalid claim");
      if (milestone.paymentState === "claimed_unverified") {
        return reply.status(200).send({
          duplicate: true,
          milestone: { id: milestone.id, payment: milestone.paymentState },
          message:
            "Claim already recorded — still NOT verified. Only a provider receipt counts as paid.",
        });
      }
      try {
        markClaimed(toDomainMilestone(milestone));
      } catch {
        throw AppError.unprocessable(
          `This milestone cannot take a claim from payment=${milestone.paymentState}`,
        );
      }
      await store.updateMilestone(milestone.id, { paymentState: "claimed_unverified" });
      try {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: milestone.id,
          type: "PaymentClaimed",
          actorType: "freelancer",
          actorId: user.id,
          idempotencyKey: `pay:${milestone.id}:claimed`,
          payload: {
            milestoneId: milestone.id,
            claim: "client says paid — NOT verified",
            ...(claimBody.note !== undefined ? { note: claimBody.note.slice(0, 500) } : {}),
          },
        });
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "CONFLICT") {
          return reply.status(200).send({
            duplicate: true,
            milestone: { id: milestone.id, payment: "claimed_unverified" },
            message:
              "Claim already recorded — still NOT verified. Only a provider receipt counts as paid.",
          });
        }
        throw err;
      }
      return reply.status(201).send({
        milestone: { id: milestone.id, payment: "claimed_unverified" },
        message:
          "Claim recorded: client says they paid. NOT verified — totals unchanged until the provider confirms.",
      });
    },
  );

  // ---- Freelancer: human-readable payment history (recomputed, read-only) ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/history",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const input = await loadReconcileInput(params.projectId);
      return {
        history: buildPaymentHistory(input),
        note: "Claims are labelled NOT-verified. Only provider-confirmed lines count as paid.",
      };
    },
  );

  // ---- Freelancer: full reconciliation (internal vs provider-verified vs milestones) ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/reconciliation",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const input = await loadReconcileInput(params.projectId);
      const payments = await store.listPayments(params.projectId);
      return {
        reconciliation: reconcileProject(input),
        payments: payments.map(serializeReconciledPayment),
        history: buildPaymentHistory(input),
        authoritativeNote:
          "Authoritative state comes from verified provider events only; success-page returns and client claims prove nothing.",
      };
    },
  );

  // ---- Freelancer: administrative diagnostics for mismatches ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/diagnostics",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const input = await loadReconcileInput(params.projectId);
      const report = reconcileProject(input);
      return {
        balanced: report.balanced,
        totals: report.totals,
        verification: report.verification,
        errors: report.mismatches.filter((m) => m.severity === "error"),
        warnings: report.mismatches.filter((m) => m.severity === "warning"),
        info: report.mismatches.filter((m) => m.severity === "info"),
        perMilestone: report.perMilestone,
        note: "Diagnostics are recomputed from stored rows + the event timeline. Resolving a mismatch means recording a new event (refund, verified receipt, correction) — never editing history.",
      };
    },
  );

  // ---- Freelancer: verify every open payment against the provider ----
  // Server-to-server read-back across the whole project. Converges drift and
  // re-applies verified receipts (including out-of-order confirmations that
  // landed after a refund/dispute attempt). Never rewrites money: illegal
  // jumps are recorded as needs-review, never forced.
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/reconciliation/run",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const queued = await store.listPayments(params.projectId);
      const results: Record<string, unknown>[] = [];
      for (const payment of queued) {
        if (
          payment.state !== "created" &&
          payment.state !== "pending" &&
          payment.state !== "processing" &&
          payment.state !== "paid" &&
          payment.state !== "partial" &&
          payment.state !== "received"
        ) {
          continue;
        }
        let remote: { status: string; amountCents: number; currency: string };
        try {
          remote = await provider.retrievePayment({ providerPaymentId: payment.providerPaymentId });
        } catch (err: unknown) {
          results.push({
            paymentId: payment.id,
            ok: false,
            error: err instanceof Error ? err.message : "provider unreachable",
          });
          continue;
        }
        const drift =
          remote.amountCents !== payment.amountCents ||
          remote.currency.toUpperCase() !== payment.currency.toUpperCase();
        const mapped =
          stripeIntentStatusToState(remote.status) ?? providerEventToState(remote.status);
        if (!drift && mapped && mapped !== payment.state) {
          try {
            const next = transitionPayment(payment.state, mapped);
            await store.updatePaymentLifecycle(payment.id, { state: next });
            try {
              await store.appendProjectEvent(params.workspaceId, params.projectId, {
                ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
                type: EVENT_BY_PAYMENT_STATE[next] ?? "PaymentReconciled",
                actorType: "system",
                idempotencyKey: `pay:${payment.id}:reconcile:${remote.status}`,
                payload: {
                  paymentId: payment.id,
                  from: payment.state,
                  to: next,
                  remote,
                  runBy: user.id,
                },
              });
            } catch (err: unknown) {
              if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
            }
            if (next === "paid" && payment.milestoneId) {
              await applyVerifiedReceipt(payment.milestoneId, payment.id, payment.amountCents);
            }
            results.push({ paymentId: payment.id, ok: true, transitioned: true, to: next, drift });
          } catch {
            try {
              await store.appendProjectEvent(params.workspaceId, params.projectId, {
                ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
                type: "PaymentReconciled",
                actorType: "system",
                idempotencyKey: `pay:${payment.id}:reconcile:${remote.status}:${Date.now()}`,
                payload: {
                  paymentId: payment.id,
                  remote,
                  note: "illegal transition; kept local state for review",
                  runBy: user.id,
                },
              });
            } catch {
              // Non-fatal.
            }
            results.push({
              paymentId: payment.id,
              ok: true,
              transitioned: false,
              drift,
              needsReview: true,
            });
          }
        } else {
          try {
            await store.appendProjectEvent(params.workspaceId, params.projectId, {
              ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
              type: "PaymentReconciled",
              actorType: "system",
              idempotencyKey: `pay:${payment.id}:reconcile:${remote.status}:${remote.amountCents}`,
              payload: { paymentId: payment.id, remote, drift, runBy: user.id },
            });
          } catch (err: unknown) {
            if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
          }
          results.push({ paymentId: payment.id, ok: true, transitioned: false, drift });
        }
      }
      const fresh = await loadReconcileInput(params.projectId);
      return {
        results,
        reconciliation: reconcileProject(fresh),
        history: buildPaymentHistory(fresh),
      };
    },
  );

  // ---- Freelancer: create a hosted checkout for a milestone ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/checkout",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const milestone = await store.findMilestone(params.milestoneId);
      if (milestone?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, milestone);

      const body = parseOrThrow(checkoutSchema, request.body ?? {}, "Invalid checkout request");
      // Fail-closed in production: without a real provider (Stripe) there is
      // no hosted checkout to send the client to. A Noop "checkout" would
      // create pending rows with noop:// URLs that look like real payments.
      if (deps.isProduction && provider.name === "noop") {
        throw new AppError(
          "PROVIDER_ERROR",
          "Payments are not configured (missing STRIPE_SECRET_KEY); checkout is disabled until a provider is connected",
        );
      }
      const headerKey = request.headers["idempotency-key"];
      const key =
        body.idempotencyKey ??
        (typeof headerKey === "string" && headerKey.trim().length > 0 ? headerKey.trim() : null) ??
        `checkout:${milestone.id}:${Date.now()}:${randomUUID().slice(0, 8)}`;

      const existing = await store.findPaymentByIdempotencyKey(key);
      if (existing) {
        // Idempotency keys are caller-chosen and looked up globally, so the
        // stored row MUST be re-scoped before it is returned: otherwise any
        // authenticated user could replay another workspace's key and read
        // that workspace's payment (amounts, provider refs, project and
        // milestone ids). Out-of-scope repeats get a bare 409 — the global
        // UNIQUE still stops a double-charge — with no row data attached.
        if (
          existing.workspaceId !== params.workspaceId ||
          existing.projectId !== params.projectId
        ) {
          throw AppError.conflict("Payment already exists for this idempotency key");
        }
        return reply.status(200).send({
          payment: serializePayment(existing),
          duplicate: true,
          message: "Checkout already created for this idempotency key.",
        });
      }

      const currency = (body.currency ?? milestone.currency).toUpperCase();
      if (currency !== milestone.currency.toUpperCase()) {
        throw AppError.unprocessable("Checkout currency must match the milestone currency");
      }
      const payments = await store.listPayments(params.projectId);
      const received = verifiedSumFor(payments, milestone.id);
      const remaining = milestone.amountCents - received;
      if (remaining <= 0 || milestone.paymentState === "paid") {
        throw AppError.conflict("This milestone is already paid — thank you.");
      }
      const amount = body.amountCents ?? remaining;
      if (amount > remaining) {
        throw AppError.unprocessable(
          `Amount exceeds the outstanding balance (${remaining} minor units remain)`,
        );
      }

      const paymentId = randomUUID();
      let checkout: { providerPaymentId: string; checkoutUrl: string };
      try {
        checkout = await provider.createCheckoutSession({
          paymentId,
          workspaceId: params.workspaceId,
          projectId: params.projectId,
          milestoneId: milestone.id,
          amountCents: amount,
          currency,
          idempotencyKey: key,
          ...(body.successUrl !== undefined ? { successUrl: body.successUrl } : {}),
          ...(body.cancelUrl !== undefined ? { cancelUrl: body.cancelUrl } : {}),
        });
      } catch (err: unknown) {
        throw new AppError(
          "PROVIDER_ERROR",
          `Payment provider unavailable: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }

      let payment: PaymentRecord;
      try {
        payment = await store.createPayment(params.workspaceId, {
          id: paymentId,
          projectId: params.projectId,
          milestoneId: milestone.id,
          provider: provider.name,
          providerPaymentId: checkout.providerPaymentId,
          amountCents: amount,
          currency,
          state: "pending",
          idempotencyKey: key,
        });
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "CONFLICT") throw err;
        throw err;
      }
      try {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: milestone.id,
          type: "PaymentCreated",
          actorType: "freelancer",
          actorId: user.id,
          idempotencyKey: `pay:${payment.id}:created`,
          payload: {
            paymentId: payment.id,
            providerPaymentId: payment.providerPaymentId,
            amountCents: amount,
            currency,
          },
        });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: milestone.id,
          type: "PaymentPending",
          actorType: "system",
          idempotencyKey: `pay:${payment.id}:pending`,
          payload: { paymentId: payment.id, checkoutUrl: checkout.checkoutUrl },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      // Intent only: milestone moves to payment_pending at most, never paid.
      try {
        if (milestone.paymentState === "unpaid" || milestone.paymentState === "overdue") {
          await store.updateMilestone(milestone.id, { paymentState: "payment_pending" });
        }
      } catch {
        // Non-fatal.
      }
      return reply.status(201).send({
        payment: serializePayment(payment),
        checkoutUrl: checkout.checkoutUrl,
        message: "Checkout created. Payment completes only via verified provider confirmation.",
      });
    },
  );

  // ---- Freelancer: list payments + reconciliation summary ----
  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/payments", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const membership = await store.findMembership(user.id, params.workspaceId);
    const project = await store.findProject(params.projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, project);
    const payments = await store.listPayments(params.projectId);
    const byState: Record<string, number> = {};
    let verifiedPaidCents = 0;
    for (const p of payments) {
      byState[p.state] = (byState[p.state] ?? 0) + 1;
      if (isVerifiedPaymentState(p.state)) verifiedPaidCents += p.amountCents;
    }
    const milestones = await store.listMilestones(params.projectId);
    const totalCents =
      milestones.reduce((s, m) => s + m.amountCents, project.totalValueCents === 0 ? 0 : 0) ||
      project.totalValueCents;
    return {
      payments: payments.map(serializePayment),
      summary: {
        totalCents,
        verifiedPaidCents,
        outstandingCents: Math.max(0, totalCents - verifiedPaidCents),
        byState,
        authoritativeNote:
          "Authoritative state comes from verified provider events only; success-page returns prove nothing.",
      },
    };
  });

  // ---- Freelancer: payment detail + audit trail ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/:paymentId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectPaymentParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const payment = await store.findPaymentById(params.paymentId);
      if (payment?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, payment);
      const events = await store.listProjectEvents(params.projectId, 100);
      const auditTrail = events.filter((e) => {
        const pid = e.payload.paymentId;
        return pid === payment.id || e.payload.providerPaymentId === payment.providerPaymentId;
      });
      return { payment: serializePayment(payment), auditTrail };
    },
  );

  // ---- Freelancer: refund a verified payment ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/:paymentId/refund",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectPaymentParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const payment = await store.findPaymentById(params.paymentId);
      if (payment?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, payment);
      if (!canRefundPayment(payment.state)) {
        throw AppError.unprocessable(
          `Only verified paid payments can be refunded (state=${payment.state})`,
        );
      }
      // Fail-closed in production: a Noop "refund" would mark money refunded
      // without any provider settlement. Refunds require a real provider.
      if (deps.isProduction && provider.name === "noop") {
        throw new AppError(
          "PROVIDER_ERROR",
          "Payments are not configured (missing STRIPE_SECRET_KEY); refunds are disabled until a provider is connected",
        );
      }
      let refundId = "";
      try {
        const res = await provider.refundPayment({
          providerPaymentId: payment.providerPaymentId,
          amountCents: payment.amountCents,
        });
        refundId = res.refundId;
      } catch (err: unknown) {
        throw new AppError(
          "PROVIDER_ERROR",
          `Refund failed: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
      const updated = await store.updatePaymentLifecycle(payment.id, { state: "refunded" });
      try {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
          type: "PaymentRefunded",
          actorType: "freelancer",
          actorId: user.id,
          idempotencyKey: `pay:${payment.id}:refunded`,
          payload: { paymentId: payment.id, refundId },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      if (payment.milestoneId) {
        try {
          const row = await store.findMilestone(payment.milestoneId);
          if (row && (row.paymentState === "funded" || row.paymentState === "paid")) {
            await store.updateMilestone(row.id, { paymentState: "refunded" });
            await refreshUnlocks(params.projectId);
          }
        } catch {
          // Non-fatal.
        }
      }
      return { payment: serializePayment(updated), refundId };
    },
  );

  // ---- Freelancer: cancel a pending payment ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/:paymentId/cancel",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectPaymentParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const payment = await store.findPaymentById(params.paymentId);
      if (payment?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, payment);
      if (!canCancelPayment(payment.state)) {
        throw AppError.unprocessable(`Payment cannot be cancelled from state=${payment.state}`);
      }
      const updated = await store.updatePaymentLifecycle(payment.id, { state: "cancelled" });
      try {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
          type: "PaymentCancelled",
          actorType: "freelancer",
          actorId: user.id,
          idempotencyKey: `pay:${payment.id}:cancelled`,
          payload: { paymentId: payment.id },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      return { payment: serializePayment(updated) };
    },
  );

  // ---- Freelancer: reconcile local state against the provider ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/payments/:paymentId/reconcile",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectPaymentParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const payment = await store.findPaymentById(params.paymentId);
      if (payment?.projectId !== params.projectId) throw AppError.notFound("Not found");
      assertResourceInWorkspace(params.workspaceId, membership, payment);
      let remote: { status: string; amountCents: number; currency: string };
      try {
        remote = await provider.retrievePayment({ providerPaymentId: payment.providerPaymentId });
      } catch (err: unknown) {
        throw new AppError(
          "PROVIDER_ERROR",
          `Reconcile failed: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
      const drift =
        remote.amountCents !== payment.amountCents ||
        remote.currency.toUpperCase() !== payment.currency.toUpperCase();
      const mapped =
        stripeIntentStatusToState(remote.status) ?? providerEventToState(remote.status);
      let updated = payment;
      let transitioned = false;
      if (!drift && mapped && mapped !== payment.state) {
        try {
          const next = transitionPayment(payment.state, mapped);
          updated = await store.updatePaymentLifecycle(payment.id, { state: next });
          transitioned = true;
          try {
            await store.appendProjectEvent(params.workspaceId, params.projectId, {
              ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
              type: EVENT_BY_PAYMENT_STATE[next] ?? "PaymentReconciled",
              actorType: "system",
              idempotencyKey: `pay:${payment.id}:reconcile:${remote.status}`,
              payload: { paymentId: payment.id, from: payment.state, to: next, remote },
            });
          } catch (err: unknown) {
            if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
          }
          if (next === "paid" && payment.milestoneId) {
            await applyVerifiedReceipt(payment.milestoneId, payment.id, payment.amountCents);
          }
        } catch {
          // Illegal transition → record review, no silent overwrite.
          try {
            await store.appendProjectEvent(params.workspaceId, params.projectId, {
              ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
              type: "PaymentReconciled",
              actorType: "system",
              idempotencyKey: `pay:${payment.id}:reconcile:${Date.now()}`,
              payload: {
                paymentId: payment.id,
                remote,
                note: "illegal transition; kept local state",
              },
            });
          } catch {
            // Non-fatal.
          }
        }
      } else {
        try {
          await store.appendProjectEvent(params.workspaceId, params.projectId, {
            ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
            type: "PaymentReconciled",
            actorType: "system",
            idempotencyKey: `pay:${payment.id}:reconcile:${remote.status}:${remote.amountCents}`,
            payload: { paymentId: payment.id, remote, drift },
          });
        } catch (err: unknown) {
          if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
        }
      }
      const fresh = await store.findPaymentById(payment.id);
      return {
        payment: serializePayment(fresh ?? updated),
        provider: { name: provider.name, ...remote },
        drift,
        transitioned,
      };
    },
  );

  // ---- Public: provider webhook (no session; signature is the credential) ----
  app.post("/api/v1/webhooks/payments", async (request, reply) => {
    const secret = webhookSecret();
    const rawHeader = request.headers["stripe-signature"];
    const signatureHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const rawBody =
      (request as unknown as { rawBody?: string }).rawBody ??
      (typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {}));
    try {
      verifyWebhookSignature({ rawBody, signatureHeader, webhookSecret: secret });
    } catch {
      throw AppError.badRequest("Invalid webhook signature");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw AppError.badRequest("Invalid webhook payload");
    }
    const evt = parsed as {
      id?: unknown;
      type?: unknown;
      data?: { object?: Record<string, unknown> };
    };
    if (typeof evt.id !== "string" || typeof evt.type !== "string") {
      throw AppError.badRequest("Invalid webhook event (missing id/type)");
    }
    const eventId = evt.id;
    const eventType = evt.type;
    if (seenWebhookIds.has(eventId)) {
      return reply.status(200).send({ received: true, duplicate: true });
    }

    const obj = evt.data?.object ?? {};
    const meta = (obj.metadata ?? {}) as Record<string, unknown>;
    const providerPaymentId =
      typeof obj.payment_intent === "string" && obj.payment_intent.length > 0
        ? obj.payment_intent
        : typeof obj.id === "string"
          ? obj.id
          : "";
    const metaPaymentId = typeof meta.paymentId === "string" ? meta.paymentId : null;

    let payment: PaymentRecord | undefined;
    if (metaPaymentId) payment = await store.findPaymentById(metaPaymentId);
    if (!payment && providerPaymentId) {
      payment =
        (await store.findPaymentByProvider("stripe", providerPaymentId)) ??
        (await store.findPaymentByProvider("fake", providerPaymentId)) ??
        (await store.findPaymentByProvider("noop", providerPaymentId));
    }
    // Fallback: scan by providerPaymentId across known providers.
    if (!payment && providerPaymentId) {
      const allProviders = ["stripe", "fake", "noop"];
      for (const name of allProviders) {
        payment = await store.findPaymentByProvider(name, providerPaymentId);
        if (payment) break;
      }
    }
    const target = providerEventToState(eventType);
    if (!target) {
      seenWebhookIds.add(eventId);
      return reply.status(200).send({ received: true, ignored: "unknown-event-type" });
    }
    if (!payment) {
      seenWebhookIds.add(eventId);
      return reply.status(200).send({ received: true, ignored: "unknown-payment" });
    }
    // Persistent replay guard: the in-memory set is a fast path, but the
    // events table (UNIQUE idempotency_key) is authoritative across restarts.
    // First delivery records a marker; a replay hits the UNIQUE and is a
    // safe no-op — even if the process restarted in between.
    try {
      await store.appendProjectEvent(payment.workspaceId, payment.projectId, {
        ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
        type: "WebhookReceived",
        actorType: "provider",
        idempotencyKey: `webhook:stripe:${eventId}`,
        payload: {
          paymentId: payment.id,
          providerEventId: eventId,
          providerEventType: eventType,
        },
      });
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === "CONFLICT") {
        seenWebhookIds.add(eventId);
        return reply.status(200).send({ received: true, duplicate: true });
      }
      throw err;
    }
    if (payment.state === target) {
      seenWebhookIds.add(eventId);
      return reply.status(200).send({ received: true, duplicate: true });
    }

    // Amount/currency validation before any paid transition.
    const rawAmount =
      (obj.amount_total as number | undefined) ??
      (obj.amount_received as number | undefined) ??
      (obj.amount as number | undefined);
    const rawCurrency = typeof obj.currency === "string" ? obj.currency : payment.currency;
    if (target === "paid") {
      const mismatch =
        typeof rawAmount === "number"
          ? validateWebhookMoney(
              { amountCents: payment.amountCents, currency: payment.currency },
              { amountCents: rawAmount, currency: rawCurrency },
            )
          : null;
      if (mismatch) {
        try {
          await store.appendProjectEvent(payment.workspaceId, payment.projectId, {
            ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
            type: "PaymentAmountMismatched",
            actorType: "provider",
            idempotencyKey: `webhook:stripe:${eventId}:mismatch`,
            payload: {
              paymentId: payment.id,
              providerEventId: eventId,
              providerEventType: eventType,
              reason: mismatch,
              expected: { amountCents: payment.amountCents, currency: payment.currency },
              reported: { amountCents: rawAmount, currency: rawCurrency.toUpperCase() },
            },
          });
        } catch (err: unknown) {
          if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
        }
        seenWebhookIds.add(eventId);
        return reply.status(200).send({ received: true, needsReview: true, reason: mismatch });
      }
    }

    let next: string;
    try {
      next = transitionPayment(payment.state, target);
    } catch {
      // Out-of-order guard: a refund/dispute that arrives before its
      // confirmation (e.g. redelivered or reordered webhooks) must NOT force
      // terminal state. Keep local state; the confirmation + the project
      // reconciliation run converge later. History is appended, never edited.
      const prePaid =
        payment.state === "created" ||
        payment.state === "pending" ||
        payment.state === "processing";
      const reversalFirst = (target === "refunded" || target === "disputed") && prePaid;
      const reason = reversalFirst
        ? `illegal transition ${payment.state} → ${target}; kept local state (possible out-of-order delivery — reversal arrived before confirmation)`
        : `illegal transition ${payment.state} → ${target}; kept local state`;
      try {
        await store.appendProjectEvent(payment.workspaceId, payment.projectId, {
          ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
          type: "PaymentAmountMismatched",
          actorType: "provider",
          idempotencyKey: `webhook:stripe:${eventId}:illegal`,
          payload: {
            paymentId: payment.id,
            providerEventId: eventId,
            providerEventType: eventType,
            reason,
          },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      seenWebhookIds.add(eventId);
      return reply.status(200).send({ received: true, ignored: "illegal-transition" });
    }

    const updated = await store.updatePaymentLifecycle(payment.id, {
      state: next,
      rawWebhookRef: eventId,
      ...(next === "paid" ? { receivedAt: new Date() } : {}),
    });
    try {
      await store.appendProjectEvent(payment.workspaceId, payment.projectId, {
        ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
        type: EVENT_BY_PAYMENT_STATE[next] ?? "PaymentReceived",
        actorType: "provider",
        idempotencyKey: `webhook:stripe:${eventId}:${next}`,
        payload: {
          paymentId: payment.id,
          providerEventId: eventId,
          providerEventType: eventType,
          providerPaymentId: payment.providerPaymentId,
          amountCents: payment.amountCents,
          currency: payment.currency,
        },
      });
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === "CONFLICT") {
        seenWebhookIds.add(eventId);
        return reply.status(200).send({ received: true, duplicate: true });
      }
      throw err;
    }
    if (next === "paid" && payment.milestoneId) {
      await applyVerifiedReceipt(payment.milestoneId, payment.id, payment.amountCents);
    }
    if (next === "refunded" && payment.milestoneId) {
      try {
        const row = await store.findMilestone(payment.milestoneId);
        if (row && (row.paymentState === "funded" || row.paymentState === "paid")) {
          await store.updateMilestone(row.id, { paymentState: "refunded" });
          await refreshUnlocks(row.projectId);
        }
      } catch {
        // Non-fatal.
      }
    }
    if (next === "disputed" && payment.milestoneId) {
      try {
        const row = await store.findMilestone(payment.milestoneId);
        if (row) {
          await store.updateMilestone(row.id, { paymentState: "disputed" });
          try {
            await store.appendProjectEvent(payment.workspaceId, payment.projectId, {
              milestoneId: row.id,
              type: "PaymentDisputed",
              actorType: "provider",
              idempotencyKey: `webhook:stripe:${eventId}:disputed-flag`,
              payload: { paymentId: payment.id },
            });
          } catch {
            // Non-fatal.
          }
        }
      } catch {
        // Non-fatal.
      }
    }
    // Transactional payment notice (Session 18): one idempotent fan-out per
    // provider event — client receipt + freelancer inbox. Best-effort: the
    // verified payment above is already recorded; this only notifies.
    const noticeKind =
      next === "paid"
        ? "payment_received"
        : next === "refunded"
          ? "payment_refunded"
          : next === "disputed"
            ? "payment_disputed"
            : next === "failed" || next === "cancelled"
              ? "payment_failed"
              : null;
    if (noticeKind) {
      await notifyLifecycle(deps, {
        workspaceId: payment.workspaceId,
        projectId: payment.projectId,
        ...(payment.milestoneId !== undefined ? { milestoneId: payment.milestoneId } : {}),
        kind: noticeKind,
        dedupe: `webhook:${eventId}`,
        detail: `${payment.amountCents} ${payment.currency} via ${payment.provider}.`,
      });
    }
    seenWebhookIds.add(eventId);
    return reply.status(200).send({ received: true, payment: serializePayment(updated) });
  });
}
