# Phase 1 — Database Architecture

**Status:** Design and unexecuted migration drafts. No database was contacted or tested.  
**Scope:** One Ethereal Co. business; not a multi-tenant SaaS design.  
**Proposed deployment schema:** `public`, Supabase Auth at `auth.users`, PostgreSQL `NUMERIC` money, INR, `Asia/Kolkata`.

## Repository baseline and compatibility boundary

The repository is a React 19/Vite 8 JavaScript SPA with `@supabase/supabase-js`; it has no router, application test suite, or business migrations. `src/lib/supabase.js` uses only `VITE_SUPABASE_URL` and a publishable/anon key. Never place a service-role secret in a `VITE_` variable. `src/App.jsx` reads `profiles` by `id`, expects `full_name`, `email`, `role`, `status`, `avatar_url`, supports email/password signup/sign-in, pending/approved/disabled UI, owner approval, and `update_my_avatar`; commercial views remain placeholders. `supabase/config.toml` is local configuration, not evidence of remote schema. Earlier Phase 0 reports observed a profiles table with those fields, but this was not re-verified in this phase. Read-only audit and role scripts are not migrations and must remain separate.

The two SQL files in `supabase/migrations/` are **proposal drafts only**. They assume a clean schema except for Supabase-managed `auth` objects and an empty `public` business schema. They are not safe to apply to the current project until an owner-authorized metadata review confirms/reconciles existing `profiles`, RPCs, triggers, grants, storage policies, and migration history. In particular, the proposed profile trigger and existing `update_my_avatar`/bucket behavior need deliberate integration rather than blind replacement.

## Design principles

- One organization is implicit; do not add `business_id` or tenant membership tables.
- UUID primary keys; `auth.users(id)` is the authority for identity. Profile role/status are server-managed.
- UTC `timestamptz` event instants; derive operational business dates using `Asia/Kolkata` in trusted server/database logic.
- Money uses `numeric(14,2)` in INR. Tax rates and invoice numbering/legal requirements remain unresolved; preserve reviewed tax snapshots without inventing rates.
- Cartons are the sale/inventory unit. Product pack quantities are 24 bottles/carton (500 ml) and 12 bottles/carton (1 L); these defaults are explicit reference data, not conversions permitting loose sales.
- Sales, payment verification, invoice issuance, return approval, and inventory movement are separate state machines/records.
- Financial and inventory history is append-only. Corrections are compensating entries with actor, reason, and audit reference.
- RLS defaults to deny. A browser-provided role, product price, totals, approval state, or inventory balance is never authoritative.

## Entity relationship overview

```text
auth.users 1──1 profiles
profiles 1──* shops (submitted_by; primary_salesperson)
shops *──* profiles via shop_salespeople
products 1──* product_variants 1──* price_records
shops + product_variants 1──* shop_price_overrides
shops 1──* sales ──* sale_lines *──1 product_variants
sales 1──* payments ──* payment_allocations (allocation target is sale)
sales 1──* return_requests ──* return_lines
sales ──* inventory_movements (sale/return source references)
product_variants 1──* inventory_movements
profiles 1──* expense_claims; expense_claims 1──* expense_attachments (optional future)
profiles 1──* audit_events (actor); audit_events reference business records polymorphically
sales 1──0..1 invoices; sales 1──* invoice_lines (snapshot)
payments 1──0..1 receipts (issued only after verification)
```

## Proposed table catalogue

Notation: `PK` primary key, `FK` foreign key, `UQ` unique. `created_at`/`updated_at` are `timestamptz`; IDs use `uuid DEFAULT gen_random_uuid()` where not Auth-derived.

### Identity and assignment

