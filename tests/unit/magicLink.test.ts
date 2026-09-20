import { describe, expect, it } from "vitest";
import { hashToken, issueMagicLink, verifyMagicLink } from "../../src/lib/magicLink.js";

const SECRET = "test-session-secret-that-is-long-enough-0123456789";

describe("magic links (single-project scope, expiring, hashed)", () => {
  it("issues a verifiable link bound to one project", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const { token, tokenHash } = issueMagicLink({
      projectId: "11111111-1111-1111-1111-111111111111",
      sessionSecret: SECRET,
      now,
      ttlHours: 24,
    });
    expect(tokenHash).toBe(hashToken(token));
    const claims = verifyMagicLink({
      token,
      expectedProjectId: "11111111-1111-1111-1111-111111111111",
      sessionSecret: SECRET,
      now: new Date("2026-01-01T12:00:00Z"),
    });
    expect(claims.projectId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects cross-project use (forwarded-link scope)", () => {
    const { token } = issueMagicLink({ projectId: "proj-a", sessionSecret: SECRET });
    expect(() =>
      verifyMagicLink({ token, expectedProjectId: "proj-b", sessionSecret: SECRET }),
    ).toThrow(/not scoped/);
  });

  it("rejects expired links", () => {
    const { token } = issueMagicLink({
      projectId: "proj-a",
      sessionSecret: SECRET,
      now: new Date("2026-01-01T00:00:00Z"),
      ttlHours: 1,
    });
    expect(() =>
      verifyMagicLink({
        token,
        expectedProjectId: "proj-a",
        sessionSecret: SECRET,
        now: new Date("2026-01-01T02:00:00Z"),
      }),
    ).toThrow(/expired/);
  });

  it("rejects tampered signatures", () => {
    const { token } = issueMagicLink({ projectId: "proj-a", sessionSecret: SECRET });
    const last = token.slice(-1);
    const tampered = `${token.slice(0, -1)}${last === "0" ? "1" : "0"}`;
    expect(() =>
      verifyMagicLink({ token: tampered, expectedProjectId: "proj-a", sessionSecret: SECRET }),
    ).toThrow();
  });

  it("two links differ (rotation limits blast radius)", () => {
    const a = issueMagicLink({ projectId: "proj-a", sessionSecret: SECRET });
    const b = issueMagicLink({ projectId: "proj-a", sessionSecret: SECRET });
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});
