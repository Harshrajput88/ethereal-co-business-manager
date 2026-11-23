# Ethereal Co. — Phase 2 Security & Integrity Remediation Summary

**Date:** 18 November 2026
**Branch:** `implementation/finish-mvp`
**Scope:** Local code/SQL remediation only. No Supabase project was contacted. No
remote SQL was executed. No credential file was read.
**Remediation migration:**
`supabase/migrations/20261118000700_business_security_integrity_remediation.sql`

## 1. What was changed

The six reviewed migrations (`20261118000100` … `20261118000600`) and the two
historical 20261117 drafts are **byte-for-byte unchanged** (SHA-256 verified
before and after this work, see §6). Every fix is applied additively by a new
migration that runs after `20261118000600_business_dashboard_team_rpcs.sql`:

- `CREATE OR REPLACE` for every affected RPC (keeps signatures and grants).
- `DROP FUNCTION` + `CREATE FUNCTION` only for `public.api_stock_qty`, whose
  return type changes from `integer` to `bigint`.
- Two additive columns: `public.sales.idempotency_fingerprint`,
  `public.payments.idempotency_fingerprint`.
- One additive unique index: `return_lines_request_line_unique` on
  `public.return_lines(return_request_id, sale_line_id)`.
- A fail-closed `DO` block that validates the existing `on_auth_user_created`
  trigger definition on `auth.users`.

## 2. Finding-by-finding remediation

Legend: **H** = HIGH, **M** = MEDIUM, **L** = LOW, **I** = INFO.