| Table | Columns and constraints |
|---|---|
| `profiles` | `id uuid PK FK auth.users(id) ON DELETE RESTRICT`; `full_name text NOT NULL`; `email text NOT NULL` (display/contact copy, not auth authority); `role app_role NOT NULL DEFAULT 'salesperson'`; `status employee_status NOT NULL DEFAULT 'pending'`; `avatar_url text`; `created_at`, `updated_at`; `approved_by uuid FK profiles(id)`, `approved_at timestamptz`, `disabled_at timestamptz`. Role/status writes are owner/admin-only via controlled workflow; public signup cannot nominate role. |
| `shop_salespeople` | `shop_id uuid FK shops ON DELETE RESTRICT`; `salesperson_id uuid FK profiles ON DELETE RESTRICT`; `is_primary boolean NOT NULL DEFAULT false`; `assigned_by uuid FK profiles`; `assigned_at timestamptz`; composite PK `(shop_id,salesperson_id)`. Partial unique index on `shop_id WHERE is_primary`. Constraint verifies assigned profile is an approved salesperson in workflow code/trigger. A single primary is required for approved shops by approval function; pending shops may have none. |

Enums proposed: `app_role(owner,admin,salesperson)`, `employee_status(pending,approved,disabled)`. Do not expose direct enum changes from the client.

### Shops, catalog, and pricing

| Table | Columns and constraints |
|---|---|
| `shops` | `id uuid PK`; `name text NOT NULL`; `phone text`, `email text`, `address_line1 text`, `address_line2 text`, `locality text`, `city text`, `state text`, `postal_code text`; `latitude numeric(9,6)`, `longitude numeric(9,6)` with paired/range checks; `status shop_status NOT NULL DEFAULT 'pending'`; `notes text`; `submitted_by uuid FK profiles`; `reviewed_by uuid FK profiles`; `reviewed_at timestamptz`; `rejection_reason text`; timestamps. Photos belong in private Storage bucket metadata/path references, not bytea. Visit history in `shop_visits`. |
| `shop_visits` | `id uuid PK`; `shop_id FK shops`; `visited_by FK profiles`; `visited_at timestamptz`; `visit_note text`; optional location; timestamps. Append-only except narrowly controlled correction. |
| `shop_photos` | `id uuid PK`; `shop_id FK shops`; `storage_path text UNIQUE NOT NULL`; `uploaded_by FK profiles`; `caption text`; `created_at`; Storage bucket private, access follows shop role/assignment. |
| `products` | `id uuid PK`; `name text UNIQUE NOT NULL`; `active boolean NOT NULL DEFAULT true`; timestamps. Seed names 500 ml and 1 litre only after owner confirmation. |
| `product_variants` | `id uuid PK`; `product_id FK products`; `sku text UNIQUE NOT NULL`; `pack_size_ml integer NOT NULL CHECK > 0`; `bottles_per_carton integer NOT NULL CHECK > 0`; `active boolean`; timestamps; `UNIQUE(product_id,pack_size_ml,bottles_per_carton)`. Initial carton counts: 24 and 12. |
| `default_prices` | `id uuid PK`; `variant_id FK product_variants`; `amount numeric(14,2) NOT NULL CHECK >= 0`; `valid_from timestamptz NOT NULL`; `valid_to timestamptz`; `set_by FK profiles`; `created_at`; `CHECK(valid_to IS NULL OR valid_to > valid_from)`. No overlapping effective periods per variant (enforce in trusted price-setting function using exclusion constraint or serialized validation). |
| `shop_price_overrides` | `id uuid PK`; `shop_id FK shops`; `variant_id FK product_variants`; `amount numeric(14,2) NOT NULL CHECK >= 0`; `valid_from`, `valid_to`; `set_by FK profiles`; `created_at`; same period checks. Trusted price resolver selects applicable shop override, else default; reject missing/ambiguous price. Historical sale line snapshots do not change when price records change. |
| `credit_controls` | Singleton row `id boolean PK DEFAULT true CHECK(id)`; `blocked boolean NOT NULL DEFAULT false`; `reason text`; `changed_by FK profiles`; `changed_at timestamptz`. Owner/Admin only. No numeric credit limit. This blocks new credit sales only; cash/UPI unaffected. |

### Sales, invoices, payment, and receivables

