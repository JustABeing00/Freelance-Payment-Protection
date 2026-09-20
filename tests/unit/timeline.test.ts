import { describe, expect, it } from "vitest";
import {
  TIMELINE_CATEGORIES,
  describeEvent,
  eventCategory,
  filterTimeline,
  isClientSafeEvent,
  summarizeTimeline,
  toClientSafePayload,
} from "../../src/domain/timeline.js";

/**
 * Session 14: evidence timeline.
 * - Every important event has a category + plain-language headline.
 * - Unknown future types stay visible (never dropped).
 * - Filtering is chronological (oldest first).
 * - Client-safe projection strips internals.
 */

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 1, 10, minutes, 0));
}

describe("evidence timeline", () => {
  it("covers every important project event with a category", () => {
    const important = [
      "ProjectCreated",
      "AgreementCreated",
      "AgreementAccepted",
      "MilestoneCreated",
      "PaymentRequested",
      "PaymentReceived",
      "DeliverableVersionCreated",
      "DeliverableViewed",
      "RevisionRequested",
      "RevisionSubmitted",
      "MilestoneApproved",
      "PaymentOverdue",
      "ReminderSent",
      "PaymentPlanOffered",
      "PaymentPlanAccepted",
      "ProjectPaused",
      "DeliverableReleased",
    ];
    for (const type of important) {
      const d = describeEvent({ type });
      expect(d.headline.length).toBeGreaterThan(3);
      expect(d.detail.length).toBeGreaterThan(3);
      expect(TIMELINE_CATEGORIES).toContain(d.category);
    }
    expect(eventCategory("PaymentRequested")).toBe("payment");
    expect(eventCategory("MilestoneApproved")).toBe("approval");
    expect(eventCategory("ProjectPaused")).toBe("project");
    expect(eventCategory("DeliverableReleased")).toBe("deliverable");
    // Session 18: queued notices render under the reminder category.
    expect(eventCategory("NotificationQueued")).toBe("reminder");
    const queued = describeEvent({
      type: "NotificationQueued",
      payload: { kind: "project_paused", category: "pauses" },
    });
    expect(queued.headline).toContain("project_paused");
    expect(queued.detail).toContain("notification center");
    expect(isClientSafeEvent("NotificationQueued")).toBe(false);
  });

  it("keeps unknown future types visible instead of dropping them", () => {
    const d = describeEvent({ type: "SomethingFrom2030" });
    expect(d.category).toBe("system");
    expect(d.headline.length).toBeGreaterThan(0);
    expect(isClientSafeEvent("SomethingFrom2030")).toBe(false);
  });

  it("filters chronologically by category, actor, milestone, date and search", () => {
    const rows = [
      { id: "a", type: "ProjectCreated", actorType: "freelancer", occurredAt: at(3), payload: {} },
      {
        id: "b",
        type: "PaymentRequested",
        actorType: "freelancer",
        milestoneId: "m1",
        occurredAt: at(1),
        payload: {},
      },
      {
        id: "c",
        type: "MilestoneApproved",
        actorType: "client",
        milestoneId: "m1",
        occurredAt: at(2),
        payload: {},
      },
    ];
    // Chronological regardless of input order.
    expect(filterTimeline(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(filterTimeline(rows, { categories: ["payment"] }).map((r) => r.id)).toEqual(["b"]);
    expect(filterTimeline(rows, { actorTypes: ["client"] }).map((r) => r.id)).toEqual(["c"]);
    expect(filterTimeline(rows, { milestoneId: "m1" }).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterTimeline(rows, { from: at(2) }).map((r) => r.id)).toEqual(["c", "a"]);
    expect(filterTimeline(rows, { to: at(2) }).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterTimeline(rows, { types: ["ProjectCreated"] }).map((r) => r.id)).toEqual(["a"]);
  });

  it("strips internals from the client-safe payload", () => {
    const safe = toClientSafePayload({
      title: "Milestone 1",
      amountCents: 500,
      providerPaymentId: "pi_secret",
      tokenHash: "abc",
      ipHash: "def",
      actorId: "user-1",
    });
    expect(safe).toEqual({ title: "Milestone 1", amountCents: 500 });
    // Review-adjacent rows stay visible; raw automation rows do not.
    expect(isClientSafeEvent("MilestoneApproved")).toBe(true);
    expect(isClientSafeEvent("PaymentClaimed")).toBe(true);
    expect(isClientSafeEvent("WebhookReceived")).toBe(false);
    expect(isClientSafeEvent("PortalLinkIssued")).toBe(false);
    expect(isClientSafeEvent("ReminderSent")).toBe(false);
  });

  it("summarizes the trail for the 'what happened?' answer", () => {
    const rows = [
      { id: "a", type: "ProjectCreated", actorType: "freelancer", occurredAt: at(0), payload: {} },
      {
        id: "b",
        type: "PaymentRequested",
        actorType: "freelancer",
        occurredAt: at(1),
        payload: {},
      },
    ];
    const summary = summarizeTimeline(rows);
    expect(summary.totalCount).toBe(2);
    expect(summary.byCategory.project).toBe(1);
    expect(summary.byCategory.payment).toBe(1);
    expect(summary.oldestAt).toBe(at(0).toISOString());
    expect(summary.newestAt).toBe(at(1).toISOString());
  });
});
