import { describe, expect, it } from "vitest";
import {
  canAttemptDelivery,
  CATEGORY_BY_KIND,
  defaultPreferences,
  getTransactionalTemplate,
  isKnownCategory,
  isKnownKind,
  isPaymentSettled,
  MAX_DELIVERY_ATTEMPTS,
  maySendOverdue,
  nextRetryAt,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_KINDS,
  notificationIdempotencyKey,
  renderTransactional,
  shouldDeliver,
  utcDay,
  type NotificationKind,
} from "../../src/domain/notifications.js";

const BASE_VARS = {
  workspaceName: "Studio",
  clientName: "Acme",
  projectTitle: "Website",
  milestoneTitle: "Milestone 1 — Build",
  amount: "1,200.00",
  currency: "USD",
  dueDate: "2026-10-01",
  daysOverdue: "5",
  portalUrl: "https://portal.example/p/1",
  freelancerName: "Studio",
  detail: "Thanks.",
  unsubscribeUrl: "https://app.example/unsubscribe?token=x",
};

const BANNED = [
  /sue/i,
  /lawsuit/i,
  /court/i,
  /attorney/i,
  /lawyer/i,
  /collections? agency/i,
  /lien/i,
  /scam/i,
  /fraud/i,
  /guarantee/i,
  /deposit/i,
];

describe("transactional notification domain", () => {
  it("covers every required kind with a category", () => {
    const required: NotificationKind[] = [
      "payment_received",
      "payment_failed",
      "payment_refunded",
      "payment_disputed",
      "approval_received",
      "approval_revision_requested",
      "approval_rejected",
      "approval_disputed",
      "milestone_overdue",
      "project_paused",
      "project_unpaused",
      "plan_proposed",
      "plan_accepted",
      "plan_missed",
      "plan_completed",
      "plan_defaulted",
      "deliverable_released",
      "deliverable_approved",
    ];
    for (const kind of required) {
      expect(NOTIFICATION_KINDS).toContain(kind);
      expect(CATEGORY_BY_KIND[kind]).toBeDefined();
    }
    expect(isKnownKind("payment_received")).toBe(true);
    expect(isKnownKind("nope")).toBe(false);
    expect(isKnownCategory("payments")).toBe(true);
    expect(isKnownCategory("nope")).toBe(false);
  });

  it("renders professional copy for every kind (banned-phrase sweep)", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const template = getTransactionalTemplate(kind);
      const rendered = renderTransactional(
        { subject: template.subject, body: template.body },
        BASE_VARS,
      );
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.body).toContain("Studio");
      expect(rendered.body).toContain("informational record");
      expect(rendered.body).toContain("Manage email preferences");
      expect(rendered.html).toContain("<p>");
      for (const phrase of BANNED) {
        expect(
          phrase.test(rendered.subject) || phrase.test(rendered.body),
          `${kind} tripped ${phrase}`,
        ).toBe(false);
      }
    }
  });

  it("rejects unknown kinds", () => {
    expect(() => getTransactionalTemplate("nope" as NotificationKind)).toThrow();
  });

  it("builds stable idempotency keys (repeats match, scopes differ)", () => {
    const a = notificationIdempotencyKey({
      kind: "milestone_overdue",
      scopeId: "m1",
      dedupe: "2026-10-05",
    });
    const b = notificationIdempotencyKey({
      kind: "milestone_overdue",
      scopeId: "m1",
      dedupe: "2026-10-05",
    });
    const c = notificationIdempotencyKey({
      kind: "milestone_overdue",
      scopeId: "m1",
      dedupe: "2026-10-06",
    });
    const d = notificationIdempotencyKey({
      kind: "payment_received",
      scopeId: "m1",
      dedupe: "2026-10-05",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^notify:milestone_overdue:m1:2026-10-05$/);
  });

  it("stops payment mail once settled, pauses on dispute", () => {
    for (const settled of ["paid", "funded", "refunded"]) {
      expect(isPaymentSettled(settled)).toBe(true);
      expect(maySendOverdue(settled)).toBe(false);
    }
    expect(maySendOverdue("disputed")).toBe(false);
    for (const open of [
      "unpaid",
      "overdue",
      "payment_pending",
      "claimed_unverified",
      "plan_active",
    ]) {
      expect(isPaymentSettled(open)).toBe(false);
      expect(maySendOverdue(open)).toBe(true);
    }
  });

  it("backs off exponentially and caps retries", () => {
    const from = new Date("2026-10-01T00:00:00.000Z");
    expect(nextRetryAt(0, from).getTime() - from.getTime()).toBe(60_000);
    expect(nextRetryAt(1, from).getTime() - from.getTime()).toBe(2 * 60_000);
    expect(nextRetryAt(3, from).getTime() - from.getTime()).toBe(8 * 60_000);
    expect(nextRetryAt(99, from).getTime() - from.getTime()).toBe(240 * 60_000);
    expect(canAttemptDelivery("queued", 0)).toBe(true);
    expect(canAttemptDelivery("failed", MAX_DELIVERY_ATTEMPTS - 1)).toBe(true);
    expect(canAttemptDelivery("failed", MAX_DELIVERY_ATTEMPTS)).toBe(false);
    expect(canAttemptDelivery("sent", 0)).toBe(false);
    expect(canAttemptDelivery("delivered", 0)).toBe(false);
  });

  it("gates delivery on preferences + opt-outs", () => {
    expect(shouldDeliver({ categoryEnabled: true, channelEnabled: true, optedOut: false })).toEqual(
      { deliver: true, reason: "ok" },
    );
    expect(
      shouldDeliver({ categoryEnabled: false, channelEnabled: true, optedOut: false }).deliver,
    ).toBe(false);
    expect(
      shouldDeliver({ categoryEnabled: true, channelEnabled: false, optedOut: false }).deliver,
    ).toBe(false);
    expect(
      shouldDeliver({ categoryEnabled: true, channelEnabled: true, optedOut: true }),
    ).toMatchObject({ deliver: false, reason: "recipient opted out" });
  });

  it("defaults every category to enabled on both channels", () => {
    const prefs = defaultPreferences();
    expect(prefs).toHaveLength(NOTIFICATION_CATEGORIES.length);
    for (const p of prefs) {
      expect(p.email).toBe(true);
      expect(p.inapp).toBe(true);
    }
  });

  it("days render as UTC calendar days", () => {
    expect(utcDay(new Date("2026-10-05T23:59:00.000Z"))).toBe("2026-10-05");
  });
});
