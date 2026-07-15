import { parseApplicationProcessRole, parseJobRepositoryConfig } from "@/lib/config/env";
import { assertPostgresCutoverReady } from "@/lib/jobs/postgres/cutover-readiness";
import { createPostgresPool } from "@/lib/jobs/postgres/pool";

async function main(): Promise<void> {
  const useTestDatabase = process.argv[2] === "--test";
  if (process.argv.length !== (useTestDatabase ? 3 : 2)) {
    throw new TypeError("Cutover readiness arguments are invalid.");
  }
  const production = process.env.NODE_ENV?.trim() === "production";
  if (production && useTestDatabase) {
    throw new TypeError("Production cutover readiness must not use TEST_DATABASE_URL.");
  }
  if (production && parseApplicationProcessRole(process.env) !== "migration") {
    throw new TypeError("Production cutover readiness requires APP_PROCESS_ROLE=migration.");
  }
  const databaseUrl = useTestDatabase
    ? process.env.TEST_DATABASE_URL?.trim()
    : process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new TypeError("Cutover readiness database configuration is missing.");
  const repository = parseJobRepositoryConfig({
    ...process.env,
    NODE_ENV: production ? "production" : "test",
    JOB_REPOSITORY_BACKEND: "postgres",
    DATABASE_URL: databaseUrl
  });
  if (repository.backend !== "postgres") throw new TypeError("Cutover readiness configuration is invalid.");
  const postgres = createPostgresPool(repository.postgres, {
    applicationName: "videosave-cutover-check"
  });
  try {
    await postgres.readiness();
    await assertPostgresCutoverReady(postgres.pool);
    console.info("PostgreSQL cutover readiness passed.");
  } finally {
    await postgres.close().catch(() => undefined);
  }
}

main().catch(() => {
  console.error("PostgreSQL cutover readiness failed.");
  process.exitCode = 1;
});
