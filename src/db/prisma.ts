import { PrismaClient } from "@prisma/client";

/**
 * Prisma singleton: one client per process. Connection opens lazily on first
 * query so unit tests and `--help`-style boots don't require a live DB.
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  globalForPrisma.__prisma ??= new PrismaClient({
    // Errors are surfaced via checkDatabase()'s {ok:false}; keep client quiet
    // outside development so health checks don't spam logs when DB is down.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : [],
  });
  return globalForPrisma.__prisma;
}

export async function checkDatabase(): Promise<{ ok: boolean; latencyMs?: number }> {
  const prisma = getPrisma();
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false };
  }
}
