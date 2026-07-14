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
      postgresTemplates: 2,
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
    const [roles, audit] = await Promise.all([
      file("deployment/postgres/roles.sql.example"),
      file("deployment/postgres/privilege-audit.sql")
    ]);
    expect(roles).toContain("ALTER SCHEMA public OWNER TO videosave_migration");
    expect(roles).not.toMatch(/OWNER TO videosave_(?:web|worker)/);
    expect(roles).not.toMatch(/GRANT\s+ALL\s+ON\s+DATABASE/i);
    expect(roles).not.toMatch(/\bPASSWORD\b\s+['"]/i);
    expect(roles).toContain("pg_advisory_lock(bigint) TO videosave_migration");
    const normalized = audit.replace(/^--.*$/gm, "").replace(/^\\.*$/gm, "");
    expect(normalized).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE)\b/i);
  });

  it("contains validation CI only, without production mutation commands", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("npm run test:deployment");
    expect(workflow).not.toMatch(/\bsystemctl\b|\bufw\b|\biptables\b|certbot/i);
    expect(workflow).not.toMatch(/^\s*DATABASE_URL\s*:/m);
    expect(workflow).not.toMatch(/^\s*deploy:\s*$/m);
  });
});
