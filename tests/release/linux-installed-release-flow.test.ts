import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Linux release validation tooling is intentionally plain Node.js ESM.
import { runChecked, validateInstalledReleaseReadiness } from "../../scripts/test-linux-installed-release.mjs";

describe("Linux installed release readiness flow", () => {
  it("applies migrations as the migration role before status and runtime readiness", async () => {
    const calls: Array<{
      entrypoint: string;
      args: string[];
      role: string | undefined;
      databaseUrl: string | undefined;
    }> = [];
    const execute = vi.fn(async (_node: string, command: string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({
        entrypoint: command[0],
        args: command.slice(1),
        role: options.env.APP_PROCESS_ROLE,
        databaseUrl: options.env.DATABASE_URL
      });
      return { stdout: "", stderr: "" };
    });
    const common = {
      NODE_ENV: "test",
      DATABASE_URL: "disposable-release-database-value"
    };

    await validateInstalledReleaseReadiness({
      installedRoot: "/installed/release",
      common,
      workerEnvironment: { ...common, APP_PROCESS_ROLE: "worker" },
      execute
    });

    expect(calls).toEqual([
      { entrypoint: "scripts/postgres-migrations.mjs", args: ["apply"], role: "migration", databaseUrl: common.DATABASE_URL },
      { entrypoint: "scripts/postgres-migrations.mjs", args: ["status"], role: "migration", databaseUrl: common.DATABASE_URL },
      { entrypoint: "checks/web-readiness.mjs", args: [], role: "web", databaseUrl: common.DATABASE_URL },
      { entrypoint: "worker/main.mjs", args: ["--check"], role: "worker", databaseUrl: common.DATABASE_URL }
    ]);
  });

  it("reports only a fixed command label when an installed command fails", async () => {
    const secret = "sensitive-runtime-value";
    const execute = vi.fn(async () => {
      throw new Error(`failed ${secret} /private/runtime/hidden`);
    });

    await expect(runChecked("web-readiness", "checks/web-readiness.mjs", [], {
      cwd: "/installed/release",
      env: { DATABASE_URL: secret },
      execute
    })).rejects.toThrow("Installed release command failed: web-readiness.");

    try {
      await runChecked("web-readiness", "checks/web-readiness.mjs", [], {
        cwd: "/installed/release",
        env: { DATABASE_URL: secret },
        execute
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("/private/runtime/hidden");
    }
  });
});
