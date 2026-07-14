\set ON_ERROR_STOP on

-- Read-only audit. Empty result sets indicate missing/extra privilege review;
-- this file never creates, alters, grants, revokes, or drops anything.
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolconnlimit
FROM pg_catalog.pg_roles
WHERE rolname IN ('videosave_migration', 'videosave_web', 'videosave_worker')
ORDER BY rolname;

SELECT n.nspname AS schema_name, owner.rolname AS schema_owner
FROM pg_catalog.pg_namespace AS n
JOIN pg_catalog.pg_roles AS owner ON owner.oid = n.nspowner
WHERE n.nspname = 'public';

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('videosave_web', 'videosave_worker')
ORDER BY grantee, table_name, privilege_type;

SELECT grantee, object_type, privilege_type
FROM information_schema.usage_privileges
WHERE object_schema = 'public'
  AND grantee IN ('videosave_web', 'videosave_worker')
ORDER BY grantee, object_type, privilege_type;

SELECT routine_schema, routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'pg_catalog'
  AND grantee IN ('videosave_migration', 'videosave_worker')
  AND routine_name IN (
    'pg_advisory_lock',
    'pg_advisory_unlock',
    'pg_try_advisory_lock',
    'pg_backend_pid'
  )
ORDER BY grantee, routine_name, privilege_type;

SELECT rolname, rolconfig
FROM pg_catalog.pg_roles
WHERE rolname IN ('videosave_migration', 'videosave_web', 'videosave_worker')
ORDER BY rolname;
