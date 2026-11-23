-- Ethereal Co. Business Manager — read-only staging readiness probe.
-- Run only after the reviewed nine-migration package has been deployed to staging.
-- This file contains SELECT statements only. It must not be used as a migration.

\echo '=== Target and PostgreSQL version ==='
SELECT current_database() AS database_name,
       current_user AS executing_role,
       version() AS postgres_version;

\echo '=== Expected migration versions ==='
WITH expected(version) AS (
  VALUES
    ('20261118000100'), ('20261118000200'), ('20261118000300'),
    ('20261118000400'), ('20261118000500'), ('20261118000600'),
    ('20261118000700'), ('20261118000800'), ('20261118000900')
)
SELECT e.version,
       EXISTS (
         SELECT 1 FROM supabase_migrations.schema_migrations m
         WHERE m.version = e.version
       ) AS applied
FROM expected e
ORDER BY e.version;

\echo '=== Public business tables without RLS ==='
SELECT n.nspname AS schema_name, c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relname NOT LIKE 'pg_%'
  AND c.relrowsecurity = false
ORDER BY c.relname;

\echo '=== SECURITY DEFINER functions callable by browser roles ==='
SELECT p.oid::regprocedure AS function_name,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       p.proconfig AS function_settings
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY p.proname, p.oid::regprocedure::text;

\echo '=== Controlled owner bootstrap privilege ==='
SELECT EXISTS (
         SELECT 1
         FROM pg_proc p,
              LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = 'public.api_claim_owner()'::regprocedure
           AND a.grantee = 0
           AND a.privilege_type = 'EXECUTE'
       ) AS public_can_execute,
       has_function_privilege('anon', 'public.api_claim_owner()', 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', 'public.api_claim_owner()', 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('postgres', 'public.api_claim_owner()', 'EXECUTE') AS postgres_can_execute;

\echo '=== Auth signup trigger wiring ==='
SELECT t.tgname, t.tgenabled,
       t.tgtype,
       t.tgfoid::regprocedure AS trigger_function,
       pg_get_userbyid(p.proowner) AS function_owner
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'auth'
  AND c.relname = 'users'
  AND t.tgname = 'on_auth_user_created'
  AND NOT t.tgisinternal;

\echo '=== Supabase ensure_rls event trigger ==='
SELECT e.evtname, e.evtevent, e.evtenabled,
       e.evtfoid::regprocedure AS trigger_function,
       pg_get_userbyid(e.evtowner) AS event_trigger_owner,
       has_function_privilege('anon', e.evtfoid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', e.evtfoid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('postgres', e.evtfoid, 'EXECUTE') AS postgres_can_execute
FROM pg_event_trigger e
WHERE e.evtname = 'ensure_rls';

\echo '=== RLS policies ==='
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
