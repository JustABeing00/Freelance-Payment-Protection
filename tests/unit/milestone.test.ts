import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  approveWork,
  changeMilestoneAmount,
  confirmFunding,
  confirmPayout,
  createMilestone,
  createMilestoneSet,
  deriveUnlockStates,
  disputeMilestone,
  markClaimed,
  markUnlockReady,
  markViewed,
  milestoneTotals,
  releaseDeliverable,
  reorderMilestones,
  requestFunding,
  requestPayout,
  requestRevision,
  sharePreview,
  startWork,
  submitWork,
  toLegacyProjection,
  validateMilestoneSequence,
  MilestoneTransitionError,
  DEFAULT_WORKFLOW,
  FLEXIBLE_WORKFLOW,
  type MilestoneState,
} from "../../src/domain/milestone.js";

function draft(orderIndex = 0, overrides: Partial<MilestoneState> = {}): MilestoneState {
  return {
    ...createMilestone({
      projectId: "p1",
      title: `M${orderIndex}`,
      amountCents: 50000,
      currency: "USD",
      orderIndex,
    }),
    ...overrides,
  };
}

function fundedMilestone(): MilestoneState {
  let m = draft(0);
  m = requestFunding(m);
  m = confirmFunding(m, "pay_fund_1");
  return m;
}

function approvedMilestone(): MilestoneState {
  let m = fundedMilestone();
  m = startWork(m);
  m = submitWork(m);
  m = approveWork(m, { approvedVersionId: "v1", currentVersionId: "v1" });
  return { ...m, currentVersionId: "v1", approvedVersionId: "v1" };
}

function expectTransition(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(MilestoneTransitionError);
    expect((err as MilestoneTransitionError).code).toBe(code);
    return;
  }
  throw new Error(`expected MilestoneTransitionError(${code}) but nothing was thrown`);
}

describe("milestone creation", () => {
  it("creates the canonical Discovery/Design/Development/Launch set totalling $4,000", () => {
    const set = createMilestoneSet({ projectId: "p1", currency: "USD" });
    expect(set).toHaveLength(4);
    expect(set.map((m) => m.title)).toEqual(["Discovery", "Design", "Development", "Launch"]);
    expect(set.map((m) => m.amountCents)).toEqual([50000, 100000, 150000, 100000]);
    expect(milestoneTotals(set).totalCents).toBe(400000);
    expect(set[0]?.unlock).toBe("available");
    expect(set[1]?.unlock).toBe("locked");
  });

  it("rejects the Deposit label, bad amounts, bad currency, bad order", () => {
    expectTransition(
      () =>
        createMilestone({
          projectId: "p1",
          title: "50% Deposit",
          amountCents: 100,
          currency: "USD",
          orderIndex: 0,
        }),
      "GUARD_VIOLATION",
    );
    expectTransition(
      () =>
        createMilestone({
          projectId: "p1",
          title: "M",
          amountCents: 0,
          currency: "USD",
          orderIndex: 0,
        }),
      "GUARD_VIOLATION",
    );
    expectTransition(
      () =>
        createMilestone({
          projectId: "p1",
          title: "M",
          amountCents: 10.5,
          currency: "USD",
          orderIndex: 0,
        }),
      "GUARD_VIOLATION",
    );
    expectTransition(
      () =>
        createMilestone({
          projectId: "p1",
          title: "M",
          amountCents: 100,
          currency: "US",
          orderIndex: 0,
        }),
      "GUARD_VIOLATION",
    );
    expectTransition(
      () =>
        createMilestone({
          projectId: "p1",
          title: "M",
          amountCents: 100,
          currency: "USD",
          orderIndex: -1,
        }),
      "GUARD_VIOLATION",
    );
  });

  it("documents every dimension in ALLOWED_TRANSITIONS", () => {
    for (const dim of ["work", "payment", "approval", "deliverable", "unlock"]) {
      expect(ALLOWED_TRANSITIONS[dim]?.length).toBeGreaterThan(0);
    }
    expect(ALLOWED_TRANSITIONS["work"]).toContain("draft→in_progress");
    expect(ALLOWED_TRANSITIONS["payment"]).toContain("payment_pending→paid");
    expect(ALLOWED_TRANSITIONS["unlock"]).toContain("locked→available");
  });
});

