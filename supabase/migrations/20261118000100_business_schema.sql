-- ============================================================================
-- Ethereal Co. Business Manager — additive business schema
-- ----------------------------------------------------------------------------
-- This migration is deliberately self-contained and idempotent. It can run on
-- a project that already has the original `profiles` table, and it does not
-- require the two earlier Phase 1 draft files. Those drafts remain unexecuted
-- design documents and must not be pushed to a database.
--
-- Security model:
--   * RLS is enabled on every browser-visible table. No direct write policies
--     or write grants are issued for business tables.
--   * All writes go through the narrow `api_*` RPCs in the next migration.
--   * Roles/status come from `public.profiles`, never from user metadata.
--   * Money is numeric(14,2) INR. Business dates use Asia/Kolkata.
-- ============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+ (used by Supabase projects).

-- ----------------------------------------------------------------------------
-- Compatibility: an older project may already have `profiles.role` as an enum
-- without an 'admin' label. Adding a label is safe; it becomes usable by the
-- following transaction (the RPCs), not by statements in this transaction.
-- ----------------------------------------------------------------------------
DO $compat$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'app_role' AND n.nspname = 'public'
  ) THEN
    ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'admin';
  END IF;
END
$compat$;

-- ----------------------------------------------------------------------------
-- Identity
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  full_name text NOT NULL DEFAULT 'New employee',
  email text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'salesperson',
  status text NOT NULL DEFAULT 'pending',
  avatar_url text,
  phone text,
  approved_by uuid,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS profiles_role_status_idx ON public.profiles(role, status);

-- Signup trigger: creates a pending salesperson only. If an earlier signup
-- trigger already exists it is left untouched to avoid double inserts.
CREATE OR REPLACE FUNCTION public.api_handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, role, status)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), split_part(COALESCE(NEW.email, 'employee'), '@', 1)),
    COALESCE(NEW.email, ''),
    'salesperson',
    'pending'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.api_handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass
  ) THEN
    CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.api_handle_new_auth_user();
  END IF;
END
$trigger$;

