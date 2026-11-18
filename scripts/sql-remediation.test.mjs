// Phase 2 security/integrity regression tests for
// supabase/migrations/20261118000700_business_security_integrity_remediation.sql
//
// PGlite is a single-connection, in-process PostgreSQL build. It executes real
// PostgreSQL (PL/pgSQL, advisory locks, row locks, unique indexes), but it cannot
// run two overlapping transactions at once. Tests whose names say "simulated"
// reproduce the *outcome* of a race sequentially and assert the serialization
// primitive exists in the SQL; they are not real multi-connection concurrency
// tests. Real concurrency must be re-run against a disposable PostgreSQL service
// before any remote deployment.
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  '20261118000700_business_security_integrity_remediation.sql'
]
const remediationFile = '20261118000700_business_security_integrity_remediation.sql'
const remediationSql = readFileSync(join(root, 'supabase', 'migrations', remediationFile), 'utf8')

const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  sales1: '33333333-3333-4333-8333-333333333333',
  sales2: '44444444-4444-4444-8444-444444444444',
  pending: '55555555-5555-4555-8555-555555555555',
  disabled: '66666666-6666-4666-8666-666666666666',
  ghost: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
}

let db
let shopA
let variant500
let variant1L

async function prepareDatabase() {
  const instance = new PGlite()
  await instance.exec(`
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
  for (const file of migrationFiles) {
    await instance.exec(readFileSync(join(root, 'supabase', 'migrations', file), 'utf8'))
  }
  return instance
}

async function seedAuthUsers(instance) {
  const users = Object.values(ids).filter(id => id !== ids.ghost)
  await instance.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::jsonb[])`,
    [
      users,
      ['owner@ethereal.test', 'admin@ethereal.test', 'sales1@ethereal.test', 'sales2@ethereal.test', 'pending@ethereal.test', 'disabled@ethereal.test'],
      [
        JSON.stringify({ full_name: 'Owner One' }),
        JSON.stringify({ full_name: 'Admin Two' }),
        JSON.stringify({ full_name: 'Sales One' }),
        JSON.stringify({ full_name: 'Sales Two' }),
        JSON.stringify({ full_name: 'Pending Five' }),
        JSON.stringify({ full_name: 'Disabled Six' })
      ]
    ]
  )
}

async function asUser(userId, sql, params = []) {
  await db.exec('SET ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId || ''])
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function asAnon(sql, params = []) {
  await db.exec('SET ROLE anon')
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)")
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function asAdmin(sql, params = []) {
  await db.exec('RESET ROLE')
  return db.query(sql, params)
}

async function expectFailure(fn, pattern) {
  let failed = false
  try {
    await fn()
  } catch (error) {
    failed = true
    if (pattern) assert.match(error.message, pattern)
  }
  assert.equal(failed, true, 'expected the operation to fail')
}

function row(result) {
  assert.ok(result.rows.length > 0, 'expected a row')
  return result.rows[0]
}

async function createSale(actorId, terms, lines, reference = null) {
  const result = reference
    ? await asUser(actorId, 'SELECT public.api_create_sale($1, $2, $3::jsonb, $4) AS r',
        [shopA, terms, JSON.stringify(lines), reference])
    : await asUser(actorId, 'SELECT public.api_create_sale($1, $2, $3::jsonb) AS r',
        [shopA, terms, JSON.stringify(lines)])
  return row(result).r
}

async function saleLineId(saleId) {
  return row(await asAdmin('SELECT id FROM public.sale_lines WHERE sale_id = $1 ORDER BY variant_id LIMIT 1', [saleId])).id
}

before(async () => {
  db = await prepareDatabase()
  await seedAuthUsers(db)

  await asUser(ids.owner, 'SELECT public.api_claim_owner()')

  for (const id of [ids.admin, ids.sales1, ids.sales2]) {
    await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [id, 'approved'])
  }
  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.admin, 'admin'])
  await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [ids.disabled, 'disabled'])

  const catalog = row(await asUser(ids.owner, 'SELECT public.api_catalog() AS r')).r
  variant500 = catalog.find(c => c.pack_size_ml === 500).variant_id
  variant1L = catalog.find(c => c.pack_size_ml === 1000).variant_id

  await asUser(ids.owner, 'SELECT public.api_set_default_price($1, $2)', [variant500, 240])
  await asUser(ids.owner, 'SELECT public.api_set_default_price($1, $2)', [variant1L, 300])
  await asUser(ids.owner, 'SELECT public.api_receive_stock($1, $2, $3)', [variant500, 100, 'Opening stock'])
  await asUser(ids.owner, 'SELECT public.api_receive_stock($1, $2, $3)', [variant1L, 100, 'Opening stock'])

  shopA = row(await asUser(ids.sales1,
    'SELECT public.api_submit_shop($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',
    ['Green Valley Store', '9990001111', 'gv@example.test', '12 Lake Road', null, 'Kankarbagh', 'Patna', 'Bihar', '800020', 'Corner shop']
  )).r.id
  await asUser(ids.owner,
    'SELECT public.api_review_shop($1, $2, NULL, $3, ARRAY[$4]::uuid[])',
    [shopA, 'approved', ids.sales1, ids.sales1]
  )
})

