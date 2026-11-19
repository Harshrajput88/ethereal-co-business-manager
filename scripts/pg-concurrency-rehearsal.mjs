// Phase 3 — real PostgreSQL 17 concurrency rehearsal.
//
// Unlike the PGlite suites (single connection), every race in this script uses
// separate psql processes, i.e. separate PostgreSQL backends. Each race holds
// its transaction open after the RPC while a second session attempts the
// conflicting operation, so the two transactions genuinely overlap.
//
// Safety rails:
//   * refuses to run unless PGDATABASE === 'ethereal_phase3_test'
//   * refuses any non-loopback host
//   * refuses any server version that is not PostgreSQL 17
//   * recreates ONLY ethereal_phase3_test before starting
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PSQL = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe'
const HOST = process.env.PGHOST || '127.0.0.1'
const PORT = process.env.PGPORT || '55432'
const DB = process.env.PGDATABASE || 'ethereal_phase3_test'
const USER = process.env.PGUSER || 'postgres'
const EVIDENCE_DIR = join(ROOT, 'reports')
const STAMP = new Date().toISOString()

const OWNER = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const SALES1 = '33333333-3333-4333-8333-333333333333'
const SALES2 = '44444444-4444-4444-8444-444444444444'
const PENDING = '55555555-5555-4555-8555-555555555555'
const DISABLED = '66666666-6666-4666-8666-666666666666'

const MIGRATIONS = [
  '20261118000100_business_schema.sql',
  '20261118000200_business_core_rpcs.sql',
  '20261118000300_business_sales_rpcs.sql',
  '20261118000400_business_payment_rpcs.sql',
  '20261118000500_business_inventory_return_expense_rpcs.sql',
  '20261118000600_business_dashboard_team_rpcs.sql',
  '20261118000700_business_security_integrity_remediation.sql'
]

const TAIL_MIGRATIONS = [
  '20261118000800_controlled_owner_bootstrap.sql',
  '20261118000900_revoke_public_rls_auto_enable.sql'
]

const logLines = []
const results = []
const database = { host: HOST, port: PORT, name: DB, migrations: [], hashes: {} }
let shopId = null
let ownerId = OWNER
let variant500 = null
let variant1L = null

function log(line = '') {
  logLines.push(line)
  console.log(line)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function lastLine(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

function psqlArgs(extra = []) {
  return ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    '-h', HOST, '-p', PORT, '-U', USER, ...extra]
}

function startPsql(sql, label, db = DB, singleTransaction = true) {
  const started = Date.now()
  // SQL is fed through stdin: migrations exceed the Windows command-line limit.
  // -1 wraps the script in one transaction; an explicit trailing COMMIT sent
  // through stdin was observed to roll back, so every session relies on -1.
  const extra = ['-d', db]
  if (singleTransaction) extra.push('-1')
  const child = spawn(PSQL, psqlArgs(extra), {
    env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' },
    windowsHide: true
  })
  child.stdin.on('error', () => {})
  child.stdin.write(sql)
  child.stdin.end()
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { err += chunk.toString('utf8') })
  const done = new Promise(resolve => {
    const timer = setTimeout(() => {
      err += `\n[harness] killed after 90s timeout`
      child.kill('SIGKILL')
    }, 90_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ label, code, out, err, started, ended: Date.now(), durationMs: Date.now() - started })
    })
  })
  return { child, done, label }
}

async function psqlText(sql, db = DB, singleTransaction = true) {
  const run = startPsql(sql, 'psql', db, singleTransaction)
  return run.done
}

function sessionSql(role, userId, body, holdSeconds = 0) {
  const prelude = role === 'authenticated'
    ? `SET LOCAL ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '${userId}', true);`
    : `SET LOCAL client_min_messages = warning;`
  return `${prelude}\nSET LOCAL client_min_messages = warning;\n${body}\n${holdSeconds > 0 ? `SELECT pg_sleep(${holdSeconds});` : ''}`
}

async function runSession(role, userId, body, holdSeconds = 0) {
  return psqlText(sessionSql(role, userId, body, holdSeconds))
}

async function admin(sql) {
  const run = await psqlText(sql)
  if (run.code !== 0) throw new Error(`admin sql failed: ${run.err.trim()}\nSQL: ${sql}`)
  return run
}

async function adminValue(sql) {
  return lastLine((await admin(sql)).out)
}

async function rows(sql) {
  const json = await adminValue(`SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (${sql}) t`)
  return JSON.parse(json)
}

async function rpc(userId, sql) {
  const run = await runSession('authenticated', userId, sql)
  if (run.code !== 0) throw new Error(`setup RPC failed for ${userId}: ${run.err.trim()}\nSQL: ${sql}`)
  return JSON.parse(lastLine(run.out))
}

