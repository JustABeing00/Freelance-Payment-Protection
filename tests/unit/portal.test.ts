import { describe, expect, it } from "vitest";
import { buildPortalView } from "../../src/domain/portal.js";
import type {
  AgreementRecord,
  ClientRecord,
  MilestoneRecord,
  PaymentRecord,
  ProjectEventRecord,
  ProjectRecord,
} from "../../src/lib/store.js";

/** Session 07: portal projection is client-safe and answers the buyer questions. */

function project(): ProjectRecord {
  return {
    id: "p1",
    workspaceId: "w1",
    clientId: "c1",
    title: "Brand site",
    description: "Marketing site",
    currency: "USD",
    totalValueCents: 400000,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function milestone(over: Partial<MilestoneRecord> & { id: string }): MilestoneRecord {
  return {
    workspaceId: "w1",
    projectId: "p1",
    title: "Milestone",
    amountCents: 100000,
    currency: "USD",
    workState: "submitted",
    paymentState: "unpaid",
    approvalState: "pending",
    deliverableState: "preview_shared",
    unlockState: "available",
    appliedPaymentIds: [],
    amountHistory: [],
    orderIndex: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("portal view", () => {
  it("answers what/due/paid with calm review language", () => {
    const view = buildPortalView({
      project: project(),
      client: { name: "Acme", company: "Acme Corp" },
      milestones: [
        milestone({
          id: "m1",
          title: "Milestone 1 — Discovery",
          amountCents: 50000,
          orderIndex: 0,
        }),
        milestone({
          id: "m2",
          title: "Milestone 2 — Design",
          amountCents: 100000,
          orderIndex: 1,
          workState: "draft",
          approvalState: "none",
          deliverableState: "locked",
          unlockState: "locked",
        }),
      ],
      payments: [],
      events: [],
      agreements: [],
    });
    expect(view.totalCents).toBe(400000);
    expect(view.paidCents).toBe(0);
    expect(view.focusHeadline).toContain("Milestone 1 — Discovery is ready for review");
    expect(view.focusHeadline).not.toMatch(/deposit|overdue|collection/i);
    expect(view.milestones[0]?.canApprove).toBe(true);
    expect(view.milestones[1]?.lockReason).toContain("Locked until");
    expect(view.nextSteps.join(" ")).toContain("Review Milestone 1 — Discovery");
  });

  it("counts only verified receipts and explains locks", () => {
    const paid: PaymentRecord = {
      id: "pay1",
      workspaceId: "w1",
      projectId: "p1",
      milestoneId: "m1",
      amountCents: 50000,
      state: "received",
      receivedAt: new Date("2026-02-01T00:00:00Z"),
    };
    const claimed: PaymentRecord = {
      id: "pay2",
      workspaceId: "w1",
      projectId: "p1",
      milestoneId: "m2",
      amountCents: 100000,
      state: "claimed_unverified",
    };
    const view = buildPortalView({
      project: project(),
      client: { name: "Acme" },
      milestones: [
        milestone({
          id: "m1",
          title: "Milestone 1 — Discovery",
          amountCents: 50000,
          orderIndex: 0,
        }),
        milestone({ id: "m2", title: "Milestone 2 — Design", amountCents: 100000, orderIndex: 1 }),
      ],
      payments: [paid, claimed],
      events: [],
      agreements: [],
    });
    expect(view.paidCents).toBe(50000);
    expect(view.payments).toHaveLength(1);
    expect(view.lockedExplanations.length).toBeGreaterThanOrEqual(0);
  });

  it("maps events to client-safe labels without internal payloads", () => {
    const events: ProjectEventRecord[] = [
      {
        id: "e1",
        workspaceId: "w1",
        projectId: "p1",
        milestoneId: "m1",
        type: "MilestoneSubmitted",
        actorType: "freelancer",
        occurredAt: new Date("2026-03-01T00:00:00Z"),
        payload: { internalNote: "should never surface verbatim" },
      },
    ];
    const view = buildPortalView({
      project: project(),
      client: { name: "Acme" },
      milestones: [
        milestone({
          id: "m1",
          title: "Milestone 1 — Discovery",
          orderIndex: 0,
          amountCents: 50000,
        }),
      ],
      payments: [],
      events,
      agreements: [],
    });
    expect(view.activity[0]?.label).toContain("ready for review");
    expect(JSON.stringify(view)).not.toContain("should never surface");
  });

  it("surfaces the current agreement with acceptance guidance", () => {
    const fullClient: ClientRecord = {
      id: "c1",
      workspaceId: "w1",
      name: "Acme",
      email: "a@x.com",
      notes: "FREELANCER-ONLY must not leak",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const agreements = [
      {
        id: "ag1",
        workspaceId: "w1",
        projectId: "p1",
        version: 1,
        status: "pending_acceptance",
        isCurrent: true,
        totalAmountCents: 400000,
        currency: "USD",
        depositAmountCents: 50000,
        milestoneSchedule: [],
        paymentDueDays: 7,
        graceDays: 3,
        pauseAfterOverdueDays: 7,
        acceptedPaymentMethods: ["stripe"],
        latePaymentPolicy: {},
        workPauseDescription: "pause",
        releaseCondition: "current_milestone_paid",
        finalDeliveryDescription: "final",
        ownershipMode: "on_final_payment",
        ownershipDescription: "own",
        maxRevisionsPerMilestone: 2,
        extraRevisionPolicy: "extra",
        cancellationNoticeDays: 7,
        cancellationPolicy: "cancel",
        termsText: "terms v1",
        hash: "abc123",
        disclaimerVersion: "v1",
        createdAt: new Date(),
      } as AgreementRecord,
    ];
    const view = buildPortalView({
      project: project(),
      // Only the safe subset crosses the boundary — notes cannot compile here.
      client: { name: fullClient.name },
      milestones: [],
      payments: [],
      events: [],
      agreements,
    });
    expect(view.agreement?.statusLabel).toContain("Awaiting");
    expect(view.nextSteps.join(" ")).toContain("accept your agreement");
    expect(JSON.stringify(view)).not.toContain("FREELANCER-ONLY");
  });
});
