# Phase 1 — Permission Matrix and RLS Design

**Proposed for one Ethereal Co. business.** This is a design specification, not evidence that current hosted RLS matches it. No database was queried.

## Roles and invariants

| Role | Scope |
|---|---|
| Owner | Full business oversight, role/employee governance, all shops, prices, sales, payments, inventory, returns, expenses, invoices and reports. Sole authority for owner succession and destructive/security-critical operations. |
| Admin | Operational control across the business: approve shops/credit/returns/expenses/payments, set prices, manage catalog/inventory, invite employees and manage salesperson access. Cannot change Owner role, promote/demote another Owner, or transfer ownership unless an explicit succession process is approved. |
| Salesperson | Read active catalog/prices and assigned shops; submit shops, visits, sales, payment claims, returns, and expenses; view own records plus assigned-shop context. Cannot approve, verify, set prices, modify stock, or alter another employee's submissions. |

Cross-cutting invariants:
- A user is authorized only when `auth.uid() = profiles.id`, `profiles.status='approved'`, and role is appropriate.
- No signup metadata can set role/status. Employee approval and role assignment are trusted Owner/Admin operations.
- Disabled users immediately fail all business authorization. Existing historical records remain immutable and attributable.
- A salesperson can access a shop when assigned in `shop_salespeople`; assignment transfer is auditable.
- SQL table privileges and RLS are both required. No policy means default deny. `service_role` bypasses RLS; never use it in the browser.
- Client-side role checks only change UI; they are not security controls.
- Critical financial transitions and movement insertion are RPC/backend-only. Until those functions exist and pass tests, deny those write paths.

## Table/operation matrix

Legend: **R** read; **C** create/submit; **U** ordinary update; **A** approve/review; **V** verify; **X** execute a controlled transaction; **—** no direct access. “Assigned” means primary or additional active assignment. Owner/Admin access remains subject to approval status and audit.

For all workflow-managed tables below, C/U/A/V/X describes the authorized business operation, not permission for arbitrary browser DML. The draft migrations intentionally grant no direct commerce writes; these operations require narrow RPC/backend functions with audit and transaction checks.

| Table | Owner | Admin | Salesperson | Operation conditions |
|---|---|---|---|---|
| `profiles` | R all; U safe fields; A roles/status | R all; U safe fields; A salespeople only | R self; U self name/avatar only | No direct client role/status update. Owner role assignment is protected. |
| `shops` | R/C/U/A all | R/C/U/A all | R assigned; C pending shop; U own pending submission only | Approval/rejection controlled; approved shop edits audited. |
| `shop_salespeople` | R/C/U all | R/C/U salesperson assignment | R own assignments | Assignment write only via trusted workflow; one primary. |
| `shop_visits` | R all | R all | R/C assigned shops | Visit records append-only; correction is audited. |
| `shop_photos` | R/C/U all | R/C/U all | R/C assigned shops | Storage path access follows corresponding table policy; no public bucket. |
| `products`, `product_variants` | R/C/U | R/C/U | R active only | Salesperson cannot set pack size or deactivate products. |
| `default_prices`, `shop_price_overrides` | R/C/U | R/C/U | R effective prices only | No salesperson write. Price edits effective-dated; never rewrite sale snapshots. |
| `credit_controls` | R/U | R/U | R blocked flag only if needed for UI | Changes are audited; no credit limit modeled. |
| `sales` | R/C/U/A/X all | R/C/U/A/X all | R assigned shops/own; C own sale | Direct update of totals/status forbidden; create/confirm via trusted operation. |
| `sale_lines` | R/C/U through controlled sale workflow | same | R/C own draft via controlled workflow | Cartons only; server-resolved prices; immutable once submitted/confirmed. |
| `invoices`, `invoice_lines` | R; issue/void via controlled workflow | R; issue via workflow; void per policy | R assigned/own sales | Immutable snapshots; PDF private. No client insert/update. |
| `payments` | R/C/V/reverse via workflow | R/C/V/reverse via workflow | R own/assigned shop; C payment claim | Salesperson cannot verify/reject/edit amount or status. |
| `payment_allocations` | R/C/X | R/C/X | R own shop allocations | Allocation cannot exceed verified payment/sale outstanding. No direct client mutation. |
| `payment_receipts` | R/issue via workflow | R/issue via workflow | R for own/assigned verified payment | Receipt generated only after verification. |
| `inventory_movements` | R/C controlled adjustment | R/C controlled adjustment | R read-only permitted stock summary | Direct UPDATE/DELETE prohibited for all; each insert is idempotent, reasoned and audited. |
| `return_requests` | R/C/A all | R/C/A all | R/C assigned shop/own; U own pending cancellation | Approval/rejection only Owner/Admin. References original sale. |
| `return_lines` | R/C/A via workflow | R/C/A via workflow | R/C own request | Condition and approved carton counts validated; no client ledger effects. |
| `expense_claims` | R/C/A all | R/C/A all | R/C own; U own pending only | Approval/rejection only Owner/Admin; only approved status in reports. |
| `shop_ledger_entries` | R; adjustments via workflow | R; adjustments via workflow | R assigned shops (minimum necessary) | Append-only, system-generated; no direct writes. |
| `audit_events` | R | R operational audit | — (or own safe event subset if justified) | Insert only through trusted workflow; immutable; avoid sensitive metadata. |

