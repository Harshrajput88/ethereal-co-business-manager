# Ethereal Co. Business Manager â€” Target Architecture

**Status:** Proposed design for review; not an assertion about the hosted database.
**Evidence baseline:** Repository inspection and Phase 0 reports. No database was accessed for this package.

## Verified today

The React/Vite app has email/password sign-up and sign-in, session handling, pending/approved/disabled account states, an owner approval flow, profile/avatar UI, and a dashboard shell. Commercial pages are largely placeholders or hardcoded. `src/lib/supabase.js` initializes the browser client from environment configuration. Existing repository files do not establish the hosted schema, policies, grants, triggers, or migration history. Earlier reports observed a `profiles` table with `id`, `full_name`, `email`, `role`, `status`, `created_at`, and `avatar_url`; re-verify this with the read-only audit before relying on it.

## Proposed platform boundaries

- **Public website:** public marketing pages, product information, lead/contact forms. No authenticated business data or privileged Supabase key in the browser. Public forms should submit through a constrained server/edge endpoint with abuse controls.
- **Private business PWA:** authenticated React application for approved staff; responsive, installable, and offline-tolerant for read-only/reference views. Business writes require connectivity and server-confirmed authorization. Offline writes must not be silently queued as final transactions.
- **Backend:** Supabase Auth plus Postgres with RLS, migrations, and narrowly scoped RPC/Edge Functions for privileged workflows. Service-role credentials remain server-side. Audit business mutations and preserve transaction history.
- **Shared identity, separated authorization:** use Auth identity and a profile/membership record. Do not trust a client-supplied role. Approval and role changes are owner-controlled and audited.

## Proposed data model

All objects below are proposals pending metadata and business review.

| Area | Proposed entities and key relationships |
|---|---|
| Identity | `profiles(auth_user_id PK/FK auth.users, full_name, email, avatar_path, account_status, created_at, updated_at)`; role should preferably be represented through `memberships`/role assignments rather than a freely editable profile field. |
| Organization | `businesses(id, name, timezone, currency_code)`; `memberships(business_id, user_id, role, status)` unique on business/user. Initial roles: owner, admin, salesperson. |
| Catalog | `products(id, name, active)`; `product_variants(id, product_id, pack_size, units_per_carton, active)`; `price_lists` and effective-dated `shop_prices(shop_id, variant_id, amount, valid_from, valid_to)`. |
| Customers | `shops(id, business_id, name, address/contact, assigned_user_id, active)`; salesperson access is constrained to assigned shops unless explicitly granted broader scope. |
| Sales | `sales_orders(id, business_id, shop_id, salesperson_id, business_date, status, totals, created_at)` and `sales_order_lines(order_id, variant_id, quantity, unit_price_snapshot, line_total)`. Snapshot price at order time; use constraints for positive quantities and valid totals. |
| Payments/receivables | `payments(id, order_id, amount, method, paid_at, reference)`; `payment_allocations` where payments can cover multiple invoices; derive outstanding amounts or maintain a reconciled ledger. Cash/UPI are proposed options, not verified requirements. |
| Inventory | `inventory_movements(id, business_id, variant_id, quantity_delta, reason, source_type, source_id, occurred_at, actor_id)` as append-only ledger; optional stock balance projection maintained transactionally. |
| Governance | `audit_events(id, business_id, actor_id, action, entity, entity_id, occurred_at, safe_metadata)` append-only; avoid storing secrets or unnecessary personal data. |

### Proposed constraints and indexes

Use UUID keys and explicit foreign keys; `NOT NULL` where required; unique business-scoped identifiers; checks for positive quantities, nonnegative prices/amounts, valid status/method values, and coherent effective-date ranges. Use `NUMERIC` for money, never floating point. Index foreign keys and common filters: `(business_id, business_date)`, `(business_id, shop_id, business_date)`, `(business_id, salesperson_id, business_date)`, `(order_id)`, and inventory `(business_id, variant_id, occurred_at)`. Add partial indexes only after query patterns are measured. Prefer restrictive deletion/soft deactivation for referenced commercial entities.

## Authorization and RLS proposal

Enable and force RLS where appropriate; default deny. Policies should scope every business row by authenticated membership in the same `business_id`, and enforce active membership/account status. Keep policy helper functions minimal, schema-qualified, stable where appropriate, and not dynamically executable by untrusted users. Avoid recursive policy lookups; review `SECURITY DEFINER` ownership, search path, execute grants, and function body.

| Role | Proposed access |
|---|---|
| Owner | Full business administration, membership/approval and role management, configuration, all commercial records, reports, and audited corrections. |
| Admin | Day-to-day catalog, shops, pricing, orders, payments, and inventory; cannot transfer ownership or alter owner membership. |
| Salesperson | Read permitted catalog/prices and own/assigned shops; create own orders and permitted payment records; no membership, pricing, or global financial administration. |

Profile users may edit only safe self-service fields. Users must not update their own role, approval status, business membership, order totals, payment reconciliation, or inventory balance directly. Route high-impact changes through validated transactions/RPCs. Storage avatar policies should scope paths to the authenticated user; private business documents remain private and use short-lived authorized URLs.

## Frontend continuity and replacement

Retain existing sign-in/session experience, pending/disabled states, profile/avatar flow, and dashboard shell where compatible after security review. Replace hardcoded commercial data and placeholder pages with typed data access, explicit loading/empty/error states, and server-authorized workflows. Do not presume current visual placeholders represent finalized requirements. Separate public routes/build surface from the private PWA; avoid exposing internal navigation or private customer data on public pages. Preserve accessibility, mobile behavior, and existing branding while adding automated regression coverage.

## Decisions required before implementation

Confirm business/legal entity and tenant model; role boundaries and salesperson shop assignment; product packaging/SKUs; units and conversion rules; price override/effective-date semantics; order lifecycle and edit/cancel rules; returns/wastage; credit terms and payment allocation; inventory source of truth; timezone and business-day cutoff; tax/invoice requirements; data retention/export; attachment needs; offline expectations; approval/recovery procedures; and reporting definitions. Prior reports mention 500 ml/24-per-carton, 1 litre/12-per-carton, INR, and Asia/Kolkata as assumptions to confirmâ€”not established facts.