describe("happy-path lifecycle (funded → approved → paid → unlocked)", () => {
  it("runs draft → funded → in_progress → approved → paid → released → unlocked", () => {
    let m = draft(0);
    expect(m.payment).toBe("unpaid");
    m = requestFunding(m);
    expect(m.payment).toBe("payment_pending");
    m = confirmFunding(m, "pay_1");
    expect(m.payment).toBe("funded");
    m = startWork(m);
    expect(m.work).toBe("in_progress");
    m = submitWork(m);
    expect(m.work).toBe("submitted");
    expect(m.approval).toBe("pending");
    m = markViewed(m);
    expect(m.work).toBe("viewed");
    m = approveWork(m, { approvedVersionId: "v3", currentVersionId: "v3" });
    expect(m.work).toBe("approved");
    m = sharePreview(m);
    m = markUnlockReady(m);
    m = requestPayout(m);
    expect(m.payment).toBe("payment_pending");
    m = confirmPayout(m, "pay_2");
    expect(m.payment).toBe("paid");
    m = releaseDeliverable(m);
    expect(m.deliverable).toBe("released");
    expect(m.unlock).toBe("unlocked");
  });

  it("supports the revision loop submitted → revision_requested → submitted → approved", () => {
    let m = fundedMilestone();
    m = startWork(m);
    m = submitWork(m);
    m = requestRevision(m, "Please adjust the palette");
    expect(m.work).toBe("revision_requested");
    m = submitWork(m);
    expect(m.work).toBe("submitted");
    m = approveWork(m, { approvedVersionId: "v2", currentVersionId: "v2" });
    expect(m.work).toBe("approved");
  });

  it("unlocks the next milestone only after the predecessor is paid + released", () => {
    const set = createMilestoneSet({ projectId: "p1" });
    let first = set[0] as MilestoneState;
    first = requestFunding(first);
    first = confirmFunding(first, "f1");
    first = startWork(first);
    first = submitWork(first);
    first = approveWork(first, { approvedVersionId: "v1", currentVersionId: "v1" });
    first = { ...first, currentVersionId: "v1", approvedVersionId: "v1" };
    first = requestPayout(first);
    first = confirmPayout(first, "p1");
    first = releaseDeliverable(first);
    const rest = [first, ...(set.slice(1) as MilestoneState[])];
    const derived = deriveUnlockStates(rest);
    expect(derived[0]?.unlock).toBe("unlocked");
    expect(derived[1]?.unlock).toBe("available");
    expect(derived[2]?.unlock).toBe("locked");
    expect(derived[3]?.unlock).toBe("locked");
  });
});

describe("guards: impossible combinations are rejected", () => {
  it("cannot approve nonexistent states (draft/in_progress)", () => {
    expectTransition(
      () => approveWork(draft(0), { approvedVersionId: "v1", currentVersionId: "v1" }),
      "INVALID_TRANSITION",
    );
    let m = fundedMilestone();
    m = startWork(m);
    expectTransition(
      () => approveWork(m, { approvedVersionId: "v1", currentVersionId: "v1" }),
      "INVALID_TRANSITION",
    );
  });

  it("cannot start work on a locked milestone (future stays locked)", () => {
    const set = createMilestoneSet({ projectId: "p1" });
    const second = set[1] as MilestoneState;
    expect(second.unlock).toBe("locked");
    let s = requestFunding(second);
    s = confirmFunding(s, "fx");
    expectTransition(() => startWork(s), "GUARD_VIOLATION");
  });

  it("cannot start work before funding under the default workflow", () => {
    const m = { ...draft(0), unlock: "available" as const };
    expectTransition(() => startWork(m), "GUARD_VIOLATION");
    // …but the flexible workflow allows parallel work.
    expect(startWork(m, FLEXIBLE_WORKFLOW).work).toBe("in_progress");
  });

  it("cannot request payout or release without a version-pinned approval", () => {
    let m = fundedMilestone();
    m = startWork(m);
    m = submitWork(m);
    expectTransition(() => requestPayout(m), "GUARD_VIOLATION");
    expectTransition(() => releaseDeliverable(m), "GUARD_VIOLATION");
    // Wrong version pin is rejected even from submitted.
    expectTransition(
      () => approveWork(m, { approvedVersionId: "v1", currentVersionId: "v2" }),
      "GUARD_VIOLATION",
    );
  });

  it("client claims never count as paid", () => {
    let m = draft(0);
    m = requestFunding(m);
    m = markClaimed(m);
    expect(m.payment).toBe("claimed_unverified");
    expect(toLegacyProjection(m).payment).not.toBe("paid");
    // A verified receipt supersedes the claim.
    m = confirmFunding(m, "verified_1");
    expect(m.payment).toBe("funded");
  });

  it("paying the same milestone twice is rejected (idempotency)", () => {
    const m = fundedMilestone();
    expectTransition(() => confirmFunding(m, "pay_fund_1"), "DUPLICATE_PAYMENT");
    let a = approvedMilestone();
    a = requestPayout(a);
    a = confirmPayout(a, "pay_out_1");
    expect(a.payment).toBe("paid");
    expectTransition(() => confirmPayout(a, "pay_out_1"), "DUPLICATE_PAYMENT");
    expectTransition(() => confirmPayout(a, "pay_out_2"), "DUPLICATE_PAYMENT");
    expectTransition(() => confirmFunding(a, "pay_out_3"), "DUPLICATE_PAYMENT");
  });

  it("partial receipts keep payment_pending until fully funded", () => {
    let m = draft(0);
    m = requestFunding(m);
    m = confirmFunding(m, "part_1", 10000);
    expect(m.payment).toBe("payment_pending");
    expect(m.appliedPaymentIds).toContain("part_1");
  });

  it("disputes freeze the milestone", () => {
    const m = disputeMilestone(fundedMilestone());
    expect(m.work).toBe("disputed");
    expect(m.payment).toBe("disputed");
    expectTransition(() => requestFunding(m), "INVALID_TRANSITION");
  });
});

