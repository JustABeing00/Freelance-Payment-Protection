import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  cancelOpenInstallments,
  installmentEventKey,
  installmentView,
  markInstallmentMissed,
  markInstallmentPaid,
  PaymentPlanError,
  planEventKey,
  renderInstallmentReminder,
  summarizePlan,
  transitionPlanState,
  validatePlanProposal,
} from "../../src/domain/paymentPlans.js";

/**
 * Session 13: payment-plan engine (pure rules).
 * - Schedules must cover the original obligation EXACTLY (no silent
 *   forgiveness, no silent surcharge).
 * - Installments settle only against verified payments; missed is derived
 *   from due dates and persisted by the run-due tick (never silently).
 * - Modified schedules are new versions; the original row is never edited.
 */

const WEEK = 7 * 86_400_000;
const BASE = new Date("2026-09-01T00:00:00.000Z");

function weekly(n: number, amountCents: number): { amountCents: number; dueDate: Date }[] {
  return Array.from({ length: n }, (_, i) => ({
    amountCents,
    dueDate: new Date(BASE.getTime() + i * WEEK),
  }));
}

describe("payment-plan proposal validation", () => {
  it("accepts 4 weekly payments of $600 against $2,400", () => {
    expect(() =>
      validatePlanProposal({ originalAmountCents: 240000, installments: weekly(4, 60000) }),
    ).not.toThrow();
  });

  it("accepts $1,000 + $700 + $700 against $2,400", () => {
    expect(() =>
      validatePlanProposal({
        originalAmountCents: 240000,
        installments: [
          { amountCents: 100000, dueDate: new Date("2026-09-01T00:00:00.000Z") },
          { amountCents: 70000, dueDate: new Date("2026-10-01T00:00:00.000Z") },
          { amountCents: 70000, dueDate: new Date("2026-11-01T00:00:00.000Z") },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a schedule that does not sum exactly (no silent forgiveness)", () => {
    expect(() =>
      validatePlanProposal({ originalAmountCents: 240000, installments: weekly(3, 60000) }),
    ).toThrow(PaymentPlanError);
  });

  it("rejects a schedule that exceeds the obligation (no silent surcharge)", () => {
    expect(() =>
      validatePlanProposal({ originalAmountCents: 240000, installments: weekly(5, 60000) }),
    ).toThrow(PaymentPlanError);
  });

  it("rejects empty, oversized, zero-amount and unordered schedules", () => {
    expect(() => validatePlanProposal({ originalAmountCents: 1000, installments: [] })).toThrow(
      PaymentPlanError,
    );
    expect(() =>
      validatePlanProposal({ originalAmountCents: 1300, installments: weekly(13, 100) }),
    ).toThrow(PaymentPlanError);
    expect(() =>
      validatePlanProposal({
        originalAmountCents: 1000,
        installments: [{ amountCents: 0, dueDate: BASE }],
      }),
    ).toThrow(PaymentPlanError);
    expect(() =>
      validatePlanProposal({
        originalAmountCents: 2000,
        installments: [
          { amountCents: 1000, dueDate: new Date("2026-10-01T00:00:00.000Z") },
          { amountCents: 1000, dueDate: new Date("2026-09-01T00:00:00.000Z") },
        ],
      }),
    ).toThrow(PaymentPlanError);
  });

  it("builds a stable 1-based schedule", () => {
    const schedule = buildSchedule(weekly(2, 50000));
    expect(schedule.map((s) => s.seq)).toEqual([1, 2]);
    expect(schedule.every((s) => s.status === "scheduled")).toBe(true);
  });
});

describe("payment-plan summaries and views", () => {
  it("tracks paid vs remaining and the next due installment", () => {
    const schedule = buildSchedule(weekly(4, 60000));
    const paid = markInstallmentPaid(schedule, 1, { paymentId: "pay_1" });
    const summary = summarizePlan(paid);
    expect(summary.totalCents).toBe(240000);
    expect(summary.paidCents).toBe(60000);
    expect(summary.remainingCents).toBe(180000);
    expect(summary.nextDue?.seq).toBe(2);
    expect(summary.complete).toBe(false);
  });

  it("derives overdue without mutating stored status", () => {
    const schedule = buildSchedule(weekly(2, 50000));
    const late = new Date("2026-12-01T00:00:00.000Z");
    const first = schedule[0];
    if (!first) throw new Error("expected a first installment");
    const view = installmentView(first, late);
    expect(view.overdue).toBe(true);
    expect(first.status).toBe("scheduled");
  });

  it("marks missed explicitly and counts it", () => {
    const schedule = buildSchedule(weekly(2, 50000));
    const next = markInstallmentMissed(schedule, 1, { note: "cash-flow delay" });
    const first = next[0];
    expect(first?.status).toBe("missed");
    expect(summarizePlan(next).missedCount).toBe(1);
    expect(() => markInstallmentMissed(next, 1)).not.toThrow();
  });

  it("refuses to mark a paid installment missed or a missing seq paid", () => {
    const schedule = markInstallmentPaid(buildSchedule(weekly(1, 50000)), 1, { paymentId: "p" });
    expect(() => markInstallmentMissed(schedule, 1)).toThrow(PaymentPlanError);
    expect(() => markInstallmentPaid(schedule, 1, { paymentId: "q" })).toThrow(PaymentPlanError);
    expect(() => markInstallmentPaid(schedule, 9, { paymentId: "q" })).toThrow(PaymentPlanError);
  });

  it("cancels only open installments on supersede", () => {
    const schedule = markInstallmentPaid(buildSchedule(weekly(3, 10000)), 1, { paymentId: "p" });
    const canceled = cancelOpenInstallments(schedule);
    expect(canceled.map((i) => i.status)).toEqual(["paid", "canceled", "canceled"]);
  });
});

describe("payment-plan state machine", () => {
  it("moves offered → active → completed, and active → defaulted → superseded", () => {
    expect(transitionPlanState("offered", "active")).toBe("active");
    expect(transitionPlanState("active", "completed")).toBe("completed");
    expect(transitionPlanState("active", "defaulted")).toBe("defaulted");
    expect(transitionPlanState("defaulted", "superseded")).toBe("superseded");
  });

  it("rejects illegal jumps (offered → completed, completed → anything)", () => {
    expect(() => transitionPlanState("offered", "completed")).toThrow(PaymentPlanError);
    expect(() => transitionPlanState("completed", "active")).toThrow(PaymentPlanError);
    expect(() => transitionPlanState("superseded", "active")).toThrow(PaymentPlanError);
  });

  it("mints stable idempotency keys", () => {
    expect(planEventKey("plan1", "accepted")).toBe("plan:plan1:accepted");
    expect(installmentEventKey("plan1", 2, "paid-pay_x")).toBe(
      "plan:plan1:installment:2:paid-pay_x",
    );
  });

  it("renders professional reminders with schedule facts and no threats", () => {
    const copy = renderInstallmentReminder({
      workspaceName: "Studio",
      clientName: "Alex",
      projectTitle: "Website",
      milestoneTitle: "Milestone 2 — Build",
      seq: 2,
      ofCount: 4,
      amountCents: 60000,
      currency: "usd",
      dueDate: new Date("2026-09-08T00:00:00.000Z"),
      remainingCents: 180000,
    });
    expect(copy.subject).toContain("installment 2 of 4");
    expect(copy.body).toContain("600.00 USD");
    expect(copy.body).toContain("1,800.00 USD");
    for (const banned of [/sue/i, /court/i, /lawsuit/i, /deposit/i]) {
      expect(copy.subject + copy.body).not.toMatch(banned);
    }
  });
});