-- ----------------------------------------------------------------------------
-- Business settings and credit control (singletons)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  business_name text NOT NULL DEFAULT 'Ethereal Co.',
  tagline text NOT NULL DEFAULT 'Pure by nature · Safe for life',
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  gstin text NOT NULL DEFAULT '',
  invoice_prefix text NOT NULL DEFAULT 'ETC-INV',
  updated_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.business_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.credit_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.credit_controls (id) VALUES (true) ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- Shops and assignment
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  locality text,
  city text,
  state text,
  postal_code text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  status text NOT NULL DEFAULT 'pending',
  notes text,
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS locality text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS latitude numeric(9,6);
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS submitted_by uuid;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS reviewed_by uuid;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS shops_status_created_idx ON public.shops(status, created_at DESC);
CREATE INDEX IF NOT EXISTS shops_submitted_by_created_idx ON public.shops(submitted_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.shop_salespeople (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  salesperson_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  assigned_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, salesperson_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_one_primary_salesperson_idx
  ON public.shop_salespeople(shop_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS shop_salespeople_person_idx
  ON public.shop_salespeople(salesperson_id, shop_id);

CREATE TABLE IF NOT EXISTS public.shop_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  visited_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  visited_at timestamptz NOT NULL DEFAULT now(),
  visit_note text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_visits_shop_time_idx ON public.shop_visits(shop_id, visited_at DESC);

-- ----------------------------------------------------------------------------
-- Catalog and pricing
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  sku text NOT NULL UNIQUE CHECK (length(btrim(sku)) BETWEEN 1 AND 80),
  pack_size_ml integer NOT NULL CHECK (pack_size_ml > 0),
  bottles_per_carton integer NOT NULL CHECK (bottles_per_carton > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, pack_size_ml, bottles_per_carton)
);
CREATE INDEX IF NOT EXISTS product_variants_product_active_idx ON public.product_variants(product_id, active);

CREATE TABLE IF NOT EXISTS public.default_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  set_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS default_prices_variant_from_idx
  ON public.default_prices(variant_id, valid_from DESC);

CREATE TABLE IF NOT EXISTS public.shop_price_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  set_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_price_override_lookup_idx
  ON public.shop_price_overrides(shop_id, variant_id, valid_from DESC);

-- ----------------------------------------------------------------------------
-- Sales and invoices
-- ----------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq;
CREATE SEQUENCE IF NOT EXISTS public.receipt_number_seq;

CREATE TABLE IF NOT EXISTS public.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_number bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  salesperson_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  payment_terms text NOT NULL,
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
  currency char(3) NOT NULL DEFAULT 'INR',
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  tax_mode text,
  tax_snapshot jsonb,
  client_reference uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS client_reference uuid;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS tax_snapshot jsonb;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS tax_total numeric(14,2) DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS sales_client_reference_idx
  ON public.sales(client_reference) WHERE client_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_date_status_idx ON public.sales(business_date, status);
CREATE INDEX IF NOT EXISTS sales_shop_date_idx ON public.sales(shop_id, business_date);
CREATE INDEX IF NOT EXISTS sales_person_date_idx ON public.sales(salesperson_id, business_date);

CREATE TABLE IF NOT EXISTS public.sale_lines (
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
  tax_rate_snapshot numeric(7,4),
  tax_amount_snapshot numeric(14,2),
  line_total_snapshot numeric(14,2) NOT NULL CHECK (line_total_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, variant_id),
  UNIQUE (id, sale_id, variant_id)
);
CREATE INDEX IF NOT EXISTS sale_lines_sale_idx ON public.sale_lines(sale_id);
CREATE INDEX IF NOT EXISTS sale_lines_variant_idx ON public.sale_lines(variant_id);

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL UNIQUE REFERENCES public.sales(id) ON DELETE RESTRICT,
  invoice_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  buyer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency char(3) NOT NULL DEFAULT 'INR',
  tax_mode text NOT NULL DEFAULT 'non_gst',
  subtotal_snapshot numeric(14,2) NOT NULL DEFAULT 0,
  tax_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  grand_total_snapshot numeric(14,2) NOT NULL DEFAULT 0,
  pdf_storage_path text,
  voided_at timestamptz,
  voided_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS pdf_storage_path text;
DO $invoice_nullable$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices'
      AND column_name = 'pdf_storage_path' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.invoices ALTER COLUMN pdf_storage_path DROP NOT NULL;
  END IF;
END
$invoice_nullable$;
CREATE INDEX IF NOT EXISTS invoices_issued_idx ON public.invoices(issued_at DESC);

CREATE TABLE IF NOT EXISTS public.invoice_lines (
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
  tax_rate_snapshot numeric(7,4),
  tax_amount_snapshot numeric(14,2),
  total_snapshot numeric(14,2) NOT NULL CHECK (total_snapshot >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON public.invoice_lines(invoice_id);

-- ----------------------------------------------------------------------------
-- Payments and receivables
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  recorded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  method text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  external_reference text,
  evidence_storage_path text,
  status text NOT NULL DEFAULT 'submitted',
  verified_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  rejected_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text,
  reversed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_shop_received_idx ON public.payments(shop_id, received_at DESC);
CREATE INDEX IF NOT EXISTS payments_recorded_by_idx ON public.payments(recorded_by, received_at DESC);
CREATE INDEX IF NOT EXISTS payments_status_idx ON public.payments(status, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_external_reference_unique_idx
  ON public.payments(method, external_reference)
  WHERE external_reference IS NOT NULL AND length(btrim(external_reference)) > 0;

CREATE TABLE IF NOT EXISTS public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, sale_id)
);
CREATE INDEX IF NOT EXISTS payment_allocations_sale_idx ON public.payment_allocations(sale_id);

CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE REFERENCES public.payments(id) ON DELETE RESTRICT,
  receipt_number text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  amount_snapshot numeric(14,2) NOT NULL CHECK (amount_snapshot > 0),
  method_snapshot text NOT NULL,
  shop_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_storage_path text
);

-- ----------------------------------------------------------------------------
-- Inventory
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  stock_bucket text NOT NULL DEFAULT 'saleable',
  movement_type text NOT NULL,
  cartons_delta integer NOT NULL CHECK (cartons_delta <> 0),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reason text,
  reverses_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_variant_time_idx
  ON public.inventory_movements(variant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS inventory_source_idx
  ON public.inventory_movements(source_type, source_id);
CREATE INDEX IF NOT EXISTS inventory_actor_time_idx
  ON public.inventory_movements(actor_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Returns
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.return_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'submitted',
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  UNIQUE (id, sale_id)
);
CREATE INDEX IF NOT EXISTS return_requests_sale_status_idx ON public.return_requests(sale_id, status);
CREATE INDEX IF NOT EXISTS return_requests_submitter_idx ON public.return_requests(submitted_by, submitted_at DESC);
CREATE INDEX IF NOT EXISTS return_requests_shop_idx ON public.return_requests(shop_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS public.return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  cartons integer NOT NULL CHECK (cartons > 0),
  condition text NOT NULL,
  approved_cartons integer NOT NULL DEFAULT 0 CHECK (approved_cartons >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (return_request_id, sale_id)
    REFERENCES public.return_requests(id, sale_id) ON DELETE RESTRICT,
  FOREIGN KEY (sale_line_id, sale_id, variant_id)
    REFERENCES public.sale_lines(id, sale_id, variant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS return_lines_sale_line_idx ON public.return_lines(sale_line_id);
CREATE INDEX IF NOT EXISTS return_lines_request_idx ON public.return_lines(return_request_id);

-- ----------------------------------------------------------------------------
-- Expenses
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_reference uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  expense_date date NOT NULL,
  category text NOT NULL CHECK (length(btrim(category)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'submitted',
  receipt_storage_path text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_reason text,
  paid_at timestamptz,
  paid_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_status_date_idx ON public.expense_claims(status, expense_date);
CREATE INDEX IF NOT EXISTS expense_submitter_date_idx ON public.expense_claims(submitted_by, expense_date);

-- ----------------------------------------------------------------------------
-- Shop ledger and audit
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shop_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES public.sales(id) ON DELETE RESTRICT,
  payment_allocation_id uuid REFERENCES public.payment_allocations(id) ON DELETE RESTRICT,
  return_request_id uuid REFERENCES public.return_requests(id) ON DELETE RESTRICT,
  entry_type text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  entry_date date NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_ledger_shop_date_idx ON public.shop_ledger_entries(shop_id, entry_date);
CREATE INDEX IF NOT EXISTS shop_ledger_sale_idx ON public.shop_ledger_entries(sale_id) WHERE sale_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_events_entity_time_idx
  ON public.audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_time_idx
  ON public.audit_events(actor_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- Append-only guards. `CREATE OR REPLACE` is not used: reuse the existing
-- helper when the earlier drafts installed it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

DO $append_only$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['audit_events', 'inventory_movements',
    'payment_allocations', 'payment_receipts', 'invoice_lines',
    'shop_ledger_entries', 'shop_visits']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = v_table || '_append_only'
        AND tgrelid = format('public.%I', v_table)::regclass
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change()',
        v_table || '_append_only', v_table
      );
    END IF;
  END LOOP;
END
$append_only$;

-- ----------------------------------------------------------------------------
-- Authorization helpers. They are SECURITY DEFINER so policies do not recurse
-- through the profiles policy they support.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.role::text
  FROM public.profiles AS p
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'approved'
$function$;
REVOKE ALL ON FUNCTION public.api_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_is_assigned(p_shop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.shop_salespeople AS ss
    JOIN public.profiles AS p ON p.id = ss.salesperson_id
    WHERE ss.shop_id = p_shop_id
      AND ss.salesperson_id = (SELECT auth.uid())
      AND p.status = 'approved'
  )
$function$;
REVOKE ALL ON FUNCTION public.api_is_assigned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_is_assigned(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(public.api_role() IN ('owner', 'admin'), false)
$function$;
REVOKE ALL ON FUNCTION public.api_is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_is_admin() TO authenticated;

-- ----------------------------------------------------------------------------
-- RLS and grants: read-only browser surface, writes only through api_* RPCs.
-- ----------------------------------------------------------------------------
DO $rls$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'profiles', 'business_settings', 'credit_controls', 'shops',
    'shop_salespeople', 'shop_visits', 'products', 'product_variants',
    'default_prices', 'shop_price_overrides', 'sales', 'sale_lines',
    'invoices', 'invoice_lines', 'payments', 'payment_allocations',
    'payment_receipts', 'inventory_movements', 'return_requests',
    'return_lines', 'expense_claims', 'shop_ledger_entries', 'audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    -- Never FORCE: SECURITY DEFINER workflows run as the table owner and must
    -- be able to maintain the ledger/audit tables. Browser roles stay denied.
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_table);
  END LOOP;
END
$rls$;

REVOKE ALL ON SEQUENCE public.invoice_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.receipt_number_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.audit_events_id_seq FROM PUBLIC, anon, authenticated;

-- Read policies
CREATE POLICY bo_profiles_read ON public.profiles FOR SELECT TO authenticated
USING (id = (SELECT auth.uid()) OR public.api_is_admin());

CREATE POLICY bo_settings_read ON public.business_settings FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_credit_read ON public.credit_controls FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_shops_read ON public.shops FOR SELECT TO authenticated
USING (
  public.api_is_admin()
  OR (public.api_role() IS NOT NULL AND (public.api_is_assigned(id) OR submitted_by = (SELECT auth.uid())))
);

CREATE POLICY bo_shop_people_read ON public.shop_salespeople FOR SELECT TO authenticated
USING (public.api_is_admin() OR salesperson_id = (SELECT auth.uid()));

CREATE POLICY bo_visits_read ON public.shop_visits FOR SELECT TO authenticated
USING (public.api_is_admin() OR public.api_is_assigned(shop_id));

CREATE POLICY bo_products_read ON public.products FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_variants_read ON public.product_variants FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_default_prices_read ON public.default_prices FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_shop_prices_read ON public.shop_price_overrides FOR SELECT TO authenticated
USING (public.api_is_admin() OR public.api_is_assigned(shop_id));

CREATE POLICY bo_sales_read ON public.sales FOR SELECT TO authenticated
USING (
  public.api_is_admin()
  OR (public.api_role() IS NOT NULL
      AND (salesperson_id = (SELECT auth.uid()) OR public.api_is_assigned(shop_id)))
);

CREATE POLICY bo_sale_lines_read ON public.sale_lines FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales s
  WHERE s.id = sale_lines.sale_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (s.salesperson_id = (SELECT auth.uid()) OR public.api_is_assigned(s.shop_id))))
));

CREATE POLICY bo_invoices_read ON public.invoices FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.sales s
  WHERE s.id = invoices.sale_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (s.salesperson_id = (SELECT auth.uid()) OR public.api_is_assigned(s.shop_id))))
));

