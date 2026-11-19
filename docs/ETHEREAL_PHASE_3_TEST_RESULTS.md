# Ethereal Co. — Phase 3 Test Results

**Date:** 18 November 2026
**Branch:** `implementation/finish-mvp` (working tree dirty, nothing committed)
**Scope:** Local-only concurrency rehearsal of the seven release migrations against a
disposable PostgreSQL 17 database. **No Supabase project, staging or production
system was contacted. No credential file was read. No remote SQL was executed.**
**Harness:** `scripts/pg-concurrency-rehearsal.mjs`
**Raw evidence:** `reports/ETHEREAL_PHASE_3_CONCURRENCY_EVIDENCE.json` and
`reports/ETHEREAL_PHASE_3_CONCURRENCY_EVIDENCE.log`

---

## 1. Verdict

| Item | Result |
|------|--------|
| Real multi-connection concurrency scenarios | **10 / 10 passed** |
| Individual assertions | **62 / 62 passed, 0 failed**, in three consecutive full runs |
| Final committed-state integrity audit | **passed** (no negative stock, no negative balance, no over-allocation by verified payments, no duplicates, no leaked locks) |
| Existing automated suites | **45 / 45 passed** |
| Lint | **0 errors** (pre-existing warnings only, none from Phase 3) |
| Production build | **passed** (`vite build`, 6.87 s) |
| **Recommendation** | **GO — local evidence is sufficient to request owner approval for a staging migration.** Not a production GO on its own; see §10 for the conditions that remain. |

No product defect was found in the seven migrations. Two harness-side defects and
one over-broad audit assertion were found **in the test tooling** and fixed before
the recorded runs; they are documented in §8 so the evidence is not overstated.

---

## 2. Environment and safety guardrails

### 2.1 PostgreSQL instance

The installed PostgreSQL 17 service (`postgresql-x64-17`, port 5432) requires a
`scram-sha-256` password for every connection, and that password is not available
to this session. It was **not** requested, guessed, or bypassed, and the service
was not reconfigured. Instead a disposable cluster was initialised from the same
PostgreSQL 17.5 binaries:

| Property | Value |
|----------|-------|
| Server version | `PostgreSQL 17.5 on x86_64-windows, compiled by msvc-19.44.35209, 64-bit` |
| Data directory | `%LOCALAPPDATA%\Temp\opencode\phase3\data` (outside the repository) |
| Listener | `127.0.0.1:55432` only (`listen_addresses = '127.0.0.1'`) |
| Authentication | `trust` (loopback-only, disposable, no credentials involved) |
| Database | `ethereal_phase3_test` (the **only** database created there) |
| Max connections | 60 |

The database is dropped and recreated from scratch at the start of every run, so
all recorded results come from a clean apply of the release set.

### 2.2 Identity assertions performed on every run

The harness aborts before seeding if any of these differ:

- `current_setting('server_version')` must start with `17.` → observed `17.5`
- `current_database()` must be exactly `ethereal_phase3_test`
- `host(inet_server_addr())` must be loopback → observed `127.0.0.1`
- `inet_server_port()` → observed `55432` (the isolated cluster, not 5432)
- `PGHOST` / `PGDATABASE` may only point at `127.0.0.1` / `ethereal_phase3_test`

Additional checks performed before starting work:

- No `SUPABASE_*` or `PG*` environment variables are configured in this shell.
- `src/lib/supabase.js` was not executed, and no network client was used — every
  database call in this phase is a local `psql` process.
- `.env`, `.env.local` and `.env.staging.local` were never read.
- `supabase/migrations/` was read-only for this phase.

### 2.3 Release set actually exercised

Applied in filename order, each file in a single transaction:

