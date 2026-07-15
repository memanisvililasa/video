\set ON_ERROR_STOP on

-- Read-only audit. Required psql string variables: migration_role, web_role, worker_role.
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolconnlimit
FROM pg_catalog.pg_roles
WHERE rolname IN (:'migration_role', :'web_role', :'worker_role')
ORDER BY rolname;

SELECT n.nspname AS schema_name, owner.rolname AS schema_owner
FROM pg_catalog.pg_namespace AS n
JOIN pg_catalog.pg_roles AS owner ON owner.oid = n.nspowner
WHERE n.nspname = 'public';

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN (:'web_role', :'worker_role')
ORDER BY grantee, table_name, privilege_type;

SELECT rolname, rolconfig
FROM pg_catalog.pg_roles
WHERE rolname IN (:'migration_role', :'web_role', :'worker_role')
ORDER BY rolname;

SELECT member.rolname AS member_role, granted.rolname AS granted_role
FROM pg_catalog.pg_auth_members AS membership
JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
WHERE member.rolname IN (:'web_role', :'worker_role')
ORDER BY member.rolname, granted.rolname;