| Table | Columns and constraints |
|---|---|
| `sales` | `id uuid PK`; `sale_number bigint UNIQUE` assigned transactionally; `shop_id FK shops`; `salesperson_id FK profiles`; `status sale_status NOT NULL DEFAULT 'draft'` (`draft`, `pending_credit_approval`, `confirmed`, `rejected`, `cancelled`); `payment_terms payment_terms NOT NULL` (`cash`, `upi`, `credit`); `business_date date NOT NULL`; `submitted_at`; `confirmed_at`; `confirmed_by FK profiles`; `rejected_at/by/reason`; `cancelled_at/by/reason`; `currency char(3) NOT NULL DEFAULT 'INR' CHECK currency='INR'`; `subtotal numeric(14,2)`, `tax_total numeric(14,2)`, `grand_total numeric(14,2)` nonnegative; GST mode/snapshot fields are stored only after the tax policy is approved; timestamps. Cash/UPI confirm as part of trusted creation transaction; credit stays pending until owner/admin approval. |
| `sale_lines` | `id uuid PK`; `sale_id FK sales ON DELETE RESTRICT`; `variant_id FK product_variants`; `cartons integer NOT NULL CHECK cartons > 0`; `unit_price_snapshot numeric(14,2) NOT NULL CHECK >= 0`; `line_subtotal numeric(14,2) NOT NULL CHECK >= 0`; tax code/rate/amount snapshots nullable until approved; `created_at`; `UNIQUE(sale_id,variant_id)` unless repeated lines are explicitly required. No bottle quantity input. Validate each line amount and totals server-side with exact numeric arithmetic. |
| `invoices` | `id uuid PK`; `sale_id FK sales UNIQUE`; `invoice_number text UNIQUE NOT NULL`; `status invoice_status` (`issued`, `voided`); `issued_at`; `issued_by`; immutable seller/buyer identity/address snapshot, currency, GST/non-GST mode, taxable/tax component totals and grand total snapshots; PDF `storage_path`; void actor/reason/time. One invoice per confirmed sale in initial policy; corrections use credit/debit note workflow after legal review, never rewrite issued PDF. |
| `invoice_lines` | `id uuid PK`; `invoice_id FK invoices`; product/SKU/name/pack snapshot; `cartons`; unit price, subtotal, tax classification/rate/components/amount, total snapshots; all monetary fields NUMERIC. Immutable after issuance. |
| `payments` | `id uuid PK`; `payment_reference uuid NOT NULL UNIQUE` (client retry idempotency key); `shop_id FK shops`; `recorded_by FK profiles`; `method payment_method` (`cash`,`upi`,`bank_transfer`); `amount numeric(14,2) NOT NULL CHECK > 0`; `received_at timestamptz`; `status payment_status` (`submitted`,`verified`,`rejected`,`reversed`); external reference/UPI transaction reference; `verified_by`, `verified_at`, rejection reason; timestamps. Salespeople may submit; Owner/Admin verifies. Only verified payments contribute to collections/outstanding. A verified payment is not editable; reversal is a separately authorized compensating record/transition. |
| `payment_allocations` | `id uuid PK`; `payment_id FK payments ON DELETE RESTRICT`; `sale_id FK sales ON DELETE RESTRICT`; `amount numeric(14,2) CHECK > 0`; `created_at`; `UNIQUE(payment_id,sale_id)`; payment allocations cannot exceed verified payment amount or sale outstanding (serialized verification/allocation transaction). Can allocate one payment across multiple sale invoices; unallocated verified balance is an unapplied customer credit pending defined accounting policy. |
| `payment_receipts` | `id uuid PK`; `payment_id FK payments UNIQUE`; `receipt_number text UNIQUE`; `issued_at`; immutable amount/method/shop snapshot; PDF storage path. Issue only after verification. |

### Inventory and returns