| Order | File | SHA-256 (matches the Phase 2 release plan) |
|-------|------|--------------------------------------------|
| 1 | `20261118000100_business_schema.sql` | `4AA1BB4A5BCB723D67DE0D2B633D5D0CDA1BB835368E105E48E418BF8F3B50FB` |
| 2 | `20261118000200_business_core_rpcs.sql` | `2F23D236278C120F3172FA6442FB390874AC1BC144E3948001D6BB910BAE9FF5` |
| 3 | `20261118000300_business_sales_rpcs.sql` | `A9C619F438A06423CDC9182EFCD329EC98EBE242D836D8428D23DF389F386CCA` |
| 4 | `20261118000400_business_payment_rpcs.sql` | `89401F07102D1A08ABB80C27A8FBB4F05CD29EAE1A3DAB52578D7E1424A05144` |
| 5 | `20261118000500_business_inventory_return_expense_rpcs.sql` | `F438A12D4E732053B0ADAF19B2BB9E64AF8DB5E974020673456BC0954CD86626` |
| 6 | `20261118000600_business_dashboard_team_rpcs.sql` | `05022AF79B4CD7B3D517DA848C2B29294B5FDC50AAAE9FCEBDF5E7A1DC7E6051` |
| 7 | `20261118000700_business_security_integrity_remediation.sql` | `16D30D467602C9CB909511424DC0330065F920EE6B9DA4D269BEB13F12A3ABC6` |

Post-apply structural verification: `api_stock_qty(uuid,text)` returns `bigint`;
`return_lines_request_line_unique` exists; the `auth.users` trigger
`on_auth_user_created` has `tgtype = 5` and points at
`api_handle_new_auth_user()`; 53 `api_*` functions are present.

A minimal Supabase-compatible bootstrap (`auth` schema, `auth.users`, `auth.uid()`,
`anon` / `authenticated` roles) was applied first because the release migrations
assume Supabase supplies those objects. The bootstrap is test scaffolding stored in
`%LOCALAPPDATA%\Temp\opencode\phase3\00_bootstrap.sql`; it is **not** part of the
release set and was not added to `supabase/migrations/`.

---

## 3. How concurrency was made real

Sequential replay cannot prove locking behaviour, so every race uses **separate OS
processes, i.e. separate PostgreSQL backends**:

1. Session A starts `psql`, runs its RPC, then executes `pg_sleep(...)` **inside the
   same open transaction** so its locks are held while it stays alive.
2. After a short delay, session B starts a second `psql` process and attempts the
   conflicting operation.
3. Mid-race the harness opens a third connection and snapshots `pg_stat_activity`
   plus `pg_locks` (`wait_event_type`, `wait_event`, `pg_blocking_pids(pid)`).
4. Both sessions are awaited and their exit codes, wall-clock durations, and
   `overlapMs` (`min(endA,endB) - max(startA,startB)`) are recorded.
5. Only after A has committed (or aborted) does the harness read the committed
   state through a fresh admin connection.

Because of step 3, each scenario records a live blocking chain rather than just an
"it failed/succeeded" assertion. Example from the recorded run:

```json
{"advisory_locks":2,"lock_waiters":1,"sessions":[
  {"state":"active","wait":"Timeout/PgSleep","blocked_by":[],
   "query":"SELECT pg_sleep(1.6);"},
  {"state":"active","wait":"Lock/advisory","blocked_by":[29160],
   "query":"SELECT public.api_claim_owner();"}]}
```

Wall-clock `overlapMs` was between **1,229 ms and 1,540 ms** for every raced pair,
i.e. the two conflicting transactions were genuinely concurrent, not sequential.

Implementation notes that matter for reproducibility:

- SQL is fed to `psql` over **stdin**, because the migration files exceed the Windows
  command-line length limit (`spawn ENAMETOOLONG`).
- Sessions run under `psql -1` (single-transaction script mode). An explicit trailing
  `COMMIT;` written to stdin was observed to report success while the rows were
  rolled back, so it is not used anywhere in the harness.
- Actor identity is set per session with `SET LOCAL ROLE authenticated` plus
  `set_config('request.jwt.claim.sub', <uuid>, true)`, which mirrors what PostgREST
  does for a signed-in request.

---

## 4. Results matrix