after(async () => {
  if (db) await db.close()
})

test('team list and audit log deny pending, disabled and salesperson roles (NULL-safe)', async () => {
  const ownerTeam = row(await asUser(ids.owner, 'SELECT public.api_team_list() AS r')).r
  assert.equal(ownerTeam.length, 6, 'owner sees the directory')

  const adminTeam = row(await asUser(ids.admin, 'SELECT public.api_team_list() AS r')).r
  assert.equal(adminTeam.length, 6, 'admin sees the directory')

  for (const id of [ids.sales1, ids.pending, ids.disabled]) {
    const team = row(await asUser(id, 'SELECT public.api_team_list() AS r')).r
    assert.deepEqual(team, [], `api_team_list must not leak profiles (${id})`)
  }

  const ownerAudit = row(await asUser(ids.owner, 'SELECT public.api_audit_log() AS r')).r
  assert.ok(Array.isArray(ownerAudit) && ownerAudit.length > 0, 'owner sees audit events')

  for (const id of [ids.sales1, ids.pending, ids.disabled]) {
    const audit = row(await asUser(id, 'SELECT public.api_audit_log() AS r')).r
    assert.deepEqual(audit, [], `api_audit_log must not leak events (${id})`)
  }
})

test('unauthenticated and anon callers cannot reach protected team/audit data', async () => {
  await expectFailure(() => asAnon('SELECT public.api_team_list()'), /permission denied/i)
  await expectFailure(() => asAnon('SELECT public.api_audit_log()'), /permission denied/i)

  const sessionless = row(await asUser(null, 'SELECT public.api_team_list() AS r')).r
  assert.deepEqual(sessionless, [])
  const sessionlessAudit = row(await asUser(null, 'SELECT public.api_audit_log() AS r')).r
  assert.deepEqual(sessionlessAudit, [])

  await expectFailure(() => asUser(null, 'SELECT public.api_dashboard()'), /Not authorized/)
})

test('pending and disabled employees cannot reach inventory or dashboard data', async () => {
  for (const id of [ids.pending, ids.disabled]) {
    await expectFailure(() => asUser(id, 'SELECT public.api_inventory_list()'), /Not authorized/)
    await expectFailure(() => asUser(id, 'SELECT public.api_dashboard()'), /Not authorized/)
    await expectFailure(
      () => asUser(id, 'SELECT public.api_receive_stock($1, $2, $3)', [variant500, 1, 'nope']),
      /Only the owner or an admin/
    )
  }
})

test('profile updates fail when the caller has no profile row', async () => {
  await expectFailure(
    () => asUser(ids.ghost, 'SELECT public.api_update_my_name($1)', ['Ghost User']),
    /Profile not found/
  )
  await expectFailure(
    () => asUser(ids.ghost, 'SELECT public.api_update_my_avatar($1)', ['https://example.test/a.png']),
    /Profile not found/
  )
})

test('owner bootstrap is serialized and the last active owner cannot be removed (simulated race)', async () => {
  assert.match(
    remediationSql,
    /pg_advisory_xact_lock\(hashtext\('ethereal\.owner_membership'\)::bigint\)/,
    'owner membership changes must take a global advisory lock'
  )
  const lockUses = (remediationSql.match(/ethereal\.owner_membership/g) || []).length
  assert.ok(lockUses >= 3, 'claim, status change and role change must share the owner lock')

  await expectFailure(
    () => asUser(ids.sales1, 'SELECT public.api_claim_owner()'),
    /owner account already exists/
  )

  // Sequential replay of a two-owner race: promote a second owner, demote it,
  // then prove the remaining owner cannot be demoted.
  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.admin, 'owner'])
  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.admin, 'admin'])
  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.owner, 'admin']),
    /last owner cannot be demoted/
  )
  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [ids.owner, 'disabled']),
    /cannot disable or unapprove your own account/
  )
  const stillOwner = row(await asAdmin('SELECT role, status FROM public.profiles WHERE id = $1', [ids.owner]))
  assert.equal(stillOwner.role, 'owner')
  assert.equal(stillOwner.status, 'approved')
})

