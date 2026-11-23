# Phase 1 — SQL Migration Security & Architecture Review

**Scope:** static review of the two Phase 1 migration drafts
**Date:** 17 November 2026
**Reviewer role:** PostgreSQL / Supabase security and financial-systems review
**Status:** not executed, not parsed by PostgreSQL, not tested against any database

| Item | Value |
|---|---|
| Reviewed files | `supabase/migrations/20261117000100_phase1_foundation.sql` (366 lines), `supabase/migrations/20261117000200_phase1_commerce_ledgers.sql` (459 lines) |
| Reference documents | `docs/PHASE_1_DATABASE_ARCHITECTURE.md`, `docs/PHASE_1_PERMISSION_MATRIX.md`, `docs/PHASE_1_WORKFLOWS.md`, `docs/PHASE_1_IMPLEMENTATION_PLAN.md`, `AGENTS.md` |
| Corrected review copies | `supabase/review/phase1/…foundation.reviewed.sql`, `…commerce_ledgers.reviewed.sql` |
| Originals | unchanged (SHA-256 recorded in §12) |
| Database contact | none |

---

## 1. Executive summary

The two drafts are a **well-structured, security-first data model** and a **poorly executable migration package**. The authorization architecture is genuinely good: default-deny is real, no client write path to money or stock exists, roles come from a server-managed table rather than JWT metadata, and all SECURITY DEFINER functions are pinned to an empty `search_path`. Those are the hard parts, and they are right.

What stops this from being runnable is a different list:

1. **Two statements guarantee that migration 2 aborts.** A `CHECK` on `return_requests` references `'paid'`/`'voided'`, which are not labels of `return_status` (22P02); and `audit_read_admin` is created twice across the two files (42710).
2. **`FORCE ROW LEVEL SECURITY` is incompatible with the package's own helper functions.** The signup trigger and the two RLS helpers are SECURITY DEFINER and run as the table owner. With FORCE set on `profiles`, the signup insert has no policy to satisfy and the read policy re-enters itself: either signup fails and every policy raises `42P17` infinite recursion, or the owner has `BYPASSRLS` and FORCE is a no-op that provides no enforcement at all. Both branches are defects; which one you get depends on a role attribute that the drafts never pin down.
3. **Three financial invariants that the documents treat as mandatory have no representation in the schema.** A payment can be allocated beyond its own amount and beyond the sale's outstanding balance; a payment that is not `verified` can still fund an allocation; the ledger has no uniqueness per economic event, so a retried transaction with a fresh idempotency key double-counts receivables or collections. These are the exact defects that make a ledger unusable, and they are invisible to every constraint in the package.
4. **The package cannot be applied to the current project as written.** `profiles` already exists, the app calls `update_my_avatar`, and `src/App.jsx` approves salespeople with a direct `.update({ status })` on `profiles` — which the new grants and policies forbid, and which the new `approved_at` CHECK would reject anyway.

**Verdict: NOT READY to execute — suitable as an approved design baseline.** Fix the two DDL blockers, resolve the FORCE-RLS ownership model, reconcile with the existing schema, and implement the Stage E transaction functions with the invariants in §7–§9. Nothing in this review suggests the design direction is wrong; it suggests the package is one careful iteration away from being testable.

### Findings at a glance

| Severity | Count | Meaning in this package |
|---|---|---|
| CRITICAL | 3 | Ledger/allocation structures permit silent, permanent financial corruption |
| HIGH | 11 | Migration failure, authorization/immutability gap, or a documented invariant with no enforcement |
| MEDIUM | 12 | Design defect that will surface during Stage D/E or operations |
| LOW | 10 | Maintainability, performance, precision-of-design issues |
| INFO | 6 | Verified positives and explicit assumptions |
| **Total** | **42** | |

No CRITICAL finding is currently exploitable by a browser client, because no client write path exists (see IN-01). They are CRITICAL because the schema **guarantees** the corruption once the first RPC or service-role script writes to it, and because append-only records make the damage permanent.

---

## 2. How this review was performed

- Both migrations read in full, line by line.
- Each table, constraint, index, grant, policy, trigger and function compared against the permission matrix, workflow document, architecture document and implementation plan.
- Every `GRANT`/`REVOKE` traced to the object it protects, and every policy traced to the role and scope the matrix defines.
- Static verification only: lexical/structural checks, cross-file dependency checks, defect greps, hash comparison of the originals (§12).
- **Not performed:** connection to any database, `supabase db push/reset`, SQL parsing by PostgreSQL, RLS execution, concurrency testing, PDF/legal validation.

### Severity definitions used

| Level | Definition |
|---|---|
| CRITICAL | Privilege escalation, or financial corruption that is silent, permanent and undetectable from the schema |
| HIGH | Migration failure, major authorization/immutability gap, or a documented business invariant with no enforcement |
| MEDIUM | Design defect that blocks or distorts a documented workflow during implementation |
| LOW | Maintainability, performance, consistency, documentation |
| INFO | Verified strength, or an explicit assumption that must stay visible |

---

## 3. Migration 1 — `20261117000100_phase1_foundation.sql`

### 3.1 What is structurally correct

- Types, tables, keys and nullability match the architecture catalogue; every FK target is explicit and uses `ON DELETE RESTRICT` where history must survive.
- `profiles` defaults to `salesperson` / `pending`, and `handle_new_auth_user()` hardcodes both, so user metadata cannot nominate a role (IN-03).
- Default-deny is implemented in the right order: `REVOKE ALL … FROM PUBLIC, anon, authenticated`, then `ENABLE ROW LEVEL SECURITY`, then narrow column-level `INSERT` grants, then policies.
- Effective-dated prices use a real exclusion constraint on `tstzrange(valid_from, valid_to, '[)')`, which is stronger than a validation function.
- `audit_events` and `shop_visits` are append-only by trigger, and the identity sequence is revoked.
- `current_employee_role()` returns `NULL` for pending/disabled employees, so every policy that gates on it denies automatically.

### 3.2 Findings

#### HI-03 — `FORCE ROW LEVEL SECURITY` breaks or neuters the definer helpers (CRITICAL-adjacent)