| Table | Columns and constraints |
|---|---|
| `inventory_movements` | `id uuid PK`; `variant_id FK product_variants`; `movement_type` (`opening`,`received`,`sale`,`damage`,`return_reusable`,`return_damaged`,`adjustment`,`reversal`); `cartons_delta integer NOT NULL CHECK <> 0`; `source_type`, `source_id`; `idempotency_key text UNIQUE`; `occurred_at`; `actor_id FK profiles`; `reason text`; `reverses_movement_id FK inventory_movements`; `created_at`. Positive receives/reusable returns; negative confirmed sales/damage/adjustments as appropriate. Append-only. A trigger rejects UPDATE/DELETE; narrowly scoped functions insert movements. Current stock is `SUM(cartons_delta)`, optionally materialized later with reconciliation. |
| `return_requests` | `id uuid PK`; `sale_id FK sales`; `shop_id FK shops`; `submitted_by FK profiles`; `status return_status` (`submitted`,`approved`,`rejected`,`cancelled`); submitted/reviewed timestamps and actor; reason; `UNIQUE(id,sale_id)` for line FK support. Must reference original confirmed sale and same shop. |
| `return_lines` | `id uuid PK`; `return_request_id`; `sale_id`; `sale_line_id FK sale_lines`; `variant_id FK product_variants`; `cartons integer CHECK > 0`; `condition return_condition` (`reusable`,`damaged`); `approved_cartons integer CHECK >= 0`; `created_at`; composite FK `(return_request_id,sale_id)`; validation prevents cumulative approved returns exceeding sold cartons less prior approved returns. Approval creates inventory movement (`return_reusable` increases stock; damaged return goes to damaged/segregated stock) and a shop-ledger credit/adjustment in the same transaction. |

Inventory convention requiring sign-off: stock is measured in saleable cartons, with reusable-return stock and damaged stock tracked separately (either by movement reason/derived balance or explicit disposition balance). Damage causes negative saleable stock. Returned damaged product does not replenish saleable stock.

### Expenses, shop ledger, reporting, and audit

| Table | Columns and constraints |
|---|---|
| `expense_claims` | `id uuid PK`; `claim_reference uuid UNIQUE` idempotency key; `submitted_by FK profiles`; `expense_date date`; `category text` from owner-managed allow-list; `description text`; `amount numeric(14,2) CHECK > 0`; `status expense_status` (`submitted`,`approved`,`rejected`,`paid`,`voided`); reviewer/time/reason; receipt private storage path; timestamps. Only approved claims enter expense reports; `paid` is separate future settlement state. |
| `shop_ledger_entries` | `id uuid PK`; `shop_id FK shops`; `sale_id FK sales`; optional `payment_allocation_id FK payment_allocations`; optional `return_request_id FK return_requests`; `entry_type` (`sale_debit`,`payment_credit`,`return_credit`,`adjustment`); `amount numeric(14,2) NOT NULL CHECK >= 0`; `entry_date`; `idempotency_key text UNIQUE`; `created_by`; `created_at`; immutable. Entries are produced by trusted workflows; outstanding = confirmed sale debits minus verified payment allocations and approved return credits, subject to owner-approved accounting rules. |
| `audit_events` | `id bigint GENERATED ALWAYS AS IDENTITY PK`; `actor_id uuid FK profiles`; `action text`; `entity_type text`; `entity_id uuid`; `occurred_at timestamptz DEFAULT now()`; `request_id uuid`; `safe_metadata jsonb NOT NULL DEFAULT '{}'`; no secrets/payment credentials; INSERT-only from controlled server workflows, no client UPDATE/DELETE. Audit is supplementary, not the accounting ledger. |

Reports are read-only views/queries over confirmed sales, verified allocations, approved expenses, ledger/movements. Weekly/monthly/yearly grouping uses `Asia/Kolkata` business date. Revenue, collections, expenses, outstanding, profit, shop/salesperson sales, and inventory require owner-approved definitions (especially tax, returns, cost of goods, and payment timing). No targets in Phase 1.

## Relationships, constraints, and indexes

All listed references use explicit FKs and restrictive deletion for records referenced by financial history. Employees/products/shops are deactivated, not deleted. Index every FK used in joins and policies. Proposed indexes include:

