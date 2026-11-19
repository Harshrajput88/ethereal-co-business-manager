import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = process.cwd()
const migrationFiles = [
  '20261118000100_business_schema.sql',
  '20261118000200_business_core_rpcs.sql',
  '20261118000300_business_sales_rpcs.sql',
  '20261118000400_business_payment_rpcs.sql',
  '20261118000500_business_inventory_return_expense_rpcs.sql',
  '20261118000600_business_dashboard_team_rpcs.sql',
  '20261118000700_business_security_integrity_remediation.sql',
  '20261118000800_controlled_owner_bootstrap.sql',
  '20261118000900_revoke_public_rls_auto_enable.sql'
]
const ownerId = '11111111-1111-4111-8111-111111111111'
let db

before(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE FUNCTION public.rls_auto_enable() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
  `)
  for (const file of migrationFiles) {
    await db.exec(readFileSync(join(root, 'supabase', 'migrations', file), 'utf8'))
  }
  await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     VALUES ($1, 'pending@ethereal.test', '{"full_name":"Pending Owner"}'::jsonb)`,
    [ownerId]
  )
})

after(async () => {
  if (db) await db.close()
})

test('migration 008 revokes self-service owner claiming and leaves new signups pending', async () => {
  const privileges = await db.query(`
    SELECT
      has_function_privilege('authenticated', 'public.api_claim_owner()', 'EXECUTE') AS authenticated_can_execute,
      has_function_privilege('anon', 'public.api_claim_owner()', 'EXECUTE') AS anon_can_execute
  `)
  assert.equal(privileges.rows[0].authenticated_can_execute, false)
  assert.equal(privileges.rows[0].anon_can_execute, false)

  const ownerPublicGrant = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) AS public_can_execute
    FROM pg_proc p WHERE p.oid = 'public.api_claim_owner()'::regprocedure
  `)
  assert.equal(ownerPublicGrant.rows[0].public_can_execute, false)

  await db.exec('SET ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [ownerId])
  try {
    await assert.rejects(
      db.query('SELECT public.api_claim_owner()'),
      /permission denied/i
    )
  } finally {
    await db.exec('RESET ROLE')
  }

  const profile = await db.query('SELECT role, status FROM public.profiles WHERE id = $1', [ownerId])
  assert.equal(profile.rows[0].role, 'salesperson')
  assert.equal(profile.rows[0].status, 'pending')
})

test('trusted operator can provision the designated owner without a public RPC', async () => {
  await db.query(`
    UPDATE public.profiles AS p
    SET role = 'owner', status = 'approved',
        approved_at = COALESCE(p.approved_at, now()),
        approved_by = p.id, disabled_at = NULL
    FROM auth.users AS u
    WHERE p.id = u.id AND lower(u.email) = lower('pending@ethereal.test')
  `)
  const profile = await db.query('SELECT role, status FROM public.profiles WHERE id = $1', [ownerId])
  assert.equal(profile.rows[0].role, 'owner')
  assert.equal(profile.rows[0].status, 'approved')
})

test('migration 009 revokes browser execution of the Supabase RLS event-trigger function', async () => {
  const privileges = await db.query(`
    SELECT
      has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') AS anon_can_execute,
      has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') AS authenticated_can_execute,
      has_function_privilege('postgres', 'public.rls_auto_enable()', 'EXECUTE') AS operator_can_execute
  `);
  assert.equal(privileges.rows[0].anon_can_execute, false);
  assert.equal(privileges.rows[0].authenticated_can_execute, false);
  assert.equal(privileges.rows[0].operator_can_execute, true);

  const rlsPublicGrant = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) AS public_can_execute
    FROM pg_proc p WHERE p.oid = 'public.rls_auto_enable()'::regprocedure
  `)
  assert.equal(rlsPublicGrant.rows[0].public_can_execute, false)
});
