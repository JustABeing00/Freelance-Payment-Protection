import { describe, expect, it } from "vitest";
import {
  AGREEMENT_DISCLAIMER,
  acceptAgreement,
  buildAgreementText,
  createAgreementDraft,
  hashAgreementTerms,
  sameAgreementContent,
  sendForAcceptance,
  supersedeAgreement,
  verifyAgreementHash,
  voidAgreement,
  type AgreementTerms,
} from "../../src/domain/agreement.js";

function validTerms(overrides: Partial<AgreementTerms> = {}): AgreementTerms {
  return {
    totalAmountCents: 400000,
    currency: "USD",
    depositAmountCents: 50000,
    milestoneSchedule: [
      { title: "Milestone 1 — Discovery", amountCents: 50000 },
      { title: "Milestone 2 — Design", amountCents: 100000 },
      { title: "Milestone 3 — Development", amountCents: 150000 },
      { title: "Milestone 4 — Launch", amountCents: 100000 },
    ],
    paymentDueDays: 7,
    graceDays: 3,
    acceptedPaymentMethods: ["bank_transfer", "stripe"],
    latePaymentPolicy: { kind: "none", description: "No late fee; reminders only." },
    pauseAfterOverdueDays: 7,
    workPauseDescription: "Work pauses 7 days after the due date until payment arrives.",
    releaseCondition: "current_milestone_paid",
    finalDeliveryDescription: "Final files released when the current milestone is paid.",
    ownershipMode: "on_final_payment",
    ownershipDescription: "Ownership transfers on final payment.",
    maxRevisionsPerMilestone: 2,
    extraRevisionPolicy: "Extra revisions billed at $50 each.",
    cancellationNoticeDays: 7,
    cancellationPolicy: "Either party may cancel with 7 days notice; work done is billed.",
    ...overrides,
  };
}

function draft(version = 1) {
  return createAgreementDraft({
    id: `agr-${version}`,
    workspaceId: "ws-1",
    projectId: "pr-1",
    version,
    terms: validTerms(),
    projectTitle: "Brand site",
    clientName: "Acme",
  });
}

describe("agreement domain", () => {
  it("creates a draft with a stable hash and disclaimer text", () => {
    const a = draft();
    expect(a.status).toBe("draft");
    expect(a.version).toBe(1);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgreementTerms(validTerms())).toBe(a.hash);
    expect(verifyAgreementHash(a)).toBe(true);
    expect(a.termsText).toContain("Milestone 1 — Discovery");
    expect(a.termsText).toContain(a.hash);
    expect(a.termsText).toContain("not a law firm");
    expect(a.disclaimerVersion).toBe("v1");
    expect(AGREEMENT_DISCLAIMER).toContain("not a law firm");
  });

  it("runs draft → sent → accepted → superseded", () => {
    const sent = sendForAcceptance(draft());
    expect(sent.status).toBe("pending_acceptance");
    expect(sent.sentAt).toBeInstanceOf(Date);
    const accepted = acceptAgreement(sent, { acceptedBy: "Acme Client" });
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedBy).toBe("Acme Client");
    const superseded = supersedeAgreement(accepted);
    expect(superseded.status).toBe("superseded");
    expect(superseded.isCurrent).toBe(false);
  });

  it("rejects accepting a draft that was never sent", () => {
    expect(() => acceptAgreement(draft(), { acceptedBy: "Acme" })).toThrow(
      /only sent versions can be accepted/,
    );
  });

  it("rejects double acceptance", () => {
    const accepted = acceptAgreement(sendForAcceptance(draft()), { acceptedBy: "Acme" });
    expect(() => acceptAgreement(accepted, { acceptedBy: "Acme" })).toThrow(/already accepted/);
  });

  it("rejects sending twice and voids only drafts/sent versions", () => {
    const sent = sendForAcceptance(draft());
    expect(() => sendForAcceptance(sent)).toThrow(/only drafts can be sent/);
    expect(voidAgreement(draft()).status).toBe("voided");
    expect(voidAgreement(sent).status).toBe("voided");
    const accepted = acceptAgreement(sendForAcceptance(draft()), { acceptedBy: "Acme" });
    expect(() => voidAgreement(accepted)).toThrow(/only drafts or sent/);
    expect(() => supersedeAgreement(sent)).toThrow(/only accepted/);
  });

  it("requires acceptedBy to name who accepted", () => {
    const sent = sendForAcceptance(draft());
    expect(() => acceptAgreement(sent, { acceptedBy: " " })).toThrow(/acceptedBy/);
  });

  it("rejects schedule sums that differ from the total", () => {
    expect(() => validTermsMismatched()).toThrow(/must sum to the total/);
    function validTermsMismatched() {
      const terms = validTerms({ totalAmountCents: 400001 });
      // validate via draft creation
      return createAgreementDraft({
        id: "x",
        workspaceId: "ws",
        projectId: "pr",
        version: 1,
        terms,
        projectTitle: "P",
        clientName: "C",
      });
    }
  });

  it("requires deposit to equal the first milestone (deposit = Milestone 1)", () => {
    expect(() =>
      createAgreementDraft({
        id: "x",
        workspaceId: "ws",
        projectId: "pr",
        version: 1,
        terms: validTerms({ depositAmountCents: 1 }),
        projectTitle: "P",
        clientName: "C",
      }),
    ).toThrow(/depositAmountCents must equal the first milestone/);
  });

  it("rejects the Deposit label in schedule titles", () => {
    expect(() =>
      createAgreementDraft({
        id: "x",
        workspaceId: "ws",
        projectId: "pr",
        version: 1,
        terms: validTerms({
          milestoneSchedule: [{ title: "50% Deposit", amountCents: 400000 }],
          depositAmountCents: 400000,
        }),
        projectTitle: "P",
        clientName: "C",
      }),
    ).toThrow(/Deposit/);
  });

  it("rejects out-of-range policy windows and missing methods", () => {
    expect(() =>
      createAgreementDraft({
        id: "x",
        workspaceId: "ws",
        projectId: "pr",
        version: 1,
        terms: validTerms({ paymentDueDays: 91 }),
        projectTitle: "P",
        clientName: "C",
      }),
    ).toThrow(/paymentDueDays/);
    expect(() =>
      createAgreementDraft({
        id: "x",
        workspaceId: "ws",
        projectId: "pr",
        version: 1,
        terms: validTerms({ acceptedPaymentMethods: [] }),
        projectTitle: "P",
        clientName: "C",
      }),
    ).toThrow(/payment method/);
  });

  it("detects content changes via hash comparison", () => {
    const a = validTerms();
    const b = validTerms({ paymentDueDays: 14 });
    expect(sameAgreementContent(a, b)).toBe(false);
    expect(sameAgreementContent(a, validTerms())).toBe(true);
    expect(verifyAgreementHash({ terms: b, hash: hashAgreementTerms(a) })).toBe(false);
  });

  it("renders all 11 required sections", () => {
    const terms = validTerms();
    const text = buildAgreementText({
      projectTitle: "P",
      clientName: "C",
      version: 1,
      terms,
      hash: hashAgreementTerms(terms),
    });
    for (const n of ["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10.", "11."]) {
      expect(text).toContain(n);
    }
  });
});
