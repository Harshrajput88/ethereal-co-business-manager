-- DRAFT ONLY — Phase 1 commercial/ledger tables for a clean single-business DB.
-- Requires 20261117000100_phase1_foundation.sql and owner-approved reconciliation.
-- NEVER apply to remote staging/production as part of this design task.
-- Not executed, parsed by PostgreSQL, or tested against a database.
--
-- ============================================================================
-- REVIEW COPY — static security review of 17 November 2026
-- Source: supabase/migrations/20261117000200_phase1_commerce_ledgers.sql
-- Findings and rationale: docs/PHASE_1_SQL_SECURITY_REVIEW.md
-- STILL NOT EXECUTED and not approved for any database.
--
-- DDL-blocking corrections applied here:
--   C-01  return_requests CHECKs referenced enum labels 'paid'/'voided' that do
--         not exist in public.return_status (CREATE TABLE would fail, 22P02).
--   C-02  Duplicate policy audit_read_admin (already created in the foundation
--         migration) removed; CREATE POLICY would fail with 42710.
--   C-03  FORCE RLS removed from audit_events (same owner/definer problem as
--         profiles; audit inserts from trusted workflows would be denied).
-- Integrity corrections applied here:
--   C-04  expense_claims review CHECK made consistent with the paid/voided
--         states; review evidence is no longer required to be erased.
--   C-05  shop_ledger_entries entry_type is now bound to its source reference
--         and a provenance-free entry is impossible.
--   C-06  One ledger entry per economic event (unique partial indexes).
--   C-07  Inventory reversal linkage required, single reversal per movement,
--         one sale movement per (sale, variant), source_type non-blank.
--   C-08  Actor/time columns added for return cancellation and expense void.
--   C-09  Expense self-approval blocked at the table level.
--   C-10  Issued invoices cannot carry void metadata.
--   C-11  Index on return_requests(shop_id) for policy evaluation.
-- NOT corrected here (requires accounting/Owner decisions or a locked RPC):
--   allocation caps, verified-payment requirement, cross-shop consistency,
--   sale/invoice total arithmetic, negative-stock prevention, ledger
--   adjustment direction/reversal link, invoice immutability trigger,
--   PDF outbox. See the allocation, totals, inventory and reversal findings.
-- ============================================================================

CREATE TYPE public.payment_terms AS ENUM ('cash', 'upi', 'credit');
CREATE TYPE public.sale_status AS ENUM
  ('draft', 'pending_credit_approval', 'confirmed', 'rejected', 'cancelled');
CREATE TYPE public.invoice_status AS ENUM ('issued', 'voided');
CREATE TYPE public.payment_method AS ENUM ('cash', 'upi', 'bank_transfer');
CREATE TYPE public.payment_status AS ENUM ('submitted', 'verified', 'rejected', 'reversed');
CREATE TYPE public.return_status AS ENUM ('submitted', 'approved', 'rejected', 'cancelled');
CREATE TYPE public.return_condition AS ENUM ('reusable', 'damaged');
CREATE TYPE public.expense_status AS ENUM ('submitted', 'approved', 'rejected', 'paid', 'voided');
CREATE TYPE public.inventory_movement_type AS ENUM
  ('opening', 'received', 'sale', 'damage', 'return_reusable',
   'return_damaged', 'adjustment', 'reversal');
CREATE TYPE public.shop_ledger_type AS ENUM
  ('sale_debit', 'payment_credit', 'return_credit', 'adjustment');
CREATE TYPE public.inventory_bucket AS ENUM ('saleable', 'damaged');