**Where:** `profiles` L267–268, `shop_salespeople` L271–272, `audit_events` L287–288 (and again in migration 2, L355–356); functions L32–53, L56–69, L115–132.

**SQL:**

```sql
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
```

**Why it fails.** `handle_new_auth_user()`, `current_employee_role()` and `is_shop_assigned()` are `SECURITY DEFINER`, so they execute as the table owner. `FORCE` makes RLS apply to that owner too unless it holds `BYPASSRLS`.

- `handle_new_auth_user()` inserts into `profiles`, which has **no INSERT policy** → every signup fails with `new row violates row-level security policy` (42501), surfaced to the client as "Database error saving new user".
- `profiles_read_self_or_admin` calls `current_employee_role()`, which selects from `profiles`, which re-evaluates the same policy → `infinite recursion detected in policy for relation "profiles"` (42P17). Because every other policy calls that helper, **every query on every table fails**.
- `audit_events` has no INSERT policy either, so trusted audit inserts are denied.
- If the owner *does* hold `BYPASSRLS`, FORCE is silently a no-op: the helpers read and write without policy evaluation, and the same will be true of every future definer RPC. The security guarantee then lives entirely in function code, not in the table.

**Impact:** total authorization outage or a false sense of enforcement. This is the single most consequential ambiguity in the package.

**Correction applied (F-01):** `FORCE` removed on `profiles`, `shop_salespeople` and `audit_events`; `ENABLE` retained, and `FORCE` retained elsewhere. The review copy carries the reasoning inline. **Owner/infra decision still open:** either pin the definer functions to a dedicated `BYPASSRLS` role and restore FORCE, or accept owner-exemption and stop claiming FORCE. The remaining FORCE flags on commerce tables must be revisited before Stage E, because definer RPCs will need to insert into them.

#### HI-11 — The package assumes an empty business schema; the project is not empty

**Where:** L6–12 (`CREATE EXTENSION`, `CREATE TYPE app_role`, `CREATE TABLE profiles`), L32–53 (trigger).

**Impact:** the architecture document already records that `public.profiles` exists with `full_name`, `email`, `role`, `status`, `avatar_url`, and that `src/App.jsx` calls `update_my_avatar` (line 228) and approves salespeople by updating `profiles` directly (lines 294–309). Consequences of applying as-is:

- `CREATE TYPE public.app_role` / `CREATE TABLE public.profiles` fail if the objects exist (42710 / 42P07), aborting the migration.
- A second `on_auth_user_created` trigger on `auth.users` would run a second insert; if an existing trigger already inserts a profile, signup fails on the primary key.
- The new `CHECK ((status = 'approved') = (approved_at IS NOT NULL) OR status = 'disabled')` rejects the app's approval update, which sets `status` only.
- `authenticated` loses all DML on `profiles`, so the same update would now fail with `permission denied` even without the CHECK.

**Correction applied (F-05):** documented in the review copy header; the file is explicitly flagged as needing conversion to a reconciled, expand-first migration. **Not** rewritten here — reconciliation depends on the Stage B metadata audit.

#### ME-01 — Role and assignment invariants are only partly enforced

**Where:** `profiles` L12–27, `shop_salespeople` L102–113.

- `approved_by` is not required when `status = 'approved'`, and nothing prevents `approved_by = id`.
- `shop_salespeople` does not verify that `salesperson_id` is an approved `salesperson`, or that `assigned_by` is owner/admin. The architecture document promises this check in "workflow code/trigger"; no trigger exists.
- `profiles.role` can be anything for a non-approved user; harmless, but the invariant "only owner promotes admins" lives entirely in a future RPC.

**Correction applied (F-02):** `approved_by` is now required for an approved profile. The self-approval and role-authority checks cannot be expressed as `CHECK`s; they belong in the Stage E RPC and should also be added as guard triggers.

#### ME-07 — `auth.users` deletion is blocked

**Where:** L13 `REFERENCES auth.users(id) ON DELETE RESTRICT`.

Disabling is the correct business behaviour, but RESTRICT makes administrative deletion (GDPR erasure, test-user cleanup) impossible while a profile exists. Decide the archival path (anonymise profile, keep id) and document it; otherwise expect failed deletions to be mistaken for bugs.

#### LO-02 — `profiles.email` can drift

**Where:** L15. `email` is a copy of `auth.users.email` with no synchronisation trigger, so a changed sign-in address leaves a stale display value. Either sync on `auth.users` update or stop treating it as authoritative (the architecture document already says it is a display copy — make that explicit in the column comment).

#### LO-06 — `updated_at` is never maintained

`profiles`, `shops`, `products`, `product_variants` (and `sales`, `payments`, `expense_claims` in migration 2) declare `updated_at timestamptz NOT NULL DEFAULT now()` but nothing updates it. Add a shared `BEFORE UPDATE` trigger or drop the columns; a timestamp that never moves is worse than no timestamp.

#### LO-04 — Extension and role assumptions

`CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions` (L6) requires the `extensions` schema to exist, and the two `EXCLUDE USING gist` constraints require the `btree_gist` operator class to resolve on the migration role's `search_path`. `REVOKE … FROM anon, authenticated` requires both roles to exist. All three hold on Supabase and fail on a bare PostgreSQL cluster; verify them in the disposable local instance before Stage C.

#### LO-09 — Repeated helper evaluation in policies

`shops_read_scope` (L305–313) calls `current_employee_role()` twice per row; most policies call it two or three times. SECURITY DEFINER SQL functions are not inlined, so this is per-row work. `auth.uid()` is correctly wrapped in a sub-select for init-plan caching. Acceptable at Phase 1 volume; note it for reporting queries.

#### IN-02 — Function hardening verified

Both helpers and the trigger are `SECURITY DEFINER` with `SET search_path = ''`, fully qualified object names, no dynamic SQL and `EXECUTE` revoked from `PUBLIC`/`anon` (helpers granted only to `authenticated`). No injection surface and no privilege-escalation path through the helpers themselves.

#### IN-03 — Role and status never come from the client

`handle_new_auth_user()` hardcodes `salesperson` / `pending` and ignores `raw_user_meta_data->>'role'`; every policy reads role from `profiles` via the helper. A forged JWT claim or a crafted signup payload cannot produce an owner or an approved account.