test('sale idempotency is scoped to the creating actor and payload', async () => {
  const reference = randomUUID()
  const payload = [{ variant_id: variant500, cartons: 1 }]
  const first = await createSale(ids.owner, 'cash', payload, reference)
  const replay = await createSale(ids.owner, 'cash', payload, reference)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.sale_id, first.sale_id)

  await expectFailure(
    () => createSale(ids.owner, 'cash', [{ variant_id: variant500, cartons: 2 }], reference),
    /already used with different sale data/
  )
  await expectFailure(
    () => createSale(ids.sales1, 'cash', payload, reference),
    /belongs to another request/
  )
})

test('payment allocations reject duplicate sales and normalize half-cent amounts', async () => {
  const saleDup = await createSale(ids.sales1, 'cash', [{ variant_id: variant500, cartons: 1 }])
  const saleHalf = await createSale(ids.sales1, 'cash', [{ variant_id: variant1L, cartons: 1 }])

  await expectFailure(
    () => asUser(ids.owner,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb)',
      [shopA, 'cash', 480, JSON.stringify([
        { sale_id: saleDup.sale_id, amount: 240 },
        { sale_id: saleDup.sale_id, amount: 240 }
      ])]),
    /only once in a payment/
  )

  // Raw 0.005 + 0.005 = 0.01 <= 0.01 passed the old aggregate check, but each
  // row rounded to 0.01 on insert, storing 0.02 against a 0.01 payment.
  await expectFailure(
    () => asUser(ids.owner,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb)',
      [shopA, 'cash', 0.01, JSON.stringify([
        { sale_id: saleDup.sale_id, amount: 0.005 },
        { sale_id: saleHalf.sale_id, amount: 0.005 }
      ])]),
    /Allocations cannot exceed the payment amount/
  )

  // A single half-cent input is normalized to one cent before validation.
  const normalized = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'cash', 0.01, JSON.stringify([{ sale_id: saleDup.sale_id, amount: 0.006 }])])).r
  assert.equal(Number(normalized.allocated), 0.01)
  const stored = row(await asAdmin(
    'SELECT amount FROM public.payment_allocations WHERE payment_id = $1', [normalized.payment_id]))
  assert.equal(Number(stored.amount), 0.01)

  // A sub-half-cent allocation rounds to zero and is refused.
  await expectFailure(
    () => asUser(ids.owner,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb)',
      [shopA, 'cash', 1, JSON.stringify([{ sale_id: saleHalf.sale_id, amount: 0.004 }])]),
    /must round to at least 0.01/
  )
})

test('payment idempotency is scoped to the creating actor and payload', async () => {
  const reference = randomUUID()
  const first = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5) AS r',
    [shopA, 'cash', 25, '[]', reference])).r
  const replay = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5) AS r',
    [shopA, 'cash', 25, '[]', reference])).r
  assert.equal(replay.idempotent, true)
  assert.equal(replay.payment_id, first.payment_id)

  await expectFailure(
    () => asUser(ids.owner,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5)',
      [shopA, 'cash', 26, '[]', reference]),
    /already used with different payment data/
  )
  await expectFailure(
    () => asUser(ids.sales1,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5)',
      [shopA, 'cash', 25, '[]', reference]),
    /belongs to another request/
  )
})

test('two payments cannot both settle the same sale balance (simulated verification race)', async () => {
  assert.match(remediationSql, /FOR UPDATE/, 'verification must lock sale rows')

  const sale = await createSale(ids.sales1, 'credit', [{ variant_id: variant500, cartons: 1 }])
  await asUser(ids.owner, 'SELECT public.api_review_credit_sale($1, $2, NULL)', [sale.sale_id, 'approve'])

  const first = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'cash', 240, JSON.stringify([{ sale_id: sale.sale_id, amount: 240 }])])).r
  const second = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'cash', 240, JSON.stringify([{ sale_id: sale.sale_id, amount: 240 }])])).r

  const verified = row(await asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, NULL) AS r',
    [first.payment_id, 'verify'])).r
  assert.equal(verified.status, 'verified')

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, NULL)', [second.payment_id, 'verify']),
    /Sale balance changed/
  )

  const balance = row(await asAdmin('SELECT public.api_sale_balance($1) AS b', [sale.sale_id])).b
  assert.equal(Number(balance), 0)
  const untouched = row(await asAdmin('SELECT status FROM public.payments WHERE id = $1', [second.payment_id]))
  assert.equal(untouched.status, 'submitted', 'the losing verification is rolled back')
})