- `profiles(role,status)`; partial index for approved employees.
- `shops(status,created_at DESC)`; `shop_salespeople(salesperson_id,shop_id)` plus unique primary-per-shop partial index.
- `product_variants(product_id,active)`; prices `(variant_id,valid_from DESC)` and overrides `(shop_id,variant_id,valid_from DESC)`.
- `sales(business_date,status)`, `(shop_id,business_date)`, `(salesperson_id,business_date)`, `(status,submitted_at)`; `sale_lines(sale_id)`.
- `payments(shop_id,received_at)`, `(status,received_at)`, `payment_allocations(sale_id)`.
- `inventory_movements(variant_id,occurred_at DESC)`, `(source_type,source_id)`, unique idempotency key.
- `return_requests(sale_id,status)`, `return_lines(sale_line_id)`.
- `expense_claims(status,expense_date)`, `(submitted_by,expense_date)`.
- `shop_ledger_entries(shop_id,entry_date)`, `audit_events(entity_type,entity_id,occurred_at DESC)`.

No overlapping price periods: migration draft uses an exclusion constraint on `(variant_id WITH =, tstzrange(valid_from,valid_to,'[)') WITH &&)` and equivalent for shop+variant, requiring `btree_gist`; deployment must confirm extension availability/ownership. If that extension is not acceptable, use serialized price-change RPC with explicit overlap check and lock.

## Critical transaction/ledger rules

1. Trusted sale-create operation resolves shop-specific price then default; locks relevant price/control and available stock; derives business date and all totals; ignores client prices/totals. Cash/UPI confirmation, sale rows/lines, sale inventory movements, shop debit, invoice snapshot, and audit event commit atomically. If any step fails, none commits. For insufficient stock, reject; no negative stock.
2. Credit create checks global credit-block flag, creates `pending_credit_approval` only, and reserves/decrements no stock until approval. Owner/Admin approval rechecks stock and credit-block state under lock, confirms sale and creates stock movements/ledger/invoice atomically.
3. Payment submission only records a claim. Verification is a server-authorized atomic operation, idempotent by payment reference, checks allocation amounts and duplicate external references where provided, then writes verified state, allocations, shop credits, receipt and audit event atomically. Duplicate retries return existing result without a second ledger effect.
4. Return submission has no stock/ledger effect. Approval locks sale/lines, validates remaining refundable/saleable quantity, records condition/disposition, inserts compensating movements and shop credit, then updates request status/audit in one transaction.
5. Expense approval changes workflow state and emits audit event; only approved status appears in expense reports. Rejection reason is required.
6. Inventory adjustments require Owner/Admin, positive/negative movement, nonempty reason and idempotency key; no direct balance update. Opening balance is one audited movement per variant at cutover.

The SQL drafts define tables, constraints, indexes, RLS baseline and append-only triggers. They deliberately do **not** yet expose financial RPCs or a GST calculation/invoice issuer: those require decisions listed below and integration with current schema/Auth. Until those narrowly scoped functions and tests exist, business writes should remain unavailable. A schema draft is not production-ready authorization.

## Security boundary

Enable and force RLS on every browser-exposed business table; no policy means deny. Supabase `authenticated` role is not sufficient: every allow rule also requires an active (`approved`) profile. Owner/Admin/Salesperson role comes from server-managed `profiles`, never JWT user metadata or client form input. Salespeople are limited to assigned shops and their own submissions. Financial confirmation, verification, approvals, role assignment, returns, inventory, invoice issuance and audit writes require trusted RPC/backend workflows. Do not grant direct mutation that bypasses them. Storage buckets are private; object paths are checked against approved shop/employee access. Service role is server-only and bypasses RLS; minimize use and audit it.

## Unresolved owner decisions

Tax/GST mode fields and historical snapshots are modeled, but GST rates, place-of-supply rules, HSN/SAC, tax inclusive/exclusive pricing, invoice numbering, credit/debit notes, and statutory retention/export require accountant/legal review. Confirm product names/SKUs, default prices, stock unit and opening inventory, whether price is per carton, shop-price date boundaries, cash/UPI sale auto-confirmation/payment semantics, credit approval and block behavior for already pending sales, payment allocation order and unapplied credits, refund/cash handling on returns, damage stock disposition, invoice PDF template/signature, supplier receipts, expense categories/attachment rules, user invite mechanism, whether Admin may approve other Admins, owner succession/multiple owners, data retention, backup and restoration RPO/RTO. Do not infer legal compliance from this proposal.