### 3.3 Verified strengths and explicit assumptions (INFO)

#### IN-01 — Default deny is genuinely implemented

`REVOKE ALL … FROM PUBLIC, anon, authenticated` runs before any grant, then RLS is enabled, then narrow column-level `INSERT` grants are issued for `shops`, `shop_visits` and `shop_photos` only. `anon` has no privilege on any Phase 1 table, and no policy uses a permissive `USING (true)`. `service_role` retains Supabase's default `ALL` and is the **only** current write path — it must never reach the browser bundle (AGENTS.md).

#### IN-04 — Money precision

All monetary columns are `numeric(14,2)`; currency is `char(3)` pinned to `'INR'`; tax rates are `numeric(7,4)`; no floating point anywhere. Rounding policy is not encoded (by design).

#### IN-05 — Stock is derived, not stored

`SUM(cartons_delta)` per variant/bucket is the only definition of on-hand stock, so no balance row can silently drift from its movements. This is the right foundation; it still needs the locked check from HI-08.

#### IN-06 — Open business questions are left open

Tax mode/rates, invoice numbering, refunds and credit notes, credit limits, COGS and retention are modelled as nullable fields or absent, not invented. That matches the implementation plan's "must approve before implementation" list.

---

## 4. Migration 2 — `20261117000200_phase1_commerce_ledgers.sql`

### 4.1 Findings — migration-blocking

#### HI-01 — `return_requests` CHECK references non-existent enum labels

**Where:** L236–237, against `CREATE TYPE … return_status AS ENUM ('submitted','approved','rejected','cancelled')` (L12).

```sql
CHECK ((status IN ('approved', 'rejected', 'paid', 'voided')) = (reviewed_at IS NOT NULL)),
CHECK ((status IN ('approved', 'rejected', 'paid', 'voided')) = (reviewed_by IS NOT NULL)),
```

**Impact:** the literals are coerced to `public.return_status` when the table is created, so `CREATE TABLE` fails with `invalid input value for enum return_status: "paid"` (22P02) and the whole migration aborts — no sales, payments, inventory, returns, expenses or ledger tables. The third check at L238 is then redundant with L237.

**Correction applied (C-01):** statuses reduced to `('approved','rejected')`, duplicate check removed, and `cancelled` given its own actor/time pair (C-08).

#### HI-02 — `audit_read_admin` is created twice

**Where:** migration 1 L383–385 and migration 2 L472–474, same table, same name.

**Impact:** `CREATE POLICY` fails with `policy "audit_read_admin" for relation "audit_events" already exists` (42710). Because migration 2 also aborts on HI-01, this is the second of two independent blockers — fixing only one does not make the package applicable.

**Correction applied (C-02):** duplicate removed from migration 2; the foundation definition is authoritative.

### 4.2 Findings — financial

#### CR-01 — Allocations can exceed the payment and the sale

**Where:** `payments` L131–160, `payment_allocations` L169–177.

The table has `amount > 0` and `UNIQUE (payment_id, sale_id)` and nothing else. Consequences:

- Several allocations against one payment can total more than `payments.amount` → collections overstated, cash reconciliation impossible.
- Allocations can exceed the sale's `grand_total` → outstanding becomes negative.
- A payment in `submitted`, `rejected` or `reversed` status can still be allocated → **unverified money reduces outstanding**, which the permission matrix and workflow document both forbid.
- A payment from shop A can be allocated to a sale in shop B.

**Correction:** not expressible as a `CHECK`. The review copy documents the required guard as a precondition for any RPC: lock the payment row (`FOR UPDATE`), require `status = 'verified'`, verify `SUM(allocations) + NEW.amount <= payments.amount`, lock the sale and verify the residual, verify shop equality. This must exist **before** `GRANT INSERT` or an allocation RPC is exposed.

#### CR-02 — Ledger has no uniqueness per economic event

**Where:** L290–306. `idempotency_key uuid NOT NULL UNIQUE` is the only duplicate protection, and it is chosen by the caller.

A retried confirmation that generates a fresh key writes a second `sale_debit` for the same sale; the same holds for `payment_credit` per allocation and `return_credit` per return. Receivables and collections are then wrong by that amount, permanently, because the table is append-only.

**Correction applied (C-06):** three partial unique indexes (`sale_debit` per `sale_id`, `payment_credit` per `payment_allocation_id`, `return_credit` per `return_request_id`).

#### CR-03 — Ledger type is not bound to its source, and provenance is optional

**Where:** L290–303, `CHECK (num_nonnulls(sale_id, payment_allocation_id, return_request_id) <= 1)`.

A `payment_credit` may cite a `sale_id` instead of an allocation; a `sale_debit` may cite nothing at all. Outstanding cannot be derived from the ledger, and no credit can be traced to the payment that produced it.

**Correction applied (C-05):** `entry_type` now requires exactly its own source and forbids the others; `adjustment` may reference at most one. Shop-consistency and adjustment direction remain open (ME-05, ME-06).

#### HI-05 — No enforcement of monetary arithmetic

**Where:** `sales` L40–42, `sale_lines` L75–80, `invoices` L99–101, `invoice_lines` L121–126.

Nothing requires `grand_total = subtotal + tax_total`, nothing requires a sale's totals to equal the sum of its lines, nothing requires an invoice to equal its sale, and `line_total_snapshot` is independent of `line_subtotal` and `tax_amount_snapshot`. Every one of these is a plausible RPC bug that no constraint will catch, and the invoice is the legal artefact.

**Correction:** requires a totals routine invoked by the same transaction (or `BEFORE INSERT/UPDATE` triggers summing the lines under lock). Documented as a Stage E gate; not applied here because the rounding and tax-inclusive/exclusive rules are unresolved.

#### HI-06 — Issued invoices are not immutable

**Where:** `invoices` L88–110 and `invoice_lines` L113–128; triggers L308–323.

`invoice_lines` is protected by `reject_immutable_change()`; the invoice header is not. A future RPC or a service-role script can rewrite `invoice_number`, `seller_snapshot`, `tax_snapshot` or `grand_total_snapshot` after issuance — which contradicts the "frozen at issuance" rule, and is a legal/audit defect rather than a style issue. `sales` totals, `payments.amount` and `payment_receipts.amount_snapshot` are in the same position.

