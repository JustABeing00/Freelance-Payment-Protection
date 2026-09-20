import { describe, expect, it } from "vitest";
import {
  deriveApprovalEffect,
  effectiveDecisionForVersion,
  eventTypeForDecision,
  isApprovalCurrent,
  labelForDecision,
  latestDecision,
  validateApprovalInput,
  ApprovalError,
} from "../../src/domain/approvals.js";

function at(
  versionNo: number,
  decision: "approved" | "revision_requested" | "rejected" | "disputed",
  when: string,
) {
  return { id: `a-${versionNo}-${decision}`, decision, versionNo, createdAt: new Date(when) };
}

describe("formal client approval (audit model)", () => {
  it("validates decisions and requires a pinned version", () => {
    expect(validateApprovalInput({ versionNo: 2, decision: "approved" }).versionNo).toBe(2);
    expect(validateApprovalInput({ versionRef: "v1", decision: "approved" }).versionRef).toBe("v1");
    expect(() => validateApprovalInput({ decision: "approved" })).toThrow(ApprovalError);
    expect(() => validateApprovalInput({ versionNo: 0, decision: "approved" })).toThrow(
      ApprovalError,
    );
    expect(() =>
      validateApprovalInput({ versionNo: 1, versionRef: "v1", decision: "approved" }),
    ).toThrow(ApprovalError);
    expect(() => validateApprovalInput({ versionNo: 1, decision: "nope" as never })).toThrow(
      ApprovalError,
    );
  });

  it("requires an actionable note for revision / rejection / dispute", () => {
    expect(() => validateApprovalInput({ versionNo: 1, decision: "revision_requested" })).toThrow(
      ApprovalError,
    );
    expect(() =>
      validateApprovalInput({ versionNo: 1, decision: "revision_requested", note: "ok" }),
    ).toThrow(ApprovalError);
    expect(() => validateApprovalInput({ versionNo: 1, decision: "rejected", note: "no" })).toThrow(
      ApprovalError,
    );
    expect(() => validateApprovalInput({ versionNo: 1, decision: "disputed", note: "  " })).toThrow(
      ApprovalError,
    );
    // Approved notes are optional; overlong notes are rejected.
    expect(validateApprovalInput({ versionNo: 1, decision: "approved" })).toMatchObject({
      decision: "approved",
    });
    expect(() =>
      validateApprovalInput({ versionNo: 1, decision: "approved", note: "x".repeat(2001) }),
    ).toThrow(ApprovalError);
  });

  it("pins currency to one version (never ambiguous across versions)", () => {
    expect(isApprovalCurrent({ versionNo: 2 }, { versionNo: 2 })).toBe(true);
    expect(isApprovalCurrent({ versionNo: 2 }, { versionNo: 3 })).toBe(false);
    expect(isApprovalCurrent({ versionRef: "v1" }, { versionRef: "v1" })).toBe(true);
    expect(isApprovalCurrent({ versionRef: "v1" }, { versionRef: "v2" })).toBe(false);
    // Mixed subjects never match.
    expect(isApprovalCurrent({ versionNo: 1 }, { versionRef: "v1" })).toBe(false);
  });

  it("keeps old-version approvals historically true without authorizing new versions", () => {
    // v2 approved, then v3 uploaded with no decision yet: v2's approval is
    // still the effective decision FOR v2, but v3 needs a fresh decision.
    const staleHistory = [at(2, "approved", "2026-09-18T10:00:00Z")];
    expect(effectiveDecisionForVersion(staleHistory, { versionNo: 2 })?.decision).toBe("approved");
    const stale = deriveApprovalEffect(staleHistory, { versionNo: 3 });
    expect(stale.isApproved).toBe(false);
    expect(stale.isCurrent).toBe(false);
    expect(stale.reason).toContain("fresh decision");

    // A later decision on the new version supersedes without rewriting history.
    const history = [
      at(2, "approved", "2026-09-18T10:00:00Z"),
      at(3, "revision_requested", "2026-09-18T11:00:00Z"),
    ];
    expect(effectiveDecisionForVersion(history, { versionNo: 2 })?.decision).toBe("approved");
    const effect = deriveApprovalEffect(history, { versionNo: 3 });
    expect(effect.isApproved).toBe(false);
    expect(effect.isCurrent).toBe(true);
    expect(effect.reason).toContain("Changes were requested");
    expect(latestDecision(history)?.decision).toBe("revision_requested");
  });

  it("treats the latest decision as authoritative (revision/rejection revokes approval)", () => {
    const approvedOnly = [at(1, "approved", "2026-09-18T10:00:00Z")];
    expect(deriveApprovalEffect(approvedOnly, { versionNo: 1 }).isApproved).toBe(true);

    const revised = [...approvedOnly, at(1, "revision_requested", "2026-09-18T11:00:00Z")];
    const revisedEffect = deriveApprovalEffect(revised, { versionNo: 1 });
    expect(revisedEffect.isApproved).toBe(false);
    expect(revisedEffect.isCurrent).toBe(true);

    const rejected = [at(1, "rejected", "2026-09-18T12:00:00Z")];
    expect(deriveApprovalEffect(rejected, { versionNo: 1 }).isApproved).toBe(false);

    const disputed = [at(1, "disputed", "2026-09-18T12:00:00Z")];
    const disputedEffect = deriveApprovalEffect(disputed, { versionNo: 1 });
    expect(disputedEffect.isApproved).toBe(false);
    expect(disputedEffect.reason).toContain("disputed");

    expect(deriveApprovalEffect([], { versionNo: 1 }).isApproved).toBe(false);
  });

  it("maps decisions to canonical events and client-safe labels", () => {
    expect(eventTypeForDecision("approved")).toBe("MilestoneApproved");
    expect(eventTypeForDecision("revision_requested")).toBe("RevisionRequested");
    expect(eventTypeForDecision("rejected")).toBe("ApprovalRejected");
    expect(eventTypeForDecision("disputed")).toBe("DisputeFlagged");
    expect(labelForDecision("approved", "Logo")).toContain("approved");
    expect(labelForDecision("revision_requested", "Logo")).toContain("Changes requested");
    expect(labelForDecision("rejected", "Logo")).toContain("not approved");
    expect(labelForDecision("disputed", "Logo")).toContain("question");
  });
});