test('returns reject duplicate lines and cap cumulative requested quantity', async () => {
  const sale = await createSale(ids.sales1, 'cash', [{ variant_id: variant500, cartons: 2 }])
  const line = await saleLineId(sale.sale_id)

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_submit_return($1, $2, $3::jsonb)',
      [sale.sale_id, 'Leaked cartons', JSON.stringify([
        { sale_line_id: line, cartons: 1, condition: 'reusable' },
        { sale_line_id: line, cartons: 1, condition: 'reusable' }
      ])]),
    /only once in a return request/
  )

  const approved = row(await asUser(ids.owner, 'SELECT public.api_submit_return($1, $2, $3::jsonb) AS r',
    [sale.sale_id, 'Leaked cartons', JSON.stringify([
      { sale_line_id: line, cartons: 2, condition: 'reusable' }
    ])])).r
  assert.equal(approved.status, 'submitted')

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_submit_return($1, $2, $3::jsonb)',
      [sale.sale_id, 'More cartons', JSON.stringify([
        { sale_line_id: line, cartons: 1, condition: 'reusable' }
      ])]),
    /exceeds the remaining returnable quantity/
  )

  await asUser(ids.owner, 'SELECT public.api_review_return($1, $2, NULL)', [approved.return_id, 'approve'])

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_submit_return($1, $2, $3::jsonb)',
      [sale.sale_id, 'After approval', JSON.stringify([
        { sale_line_id: line, cartons: 1, condition: 'reusable' }
      ])]),
    /exceeds the remaining returnable quantity/
  )
})

test('return approvals re-check shared sale lines and the unique index blocks duplicates', async () => {
  assert.match(remediationSql, /ethereal\.return_line:/, 'approvals must lock shared sale lines')
  assert.match(remediationSql, /return_lines_request_line_unique/, 'duplicate return lines need a unique index')

  const sale = await createSale(ids.sales1, 'cash', [{ variant_id: variant1L, cartons: 1 }])
  const line = await saleLineId(sale.sale_id)
  const requestA = randomUUID()
  const requestB = randomUUID()

  for (const request of [requestA, requestB]) {
    await asAdmin(
      `INSERT INTO public.return_requests (id, sale_id, shop_id, submitted_by, status, reason)
       VALUES ($1, $2, $3, $4, 'submitted', 'Injected pending return')`,
      [request, sale.sale_id, shopA, ids.sales1]
    )
    await asAdmin(
      `INSERT INTO public.return_lines (return_request_id, sale_id, sale_line_id, variant_id, cartons, condition)
       VALUES ($1, $2, $3, $4, 1, 'reusable')`,
      [request, sale.sale_id, line, variant1L]
    )
  }

  await expectFailure(
    () => asAdmin(
      `INSERT INTO public.return_lines (return_request_id, sale_id, sale_line_id, variant_id, cartons, condition)
       VALUES ($1, $2, $3, $4, 1, 'reusable')`,
      [requestA, sale.sale_id, line, variant1L]
    ),
    /duplicate key value|unique/i
  )

  await asUser(ids.owner, 'SELECT public.api_review_return($1, $2, NULL)', [requestA, 'approve'])
  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_review_return($1, $2, NULL)', [requestB, 'approve']),
    /exceeds the remaining returnable quantity/
  )

  const winner = row(await asAdmin('SELECT status FROM public.return_requests WHERE id = $1', [requestA]))
  const loser = row(await asAdmin('SELECT status FROM public.return_requests WHERE id = $1', [requestB]))
  assert.equal(winner.status, 'approved')
  assert.equal(loser.status, 'submitted')
})