**Correction:** add a `BEFORE UPDATE` guard that permits only `issued → voided`, rejects changes to snapshot columns and requires the void actor/reason; same pattern for a verified payment (only `verified → reversed`). Not applied: the void and reversal rules need Owner/accounting sign-off.

#### ME-04 — Invoice issuance is coupled to PDF existence, with no outbox

**Where:** L102 `pdf_storage_path text NOT NULL UNIQUE`.

The workflow requires invoice issuance and PDF rendering to be separable and retriable ("render failure is retriable by idempotent outbox key without duplicating sale, stock or invoice number"), but an invoice row cannot exist without a storage path, and no outbox table exists. Either the sale transaction fails because a file upload failed, or a PDF is generated inside the sale transaction — both violate the stated design.

**Correction:** make the path nullable, add an `invoice_render_outbox` keyed by invoice id, and let the worker fill the path. Schema addition, Owner acceptance needed.

#### ME-05 — Ledger cannot express adjustment direction

`amount numeric(14,2) NOT NULL CHECK (amount >= 0)` (L297) plus four entry types means an `adjustment` has a magnitude but no direction. Either add a `direction` column / signed amount, or model debits and credits as separate types. Accounting decision.

#### ME-06 — Verified-payment reversal is not representable

`payments.status` includes `reversed` (L11) and keeps `verified_at/by` (L152–153), but `payment_allocations` is append-only (L312–314) and `shop_ledger_type` has no contra type (L18–19). Reversing a verified payment therefore leaves its allocation and its credit in place with no compensating row that a report can interpret. Approximating it with `adjustment` fails because of ME-05. The documents promise "compensating reversal with reason and new audit/ledger entries"; the schema cannot express it.

#### ME-10 — Idempotency keys are not bound to their payload

`payment_reference` (L133), `claim_reference` (L267), `idempotency_key` (L198, L299, L366) are caller-supplied UUIDs with no request hash. A retry that reuses the key with different values silently no-ops; a retry with a new key duplicates the record. Store a canonical payload hash next to the key, or derive the key server-side.

### 4.3 Findings — inventory and returns

#### HI-07 — Inventory provenance and duplicate protection are incomplete

**Where:** L190–222.

- `source_type text` / `source_id uuid` have no FK, no allow-list and no uniqueness: a movement can cite a sale id that does not exist, or cite the same sale twice.
- `reverses_movement_id` is neither required for `reversal` nor unique: a movement can be reversed repeatedly, and a `reversal` can carry the same sign as its target.
- `adjustment` and `reversal` accept any bucket and any sign, so an "adjustment" can inflate saleable stock with only a text reason.

**Impact:** the append-only ledger diverges from physical stock with no schema-level signal, and the damage is permanent.

**Corrections applied (C-07):** `reversal` must name its target, the target cannot be itself, at most one reversal per movement, at most one `sale` movement per `(source_id, variant_id)`, and `source_type` cannot be blank. **Still missing:** the source vocabulary and real FK resolution (polymorphic by design), a reverse-sign check, and per-sale-line linkage — `source_id` is the sale, so a sale with two lines of the same variant (prevented by `UNIQUE (sale_id, variant_id)`) is the only case that works out.

#### HI-08 — No negative-stock or concurrency protection

Stock is `SUM(cartons_delta)` and nothing checks it. Two concurrent confirmations for the same variant both pass any read-then-write check unless the RPC locks. The workflow document requires "insufficient stock rejects confirmation; it cannot create negative available stock" and row locks on credit approval. No reservation model exists, and `cartons_delta <> 0` is the only quantity guard.

**Correction:** the confirmation RPC must lock per variant (`SELECT … FROM inventory_movements WHERE variant_id = … FOR UPDATE` is not sufficient because it locks rows, not a balance; use an advisory lock keyed by variant, or select the balance into a locked variant row). Documented as a Stage E gate.

#### HI-09 — Returns are not tied to the sale's shop; cumulative caps unenforced

**Where:** L224–263.

`return_requests.shop_id` is independent of `sales.shop_id`, so a return can credit a different shop's ledger. `return_lines.approved_cartons <= cartons` is per-row only; nothing limits the total approved across requests for the same `sale_line_id`, and an approved return can carry `approved_cartons = 0`. `cancelled` had no actor/time (fixed, C-08).

**Correction:** approval RPC must verify shop equality and lock the sale lines before summing approved quantities; add `approved_cartons > 0` for approved lines if the business agrees a zero-line return is meaningless.

#### ME-12 — Business date is not derived

`sales.business_date` (L29) and `shop_ledger_entries.entry_date` (L298) are plain dates with no `Asia/Kolkata` derivation and no guard against future dates. Correctness depends entirely on the future RPC; a client-supplied date would silently shift revenue between reporting periods.

### 4.4 Findings — expenses

#### HI-04 — `paid` and `voided` conflict with the review CHECK

**Where:** L282–285.

```sql
CHECK ((status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL)),
CHECK ((status = 'paid') = (paid_at IS NOT NULL AND paid_by IS NOT NULL)),
```

For `paid`, the first check requires `reviewed_at IS NULL`; for `voided` likewise. Settling or voiding an approved claim therefore forces the approval evidence to be erased — or makes both states unreachable. `reviewed_by` is not constrained at all.

**Correction applied (C-04):** review evidence is required for every non-`submitted` state, with `reviewed_by` in step. If "void before review" is a real business case, relax to `status NOT IN ('submitted','voided')` for the review pair — that is an Owner decision.

#### ME-02 — Segregation of duties

Self-approval of an expense is now blocked at table level (C-09). For payments, the same person may record and verify a payment (`recorded_by` vs `verified_by`, L135/L142) — role separation usually prevents this (a salesperson cannot verify), but not for an admin acting as recorder. Decide whether to forbid it, and enforce in the RPC and/or a guard trigger.

#### ME-03 — Missing transition actors (fixed)

`expense_claims` had `status = 'voided'` with no `voided_at/by`; `return_requests` had `status = 'cancelled'` with no cancelled actor/time. Both are additive corrections in the review copy (C-08) and need Owner acceptance.

