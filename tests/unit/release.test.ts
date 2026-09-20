import { describe, expect, it } from "vitest";
import { canRelease, isApprovalValidForVersion } from "../../src/domain/release.js";

const base = {
  milestoneId: "m1",
  milestoneAmountCents: 50000,
  projectMilestones: [
    { id: "m1", amountCents: 50000 },
    { id: "m2", amountCents: 50000 },
  ],
};

describe("release gates (no surprise locks, version-pinned approval)", () => {
  it("INVARIANT: old-version approval never releases a new version", () => {
    expect(isApprovalValidForVersion("v-old", "v-new")).toBe(false);
    expect(isApprovalValidForVersion(null, "v-new")).toBe(false);
    expect(isApprovalValidForVersion("v-new", "v-new")).toBe(true);

    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [{ milestoneId: "m1", amountCents: 50000, state: "received" }],
      approvedVersionId: "v-old",
      currentVersionId: "v-new",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/superseded/i);
  });

  it("current_milestone_paid: verified full payment + current approval releases", () => {
    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [{ milestoneId: "m1", amountCents: 50000, state: "received" }],
      approvedVersionId: "v3",
      currentVersionId: "v3",
    });
    expect(d).toMatchObject({ allowed: true, overridden: false });
  });

  it("client claim (pending row) does not satisfy the gate", () => {
    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [{ milestoneId: "m1", amountCents: 50000, state: "pending" }],
      approvedVersionId: "v1",
      currentVersionId: "v1",
    });
    expect(d.allowed).toBe(false);
  });

  it("partial payment blocks release and shows remaining", () => {
    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [{ milestoneId: "m1", amountCents: 10000, state: "partial" }],
      approvedVersionId: "v1",
      currentVersionId: "v1",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/not fully paid/i);
  });

  it("all_milestones_paid requires the whole project paid", () => {
    const d = canRelease({
      ...base,
      condition: "all_milestones_paid",
      payments: [{ milestoneId: "m1", amountCents: 50000, state: "received" }],
      approvedVersionId: "v1",
      currentVersionId: "v1",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/whole project paid/i);
  });

  it("manual override with reason is allowed but flagged in evidence", () => {
    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [],
      approvedVersionId: "v1",
      currentVersionId: "v1",
      manualOverride: { reason: "Client CEO called; releasing against PO-123" },
    });
    expect(d).toMatchObject({ allowed: true, overridden: true });
  });

  it("one-word override reasons are rejected", () => {
    const d = canRelease({
      ...base,
      condition: "current_milestone_paid",
      payments: [],
      approvedVersionId: "v1",
      currentVersionId: "v1",
      manualOverride: { reason: "ok" },
    });
    expect(d.allowed).toBe(false);
  });
});