| # | Scenario | Sessions | Concurrency evidence | Result |
|---|----------|----------|----------------------|--------|
| 1 | Concurrent first-owner claims | 2 + monitor | B blocked on `Lock/advisory` for 1,446 ms | 6/6 pass |
| 2 | Concurrent last-owner demotion | 2 + monitor | B blocked on `Lock/advisory` for 1,313 ms | 6/6 pass |
| 3 | Concurrent payment verification vs one sale balance | 2 + monitor | B blocked on `Lock/transactionid` for 1,379 ms | 8/8 pass |
| 4 | Concurrent return approvals for one sale line | 2 + monitor | B blocked on `Lock/advisory` for 1,364 ms | 7/7 pass |
| 5a | Concurrent stock receipt and sale | 2 + monitor | Both committed; B queued on the variant lock | 6/6 pass |
| 5b | Concurrent sales against one carton | 2 + monitor | B blocked, then rejected for insufficient stock | 5/5 pass |
| 6a | Duplicate sale idempotency reference | 2 + monitor | B blocked on `Lock/transactionid` (unique index) | 5/5 pass |
| 6b | Duplicate payment idempotency reference | 2 + monitor | B blocked on `Lock/transactionid` (unique index) | 4/4 pass |
| 7 | Aborted lock holder releases its advisory lock | 2 + monitor | B blocked for 1,062 ms, then completed | 5/5 pass |
| 8 | Final committed-state integrity audit | 1 admin | full-database audit | 10/10 pass |

Totals: **62 assertions, 62 passed, 0 failed** — identical across three consecutive
full runs on 18 November 2026 (each run recreates the database from scratch).

---

## 5. Scenario detail

### 5.1 Concurrent first-owner claims

**Race.** `owner@ethereal.test` and `pending@ethereal.test` both call
`api_claim_owner()`; A holds its transaction open.

**Observed.** A exit 0 (1,849 ms). B exit 3 with `An owner account already exists`,
after waiting 1,446 ms on the membership advisory lock. Monitor snapshot shows B
`Lock/advisory` blocked by A.

**Committed state.** Exactly one profile with `role='owner' AND status='approved'`;
no second owner row; the losing caller stays `salesperson/pending`.
**Checks:** 6/6 pass.

### 5.2 Concurrent last-owner demotion

**Race.** With two approved owners, A demotes owner-1 and B demotes owner-2 at the
same time.

**Observed.** Exactly one demotion committed (A exit 0, B exit 3). The loser was
rejected by the last-owner guard after queueing 1,313 ms on
`hashtext('ethereal.owner_membership')`.

**Committed state.** One approved owner remains. State was then restored to a known
owner/admin pair for later scenarios.
**Checks:** 6/6 pass.

### 5.3 Concurrent payment verification against one sale balance

**Setup.** A credit sale of one carton (₹240) is approved, then **two** submitted
payments of ₹240 each, both explicitly allocated to that sale, exist at verification
time.

**Race.** A verifies payment 1 while B verifies payment 2.

**Observed.** One verification committed (A exit 0). B waited 1,379 ms on the sale
row lock, then failed with `Sale balance changed; allocation exceeds the current
outstanding amount…` — the deterministic sale-id lock order plus post-lock balance
re-check prevents double settlement.

**Committed state.** `api_sale_balance(sale) = 0`; verified allocation total = ₹240;
exactly one `payment_credit` ledger row of ₹240; exactly one receipt. The losing
payment remains `submitted` with its tentative ₹240 allocation (see §9.2).
**Checks:** 8/8 pass.

### 5.4 Concurrent return approvals for one sale line

**Setup.** One carton is sold, one return request for that carton is submitted
through `api_submit_return`. Because the submission path caps *cumulative requested
quantity* (a fix from Phase 2), a second pending request for the same line cannot be
created through the API — so the harness inserts a stale second pending request
directly, exactly as legacy/duplicated data would look.

**Race.** A approves request 1 while B approves request 2.

**Observed.** One approval committed (A exit 0). B waited 1,364 ms on the shared
sale-line advisory lock, then failed with `Return exceeds the remaining returnable
quantity…`.

