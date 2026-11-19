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
  '20261118000700_business_security_integrity_remediation.sql'
]

const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  sales1: '33333333-3333-4333-8333-333333333333',
  sales2: '44444444-4444-4444-8444-444444444444',
  sales3: '55555555-5555-4555-8555-555555555555'
}

let db
let shopA
let shopB
let variant500
let variant1L
let saleCash
let saleCredit

async function asUser(userId, sql, params = []) {
  await db.exec('SET ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId])
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
    -- Simulate a legacy app profile table with an unsafe permissive policy.
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY REFERENCES auth.users(id)
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY legacy_profiles_read_all ON public.profiles
      FOR SELECT TO authenticated USING (true);
  `)

  for (const file of migrationFiles) {
    await db.exec(readFileSync(join(root, 'supabase', 'migrations', file), 'utf8'))
  }

  await db.query(
    `INSERT INTO auth.users (id, email, raw_user_meta_data)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::jsonb[])`,
    [
      Object.values(ids),
      ['owner@ethereal.test', 'admin@ethereal.test', 'sales1@ethereal.test', 'sales2@ethereal.test', 'sales3@ethereal.test'],
      [
        JSON.stringify({ full_name: 'Owner One' }),
        JSON.stringify({ full_name: 'Admin Two' }),
        JSON.stringify({ full_name: 'Sales One' }),
        JSON.stringify({ full_name: 'Sales Two' }),
        JSON.stringify({ full_name: 'Sales Three' })
      ]
    ]
  )

  const profileCount = row(await db.query('SELECT count(*)::int AS n FROM public.profiles'))
  assert.equal(profileCount.n, 5, 'signup trigger creates pending profiles')
})

after(async () => {
  if (db) await db.close()
})

test('profiles migration removes legacy broad policies and scopes reads', async () => {
  const policies = await db.query(
    `SELECT polname FROM pg_policy WHERE polrelid = 'public.profiles'::regclass`
  )
  assert.deepEqual(policies.rows.map(item => item.polname), ['bo_profiles_read'])

  const own = await asUser(ids.sales1, 'SELECT id FROM public.profiles ORDER BY id')
  assert.deepEqual(own.rows.map(item => item.id), [ids.sales1])
})

test('pending users cannot read team directory or audit history', async () => {
  const team = row(await asUser(ids.sales3, 'SELECT public.api_team_list() AS r')).r
  const audit = row(await asUser(ids.sales3, 'SELECT public.api_audit_log() AS r')).r
  assert.deepEqual(team, [])
  assert.deepEqual(audit, [])
})

test('first owner can be claimed only once', async () => {
  const claimed = row(await asUser(ids.owner, 'SELECT public.api_claim_owner() AS r'))
  assert.equal(claimed.r.role, 'owner')
  assert.equal(claimed.r.status, 'approved')

  await expectFailure(
    () => asUser(ids.sales1, 'SELECT public.api_claim_owner()'),
    /owner account already exists/
  )
})

test('owner approves admin and salespeople; disabled accounts lose access', async () => {
  for (const id of [ids.admin, ids.sales1, ids.sales2]) {
    await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [id, 'approved'])
  }
  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.admin, 'admin'])

  const team = row(await asUser(ids.owner, 'SELECT public.api_team_list() AS r')).r
  assert.equal(team.length, 5)
  assert.equal(team.find(p => p.id === ids.sales3).status, 'pending')

  await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [ids.sales3, 'approved'])
  await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [ids.sales3, 'disabled'])
  const disabled = row(await db.query('SELECT status FROM public.profiles WHERE id = $1', [ids.sales3]))
  assert.equal(disabled.status, 'disabled')
  await asUser(ids.owner, 'SELECT public.api_set_employee_status($1, $2)', [ids.sales3, 'approved'])
})

test('catalog is seeded with 24-bottle and 12-bottle cartons', async () => {
  const catalog = row(await asUser(ids.owner, 'SELECT public.api_catalog() AS r')).r
  assert.equal(catalog.length, 2)
  const five = catalog.find(c => c.pack_size_ml === 500)
  const one = catalog.find(c => c.pack_size_ml === 1000)
  assert.equal(five.bottles_per_carton, 24)
  assert.equal(one.bottles_per_carton, 12)
  variant500 = five.variant_id
  variant1L = one.variant_id

  await asUser(ids.owner, 'SELECT public.api_set_default_price($1, $2)', [variant500, 240])
  await asUser(ids.owner, 'SELECT public.api_set_default_price($1, $2)', [variant1L, 300])

  await asUser(ids.owner, 'SELECT public.api_receive_stock($1, $2, $3)', [variant500, 100, 'Opening stock'])
  await asUser(ids.owner, 'SELECT public.api_receive_stock($1, $2, $3)', [variant1L, 100, 'Opening stock'])

  const priced = row(await asUser(ids.sales1, 'SELECT public.api_catalog() AS r')).r
  assert.equal(priced.find(c => c.pack_size_ml === 500).default_price, 240)
  assert.equal(priced.find(c => c.pack_size_ml === 1000).stock_saleable, 100)
})

test('shop submission and approval require assignment', async () => {
  shopA = row(await asUser(ids.sales1,
    'SELECT public.api_submit_shop($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',
    ['Green Valley Store', '9990001111', 'gv@example.test', '12 Lake Road', null, 'Kankarbagh', 'Patna', 'Bihar', '800020', 'Corner shop']
  )).r.id

  shopB = row(await asUser(ids.sales2,
    'SELECT public.api_submit_shop($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS r',
    ['Sunrise Mart', '9990002222', null, '4 Hill Street', null, 'Boring Road', 'Patna', 'Bihar', '800001', null]
  )).r.id

  const pending = row(await asUser(ids.sales1, 'SELECT public.api_shops_list() AS r')).r
  assert.equal(pending.find(s => s.id === shopA).status, 'pending')

  await expectFailure(
    () => asUser(ids.sales1, 'SELECT public.api_review_shop($1, $2, NULL, $3, ARRAY[]::uuid[])', [shopA, 'approved', ids.sales1]),
    /Only the owner or an admin/
  )

  await asUser(ids.owner,
    'SELECT public.api_review_shop($1, $2, NULL, $3, ARRAY[]::uuid[])',
    [shopA, 'approved', ids.sales1]
  )
  await asUser(ids.admin,
    'SELECT public.api_review_shop($1, $2, NULL, $3, ARRAY[]::uuid[])',
    [shopB, 'approved', ids.sales2]
  )

  const shops = row(await asUser(ids.sales1, 'SELECT public.api_shops_list() AS r')).r
  assert.equal(shops.find(s => s.id === shopA).salespeople[0].is_primary, true)
  assert.equal(shops.find(s => s.id === shopB), undefined, 'sales1 cannot see shopB')

  await asUser(ids.owner, 'SELECT public.api_set_shop_price($1, $2, $3)', [shopA, variant500, 230])
})

test('cash sale confirms atomically, moves stock and needs payment verification', async () => {
  saleCash = row(await asUser(ids.sales1,
    'SELECT public.api_create_sale($1, $2, $3::jsonb) AS r',
    [shopA, 'cash', JSON.stringify([
      { variant_id: variant500, cartons: 2 },
      { variant_id: variant1L, cartons: 1 }
    ])]
  )).r

  assert.equal(saleCash.status, 'confirmed')
  assert.equal(Number(saleCash.grand_total), 760)
  assert.match(saleCash.invoice_number, /^ETC-INV-/)

  const stock = row(await asUser(ids.sales1, 'SELECT public.api_catalog() AS r')).r
  assert.equal(stock.find(c => c.variant_id === variant500).stock_saleable, 98)
  assert.equal(stock.find(c => c.variant_id === variant1L).stock_saleable, 99)

  const payments = row(await asUser(ids.sales1, 'SELECT public.api_payments_list() AS r')).r
  const pending = payments.find(p => p.status === 'submitted' && Number(p.amount) === 760)
  assert.ok(pending, 'cash sale creates a submitted payment')

  const before = row(await asUser(ids.sales1, 'SELECT public.api_sales_list() AS r')).r
    .find(s => s.id === saleCash.sale_id)
  assert.equal(Number(before.balance), 760, 'unverified payment does not reduce outstanding')

  const verified = row(await asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, $3) AS r',
    [pending.id, 'verify', null])).r
  assert.equal(verified.status, 'verified')
  assert.match(verified.receipt_number, /^ETC-RCPT-/)

  const after = row(await asUser(ids.sales1, 'SELECT public.api_sales_list() AS r')).r
    .find(s => s.id === saleCash.sale_id)
  assert.equal(Number(after.balance), 0)
})

test('credit sale waits for approval, then moves stock and becomes receivable', async () => {
  saleCredit = row(await asUser(ids.sales1,
    'SELECT public.api_create_sale($1, $2, $3::jsonb) AS r',
    [shopA, 'credit', JSON.stringify([{ variant_id: variant500, cartons: 3 }])]
  )).r
  assert.equal(saleCredit.status, 'pending_credit_approval')
  assert.equal(Number(saleCredit.grand_total), 690)

  let stock = row(await asUser(ids.sales1, 'SELECT public.api_catalog() AS r')).r
  assert.equal(stock.find(c => c.variant_id === variant500).stock_saleable, 98, 'credit awaits approval')

  const approved = row(await asUser(ids.owner,
    'SELECT public.api_review_credit_sale($1, $2, $3) AS r',
    [saleCredit.sale_id, 'approve', null]
  )).r
  assert.equal(approved.status, 'confirmed')

  stock = row(await asUser(ids.sales1, 'SELECT public.api_catalog() AS r')).r
  assert.equal(stock.find(c => c.variant_id === variant500).stock_saleable, 95)

  const detail = row(await asUser(ids.sales1, 'SELECT public.api_sale_detail($1) AS r', [saleCredit.sale_id])).r
  assert.equal(Number(detail.balance), 690)
  assert.ok(detail.invoice.invoice_number)
})

test('payment with no allocation auto-allocates FIFO on verification', async () => {
  const recorded = row(await asUser(ids.sales1,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'upi', 690, '[]']
  )).r
  assert.equal(recorded.status, 'submitted')

  await asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, NULL)', [recorded.payment_id, 'verify'])

  const detail = row(await asUser(ids.sales1, 'SELECT public.api_sale_detail($1) AS r', [saleCredit.sale_id])).r
  assert.equal(Number(detail.balance), 0)
  assert.ok(detail.payments.some(p => p.status === 'verified'))
})

test('rejected payment does not affect receivables', async () => {
  const recorded = row(await asUser(ids.sales1,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb) AS r',
    [shopA, 'cash', 100, '[]']
  )).r

  await asUser(ids.owner, 'SELECT public.api_verify_payment($1, $2, $3)',
    [recorded.payment_id, 'reject', 'Cash not deposited'])

  const detail = row(await asUser(ids.sales1, 'SELECT public.api_sale_detail($1) AS r', [saleCredit.sale_id])).r
  assert.equal(Number(detail.balance), 0)

  const payments = row(await asUser(ids.sales1, 'SELECT public.api_payments_list() AS r')).r
  assert.equal(payments.find(p => p.id === recorded.payment_id).status, 'rejected')
})

test('returns add reusable stock and credit the shop ledger', async () => {
  const detail = row(await asUser(ids.sales1, 'SELECT public.api_sale_detail($1) AS r', [saleCredit.sale_id])).r
  const line = detail.lines[0]

  const created = row(await asUser(ids.sales1,
    'SELECT public.api_submit_return($1, $2, $3::jsonb) AS r',
    [saleCredit.sale_id, 'Two bottles leaked', JSON.stringify([
      { sale_line_id: line.id, cartons: 1, condition: 'reusable' }
    ])]
  )).r
  assert.equal(created.status, 'submitted')

  const approved = row(await asUser(ids.owner,
    'SELECT public.api_review_return($1, $2, NULL) AS r',
    [created.return_id, 'approve']
  )).r
  assert.equal(approved.status, 'approved')
  assert.equal(Number(approved.credit), 230)

  const stock = row(await asUser(ids.sales1, 'SELECT public.api_catalog() AS r')).r
  assert.equal(stock.find(c => c.variant_id === variant500).stock_saleable, 96)

  const after = row(await asUser(ids.sales1, 'SELECT public.api_sale_detail($1) AS r', [saleCredit.sale_id])).r
  assert.equal(Number(after.balance), 0)

  await expectFailure(
    () => asUser(ids.sales1, 'SELECT public.api_review_return($1, $2, NULL)', [created.return_id, 'approve']),
    /Only the owner or an admin/
  )
})

test('inventory adjustments require a reason and cannot go negative', async () => {
  await asUser(ids.owner, 'SELECT public.api_adjust_stock($1, $2, $3, $4)',
    [variant500, 'saleable', -1, 'Physical count correction'])

  const stock = row(await asUser(ids.owner, 'SELECT public.api_catalog() AS r')).r
  assert.equal(stock.find(c => c.variant_id === variant500).stock_saleable, 95)

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_adjust_stock($1, $2, $3, $4)',
      [variant500, 'saleable', -999, 'Impossible']),
    /negative/
  )
  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_adjust_stock($1, $2, $3, $4)',
      [variant500, 'saleable', 1, '   ']),
    /reason is required/
  )
})

test('expenses require independent approval and can be settled', async () => {
  const claim = row(await asUser(ids.sales1,
    'SELECT public.api_submit_expense($1, $2, $3, $4) AS r',
    [new Date().toISOString().slice(0, 10), 'Transport', 'Auto fare to shop', 150]
  )).r

  await asUser(ids.owner, 'SELECT public.api_review_expense($1, $2, NULL)', [claim.id, 'approve'])
  const paid = row(await asUser(ids.owner, 'SELECT public.api_mark_expense_paid($1) AS r', [claim.id])).r
  assert.equal(paid.status, 'paid')

  const own = row(await asUser(ids.admin,
    'SELECT public.api_submit_expense($1, $2, $3, $4) AS r',
    [new Date().toISOString().slice(0, 10), 'Office', 'Self claim', 50]
  )).r
  await expectFailure(
    () => asUser(ids.admin, 'SELECT public.api_review_expense($1, $2, NULL)', [own.id, 'approve']),
    /cannot approve or reject your own expense/
  )
})

test('salespeople cannot sell to unassigned shops or bypass the API', async () => {
  await expectFailure(
    () => asUser(ids.sales2, 'SELECT public.api_create_sale($1, $2, $3::jsonb)',
      [shopA, 'cash', JSON.stringify([{ variant_id: variant500, cartons: 1 }])]),
    /not assigned/
  )

  await expectFailure(
    () => asUser(ids.sales1,
      `INSERT INTO public.sales (shop_id, salesperson_id, status, payment_terms, business_date, grand_total)
       VALUES ($1, $2, 'confirmed', 'cash', current_date, 1)`,
      [shopA, ids.sales1]),
    /permission denied/
  )

  await expectFailure(
    () => asUser(ids.sales1, 'UPDATE public.profiles SET status = $2 WHERE id = $1', [ids.sales1, 'approved']),
    /permission denied/
  )
})

test('idempotency and role management', async () => {
  const ref = '99999999-9999-4999-8999-999999999999'
  const first = row(await asUser(ids.sales1,
    'SELECT public.api_create_sale($1, $2, $3::jsonb, $4) AS r',
    [shopA, 'cash', JSON.stringify([{ variant_id: variant1L, cartons: 1 }]), ref]
  )).r
  const second = row(await asUser(ids.sales1,
    'SELECT public.api_create_sale($1, $2, $3::jsonb, $4) AS r',
    [shopA, 'cash', JSON.stringify([{ variant_id: variant1L, cartons: 1 }]), ref]
  )).r

  assert.equal(first.sale_id, second.sale_id)
  assert.equal(second.idempotent, true)

  await expectFailure(
    () => asUser(ids.sales2,
      'SELECT public.api_create_sale($1, $2, $3::jsonb, $4)',
      [shopB, 'cash', JSON.stringify([{ variant_id: variant1L, cartons: 1 }]), ref]),
    /This client reference belongs to another request/
  )

  const rightfulRetry = row(await asUser(ids.sales1,
    'SELECT public.api_create_sale($1, $2, $3::jsonb, $4) AS r',
    [shopA, 'cash', JSON.stringify([{ variant_id: variant1L, cartons: 1 }]), ref]
  )).r
  assert.equal(rightfulRetry.sale_id, first.sale_id)
  assert.equal(rightfulRetry.idempotent, true)

  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.sales2, 'admin'])
  const promoted = row(await db.query('SELECT role FROM public.profiles WHERE id = $1', [ids.sales2]))
  assert.equal(promoted.role, 'admin')

  await asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.sales2, 'salesperson'])

  await expectFailure(
    () => asUser(ids.owner, 'SELECT public.api_set_employee_role($1, $2)', [ids.owner, 'salesperson']),
    /last owner/
  )
})

test('payment idempotency references cannot be replayed by another salesperson', async () => {
  const ref = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const first = row(await asUser(ids.sales1,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5) AS r',
    [shopA, 'upi', 25, '[]', ref]
  )).r
  assert.equal(first.status, 'submitted')

  await expectFailure(
    () => asUser(ids.sales2,
      'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5)',
      [shopB, 'upi', 25, '[]', ref]
    ),
    /This client reference belongs to another request/
  )

  const rightfulRetry = row(await asUser(ids.sales1,
    'SELECT public.api_record_payment($1, $2, $3, now(), NULL, $4::jsonb, $5) AS r',
    [shopA, 'upi', 25, '[]', ref]
  )).r
  assert.equal(rightfulRetry.payment_id, first.payment_id)
  assert.equal(rightfulRetry.idempotent, true)
})

test('dashboard and reports reflect verified money only', async () => {
  const dash = row(await asUser(ids.owner, 'SELECT public.api_dashboard() AS r')).r
  assert.equal(Number(dash.today_sales), 1750) // 760 cash + 690 credit + 240 idempotent sale
  assert.equal(Number(dash.outstanding), 300)
  assert.ok(Number(dash.collected_today) >= 1450)
  assert.equal(dash.stock.length, 2)
  assert.ok(dash.recent_sales.length >= 3)

  const audit = row(await asUser(ids.owner, 'SELECT public.api_audit_log() AS r')).r
  assert.ok(audit.length > 5)

  const salespersonAudit = row(await asUser(ids.sales1, 'SELECT public.api_audit_log() AS r')).r
  assert.equal(salespersonAudit.length, 0)

  const sales = row(await asUser(ids.owner, 'SELECT public.api_sales_list() AS r')).r
  assert.ok(sales.every(s => s.invoice_number || s.status !== 'confirmed'))
})
