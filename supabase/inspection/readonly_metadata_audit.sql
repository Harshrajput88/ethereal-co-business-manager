-- ETHEREAL CO. — READ-ONLY SUPABASE METADATA AUDIT
-- Review the companion PHASE_0C_FINAL_METADATA_SQL_REVIEW.pdf before manual use.
-- This file contains only SELECT statements. It does not change database state.
-- No connection or SQL execution is performed while preparing/reviewing this file.
-- Catalog and information_schema visibility depends on the inspecting role.
--
-- Safe-use note: Run one labelled section at a time in an owner-approved staging
-- SQL editor/session. Do not run against production. This audit avoids business
-- rows, Auth user rows, storage object rows, secrets, and sample data.

-- 01. Visible schemas
SELECT schema_name
FROM information_schema.schemata
WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
ORDER BY schema_name;

-- Expected: non-system schema names visible to the current role.

-- 02. Tables and views
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;

-- Expected: visible relation names/types; privilege-filtered.

-- 03. Columns and defaults
SELECT table_schema, table_name, ordinal_position, column_name, data_type,
       udt_name, is_nullable, column_default, character_maximum_length,
       numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;

-- Expected: visible column metadata. Defaults may reveal implementation details.

-- 04. Primary, unique, foreign-key, and check constraints
SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS constraint_name,
       CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE'
            WHEN 'f' THEN 'FOREIGN KEY' WHEN 'c' THEN 'CHECK' ELSE con.contype::text END AS constraint_type,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, con.conname;

-- Expected: constraint definitions for visible non-system relations.

-- 05. Foreign-key relationships, positionally matched for composite keys
SELECT source_ns.nspname AS referencing_schema,
       source_table.relname AS referencing_table,
       source_column.attname AS referencing_column,
       target_ns.nspname AS referenced_schema,
       target_table.relname AS referenced_table,
       target_column.attname AS referenced_column,
       source_key.ordinality AS column_position,
       con.conname AS constraint_name,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class source_table ON source_table.oid = con.conrelid
JOIN pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
JOIN pg_class target_table ON target_table.oid = con.confrelid
JOIN pg_namespace target_ns ON target_ns.oid = target_table.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinality)
JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
  ON target_key.ordinality = source_key.ordinality
JOIN pg_attribute source_column
  ON source_column.attrelid = source_table.oid
 AND source_column.attnum = source_key.attnum
JOIN pg_attribute target_column
  ON target_column.attrelid = target_table.oid
 AND target_column.attnum = target_key.attnum
WHERE con.contype = 'f'
  AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY source_ns.nspname, source_table.relname, con.conname, source_key.ordinality;

-- Expected: one output row per FK column. conkey/confkey are unnested with
-- WITH ORDINALITY, pairing referencing/referenced attnums at the same constraint
-- position; composite FKs therefore remain correctly paired.

-- 06. Indexes
SELECT schemaname AS schema_name, tablename AS table_name, indexname AS index_name,
       indexdef AS definition
FROM pg_indexes
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename, indexname;

-- Expected: visible index names/definitions.

-- 07. Row-level security status
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname;

-- Expected: RLS enabled/forced flags for visible ordinary/partitioned tables.

-- 08. RLS policies
SELECT schemaname AS schema_name, tablename AS table_name, policyname,
       permissive, roles, cmd AS command, qual AS using_expression,
       with_check AS check_expression
FROM pg_policies
ORDER BY schemaname, tablename, policyname;

-- Expected: policies visible to the current role; expressions may disclose logic.

-- 09. Grants, role membership, and effective privilege checks (read-only)
-- 09a. Direct table grants and explicit PUBLIC table grants.
-- information_schema.role_table_grants reports grants applicable to current role
-- (including inherited role grants in some PostgreSQL versions); it is not a
-- complete ACL provenance report. The ACL query below distinguishes explicit ACLs.
SELECT n.nspname AS schema_name, c.relname AS table_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname END AS grantee,
       grantor_role.rolname AS grantor, acl.privilege_type,
       acl.is_grantable, 'explicit ACL entry' AS grant_source
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS acl
LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, grantee, acl.privilege_type;

-- 09b. Direct schema ACL entries (schema usage/create are separate from table ACLs).
SELECT n.nspname AS schema_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname END AS grantee,
       grantor_role.rolname AS grantor, acl.privilege_type, acl.is_grantable
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS acl
LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, grantee, acl.privilege_type;

-- 09c. Role membership edges. Visibility may require elevated catalog privileges;
-- membership does not by itself mean every member can assume every role.
SELECT member_role.rolname AS member_role, granted_role.rolname AS granted_role,
       grantor_role.rolname AS grantor, m.admin_option