**Committed state.** `approved_cartons = 1` (never 2), exactly one
`return_request` inventory movement, exactly one `return_credit` ledger row, and
saleable stock for the variant moved 98 → 99 (+1 only).
**Checks:** 7/7 pass.

### 5.5 Concurrent stock receipt and sale

**Setup.** A fresh product variant with one carton on hand.

**Race.** A receives +5 cartons while B sells −1 carton of the same variant.

**Observed.** Both committed (A exit 0 at 1,745 ms, B exit 0 at 1,405 ms) with no
deadlock and no lost update; B queued on the variant advisory lock, then read stock
after A's commit.

**Committed state.** Stock = 1 + 5 − 1 = **5**; exactly one sale; exactly three
inventory movements (opening, receipt, sale).
**Checks:** 6/6 pass.

### 5.6 Concurrent oversell attempt

**Setup.** A fresh variant with exactly one carton on hand.

**Race.** Two sessions sell one carton each.

**Observed.** Exactly one sale committed; the loser waited 1,553 ms on the variant
lock and then failed with `Insufficient stock`.

**Committed state.** Stock = 0 (never negative); the failed transaction left no
partial `sale`, `sale_line` or `inventory_movements` rows (2 movements total:
opening + the one successful sale).
**Checks:** 5/5 pass.

### 5.7 Duplicate idempotency requests

**5.7.a Sale.** Two concurrent `api_create_sale` calls with the same
`p_client_reference`. One committed; the other blocked on the unique index for
1,313 ms and failed with `duplicate key value violates unique constraint`. One sale
row, one stock movement. A later sequential retry with the same reference returned
`{"idempotent": true, "sale_id": "…", "status": "confirmed"}` — the documented replay
path works once the first transaction has committed.
**Checks:** 5/5 pass.

**5.7.b Payment.** Same pattern for `api_record_payment` with the same
`p_client_reference`: loser blocked 1,229 ms and failed on the unique payment
reference; one payment row; the subsequent retry returned
`{"idempotent": true, "payment_id": "…", "status": "submitted"}`.
**Checks:** 4/4 pass.

### 5.8 Rollback behaviour and lock release

**Race.** A acquires the variant advisory lock, sleeps 1.2 s, then raises
`phase3 deliberate rollback`, so `psql -1` rolls the whole session back while B waits
to sell that variant.

**Observed.** A exited 3 with the injected error. B was blocked for 1,062 ms, then
committed its sale normally. No sale rows came from A's aborted transaction, and
`pg_locks` shows **zero** advisory locks afterwards.

**Interpretation.** Locks (advisory and row-level) are released on abort; a crashed
or rejected transaction cannot strand inventory forever.
**Checks:** 5/5 pass.

---

## 6. Final committed-state integrity audit

Run on a fresh admin connection after all scenarios:

| Assertion | Observed |
|-----------|----------|
| Approved owners | 1 |
| Sales with negative balance | 0 |
| Sales over-allocated by **verified** payments | 0 |
| Sales over-allocated by **submitted** payments (informational) | 0 |
| Variants with negative saleable/damaged stock | 0 |
| Duplicate sale `client_reference` | 0 |
| Duplicate payment `payment_reference` | 0 |
| Duplicate `return_lines` per (request, sale line) | 0 |
| Sale lines returned beyond their sold quantity | 0 |
| Advisory locks left behind | 0 |
| Backends left `idle in transaction` | 0 |

The audit's over-allocation test deliberately matches the product's own
`api_sale_balance()` definition, which counts only allocations belonging to
`verified` payments. That definition is the right integrity boundary (see §9.2).

---

## 7. Automated suites, lint and build

| Command | Result |
|---------|--------|
| `npm test` | **45 / 45 pass, 0 fail** (`node --test`, 6.80 s): backend, SQL integration, remediation, RPC contract, integration status, backend mode |
| `npm run lint` | **exit 0**, 0 errors; warnings are pre-existing `react-hooks`/`react-compiler` advisories in `src/App.jsx`, `src/pages/*`, `src/App-backup.jsx` and are unrelated to Phase 3 |
| `npm run build` | **pass** — `vite build` completed in 6.87 s; only the existing chunk-size advisory |
| `node scripts/pg-concurrency-rehearsal.mjs` | **62 / 62 checks pass** (three consecutive runs) |

