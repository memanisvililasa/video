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
    for (const unit of [web, worker, migration]) {
      expect(unit).toContain("StandardOutput=journal");
      expect(unit).toContain("StandardError=journal");
      expect(unit).not.toMatch(/LogsDirectory=|Standard(?:Output|Error)=(?:append|file):/);
      expect(unit).not.toMatch(/OnCalendar=|Persistent=true|\.timer\b/i);
    }
    expect(worker).toContain("KillSignal=SIGTERM");
    expect(worker).toContain("KillMode=mixed");
    expect(worker).toContain("TimeoutStopSec=330s");
    expect(web).toContain("StartLimitIntervalSec=60s");
    expect(web).toContain("StartLimitBurst=5");
    expect(worker).toContain("StartLimitIntervalSec=120s");
    expect(worker).toContain("StartLimitBurst=5");
    expect(migration).toContain("Type=oneshot");
    expect(migration).toContain("Restart=no");
  });

  it("keeps observability environment role-aware and loopback-only", async () => {
    const [web, worker, migration] = await Promise.all([
      file("deployment/env/web.env.example"),
      file("deployment/env/worker.env.example"),
      file("deployment/env/migration.env.example")
    ]);
    expect(web).toContain("HOSTNAME=127.0.0.1");
    expect(web).toContain("OBSERVABILITY_LOG_LEVEL=info");
    expect(worker).toContain("WORKER_OBSERVABILITY_HOST=127.0.0.1");
    expect(worker).toMatch(/WORKER_OBSERVABILITY_PORT=\d+/);
    expect(migration).toContain("APP_PROCESS_ROLE=migration");
    expect(migration).not.toMatch(/WORKER_OBSERVABILITY_|OBSERVABILITY_READINESS_TIMEOUT_MS|OBSERVABILITY_METRICS_MAX_BYTES|MEDIA_STORAGE_/);
    for (const environment of [web, worker, migration]) expect(environment).not.toContain("TEST_DATABASE_URL");
  });

  it("overwrites client identity at every proxy location", async () => {
    const nginx = await file("deployment/nginx/videosave.conf");
    expect(nginx.match(/proxy_set_header X-VideoSave-Client-IP \$remote_addr;/g)).toHaveLength(2);
    expect(nginx.match(/proxy_set_header X-Forwarded-For "";/g)).toHaveLength(2);
    expect(nginx.match(/proxy_set_header Host __PUBLIC_HOSTNAME__;/g)).toHaveLength(2);
    expect(nginx).toContain('location ~ "^/api/file/[A-Za-z0-9_-]{8,128}$" {');
    expect(nginx).not.toContain("location ~ ^/api/file/[A-Za-z0-9_-]{8,128}$ {");
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
    expect(nginx).not.toMatch(/\b(?:alias|root)\s+\/var\/lib\/videosave\/media/);
    expect(nginx).not.toContain("limit_except");
    const internal = nginx.match(/location \^~ \/internal\/observability\/ \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const exactInternal = nginx.match(/location = \/internal\/observability \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(exactInternal).toContain("return 404;");
    expect(exactInternal).not.toContain("proxy_pass");
    expect(internal).toContain("return 404;");
    expect(internal).not.toContain("proxy_pass");
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
    expect(workflow).toContain("npm run stage:release:artifact");
    expect(workflow).toContain("name: videosave-phase-a-release-${{ github.sha }}");
    expect(workflow).toContain("path: ci-release-artifact/");
    expect(workflow).not.toContain(".release-dist/*.tar.gz");
    expect(workflow).not.toContain("include-hidden-files: true");
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
    expect(workflow.indexOf("npm run stage:release:artifact"))
      .toBeLessThan(workflow.indexOf("actions/upload-artifact@"));
  });

  it("runs the observability browser bundle audit once after the Linux production build", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    const releaseLinux = workflow.slice(workflow.indexOf("  release_linux:"), workflow.indexOf("  deployment_linux:"));
    const auditCommand = "npm run audit:observability:bundle";
    const auditStep = releaseLinux.match(
      /^      - name: Mandatory observability browser bundle audit\n[\s\S]*?(?=^      - |^  \w)/m
    )?.[0].trim();

    expect(workflow.match(/^[ \t]+run: npm run audit:observability:bundle$/gm)).toHaveLength(1);
    expect(releaseLinux).toContain("runs-on: ubuntu-24.04");
    expect(auditStep).toBe([
      "- name: Mandatory observability browser bundle audit",
      "        run: npm run audit:observability:bundle"
    ].join("\n"));
    expect(releaseLinux.indexOf("npm run build\n")).toBeLessThan(releaseLinux.indexOf(auditCommand));
    expect(releaseLinux.indexOf(auditCommand)).toBeLessThan(releaseLinux.indexOf("- name: Immutable Linux release gate"));
    expect(workflow).toContain("needs: [regression, worker_smoke, release_linux, deployment_linux, supply_chain]");
    expect(workflow).toContain('test "$RELEASE_LINUX_RESULT" = "success"');
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("${{ secrets.");
    expect(workflow).not.toMatch(/^\s*(?:deploy|production):\s*$/m);
  });

  it("keeps smoke, installed release, systemd and Nginx gates mandatory on Linux", async () => {
    const workflow = await file(".github/workflows/validate.yml");
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(6);
    expect(workflow).toContain("npm run test:postgres");
    expect(workflow).toContain("name: Mandatory compatible-transcode worker smoke");
    expect(workflow).toContain("npm run test:worker:smoke");
    expect(workflow).toContain("npm run test:release:linux");
    expect(workflow).toContain("npm run verify:deployment:linux");
    expect(workflow).toContain("npm run verify:observability");
    const releaseLinux = workflow.slice(workflow.indexOf("  release_linux:"), workflow.indexOf("  deployment_linux:"));
    const installed = releaseLinux.match(
      /^      - name: Mandatory installed-release observability gate\n[\s\S]*?(?=^      - |^  \w)/m
    )?.[0].trim();
    expect(installed).toBe([
      "- name: Mandatory installed-release observability gate",
      "        run: npm run test:release:linux"
    ].join("\n"));
    expect(workflow.match(/^[ \t]+run: npm run test:release:linux$/gm)).toHaveLength(1);
    expect(releaseLinux.indexOf("npm run test:release\n")).toBeLessThan(releaseLinux.indexOf("npm run test:release:linux"));
    expect(releaseLinux.indexOf("npm run test:release:linux")).toBeLessThan(releaseLinux.indexOf("npm run stage:release:artifact"));
    const deploymentLinux = workflow.slice(workflow.indexOf("  deployment_linux:"), workflow.indexOf("  supply_chain:"));
    expect(deploymentLinux).toContain("- name: Linux systemd, Nginx, and observability isolation gate");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
  });
});
