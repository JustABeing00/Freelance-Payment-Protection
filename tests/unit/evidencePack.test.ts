import { describe, expect, it } from "vitest";
import {
  assertFactualCopy,
  buildEvidencePackSnapshot,
  canonicalizeSnapshot,
  hashEvidencePack,
  renderEvidencePackHtml,
  type EvidencePackBuilderInput,
} from "../../src/domain/evidencePack.js";

/**
 * Session 15: evidence pack domain.
 * - Every required section is present when applicable.
 * - Copy stays factual: no legal conclusions, no outcome guarantees.
 * - Money: verified receipts count; claims never do.
 * - Hashing is stable and sensitive to content.
 */

function baseInput(): EvidencePackBuilderInput {
  const at = (day: string): Date => new Date(`${day}T10:00:00.000Z`);
  return {
    generatedBy: "user-1",
    generatedAt: at("2026-09-18"),
    parties: {
      workspaceName: "Studio North",
      clientName: "Acme Corp",
      clientCompany: "Acme",
      clientEmail: "pay@acme.example",
    },
    project: {
      id: "project-1",
      title: "Brand site",
      description: "Marketing site rebuild",
      currency: "USD",
      totalValueCents: 240000,
      status: "active",
      paymentTerms: "Milestone 1 on approval, balance on delivery",
      createdAt: at("2026-09-01"),
    },
    agreements: [
      {
        version: 1,
        status: "accepted",
        hash: "a".repeat(64),
        totalAmountCents: 240000,
        currency: "USD",
        depositAmountCents: 0,
        paymentDueDays: 7,
        graceDays: 3,
        acceptedPaymentMethods: ["stripe"],
        sentAt: at("2026-09-02"),
        acceptedAt: at("2026-09-03"),
        acceptedBy: "Alex Client",
      },
    ],
    milestones: [
      {
        id: "m1",
        title: "Milestone 1 — Build",
        amountCents: 240000,
        currency: "USD",
        dueDate: at("2026-09-10"),
        workState: "submitted",
        paymentState: "overdue",
        approvalState: "approved",
        orderIndex: 0,
      },
    ],
    payments: [
      {
        id: "pay-claim",
        milestoneId: "m1",
        amountCents: 240000,
        currency: "USD",
        state: "pending",
        provider: "stripe",
        createdAt: at("2026-09-11"),
      },
      {
        id: "pay-real",
        milestoneId: "m1",
        amountCents: 60000,
        currency: "USD",
        state: "paid",
        provider: "stripe",
        createdAt: at("2026-09-12"),
        receivedAt: at("2026-09-12"),
      },
    ],
    deliverables: [
      {
        id: "d1",
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        title: "Homepage",
        status: "client_review",
        currentVersionNo: 2,
        approvedVersionNo: 1,
        versions: [
          { versionNo: 1, createdAt: at("2026-09-05"), fileCount: 1, linkCount: 0 },
          { versionNo: 2, createdAt: at("2026-09-08"), fileCount: 1, linkCount: 1 },
        ],
      },
    ],
    approvals: [
      {
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        decision: "approved",
        versionNo: 1,
        actorType: "client",
        createdAt: at("2026-09-06"),
      },
    ],
    reminders: [
      {
        id: "r1",
        milestoneId: "m1",
        template: "payment_due",
        state: "sent",
        recipient: "pay@acme.example",
        scheduledFor: at("2026-09-10"),
        sentAt: at("2026-09-10"),
      },
    ],
    paymentPlans: [
      {
        id: "plan-1",
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        version: 1,
        state: "active",
        originalAmountCents: 180000,
        currency: "USD",
        offeredAt: at("2026-09-13"),
        acceptedAt: at("2026-09-14"),
        installments: [
          { seq: 1, amountCents: 90000, dueDate: at("2026-09-20"), status: "scheduled" },
          { seq: 2, amountCents: 90000, dueDate: at("2026-09-27"), status: "scheduled" },
        ],
      },
    ],
    events: [
      {
        id: "e1",
        type: "ProjectCreated",
        actorType: "freelancer",
        occurredAt: at("2026-09-01"),
        payload: { title: "Brand site" },
      },
      {
        id: "e2",
        type: "MilestoneApproved",
        actorType: "client",
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        occurredAt: at("2026-09-06"),
        payload: {},
      },
      {
        id: "e3",
        type: "RevisionRequested",
        actorType: "client",
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        occurredAt: at("2026-09-07"),
        payload: { note: "Adjust spacing" },
      },
      {
        id: "e4",
        type: "RevisionSubmitted",
        actorType: "freelancer",
        milestoneId: "m1",
        milestoneTitle: "Milestone 1 — Build",
        occurredAt: at("2026-09-08"),
        payload: {},
      },
    ],
  };
}

