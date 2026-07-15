import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Deployment verifier is intentionally plain Node.js ESM.
import { verifyDeploymentTemplates } from "../../scripts/verify-deployment-templates.mjs";

const root = process.cwd();

async function file(relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

describe("Phase A deployment templates", () => {
  it("passes the aggregate fail-closed contract verifier", async () => {
    await expect(verifyDeploymentTemplates()).resolves.toEqual({
      units: 3,
      nginx: 1,
      postgresTemplates: 4,
      workflow: 1
    });
  });

  it("keeps service identities and writable boundaries separated", async () => {
    const [web, worker, migration] = await Promise.all([
      file("deployment/systemd/videosave-web.service"),
      file("deployment/systemd/videosave-worker.service"),
      file("deployment/systemd/videosave-migrate.service")
    ]);
    expect(web).toContain("User=videosave-web");
    expect(worker).toContain("User=videosave-worker");
    expect(migration).toContain("User=videosave-migrate");
    expect(web).toContain("SupplementaryGroups=videosave-media");
    expect(worker).toContain("SupplementaryGroups=videosave-media");
    expect(web).not.toContain("ReadWritePaths=/var/lib/videosave/media");
    expect(worker).toContain("ReadWritePaths=/var/lib/videosave/media");
    expect(migration).not.toContain("ReadWritePaths=/var/lib/videosave/media");
    expect(web).not.toContain("postgres-migrations.mjs apply");
    expect(worker).not.toContain("postgres-migrations.mjs apply");
  });

  it("overwrites client identity at every proxy location", async () => {
    const nginx = await file("deployment/nginx/videosave.conf");
    expect(nginx.match(/proxy_set_header X-VideoSave-Client-IP \$remote_addr;/g)).toHaveLength(2);
    expect(nginx.match(/proxy_set_header X-Forwarded-For "";/g)).toHaveLength(2);
    expect(nginx.match(/proxy_set_header Host __PUBLIC_HOSTNAME__;/g)).toHaveLength(2);
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
    expect(nginx).not.toMatch(/\b(?:alias|root)\s+\/var\/lib\/videosave\/media/);
    expect(nginx).not.toContain("limit_except");
  });

  it("keeps PostgreSQL runtime roles non-owning and audit SQL read-only", async () => {
    const [roles, grants, audit] = await Promise.all([
      file("deployment/postgres/roles.sql.example"),
      file("deployment/postgres/runtime-grants.sql.example"),
      file("deployment/postgres/privilege-audit.sql")
    ]);
    expect(roles).toContain("CREATE ROLE :\"migration_role\"");
    expect(grants).toContain("ALTER SCHEMA public OWNER TO :\"migration_role\"");
    expect(grants).not.toMatch(/OWNER TO :\"(?:web|worker)_role\"/);
    expect(grants).not.toMatch(/GRANT\s+ALL\s+ON\s+DATABASE/i);
    expect(`${roles}\n${grants}`).not.toMatch(/\bPASSWORD\b\s+['"]/i);
    expect(grants).toContain("pg_advisory_lock(bigint) TO :\"migration_role\"");
    const normalized = audit.replace(/^--.*$/gm, "").replace(/^\\.*$/gm, "");
    expect(normalized).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
  });

  it("contains validation CI only, without production mutation commands", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("npm run test:deployment:unit");
    expect(workflow).toContain("npm run verify:deployment:linux");
    expect(workflow).not.toMatch(/uses:\s+[^@\s]+@v\d+/);
    expect(workflow).not.toMatch(/\bsystemctl\b|\bufw\b|\biptables\b|certbot/i);
    expect(workflow).not.toMatch(/^\s*DATABASE_URL\s*:/m);
    expect(workflow).not.toMatch(/^\s*deploy:\s*$/m);
  });

  it("runs mandatory Linux evidence independently and fails closed in acceptance", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    const mandatory = ["regression", "worker_smoke", "release_linux", "deployment_linux", "supply_chain"];
    for (const job of mandatory) expect(workflow).toMatch(new RegExp(`^  ${job}:$`, "m"));
    const beforeAcceptance = workflow.split(/^  acceptance:/m)[0];
    expect(beforeAcceptance).not.toMatch(/^    (?:needs|if):/m);
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow).toContain("needs: [regression, worker_smoke, release_linux, deployment_linux, supply_chain]");
    for (const result of ["REGRESSION", "WORKER_SMOKE", "RELEASE_LINUX", "DEPLOYMENT_LINUX", "SUPPLY_CHAIN"]) {
      expect(workflow).toContain(`test \"$${result}_RESULT\" = \"success\"`);
    }
    expect(workflow).not.toContain("continue-on-error:");
  });

  it("keeps smoke, installed release, systemd and Nginx gates mandatory on Linux", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(6);
    expect(workflow).toContain("npm run test:postgres");
    expect(workflow).toContain("npm run test:worker:smoke");
    expect(workflow).toContain("npm run test:release:linux");
    expect(workflow).toContain("npm run verify:deployment:linux");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  });
});
