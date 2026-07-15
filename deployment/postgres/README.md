# PostgreSQL Phase A role boundary

The templates are operator-reviewed examples and never run from application startup. They contain no password or connection URL. Use strict psql identifier variables and provide credentials through the external secret channel.

Apply them in this order:

1. As a cluster administrator, run `roles.sql.example` with the supported Phase A names `migration_role=videosave_migration`, `web_role=videosave_web`, and `worker_role=videosave_worker`. Parameterization exists for disposable acceptance tests; production cutover check expects these names.
2. Assign LOGIN passwords outside the repository.
3. From an administrative database, run `database.sql.example` with the reviewed application database name and migration owner.
4. Connect as the migration owner and apply migrations 001-004 with the separate migration command.
5. As an administrator connected to the application database, run `runtime-grants.sql.example`.
6. Run `privilege-audit.sql` read-only and packaged `checks/cutover-readiness.mjs` under `APP_PROCESS_ROLE=migration`. Both are read-only; only the separate migration `apply` command acquires the migration lock or changes schema.

The migration role owns the database schema and migration objects. Web can create/read/cancel jobs and read artifact metadata. Worker can claim/update/recover jobs and manage artifact metadata/lifecycle state. Runtime roles are `NOINHERIT`, are not members of the migration owner, never own schema objects, lack schema `CREATE`, and have no superuser, `CREATEDB`, `CREATEROLE`, or replication privilege. Default privileges revoke PUBLIC access, provide only baseline runtime reads/sequence usage, and do not grant broad future writes; each future migration must explicitly extend the write allowlist.

PostgreSQL must use verified TLS and a local/private or managed-private boundary. A provider-specific database owner is acceptable only when documented and the real-role acceptance/audit still proves the runtime restrictions.