FROM pg_auth_members m
JOIN pg_roles granted_role ON granted_role.oid = m.roleid
JOIN pg_roles member_role ON member_role.oid = m.member
LEFT JOIN pg_roles grantor_role ON grantor_role.oid = m.grantor
ORDER BY member_role.rolname, granted_role.rolname;

-- 09d. Effective table privileges for the current session user. This evaluates
-- the effective privilege check, including applicable inherited/PUBLIC grants.
-- It does not identify which ACL path supplied a privilege and is not an RLS test.
SELECT table_schema, table_name,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'SELECT') AS can_select,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'INSERT') AS can_insert,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'UPDATE') AS can_update,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'DELETE') AS can_delete,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'TRUNCATE') AS can_truncate,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'REFERENCES') AS can_reference,
       has_table_privilege(current_user, quote_ident(table_schema) || '.' || quote_ident(table_name), 'TRIGGER') AS can_trigger
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;

-- Expected: explicit ACL rows, PUBLIC/direct grantees, visible membership edges,
-- and current_user effective booleans. Results can differ by inspecting role.
-- No privilege is changed. These checks do not establish row-level access under RLS.

-- 10. Routine metadata only (no function/procedure bodies)
SELECT n.nspname AS schema_name, p.proname AS routine_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       pg_get_function_result(p.oid) AS result_type, p.prokind AS routine_kind,
       p.prosecdef AS security_definer, p.provolatile AS volatility,
       p.proacl AS routine_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, p.proname, arguments;

-- Optional manual review only — sensitive routine bodies may contain credentials,
-- business logic, or other implementation details. Do not run as part of the
-- ordinary metadata audit. Review only with owner approval and appropriate access.
-- SELECT n.nspname AS schema_name, p.proname AS routine_name,
--        pg_get_function_identity_arguments(p.oid) AS arguments,
--        pg_get_functiondef(p.oid) AS definition
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
-- ORDER BY n.nspname, p.proname, arguments;

-- 11. Non-internal triggers and trigger definitions
SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid, true) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY n.nspname, c.relname, t.tgname;

-- Expected: visible non-internal trigger definitions; may reveal implementation.

-- 12. Storage catalog compatibility and bucket metadata
-- Do not assume the storage schema or bucket columns exist. This query reads
-- information_schema only and safely returns zero rows if storage.buckets is absent.
SELECT table_schema, table_name, ordinal_position, column_name, data_type,
       udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'storage'
  AND table_name = 'buckets'
ORDER BY ordinal_position;

-- Expected: installed bucket-column inventory, or zero rows if absent/invisible.
-- Review these columns before selecting bucket values: Supabase versions vary
-- (for example owner/owner_id, timestamps, limits, and MIME-type columns).
-- Optional manual follow-up ONLY after confirming every selected column exists:
-- SELECT id, name, public FROM storage.buckets ORDER BY name;
-- The optional query is intentionally commented out and is not portable across
-- versions. This section never reads storage.objects or object names/content.

-- 13. Storage policies, if any
-- pg_policies is a system view and can be filtered by visibility. No assumption
-- is made that a storage schema or storage.objects relation exists.
SELECT schemaname AS schema_name, tablename AS table_name, policyname,
       permissive, roles, cmd AS command, qual AS using_expression,
       with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'storage'
ORDER BY tablename, policyname;

-- Expected: visible policies in schema storage, or zero rows. This is metadata only.

-- 14. Supabase migration-history visibility and safe existence/column check
-- Never directly SELECT from supabase_migrations.schema_migrations here: a static
-- relation reference fails if the relation is absent. This catalog-only SELECT
-- safely returns zero rows when schema/table is absent or not visible. It reports
-- whether the expected relation and its columns are visible; it does not read rows.
SELECT table_schema, table_name, ordinal_position, column_name, data_type,
       udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'supabase_migrations'
  AND table_name = 'schema_migrations'
ORDER BY ordinal_position;

-- Expected: migration-history column inventory, or zero rows when absent/invisible.
-- Supabase CLI/project versions and permissions vary; history may be elsewhere or
-- inaccessible. Only after confirming table existence, columns, authorization, and
-- staging target may an owner manually run an appropriate SELECT version/name query.
-- Do not infer that zero rows means no migrations exist.

-- GENERAL LIMITATIONS
-- Catalog/information_schema results are privilege-filtered. Absence from output
-- does not prove absence. Effective SQL privileges are distinct from RLS outcomes.
-- Storage catalog schemas/columns and migration-history layout are version-dependent.
-- No business data, auth.users rows, storage objects, secrets, or function bodies
-- are included in ordinary output. Do not run against production.