test('stock receipt replay is idempotent, payload-checked and audited once', async () => {
  const reference = randomUUID()
  const auditBefore = Number(row(await asAdmin(
    "SELECT count(*) AS n FROM public.audit_events WHERE action = 'inventory.received'")).n)

  const first = row(await asUser(ids.owner,
    'SELECT public.api_receive_stock($1, $2, $3, $4) AS r',
    [variant1L, 5, 'Retry test', reference])).r
  const replay = row(await asUser(ids.owner,
    'SELECT public.api_receive_stock($1, $2, $3, $4) AS r',
    [variant1L, 5, 'Retry test', reference])).r
  assert.equal(first.idempotent, false)
  assert.equal(replay.idempotent, true)
  assert.equal(Number(replay.saleable), Number(first.saleable))

  const auditAfter = Number(row(await asAdmin(
    "SELECT count(*) AS n FROM public.audit_events WHERE action = 'inventory.received'")).n)
  assert.equal(auditAfter, auditBefore + 1, 'a replay must not duplicate the audit event')

  await expectFailure(
    () => asUser(ids.admin, 'SELECT public.api_receive_stock($1, $2, $3, $4)',
      [variant1L, 6, 'Retry test', reference]),
    /different stock receipt/
  )
})

test('inventory aggregates are bigint and survive beyond 2^31 cartons', async () => {
  const product = row(await asAdmin(
    "SELECT id FROM public.products WHERE name = '500 ml Water'")).id
  const variant = row(await asAdmin(
    `INSERT INTO public.product_variants (product_id, sku, pack_size_ml, bottles_per_carton)
     VALUES ($1, 'ETC-OVERFLOW-TEST', 500, 99) RETURNING id`, [product])).id

  for (const amount of [2147483647, 2147483647]) {
    await asAdmin(
      `INSERT INTO public.inventory_movements
         (variant_id, stock_bucket, movement_type, cartons_delta, source_type, source_id, actor_id, reason)
       VALUES ($1, 'saleable', 'received', $2, 'overflow_test', gen_random_uuid(), $3, 'Overflow test')`,
      [variant, amount, ids.owner]
    )
  }

  const total = row(await asAdmin('SELECT public.api_stock_qty($1, $2) AS q', [variant, 'saleable'])).q
  assert.equal(Number(total), 4294967294, 'api_stock_qty must not overflow at 32 bits')
  const catalogType = row(await asAdmin(
    `SELECT pg_get_function_result(p.oid) AS t FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'api_stock_qty'`)).t
  assert.equal(catalogType, 'bigint')
})

test('dashboard separates cash collected from applied allocations', async () => {
  const payment = row(await asUser(ids.owner,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'cash', 5000, '[]'])).r
  const verified = row(await asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, NULL) AS r',
    [payment.payment_id, 'verify'])).r
  const unapplied = Number(verified.unapplied)
  assert.ok(unapplied > 0, 'the oversized payment leaves cash unapplied')

  const dashboard = row(await asUser(ids.owner, 'SELECT public.api_dashboard() AS r')).r
  assert.ok('applied_today' in dashboard, 'applied_today must be reported explicitly')
  assert.ok('applied_month' in dashboard, 'applied_month must be reported explicitly')

  const collected = Number(dashboard.collected_today)
  const applied = Number(dashboard.applied_today)
  assert.ok(Number.isFinite(collected) && Number.isFinite(applied))
  assert.ok(collected - applied >= unapplied - 0.001,
    'collected (cash received) must exceed applied (settlement) by the unapplied amount')
  assert.ok(Number(dashboard.applied_month) <= Number(dashboard.month_collected))
})

test('a disabled account cannot bootstrap ownership but a pending account can', async () => {
  const isolated = await prepareDatabase()
  const asIsolatedUser = async (userId, sql) => {
    await isolated.exec('SET ROLE authenticated')
    await isolated.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId])
    try {
      return await isolated.query(sql)
    } finally {
      await isolated.exec('RESET ROLE')
    }
  }

  try {
    await seedAuthUsers(isolated)
    await isolated.query("UPDATE public.profiles SET status = 'disabled' WHERE id = $1", [ids.disabled])

    let failed = false
    try {
      await asIsolatedUser(ids.disabled, 'SELECT public.api_claim_owner()')
    } catch (error) {
      failed = true
      assert.match(error.message, /disabled account cannot claim ownership/)
    }
    assert.equal(failed, true, 'disabled accounts must not claim the first owner role')

    // A pending account is the documented bootstrap path for first ownership.
    const claimed = row(await asIsolatedUser(ids.pending, 'SELECT public.api_claim_owner() AS r')).r
    assert.equal(claimed.role, 'owner')
    assert.equal(claimed.status, 'approved')
  } finally {
    await isolated.close()
  }
})