## Approval / transition matrix

| Resource | Submitted by | Decider | Allowed transitions | Side effect requiring atomic transaction |
|---|---|---|---|---|
| Employee signup | Applicant through Supabase Auth signup | Owner/Admin invite/approval; role assignment by Owner/Admin | pending → approved or disabled; disabled may be re-enabled by Owner/Admin | Access policy changes immediately; audit event. |
| Shop | Any approved employee | Owner/Admin | pending → approved/rejected; rejected resubmission policy to define | Approved shop must receive exactly one primary salesperson; assignments audited. |
| Cash/UPI sale | Salesperson or Owner/Admin | Policy auto-confirms in trusted operation | draft → confirmed | Stock movement, shop debit, invoice/PDF request, audit, all-or-nothing. Payment verification remains separate. |
| Credit sale | Salesperson | Owner/Admin | draft → pending approval → confirmed/rejected | Recheck block and stock; confirmation creates inventory and ledger effects once. |
| Payment | Salesperson records; Owner/Admin may record | Owner/Admin verifies | submitted → verified/rejected; verified → reversed only via compensating workflow | Verified allocations, shop credit, receipt and audit are atomic; retry idempotent. |
| Return | Salesperson | Owner/Admin | submitted → approved/rejected; pending may be cancelled by submitter | Approved quantities create disposition movements and shop credit atomically. |
| Inventory adjustment | Owner/Admin only | Owner/Admin with reason; second-person approval policy unresolved | append movement, never edit balance | Idempotent movement, audit, balance reconciliation. |
| Expense | Salesperson | Owner/Admin | submitted → approved/rejected; approved → paid/voided via controlled workflow | Only approved expenses included in reports. |

## RLS policy shape

Define small stable helpers such as `current_employee_status()` / `current_employee_role()` and assignment checks, with `search_path=''` and schema-qualified references if implemented as `SECURITY DEFINER`. However, prefer `SECURITY INVOKER` when table RLS allows it; avoid recursive policies by using a non-recursive profile lookup. Do not grant broad helper execution by default. Any definer function must have a fixed safe `search_path`, minimal owner, explicit argument validation, no dynamic SQL, and `EXECUTE` revoked from `PUBLIC` then granted narrowly.

Policy predicates should be row-specific:
- Profile read: self or approved Owner/Admin. Self-update limited to safe columns (column privileges or an RPC; RLS alone cannot restrict columns).
- Shop select: approved Owner/Admin or approved salesperson assigned; insert requires `submitted_by=auth.uid()` and pending state; status/reviewer fields cannot be set by client.
- Sales select: Owner/Admin or salesperson is submitter / assigned to shop. Sales insert/update controlled by server operation, not arbitrary row policy.
- Payments: same shop scope; salesperson may submit only their own claim; verification fields protected.
- Expenses: submitter sees own; Owner/Admin sees all; review state protected.
- Ledger, invoices, inventory, audit: read scope only; inserts through trusted functions; updates/deletes denied.
- Storage object `bucket_id` and path are checked against user identity or approved shop assignment; private bucket, signed URLs, file-size/type limits, randomized names, metadata row authorization.

## Security assumptions and limitations

1. `auth.uid()` is supplied by verified Supabase JWT; no security decision trusts `user_metadata`.
2. Browser uses only anon/publishable key and user JWT. Server/service role remains secret and server-only.
3. All exposed tables have RLS enabled and forced, and browser roles receive only needed grants.
4. SQL policies cannot provide reliable column-level protection alone; protected fields require column grants and/or validated RPCs.
5. Owner/Admin workflows must be server-enforced. UI hiding or client-supplied IDs are not authorization.
6. Signed invoice/photo/receipt URLs expire and are issued only after object-level authorization.
7. A single Owner account lockout/succession process is unresolved; recovery must not be an unaudited client role edit.

The migration drafts intentionally apply a restrictive foundation and leave high-risk write operations unavailable until RPCs and database tests are added. Owner review is a required gate before implementation.