### 4.5 Completeness

#### HI-10 — No operational write path exists, so Phase 1 cannot be exercised

**Where:** migration 1 L290–300 (grants), migration 2 L358–362; no functions beyond the four helpers.

`authenticated` holds `SELECT` on every commerce table and **no** `INSERT`/`UPDATE`/`DELETE`; the only `INSERT` privileges in the package are the three column-level grants on `shops`, `shop_visits` and `shop_photos`. Nothing can approve a shop, create an assignment, confirm a sale, verify a payment, receive or damage stock, approve a return or expense, issue an invoice, write a ledger row or write an audit event. `service_role` is the only path, and using it from the app is prohibited.

This is **deliberate** — the implementation plan defers financial writes to Stage E — but it must be stated plainly: the package is a data model, not a working Phase 1 backend. Any dashboard built against it can only read.

**Correction:** none in this review. Keep the default-deny posture and build the Stage E functions next; do not "unblock" the UI with table-level grants.

### 4.6 Low-severity items (both migrations)

- **LO-01 — Policy and join indexes.** `return_requests(shop_id)` is filtered by a policy with no index (added, C-11); `return_lines(variant_id)` and `invoice_lines(invoice_id)` are fine, but `return_lines` has no variant index for reporting.
- **LO-03 — Signup robustness and bootstrap.** Name clamping and duplicate-safe insert are applied (F-03). Still missing by design: a backfill for pre-existing `auth.users`, a first-Owner bootstrap, and a decision on what happens when an invited user already has a profile.
- **LO-05 — Confusing duplicate DDL.** Migration 2 repeats `ALTER TABLE public.audit_events ENABLE/FORCE ROW LEVEL SECURITY` (L355–356) although migration 1 already did it. Harmless, but it obscures which file owns the setting (the FORCE line is gone in the review copy).
- **LO-07 — Enum vs text inconsistency.** `tax_mode` is `text` with an ad-hoc `IN ('gst','non_gst')` list in two tables (L43, L98) while every other state is an enum; `expense_claims.category` is free text although the architecture document specifies an owner-managed allow-list. Use enums or FK-backed lookup tables.
- **LO-08 — No duplicate guard on visits.** `shop_visits` (migration 1 L134–148) accepts repeated identical visits; a double-tap logs two rows and the append-only trigger prevents correction.
- **LO-10 — Invoice lines cannot be joined to a variant.** `invoice_lines` stores name/SKU/pack snapshots only (L113–128), so historical invoice lines cannot be aggregated by `variant_id` without string matching. Add a nullable `variant_id` snapshot reference if reporting needs it.

---

## 5. RLS policy matrix

Legend — **S** = SELECT, **I** = INSERT, **U** = UPDATE, **D** = DELETE. "Approved employee" means `current_employee_role() IS NOT NULL`; pending and disabled users are denied everywhere because the helper returns `NULL`. RLS is `ENABLE`d on all 23 tables; `FORCE` as noted.

| # | Table | RLS | S | I | U | D | Scope |
|---|---|---|---|---|---|---|---|
| 1 | `profiles` | ENABLE (+FORCE→**removed**) | self **or** owner/admin | none | none | none | Approver/role writes require a definer RPC |
| 2 | `shops` | ENABLE + FORCE | owner/admin **or** assigned **or** own submission | column-grant, forced `pending`, `submitted_by = auth.uid()` | none | none | No path to approve/reject/correct |
| 3 | `shop_salespeople` | ENABLE (+FORCE→**removed**) | own assignment **or** owner/admin | none | none | none | Assignment impossible without RPC |
| 4 | `shop_visits` | ENABLE + FORCE | owner/admin **or** assigned | column-grant, self + assigned | none (trigger) | none (trigger) | Append-only |
| 5 | `shop_photos` | ENABLE + FORCE | owner/admin **or** assigned | column-grant, self + assigned | none | none | Object access not enforced here (ME-09) |
| 6 | `products` | ENABLE + FORCE | all approved employees | none | none | none | Catalog is service-role seeded |
| 7 | `product_variants` | ENABLE + FORCE | all approved employees | none | none | none | — |
| 8 | `default_prices` | ENABLE + FORCE | all approved employees | none | none | none | Price setting needs RPC |
| 9 | `shop_price_overrides` | ENABLE + FORCE | owner/admin **or** assigned | none | none | none | Salesperson can read own-shop price |
| 10 | `credit_controls` | ENABLE + FORCE | all approved employees | none | none | none | `reason` exposed to salespeople |
| 11 | `audit_events` | ENABLE (+FORCE→**removed**) | owner/admin | none | none (trigger) | none (trigger) | Writes require definer/service role |
| 12 | `sales` | ENABLE + FORCE | owner/admin **or** own **or** assigned shop | none | none | none | Colleagues' sales visible in shared shops (ME-11) |
| 13 | `sale_lines` | ENABLE + FORCE | via parent sale | none | none | none | — |
| 14 | `invoices` | ENABLE + FORCE | via sale | none | none | none | No immutability guard (HI-06) |
| 15 | `invoice_lines` | ENABLE + FORCE | via invoice→sale | none | none | none | — |
| 16 | `payments` | ENABLE + FORCE | owner/admin **or** recorder **or** assigned shop | none | none | none | Evidence path visible to shop peers |
| 17 | `payment_allocations` | ENABLE + FORCE | via payment | none | none (trigger) | none (trigger) | Caps unenforced (CR-01) |
| 18 | `payment_receipts` | ENABLE + FORCE | via payment | none | none (trigger) | none (trigger) | — |
| 19 | `inventory_movements` | ENABLE + FORCE | all approved employees | none | none (trigger) | none (trigger) | All shops' stock visible to all staff |
| 20 | `return_requests` | ENABLE + FORCE | owner/admin **or** own **or** assigned shop | none | none | none | — |
| 21 | `return_lines` | ENABLE + FORCE | via request | none | none | none | — |
| 22 | `expense_claims` | ENABLE + FORCE | owner/admin **or** own only | none | none | none | Correctly narrowest scope |
| 23 | `shop_ledger_entries` | ENABLE + FORCE | owner/admin **or** assigned shop | none | none (trigger) | none (trigger) | Receivables visible to salespeople (ME-11) |

