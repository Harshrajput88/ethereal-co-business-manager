# Ethereal Co. — Six Migration Security & Release Review

**Date:** 18 November 2026  
**Scope:** Local static review of six 20261118 migrations, 42 frontend RPC contracts, two historical 20261117 drafts, and local automated tests.  
**Remote access:** None. No SQL was executed against Supabase; no database or Storage changes were made.

## Executive verdict

# NO-GO

Do not deploy this package to staging or production. The local package contract audit and PGlite tests pass, but they do not demonstrate Supabase-equivalent authorization, concurrency, trigger behavior, or deployment compatibility. Confirmed HIGH findings include unauthorized team/audit data disclosure to authenticated profiles whose `api_role()` is NULL, cumulative return quantities exceeding the original sale quantity, and concurrent payment allocations exceeding a sale's balance. Payment rounding can also make recorded allocations exceed the rounded payment amount. Owner initialization and last-owner protections are race-prone.

The 20261117 drafts are historical inputs, not part of the proposed deployment set. Preserve them unchanged and do not use a generic migration push that might select them.

## Migration-by-migration findings

| Migration | Severity | Finding / evidence | Required action |
|---|---|---|---|
| `20261118000100_business_schema.sql` | MEDIUM | Additive compatibility relies heavily on `CREATE TABLE IF NOT EXISTS` plus selected `ADD COLUMN IF NOT EXISTS`; existing tables are not fully reconciled for column types, constraints, nullability, indexes, and triggers. Applying over a partial/older schema may silently preserve incompatible definitions. | Compare every existing object/constraint before deployment and provide explicit compatibility checks/migrations; rehearse from both empty and supported legacy schemas. |
| `20261118000100_business_schema.sql` | MEDIUM | Signup trigger installation checks only trigger name on `auth.users`; an existing trigger with the same name is left untouched even if it calls a different function or has different timing. The new function is created regardless. | Inspect trigger definition and function binding; fail closed on unexpected same-name trigger rather than assuming compatibility. Test signup in Supabase-compatible environment. |
| `20261118000100_business_schema.sql` | LOW | `shop_visits` and several table values have no database-level bounded text/range constraints beyond RPC validation; safety depends on function implementation and privilege boundaries. | Add limits/checks where operationally required; keep direct write grants absent. |
| `20261118000200_business_core_rpcs.sql` | HIGH | `api_claim_owner()` uses a check-then-update sequence (`IF EXISTS owner`, lines 230–237) without transaction serialization or a unique invariant. Two authenticated users can concurrently pass the check and both claim owner. | Serialize bootstrap with advisory/row lock or a one-time bootstrap invariant; add concurrent regression test and ensure no post-bootstrap re-claim. |
| `20261118000200_business_core_rpcs.sql` | MEDIUM | `api_update_my_name()` and `api_update_my_avatar()` do not verify that the profile UPDATE affected a row; they can return success-shaped JSON for a missing profile. | Check `FOUND`/row count and return a clear failure; test Auth/profile trigger failure. |
| `20261118000200_business_core_rpcs.sql` | MEDIUM | Invoice/receipt sequences are global and generated through internal SECURITY DEFINER functions. Their numbering semantics, gaps, prefix configuration, and accounting/legal requirements are not documented; sequences are non-transactional. | Confirm invoice numbering requirements with accounting and document acceptable gaps; test concurrent issuance and uniqueness. |
| `20261118000300_business_sales_rpcs.sql` | MEDIUM | `api_create_sale()` idempotency lookup returns an existing sale by client reference without binding the reference to the authenticated actor or verifying payload equivalence (lines 226–236). A caller who learns another reference may retrieve its result. | Scope idempotency records to actor and compare immutable request identity; test collisions/replays. |
| `20261118000300_business_sales_rpcs.sql` | MEDIUM | Stock validation and debit are protected by advisory lock, but inventory value comes from summing append-only movements and casting to `integer`; long-lived aggregate overflow is possible. | Define stock bounds and use a sufficiently wide aggregate type; test boundary behavior. |
| `20261118000300_business_sales_rpcs.sql` | INFO | Sales/invoice arithmetic snapshots are consistent for the current non-GST model (line amount is unit price × positive integer cartons; total is accumulated and stored), but tax is explicitly zero and marked pending accountant review. | Treat invoices as non-GST only after tax/accounting approval; do not infer tax compliance from arithmetic tests. |
| `20261118000400_business_payment_rpcs.sql` | HIGH | `api_verify_payment()` validates existing allocations against `api_sale_balance()` without locking those sales (lines 182–191). Different payment rows can be verified concurrently against the same outstanding sale and both pass before either verified allocation is visible, over-allocating the balance. | Lock sale rows in deterministic order before checking/allocating; serialize each sale's outstanding-balance mutation; add concurrent integration tests. |
| `20261118000400_business_payment_rpcs.sql` | HIGH | `api_record_payment()` checks allocation totals before rounding each allocation to cents (lines 96–115). Multiple fractional-cent inputs can each round upward when inserted, so stored allocations can exceed the rounded payment amount. | Normalize/round each allocation first, validate normalized sum against normalized payment, and test half-cent edge cases. |
| `20261118000400_business_payment_rpcs.sql` | MEDIUM | Duplicate `sale_id` entries in one allocation array pass the per-entry checks but violate `UNIQUE(payment_id,sale_id)` at insertion, causing the entire RPC to fail rather than returning a controlled validation error. | Reject duplicate sale IDs or aggregate them before validation/insertion. |
| `20261118000400_business_payment_rpcs.sql` | MEDIUM | Payment idempotency returns an existing payment on `payment_reference` without checking caller, shop, or payload equivalence (lines 57–63). | Bind idempotency key to actor and immutable request parameters; test key reuse across accounts. |
| `20261118000400_business_payment_rpcs.sql` | MEDIUM | Submitted allocations do not reserve outstanding balances; different unverified payments may both reference the same amount. Verification currently rechecks, but concurrent verification has the HIGH race above and rejected/re-recorded workflow is operationally fragile. | Define reservation semantics and serialize verification; test multiple pending payments against one sale. |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | HIGH | `api_submit_return()` checks each line independently against the full sold quantity (lines 252–268); duplicate `sale_line_id` entries in one request can sum above cartons sold. `api_review_return()` checks only previously approved requests and does not aggregate duplicate lines in the current request (lines 329–363). | Reject duplicates and aggregate requested quantities per sale line; enforce the invariant at approval while holding a lock on the sale line. |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | HIGH | Two different pending return requests for the same sale line can be reviewed concurrently. Each locks only its own request row, observes the same previously approved total, and can both issue credits/stock movements exceeding quantity sold. | Lock shared sale-line rows in deterministic order before checking totals; add concurrent tests and database-level invariant strategy. |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | MEDIUM | `api_receive_stock()` treats an idempotency-key conflict as a successful no-op but still writes a new audit event and returns a generic success response; it does not compare replay payload. | Scope key to actor and compare variant/quantity; return explicit idempotent result and avoid duplicate audit on replay. |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | MEDIUM | `api_review_return()` does not take the inventory advisory lock used by sale/receive/adjust operations. Positive return movements cannot make stock negative, but concurrent stock reporting/serializability semantics are not uniformly coordinated. | Use one documented per-variant lock protocol for every stock mutation; test simultaneous return/sale/adjustment. |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | INFO | Expense review and paid transitions lock the expense row and require submitted→approved/rejected→paid, with self-approval blocked. | Retain row locks and test admin/owner segregation and audit outcomes. |
| `20261118000600_business_dashboard_team_rpcs.sql` | HIGH | `api_team_list()` checks `api_role() NOT IN ('owner','admin')` (lines 32–49). For pending/disabled authenticated users `api_role()` is NULL, and SQL `NULL NOT IN (...)` is NULL, not TRUE. CASE therefore takes the ELSE branch and returns all profiles. | Replace with explicit NULL-safe deny (`api_role() IS NULL OR ...`); add pending/disabled regression tests. |
| `20261118000600_business_dashboard_team_rpcs.sql` | HIGH | `api_audit_log()` has the same NULL `NOT IN` fall-through (lines 358–376), allowing pending/disabled authenticated users to read the audit log and metadata. | Replace with explicit NULL-safe deny; test against pending/disabled accounts. |
| `20261118000600_business_dashboard_team_rpcs.sql` | HIGH | `api_set_employee_status()` and `api_set_employee_role()` lock the target row but count active owners without serializing owner changes (status lines 91–95; role lines 142–147). Concurrent demote/disable operations may each see multiple owners and remove the last active owner. | Serialize owner-role/status mutations globally or enforce invariant with a robust database constraint/workflow; add race tests. |
| `20261118000600_business_dashboard_team_rpcs.sql` | MEDIUM | `api_dashboard()` reports `collected_today` and `month_collected` by summing full verified payment amounts, while receivables are allocation-based. Unapplied payment portions can inflate collected metrics relative to sale-level settlement; confirm intended cash-received versus applied definition. | Name/define cash-received metrics explicitly and reconcile against receipts, allocations, refunds/reversals, and reports. |
| `20261118000600_business_dashboard_team_rpcs.sql` | LOW | Seed conflict handling is idempotent by product name/SKU, but an existing conflicting SKU attached to a different product is silently retained. | Preflight seed identities and verify product-variant relationships after applying. |

