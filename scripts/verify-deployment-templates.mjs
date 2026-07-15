import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function text(relative) {
  return readFile(path.join(projectRoot, relative), "utf8");
}

function containsAll(content, values, label) {
  for (const value of values) assert(content.includes(value), `${label} is missing ${value}.`);
}

function unitContract(name, content) {
  containsAll(content, [
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "NoNewPrivileges=true",
    "CapabilityBoundingSet=",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "RestrictRealtime=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "WorkingDirectory=/opt/videosave/current",
    "StandardOutput=journal",
    "StandardError=journal"
  ], name);
  assert(!/^User=root$/m.test(content), `${name} must not run as root.`);
  assert(!/^ReadWritePaths=\/$/m.test(content), `${name} exposes the root filesystem.`);
}

export async function verifyDeploymentTemplates() {
  const [web, worker, migration, nginx, roles, database, grants, audit, webEnv, workerEnv, workflow, ignore] = await Promise.all([
    text("deployment/systemd/videosave-web.service"),
    text("deployment/systemd/videosave-worker.service"),
    text("deployment/systemd/videosave-migrate.service"),
    text("deployment/nginx/videosave.conf"),
    text("deployment/postgres/roles.sql.example"),
    text("deployment/postgres/database.sql.example"),
    text("deployment/postgres/runtime-grants.sql.example"),
    text("deployment/postgres/privilege-audit.sql"),
    text("deployment/env/web.env.example"),
    text("deployment/env/worker.env.example"),
    text(".github/workflows/validate.yml"),
    text(".gitignore")
  ]);

  unitContract("web unit", web);
  unitContract("worker unit", worker);
  unitContract("migration unit", migration);
  containsAll(web, [
    "User=videosave-web",
    "Group=videosave-web",
    "SupplementaryGroups=videosave-media",
    "EnvironmentFile=/etc/videosave/web.env",
    "ExecStartPre=/usr/bin/node /opt/videosave/current/checks/web-readiness.mjs",
    "ExecStart=/usr/bin/node /opt/videosave/current/server.js",
    "Restart=on-failure",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "RequiresMountsFor=/var/lib/videosave/media",
    "ReadOnlyPaths=/opt/videosave /etc/videosave /var/lib/videosave/media",
    "InaccessiblePaths=/var/lib/videosave/media/jobs"
  ], "web unit");
  assert(!/postgres-migrations\.mjs (?:apply|status)/.test(web), "Web must not run migrations.");
  containsAll(worker, [
    "User=videosave-worker",
    "Group=videosave-worker",
    "SupplementaryGroups=videosave-media",
    "EnvironmentFile=/etc/videosave/worker.env",
    "ExecStartPre=/usr/bin/node /opt/videosave/current/worker/main.mjs --check",
    "ExecStart=/usr/bin/node /opt/videosave/current/worker/main.mjs",
    "Restart=on-failure",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "TimeoutStopSec=330s",
    "RequiresMountsFor=/var/lib/videosave/media",
    "ReadWritePaths=/var/lib/videosave/media"
  ], "worker unit");
  assert(!/postgres-migrations\.mjs (?:apply|status)/.test(worker), "Worker must not run migrations.");
  containsAll(migration, [
    "Type=oneshot",
    "User=videosave-migrate",
    "EnvironmentFile=/etc/videosave/migration.env",
    "postgres-migrations.mjs apply",
    "postgres-migrations.mjs status",
    "Restart=no"
  ], "migration unit");
  assert(!migration.includes("Restart=always"), "Migration must never restart continuously.");

  containsAll(nginx, [
    "server 127.0.0.1:3000;",
    "listen 80;",
    "listen 443 ssl http2;",
    "__PUBLIC_HOSTNAME__",
    "__TLS_CERTIFICATE_FILE__",
    "__TLS_CERTIFICATE_KEY_FILE__",
    "proxy_set_header X-VideoSave-Client-IP $remote_addr;",
    "proxy_set_header Host __PUBLIC_HOSTNAME__;",
    "proxy_set_header X-Forwarded-Host __PUBLIC_HOSTNAME__;",
    "proxy_set_header X-Forwarded-For \"\";",
    "proxy_set_header X-Real-IP \"\";",
    "proxy_set_header Forwarded \"\";",
    "client_max_body_size 16k;",
    "client_header_timeout 15s;",
    "proxy_connect_timeout 5s;",
    "proxy_buffering off;",
    "request_id=$request_id",
    "method=$request_method uri=$uri"
  ], "Nginx template");
  assert((nginx.match(/proxy_set_header X-VideoSave-Client-IP \$remote_addr;/g) ?? []).length === 2,
    "Every Nginx proxy location must overwrite the trusted identity header.");
  assert((nginx.match(/proxy_set_header Host __PUBLIC_HOSTNAME__;/g) ?? []).length === 2,
    "Every Nginx proxy location must use the rendered canonical host.");
  assert(!nginx.includes("$proxy_add_x_forwarded_for"), "Forwarded chains must not be trusted.");
  assert(!/\b(?:alias|root)\s+\/var\/lib\/videosave\/media/.test(nginx), "Nginx must not expose media directly.");
  assert(!nginx.includes("limit_except"), "Nginx must not block API methods.");
  assert(!nginx.includes("proxy_set_header Upgrade"), "WebSocket behavior is out of scope.");

  containsAll(roles, [
    "CREATE ROLE :\"migration_role\" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    "CREATE ROLE :\"web_role\" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    "CREATE ROLE :\"worker_role\" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION"
  ], "PostgreSQL role bootstrap");
  containsAll(database, [
    "CREATE DATABASE :\"database_name\" OWNER :\"migration_role\" TEMPLATE template0",
    "REVOKE CONNECT, TEMPORARY ON DATABASE :\"database_name\" FROM PUBLIC"
  ], "PostgreSQL database template");
  containsAll(grants, [
    "ALTER SCHEMA public OWNER TO :\"migration_role\"",
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.media_jobs TO :\"web_role\"",
    "GRANT SELECT ON TABLE public.media_artifacts TO :\"web_role\"",
    "GRANT SELECT, UPDATE, DELETE ON TABLE public.media_jobs TO :\"worker_role\"",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.media_artifacts TO :\"worker_role\"",
    "GRANT SELECT, UPDATE ON TABLE public.media_lifecycle_state TO :\"worker_role\"",
    "pg_advisory_lock(bigint) TO :\"migration_role\"",
    "pg_try_advisory_lock(integer, integer)",
    "SET search_path = public, pg_catalog",
    "ALTER DEFAULT PRIVILEGES FOR ROLE :\"migration_role\""
  ], "PostgreSQL runtime grants");
  const postgresTemplates = [roles, database, grants, audit].join("\n");
  assert(!/\bPASSWORD\b\s+['\"]/i.test(postgresTemplates), "PostgreSQL template contains a password.");
  assert(!/postgres(?:ql)?:\/\//i.test(postgresTemplates), "PostgreSQL template contains a connection string.");
  assert(!/GRANT\s+ALL\s+ON\s+DATABASE/i.test(postgresTemplates), "PostgreSQL template grants excessive database privileges.");
  assert(!/ALTER (?:SCHEMA|TABLE).*OWNER TO :\"(?:web|worker)_role\"/i.test(grants), "Runtime role owns schema objects.");
  const auditStatements = audit
    .split("\n")
    .filter((line) => !line.trim().startsWith("--") && !line.trim().startsWith("\\"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  assert(auditStatements.every((statement) => statement.startsWith("SELECT ")), "Privilege audit must be read-only.");

  for (const [label, environment] of [["web env", webEnv], ["worker env", workerEnv]]) {
    containsAll(environment, ["MEDIA_STORAGE_AUTHORITY_ID=<32-lowercase-hex-authority-id>"], label);
    assert(!environment.includes("TEST_DATABASE_URL"), `${label} must not use test credentials.`);
  }
  containsAll(webEnv, ["HOSTNAME=127.0.0.1", "TRUST_PROXY_MODE=nginx-single-host"], "web env");

  containsAll(workflow, [
    "permissions:\n  contents: read",
    "  regression:",
    "  worker_smoke:",
    "  release_linux:",
    "  deployment_linux:",
    "  supply_chain:",
    "  acceptance:",
    "node-version: 24.18.0",
    "npm@11.6.0",
    "postgres:17",
    "ffmpeg",
    "npm run test:deployment:unit",
    "npm run test:postgres",
    "npm run check:cutover:test",
    "npm run test:worker:smoke",
    "npm run build:release",
    "npm run verify:release",
    "npm run test:release:linux",
    "npm run verify:deployment:linux",
    "npm run audit:repository",
    "test \"$(git rev-parse HEAD)\" = \"$GITHUB_SHA\"",
    "if: ${{ always() }}",
    "needs: [regression, worker_smoke, release_linux, deployment_linux, supply_chain]",
    "test \"$REGRESSION_RESULT\" = \"success\"",
    "test \"$WORKER_SMOKE_RESULT\" = \"success\"",
    "test \"$RELEASE_LINUX_RESULT\" = \"success\"",
    "test \"$DEPLOYMENT_LINUX_RESULT\" = \"success\"",
    "test \"$SUPPLY_CHAIN_RESULT\" = \"success\"",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"
  ], "CI workflow");
  const actionRefs = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
  assert(actionRefs.length > 0 && actionRefs.every((ref) => /^[a-f0-9]{40}$/.test(ref)), "CI actions must use immutable SHAs.");
  assert(!/continue-on-error:\s*true/.test(workflow), "Mandatory CI gates must not continue on error.");
  const beforeAcceptance = workflow.split(/^  acceptance:/m)[0];
  assert(!/^    (?:needs|if):/m.test(beforeAcceptance), "Mandatory Linux jobs must execute independently.");
  assert((workflow.match(/^  (?:regression|worker_smoke|release_linux|deployment_linux|supply_chain):$/gm) ?? []).length === 5,
    "CI must define every independent mandatory job exactly once.");
  assert((workflow.match(/^          test \"\$[A-Z_]+_RESULT\" = \"success\"$/gm) ?? []).length === 5,
    "Final acceptance must fail closed for every mandatory job result.");
  assert(!/^\s*(?:deploy|production):\s*$/m.test(workflow), "CI must not contain a production deploy job.");
  assert(!/\bsystemctl\b|\bufw\b|\biptables\b|certbot/i.test(workflow), "CI must not mutate host deployment state.");
  assert(!/^\s*DATABASE_URL\s*:/m.test(workflow), "CI must not define production DATABASE_URL.");
  assert(!workflow.includes("${{ secrets."), "Validation CI must not interpolate repository secrets.");
  assert(!/run:\s*[^\n]*\$\{\{\s*(?:github\.event|inputs)\b/.test(workflow),
    "Validation CI must not interpolate untrusted event values into shell commands.");
  assert(workflow.includes('test "$(node --version)" = "v24.18.0"') &&
    workflow.includes('test "$(npm --version)" = "11.6.0"'), "CI must enforce the exact toolchain.");
  assert(ignore.includes(".release-dist") && ignore.includes(".production-smoke-dist"), "Generated outputs must be ignored.");

  const scanned = [web, worker, migration, nginx, postgresTemplates, webEnv, workerEnv, workflow].join("\n");
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(scanned), "Deployment templates contain key material.");
  assert(!/\/Users\/[A-Za-z0-9._-]+\//.test(scanned), "Deployment templates contain a local user path.");
  return Object.freeze({ units: 3, nginx: 1, postgresTemplates: 4, workflow: 1 });
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  verifyDeploymentTemplates().then(
    (result) => console.info(`Deployment templates passed: ${JSON.stringify(result)}.`),
    (error) => {
      console.error(error instanceof Error ? error.message : "Deployment template verification failed.");
      process.exitCode = 1;
    }
  );
}
