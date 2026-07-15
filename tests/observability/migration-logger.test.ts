import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The migration logger is a plain Node.js release script.
import { createMigrationOperationalLogger } from "../../scripts/operational-log.mjs";

describe("migration process logger", () => {
  it("uses the same bounded base JSON contract without connection data", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const logger = await createMigrationOperationalLogger({ NODE_ENV: "test", OBSERVABILITY_LOG_LEVEL: "info" });
      logger.info("migration.status", {
        outcome: "success",
        reasonCode: "none",
        metadata: { command: "status", total: 4, connectionString: ["postgresql://user", "secret@db/app"].join(":") }
      });
    } finally {
      write.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      schemaVersion: "1.0",
      event: "migration.status",
      processRole: "migration",
      outcome: "success",
      reasonCode: "none"
    });
    expect(lines[0]).not.toContain("postgresql://");
    expect(lines[0]).not.toContain("secret");
  });
});