CREATE POLICY bo_invoice_lines_read ON public.invoice_lines FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.invoices i
  JOIN public.sales s ON s.id = i.sale_id
  WHERE i.id = invoice_lines.invoice_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (s.salesperson_id = (SELECT auth.uid()) OR public.api_is_assigned(s.shop_id))))
));

CREATE POLICY bo_payments_read ON public.payments FOR SELECT TO authenticated
USING (
  public.api_is_admin()
  OR (public.api_role() IS NOT NULL
      AND (recorded_by = (SELECT auth.uid()) OR public.api_is_assigned(shop_id)))
);

CREATE POLICY bo_allocations_read ON public.payment_allocations FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.payments p
  WHERE p.id = payment_allocations.payment_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (p.recorded_by = (SELECT auth.uid()) OR public.api_is_assigned(p.shop_id))))
));

CREATE POLICY bo_receipts_read ON public.payment_receipts FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.payments p
  WHERE p.id = payment_receipts.payment_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (p.recorded_by = (SELECT auth.uid()) OR public.api_is_assigned(p.shop_id))))
));

CREATE POLICY bo_inventory_read ON public.inventory_movements FOR SELECT TO authenticated
USING (public.api_role() IS NOT NULL);

CREATE POLICY bo_returns_read ON public.return_requests FOR SELECT TO authenticated
USING (
  public.api_is_admin()
  OR (public.api_role() IS NOT NULL
      AND (submitted_by = (SELECT auth.uid()) OR public.api_is_assigned(shop_id)))
);

CREATE POLICY bo_return_lines_read ON public.return_lines FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.return_requests r
  WHERE r.id = return_lines.return_request_id
    AND (public.api_is_admin()
      OR (public.api_role() IS NOT NULL
          AND (r.submitted_by = (SELECT auth.uid()) OR public.api_is_assigned(r.shop_id))))
));

CREATE POLICY bo_expenses_read ON public.expense_claims FOR SELECT TO authenticated
USING (public.api_is_admin() OR submitted_by = (SELECT auth.uid()));

CREATE POLICY bo_ledger_read ON public.shop_ledger_entries FOR SELECT TO authenticated
USING (public.api_is_admin() OR public.api_is_assigned(shop_id));

CREATE POLICY bo_audit_read ON public.audit_events FOR SELECT TO authenticated
USING (public.api_is_admin());
