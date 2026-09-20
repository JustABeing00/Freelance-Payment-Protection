import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors.js";
import { assertSameWorkspace, filterByWorkspace, tenantScope } from "../../src/lib/tenant.js";

describe("tenant isolation (workspace_id on every row, every query scoped)", () => {
  it("denies cross-workspace access with a generic message (no oracle leak)", () => {
    try {
      assertSameWorkspace("ws-a", { workspaceId: "ws-b" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("FORBIDDEN");
      expect((err as AppError).message).toBe("Access denied");
    }
  });

  it("denies missing resources the same way as foreign ones", () => {
    expect(() => assertSameWorkspace("ws-a", null)).toThrowError(AppError);
    expect(() => assertSameWorkspace("ws-a", undefined)).toThrowError(AppError);
  });

  it("allows same-workspace access", () => {
    expect(() => assertSameWorkspace("ws-a", { workspaceId: "ws-a" })).not.toThrow();
  });

  it("scope helper always injects workspaceId; list filter is defense in depth", () => {
    expect(tenantScope("ws-a")).toEqual({ workspaceId: "ws-a" });
    const rows = [{ workspaceId: "ws-a" }, { workspaceId: "ws-b" }];
    expect(filterByWorkspace("ws-a", rows)).toEqual([{ workspaceId: "ws-a" }]);
  });
});
