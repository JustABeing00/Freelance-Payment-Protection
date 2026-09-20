import { describe, expect, it } from "vitest";
import { buildProjectSummary } from "../../src/domain/projectView.js";
import type {
  MilestoneRecord,
  PaymentRecord,
  ProjectEventRecord,
  ProjectRecord,
} from "../../src/lib/store.js";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = new Date("2026-09-01T00:00:00Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    clientId: "33333333-3333-4333-8333-333333333333",
    title: "Website rebuild",
    currency: "USD",
    totalValueCents: 500000,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function milestone(overrides: Partial<MilestoneRecord> = {}): MilestoneRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    title: "Milestone 1 — Discovery",
    amountCents: 100000,
    workState: "draft",
    paymentState: "unpaid",
    orderIndex: 0,
    ...overrides,
  };
}

describe("project command-center summary", () => {
  it("shows totals with nothing paid and a draft first step", () => {
    const s = buildProjectSummary({
      project: project(),
      milestones: [milestone()],
      payments: [],
      events: [],
      now: new Date("2026-09-02T00:00:00Z"),
    });
    expect(s.totalValueCents).toBe(500000);
    expect(s.amountPaidCents).toBe(0);
    expect(s.outstandingCents).toBe(100000);
    expect(s.paymentStatus).toBe("unpaid");
    expect(s.currentMilestone?.title).toContain("Milestone 1");
    expect(s.nextAction).toMatch(/share/i);
    expect(s.recentActivity).toEqual([]);
  });

  it("counts only verified receipts; claims never mark paid", () => {
    const paid: PaymentRecord = {
      id: "p1",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      projectId: "11111111-1111-4111-8111-111111111111",
      milestoneId: "44444444-4444-4444-8444-444444444444",
      amountCents: 100000,
      state: "received",
    };
    const claimed: PaymentRecord = {
      ...paid,
      id: "p2",
      amountCents: 99999,
      state: "claimed_unverified",
    };
    const s = buildProjectSummary({
      project: project(),
      milestones: [milestone()],
      payments: [claimed],
      events: [],
      now: new Date("2026-09-02T00:00:00Z"),
    });
    expect(s.amountPaidCents).toBe(0);
    expect(s.paymentStatus).toBe("unpaid");

    const s2 = buildProjectSummary({
      project: project(),
      milestones: [milestone()],
      payments: [paid],
      events: [],
      now: new Date("2026-09-02T00:00:00Z"),
    });
    expect(s2.amountPaidCents).toBe(100000);
    expect(s2.currentMilestone).toBeNull();
    expect(s2.nextAction).toMatch(/evidence/i);
  });

  it("flags overdue and surfaces recent activity", () => {
    const late = milestone({
      dueDate: new Date("2026-08-01T00:00:00Z"),
      workState: "approved",
      paymentState: "requested",
    });
    const event: ProjectEventRecord = {
      id: "e1",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      projectId: "11111111-1111-4111-8111-111111111111",
      type: "PaymentRequested",
      actorType: "freelancer",
      occurredAt: new Date("2026-08-20T00:00:00Z"),
      payload: {},
    };
    const s = buildProjectSummary({
      project: project(),
      milestones: [late],
      payments: [],
      events: [event],
      now: new Date("2026-09-10T00:00:00Z"),
    });
    expect(s.paymentStatus).toBe("overdue");
    expect(s.nextAction).toMatch(/overdue/i);
    expect(s.recentActivity).toHaveLength(1);
    expect(s.recentActivity[0]?.label).toBe("Payment requested");
  });
});