describe("evidence pack snapshot", () => {
  it("covers every required section with factual statements", () => {
    const snapshot = buildEvidencePackSnapshot(baseInput());
    expect(snapshot.parties.clientName).toBe("Acme Corp");
    expect(snapshot.project.title).toBe("Brand site");
    expect(snapshot.project.paymentTerms).toContain("Milestone 1");
    expect(snapshot.agreement.currentVersion).toBe(1);
    expect(snapshot.agreement.versionHashes).toEqual(["a".repeat(64)]);
    expect(snapshot.milestones).toHaveLength(1);
    expect(snapshot.payments).toHaveLength(2);
    expect(snapshot.deliverables[0]?.versions).toHaveLength(2);
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.revisions.map((r) => r.type)).toEqual([
      "RevisionRequested",
      "RevisionSubmitted",
    ]);
    expect(snapshot.reminders).toHaveLength(1);
    expect(snapshot.paymentPlans).toHaveLength(1);
    expect(snapshot.timeline.map((e) => e.type)).toEqual([
      "ProjectCreated",
      "MilestoneApproved",
      "RevisionRequested",
      "RevisionSubmitted",
    ]);
    expect(snapshot.integrity.eventCount).toBe(4);

    // Factual approval phrasing: date + actor + version, no conclusions.
    expect(snapshot.approvals[0]?.statement).toMatch(
      /^On 2026-09-06, the client approved Milestone 1 — Build version 1\.$/,
    );
    // Disclaimers travel with every export.
    expect(snapshot.disclaimer).toMatch(/Not legal advice/);
    expect(snapshot.noGuarantee).toMatch(/does not predict or guarantee/);
  });

  it("counts only verified receipts toward paid, never claims", () => {
    const snapshot = buildEvidencePackSnapshot(baseInput());
    expect(snapshot.financialSummary.milestonesTotalCents).toBe(240000);
    expect(snapshot.financialSummary.verifiedPaidCents).toBe(60000);
    expect(snapshot.financialSummary.outstandingCents).toBe(180000);
    expect(snapshot.financialSummary.verifiedOnlyNote).toMatch(/Only provider-confirmed/);
    const byId = new Map(snapshot.payments.map((p) => [p.id, p] as const));
    expect(byId.get("pay-claim")?.verified).toBe(false);
    expect(byId.get("pay-real")?.verified).toBe(true);
  });

  it("tolerates an empty project without throwing", () => {
    const empty: EvidencePackBuilderInput = {
      ...baseInput(),
      agreements: [],
      milestones: [],
      payments: [],
      deliverables: [],
      approvals: [],
      reminders: [],
      paymentPlans: [],
      events: [],
    };
    const snapshot = buildEvidencePackSnapshot(empty);
    expect(snapshot.integrity.eventCount).toBe(0);
    expect(snapshot.financialSummary.outstandingCents).toBe(0);
    expect(snapshot.timeline).toEqual([]);
  });

  it("pins stable bytes: same input, same hash; changed input, new hash", () => {
    const a = buildEvidencePackSnapshot(baseInput());
    const b = buildEvidencePackSnapshot(baseInput());
    expect(canonicalizeSnapshot(a)).toBe(canonicalizeSnapshot(b));
    expect(hashEvidencePack(canonicalizeSnapshot(a))).toBe(
      hashEvidencePack(canonicalizeSnapshot(b)),
    );
    expect(hashEvidencePack(canonicalizeSnapshot(a))).toMatch(/^[0-9a-f]{64}$/);

    const changed = buildEvidencePackSnapshot({
      ...baseInput(),
      payments: [],
    });
    expect(hashEvidencePack(canonicalizeSnapshot(changed))).not.toBe(
      hashEvidencePack(canonicalizeSnapshot(a)),
    );
  });

  it("rejects legal conclusions and outcome guarantees in copy", () => {
    expect(() => assertFactualCopy("On March 13, the client approved version 4.")).not.toThrow();
    for (const bad of [
      "This proves the client committed fraud.",
      "The client is liable for breach of contract.",
      "This pack guarantees success in your dispute.",
      "We will see you in court.",
    ]) {
      expect(() => assertFactualCopy(bad)).toThrow(/must stay factual/);
    }
  });

  it("renders a clean printable export without legal conclusions", () => {
    const snapshot = buildEvidencePackSnapshot(baseInput());
    const html = renderEvidencePackHtml(snapshot, {
      packId: "pack-1",
      sha256: hashEvidencePack(canonicalizeSnapshot(snapshot)),
      artifactRef: "evidence-pack/project-1/2026-09-18.json",
    });
    expect(html).toContain("Brand site");
    expect(html).toContain("Not legal advice");
    expect(html).toContain("does not predict or guarantee");
    expect(html).toContain("Save as PDF");
    expect(html.toLowerCase()).not.toContain("fraud");
    expect(html.toLowerCase()).not.toContain("guarantee success");
    expect(() => assertFactualCopy(html)).not.toThrow();
  });
});