The new harness is the only source file added by this phase. It is not wired into
`npm test` because it requires a live PostgreSQL 17 server and creates/drops
`ethereal_phase3_test`; running it implicitly in CI would be destructive.

Reproduction:

```powershell
# 1. start the disposable cluster (loopback only, port 55432)
& 'C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe' `
  -D "$env:LOCALAPPDATA\Temp\opencode\phase3\data" `
  -l "$env:LOCALAPPDATA\Temp\opencode\phase3\server.log" start

# 2. run the rehearsal (drops and recreates only ethereal_phase3_test)
node scripts/pg-concurrency-rehearsal.mjs
```

The harness refuses to run if the target database is not exactly
`ethereal_phase3_test` or if the server is not on loopback.

---

## 8. Issues encountered (all in the test tooling, none in the migrations)

These are recorded so that the evidence trail is honest; each was diagnosed to root
cause before the recorded runs.

1. **`spawn ENAMETOOLONG`** when passing migration SQL through `psql -c`. Windows
   command-line length limit. Fixed by feeding SQL on stdin.
2. **Silent rollback with an explicit trailing `COMMIT;`** on stdin: `psql` reported
   success and printed the RPC result, but no rows persisted. Diagnosed as
   client/`psql` behaviour, not a database fault (the same statements commit when
   wrapped). Fixed by running every session and migration under `psql -1`.
3. **Over-broad audit assertion** in the first harness run: it counted *all*
   allocations (including those belonging to still-`submitted` payments) and flagged
   a sale as over-allocated. This matches neither the product's balance function nor
   the intended model. Fixed by asserting on verified allocations and recording
   tentative allocations as separate informational evidence.
4. **Return-approval setup** initially tried to create two pending requests for one
   sale line through the API. The Phase 2 cumulative-quantity cap correctly rejected
   it, so the second stale request is now injected directly to test the *approval*
   race rather than the *submission* cap.
5. **Environment hiccup:** one early run aborted with `connection refused` because the
   disposable cluster process had died when its launching shell was terminated. The
   cluster was restarted; because the database is recreated per run, no recorded
   result depends on that aborted attempt.

No migration file was modified to make a test pass. The seven SHA-256 hashes above
are identical to the Phase 2 release plan, which is the evidence that the exercised
SQL is the reviewed SQL.

---

## 9. Residual risks and coverage gaps

### 9.1 Not covered by this phase

- **Supabase transport layer.** Everything ran over direct `psql`. PostgREST,
  the Supabase pooler (PgBouncer in transaction mode), JWT claim propagation and
  HTTP-level retries were not exercised.
- **RLS as a browser.** The harness switches role locally; it does not prove that
  `anon` or a real JWT can never reach a table, only that the RPC grants behave.
- **Scale.** Two concurrent writers per scenario on a single Windows host. No test at
  dozens of concurrent sessions, no connection-pool saturation, no network latency
  or partition, no statement/lock timeouts.
- **Crash recovery.** Rollback of an in-flight transaction was tested (§5.8); a
  postmaster crash with WAL replay was not.
- **Advisory-lock hash collisions.** Keys are `hashtext(<uuid>)::bigint` (32-bit
  space). A collision serializes two unrelated variants — a performance effect, never
  a correctness one — and cannot be excluded by construction.
- **Clock/timezone edges.** `Asia/Kolkata` business-date boundaries and midnight
  rollovers during verification were not targeted.
- **UI behaviour under contention.** No browser test of what a salesperson sees while
  another session holds the lock (spinner, double-submit, retry messaging).

### 9.2 Behaviour worth knowing (accepting, not blocking)

- A payment that **loses** the verification race stays `submitted` with its
  tentative allocation recorded, and must be explicitly rejected or re-recorded.
  Verified-basis balances stay correct (`api_sale_balance()` ignores unverified
  allocations), but the operator sees a stale pending payment. This is a UX/operations
  concern for the payments screen, not a data-integrity defect.