| # | Sev | Original finding (file) | Fix in `…20261118000700…` | Evidence |
|---|-----|-------------------------|---------------------------|----------|
| 1 | H | `api_team_list()` NULL `NOT IN` fall-through leaked every profile to pending/disabled accounts (`…000600`) | Replaced the SQL `CASE` with PL/pgSQL; explicit `IF v_role IS NULL OR v_role NOT IN ('owner','admin') THEN RETURN '[]'`; same grant surface | `team list and audit log deny pending, disabled and salesperson roles (NULL-safe)` |
| 2 | H | `api_audit_log()` same NULL fall-through leaked audit rows/metadata (`…000600`) | Same explicit NULL-safe deny; preserved limit handling and output shape | same test as #1 |
| 3 | H | `api_claim_owner()` check-then-update race allowed two first owners (`…000200`) | `pg_advisory_xact_lock(hashtext('ethereal.owner_membership')::bigint)` before the existence check; missing-profile and disabled-account failures | `owner bootstrap is serialized and the last active owner cannot be removed (simulated race)`, `a disabled account cannot bootstrap ownership but a pending account can` |
| 4 | H | Concurrent status/role changes could remove the last active owner (`…000600`) | Both functions take the same global owner-membership advisory lock before reading/counting owners; the invariant now covers any transition out of `approved`, and only counts *currently approved* owners | same simulated race test (also asserts the lock exists in SQL) |
| 5 | H | `api_verify_payment()` validated balances without locking sales, so two verifications could spend one balance (`…000400`) | Locks every affected sale (explicit allocations plus every open sale of the shop) in deterministic `sale.id` order with `FOR UPDATE` before validation and FIFO allocation; re-checks the balance under lock | `two payments cannot both settle the same sale balance (simulated verification race)` |
| 6 | H | `api_record_payment()` validated raw allocation totals, then rounded rows individually, so stored allocations could exceed the payment (`…000400`) | Every allocation is rounded to cents first; the normalized sum is validated against the rounded payment; every stored row is `round(..., 2)` | `payment allocations reject duplicate sales and normalize half-cent amounts` |
| 7 | H | Duplicate `sale_id` entries in one allocation array passed per-entry checks and then violated `UNIQUE(payment_id, sale_id)` at insert (`…000400`) | Duplicate sale IDs are compared with `count(*)` vs `count(DISTINCT sale_id)` and rejected with a controlled message before insertion; a null sale ID has its own message | `payment allocations reject duplicate sales and normalize half-cent amounts` |
| 8 | H | Duplicate `sale_line_id` lines could exceed the sold quantity (`…000500`) | Duplicate lines rejected before insert, structurally enforced by the new unique index; requested quantity is capped cumulatively across `submitted` + `approved` requests under a per-sale-line advisory lock | `returns reject duplicate lines and cap cumulative requested quantity`, `return approvals re-check shared sale lines and the unique index blocks duplicates` |
| 9 | H | Concurrent approvals of two requests for one sale line could both over-approve (`…000500`) | `api_review_return()` takes `hashtext('ethereal.return_line:' || sale_line_id)` advisory locks in deterministic order (then per-variant locks), and re-checks approved quantities before inserting movements/credits | `return approvals re-check shared sale lines and the unique index blocks duplicates` |
| 10 | H | Pending/disabled employees could reach protected information | Fixes #1/#2 plus explicit checks already present elsewhere; regression coverage confirms inventory, dashboard and stock receipt RPCs deny them | `pending and disabled employees cannot reach inventory or dashboard data`, `unauthenticated and anon callers cannot reach protected team/audit data` |
| 11 | M | Sale idempotency returned another actor's sale and ignored payload (`…000300`) | Replay is scoped to `salesperson_id = auth.uid()` and compared against `idempotency_fingerprint` = `md5` of normalized shop/terms/lines; mismatch or foreign actor raises | `sale idempotency is scoped to the creating actor and payload` |
| 12 | M | Payment idempotency returned another actor's payment and ignored payload (`…000400`) | Same pattern keyed on `recorded_by` and an `md5` fingerprint of shop/method/amount/external reference/normalized allocations (`received_at` excluded) | `payment idempotency is scoped to the creating actor and payload` |
| 13 | M | Stock receipt treated a key conflict as success, replayed silently, and duplicated the audit event (`…000500`) | `ON CONFLICT (idempotency_key) DO NOTHING`, then compare stored actor/variant/cartons/source; replay returns `idempotent: true` and writes no audit event; conflicting payload raises `42501` | `stock receipt replay is idempotent, payload-checked and audited once` |
| 14 | M | Profile updates returned success without an affected row (`…000200`) | `api_update_my_name` / `api_update_my_avatar` check `FOUND` after `UPDATE` and raise `Profile not found` | `profile updates fail when the caller has no profile row` |
| 15 | M | Inventory locking was inconsistent across stock mutations (`…000500`) | Sale creation, credit approval, receipt, adjustment and return approval all take `hashtext(<variant_id>::text)` per variant, in ascending variant order | static assertions in the remediation tests; return test exercises approval |
| 16 | M | Inventory aggregates cast to `integer`, so append-only totals could overflow (`…000200`, `…000300`, `…000500`, `…000600`) | `api_stock_qty` returns `bigint`; dependent recordsets in `api_inventory_list`/`api_dashboard` widened to `bigint`; adjustment arithmetic uses `bigint` | `inventory aggregates are bigint and survive beyond 2^31 cartons` |
| 17 | M | Dashboard “collected” metrics mixed cash received with allocation-based settlement (`…000600`) | `collected_today`/`month_collected` stay cash-received; new `applied_today`/`applied_month` report verified allocation totals; both use the same visibility predicate | `dashboard separates cash collected from applied allocations` |
| 18 | M | Signup trigger compatibility was assumed from the trigger name (`…000100`) | Fail-closed check: an existing `on_auth_user_created` must be non-internal, `AFTER INSERT FOR EACH ROW` (`tgtype = 5`) and bound to `public.api_handle_new_auth_user()`; otherwise the migration aborts with a manual-reconciliation message | exercised by every PGlite bootstrap (the trigger exists and passes the check) |
| 19 | M | Payment receipt `INSERT … ON CONFLICT DO NOTHING RETURNING *` could return a null receipt | If `RETURNING` yields no row, the existing receipt is selected before responding | covered by payment verification tests |
| 20 | M | Additive `CREATE TABLE IF NOT EXISTS` compatibility is not fully reconciled for legacy schemas (`…000100`) | **Deferred.** Cannot be validated without target-schema access; recorded in the release plan preflight | see remaining risks |
| 21 | M | Invoice/receipt sequences can gap on rollback (`…000200`) | **Accepted.** PostgreSQL sequences are non-transactional; numbering requirements remain an accounting decision | documented, unchanged |
| 22 | L | Seed conflict handling silently keeps a conflicting SKU on another product (`…000600`) | **Deferred** to the release preflight (verify product/variant pairs after apply) | release plan |
| 23 | L | Some table values have no database-level text/range constraints (`…000100`) | **Accepted** for this phase: direct writes stay revoked, validation remains in RPCs | documented |
| 24 | I | Non-GST arithmetic is consistent but tax treatment is pending (`…000300`) | **Accepted**, no change; invoice remains explicitly non-GST | documented |
| 25 | I | Expense review/paid transitions already correct (`…000500`) | No change | existing integration test |
| 26 | M | Submitted allocations do not reserve balances (`…000400`) | **Documented.** No reservation is introduced; verification is the authoritative, now-serialized step and re-validates every allocation | `two payments cannot both settle the same sale balance`, payment tests |

