import { describe, expect, it } from "vitest";
import {
  assertProfessionalCopy,
  buildProtectionChecks,
  type BuildProtectionInput,
} from "../../src/domain/protection.js";

const EXPECTED_CODES = [
  "payment_method_not_configured",
  "deposit_missing",
  "milestone_overdue",
  "contract_unsigned",
  "approved_unpaid",
  "final_request_before_payment",
  "payment_deadline_unclear",
  "multiple_payment_failures",
  "repeated_missed_installments",
  "no_recent_client_activity",
  "large_unpaid_balance",
  "final_unlocked",
];

const BANNED = ["scammer", "scammers", "bad client", "dishonest", "fraudulent", "fraud"];

function healthyInput(): BuildProtectionInput {
  const now = new Date("2026-09-18T12:00:00Z");
  const due = new Date("2026-10-18T12:00:00Z");
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Brand site",
      currency: "USD",
      totalValueCents: 100000,
      paymentTerms: "Milestone 1 on approval, balance on delivery.",
    },
    milestones: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Milestone 1",
        amountCents: 50000,
        dueDate: due,
        paymentState: "paid",
        approvalState: "approved",
        deliverableState: "released",
        orderIndex: 0,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        title: "Milestone 2",
        amountCents: 50000,
        dueDate: due,
        paymentState: "paid",
        approvalState: "approved",
        deliverableState: "released",
        orderIndex: 1,
      },
    ],
    payments: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        milestoneId: "22222222-2222-4222-8222-222222222222",
        amountCents: 50000,
        state: "paid",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        milestoneId: "33333333-3333-4333-8333-333333333333",
        amountCents: 50000,
        state: "paid",
      },
    ],
    agreements: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        version: 1,
        status: "accepted",
        acceptedPaymentMethods: ["card"],
      },
    ],
    deliverables: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        milestoneId: "22222222-2222-4222-8222-222222222222",
        title: "Homepage",
        status: "released",
      },
    ],
    approvals: [],
    events: [
      {
        id: "88888888-8888-4888-8888-888888888888",
        type: "MilestoneApproved",
        actorType: "client",
        occurredAt: new Date("2026-09-17T12:00:00Z"),
        milestoneId: "22222222-2222-4222-8222-222222222222",
      },
    ],
    paymentPlans: [],
    now,
  };
}