CREATE TABLE public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  salesperson_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status public.sale_status NOT NULL DEFAULT 'draft',
  payment_terms public.payment_terms NOT NULL,
  business_date date NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejection_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  cancellation_reason text,
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  tax_mode text CHECK (tax_mode IS NULL OR tax_mode IN ('gst', 'non_gst')),
  tax_snapshot jsonb CHECK (tax_snapshot IS NULL OR jsonb_typeof(tax_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (status <> 'confirmed' OR confirmed_by IS NOT NULL),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CHECK (status <> 'rejected' OR
    (rejected_at IS NOT NULL AND rejected_by IS NOT NULL
     AND NULLIF(btrim(rejection_reason), '') IS NOT NULL)),
  CHECK (status <> 'cancelled' OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
     AND NULLIF(btrim(cancellation_reason), '') IS NOT NULL)),
  CHECK (status <> 'pending_credit_approval' OR payment_terms = 'credit'),
  CHECK (status <> 'confirmed' OR
    (tax_mode IS NOT NULL AND tax_snapshot IS NOT NULL))
);
CREATE INDEX sales_date_status_idx ON public.sales(business_date, status);
CREATE INDEX sales_shop_date_idx ON public.sales(shop_id, business_date);
CREATE INDEX sales_person_date_idx ON public.sales(salesperson_id, business_date);
CREATE INDEX sales_review_queue_idx ON public.sales(submitted_at)
  WHERE status = 'pending_credit_approval';

CREATE TABLE public.sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  cartons integer NOT NULL CHECK (cartons > 0),
  product_name_snapshot text NOT NULL,
  sku_snapshot text NOT NULL,
  pack_size_ml_snapshot integer NOT NULL CHECK (pack_size_ml_snapshot > 0),
  bottles_per_carton_snapshot integer NOT NULL CHECK (bottles_per_carton_snapshot > 0),
  unit_price_snapshot numeric(14,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  line_subtotal numeric(14,2) NOT NULL CHECK (line_subtotal >= 0),
  tax_code_snapshot text,
  tax_rate_snapshot numeric(7,4) CHECK (tax_rate_snapshot IS NULL OR tax_rate_snapshot >= 0),
  tax_amount_snapshot numeric(14,2) CHECK (tax_amount_snapshot IS NULL OR tax_amount_snapshot >= 0),
  line_total_snapshot numeric(14,2) NOT NULL CHECK (line_total_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, variant_id),
  UNIQUE (id, sale_id, variant_id)
);
CREATE INDEX sale_lines_sale_idx ON public.sale_lines(sale_id);
CREATE INDEX sale_lines_variant_idx ON public.sale_lines(variant_id);

CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE REFERENCES public.sales(id) ON DELETE RESTRICT,
  invoice_number text NOT NULL UNIQUE,
  status public.invoice_status NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_snapshot jsonb NOT NULL CHECK (jsonb_typeof(seller_snapshot) = 'object'),
  buyer_snapshot jsonb NOT NULL CHECK (jsonb_typeof(buyer_snapshot) = 'object'),
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  tax_mode text NOT NULL CHECK (tax_mode IN ('gst', 'non_gst')),
  subtotal_snapshot numeric(14,2) NOT NULL CHECK (subtotal_snapshot >= 0),
  tax_snapshot jsonb NOT NULL CHECK (jsonb_typeof(tax_snapshot) = 'object'),
  grand_total_snapshot numeric(14,2) NOT NULL CHECK (grand_total_snapshot >= 0),
  pdf_storage_path text NOT NULL UNIQUE,
  voided_at timestamptz,
  voided_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK (status <> 'voided' OR
    (voided_by IS NOT NULL AND NULLIF(btrim(void_reason), '') IS NOT NULL)),
  -- REVIEW FIX C-10: an issued invoice must not carry void metadata.
  CHECK (status <> 'issued' OR (voided_by IS NULL AND void_reason IS NULL))
);
CREATE INDEX invoices_issued_idx ON public.invoices(issued_at DESC);

