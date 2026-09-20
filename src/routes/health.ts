import type { FastifyInstance } from "fastify";
import { checkDatabase } from "../db/prisma.js";

export const APP_VERSION = "0.19.0";
export const DISCLAIMER =
  "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.";

/**
 * Health strategy: /health is unauthenticated and never leaks internals.
 * - status "ok" when HTTP serves; `db` reports "up"|"down" separately so
 *   orchestration can distinguish app-liveness from DB-readiness.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => {
    const db = await checkDatabase().catch(() => ({ ok: false as const }));
    return {
      status: "ok",
      version: APP_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
      db: db.ok ? "up" : "down",
      ...(db.ok && "latencyMs" in db && typeof db.latencyMs === "number"
        ? { dbLatencyMs: db.latencyMs }
        : {}),
    };
  });

  app.get("/api/v1/disclaimer", () => ({
    disclaimer: DISCLAIMER,
    version: "v1",
  }));
}
