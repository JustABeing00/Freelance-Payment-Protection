import { describe, expect, it } from "vitest";
import { reduceMilestone } from "../../src/domain/events.js";
import type { DomainEvent } from "../../src/domain/types.js";

function ev(type: string, at: string, extra: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: `${type}-${at}`,
    workspaceId: "ws1",
    projectId: "p1",
    milestoneId: "m1",
    type,
    actorType: "system",
    payload: {},
    occurredAt: new Date(at),
    recordedAt: new Date(at),
    ...extra,
  };
}

describe("event-sourced projection (3 dimensions stay independent)", () => {
  it("happy path: submitted → viewed → approved → paid → released", () => {
    const state = reduceMilestone([
      ev("MilestoneSubmitted", "2026-01-01T00:00:00Z"),
      ev("DeliverablePreviewShared", "2026-01-01T01:00:00Z"),
      ev("MilestoneViewed", "2026-01-01T02:00:00Z"),
      ev("MilestoneApproved", "2026-01-01T03:00:00Z"),
      ev("PaymentRequested", "2026-01-01T04:00:00Z"),
      ev("PaymentReceived", "2026-01-01T05:00:00Z"),
      ev("DeliverableReleased", "2026-01-01T06:00:00Z"),
    ]);
    expect(state).toEqual({ work: "approved", payment: "paid", delivery: "released" });
  });

  it("INVARIANT: PaymentClaimed never marks paid", () => {
    const state = reduceMilestone([
      ev("PaymentRequested", "2026-01-01T00:00:00Z"),
      ev("PaymentClaimed", "2026-01-01T01:00:00Z", { actorType: "client" }),
    ]);
    expect(state.payment).toBe("claimed_unverified");
    expect(state.payment).not.toBe("paid");
  });

  it("approval ≠ paid ≠ released: approved alone releases nothing", () => {
    const state = reduceMilestone([
      ev("MilestoneSubmitted", "2026-01-01T00:00:00Z"),
      ev("MilestoneApproved", "2026-01-01T01:00:00Z"),
    ]);
    expect(state.work).toBe("approved");
    expect(state.payment).toBe("unpaid");
    expect(state.delivery).toBe("locked");
  });

  it("revision loop preserves history; unknown future types are ignored", () => {
    const state = reduceMilestone([
      ev("MilestoneSubmitted", "2026-01-01T00:00:00Z"),
      ev("RevisionRequested", "2026-01-01T01:00:00Z"),
      ev("RevisionSubmitted", "2026-01-01T02:00:00Z"),
      ev("SomeFutureEventType", "2026-01-01T03:00:00Z"),
      ev("MilestoneApproved", "2026-01-01T04:00:00Z"),
    ]);
    expect(state.work).toBe("approved");
  });

  it("refund after release flags payment but history fact stays released", () => {
    const state = reduceMilestone([
      ev("PaymentReceived", "2026-01-01T00:00:00Z"),
      ev("DeliverableReleased", "2026-01-01T01:00:00Z"),
      ev("PaymentRefunded", "2026-01-02T00:00:00Z", { actorType: "provider" }),
    ]);
    expect(state.payment).toBe("refunded");
    expect(state.delivery).toBe("released");
  });

  it("late-arriving provider confirmation orders by occurred_at, not recorded_at", () => {
    const state = reduceMilestone([
      {
        ...ev("PaymentReceived", "2026-01-05T00:00:00Z"),
        recordedAt: new Date("2026-01-10T00:00:00Z"),
      },
      {
        ...ev("PaymentOverdue", "2026-01-03T00:00:00Z"),
        recordedAt: new Date("2026-01-11T00:00:00Z"),
      },
    ]);
    // overdue (Jan 3) sorts before receipt (Jan 5) → ends paid
    expect(state.payment).toBe("paid");
  });
});