- Concurrent duplicates of the same `p_client_reference` produce a raw
  `23505 duplicate key` error for the loser, not an idempotent success. Only
  retries issued *after* the first transaction commits take the documented replay
  path. Any future HTTP wrapper for double-clicks should translate `23505` into a
  retry-or-refresh message.
- Every write RPC serializes on the variant advisory lock, so throughput per product
  variant is effectively single-writer. Correct by design, but relevant to sizing.

### 9.3 Pre-existing lint warnings

`npm run lint` exits 0 with warnings in components that Phase 3 did not touch. They
are out of scope here and were not "fixed" opportunistically.

---

## 10. GO / NO-GO

**GO (with conditions) for the next step: owner-approved migration of staging.**

Basis:

- All six required race categories were executed with genuinely overlapping
  transactions on separate backends, with live lock-wait evidence.
- Final committed state is consistent across every scenario and passes a whole-
  database audit.
- Rollback releases locks; duplicate requests cannot create duplicate rows; stock can
  never go negative; money can never be allocated twice; the last owner cannot be
  removed and a second owner cannot be claimed.
- The exercised SQL is byte-identical to the reviewed Phase 2 release set.
- Existing automated suites, lint and the production build all pass.

Conditions before staging (all require explicit owner approval):

1. Apply the seven migrations to **staging** only, using the preflight/ordering/rollback
   procedure in `docs/ETHEREAL_PHASE_2_RELEASE_MIGRATION_PLAN.md`.
2. Re-run an equivalent smoke sequence through the real Supabase API (not `psql`) so
   PostgREST, JWT claims and the pooler are covered.
3. Confirm the payments UI surfaces pending payments that lost a verification race,
   and that double-submits map `23505` to a retry message.
4. Only after staging passes, schedule production.

**NO-GO for production today**, for the single reason that no staging validation has
happened yet. Nothing in this rehearsal argues against the migrations themselves.

**Explicitly not done:** no remote database was contacted, no migration was pushed, no
commit or push was made, and nothing in `supabase/migrations/` or existing reports was
modified. Work stops here pending owner approval.


---

## 11. Release-tail rehearsal update — 19 November 2026

The earlier evidence above is specifically for migrations **001–007**. It must not be
misrepresented as a rehearsal of the current nine-file release candidate.

The PostgreSQL 17 harness has now been extended in
`scripts/pg-concurrency-rehearsal.mjs` to apply migrations 008 and 009 **after** the
existing business concurrency scenarios, then assert:

- `authenticated` and `anon` cannot execute `api_claim_owner()` after migration 008.
- A pending authenticated user receives a PostgreSQL permission-denied result when
  attempting the owner-claim RPC, and their profile remains `salesperson/pending`.
- `anon` and `authenticated` cannot execute `public.rls_auto_enable()` after
  migration 009.
- The trusted `postgres` role retains execute permission on the event-trigger
  function.
- Both tail migration files are included in the generated evidence hashes and
  migration list.

For the isolated local rehearsal only, the harness creates a minimal stand-in
`public.rls_auto_enable()` event-trigger function and grants it to PUBLIC before
applying migration 009. This tests the ACL change, not Supabase's actual platform
event-trigger installation or its runtime behavior.

**Execution status: NOT YET RUN.** The historical 62/62 result remains valid only
for the earlier seven-migration run. No 009/008 real-PostgreSQL result is claimed
until the updated harness has been executed successfully on the isolated
PostgreSQL 17 cluster.

The standard CI workflow does not run this harness because it intentionally drops
and recreates the dedicated local database `ethereal_phase3_test`. CI's green
result is not a substitute for this rehearsal.

**Current decision remains HOLD / NO-GO for staging writes.** The nine-file set
still needs the updated real-PostgreSQL rehearsal, independent security review,
Supabase Auth/PostgREST/RLS verification, and backup/restore rehearsal. No remote
database was changed by this update.
