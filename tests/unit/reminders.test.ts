import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDER_POLICY,
  daysOverdue,
  formatAmount,
  getTemplate,
  listTemplates,
  planReminderSchedule,
  REMINDER_TEMPLATES,
  renderTemplate,
  resolvePolicy,
  scheduleIdempotencyKey,
  validateReminderPolicy,
  validateTemplateBody,
  ReminderPolicyError,
  type ReminderPolicy,
} from "../../src/domain/reminders.js";

/**
 * Session 12: the reminder schedule is configurable data, never a hard-coded
 * universal path. The default policy mirrors the task example; freelancers
 * may reshape it freely within the safety rails.
 */

describe("reminder policy", () => {
  it("ships a default policy matching the task example stages", () => {
    const offsets = DEFAULT_REMINDER_POLICY.steps.map((s) => s.offsetDays);
    expect(offsets).toEqual([-3, 0, 3, 7, 14, 21]);
    expect(DEFAULT_REMINDER_POLICY.enabled).toBe(true);
  });

  it("marks escalation + work-paused steps manual-only (never automatic)", () => {
    const manual = DEFAULT_REMINDER_POLICY.steps.filter((s) => s.requiresManual === true);
    expect(manual.map((s) => s.key).sort()).toEqual(["escalation", "work_paused"]);
  });

  it("rejects escalation tones without requiresManual", () => {
    const bad: ReminderPolicy = {
      version: 1,
      channel: "email",
      enabled: true,
      steps: [
        {
          key: "escalation",
          offsetDays: 14,
          label: "Escalation",
          tone: "escalation",
          templateKey: "escalation_notice",
        },
      ],
    };
    expect(() => validateReminderPolicy(bad)).toThrow(ReminderPolicyError);
  });

  it("rejects duplicate offsets and unknown templates", () => {
    const dup: ReminderPolicy = {
      version: 1,
      channel: "email",
      enabled: true,
      steps: [
        { key: "a", offsetDays: 0, label: "A", tone: "neutral", templateKey: "payment_due" },
        { key: "b", offsetDays: 0, label: "B", tone: "neutral", templateKey: "payment_due" },
      ],
    };
    expect(() => validateReminderPolicy(dup)).toThrow(/duplicate offsetDays/);
    const unknown: ReminderPolicy = {
      version: 1,
      channel: "email",
      enabled: true,
      steps: [
        { key: "a", offsetDays: 0, label: "A", tone: "neutral", templateKey: "nope_missing" },
      ],
    };
    expect(() => validateReminderPolicy(unknown)).toThrow(/unknown template/);
  });

  it("resolves project override over workspace defaults over built-in default", () => {
    const workspace = {
      policy: { ...DEFAULT_REMINDER_POLICY, version: 2, maxPerWeek: 1 },
    };
    const project = {
      version: 1,
      channel: "email",
      enabled: true,
      steps: [
        { key: "due", offsetDays: 0, label: "Due", tone: "neutral", templateKey: "payment_due" },
      ],
    };
    expect(resolvePolicy({ workspaceDefaults: {}, projectOverride: {} }).version).toBe(1);
    expect(resolvePolicy({ workspaceDefaults: workspace, projectOverride: {} }).maxPerWeek).toBe(1);
    const resolved = resolvePolicy({ workspaceDefaults: workspace, projectOverride: project });
    expect(resolved.steps).toHaveLength(1);
    expect(resolved.steps[0]?.key).toBe("due");
  });

  it("plans concrete send times anchored at the due date", () => {
    const due = new Date("2026-10-01T00:00:00.000Z");
    const planned = planReminderSchedule({ dueDate: due, policy: DEFAULT_REMINDER_POLICY });
    expect(planned).toHaveLength(6);
    expect(planned[0]?.scheduledAt.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(planned[planned.length - 1]?.scheduledAt.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  it("returns no schedule when the policy is disabled", () => {
    const due = new Date("2026-10-01T00:00:00.000Z");
    const planned = planReminderSchedule({
      dueDate: due,
      policy: { ...DEFAULT_REMINDER_POLICY, enabled: false },
    });
    expect(planned).toEqual([]);
  });

  it("builds stable idempotency keys per step and day", () => {
    const at = new Date("2026-10-04T00:00:00.000Z");
    expect(
      scheduleIdempotencyKey({ milestoneId: "m1", stepKey: "overdue_3d", scheduledAt: at }),
    ).toBe("reminder:m1:overdue_3d:2026-10-04");
  });
});

describe("reminder templates", () => {
  it("renders variables and formats jurisdiction grammatically", () => {
    const template = getTemplate("escalation_notice");
    const { subject, body } = renderTemplate(template, {
      clientName: "Acme",
      milestoneTitle: "Milestone 1 — Build",
      daysOverdue: "14",
      jurisdiction: "",
      workspaceName: "Studio",
    } as never);
    expect(subject).toContain("14 days");
    expect(body).toContain("Jurisdiction note:");
    const withJurisdiction = renderTemplate(template, {
      jurisdiction: "India",
    } as never);
    expect(withJurisdiction.body).toContain("Jurisdiction note (India):");
  });

  it("keeps every default template free of legal threats and Deposit labels", () => {
    const banned = [
      /\bsue\b/i,
      /lawsuit/i,
      /legal action/i,
      /\bcourt\b/i,
      /collections? agency/i,
      /\blien\b/i,
      /deposit/i,
    ];
    for (const template of REMINDER_TEMPLATES) {
      for (const pattern of banned) {
        expect(
          pattern.test(template.subject) || pattern.test(template.body),
          `${template.key} matches ${pattern}`,
        ).toBe(false);
      }
    }
    expect(listTemplates()).toHaveLength(REMINDER_TEMPLATES.length);
  });

  it("rejects custom templates with threatening or Deposit phrasing", () => {
    expect(() => validateTemplateBody("custom", "Subject", "We will sue you in court.")).toThrow(
      ReminderPolicyError,
    );
    expect(() => validateTemplateBody("custom", "50% Deposit due", "Body.")).toThrow(
      ReminderPolicyError,
    );
  });

  it("formats money and counts overdue days", () => {
    expect(formatAmount(120000)).toBe("1,200.00");
    expect(daysOverdue(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-04T12:00:00Z"))).toBe(3);
    expect(daysOverdue(new Date("2026-10-10T00:00:00Z"), new Date("2026-10-04T00:00:00Z"))).toBe(0);
  });
});