describe("protection checks", () => {
  it("covers all 12 observable conditions with no scores", () => {
    const report = buildProtectionChecks(healthyInput());
    expect(report.checks.map((c) => c.code)).toEqual(EXPECTED_CODES);
    expect(report).not.toHaveProperty("riskScore");
    expect(report).not.toHaveProperty("score");
    expect(JSON.stringify(report).toLowerCase()).not.toContain("risk score");
    for (const c of report.checks) {
      expect(c.evidence).toBeDefined();
      expect(typeof c.detail).toBe("string");
      expect(c.detail.length).toBeGreaterThan(10);
      expect(typeof c.nextStep).toBe("string");
    }
  });

  it("reports healthy when workflow conditions are sound", () => {
    const report = buildProtectionChecks(healthyInput());
    expect(report.status).toBe("healthy");
    expect(report.attentionCount).toBe(0);
    expect(report.clearCount).toBe(12);
  });

  it("flags weak process conditions with evidence, never client labels", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const past = new Date("2026-08-01T12:00:00Z");
    const report = buildProtectionChecks({
      project: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Risky site",
        currency: "USD",
        totalValueCents: 200000,
      },
      milestones: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          title: "Milestone 1",
          amountCents: 100000,
          dueDate: past,
          paymentState: "unpaid",
          approvalState: "approved",
          deliverableState: "released",
          orderIndex: 0,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          title: "Milestone 2",
          amountCents: 100000,
          paymentState: "unpaid",
          approvalState: "none",
          deliverableState: "locked",
          orderIndex: 1,
        },
      ],
      payments: [
        { id: "a1", amountCents: 100, state: "failed" },
        { id: "a2", amountCents: 100, state: "cancelled" },
      ],
      agreements: [],
      deliverables: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          milestoneId: "22222222-2222-4222-8222-222222222222",
          title: "Homepage final",
          status: "released",
        },
      ],
      approvals: [],
      events: [
        {
          id: "e1",
          type: "DeliverableViewed",
          actorType: "client",
          occurredAt: new Date("2026-09-10T12:00:00Z"),
          milestoneId: "22222222-2222-4222-8222-222222222222",
        },
        {
          id: "e2",
          type: "PaymentPlanInstallmentMissed",
          actorType: "system",
          occurredAt: new Date("2026-09-11T12:00:00Z"),
        },
        {
          id: "e3",
          type: "PaymentPlanInstallmentMissed",
          actorType: "system",
          occurredAt: new Date("2026-09-12T12:00:00Z"),
        },
      ],
      paymentPlans: [
        {
          id: "p1",
          milestoneId: "22222222-2222-4222-8222-222222222222",
          state: "active",
          installments: [
            { seq: 1, amountCents: 50000, dueDate: past, status: "missed" },
            { seq: 2, amountCents: 50000, dueDate: past, status: "missed" },
          ],
        },
      ],
      now,
    });
    const byCode = new Map(report.checks.map((c) => [c.code, c] as const));
    for (const code of EXPECTED_CODES) {
      expect(byCode.has(code)).toBe(true);
    }
    expect(byCode.get("payment_method_not_configured")?.status).toBe("needs_attention");
    expect(byCode.get("deposit_missing")?.status).toBe("needs_attention");
    expect(byCode.get("milestone_overdue")?.status).toBe("needs_attention");
    expect(byCode.get("contract_unsigned")?.status).toBe("needs_attention");
    expect(byCode.get("approved_unpaid")?.status).toBe("needs_attention");
    expect(byCode.get("final_request_before_payment")?.status).toBe("needs_attention");
    expect(byCode.get("payment_deadline_unclear")?.status).toBe("needs_attention");
    expect(byCode.get("multiple_payment_failures")?.status).toBe("needs_attention");
    expect(byCode.get("repeated_missed_installments")?.status).toBe("needs_attention");
    expect(byCode.get("large_unpaid_balance")?.status).toBe("needs_attention");
    expect(byCode.get("final_unlocked")?.status).toBe("needs_attention");
    expect(report.status).toBe("needs_attention");
    expect(report.attentionCount).toBeGreaterThan(5);
    // Evidence present on the attention rows.
    expect(
      (byCode.get("milestone_overdue")?.evidence.overdueMilestones as unknown[]).length,
    ).toBeGreaterThan(0);
    expect(byCode.get("multiple_payment_failures")?.evidence.failedCount).toBe(2);

    const blob = JSON.stringify(report).toLowerCase();
    for (const word of BANNED) {
      expect(blob).not.toContain(word);
    }
  });

  it("flags stale client activity only when balance is outstanding", () => {
    const base = healthyInput();
    // Paid in full: even ancient activity is fine because nothing is owed.
    const paid = buildProtectionChecks({
      ...base,
      events: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          type: "MilestoneApproved",
          actorType: "client",
          occurredAt: new Date("2026-01-01T12:00:00Z"),
        },
      ],
      now: new Date("2026-09-18T12:00:00Z"),
    });
    expect(paid.checks.find((c) => c.code === "no_recent_client_activity")?.status).toBe("clear");

    // Same staleness with an outstanding balance needs attention.
    const unpaid = buildProtectionChecks({
      ...base,
      payments: [],
      milestones: base.milestones.map((m) => ({ ...m, paymentState: "unpaid" })),
      events: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          type: "MilestoneApproved",
          actorType: "client",
          occurredAt: new Date("2026-01-01T12:00:00Z"),
        },
      ],
      now: new Date("2026-09-18T12:00:00Z"),
    });
    expect(unpaid.checks.find((c) => c.code === "no_recent_client_activity")?.status).toBe(
      "needs_attention",
    );
  });

  it("counts only verified receipts toward balances", () => {
    const base = healthyInput();
    const report = buildProtectionChecks({
      ...base,
      payments: [
        {
          id: "claim-1",
          milestoneId: "22222222-2222-4222-8222-222222222222",
          amountCents: 200000,
          state: "claimed_unverified",
        },
      ],
      now: new Date("2026-09-18T12:00:00Z"),
    });
    expect(report.checks.find((c) => c.code === "deposit_missing")?.status).toBe("needs_attention");
    expect(report.checks.find((c) => c.code === "large_unpaid_balance")?.status).toBe(
      "needs_attention",
    );
  });

  it("rejects client-labelling copy", () => {
    for (const bad of ["scammer", "bad client", "dishonest", "fraudulent", "fraud"]) {
      expect(() => assertProfessionalCopy(`The ${bad} did this`)).toThrow();
    }
    expect(() => assertProfessionalCopy("Deposit missing before work starts.")).not.toThrow();
  });
});