## Cross-package security and data integrity

### Authorization, RLS, SECURITY DEFINER

- The 42 frontend RPC contracts match the local inventory and the repository contract audit reports authenticated EXECUTE plus PUBLIC/anon revokes for those functions. This is only a local static check.
- All 53 `api_*` definitions across the six current migrations use SECURITY DEFINER and fixed `SET search_path = ''` in the reviewed definitions. Internal helpers are revoked from browser roles; API functions are generally revoked from PUBLIC/anon and granted to authenticated.
- Authorization is generally derived from `auth.uid()` and `public.profiles`, with SQL-side owner/admin/assignment checks. Direct browser writes are revoked and RLS is enabled with NO FORCE for table-owner-backed SECURITY DEFINER workflows.
- The NULL authorization defects in `api_team_list` and `api_audit_log` are material exceptions to that model. A policy/grant audit alone would not detect them; test behavior for approved, pending, disabled, and unauthenticated contexts.
- Function ownership is not explicitly set by these files and therefore depends on the migration executor/ownership environment. Verify actual owners and `BYPASSRLS`/table-owner assumptions in a compatible rehearsal before deployment.

### Arithmetic, payment allocation, invoices

- Sale totals are derived server-side from current prices and positive integer carton quantities; clients do not supply price/total. Invoice snapshots derive from the sale, shop and settings.
- Payment amount is rounded to two decimals for storage, but allocation entries are rounded individually after aggregate validation; this can break `sum(allocations) <= payment amount`.
- Outstanding balance is computed from verified payment allocations and approved return-credit ledger entries with a floor at zero. Submitted payment allocations do not reduce the balance.
- Concurrent verification of different payments against one sale is not serialized for explicit allocations. FIFO candidates use row locking, but that does not repair the unlocked explicit-allocation path.
- Receipt insertion is idempotent by unique payment ID, but a concurrent conflicting insertion can leave the `RETURNING` row null; test that response path.
- Invoice/receipt number sequences can gap on transaction rollback, as PostgreSQL sequences are non-transactional. Confirm this is accepted.