Cross-package items from the review (function ownership/BYPASSRLS assumptions,
PostgREST cache, Storage provisioning, migration history) are deployment-time
checks, not code defects; they are carried into the release plan.

## 3. Business-rule clarifications (with rationale)

| Change | Rationale |
|--------|-----------|
| A **pending** user may claim first ownership; a **disabled** user may not | Preserves the documented bootstrap path (first signup is pending until approved) while refusing explicitly revoked accounts |
| Return quantity is capped **cumulatively** across `submitted` and `approved` requests for the same sale line | A per-request cap let parallel pending requests over-return; the cumulative cap matches the signed return workflow |
| Duplicate return lines in one request are **structurally impossible** (unique index), and the migration fails closed if legacy duplicates exist | Requested quantity per line must be unambiguous for the approval invariant |
| Idempotency keys are scoped to the **creating actor + normalized payload**; reuse with different data is an error, not a silent success | Prevents cross-actor result disclosure and masks no caller bugs |
| The last **active** owner cannot be moved to `disabled` **or `pending`** | `api_role()` only recognizes `approved` profiles, so either transition removes all administrative access |
| Owner-demotion protection applies only when the target is a **currently approved** owner | Avoids blocking reclassification of a pending owner while keeping the invariant |
| Self-service status changes to anything other than `approved` are rejected | An admin/owner must not remove their own access through a path that bypasses the last-owner intent |
| `collected_today` / `month_collected` remain **cash received**; `applied_today` / `applied_month` are **allocation-based** | Keeps existing UI meaning honest and exposes settlement separately, as the review requested |
| Sub-cent allocations (< 0.005) are rejected after rounding to 0.00 | A zero-cent allocation cannot be persisted meaningfully |
| Submitted payments still do **not** reserve balances | Preserves the existing workflow; verification is serialized and authoritative instead of introducing a new reservation ledger |

## 4. Test coverage added

`scripts/sql-remediation.test.mjs` — 15 tests against the real migrations in
PGlite (real PostgreSQL parser/executor, PL/pgSQL, advisory locks, row locks,
unique indexes):

1. Role matrix for team/audit: owner, admin see data; salesperson, pending, disabled get `[]`.
2. Unauthenticated session and `anon` role denied (no grant; empty/denied results).
3. Pending/disabled denied inventory, dashboard and stock receipt.
4. Profile update with no profile row fails.
5. Owner bootstrap serialization, last-owner demotion/self-disable (simulated race + static lock assertion).
6. Sale idempotency: replay, payload mismatch, cross-actor replay.
7. Duplicate payment allocations, half-cent normalization, sub-cent rejection.
8. Payment idempotency: replay, payload mismatch, cross-actor replay.
9. Two payments against one sale balance (simulated verification race).
10. Duplicate return lines and cumulative quantity cap.
11. Concurrent return approvals (injected stale request) and unique-index enforcement.
12. Stock receipt replay idempotency, payload mismatch, single audit event.
13. `bigint` inventory aggregate beyond 2^31 and `api_stock_qty` return type.
14. Dashboard cash-received vs applied-allocation metrics.
15. Disabled account cannot bootstrap ownership; pending account can.