CREATE TABLE public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  product_name_snapshot text NOT NULL,
  sku_snapshot text NOT NULL,
  pack_size_ml_snapshot integer NOT NULL CHECK (pack_size_ml_snapshot > 0),
  bottles_per_carton_snapshot integer NOT NULL CHECK (bottles_per_carton_snapshot > 0),
  cartons integer NOT NULL CHECK (cartons > 0),
  unit_price_snapshot numeric(14,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  subtotal_snapshot numeric(14,2) NOT NULL CHECK (subtotal_snapshot >= 0),
  tax_code_snapshot text,
  tax_rate_snapshot numeric(7,4) CHECK (tax_rate_snapshot IS NULL OR tax_rate_snapshot >= 0),
  tax_amount_snapshot numeric(14,2) CHECK (tax_amount_snapshot IS NULL OR tax_amount_snapshot >= 0),
  total_snapshot numeric(14,2) NOT NULL CHECK (total_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_lines_invoice_idx ON public.invoice_lines(invoice_id);

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference uuid NOT NULL UNIQUE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  recorded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  method public.payment_method NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  received_at timestamptz NOT NULL,
  external_reference text,
  evidence_storage_path text,
  status public.payment_status NOT NULL DEFAULT 'submitted',
  verified_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text,
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('verified', 'reversed')) = (verified_at IS NOT NULL)),
  CHECK ((status IN ('verified', 'reversed')) = (verified_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR
    (rejected_at IS NOT NULL AND rejected_by IS NOT NULL
     AND NULLIF(btrim(rejection_reason), '') IS NOT NULL)),
  CHECK (status <> 'reversed' OR
    (reversed_at IS NOT NULL AND reversed_by IS NOT NULL
     AND NULLIF(btrim(reversal_reason), '') IS NOT NULL))
);
CREATE INDEX payments_shop_received_idx ON public.payments(shop_id, received_at DESC);
CREATE INDEX payments_recorded_by_idx ON public.payments(recorded_by, received_at DESC);
CREATE INDEX payments_review_queue_idx ON public.payments(received_at)
  WHERE status = 'submitted';
CREATE UNIQUE INDEX payments_external_reference_unique_idx
  ON public.payments(method, external_reference)
  WHERE external_reference IS NOT NULL AND length(btrim(external_reference)) > 0;

CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, sale_id)
);
CREATE INDEX payment_allocations_sale_idx ON public.payment_allocations(sale_id);

CREATE TABLE public.payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES public.payments(id) ON DELETE RESTRICT,
  receipt_number text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  amount_snapshot numeric(14,2) NOT NULL CHECK (amount_snapshot > 0),
  method_snapshot public.payment_method NOT NULL,
  shop_snapshot jsonb NOT NULL CHECK (jsonb_typeof(shop_snapshot) = 'object'),
  pdf_storage_path text NOT NULL UNIQUE
);

CREATE TABLE public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  stock_bucket public.inventory_bucket NOT NULL DEFAULT 'saleable',
  movement_type public.inventory_movement_type NOT NULL,
  cartons_delta integer NOT NULL CHECK (cartons_delta <> 0),
  source_type text NOT NULL CHECK (length(btrim(source_type)) > 0),
  source_id uuid NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reason text,
  reverses_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (movement_type IN ('opening', 'received', 'return_reusable')
      AND stock_bucket = 'saleable' AND cartons_delta > 0)
    OR (movement_type = 'sale' AND stock_bucket = 'saleable' AND cartons_delta < 0)
    OR (movement_type = 'damage' AND
      ((stock_bucket = 'saleable' AND cartons_delta < 0)
        OR (stock_bucket = 'damaged' AND cartons_delta > 0)))
    OR (movement_type = 'return_damaged' AND stock_bucket = 'damaged' AND cartons_delta > 0)
    OR movement_type IN ('adjustment', 'reversal')
  ),
  CHECK (movement_type NOT IN ('adjustment', 'damage', 'reversal')
    OR NULLIF(btrim(reason), '') IS NOT NULL),
  -- REVIEW FIX C-07: a reversal must name its target and must not mirror itself.
  CHECK (movement_type <> 'reversal' OR reverses_movement_id IS NOT NULL),
  CHECK (reverses_movement_id IS NULL OR reverses_movement_id <> id)
);
CREATE INDEX inventory_variant_time_idx
  ON public.inventory_movements(variant_id, occurred_at DESC);
CREATE INDEX inventory_source_idx
  ON public.inventory_movements(source_type, source_id);
