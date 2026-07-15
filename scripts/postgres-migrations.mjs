import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { POSTGRES_MIGRATION_CATALOG } from "./postgres-migration-catalog.mjs";

const { Client } = pg;
const MIGRATION_LOCK_KEY = 5_903_000_001;
const MIGRATIONS_DIRECTORY = new URL("../db/migrations/", import.meta.url);
const SAFE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

function safeSchema(schema) {
  if (!SAFE_SCHEMA.test(schema)) throw new TypeError("PostgreSQL schema name is invalid.");
  return schema;
}

function tlsConfiguration(sslMode, nodeEnv) {
  const production = nodeEnv === "production";
  const normalized = sslMode || (production ? "require" : "disable");
  if (normalized !== "disable" && normalized !== "require") {
    throw new TypeError("POSTGRES_SSL_MODE must be exactly 'disable' or 'require'.");
  }
  if (production && normalized !== "require") {
    throw new TypeError("Production PostgreSQL migrations require verified TLS.");
  }
  return normalized === "require" ? { rejectUnauthorized: true } : false;
}

function databaseUrlFromEnvironment(useTestDatabase) {
  const name = useTestDatabase ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required for PostgreSQL migrations.`);
  return value;
}

async function loadMigrations() {
  return Promise.all(
    POSTGRES_MIGRATION_CATALOG.map(async (migration) => {
      const url = new URL(migration.file, MIGRATIONS_DIRECTORY);
      if (fileURLToPath(url).split("/").at(-1) !== migration.file) {
        throw new TypeError("Configured migration filename is invalid.");
      }
      const sql = await readFile(url, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (checksum !== migration.checksum) {
        throw new Error(`Migration ${migration.version} checksum does not match the release catalog.`);
      }
      return Object.freeze({
        ...migration,
        sql,
        checksum
      });
    })
  );
}

function migrationClientOptions(options) {
  return {
    connectionString: options.connectionString,
    ssl: tlsConfiguration(options.sslMode, options.nodeEnv),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    application_name: "videosave-migrations"
  };
}

async function ensureHistoryTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _videosave_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedMigrations(client) {
  const result = await client.query(
    "SELECT version, checksum, applied_at FROM _videosave_migrations ORDER BY version"
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function historyTableExists(client, schema) {
  const result = await client.query(
    "SELECT to_regclass(format('%I.%I', $1::text, '_videosave_migrations'))::text AS history",
    [schema]
  );
  return result.rows[0]?.history !== null;
}

function verifyChecksums(migrations, applied) {
  for (const migration of migrations) {
    const history = applied.get(migration.version);
    if (history && history.checksum !== migration.checksum) {
      throw new Error(`Migration ${migration.version} checksum does not match its applied history.`);
    }
  }
  for (const version of applied.keys()) {
    if (!migrations.some((migration) => migration.version === version)) {
      throw new Error(`Applied migration ${version} is not present in the migration catalog.`);
    }
  }
}

async function withMigrationLock(options, operation) {
  const schema = safeSchema(options.schema ?? "public");
  const client = new Client(migrationClientOptions(options));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query("SELECT set_config('search_path', $1, false)", [schema]);
    return await operation(client);
  } finally {
    if (connected) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      } catch {
        // The connection close below releases a session advisory lock as well.
      }
    }
    await client.end().catch(() => undefined);
  }
}

async function withReadOnlyStatusClient(options, operation) {
  const schema = safeSchema(options.schema ?? "public");
  const client = new Client(migrationClientOptions(options));
  let connected = false;
  let transaction = false;
  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN READ ONLY");
    transaction = true;
    await client.query("SELECT set_config('search_path', $1, true)", [schema]);
    return await operation(client, schema);
  } finally {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    if (connected) await client.end().catch(() => undefined);
  }
}

export async function applyMigrations(options) {
  const migrations = await loadMigrations();
  return withMigrationLock(options, async (client) => {
    await ensureHistoryTable(client);
    const applied = await appliedMigrations(client);
    verifyChecksums(migrations, applied);
    const newlyApplied = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO _videosave_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum]
        );
        await client.query("COMMIT");
        newlyApplied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return Object.freeze({
      total: migrations.length,
      applied: Object.freeze(newlyApplied)
    });
  });
}

export async function migrationStatus(options) {
  const migrations = await loadMigrations();
  return withReadOnlyStatusClient(options, async (client, schema) => {
    const applied = await historyTableExists(client, schema)
      ? await appliedMigrations(client)
      : new Map();
    verifyChecksums(migrations, applied);
    return Object.freeze(
      migrations.map((migration) =>
        Object.freeze({
          version: migration.version,
          status: applied.has(migration.version) ? "applied" : "pending"
        })
      )
    );
  });
}

async function main() {
  const command = process.argv[2];
  const useTestDatabase = process.argv[3] === "--test";
  const production = process.env.NODE_ENV?.trim() === "production";
  const role = process.env.APP_PROCESS_ROLE?.trim();
  if (production && role !== "migration") {
    throw new TypeError("APP_PROCESS_ROLE must be exactly 'migration' for production migrations.");
  }
  if (role && role !== "migration" && !(role === "local" && !production)) {
    throw new TypeError("Only APP_PROCESS_ROLE=migration may run the migration command.");
  }
  if (production && useTestDatabase) {
    throw new TypeError("Production migrations must not use TEST_DATABASE_URL.");
  }
  if (!useTestDatabase && process.argv[3] !== undefined) {
    throw new TypeError("The only supported migration option is --test.");
  }
  if (process.argv.length > (useTestDatabase ? 4 : 3)) {
    throw new TypeError("Unexpected migration arguments.");
  }
  if (command !== "apply" && command !== "status") {
    throw new TypeError("Migration command must be exactly 'apply' or 'status'.");
  }

  const options = {
    connectionString: databaseUrlFromEnvironment(useTestDatabase),
    sslMode: process.env.POSTGRES_SSL_MODE,
    nodeEnv: process.env.NODE_ENV,
    schema: "public"
  };
  if (command === "apply") {
    const result = await applyMigrations(options);
    console.log(
      result.applied.length === 0
        ? `Migrations are current (${result.total} applied).`
        : `Applied migrations: ${result.applied.join(", ")}.`
    );
    return;
  }

  const status = await migrationStatus(options);
  for (const migration of status) console.log(`${migration.version}: ${migration.status}`);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    const message =
      error instanceof TypeError || error?.message?.startsWith("Migration ")
        ? error.message
        : "Database operation failed without exposing connection details.";
    console.error(`PostgreSQL migration failed: ${message}`);
    process.exitCode = 1;
  });
}