**Verified against the matrix:**

| Requirement | Result |
|---|---|
| Salesperson cannot modify prices | Pass — no DML grant on price tables |
| Salesperson cannot approve payments/sales/returns/expenses | Pass — no DML, and no policy would allow it |
| Unauthorized inventory adjustment | Pass — no INSERT path at all |
| Disabled/pending user sees no business data | Pass — helper returns `NULL`; only own profile row is readable |
| Access to unassigned shops | Pass — `is_shop_assigned()` plus `submitted_by`/`recipient` fallbacks |
| Direct financial/ledger/invoice mutation | Pass — SELECT-only grants; append-only triggers on ledger, movements, allocations, receipts, invoice lines |
| Client-supplied role/status trusted | Pass — nothing reads JWT metadata or client role |
| Default deny | Pass — `REVOKE ALL` before grants, no permissive `USING (true)` anywhere |

**Policy overlaps / unintended access:** none found at row level. The only access questions are business decisions, not bugs: colleagues' sales in shared shops (ME-11), all-shop inventory visibility, and shop receivables visible to assigned salespeople.

---

## 6. Function security review

| Function | Definer | `search_path` | EXECUTE | Authorization inside | Verdict |
|---|---|---|---|---|---|
| `handle_new_auth_user()` L32–53 | Yes (required: writes `profiles` during auth insert) | `''` | revoked from PUBLIC/anon/authenticated | None needed; hardcodes `salesperson`/`pending` | Correct, but **broken by FORCE RLS** (HI-03) and can abort signup on an over-long name (fixed, F-03). No `ON CONFLICT`, so a pre-existing profile fails the signup (fixed). |
| `current_employee_role()` L56–69 | Yes (required: reads `profiles` under RLS) | `''` | revoked from PUBLIC/anon, granted to authenticated | Returns only the caller's own role, and only when `status = 'approved'` | Correct design; **recurses under FORCE RLS** (HI-03). No arguments, no dynamic SQL. |
| `is_shop_assigned(uuid)` L115–132 | Yes (required: reads assignments under RLS) | `''` | same | Joins on `auth.uid()`, requires approved status | Correct; under FORCE its result depends on the policy it supports, which is fragile (fixed). |
| `reject_immutable_change()` L242–251 | **No** (correct — trigger only) | `''` | revoked | n/a | Correct. Row-level only: `TRUNCATE` is not blocked (ME-08). |

No SQL injection surface: no dynamic SQL, no `format()`, all identifiers schema-qualified, all values bound. No unnecessary `SECURITY DEFINER`. No function grants `EXECUTE` to `anon`.

---

## 7. Financial integrity review

| Invariant (source) | Enforced? | Notes |
|---|---|---|
| Money is exact `NUMERIC(14,2)`, INR only | Yes | `numeric`, `char(3)` pinned to `'INR'` |
| Price resolved server-side, override before default | **No** | No resolver; snapshots can be any value |
| Sale totals equal the sum of lines | **No** | HI-05 |
| Tax components consistent with rate and base | **No** | HI-05; legal rules unresolved |
| Invoice equals the frozen sale | **No** | HI-05; one invoice per sale is enforced |
| Invoice/tax snapshots frozen after issuance | **No** | HI-06 |
| Unverified payments never reduce outstanding | **No** | CR-01 — allocations ignore payment status |
| A payment cannot be over-allocated | **No** | CR-01 |
| A sale cannot be over-collected | **No** | CR-01 |
| Allocation stays within one shop | **No** | CR-01 |
| Exactly one debit per confirmed sale | **No** (partly) | CR-02, fixed by C-06 |
| Exactly one credit per verified allocation / approved return | **No** (partly) | CR-02, fixed by C-06 |
| Credit is traceable to its source | **No** | CR-03, fixed by C-05 |
| Ledger outstanding = debits − credits | **Not computable** | No direction/reversal model (ME-05, ME-06) |
| Receipt only after verification | **No** | `payment_receipts` can be inserted for any payment; no constraint, no RPC |
| Sale confirmation, payment verification and invoice issuance are independent | **Yes** | Separate tables/status enums; invoice has its own `issued`/`voided` |
| Duplicate payment submission prevented | Partly | `payment_reference` + `(method, external_reference)` unique, but client-chosen (ME-10) |
| Expense totals exclude non-approved claims | **No** (query-level) | Correct if reports filter `status = 'approved'`; nothing enforces it |
| Invoice numbering | **No** | Client-supplied `text`; series/format pending legal review |

**The three defects that matter for money** are CR-01, CR-02 and CR-03. Each is a constraint/trigger gap, not a design disagreement, and each is fixable without new business rules. Until they are closed, any RPC that writes allocations or ledger rows will produce books that cannot be reconciled.

---

## 8. Inventory integrity review

| Requirement | Status |
|---|---|
| Append-only movements (no UPDATE/DELETE) | **Yes** — trigger, plus no grants; `TRUNCATE` remains possible for the owner |
| Carton-only quantities | Yes — `cartons integer`, no bottle column |
| 500 ml = 24 / 1 L = 12 reference data | Yes, as `bottles_per_carton` per variant; no seed data (Owner decision) |
| Stock derived from signed deltas | Yes — `SUM(cartons_delta)`, no mutable balance |
| Saleable vs damaged buckets | Yes — `inventory_bucket` plus type/sign CHECKs |
| Confirmed sale deducts stock exactly once | **Partially** — one movement per `(sale, variant)` after C-07; no per-line link, no status enforcement |
| Return disposal by condition | Yes at type level; no constraint that a `return_reusable` movement cites an approved return |
| Duplicate movement prevention | **Weak** — caller-supplied key only; improved by C-07 |
| Negative inventory prevention | **No** — HI-08 |
| Concurrent sale safety | **No** — HI-08 |
| Adjustment requires reason + idempotency | Reason yes; idempotency is any UUID, and direction is unconstrained (ME-05) |
| Reversal integrity | **Weak** — improved by C-07; sign and linkage to the reversed movement still unverified |

---

## 9. Audit and data-integrity review

