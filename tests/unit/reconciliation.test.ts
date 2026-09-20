import { describe, expect, it } from "vitest";
import {
  buildPaymentHistory,
  isSettlementProviderEvent,
  reconcileProject,
  settlementNote,
  verificationLabel,
  verificationTierForPaymentState,
  type ReconcileProjectInput,
} from "../../src/domain/reconciliation.js";

function baseInput(overrides: Partial<ReconcileProjectInput> = {}): ReconcileProjectInput {
  return {
    projectId: "project-1",
    projectTotalCents: 50000,
    projectCurrency: "USD",
    milestones: [
      {
        id: "m1",
        title: "Milestone 1 — Discovery",
        amountCents: 50000,
        currency: "USD",
        orderIndex: 0,
        paymentState: "unpaid",
        appliedPaymentIds: [],
      },
    ],
    payments: [],
    events: [],
    ...overrides,
  };
}

describe("verification tiers (claimed != initiated != confirmed != settled)", () => {
  it("maps lifecycle states to tiers", () => {
    expect(verificationTierForPaymentState("created")).toBe("initiated");
    expect(verificationTierForPaymentState("pending")).toBe("initiated");
    expect(verificationTierForPaymentState("processing")).toBe("initiated");
    expect(verificationTierForPaymentState("paid")).toBe("provider_confirmed");
    expect(verificationTierForPaymentState("received")).toBe("provider_confirmed");
    expect(verificationTierForPaymentState("partial")).toBe("provider_confirmed");
    expect(verificationTierForPaymentState("settled")).toBe("settled");
    expect(verificationTierForPaymentState("failed")).toBe("failed");
    expect(verificationTierForPaymentState("cancelled")).toBe("failed");
    expect(verificationTierForPaymentState("refunded")).toBe("reversed");
    expect(verificationTierForPaymentState("disputed")).toBe("reversed");
  });

  it("labels every tier in human words, never equating claim with paid", () => {
    expect(verificationLabel("claimed")).toMatch(/not verified/i);
    expect(verificationLabel("provider_confirmed")).toMatch(/verified/i);
    expect(verificationLabel("claimed")).not.toBe(verificationLabel("provider_confirmed"));
  });

  it("recognises settlement legs where providers expose them", () => {
    expect(isSettlementProviderEvent("transfer.paid")).toBe(true);
    expect(isSettlementProviderEvent("payout.paid")).toBe(true);
    expect(isSettlementProviderEvent("payment_intent.succeeded")).toBe(false);
    expect(settlementNote("stripe", "paid")).toMatch(/settlement record/i);
    expect(settlementNote("stripe", "pending")).toMatch(/no settlement/i);
  });
});

