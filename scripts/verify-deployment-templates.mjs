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
  const [web, worker, migration, nginx, roles, audit, webEnv, workerEnv, workflow, ignore] = await Promise.all([
    text("deployment/systemd/videosave-web.service"),
    text("deployment/systemd/videosave-worker.service"),
    text("deployment/systemd/videosave-migrate.service"),
    text("deployment/nginx/videosave.conf"),
    text("deployment/postgres/roles.sql.example"),
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
    "listen 443 ssl;",
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
    "CREATE ROLE videosave_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    "CREATE ROLE videosave_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    "CREATE ROLE videosave_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    "ALTER SCHEMA public OWNER TO videosave_migration",
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.media_jobs TO videosave_web",
    "GRANT SELECT ON TABLE public.media_artifacts TO videosave_web",
    "GRANT SELECT, UPDATE, DELETE ON TABLE public.media_jobs TO videosave_worker",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.media_artifacts TO videosave_worker",
    "GRANT SELECT, UPDATE ON TABLE public.media_lifecycle_state TO videosave_worker",
    "pg_advisory_lock(bigint) TO videosave_migration",
    "pg_try_advisory_lock(integer, integer)",
    "SET search_path = public, pg_catalog"
  ], "PostgreSQL role template");
  assert(!/\bPASSWORD\b\s+['\"]/i.test(roles), "PostgreSQL template contains a password.");
  assert(!/postgres(?:ql)?:\/\//i.test(roles), "PostgreSQL template contains a connection string.");
  assert(!/GRANT\s+ALL\s+ON\s+DATABASE/i.test(roles), "PostgreSQL template grants excessive database privileges.");
  assert(!/ALTER (?:SCHEMA|TABLE).*OWNER TO videosave_(?:web|worker)/i.test(roles), "Runtime role owns schema objects.");
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

  containsAll(workflow, [
    "permissions:\n  contents: read",
    "node-version: 24.18.0",
    "npm@11.6.0",
    "postgres:17",
    "ffmpeg",
    "npm run test:deployment",
    "npm run test:postgres",
    "npm run test:worker:smoke",
    "npm run build:release",
    "npm run verify:release",
    "actions/upload-artifact@v4"
  ], "CI workflow");
  assert(!/^\s*(?:deploy|production):\s*$/m.test(workflow), "CI must not contain a production deploy job.");
  assert(!/\bsystemctl\b|\bufw\b|\biptables\b|certbot/i.test(workflow), "CI must not mutate host deployment state.");
  assert(!/^\s*DATABASE_URL\s*:/m.test(workflow), "CI must not define production DATABASE_URL.");
  assert(ignore.includes(".release-dist") && ignore.includes(".production-smoke-dist"), "Generated outputs must be ignored.");

  const scanned = [web, worker, migration, nginx, roles, audit, webEnv, workerEnv, workflow].join("\n");
  assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(scanned), "Deployment templates contain key material.");
  assert(!/\/Users\/[A-Za-z0-9._-]+\//.test(scanned), "Deployment templates contain a local user path.");
  return Object.freeze({ units: 3, nginx: 1, postgresTemplates: 2, workflow: 1 });
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
