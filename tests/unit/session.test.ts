import { describe, expect, it } from "vitest";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createSessionToken,
  extractSessionToken,
  verifySessionToken,
} from "../../src/lib/session.js";

const SECRET = "test-session-secret-that-is-long-enough-0123456789";

describe("stateless session tokens", () => {
  it("round-trips userId with issue/expiry claims", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { token, claims } = createSessionToken({
      userId: "user-1",
      sessionSecret: SECRET,
      now,
      ttlSeconds: 3600,
    });
    const verified = verifySessionToken({ token, sessionSecret: SECRET, now });
    expect(verified.userId).toBe("user-1");
    expect(verified.expiresAt.getTime() - verified.issuedAt.getTime()).toBe(3600_000);
    expect(claims.userId).toBe("user-1");
  });

  it("rejects tampered tokens (constant-time compare)", () => {
    const { token } = createSessionToken({ userId: "user-1", sessionSecret: SECRET });
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(() => verifySessionToken({ token: tampered, sessionSecret: SECRET })).toThrow(
      /Invalid session/,
    );
  });

  it("rejects expired sessions and wrong secrets", () => {
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const { token } = createSessionToken({
      userId: "user-1",
      sessionSecret: SECRET,
      now: issuedAt,
      ttlSeconds: 60,
    });
    expect(() =>
      verifySessionToken({
        token,
        sessionSecret: SECRET,
        now: new Date(issuedAt.getTime() + 61_000),
      }),
    ).toThrow(/expired/i);
    expect(() =>
      verifySessionToken({
        token,
        sessionSecret: "a-different-secret-that-is-also-long-enough-00",
        now: issuedAt,
      }),
    ).toThrow(/Invalid session/);
  });

  it("fails closed on short secrets", () => {
    expect(() => createSessionToken({ userId: "u", sessionSecret: "short" })).toThrow(
      /fail-closed/i,
    );
    expect(() => verifySessionToken({ token: "s1.u.1.2.n.sig", sessionSecret: "short" })).toThrow(
      /fail-closed/i,
    );
  });

  it("extracts Bearer tokens and session cookies", () => {
    expect(extractSessionToken({ authorization: "Bearer abc.def", cookie: undefined })).toBe(
      "abc.def",
    );
    expect(
      extractSessionToken({ authorization: undefined, cookie: "a=1; session=tok123; b=2" }),
    ).toBe("tok123");
    expect(extractSessionToken({ authorization: undefined, cookie: undefined })).toBeUndefined();
  });

  it("builds HttpOnly session cookies (Secure only in production)", () => {
    const dev = buildSessionCookie("tok", false);
    expect(dev).toContain("HttpOnly");
    expect(dev).toContain("SameSite=Lax");
    expect(dev).not.toContain("Secure");
    expect(buildSessionCookie("tok", true)).toContain("Secure");
    expect(buildClearedSessionCookie()).toContain("Max-Age=0");
  });
});