describe("reconcileProject", () => {
  it("balances a clean fully-paid project", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1 — Discovery",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "paid",
            appliedPaymentIds: ["p1"],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            receivedAt: new Date("2026-01-02T00:00:00Z"),
          },
        ],
        events: [
          {
            id: "e1",
            type: "PaymentReceived",
            occurredAt: new Date("2026-01-02T00:00:00Z"),
            milestoneId: "m1",
            payload: { paymentId: "p1" },
          },
        ],
      }),
    );
    expect(report.balanced).toBe(true);
    expect(report.totals.verifiedPaidCents).toBe(50000);
    expect(report.totals.outstandingCents).toBe(0);
    expect(report.perMilestone[0]?.status).toBe("paid");
    expect(report.verification.confirmedPayments).toBe(1);
  });

  it("flags milestone-total vs project-total drift as an error", () => {
    const report = reconcileProject(baseInput({ projectTotalCents: 99999 }));
    expect(report.balanced).toBe(false);
    expect(report.mismatches.some((m) => m.code === "milestone_total_mismatch")).toBe(true);
  });

  it("detects overpaid milestones, orphan payments and currency mismatch", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1",
            amountCents: 10000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "paid",
            appliedPaymentIds: ["p1", "p2"],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 10000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            receivedAt: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "p2",
            milestoneId: "m1",
            amountCents: 10000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_2",
            createdAt: new Date("2026-01-03T00:00:00Z"),
            receivedAt: new Date("2026-01-04T00:00:00Z"),
          },
          {
            id: "p3",
            milestoneId: "gone",
            amountCents: 500,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_3",
            createdAt: new Date("2026-01-05T00:00:00Z"),
          },
          {
            id: "p4",
            milestoneId: "m1",
            amountCents: 100,
            currency: "EUR",
            state: "pending",
            provider: "stripe",
            providerPaymentId: "pi_4",
            createdAt: new Date("2026-01-06T00:00:00Z"),
          },
        ],
        events: [],
      }),
    );
    const codes = report.mismatches.map((m) => m.code);
    expect(codes).toContain("overpaid_milestone");
    expect(codes).toContain("orphan_payment");
    expect(codes).toContain("currency_mismatch");
    expect(report.balanced).toBe(false);
  });

  it("treats claims as warnings that never count toward totals", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "claimed_unverified",
            appliedPaymentIds: [],
          },
        ],
        events: [
          {
            id: "e1",
            type: "PaymentClaimed",
            occurredAt: new Date("2026-01-01T00:00:00Z"),
            milestoneId: "m1",
            payload: {},
          },
        ],
      }),
    );
    expect(report.totals.verifiedPaidCents).toBe(0);
    expect(report.totals.outstandingCents).toBe(50000);
    expect(report.mismatches.some((m) => m.code === "claimed_without_payment")).toBe(true);
    expect(report.perMilestone[0]?.status).toBe("claimed");
  });

  it("reports partial coverage and initiated-but-unconfirmed money", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "payment_pending",
            appliedPaymentIds: ["p1"],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 20000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            receivedAt: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "p2",
            milestoneId: "m1",
            amountCents: 30000,
            currency: "USD",
            state: "pending",
            provider: "stripe",
            providerPaymentId: "pi_2",
            createdAt: new Date("2026-01-03T00:00:00Z"),
          },
        ],
        events: [],
      }),
    );
    const codes = report.mismatches.map((m) => m.code);
    expect(codes).toContain("partial_uncovered");
    expect(codes).toContain("initiated_without_confirmation");
    expect(report.perMilestone[0]?.status).toBe("partial");
  });

  it("flags failed payments, open disputes and missing provider linkage", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "disputed",
            appliedPaymentIds: [],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "failed",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            id: "p2",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "disputed",
            provider: "stripe",
            providerPaymentId: "pi_2",
            createdAt: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "p3",
            milestoneId: "m1",
            amountCents: 100,
            currency: "USD",
            state: "pending",
            provider: "stripe",
            providerPaymentId: "",
            createdAt: new Date("2026-01-03T00:00:00Z"),
          },
        ],
        events: [],
      }),
    );
    const codes = report.mismatches.map((m) => m.code);
    expect(codes).toContain("failed_payment");
    expect(codes).toContain("dispute_open");
    expect(codes).toContain("missing_provider_linkage");
  });

  it("detects out-of-order reversals and needs-review queue entries", () => {
    const report = reconcileProject(
      baseInput({
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "pending",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
        events: [
          {
            id: "e1",
            type: "PaymentAmountMismatched",
            occurredAt: new Date("2026-01-02T00:00:00Z"),
            milestoneId: "m1",
            payload: {
              paymentId: "p1",
              reason: "illegal transition pending → refunded; kept local state",
            },
          },
        ],
      }),
    );
    expect(report.mismatches.some((m) => m.code === "out_of_order")).toBe(true);
  });

  it("flags projection drift when verified rows are not applied", () => {
    const report = reconcileProject(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Milestone 1",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "payment_pending",
            appliedPaymentIds: [],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            receivedAt: new Date("2026-01-02T00:00:00Z"),
          },
        ],
        events: [],
      }),
    );
    expect(report.mismatches.some((m) => m.code === "unapplied_verified")).toBe(true);
  });
});

describe("buildPaymentHistory", () => {
  it("writes plain-language lines with claims marked NOT-verified", () => {
    const history = buildPaymentHistory(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Discovery",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "claimed_unverified",
            appliedPaymentIds: [],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "pending",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
        events: [
          {
            id: "e1",
            type: "PaymentClaimed",
            occurredAt: new Date("2026-01-02T00:00:00Z"),
            milestoneId: "m1",
            payload: {},
          },
        ],
      }),
    );
    const headlines = history.map((h) => h.headline).join("\n");
    expect(headlines).toMatch(/Checkout created/);
    expect(headlines).toMatch(/NOT verified/);
    expect(history.some((h) => h.tier === "claimed")).toBe(true);
    expect(history.some((h) => h.headline.startsWith("Provider confirmed"))).toBe(false);
    // Chronological: oldest first.
    const ats = history.map((h) => h.at);
    expect([...ats].sort()).toEqual(ats);
  });

  it("celebrates provider confirmations and explains failures", () => {
    const history = buildPaymentHistory(
      baseInput({
        milestones: [
          {
            id: "m1",
            title: "Discovery",
            amountCents: 50000,
            currency: "USD",
            orderIndex: 0,
            paymentState: "paid",
            appliedPaymentIds: ["p1"],
          },
        ],
        payments: [
          {
            id: "p1",
            milestoneId: "m1",
            amountCents: 50000,
            currency: "USD",
            state: "paid",
            provider: "stripe",
            providerPaymentId: "pi_1",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            receivedAt: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "p2",
            milestoneId: "m1",
            amountCents: 100,
            currency: "USD",
            state: "failed",
            provider: "stripe",
            providerPaymentId: "pi_2",
            createdAt: new Date("2026-01-03T00:00:00Z"),
          },
        ],
        events: [],
      }),
    );
    expect(history.some((h) => h.kind === "confirmed" && h.tier === "provider_confirmed")).toBe(
      true,
    );
    expect(history.some((h) => h.kind === "failed" && /no money moved/i.test(h.detail))).toBe(true);
  });
});