CREATE INDEX inventory_actor_time_idx
  ON public.inventory_movements(actor_id, occurred_at DESC);
-- REVIEW FIX C-07: at most one reversal per movement, and at most one sale
-- deduction per (sale, variant). The client-supplied idempotency key alone does
-- not stop a second, differently-keyed movement for the same economic event.
CREATE UNIQUE INDEX inventory_one_reversal_per_movement_idx
  ON public.inventory_movements(reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;
CREATE UNIQUE INDEX inventory_one_sale_movement_per_variant_idx
  ON public.inventory_movements(source_id, variant_id)
  WHERE source_type = 'sale';

CREATE TABLE public.return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status public.return_status NOT NULL DEFAULT 'submitted',
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  -- REVIEW FIX C-08: 'cancelled' had no actor/time, so that transition was
  -- unauditable. Additive columns; approve only if Owner accepts them.
  cancelled_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  UNIQUE (id, sale_id),
  -- REVIEW FIX C-01: 'paid' and 'voided' are not labels of public.return_status,
  -- so the original CHECKs made this CREATE TABLE fail with 22P02. Review
  -- metadata belongs to approved/rejected only; 'cancelled' carries its own.
  CHECK ((status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected')) = (reviewed_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR NULLIF(btrim(review_reason), '') IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX return_requests_sale_status_idx ON public.return_requests(sale_id, status);
-- REVIEW FIX C-11: policy evaluation filters returns by shop_id.
CREATE INDEX return_requests_shop_idx ON public.return_requests(shop_id);
CREATE INDEX return_requests_submitter_idx ON public.return_requests(submitted_by, submitted_at DESC);
CREATE INDEX return_requests_review_idx ON public.return_requests(submitted_at)
  WHERE status = 'submitted';

CREATE TABLE public.return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  cartons integer NOT NULL CHECK (cartons > 0),
  condition public.return_condition NOT NULL,
  approved_cartons integer NOT NULL DEFAULT 0 CHECK (approved_cartons >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (return_request_id, sale_id)
    REFERENCES public.return_requests(id, sale_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_line_id, sale_id, variant_id)
    REFERENCES public.sale_lines(id, sale_id, variant_id) ON DELETE RESTRICT,
  CHECK (approved_cartons <= cartons)
);
CREATE INDEX return_lines_sale_line_idx ON public.return_lines(sale_line_id);
CREATE INDEX return_lines_request_idx ON public.return_lines(return_request_id);

CREATE TABLE public.expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_reference uuid NOT NULL UNIQUE,
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  expense_date date NOT NULL,
  category text NOT NULL CHECK (length(btrim(category)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status public.expense_status NOT NULL DEFAULT 'submitted',
  receipt_storage_path text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  paid_at timestamptz,
  paid_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  -- REVIEW FIX C-08: 'voided' had no actor/time.
  voided_at timestamptz,
  voided_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- REVIEW FIX C-04: the original CHECK required reviewed_at IS NULL whenever the
  -- status was 'paid' or 'voided'. Settling or voiding an approved claim would
  -- therefore have to erase its approval evidence, contradicting the audit rule.
  CHECK ((status <> 'submitted') = (reviewed_at IS NOT NULL)),
  CHECK ((status <> 'submitted') = (reviewed_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR NULLIF(btrim(review_reason), '') IS NOT NULL),
  -- REVIEW FIX C-09: documented default is no self-approval.
  CHECK (reviewed_by IS NULL OR reviewed_by <> submitted_by),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL AND paid_by IS NOT NULL)),
  CHECK ((paid_at IS NULL) = (paid_by IS NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX expense_status_date_idx ON public.expense_claims(status, expense_date);
CREATE INDEX expense_submitter_date_idx ON public.expense_claims(submitted_by, expense_date);

CREATE TABLE public.shop_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  payment_allocation_id uuid REFERENCES public.payment_allocations(id) ON DELETE RESTRICT,
  return_request_id uuid REFERENCES public.return_requests(id) ON DELETE RESTRICT,
  entry_type public.shop_ledger_type NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  entry_date date NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- REVIEW FIX C-05: entry_type is bound to the source it claims to represent,
  -- so a credit cannot cite a sale and a provenance-free adjustment/debit is
  -- impossible. Direction and reversal linkage for adjustments remain an
  -- accounting decision -- see the ledger findings in the review.
  CHECK ((entry_type = 'sale_debit'
            AND sale_id IS NOT NULL
            AND payment_allocation_id IS NULL
            AND return_request_id IS NULL)
      OR (entry_type = 'payment_credit'
            AND payment_allocation_id IS NOT NULL
            AND sale_id IS NULL
            AND return_request_id IS NULL)
      OR (entry_type = 'return_credit'
            AND return_request_id IS NOT NULL
            AND sale_id IS NULL
            AND payment_allocation_id IS NULL)
      OR (entry_type = 'adjustment'
            AND num_nonnulls(sale_id, payment_allocation_id, return_request_id) <= 1))
);
CREATE INDEX shop_ledger_shop_date_idx ON public.shop_ledger_entries(shop_id, entry_date);
CREATE INDEX shop_ledger_sale_idx ON public.shop_ledger_entries(sale_id)
  WHERE sale_id IS NOT NULL;
-- REVIEW FIX C-06: one ledger entry per economic event. Without these, a second
-- sale_debit for the same sale (or a second credit for the same allocation or
-- return) double-counts receivables/collections, and the caller-supplied
-- idempotency_key does not prevent it.
CREATE UNIQUE INDEX shop_ledger_one_debit_per_sale_idx
  ON public.shop_ledger_entries(sale_id)
  WHERE entry_type = 'sale_debit';
CREATE UNIQUE INDEX shop_ledger_one_credit_per_allocation_idx
  ON public.shop_ledger_entries(payment_allocation_id)
  WHERE entry_type = 'payment_credit';
CREATE UNIQUE INDEX shop_ledger_one_credit_per_return_idx
  ON public.shop_ledger_entries(return_request_id)
  WHERE entry_type = 'return_credit';

-- Reuse public.reject_immutable_change() installed by the foundation migration.
CREATE TRIGGER inventory_movements_append_only
BEFORE UPDATE OR DELETE ON public.inventory_movements
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER payment_allocations_append_only
BEFORE UPDATE OR DELETE ON public.payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER payment_receipts_append_only
BEFORE UPDATE OR DELETE ON public.payment_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER invoice_lines_append_only
BEFORE UPDATE OR DELETE ON public.invoice_lines
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER shop_ledger_append_only
BEFORE UPDATE OR DELETE ON public.shop_ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
REVOKE ALL ON public.sales, public.sale_lines, public.invoices, public.invoice_lines,
  public.payments, public.payment_allocations, public.payment_receipts,
  public.inventory_movements, public.return_requests, public.return_lines,
  public.expense_claims, public.shop_ledger_entries
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.sales_sale_number_seq FROM PUBLIC, anon, authenticated;

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.return_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expense_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
-- REVIEW FIX C-03: FORCE is not re-applied here (it is removed in the foundation
-- review copy, F-01). With FORCE, this table's owner is also subject to RLS and
-- there is no INSERT policy, so every trusted-workflow audit insert would be
-- denied. ENABLE keeps default-deny for anon/authenticated; INSERT stays
-- definer-only.

GRANT SELECT ON public.sales, public.sale_lines, public.invoices, public.invoice_lines,
  public.payments, public.payment_allocations, public.payment_receipts,
  public.inventory_movements, public.return_requests, public.return_lines,
  public.expense_claims, public.shop_ledger_entries, public.audit_events
TO authenticated;

CREATE POLICY sales_read_scope ON public.sales
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND (salesperson_id = (SELECT auth.uid()) OR public.is_shop_assigned(shop_id))
  )
);
CREATE POLICY sale_lines_read_scope ON public.sale_lines
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales s
  WHERE s.id = sale_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (s.salesperson_id = (SELECT auth.uid())
          OR public.is_shop_assigned(s.shop_id))))
));
CREATE POLICY invoices_read_scope ON public.invoices
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales s
  WHERE s.id = sale_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (s.salesperson_id = (SELECT auth.uid())
          OR public.is_shop_assigned(s.shop_id))))
));
CREATE POLICY invoice_lines_read_scope ON public.invoice_lines
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.invoices i JOIN public.sales s ON s.id = i.sale_id
  WHERE i.id = invoice_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (s.salesperson_id = (SELECT auth.uid())
          OR public.is_shop_assigned(s.shop_id))))
));
CREATE POLICY payments_read_scope ON public.payments
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND (recorded_by = (SELECT auth.uid()) OR public.is_shop_assigned(shop_id))
  )
);
CREATE POLICY allocations_read_scope ON public.payment_allocations
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.payments p
  WHERE p.id = payment_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (p.recorded_by = (SELECT auth.uid())
          OR public.is_shop_assigned(p.shop_id))))
));
CREATE POLICY receipts_read_scope ON public.payment_receipts
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.payments p
  WHERE p.id = payment_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (p.recorded_by = (SELECT auth.uid())
          OR public.is_shop_assigned(p.shop_id))))
));
CREATE POLICY inventory_read_approved ON public.inventory_movements
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin', 'salesperson'));
CREATE POLICY returns_read_scope ON public.return_requests
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND (submitted_by = (SELECT auth.uid()) OR public.is_shop_assigned(shop_id))
  )
);
CREATE POLICY return_lines_read_scope ON public.return_lines
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.return_requests r
  WHERE r.id = return_request_id
    AND (public.current_employee_role() IN ('owner', 'admin')
      OR (public.current_employee_role() IS NOT NULL
        AND (r.submitted_by = (SELECT auth.uid())
          OR public.is_shop_assigned(r.shop_id))))
));
CREATE POLICY expenses_read_scope ON public.expense_claims
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND submitted_by = (SELECT auth.uid())
  )
);
CREATE POLICY shop_ledger_read_scope ON public.shop_ledger_entries
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND public.is_shop_assigned(shop_id)
  )
);
-- REVIEW FIX C-02: the duplicate audit_read_admin policy statement was removed.
-- It is already created on public.audit_events by the foundation migration, so
-- the original statement failed with 42710 and aborted the whole migration. The
-- foundation policy (owner/admin SELECT) is the single source of truth.

