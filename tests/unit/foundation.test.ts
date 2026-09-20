import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

describe("environment fail-closed", () => {
  it("throws when required vars are missing", () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/fail-closed/i);
  });

  it("throws on short SESSION_SECRET", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: "postgres://localhost:5432/x",
        SESSION_SECRET: "short",
        APP_BASE_URL: "http://localhost:3000",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SESSION_SECRET/);
  });

  it("accepts a complete minimal config with safe defaults", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://localhost:5432/x",
      SESSION_SECRET: "a".repeat(32),
      APP_BASE_URL: "http://localhost:3000",
    } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(3000);
    expect(env.MAGIC_LINK_TTL_HOURS).toBe(168);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it(".env.example ships placeholders only (no secrets)", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    for (const key of ["DATABASE_URL", "SESSION_SECRET", "APP_BASE_URL"]) {
      expect(example).toContain(key);
    }
    // No real-looking secrets: placeholders use changeme/example/test values.
    expect(example).not.toMatch(/sk-live/i);
  });
});

describe("append-only migration guards", () => {
  it("migration protects all evidence/financial tables against UPDATE/DELETE", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma", "migrations", "0001_foundation", "migration.sql"),
      "utf8",
    );
    for (const table of ["events", "payments", "approvals", "agreements", "evidence_packs"]) {
      expect(sql).toContain(`ON "${table}"`);
    }
    expect(sql).toContain("prevent_history_mutation");
    expect(sql).toContain("idempotencyKey");
  });
});

describe("migration/schema naming contract", () => {
  it("no migration references snake_case columns (schema.prisma is camelCase, quoted identifiers are case-sensitive)", () => {
    // Table names stay snake_case via @@map — only column identifiers must be
    // camelCase. A single "workspace_id" in an index/constraint/trigger breaks
    // `migrate deploy` with 42703 (see 0007 P3018 incident).
    const dir = join(process.cwd(), "prisma", "migrations");
    const snakeColumns = [
      '"workspace_id"',
      '"project_id"',
      '"milestone_id"',
      '"created_at"',
      '"updated_at"',
    ];
    for (const name of readdirSync(dir)) {
      const sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
      for (const bad of snakeColumns) {
        expect(sql, `${name} must not reference ${bad}`).not.toContain(bad);
      }
    }
  });
});
