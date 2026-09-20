import { describe, expect, it } from "vitest";
import {
  isMilestonePaid,
  isOverdue,
  projectOutstandingCents,
  sumReceivedForMilestone,
} from "../../src/domain/money.js";

describe("money integrity (integer minor units)", () => {
  it("sums only verified receipts toward a milestone", () => {
    const payments = [
      { milestoneId: "m1", amountCents: 30000, state: "received" },
      { milestoneId: "m1", amountCents: 20000, state: "partial" },
      { milestoneId: "m1", amountCents: 99999, state: "pending" },
      { milestoneId: "m2", amountCents: 50000, state: "received" },
    ];
    expect(sumReceivedForMilestone(payments, "m1")).toBe(50000);
    expect(isMilestonePaid(50000, payments, "m1")).toBe(true);
    expect(isMilestonePaid(50001, payments, "m1")).toBe(false);
  });

  it("outstanding = milestones total − verified received (plans do not reduce)", () => {
    const payments = [{ milestoneId: "m1", amountCents: 20000, state: "received" }];
    expect(projectOutstandingCents([50000, 50000], payments)).toBe(80000);
  });

  it("partial payment leaves milestone unpaid", () => {
    const payments = [{ milestoneId: "m1", amountCents: 10000, state: "partial" }];
    expect(isMilestonePaid(50000, payments, "m1")).toBe(false);
  });

  it("rejects float/negative amounts (fail-closed)", () => {
    expect(() => projectOutstandingCents([10.5], [])).toThrow();
    expect(() => projectOutstandingCents([-1], [])).toThrow();
  });

  it("overdue respects grace window and zero outstanding", () => {
    const due = new Date("2026-01-01T00:00:00Z");
    expect(
      isOverdue({
        nowUtc: new Date("2026-01-02T00:00:00Z"),
        dueDate: due,
        graceDays: 3,
        outstandingCents: 100,
      }),
    ).toBe(false);
    expect(
      isOverdue({
        nowUtc: new Date("2026-01-05T00:00:01Z"),
        dueDate: due,
        graceDays: 3,
        outstandingCents: 100,
      }),
    ).toBe(true);
    expect(
      isOverdue({
        nowUtc: new Date("2027-01-01T00:00:00Z"),
        dueDate: due,
        graceDays: 0,
        outstandingCents: 0,
      }),
    ).toBe(false);
  });
});
