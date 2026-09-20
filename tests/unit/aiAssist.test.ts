import { describe, expect, it } from "vitest";
import {
  AI_ASSIST_DISCLAIMER,
  assertAssistCopy,
  checkAgreementConsistency,
  draftPaymentReminder,
  extractCommunicationEvents,
  extractContractTerms,
  summarizeEvidenceTimeline,
} from "../../src/domain/aiAssist.js";

describe("aiAssist domain", () => {
  it("extracts contract terms with verbatim quotes and reports missing fields", () => {
    const text = [
      "Payment terms: Net 15, payable by bank transfer.",
      "Milestone 1 — Design ($500) due 2026-10-01.",
      "Late fee of 2% per month applies after the due date.",
      "Up to 2 revisions per milestone; extra revisions billed separately.",
      "Final delivery upon final payment via shared drive handover.",
    ].join(" ");
    const result = extractContractTerms(text);
    expect(result.reviewRequired).toBe(true);
    expect(result.disclaimer).toBe(AI_ASSIST_DISCLAIMER);
    const byField = new Map(result.fields.map((f) => [f.field, f] as const));
    expect(byField.get("payment_terms")?.found).toBe(true);
    expect(byField.get("milestones")?.found).toBe(true);
    expect(byField.get("deadlines")?.found).toBe(true);
    expect(byField.get("late_fee")?.found).toBe(true);
    expect(byField.get("revision_terms")?.found).toBe(true);
    expect(byField.get("final_delivery")?.found).toBe(true);
    for (const field of result.fields) {
      for (const quote of field.quotes) {
        expect(text).toContain(quote);
      }
    }
    expect(result.missingFields).toHaveLength(0);
  });

  it("never invents terms: empty matches report found:false", () => {
    const result = extractContractTerms("Hello, just checking in on the project status.");
    expect(result.fields.every((f) => !f.found)).toBe(true);
    expect(result.missingFields).toHaveLength(6);
  });

  it("extracts communication events with quotes only", () => {
    const text =
      "Hi! The design looks good, approved. I will pay by 2026-10-05. " +
      "Cash-flow is tight — can we do a payment plan with installments?";
    const result = extractCommunicationEvents(text);
    expect(result.reviewRequired).toBe(true);
    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toContain("promised_payment_date");
    expect(kinds).toContain("payment_plan_discussion");
    for (const event of result.events) {
      expect(text).toContain(event.quote);
    }
    const promised = result.events.find((e) => e.kind === "promised_payment_date");
    expect(promised?.observedDateText).toBe("2026-10-05");
  });

  it("drafts reminders strictly from facts with professional copy", () => {
    const draft = draftPaymentReminder(
      {
        workspaceName: "Studio",
        clientName: "Acme",
        projectTitle: "Brand site",
        milestoneTitle: "Milestone 1",
        amountCents: 50000,
        currency: "USD",
        dueDateIso: "2026-10-01",
        daysOverdue: 5,
        outstandingCents: 50000,
      },
      "friendly",
    );
    expect(draft.reviewRequired).toBe(true);
    expect(draft.financialRecordsChanged).toBe(false);
    expect(draft.subject).toContain("Milestone 1");
    expect(draft.body).toContain("$500.00");
    expect(draft.body).toContain("2026-10-01");
    expect(draft.body).toContain("verified payments automatically");
    const blob = `${draft.subject} ${draft.body}`.toLowerCase();
    for (const banned of ["fraud", "scam", "sue", "lawsuit", "court", "guarantee"]) {
      expect(blob).not.toContain(banned);
    }
  });

  it("summarizes the timeline as dated bullets without conclusions", () => {
    const summary = summarizeEvidenceTimeline([
      {
        occurredAt: new Date("2026-09-01T10:00:00Z"),
        actorType: "client",
        headline: "Milestone 1 approved",
        type: "MilestoneApproved",
      },
      {
        occurredAt: new Date("2026-09-05T10:00:00Z"),
        actorType: "system",
        headline: "Reminder sent for Milestone 1",
        type: "ReminderSent",
      },
    ]);
    expect(summary.eventCount).toBe(2);
    expect(summary.bullets).toHaveLength(2);
    expect(summary.bullets[0]).toContain("2026-09-01");
    expect(summary.bullets[0]).toContain("the client");
    expect(summary.financialRecordsChanged).toBe(false);
    const blob = summary.bullets.join(" ").toLowerCase();
    for (const banned of ["fraud", "guilty", "breach", "sue"]) {
      expect(blob).not.toContain(banned);
    }
  });

  it("flags agreement contradictions with evidence", () => {
    const report = checkAgreementConsistency({
      agreement: {
        version: 1,
        status: "accepted",
        totalAmountCents: 100000,
        depositAmountCents: 50000,
        schedule: [
          { title: "Milestone 1", amountCents: 50000 },
          { title: "Milestone 2", amountCents: 50000 },
        ],
        finalDeliveryDescription: "Short",
        lateFeeKind: "none",
        maxRevisionsPerMilestone: 2,
      },
      milestones: [
        { id: "m1", title: "Milestone 1", amountCents: 40000, orderIndex: 0 },
        { id: "m2", title: "Milestone 2", amountCents: 50000, orderIndex: 1 },
      ],
      projectTotalCents: 100000,
    });
    expect(report.reviewRequired).toBe(true);
    expect(report.financialRecordsChanged).toBe(false);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain("milestone_amount_mismatch");
    expect(codes).toContain("deposit_amount_mismatch");
    expect(codes).toContain("invoice_due_date_missing");
    expect(codes).toContain("final_delivery_condition_missing");
    expect(report.attentionCount).toBeGreaterThan(0);
  });

  it("reports consistent agreements factually", () => {
    const report = checkAgreementConsistency({
      agreement: {
        version: 2,
        status: "accepted",
        totalAmountCents: 100000,
        depositAmountCents: 50000,
        schedule: [
          { title: "Milestone 1", amountCents: 50000 },
          { title: "Milestone 2", amountCents: 50000 },
        ],
        finalDeliveryDescription: "Final files release after verified payment for each milestone.",
        lateFeeKind: "flat_fee",
        maxRevisionsPerMilestone: 2,
      },
      milestones: [
        {
          id: "m1",
          title: "Milestone 1",
          amountCents: 50000,
          orderIndex: 0,
          dueDate: new Date("2026-10-01T00:00:00Z"),
        },
        {
          id: "m2",
          title: "Milestone 2",
          amountCents: 50000,
          orderIndex: 1,
          dueDate: new Date("2026-11-01T00:00:00Z"),
        },
      ],
      projectTotalCents: 100000,
    });
    expect(report.findings.map((f) => f.code)).toContain("consistent");
    expect(report.attentionCount).toBe(0);
  });

  it("rejects labelling, legal threats, and outcome guarantees", () => {
    expect(() => assertAssistCopy("this client is a scammer")).toThrow();
    expect(() => assertAssistCopy("we will sue you")).toThrow();
    expect(() => assertAssistCopy("guaranteed to win")).toThrow();
    expect(() => extractContractTerms("")).toThrow();
    expect(() => extractCommunicationEvents("   ")).toThrow();
  });
});
