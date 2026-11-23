# Phase 1 — Implementation Plan

**Current phase output:** design package and unexecuted SQL drafts only. No migrations were run.  
**Next development phase recommendation:** owner review and compatibility discovery, then isolated local database tests before any staging deployment.

## Migration sequence

The `supabase/migrations/` files are chronological, draft SQL for a clean-schema proposal. They are not verified against this project's live/staging database and must not be run before the owner approves a metadata comparison.

1. `20261117000100_phase1_foundation.sql` — enums, profile lifecycle/trigger, shops and assignments, visits/photos metadata, products/variants, effective-dated default/shop prices, credit block, constraints/indexes, profile/shop/catalog RLS and append-only audit foundation.
2. `20261117000200_phase1_commerce_ledgers.sql` — sales/lines, invoice snapshots, payments/allocations/receipts, inventory movements, returns, expenses, shop ledger, constraints/indexes, RLS, append-only guards.

Dependencies: Auth `auth.users` exists; `pgcrypto`/UUID generation and `btree_gist` availability/ownership checked; existing profile, avatar RPC, storage bucket/policies, grants and triggers reconciled; first owner provisioned by explicit trusted procedure. SQL drafts do not provision a first Owner or expose final critical-operation RPCs. Financial business writes remain denied until secure transaction functions are designed, implemented, and tested.

## Implementation stages and gates

| Stage | Work | Exit gate |
|---|---|---|
| A. Owner review | Approve one-business scope, roles, workflows, tax/accounting decisions, assumptions in architecture doc. | Signed decision log and business acceptance. |
| B. Compatibility inventory | Run approved read-only audit manually in staging; compare existing profile/RPC/trigger/storage/grants/history with draft assumptions. No schema changes. | Migration reconciliation plan; backup/restore responsibility named. |
| C. Local disposable schema | Adapt drafts to confirmed schema; run migrations only against disposable local DB after explicit implementation authorization. Add Supabase Auth fixture users. | Migrations reproducible from blank local state; lint/static parse; schema diff reviewed. |
| D. Security foundation | Implement policies/helper functions and role provisioning; no frontend business writes. | RLS allow/deny tests across anonymous, pending, approved roles and disabled users; no privilege escalation. |
| E. Trusted transactions | Narrow RPC/backend operations for shop approval, sale submit/credit confirm, payment verify, returns, inventory, expenses, invoices; idempotency and audit. | Transaction/concurrency/rollback tests pass; independent security review. |
| F. Application integration | Replace placeholders incrementally; preserve login/profile states; client uses anon key and RPC/table access only. | UI, API, accessibility, E2E tests; no service role in bundle. |
| G. Staging release | Owner-authorized staging deployment, backup, migration rehearsal, business UAT, audit. | Explicit release approval. Production remains separate approval. |

## Testing strategy (not run in this design task)

- Static: migration filename order; no secret literals; explicit FK target; monetary columns NUMERIC; no grants to `anon` for private data; RLS on all exposed tables; functions schema-qualified with fixed search path if SECURITY DEFINER; all direct UPDATE/DELETE of append-only records denied.
- Schema: create from empty disposable Supabase local instance; apply migrations; verify constraints, FK actions, indexes, generated defaults, RLS enabled/forced, and migration repeatability using approved tooling.
- RLS: test anon; signup pending; approved Owner/Admin/Salesperson; disabled user; salesperson assigned/unassigned shops; reassignment; cross-record ID tampering; each CRUD action per matrix. Include tests as authenticated JWT identities, not service role.
- Financial: price override precedence/effective boundaries; snapshots immutable after price changes; numeric rounding; sale confirm rollback; insufficient/concurrent stock; credit blocked; duplicate idempotency key; repeated payment verification; allocation overrun; receipt only verified; return cumulative quantity/condition; expense report only approved.
- Ledger: every confirmed sale exactly one debit/movement per line; every approved return one credit and correct disposition; payment retry no duplicate; inventory replay equals balance; immutable records cannot update/delete; reconciliation detects gaps.
- Operational: timezone around India midnight, report periods/week start/fiscal year, invoice/PDF retry, private storage, export authorization, backup/restore rehearsal, disabled employee session behavior.

No database tests, SQL execution, or live project verification were performed for this deliverable.

## Rollback and recovery

- Never use `db reset`, remote `db push`, or apply migrations without a separately approved change/release plan.
- For local development, reset disposable fixtures freely only after confirming the target is local and data is disposable.
- Production migrations should be forward-compatible, additive first, backward-compatible during rollout, and rehearsed on a recent staging clone. Use expand/migrate/contract; do not drop/rename columns in the same release that still runs old clients.
- Before any staging/production change: verified backup and restore point; reviewed migration SQL; owner approval; dependency/version/extension check; operator confirms project ref; exact rollback/forward-fix plan.
- DDL rollback is not equivalent to financial rollback. Preserve immutable invoices/ledger/movements; correct with compensating records and maintain audit evidence.
- If a migration fails, stop writes/deployment, capture error, assess transaction state, restore or apply reviewed forward fix. Do not improvise destructive rollback.
- Retention, RPO/RTO, backup owner, incident contacts, and invoice object recovery remain unresolved.

## Documented defaults vs owner approvals

**Defaults proposed:** one business; INR; Asia/Kolkata; `NUMERIC(14,2)`; carton-only sales; 500 ml/24 bottles and 1 litre/12 bottles; no fixed credit limit; blocked flag stops new credit; cash/UPI sales auto-confirm but payment verification remains separate; only verified payments reduce outstanding; only approved expenses enter expense reports; immutable historical snapshots; private storage; no salesperson targets.

**Must approve before implementation:** current schema reconciliation and first Owner bootstrap; product/SKU and prices; exact status vocabulary and edit/cancel rules; credit pending behavior after block; stock reservation timing and negative-stock policy; sales invoice numbering and GST/non-GST legal format/rates/rounding; inventory damaged/returned segregation; returns effect/refunds/credit notes; payment allocation/unapplied credits/reversals; expense categories/self-approval/settlement; assignment transfer visibility; Admin role boundaries/invitations; owner succession; shop duplicate matching; storage retention and permitted photo/receipt formats; week/fiscal-year definitions; profit/COGS; report permissions; privacy/retention/backup policy.

## Phase 1 deliverable status

Created architecture, permissions, workflows, implementation plan and two versioned draft migrations. These do not change any database until explicitly executed by an authorized operator. Not implemented: application features, secure transaction RPCs, PDF/Excel generation, GST logic, real invite/employee controls, data imports, or deployment. Not tested: database syntax/runtime, RLS behavior, concurrency, migrations on any database, or PDF/legal compliance. The project has no migrations or test suite before this package; existing source/auth integration still requires schema-aware compatibility work.
