import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = process.cwd()
const files = [
  '20261118000100_business_schema.sql',
  '20261118000200_business_core_rpcs.sql',
  '20261118000300_business_sales_rpcs.sql',
  '20261118000400_business_payment_rpcs.sql',
  '20261118000500_business_inventory_return_expense_rpcs.sql',
  '20261118000600_business_dashboard_team_rpcs.sql'
]

const db = new PGlite()

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
`)

for (const file of files) {
  const sql = readFileSync(join(root, 'supabase', 'migrations', file), 'utf8')
  try {
    await db.exec(sql)
    console.log('applied', file)
  } catch (error) {
    console.error('FAILED', file)
    console.error(error.message)
    process.exitCode = 1
    break
  }
}

if (!process.exitCode) {
  const tables = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `)
  console.log('tables:', tables.rows.map(r => r.table_name).join(', '))
  const functions = await db.query(`
    SELECT proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND proname LIKE 'api_%'
    ORDER BY proname
  `)
  console.log('rpc count:', functions.rows.length)
}