**Simulated vs real concurrency.** PGlite exposes a single connection, so no two
transactions overlap in time. Tests named “simulated race” reproduce the losing
branch sequentially (stale balance, stale approved quantity, repeated claim) and
assert that the serialization primitive exists in the SQL. They do **not** prove
lock scheduling under real contention. A real multi-connection PostgreSQL
rehearsal is still required before remote deployment (see release plan).

No mock data or stubbed business logic was introduced; all tests run the shipped
migrations.

## 5. Verification results (actual)

| Command | Result |
|---------|--------|
| `npm test` | **45 passed, 0 failed** (5 files): `backend.test.mjs`, `sql-integration.test.mjs` (14), `sql-remediation.test.mjs` (15), `rpc-contract.test.mjs` (1), `integration-status.test.mjs` + `backend-mode.test.mjs` (bundled: 15 across the backend/status files) |
| `npm run lint` | **0 errors**, 42 pre-existing warnings (React hooks/memoization, `Date` purity, `App-backup.jsx`); no new warnings from this work |
| `npm run build` | Success — `dist/index.html` 1.04 kB, CSS 63.64 kB, JS 670.66 kB (chunk-size warning only) |
| Original migration hashes | 8/8 match the pre-work snapshot (`20261117…` ×2, `20261118…000100`–`000600`) |
| RPC contract audit | Passes with the 7th migration included (42 frontend RPCs still match signatures/grants) |

## 6. Preserved artifacts

SHA-256 recorded before remediation and re-checked after
(`C:\Users\harsh\AppData\Local\Temp\opencode\phase2-original-migrations.sha256`):

```
5FA5BF02…7D5E  20261117000100_phase1_foundation.sql
DC00A7CA…FC29  20261117000200_phase1_commerce_ledgers.sql
4AA1BB4A…3B50FB  20261118000100_business_schema.sql
2F23D236…E9FF5  20261118000200_business_core_rpcs.sql
A9C619F4…86CCA  20261118000300_business_sales_rpcs.sql
89401F07…05144  20261118000400_business_payment_rpcs.sql
F438A12D…86626  20261118000500_business_inventory_return_expense_rpcs.sql
05022AF7…7E6051  20261118000600_business_dashboard_team_rpcs.sql
```

## 7. Remaining risks (carried to the release plan)

1. **Real concurrency is unproven locally.** All lock-ordering behaviour must be
   rehearsed on a disposable PostgreSQL/Supabase instance with overlapping
   sessions before production.
2. **Simultaneous first use of one client reference.** The unique index prevents
   duplicates, but the losing concurrent insert surfaces a unique-violation error
   instead of an idempotent replay. No data corruption; retrying returns the
   stored result.
3. **Legacy data.** Creating `return_lines_request_line_unique` fails if
   duplicate return lines already exist; pre-existing sales/payments have a NULL
   fingerprint, so replaying their old client references fails closed instead of
   returning the original object.
4. **Verification lock scope.** Verification locks every open sale of the shop to
   make FIFO allocation safe; shops with many open invoices may see contention.
5. **Sequences.** Invoice/receipt numbering can gap on rollback (accepted).
6. **Schema compatibility** (`CREATE TABLE IF NOT EXISTS` reconciliation) is not
   verified against a legacy schema; the migration assumes the six 20261118
   files define the objects or that an equivalent schema exists.
7. **Signup trigger.** The check fails closed if another integration owns
   `on_auth_user_created`; that requires manual reconciliation.
8. **Ownership/RLS flags** of created functions and tables (owner, BYPASSRLS)
   depend on the deploying role and are not verifiable locally.
9. **Frontend adoption.** `applied_today` / `applied_month` are additive API
   fields; the UI does not display them yet.

## 8. Status

All 10 HIGH findings from the release review have a code fix and a regression
test in this branch. The package is **ready for independent review and staging
rehearsal**, not for production deployment. No remote action was taken; owner
approval is required before any database write.