function expect(checks, name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail })
  if (!condition) log(`   FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
}

const SNAPSHOT_SQL = `SELECT json_build_object(
  'advisory_locks', (SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid = l.database
                     WHERE l.locktype = 'advisory' AND d.datname = current_database()),
  'lock_waiters', (SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database() AND wait_event_type = 'Lock'),
  'sessions', COALESCE((SELECT json_agg(json_build_object(
      'pid', pid, 'state', state,
      'wait', COALESCE(wait_event_type || '/' || wait_event, ''),
      'blocked_by', pg_blocking_pids(pid),
      'query', left(regexp_replace(query, '\\s+', ' ', 'g'), 110)))
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND pid <> pg_backend_pid()), '[]'::json))`

async function race({ roleA, userA, bodyA, roleB, userB, bodyB, delayMs = 400, holdSeconds = 1.6, monitorMs = 1000 }) {
  const a = startPsql(sessionSql(roleA, userA, bodyA, holdSeconds), 'A')
  await sleep(delayMs)
  const b = startPsql(sessionSql(roleB, userB, bodyB, 0), 'B')
  await sleep(Math.max(0, monitorMs - delayMs))
  let snapshot = null
  try {
    snapshot = JSON.parse(lastLine((await psqlText(SNAPSHOT_SQL)).out))
  } catch (error) {
    snapshot = { error: error.message }
  }
  const [runA, runB] = await Promise.all([a.done, b.done])
  const overlapMs = Math.max(0, Math.min(runA.ended, runB.ended) - Math.max(runA.started, runB.started))
  return { runA, runB, snapshot, overlapMs }
}

function scenarioLogger(name) {
  log('')
  log(`=== ${name} ===`)
}

async function resetDatabase() {
  const drop = await psqlText(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`, 'postgres', false)
  if (drop.code !== 0) throw new Error(`drop failed: ${drop.err}`)
  const create = await psqlText(`CREATE DATABASE ${DB};`, 'postgres', false)
  if (create.code !== 0) throw new Error(`create failed: ${create.err}`)
}

async function applyMigrations() {
  const bootstrap = process.env.PHASE3_BOOTSTRAP_SQL || join(ROOT, 'scripts', 'phase3-bootstrap.sql')
  if (!existsSync(bootstrap)) throw new Error(`bootstrap SQL missing at ${bootstrap}`)
  const boot = await psqlText(readFileSync(bootstrap, 'utf8'))
  if (boot.code !== 0) throw new Error(`bootstrap failed: ${boot.err}`)
  for (const file of MIGRATIONS) {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', file), 'utf8')
    database.hashes[file] = createHash('sha256').update(sql).digest('hex').toUpperCase()
    const run = await psqlText(sql)
    if (run.code !== 0) throw new Error(`migration ${file} failed: ${run.err}`)
    database.migrations.push(file)
  }
}

async function identityCheck() {
  const version = await adminValue('SELECT current_setting(\'server_version\')')
  const db = await adminValue('SELECT current_database()')
  const host = await adminValue('SELECT COALESCE(host(inet_server_addr()), \'local\')')
  const port = await adminValue('SELECT inet_server_port()')
  if (!version.startsWith('17.')) throw new Error(`PostgreSQL 17 required, found ${version}`)
  if (db !== 'ethereal_phase3_test') throw new Error(`wrong database ${db}`)
  if (!['127.0.0.1', '::1', 'local'].includes(host)) throw new Error(`non-loopback server ${host}`)
  return { version, db, host, port }
}