describe("amount changes require auditability after funding", () => {
  it("allows free edits before funding, demands audit after", () => {
    const before = draft(0);
    const free = changeMilestoneAmount(before, 60000, null);
    expect(free.milestone.amountCents).toBe(60000);
    expect(free.auditRecord).toBeNull();

    const funded = fundedMilestone();
    expectTransition(() => changeMilestoneAmount(funded, 60000, null), "AUDIT_REQUIRED");
    expectTransition(
      () => changeMilestoneAmount(funded, 60000, { reason: "short", actorId: "u1" }),
      "AUDIT_REQUIRED",
    );
    const audited = changeMilestoneAmount(funded, 60000, {
      reason: "Client added an extra page",
      actorId: "u1",
    });
    expect(audited.milestone.amountCents).toBe(60000);
    expect(audited.auditRecord?.oldAmountCents).toBe(50000);
    expect(audited.milestone.amountHistory).toHaveLength(1);
  });
});

describe("sequence integrity", () => {
  it("rejects gaps, duplicates and mixed currencies", () => {
    const set = createMilestoneSet({ projectId: "p1" });
    const gap = set.filter((_, i) => i !== 1);
    expectTransition(() => validateMilestoneSequence(gap), "SEQUENCE_VIOLATION");
    const dup = [set[0] as MilestoneState, { ...(set[1] as MilestoneState), orderIndex: 0 }];
    expectTransition(() => validateMilestoneSequence(dup), "SEQUENCE_VIOLATION");
    const mixed = [set[0] as MilestoneState, { ...(set[1] as MilestoneState), currency: "EUR" }];
    expectTransition(() => validateMilestoneSequence(mixed), "SEQUENCE_VIOLATION");
  });

  it("rejects backward due dates in sequence order", () => {
    const a = createMilestone({
      projectId: "p1",
      title: "A",
      amountCents: 100,
      currency: "USD",
      orderIndex: 0,
      dueDate: new Date("2026-03-01T00:00:00Z"),
    });
    const b = createMilestone({
      projectId: "p1",
      title: "B",
      amountCents: 100,
      currency: "USD",
      orderIndex: 1,
      dueDate: new Date("2026-01-01T00:00:00Z"),
    });
    expectTransition(() => validateMilestoneSequence([a, b]), "SEQUENCE_VIOLATION");
  });

  it("freezes order after funding unless audited", () => {
    const set = createMilestoneSet({ projectId: "p1" });
    const ids = set.map((m) => m.id);
    const reversed = [...ids].reverse();
    // Unfunded reorder is fine.
    expect(reorderMilestones(set, reversed).map((m) => m.id)).toEqual(reversed);
    // Funded reorder without audit is rejected.
    const funded = set.map((m, i) => (i === 0 ? confirmFunding(requestFunding(m), "f1") : m));
    expectTransition(() => reorderMilestones(funded, reversed), "AUDIT_REQUIRED");
    const ok = reorderMilestones(funded, reversed, {
      reason: "Client reprioritised launch first",
      actorId: "u1",
    });
    expect(ok.map((m) => m.id)).toEqual(reversed);
    expectTransition(() => reorderMilestones(set, [ids[0] as string]), "SEQUENCE_VIOLATION");
  });
});

describe("legacy compatibility", () => {
  it("maps funded/paid onto the canonical paid projection", () => {
    expect(toLegacyProjection(fundedMilestone()).payment).toBe("paid");
    let a = approvedMilestone();
    a = requestPayout(a);
    a = confirmPayout(a, "pz");
    expect(toLegacyProjection(a).payment).toBe("paid");
    expect(toLegacyProjection(a).work).toBe("approved");
  });

  it("totals split funded vs paid", () => {
    const set = createMilestoneSet({ projectId: "p1" });
    const funded = set.map((m, i) =>
      i === 0 ? confirmFunding(requestFunding(m), "f1") : m,
    ) as MilestoneState[];
    expect(milestoneTotals(funded).fundedCents).toBe(50000);
    expect(milestoneTotals(funded).paidCents).toBe(0);
    expect(milestoneTotals(funded).currency).toBe("USD");
  });

  it("default workflow requires funding + approval; flexible relaxes both", () => {
    expect(DEFAULT_WORKFLOW.requireFundingBeforeWork).toBe(true);
    expect(DEFAULT_WORKFLOW.requireApprovalForPayout).toBe(true);
    expect(DEFAULT_WORKFLOW.unlockPolicy).toBe("previous_paid");
    expect(FLEXIBLE_WORKFLOW.requireFundingBeforeWork).toBe(false);
    expect(FLEXIBLE_WORKFLOW.unlockPolicy).toBe("open");
  });
});
