# Phase 1 — Business Workflows

All actions below are proposed server/database workflows. Each state transition is validated against the current record and actor; the client supplies intent, not authoritative price, totals, role, approval, or balance. A transaction either commits all required records or none.

## Shop submission and approval

1. Any approved employee submits shop contact/address, optional paired latitude/longitude, notes, and photos. Insert starts `pending`, sets `submitted_by=auth.uid()`, and cannot set review fields.
2. Owner/Admin checks duplicates (phone/name/address review; exact duplicate rule unresolved), completeness, and assignment.
3. Approve/reject operation records reviewer/time/reason. Approval requires exactly one primary approved salesperson. Add any additional salesperson assignments in the same audited operation.
4. Assignment transfer changes the primary and/or secondary mapping; it does not rewrite historical sale salesperson IDs. Historical access is governed by report permissions agreed by owner.
5. Photos upload to a private bucket with randomized object paths; metadata row and storage access are verified. Visit logs append separately.

**Atomicity:** shop state, reviewer, primary assignment, optional assignments, audit event. Do not publish a shop before the required primary assignment exists.

## Sale submission and confirmation

1. Salesperson chooses an approved assigned shop, active product variants, and positive integer carton quantities only.
2. Trusted operation resolves effective shop override first, then current default price; missing/ambiguous price blocks submission. It calculates monetary values using `NUMERIC`, derives Asia/Kolkata business date, and snapshots product/SKU, pack, price, tax mode/rate/components (after legal decisions), and buyer/seller invoice details.
3. Cash/UPI payment terms auto-confirm in the same trusted transaction, as required by the business rule. **This is a sale confirmation rule, not payment verification.** If actual funds evidence must be separately recorded, a payment claim is also created; collections remain excluded until verified.
4. Credit checks the singleton credit block; creates a pending approval, with no inventory decrement or invoice until approval. Owner/Admin approval locks/rechecks stock and credit policy before confirmation. Rejection has reason and no stock/ledger impact.
5. Confirmation atomically stores the sale and lines, inventory movement(s), shop ledger debit, immutable invoice/tax snapshots, audit event and invoice-PDF generation request/outbox record. Any failed step rolls back. Insufficient stock rejects confirmation; it cannot create negative available stock.
6. The PDF worker generates an invoice from immutable snapshots and stores it privately. Render failure is retriable by idempotent outbox key without duplicating sale, stock or invoice number.

## Credit sale review

- Credit is not automatically confirmed. Owner/Admin approves or rejects.
- `credit_controls.blocked=true` prevents new credit submissions/approvals; existing confirmed debts remain collectible. Policy for pending credit sales when blocked toggles must be chosen (proposed: do not auto-cancel; approval checks current flag and is blocked).
- There is no fixed credit limit. Owner/Admin may use outstanding report and manual block.
- Approval must re-read shop assignment/status and stock, use row locks or equivalent serialization, and be idempotent. Only one confirmation can create sale movements/invoice/ledger entries.

## Payment recording, verification, receipt

1. Salesperson records method (`cash`, `upi`, `bank_transfer`), amount > 0, received time, shop, optional reference/evidence, and a UUID idempotency key.
2. The record is `submitted`, not a collection. A unique client retry key and optional normalized external reference prevent duplicate submissions/processing.
3. Owner/Admin reviews evidence and verifies or rejects. Verification is atomic: lock payment and sale allocation targets; reject duplicate processing; check verified allocation totals and outstanding; set verified fields; insert payment allocations and immutable shop-ledger credits; create one receipt; record audit event.
4. Receipt PDF is emitted only after verification. Retried verification returns the prior outcome and does not create another receipt/credit.
5. Corrections to verified payments use a compensating reversal with reason and new audit/ledger entries; no destructive edit. Rules for overpayment/unapplied shop credit and cash reconciliation need owner approval.

## Return request and disposition

1. Salesperson selects original confirmed sale and line(s), submits positive carton quantities and labels each reusable or damaged; requests can never exceed sold quantities.
2. Owner/Admin approves/rejects with reason. Approval locks sale lines and rechecks remaining returnable quantities across all approved requests.
3. In one transaction, set approved quantities, insert return movements, create shop ledger credit, link return to original sale and add audit event.
4. Reusable returns add saleable stock only after inspection. Damaged returns go to a segregated/damaged disposition and do not increase saleable stock. Return-to-cash refunds are not assumed; credit-note/accounting treatment requires approval.

## Inventory receive, sale, damage, return, adjustment

- Maintain append-only `inventory_movements`; derive stock from signed carton deltas. No user updates an on-hand number.
- Receipt/stock received is an Owner/Admin-controlled positive movement with source/reference, quantity, time and actor.
- Confirmed sale creates negative movement exactly once. Credit approval is the commit point, not credit submission.
- Damage is Owner/Admin recorded and removes saleable cartons; reason/evidence required.
- Return movement follows approved condition disposition.
- Adjustment requires reason and idempotency key; optional second-person review remains unresolved.
- Reconcile variant balances against physical counts, investigate ledger gaps, and issue an adjustment movement rather than rewriting prior records.

## Expense claim

1. Salesperson submits amount, date, category, explanation and private receipt path; unique claim key prevents duplicates.
2. Owner/Admin approves/rejects with actor/time; rejection requires reason. Submitter cannot review own claim unless an explicit exception policy is approved (default: no self-approval).
3. Only `approved` claims enter expense totals; `paid` is a separate settlement event. Corrections/voids are audited and do not erase claim history.

## Employee onboarding, invitation, disablement, exit

- Public email/password signup creates a pending salesperson profile only; metadata cannot assign Owner/Admin.
- Owner/Admin can invite via Supabase Auth invitation flow and assign role through trusted admin workflow. Role invitation choices should be limited; owner assignment is a separate owner-only action.
- Approval sets status and approver/time. Until approved, no business-table access.
- Disablement immediately blocks RLS and new sessions/workflows; revoke/expire sessions as supported, remove/reassign shop assignments, preserve historical records and actor IDs.
- Exit retains sales, payments, visits, expenses, and audit history. Transfer shop primary/additional assignments with explicit audit trail.
- Owner recovery/succession and Admin promotion constraints require documented operational procedures.

## Statements, exports, and reports

- Daily/weekly/monthly/yearly groups use Asia/Kolkata business date, not browser locale. Confirm week start and fiscal year before coding.
- Revenue (confirmed sales less approved returns/credits), collections (verified allocated payments), expenses (approved only), outstanding (ledger receivable), and profit (requires cost of goods and tax treatment) are distinct metrics.
- Shop/salesperson reports retain historical sale attribution even after assignment transfers. Access scope for former employees is an owner decision.
- Monthly shop statements combine immutable sale invoices, verified receipts, and approved credits. PDF/Excel export must be permission-checked, paginated, escaped, and audited; no public storage links.

## Invoice and tax snapshots

Each confirmed sale requires one PDF invoice record. GST/non-GST mode, seller/buyer snapshot, item/pack, unit price, quantities, taxable base, tax components/rates, totals, invoice number, issue timestamp, and currency are frozen at issuance. No tax rate is assumed here. An accountant/legal reviewer must specify applicable GST treatment, invoice series, mandatory fields, credit/debit-note handling, rounding, place of supply, and retention. Reprints use the same snapshot; corrections issue a linked document after policy approval. Payment receipt is a different artifact, generated only after payment verification.