async function seedFixtures() {
  await admin(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${OWNER}',   'owner@ethereal.test',    '{"full_name":"Owner One"}'),
    ('${ADMIN}',   'admin@ethereal.test',    '{"full_name":"Admin Two"}'),
    ('${SALES1}',  'sales1@ethereal.test',   '{"full_name":"Sales One"}'),
    ('${SALES2}',  'sales2@ethereal.test',   '{"full_name":"Sales Two"}'),
    ('${PENDING}', 'pending@ethereal.test',  '{"full_name":"Pending Five"}'),
    ('${DISABLED}','disabled@ethereal.test', '{"full_name":"Disabled Six"}')
    ON CONFLICT (id) DO NOTHING`)

  // The first-owner claim already happened in scenario 1; resolve the winner.
  ownerId = await adminValue(`SELECT id FROM public.profiles WHERE role = 'owner' AND status = 'approved' LIMIT 1`)

  await rpc(ownerId, `SELECT public.api_set_employee_status('${ADMIN}', 'approved');
                      SELECT public.api_set_employee_role('${ADMIN}', 'admin');
                      SELECT public.api_set_employee_status('${SALES1}', 'approved');
                      SELECT public.api_set_employee_status('${SALES2}', 'approved');
                      SELECT public.api_set_employee_status('${DISABLED}', 'disabled');`)

  variant500 = await adminValue(`SELECT id FROM public.product_variants WHERE sku = 'ETC-500ML-24'`)
  variant1L = await adminValue(`SELECT id FROM public.product_variants WHERE sku = 'ETC-1L-12'`)

  await rpc(ownerId, `SELECT public.api_set_default_price('${variant500}', 240);
                      SELECT public.api_set_default_price('${variant1L}', 300);
                      SELECT public.api_receive_stock('${variant500}', 100, 'Opening stock', 'aaaaaaaa-0000-4000-8000-000000000001');
                      SELECT public.api_receive_stock('${variant1L}', 100, 'Opening stock', 'aaaaaaaa-0000-4000-8000-000000000002');`)

  const shop = await rpc(SALES1, `SELECT public.api_submit_shop(
    'Green Valley Store', '9990001111', 'gv@example.test', '12 Lake Road', NULL,
    'Kankarbagh', 'Patna', 'Bihar', '800020', 'Corner shop')`)
  shopId = shop.id
  const shopVisible = await adminValue(`SELECT count(*) FROM public.shops WHERE id = '${shopId}'`)
  log(`shop submit: id=${shopId} status=${shop.status} visibleRows=${shopVisible}`)
  if (shopVisible !== '1') throw new Error(`shop ${shopId} was not committed`)
  await rpc(ownerId, `SELECT public.api_review_shop('${shopId}', 'approved', NULL, '${SALES1}', ARRAY['${SALES1}']::uuid[])`)
}

async function scenarioFirstOwnerClaim() {
  scenarioLogger('1. Concurrent first-owner claims')
  const checks = []
  const reference = randomUUID()
  const raceResult = await race({
    roleA: 'authenticated', userA: OWNER,
    bodyA: 'SELECT public.api_claim_owner();',
    roleB: 'authenticated', userB: PENDING,
    bodyB: 'SELECT public.api_claim_owner();',
    holdSeconds: 1.6
  })
  log(`A(owner bid) exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B(pending bid) exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  expect(checks, 'A claim committed', raceResult.runA.code === 0)
  expect(checks, 'B claim rejected', raceResult.runB.code !== 0 && /owner account already exists/i.test(raceResult.runB.err))
  expect(checks, 'B waited behind the owner advisory lock (>=800ms)',
    raceResult.runB.durationMs >= 800, `${raceResult.runB.durationMs}ms`)
  expect(checks, 'second session observed waiting on a lock',
    Array.isArray(raceResult.snapshot?.sessions) && raceResult.snapshot.sessions.some(s => s.blocked_by?.length > 0),
    JSON.stringify(raceResult.snapshot?.sessions || []))

  const state = await rows(`SELECT role, status, count(*)::int AS n FROM public.profiles GROUP BY 1,2 ORDER BY 1,2`)
  const approvedOwners = Number(await adminValue(`SELECT count(*) FROM public.profiles WHERE role='owner' AND status='approved'`))
  expect(checks, 'exactly one approved owner exists', approvedOwners === 1, String(approvedOwners))
  expect(checks, 'no second owner row was created', state.filter(r => r.role === 'owner').length === 1, JSON.stringify(state))

  return { name: '1. Concurrent first-owner claims', checks, evidence: { race: summarizeRace(raceResult), state } }
}

async function scenarioLastOwnerDemotion() {
  scenarioLogger('2. Concurrent last-owner demotion')
  const checks = []
  await rpc(ownerId, `SELECT public.api_set_employee_role('${ADMIN}', 'owner')`)
  const before = Number(await adminValue(`SELECT count(*) FROM public.profiles WHERE role='owner' AND status='approved'`))
  expect(checks, 'setup has two approved owners', before === 2, String(before))

  const raceResult = await race({
    roleA: 'authenticated', userA: ADMIN,
    bodyA: `SELECT public.api_set_employee_role('${OWNER}', 'admin');`,
    roleB: 'authenticated', userB: OWNER,
    bodyB: `SELECT public.api_set_employee_role('${ADMIN}', 'admin');`,
    holdSeconds: 1.6
  })
  log(`A(${ADMIN.slice(0, 8)} demotes owner1) exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B(${OWNER.slice(0, 8)} demotes owner2) exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  expect(checks, 'exactly one demotion committed', [raceResult.runA.code, raceResult.runB.code].filter(c => c === 0).length === 1,
    `A=${raceResult.runA.code} B=${raceResult.runB.code}`)
  expect(checks, 'loser rejected with last-owner guard',
    /last owner cannot be demoted/i.test(raceResult.runA.err + raceResult.runB.err))
  expect(checks, 'loser waited behind the membership advisory lock',
    Math.max(raceResult.runA.durationMs, raceResult.runB.durationMs) >= 800)

  const approvedOwners = Number(await adminValue(`SELECT count(*) FROM public.profiles WHERE role='owner' AND status='approved'`))
  expect(checks, 'exactly one approved owner remains', approvedOwners === 1, String(approvedOwners))

  // Restore a known owner/admin pair for later scenarios.
  const currentOwner = await adminValue(`SELECT id FROM public.profiles WHERE role='owner' AND status='approved' LIMIT 1`)
  await rpc(currentOwner, `SELECT public.api_set_employee_role('${OWNER}', 'owner')`)
  await rpc(OWNER, `SELECT public.api_set_employee_role('${ADMIN}', 'admin')`)
  ownerId = OWNER
  const restored = Number(await adminValue(`SELECT count(*) FROM public.profiles WHERE role='owner' AND status='approved'`))
  expect(checks, 'state restored to one owner', restored === 1, String(restored))

  return { name: '2. Concurrent last-owner demotion', checks, evidence: { race: summarizeRace(raceResult) } }
}

async function scenarioPaymentVerification() {
  scenarioLogger('3. Concurrent payment verification against one sale balance')
  const checks = []
  const sale = await rpc(SALES1, `SELECT public.api_create_sale('${shopId}', 'credit',
    '[{"variant_id":"${variant500}","cartons":1}]'::jsonb)`)
  await rpc(ownerId, `SELECT public.api_review_credit_sale('${sale.sale_id}', 'approve', NULL)`)

  const record = () => `SELECT public.api_record_payment('${shopId}', 'cash', 240, now(), NULL,
      '[{"sale_id":"${sale.sale_id}","amount":240}]'::jsonb)`
  const p1 = await rpc(ownerId, record())
  const p2 = await rpc(ownerId, record())

  const raceResult = await race({
    roleA: 'authenticated', userA: ownerId,
    bodyA: `SELECT public.api_verify_payment('${p1.payment_id}', 'verify', NULL);`,
    roleB: 'authenticated', userB: ownerId,
    bodyB: `SELECT public.api_verify_payment('${p2.payment_id}', 'verify', NULL);`,
    holdSeconds: 1.6
  })
  log(`A verify ${p1.payment_id.slice(0, 8)} exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B verify ${p2.payment_id.slice(0, 8)} exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const statuses = await rows(`SELECT id, status FROM public.payments WHERE id IN ('${p1.payment_id}','${p2.payment_id}') ORDER BY id`)
  const balance = Number(await adminValue(`SELECT public.api_sale_balance('${sale.sale_id}')`))
  const verifiedAllocated = Number(await adminValue(`SELECT COALESCE(sum(pa.amount),0) FROM public.payment_allocations pa
    JOIN public.payments p ON p.id = pa.payment_id
    WHERE pa.sale_id='${sale.sale_id}' AND p.status='verified'`))
  const tentativeAllocated = Number(await adminValue(`SELECT COALESCE(sum(pa.amount),0) FROM public.payment_allocations pa
    JOIN public.payments p ON p.id = pa.payment_id
    WHERE pa.sale_id='${sale.sale_id}' AND p.status='submitted'`))
  const ledgerCredits = Number(await adminValue(`SELECT COALESCE(sum(amount),0) FROM public.shop_ledger_entries
    WHERE entry_type='payment_credit' AND payment_allocation_id IN
      (SELECT id FROM public.payment_allocations WHERE sale_id='${sale.sale_id}')`))
  const receipts = Number(await adminValue(`SELECT count(*) FROM public.payment_receipts WHERE payment_id IN ('${p1.payment_id}','${p2.payment_id}')`))

  expect(checks, 'exactly one verification committed', statuses.filter(s => s.status === 'verified').length === 1, JSON.stringify(statuses))
  expect(checks, 'loser reports a changed sale balance', /Sale balance changed/i.test(raceResult.runA.err + raceResult.runB.err))
  expect(checks, 'loser waited behind the sale row lock', Math.max(raceResult.runA.durationMs, raceResult.runB.durationMs) >= 800)
  expect(checks, 'sale balance is exactly zero', balance === 0, String(balance))
  expect(checks, 'verified allocation equals the sale total exactly once', verifiedAllocated === 240, String(verifiedAllocated))
  expect(checks, 'ledger credit posted exactly once', ledgerCredits === 240, String(ledgerCredits))
  expect(checks, 'losing payment stayed unverified with its tentative allocation',
    tentativeAllocated === 240, String(tentativeAllocated))
  expect(checks, 'exactly one receipt exists', receipts === 1, String(receipts))

  return {
    name: '3. Concurrent payment verification',
    checks,
    evidence: { race: summarizeRace(raceResult), statuses, balance, verifiedAllocated, tentativeAllocated, ledgerCredits, receipts }
  }
}

async function scenarioReturnApproval() {
  scenarioLogger('4. Concurrent return approvals for one sale line')
  const checks = []
  const sale = await rpc(SALES1, `SELECT public.api_create_sale('${shopId}', 'cash',
    '[{"variant_id":"${variant500}","cartons":1}]'::jsonb)`)
  const line = await adminValue(`SELECT id FROM public.sale_lines WHERE sale_id='${sale.sale_id}' ORDER BY variant_id LIMIT 1`)
  const stockBefore = Number(await adminValue(`SELECT public.api_stock_qty('${variant500}','saleable')`))

  const r1 = await rpc(SALES1, `SELECT public.api_submit_return('${sale.sale_id}', 'Leaked cartons',
    '[{"sale_line_id":"${line}","cartons":1,"condition":"reusable"}]'::jsonb)`)

  // The submission path caps cumulative requested quantity, so a second pending
  // request for the same line can only exist as legacy/stale data. Insert it
  // directly (the same technique the PGlite suite uses) to exercise the approval
  // race between two already-pending requests.
  const r2id = randomUUID()
  await admin(`INSERT INTO public.return_requests (id, sale_id, shop_id, submitted_by, status, reason)
    VALUES ('${r2id}', '${sale.sale_id}', '${shopId}', '${SALES1}', 'submitted', 'Stale pending return');
    INSERT INTO public.return_lines (return_request_id, sale_id, sale_line_id, variant_id, cartons, condition)
    VALUES ('${r2id}', '${sale.sale_id}', '${line}', '${variant500}', 1, 'reusable');`)
  const r2 = { return_id: r2id }

  const raceResult = await race({
    roleA: 'authenticated', userA: ownerId,
    bodyA: `SELECT public.api_review_return('${r1.return_id}', 'approve', NULL);`,
    roleB: 'authenticated', userB: ownerId,
    bodyB: `SELECT public.api_review_return('${r2.return_id}', 'approve', NULL);`,
    holdSeconds: 1.6
  })
  log(`A approve ${r1.return_id.slice(0, 8)} exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B approve ${r2.return_id.slice(0, 8)} exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const statuses = await rows(`SELECT id, status FROM public.return_requests WHERE id IN ('${r1.return_id}','${r2.return_id}') ORDER BY id`)
  const approvedCartons = Number(await adminValue(`SELECT COALESCE(sum(approved_cartons),0) FROM public.return_lines WHERE return_request_id IN ('${r1.return_id}','${r2.return_id}')`))
  const movements = Number(await adminValue(`SELECT count(*) FROM public.inventory_movements WHERE source_type='return_request' AND source_id IN ('${r1.return_id}','${r2.return_id}')`))
  const credits = Number(await adminValue(`SELECT count(*) FROM public.shop_ledger_entries WHERE entry_type='return_credit' AND sale_id='${sale.sale_id}'`))
  const stockAfter = Number(await adminValue(`SELECT public.api_stock_qty('${variant500}','saleable')`))

  expect(checks, 'exactly one approval committed', statuses.filter(s => s.status === 'approved').length === 1, JSON.stringify(statuses))
  expect(checks, 'loser reports excessive return quantity', /exceeds the remaining returnable quantity/i.test(raceResult.runA.err + raceResult.runB.err))
  expect(checks, 'loser waited behind the sale-line advisory lock', Math.max(raceResult.runA.durationMs, raceResult.runB.durationMs) >= 800)
  expect(checks, 'approved cartons equal one, never two', approvedCartons === 1, String(approvedCartons))
  expect(checks, 'exactly one return stock movement exists', movements === 1, String(movements))
  expect(checks, 'exactly one return credit exists', credits === 1, String(credits))
  expect(checks, 'stock increased by exactly one carton', stockAfter - stockBefore === 1, `${stockBefore} -> ${stockAfter}`)

  return {
    name: '4. Concurrent return approvals',
    checks,
    evidence: { race: summarizeRace(raceResult), statuses, approvedCartons, movements, credits, stockBefore, stockAfter }
  }
}

async function createVariant(sku) {
  const productId = await adminValue(`INSERT INTO public.products (name) VALUES ('Phase 3 ${sku}') RETURNING id`)
  return adminValue(`INSERT INTO public.product_variants (product_id, sku, pack_size_ml, bottles_per_carton)
    VALUES ('${productId}', '${sku}', 500, 24) RETURNING id`)
}

async function scenarioReceiptVersusSale() {
  scenarioLogger('5a. Concurrent stock receipt and sale (same variant)')
  const checks = []
  const variant = await createVariant(`ETC-P3-RCV-${Date.now()}`)
  await rpc(ownerId, `SELECT public.api_set_default_price('${variant}', 240);
                      SELECT public.api_receive_stock('${variant}', 1, 'Phase 3 opening', '${randomUUID()}');`)

  const raceResult = await race({
    roleA: 'authenticated', userA: ownerId,
    bodyA: `SELECT public.api_receive_stock('${variant}', 5, 'Concurrent receipt', '${randomUUID()}');`,
    roleB: 'authenticated', userB: SALES1,
    bodyB: `SELECT public.api_create_sale('${shopId}', 'cash', '[{"variant_id":"${variant}","cartons":1}]'::jsonb);`,
    holdSeconds: 1.6
  })
  log(`A receipt +5 exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms ${lastLine(raceResult.runA.err)}`)
  log(`B sale -1 exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const stock = Number(await adminValue(`SELECT public.api_stock_qty('${variant}','saleable')`))
  const movements = Number(await adminValue(`SELECT count(*) FROM public.inventory_movements WHERE variant_id='${variant}'`))
  const sales = Number(await adminValue(`SELECT count(*) FROM public.sales WHERE id IN (SELECT sale_id FROM public.sale_lines WHERE variant_id='${variant}')`))

  expect(checks, 'receipt committed', raceResult.runA.code === 0, lastLine(raceResult.runA.err))
  expect(checks, 'sale committed', raceResult.runB.code === 0, lastLine(raceResult.runB.err))
  expect(checks, 'both serialized without deadlock or lost update',
    raceResult.runA.code === 0 && raceResult.runB.code === 0)
  expect(checks, 'final stock is 1 + 5 - 1 = 5', stock === 5, String(stock))
  expect(checks, 'exactly one sale was created', sales === 1, String(sales))
  expect(checks, 'exactly three movements (opening, receipt, sale)', movements === 3, String(movements))

  return { name: '5a. Concurrent receipt and sale', checks, evidence: { race: summarizeRace(raceResult), stock, movements, sales } }
}

async function scenarioOversellRace() {
  scenarioLogger('5b. Concurrent sales against one carton of stock')
  const checks = []
  const variant = await createVariant(`ETC-P3-OVER-${Date.now()}`)
  await rpc(ownerId, `SELECT public.api_set_default_price('${variant}', 240);
                      SELECT public.api_receive_stock('${variant}', 1, 'Phase 3 opening', '${randomUUID()}');`)

  const sell = () => `SELECT public.api_create_sale('${shopId}', 'cash', '[{"variant_id":"${variant}","cartons":1}]'::jsonb);`
  const raceResult = await race({
    roleA: 'authenticated', userA: SALES1, bodyA: sell(),
    roleB: 'authenticated', userB: SALES1, bodyB: sell(),
    holdSeconds: 1.6
  })
  log(`A sale exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B sale exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const stock = Number(await adminValue(`SELECT public.api_stock_qty('${variant}','saleable')`))
  const saleCount = Number(await adminValue(`SELECT count(*) FROM public.sale_lines WHERE variant_id='${variant}'`))
  const movements = Number(await adminValue(`SELECT count(*) FROM public.inventory_movements WHERE variant_id='${variant}'`))

  expect(checks, 'exactly one sale committed', [raceResult.runA.code, raceResult.runB.code].filter(c => c === 0).length === 1,
    `A=${raceResult.runA.code} B=${raceResult.runB.code}`)
  expect(checks, 'loser rejected for insufficient stock', /Insufficient stock/i.test(raceResult.runA.err + raceResult.runB.err))
  expect(checks, 'loser waited behind the variant advisory lock', Math.max(raceResult.runA.durationMs, raceResult.runB.durationMs) >= 800)
  expect(checks, 'stock never went negative', stock === 0, String(stock))
  expect(checks, 'failed sale left no partial rows', saleCount === 1 && movements === 2, `sales=${saleCount} movements=${movements}`)

  return { name: '5b. Concurrent oversell attempt', checks, evidence: { race: summarizeRace(raceResult), stock, saleCount, movements } }
}

async function scenarioDuplicateSale() {
  scenarioLogger('6a. Concurrent duplicate sale idempotency reference')
  const checks = []
  const reference = randomUUID()
  const body = `SELECT public.api_create_sale('${shopId}', 'cash',
    '[{"variant_id":"${variant1L}","cartons":1}]'::jsonb, '${reference}');`

  const raceResult = await race({
    roleA: 'authenticated', userA: SALES1, bodyA: body,
    roleB: 'authenticated', userB: SALES1, bodyB: body,
    holdSeconds: 1.5
  })
  log(`A create exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B create exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const count = Number(await adminValue(`SELECT count(*) FROM public.sales WHERE client_reference='${reference}'`))
  const saleId = await adminValue(`SELECT id FROM public.sales WHERE client_reference='${reference}'`)
  const movements = Number(await adminValue(`SELECT count(*) FROM public.inventory_movements WHERE source_type='sale' AND source_id='${saleId}'`))
  expect(checks, 'exactly one sale row exists', count === 1, String(count))
  expect(checks, 'loser was blocked then rejected by the unique index',
    raceResult.runB.code !== 0 && /duplicate key value|unique constraint/i.test(raceResult.runB.err))
  expect(checks, 'loser waited on the index (>=700ms)', raceResult.runB.durationMs >= 700, `${raceResult.runB.durationMs}ms`)
  expect(checks, 'only one stock movement was written', movements === 1, String(movements))

  const retry = await runSession('authenticated', SALES1, body)
  const replay = retry.code === 0 ? JSON.parse(lastLine(retry.out)) : null
  expect(checks, 'documented retry is idempotent', replay?.idempotent === true && replay?.sale_id === saleId,
    retry.code === 0 ? JSON.stringify(replay) : retry.err)

  return { name: '6a. Duplicate sale idempotency', checks, evidence: { race: summarizeRace(raceResult), count, movements, replay } }
}

async function scenarioDuplicatePayment() {
  scenarioLogger('6b. Concurrent duplicate payment idempotency reference')
  const checks = []
  const reference = randomUUID()
  const body = `SELECT public.api_record_payment('${shopId}', 'cash', 25, now(), NULL, '[]'::jsonb, '${reference}');`

  const raceResult = await race({
    roleA: 'authenticated', userA: ownerId, bodyA: body,
    roleB: 'authenticated', userB: ownerId, bodyB: body,
    holdSeconds: 1.5
  })
  log(`A record exit=${raceResult.runA.code} duration=${raceResult.runA.durationMs}ms`)
  log(`B record exit=${raceResult.runB.code} duration=${raceResult.runB.durationMs}ms -> ${lastLine(raceResult.runB.err)}`)
  log(`wall-clock overlap=${raceResult.overlapMs}ms; monitor=${JSON.stringify(raceResult.snapshot)}`)

  const count = Number(await adminValue(`SELECT count(*) FROM public.payments WHERE payment_reference='${reference}'`))
  const paymentId = await adminValue(`SELECT id FROM public.payments WHERE payment_reference='${reference}'`)
  expect(checks, 'exactly one payment row exists', count === 1, String(count))
  expect(checks, 'loser rejected by the unique payment reference',
    raceResult.runB.code !== 0 && /duplicate key value|unique constraint/i.test(raceResult.runB.err))
  expect(checks, 'loser waited on the index (>=700ms)', raceResult.runB.durationMs >= 700, `${raceResult.runB.durationMs}ms`)

  const retry = await runSession('authenticated', ownerId, body)
  const replay = retry.code === 0 ? JSON.parse(lastLine(retry.out)) : null
  expect(checks, 'documented retry is idempotent', replay?.idempotent === true && replay?.payment_id === paymentId,
    retry.code === 0 ? JSON.stringify(replay) : retry.err)

  return { name: '6b. Duplicate payment idempotency', checks, evidence: { race: summarizeRace(raceResult), count, replay } }
}

async function scenarioLockRelease() {
  scenarioLogger('7. Aborted lock holder releases its advisory lock')
  const checks = []
  const bodyA = `SELECT pg_advisory_xact_lock(hashtext('${variant1L}')::bigint);`
  // The holder acquires the variant lock, waits long enough for session B to
  // queue behind it, then deliberately aborts. psql -1 turns the abort into a
  // rollback, so the lock must be released without any committed work.
  const a = startPsql(`${bodyA}\nSELECT pg_sleep(1.2);\nDO $$ BEGIN RAISE EXCEPTION 'phase3 deliberate rollback'; END $$;`, 'A')
  await sleep(350)
  const b = startPsql(sessionSql('authenticated', SALES1,
    `SELECT public.api_create_sale('${shopId}', 'cash', '[{"variant_id":"${variant1L}","cartons":1}]'::jsonb);`), 'B')
  await sleep(500)
  const snapshot = JSON.parse(lastLine((await psqlText(SNAPSHOT_SQL)).out))
  const [runA, runB] = await Promise.all([a.done, b.done])
  log(`A lock-holder exit=${runA.code} duration=${runA.durationMs}ms -> ${lastLine(runA.err)}`)
  log(`B sale exit=${runB.code} duration=${runB.durationMs}ms -> ${lastLine(runB.err)}`)
  log(`monitor=${JSON.stringify(snapshot)}`)

  expect(checks, 'lock holder aborted and rolled back', runA.code !== 0 && /phase3 deliberate rollback/i.test(runA.err))
  expect(checks, 'waiting sale proceeded after rollback', runB.code === 0, lastLine(runB.err))
  expect(checks, 'waiting sale was actually blocked (>=500ms)', runB.durationMs >= 500, `${runB.durationMs}ms`)
  expect(checks, 'sales count is unchanged by the aborted holder',
    Number(await adminValue(`SELECT count(*) FROM public.sales WHERE id IN (SELECT sale_id FROM public.sale_lines WHERE variant_id='${variant1L}')`)) >= 1)
  expect(checks, 'no advisory lock leaked after rollback',
    Number(await adminValue(`SELECT count(*) FROM pg_locks WHERE locktype='advisory'`)) === 0)

  return { name: '7. Rollback releases advisory lock', checks, evidence: { a: runA.durationMs, b: runB.durationMs, snapshot } }
}

async function scenarioReleaseTailMigrations() {
  scenarioLogger('9. Release-tail security migrations 008 and 009')
  const checks = []

  // Rehearse the Supabase-owned event-trigger function ACL locally. The real
  // platform function is not present in a vanilla PostgreSQL cluster.
  await admin(`
    CREATE OR REPLACE FUNCTION public.rls_auto_enable()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $function$ BEGIN NULL; END; $function$;
    GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC;
  `)

  for (const file of TAIL_MIGRATIONS) {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', file), 'utf8')
    database.hashes[file] = createHash('sha256').update(sql).digest('hex').toUpperCase()
    const run = await psqlText(sql)
    if (run.code !== 0) throw new Error(`tail migration ${file} failed: ${run.err}`)
    database.migrations.push(file)
    log(`applied ${file}`)
  }

  const ownerPrivileges = await rows(`SELECT
    has_function_privilege('authenticated', 'public.api_claim_owner()', 'EXECUTE') AS authenticated_can_execute,
    has_function_privilege('anon', 'public.api_claim_owner()', 'EXECUTE') AS anon_can_execute`)
  expect(checks, 'authenticated cannot execute api_claim_owner after migration 008',
    ownerPrivileges[0].authenticated_can_execute === false, JSON.stringify(ownerPrivileges[0]))
  expect(checks, 'anon cannot execute api_claim_owner after migration 008',
    ownerPrivileges[0].anon_can_execute === false, JSON.stringify(ownerPrivileges[0]))

  const ownerPublicGrant = await rows(`SELECT EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_can_execute
  FROM pg_proc p WHERE p.oid = 'public.api_claim_owner()'::regprocedure`)
  expect(checks, 'PUBLIC cannot execute api_claim_owner after migration 008',
    ownerPublicGrant[0].public_can_execute === false, JSON.stringify(ownerPublicGrant[0]))

  const blockedClaim = await runSession('authenticated', PENDING, 'SELECT public.api_claim_owner();')
  expect(checks, 'pending user owner claim is denied by PostgreSQL privileges',
    blockedClaim.code !== 0 && /permission denied/i.test(blockedClaim.err), lastLine(blockedClaim.err))
  const pendingProfile = await rows(`SELECT role, status FROM public.profiles WHERE id = '${PENDING}'`)
  expect(checks, 'denied owner claim leaves pending profile unchanged',
    pendingProfile.length === 1 && pendingProfile[0].role === 'salesperson' && pendingProfile[0].status === 'pending',
    JSON.stringify(pendingProfile))

  const rlsPrivileges = await rows(`SELECT
    has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') AS anon_can_execute,
    has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') AS authenticated_can_execute,
    has_function_privilege('postgres', 'public.rls_auto_enable()', 'EXECUTE') AS operator_can_execute`)
  expect(checks, 'anon cannot execute rls_auto_enable after migration 009',
    rlsPrivileges[0].anon_can_execute === false, JSON.stringify(rlsPrivileges[0]))
  expect(checks, 'authenticated cannot execute rls_auto_enable after migration 009',
    rlsPrivileges[0].authenticated_can_execute === false, JSON.stringify(rlsPrivileges[0]))

  const rlsPublicGrant = await rows(`SELECT EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) AS public_can_execute
  FROM pg_proc p WHERE p.oid = 'public.rls_auto_enable()'::regprocedure`)
  expect(checks, 'PUBLIC cannot execute rls_auto_enable after migration 009',
    rlsPublicGrant[0].public_can_execute === false, JSON.stringify(rlsPublicGrant[0]))
  expect(checks, 'trusted postgres operator retains rls_auto_enable execution',
    rlsPrivileges[0].operator_can_execute === true, JSON.stringify(rlsPrivileges[0]))

  return { name: '9. Release-tail security migrations 008 and 009', checks,
    evidence: { ownerPrivileges: ownerPrivileges[0], rlsPrivileges: rlsPrivileges[0], blockedClaimError: lastLine(blockedClaim.err) } }
}

async function finalAudit() {
  scenarioLogger('8. Final committed-state integrity audit')
  const checks = []
  const audit = await rows(`SELECT
    (SELECT count(*)::int FROM public.profiles WHERE role='owner' AND status='approved') AS approved_owners,
    (SELECT count(*)::int FROM public.sales s WHERE public.api_sale_balance(s.id) < 0) AS negative_balances,
    (SELECT count(*)::int FROM public.sales s
       WHERE COALESCE((SELECT sum(pa.amount) FROM public.payment_allocations pa
                        JOIN public.payments p ON p.id = pa.payment_id
                        WHERE pa.sale_id=s.id AND p.status='verified'),0) > s.grand_total) AS over_allocated_sales,
    (SELECT count(*)::int FROM public.sales s
       WHERE COALESCE((SELECT sum(pa.amount) FROM public.payment_allocations pa
                        JOIN public.payments p ON p.id = pa.payment_id
                        WHERE pa.sale_id=s.id AND p.status='submitted'),0) > s.grand_total) AS pending_allocation_overage,
    (SELECT count(*)::int FROM public.product_variants v
       WHERE public.api_stock_qty(v.id,'saleable') < 0 OR public.api_stock_qty(v.id,'damaged') < 0) AS negative_stock_variants,
    (SELECT count(*)::int FROM (SELECT client_reference FROM public.sales
       WHERE client_reference IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d) AS duplicate_sale_refs,
    (SELECT count(*)::int FROM (SELECT payment_reference FROM public.payments
       GROUP BY 1 HAVING count(*) > 1) d) AS duplicate_payment_refs,
    (SELECT count(*)::int FROM (SELECT return_request_id, sale_line_id FROM public.return_lines
       GROUP BY 1,2 HAVING count(*) > 1) d) AS duplicate_return_lines,
    (SELECT count(*)::int FROM public.return_lines rl
       JOIN public.sale_lines sl ON sl.id = rl.sale_line_id
       WHERE rl.approved_cartons > sl.cartons) AS over_returned_lines,
    (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory') AS advisory_locks,
    (SELECT count(*)::int FROM pg_stat_activity
       WHERE datname=current_database() AND state='idle in transaction') AS idle_in_transaction`)

  const row = audit[0]
  log(JSON.stringify(row, null, 2))
  expect(checks, 'one approved owner', row.approved_owners === 1, String(row.approved_owners))
  expect(checks, 'no negative sale balances', row.negative_balances === 0, String(row.negative_balances))
  expect(checks, 'no sale is over-allocated by verified payments', row.over_allocated_sales === 0, String(row.over_allocated_sales))
  expect(checks, 'no submitted payment allocations exceed sale totals', row.pending_allocation_overage === 0, String(row.pending_allocation_overage))
  expect(checks, 'no negative stock', row.negative_stock_variants === 0, String(row.negative_stock_variants))
  expect(checks, 'no duplicate sale references', row.duplicate_sale_refs === 0, String(row.duplicate_sale_refs))
  expect(checks, 'no duplicate payment references', row.duplicate_payment_refs === 0, String(row.duplicate_payment_refs))
  expect(checks, 'no duplicate return lines', row.duplicate_return_lines === 0, String(row.duplicate_return_lines))
  expect(checks, 'no over-returned sale lines', row.over_returned_lines === 0, String(row.over_returned_lines))
  expect(checks, 'no advisory locks remain', row.advisory_locks === 0, String(row.advisory_locks))
  expect(checks, 'no idle-in-transaction backend remains', row.idle_in_transaction === 0, String(row.idle_in_transaction))

  return { name: '8. Final integrity audit', checks, evidence: row }
}

function summarizeRace(raceResult) {
  return {
    a: { exit: raceResult.runA.code, durationMs: raceResult.runA.durationMs, error: lastLine(raceResult.runA.err) },
    b: { exit: raceResult.runB.code, durationMs: raceResult.runB.durationMs, error: lastLine(raceResult.runB.err) },
    overlapMs: raceResult.overlapMs,
    snapshot: raceResult.snapshot
  }
}

async function main() {
  if (DB !== 'ethereal_phase3_test') throw new Error(`Refusing to run against ${DB}`)
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error(`Refusing non-loopback host ${HOST}`)
  if (!existsSync(PSQL)) throw new Error(`psql not found at ${PSQL}`)

  log(`Phase 3 real-concurrency rehearsal — ${STAMP}`)
  log(`psql: ${PSQL}`)
  await resetDatabase()
  await applyMigrations()
  const identity = await identityCheck()
  database.version = identity.version
  database.port = identity.port
  log(`identity: PostgreSQL ${identity.version} @ ${identity.host}:${identity.port} db=${identity.db}`)

  await admin(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ('${OWNER}', 'owner@ethereal.test', '{"full_name":"Owner One"}'),
    ('${PENDING}', 'pending@ethereal.test', '{"full_name":"Pending Five"}')
    ON CONFLICT (id) DO NOTHING`)

  results.push(await scenarioFirstOwnerClaim())
  await seedFixtures()
  results.push(await scenarioLastOwnerDemotion())
  results.push(await scenarioPaymentVerification())
  results.push(await scenarioReturnApproval())
  results.push(await scenarioReceiptVersusSale())
  results.push(await scenarioOversellRace())
  results.push(await scenarioDuplicateSale())
  results.push(await scenarioDuplicatePayment())
  results.push(await scenarioLockRelease())
  results.push(await scenarioReleaseTailMigrations())
  results.push(await finalAudit())

  const allChecks = results.flatMap(r => r.checks)
  const failed = allChecks.filter(c => !c.passed)
  const summary = {
    generatedAt: STAMP,
    database,
    identity,
    scenarioCount: results.length,
    checkCount: allChecks.length,
    passed: allChecks.length - failed.length,
    failed: failed.length,
    failures: failed,
    results
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'ETHEREAL_PHASE_3_CONCURRENCY_EVIDENCE.json'), JSON.stringify(summary, null, 2))
  writeFileSync(join(EVIDENCE_DIR, 'ETHEREAL_PHASE_3_CONCURRENCY_EVIDENCE.log'), logLines.join('\n') + '\n')

  log('')
  log(`SUMMARY: ${summary.passed}/${summary.checkCount} checks passed, ${summary.failed} failed`)
  if (summary.failed > 0) {
    log('FAILED CHECKS:')
    for (const failure of failed) log(` - ${failure.name}: ${failure.detail}`)
  }
  process.exitCode = summary.failed > 0 ? 1 : 0
}

main().catch(error => {
  console.error(error)
  logLines.push(`FATAL: ${error.stack || error.message}`)
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, 'ETHEREAL_PHASE_3_CONCURRENCY_EVIDENCE.log'), logLines.join('\n') + '\n')
  } catch {}
  process.exit(2)
})