### Inventory and return invariants

- Sale creation, credit approval, manual receive, and adjustment use a shared per-variant advisory lock. Confirm exact advisory-key behavior and consistent lock order; credit review loops are not explicitly ordered by variant.
- Stock is an append-only movement sum. Receive idempotency conflicts do not verify payload equivalence and still create audit entries.
- Return submission permits duplicate lines and compares each entry to the full sold quantity. Review checks previous approvals, but not duplicates within the current request; separate pending requests can race because they lock different request rows, not the shared sale line.
- Reusable returns credit saleable stock; damaged returns credit damaged stock. Both create financial return credit based on unit price. Quantity and amount limits must be enforced atomically.

### Audit and idempotency

- Most state-changing RPCs call the internal audit helper in the same transaction; append-only triggers guard selected event/ledger tables.
- Audit helper is SECURITY DEFINER with empty search_path and not executable by browser roles. A transaction failure rolls back both mutation and audit event.
- Idempotency exists for sale, payment, expense claim and stock receipt, but key ownership/payload matching is inconsistent. Replays may return another actor's object or report success for a conflicting payload; stock receipt retry also duplicates audit.
- Not every state transition has an explicit idempotency key. Verify actor, request ID, action, entity, and safe metadata conventions.

### Auth, profiles, Storage

- Migration 1 creates a pending salesperson profile on Auth signup and avoids duplicate profile insert by ID. Same-name existing trigger is not validated for definition.
- First-owner claim and last-owner protections are check-then-act races.
- Profile update RPCs do not check row count; Storage is not configured by this package. The frontend requires a separately provisioned `profile-picture` bucket and policies.
- The prior staging snapshot showed zero Auth users, no public profile table, no bucket and no public business objects. It does not provide authorization for writes or guarantee the state remains unchanged.

## RPC inventory comparison

`docs/SUPABASE_RPC_INVENTORY.md` lists 42 frontend RPCs and 11 helper/trigger functions. The local `rpc-contract.test.mjs` compares frontend call names/argument names against the six current migration definitions and their authenticated grants; it passed. No remote function existence or PostgREST cache status is implied.

## Older 20261117 drafts — safe exclusion

The files are `supabase/migrations/20261117000100_phase1_foundation.sql` and `supabase/migrations/20261117000200_phase1_commerce_ledgers.sql`. They are explicitly described as drafts and have an earlier SQL security review with unresolved execution/RLS/compatibility blockers. Keep both original files byte-for-byte unchanged. Do not execute, rename, delete, rewrite, or “mark applied” as part of deploying the newer set. Because both reside in the CLI migration directory and the prior staging inspection found no usual project migration ledger, do not run generic migration push. Use a reviewed temporary release directory/worktree containing only the explicitly approved six migrations, verify the exact planned IDs against target history, and retain hashes/copies of all originals. Reconcile Supabase migration history before any write; do not fabricate ledger entries.

## Local verification performed

- `npm test`: **30 passed, 0 failed**. This includes ephemeral PGlite schema/workflow integration and RPC contract checks.
- The PGlite tests execute the six current migrations against a local emulation and cover representative workflows. They do not model Supabase Auth, PostgREST, production PostgreSQL concurrency/isolation under load, ownership/role flags, managed extensions, Storage, or deployment history.
- No remote database was connected, no Supabase SQL was executed, and no migration or Supabase object was modified.

## Release decision

**NO-GO for staging or production.** Correct and independently review the HIGH findings, extend concurrency/security regression coverage, reconcile the migration-history and older-draft selection strategy, and rehearse on a disposable Supabase-compatible environment. The staging deployment runbook is `docs/ETHEREAL_STAGING_DEPLOYMENT_RUNBOOK.md`. Wait for separate owner approval before any database write.
