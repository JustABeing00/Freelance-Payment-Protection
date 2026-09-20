import { getEnv } from "./config/env.js";
import { buildApp } from "./config/app.js";

/**
 * Boot (fail-closed): missing/invalid env throws before listen().
 * Never log secrets; the env loader reports only field names.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const app = await buildApp({ env });
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  console.error("Fatal boot error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