- **Append-only enforcement** is solid for the six protected tables, at row level. `TRUNCATE` is not intercepted; a table owner can also `ALTER TABLE … DISABLE TRIGGER`. Treat audit as tamper-evident only against application roles, not against the database owner (ME-08).
- **Audit writes** have no grant and no policy; only `service_role` or a definer function can insert. That matches "controlled server workflows", but it also means the audit trail does not exist yet — no RPC writes it, and no trigger captures state changes.
- **Historical snapshots** exist for product/SKU/pack/price/tax and for seller/buyer, which is the right shape. They are not immutable on `invoices`/`payments` (HI-06).
- **Referential integrity** is strong: explicit FKs, `ON DELETE RESTRICT`, composite FKs linking `return_lines` to both the request and the original sale line, `UNIQUE (id, sale_id)` support keys.
- **Immutability vs. state machines:** `sales`, `payments`, `invoices`, `return_requests` and `expense_claims` legitimately need `UPDATE`, but only for their status transitions. No guard trigger restricts *which* columns may change, so "immutable once confirmed/issued/verified" is a comment, not a constraint.
- **Soft deletion:** employees, products and shops are deactivated rather than deleted — correct — but `products`/`product_variants` use a bare `active` flag and `profiles` uses `status`; there is no uniform archive convention. Acceptable.
- **Timezones:** all instants are `timestamptz`; business dates are plain `date` with no derivation (ME-12).
- **Employee exit:** disabling blocks RLS immediately (helper returns `NULL`), history is preserved through `RESTRICT`, and no assignment cleanup exists (no write path). Sessions are not revoked by the database — that is an application/Auth concern.

---

## 10. Supabase compatibility

| Area | Assessment |
|---|---|
| `auth.users` integration | FK is correct and cascade-safe (RESTRICT). `ON DELETE RESTRICT` blocks admin deletion (ME-07). |
| Signup trigger | Correct pattern, but collides with any existing trigger; a duplicate insert fails signup (HI-11). Needs reconciliation and a backfill decision for existing users. |
| Existing `profiles` | **Collision.** The app already reads `profiles` and updates `status` directly. The migration neither preserves nor replaces that contract. |
| `update_my_avatar` RPC | Not defined here; the app calls it. Must survive the migration untouched. |
| Managed roles | `anon`, `authenticated` assumed present (correct on Supabase). `service_role` retains default `ALL` privileges — it is the only current write path and must stay server-side (AGENTS.md). |
| Schema exposure | `supabase/config.toml` exposes `public` and sets `extra_search_path = ["public","extensions"]`, so the `extensions` schema resolves for API requests; the migration role's own path must be verified for the `btree_gist` opclasses. |
| Extensions | `btree_gist` only; no `pgcrypto` requirement (`gen_random_uuid()` is core). No Storage objects, buckets or policies are created, yet four columns assume private objects (ME-09). |
| Migration conventions | Filenames are correctly ordered and the second file depends on the first. Each migration is one transaction, so a failure leaves the previous version — but the two blockers mean version 2 never lands at all. |
| Non-idempotency | `CREATE TYPE`/`CREATE TABLE`/`CREATE POLICY` are unguarded by design ("clean schema"). Acceptable for a disposable local instance, not for staging. |
| Empty-schema assumption | The architecture doc already warns that staging's `public` schema is not empty. The drafts, as written, cannot run there. |

---

## 11. Risk register

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| CR-01 | Over-allocated / unverified payment settles debt | High once RPCs exist | Severe, silent | Locked verification RPC + guard triggers; no allocation grant until tested | Eng |
| CR-02 | Duplicate ledger entry double-counts receivable/collection | Medium | Severe, permanent | Partial unique indexes (applied) + deterministic idempotency | Eng |
| CR-03 | Untraceable or misattributed ledger entry | Medium | Severe, audit failure | Type↔source CHECK (applied) + shop consistency trigger | Eng |
| HI-03 | Auth outage / recursion, or no enforcement at all | High if applied as-is | Total | FORCE decision + role model (partial fix applied) | Eng + Infra |
| HI-01/HI-02 | Migration 2 cannot apply | Certain | Blocks Phase 1 | Fixed in review copies | Eng |
| HI-11 | Existing schema collision, broken owner approval | Certain on staging | Blocks rollout | Stage B audit, reconciled migration, status RPC | Eng + Owner |
| HI-06 | Issued invoice can be rewritten | Low (needs owner/service role) | Legal/audit | Immutability guard | Eng + Accountant |
| HI-08 | Negative stock under concurrency | Medium | Inventory/financial drift | Locking confirmation RPC | Eng |
| ME-09 | Storage objects readable outside policy | Unknown | Privacy | Bucket + `storage.objects` policies | Eng |
| ME-07 | Cannot delete a user | Medium | Operational/privacy | Archival path | Owner |

---

## 12. Corrections applied to the review copies

Originals are **unchanged**. Hashes (SHA-256, first 12 hex):

| File | Original | Review copy |
|---|---|---|
| `…_phase1_foundation.sql` | `5fa5bf02753c` | `22a2f6f12413` |
| `…_phase1_commerce_ledgers.sql` | `dc00a7ca9f41` | `2f56a8536a36` |

Every change is marked in-file with `REVIEW FIX <id>` and a rationale.