-- This draft intentionally grants no direct commerce INSERT/UPDATE/DELETE access.
-- Add narrow transactional RPCs and scoped grants only after security review.
--
-- ============================================================================
-- REVIEW: invariants that cannot be expressed as a single-table CHECK and that
-- MUST exist before any INSERT/UPDATE grant or RPC is exposed. Each requires a
-- locked transaction (row locks / serializable) and service-side authorization.
--
--  1. payment_allocations: SUM(amount) per payment_id <= payments.amount, only
--     when payments.status = 'verified'; allocation target must be a confirmed
--     sale in the same shop_id as the payment; rejected/reversed/deleted
--     payments must never fund an allocation.
--  2. sales/sale_lines/invoice_lines: grand_total = subtotal + tax_total;
--     subtotal = SUM(line_subtotal); invoice totals must equal the frozen sale
--     totals; tax_amount <= taxable x rate.
--  3. inventory: available = SUM(cartons_delta) per (variant, bucket) must be
--     checked under lock at confirmation time; confirmation rejects negative
--     stock. source_id must resolve to a real sale/return row.
--  4. returns: SUM(approved_cartons) per sale_line across approved requests
--     must not exceed the sold cartons; return shop must equal sale shop.
--  5. ledger: entry shop must equal the source record's shop, and one debit /
--     credit per source (partly enforced by C-06 above). Adjustments need a
--     direction and a reversal link -- accounting decision pending.
--  6. invoices/payments: snapshot columns freeze at issuance/verification; only
--     the status transition may UPDATE, and every UPDATE writes an audit event.
-- ============================================================================