| ID | Finding | Change | Risk of the change |
|---|---|---|---|
| F-01 | HI-03 | `FORCE ROW LEVEL SECURITY` removed from `profiles`, `shop_salespeople`, `audit_events` (ENABLE kept, FORCE kept elsewhere) | Low; restores the documented behaviour. Paired with an open infra decision. |
| F-02 | ME-01 | `CHECK ((status='approved') = (approved_by IS NOT NULL) OR status='disabled')` | Low; strictly tightens. Existing rows must satisfy it. |
| F-03 | HI-03 / LO-03 | `handle_new_auth_user()` clamps the name to 160 chars and uses `ON CONFLICT (id) DO NOTHING` | Low; prevents aborted signups |
| F-04 | ME-01 | Credit block requires `changed_by` | Low |
| F-05 | HI-11 | Header documents the schema collision; no DDL change | None |
| C-01 | HI-01 | `return_requests` CHECKs use only real enum labels; redundant check removed | Low |
| C-02 | HI-02 | Duplicate `audit_read_admin` policy removed | None |
| C-03 | HI-03 | `FORCE` not re-applied to `audit_events` (removed in the foundation copy) | Low |
| C-04 | HI-04 | Expense review evidence required for all non-`submitted` states; `reviewed_by` in step | Medium — see the "void before review" note |
| C-05 | CR-03 | `shop_ledger_entries` type↔source mapping CHECK | Low; may reject a mis-typed adjustment |
| C-06 | CR-02 | Three partial unique indexes on the ledger | Low |
| C-07 | HI-07 | Reversal target required + unique; one sale movement per `(sale, variant)`; non-blank `source_type`; no self-reversal | Low |
| C-08 | ME-03 | Additive `cancelled_at/by` (returns), `voided_at/by` (expenses) + checks | Medium — schema addition, needs Owner acceptance |
| C-09 | ME-02 | `reviewed_by <> submitted_by` for expenses | Low |
| C-10 | HI-06 | Issued invoices cannot carry void metadata | Low |
| C-11 | LO-01 | Index on `return_requests(shop_id)` | None |

**What was deliberately not changed:** allocation caps, verified-payment requirement, cross-shop consistency, total arithmetic, negative-stock locking, adjustment direction/reversal linkage, invoice immutability trigger, PDF outbox, refund/credit-note rules, tax. Each needs either a locked transaction function or an accounting/business decision; inventing them in a review copy would hide the decision. They are listed in the required-invariants block at the end of the commerce review copy and in §13.

**Both review copies remain unexecuted.** No PostgreSQL parser was available locally, so they are lexically and structurally checked only (§14), not grammar-validated.

---

## 13. Unresolved decisions requiring Owner approval

1. **FORCE RLS vs. definer ownership model** (HI-03) — restore FORCE with a `BYPASSRLS` function owner, or accept owner exemption. This determines the authorization guarantee.
2. **First Owner bootstrap** — no row can be created without a trusted procedure; there is no seeded owner.
3. **Schema reconciliation** — what happens to the existing `profiles` rows, the existing signup trigger and `update_my_avatar`.
4. **Owner approval RPC** — replacing the app's direct `profiles.update({status})`, including who may approve whom and whether self-approval is ever allowed.
5. **Payment allocation policy** (CR-01) — allocation order, unapplied credit treatment, overpayment handling, and whether an admin may verify a payment they recorded.
6. **Reversal/void model** (ME-05, ME-06) — signed adjustments vs. contra entry types, and the reversal link.
7. **Return economics** (HI-09) — cash refund vs. credit note, zero-quantity approvals, damaged-stock valuation.
8. **Tax/GST and invoice numbering** — mode, rates, HSN/SAC, rounding, series, credit/debit notes, retention.
9. **Visibility of colleagues' sales, shop payables/receivables and all-shop inventory** to salespeople (ME-11).
10. **Storage** — bucket names, path conventions and object-level policies for photos, evidence, receipts and invoice PDFs (ME-09).
11. **Employee deletion/archival** (ME-07) — whether `auth.users` deletion is ever permitted.
12. **Expense "void before review"** — whether a voided claim must still carry review evidence (C-04).

---

## 14. Static validation performed

| Check | Method | Result |
|---|---|---|
| Statement structure | Custom lexer: strips `--` comments, handles `'…'`, `$tag$…$tag$`; splits on `;`; compares `(`/`)` per statement | 0 unbalanced parentheses, 0 unterminated literals/comments across all four files |
| Statement counts | Same tool | Foundation 84 → 81 (−3 `FORCE` statements); commerce 95 → 99 (−2 removed, +6 indexes) — all accounted for |
| DDL blockers | Targeted grep on the reviewed copies | No remaining `'paid'/'voided'` in `return_requests`; exactly one `audit_read_admin` policy; zero `FORCE` on the three affected tables |
| Originals unmodified | SHA-256 before/after | Identical (`5fa5bf02753c…`, `dc00a7ca9f41…`) |
| Grants/policies traced | Manual, table by table | §5 matrix |
| Secret literals in migrations | grep for keys/tokens/URLs | None |
| PostgreSQL grammar/runtime | **Not performed** | No server, no parser, no execution |
| RLS behaviour | **Not performed** | Requires a disposable local instance |

**Explicitly not claimed:** the migrations compile, the constraints are satisfiable, the policies behave as documented, or RLS has been tested. Those are Stage C/D gates.

---

## 15. Readiness recommendation

**Do not execute either draft against the local, staging or production database in their current form.**

| Question | Answer |
|---|---|
| Is this a sound design baseline? | **Yes** — schema, role model and default-deny posture match the documentation closely |
| Is it applicable today? | **No** — two DDL blockers, an incoherent FORCE-RLS model, and a collision with the existing schema |
| Is it secure for browser clients? | **Yes as far as it goes** — no client write path exists; the residual risk is that the future RPC layer inherits unenforced invariants |
| Is it financially correct? | **Not yet** — three ledger/allocation invariants have no representation |
| Is it testable end-to-end? | **No** — no RPCs, so no sale, payment, return, expense or audit row can be created |

**Readiness: RED for execution, AMBER for design.**

Gates, in order:

1. **Owner decision log** — items 1–3 and 5 in §13 (blocking).
2. **Stage B compatibility audit** — read-only metadata comparison on staging; produce the reconciliation plan.
3. **Convert to a reconciled, expand-first migration** — handle existing `profiles`, trigger and `update_my_avatar`; make the package idempotent for staging use.
4. **Disposable local database** — apply the reviewed copies, fix any grammar/constraint failures, then run the RLS matrix (anon, pending, approved owner/admin/salesperson, disabled, assigned/unassigned, reassigned, cross-record ID tampering).
5. **Stage E functions** — one locked, idempotent, audited transaction per workflow, with the §7–§8 invariants implemented and negative/concurrency tests.
6. **Only then** restore `FORCE` decision, grants and UI integration.

**Exact next step:** obtain Owner sign-off on the FORCE-RLS model and the reconciliation scope (§13 items 1–3), then run the approved read-only Stage B audit; do not execute these drafts before that.
