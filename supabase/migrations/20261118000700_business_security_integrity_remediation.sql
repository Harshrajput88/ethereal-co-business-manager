-- ============================================================================
-- Ethereal Co. — Phase 2 security and integrity remediation
-- ----------------------------------------------------------------------------
-- Additive remediation for the six 20261118 business migrations. Those six
-- files are preserved unchanged; this migration must run after
-- 20261118000600_business_dashboard_team_rpcs.sql.
--
-- HIGH fixes
--   1. NULL-safe authorization in api_team_list()/api_audit_log().
--   2. Serialized first-owner claim (api_claim_owner).
--   3. Serialized last-active-owner protection (employee status/role changes).
--   4. Serialized payment verification so concurrent verifications cannot
--      allocate more than a sale's outstanding balance.
--   5. Payment allocations normalized to cents before total validation.
--   6. Duplicate sale IDs in one payment are rejected.
--   7. Duplicate sale lines in one return are rejected, and a unique index
--      enforces it structurally.
--   8. Return approvals serialize on shared sale lines and re-check cumulative
--      approved quantities.
--   9. Pending/disabled employees cannot read team or audit data.
--
-- MEDIUM fixes
--  10. Sale/payment idempotency scoped to creating actor and payload.
--  11. Stock receipt replay is idempotent, payload-checked, and does not write
--      a duplicate audit event.
--  12. Profile update RPCs fail when no profile row was affected.
--  13. All stock mutations use the same per-variant advisory lock protocol.
--  14. Inventory aggregates use bigint (no 32-bit overflow at read time).
--  15. Dashboard reports cash collected and applied allocations separately.
--  16. Signup trigger compatibility is verified instead of assumed.
--
-- Documented business-rule clarifications (no silent rule changes):
--   * A pending (not yet approved) user may still claim first ownership: that
--     is the documented bootstrap path. A disabled account may not.
--   * Return quantities are capped cumulatively across submitted and approved
--     requests for the same sale line, not just within one request.
--   * Idempotency keys are scoped to the creating actor and normalized payload.
--   * `collected_today`/`month_collected` remain cash-received totals of
--     verified payments; `applied_today`/`applied_month` are the new
--     allocation-based (settlement) figures.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Supporting columns and structural invariants
-- ----------------------------------------------------------------------------
ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;

-- Duplicate sale lines in a single return request are structurally impossible.
-- Existing duplicate rows (none expected) make this migration fail closed.
CREATE UNIQUE INDEX IF NOT EXISTS return_lines_request_line_unique
  ON public.return_lines(return_request_id, sale_line_id);

-- ----------------------------------------------------------------------------
-- Signup trigger compatibility: fail closed instead of assuming a same-name
-- trigger is ours. AFTER INSERT FOR EACH ROW => tgtype = 5.
-- ----------------------------------------------------------------------------
DO $signup_trigger_check$
DECLARE
  v_trigger pg_trigger%ROWTYPE;
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    SELECT * INTO v_trigger
    FROM pg_trigger
    WHERE tgname = 'on_auth_user_created'
      AND tgrelid = to_regclass('auth.users');

    IF FOUND AND (
      v_trigger.tgisinternal
      OR v_trigger.tgfoid <> 'public.api_handle_new_auth_user()'::regprocedure
      OR v_trigger.tgtype <> 5
    ) THEN
      RAISE EXCEPTION
        'on_auth_user_created already exists with an unexpected definition; reconcile the Auth signup trigger manually before applying this remediation';
    END IF;
  END IF;
END
$signup_trigger_check$;

-- ----------------------------------------------------------------------------
-- Inventory aggregates: bigint end-to-end so a large carton total cannot
-- overflow a 32-bit integer while catalog/dashboard queries are reading it.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.api_stock_qty(uuid, text);

CREATE FUNCTION public.api_stock_qty(
  p_variant_id uuid,
  p_bucket text DEFAULT 'saleable'
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(SUM(m.cartons_delta), 0)::bigint
  FROM public.inventory_movements AS m
  WHERE m.variant_id = p_variant_id
    AND m.stock_bucket = p_bucket
$function$;
REVOKE ALL ON FUNCTION public.api_stock_qty(uuid, text) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- First-owner bootstrap: one global advisory lock serializes concurrent
-- claims. A pending user may bootstrap; a disabled account may not.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_claim_owner()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ethereal.owner_membership')::bigint);

  IF EXISTS (SELECT 1 FROM public.profiles WHERE role::text = 'owner') THEN
    RAISE EXCEPTION 'An owner account already exists' USING ERRCODE = '42501';
  END IF;

  SELECT p.status::text INTO v_status
  FROM public.profiles AS p
  WHERE p.id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Create your profile before claiming ownership' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'disabled' THEN
    RAISE EXCEPTION 'A disabled account cannot claim ownership' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET role = 'owner', status = 'approved', approved_at = now(),
      approved_by = v_uid, disabled_at = NULL, updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.audit_events (actor_id, action, entity_type, entity_id, safe_metadata)
  VALUES (v_uid, 'owner.claimed', 'profile', v_uid, '{}'::jsonb);

  RETURN jsonb_build_object('id', v_uid, 'role', 'owner', 'status', 'approved');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_claim_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_claim_owner() TO authenticated;

-- ----------------------------------------------------------------------------
-- Self-service profile updates must fail when no profile row was affected.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_update_my_name(p_full_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_name text := NULLIF(btrim(p_full_name), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_name IS NULL OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'Enter a valid name (1-160 characters)';
  END IF;

  UPDATE public.profiles
  SET full_name = v_name, updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object('id', v_uid, 'full_name', v_name);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_update_my_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_update_my_name(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_update_my_avatar(p_avatar_url text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_url text := NULLIF(btrim(p_avatar_url), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_url IS NOT NULL AND length(v_url) > 2048 THEN
    RAISE EXCEPTION 'Avatar URL is too long';
  END IF;

  UPDATE public.profiles
  SET avatar_url = v_url, updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object('id', v_uid, 'avatar_url', v_url);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_update_my_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_update_my_avatar(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Sales: actor/payload-scoped idempotency, bigint stock, deterministic locks.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_create_sale(
  p_shop_id uuid,
  p_payment_terms text,
  p_lines jsonb,
  p_client_reference uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_shop public.shops%ROWTYPE;
  v_line record;
  v_variant public.product_variants%ROWTYPE;
  v_product public.products%ROWTYPE;
  v_price numeric;
  v_total numeric := 0;
  v_sale_id uuid;
  v_sale_number bigint;
  v_status text;
  v_business_date date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_stock bigint;
  v_count integer := 0;
  v_distinct integer := 0;
  v_fingerprint text;
  v_existing public.sales%ROWTYPE;
  v_credit_blocked boolean;
  v_payment_id uuid;
  v_invoice jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_client_reference IS NOT NULL THEN
    IF jsonb_typeof(p_lines) = 'array' THEN
      v_fingerprint := md5(jsonb_build_object(
        'shop_id', p_shop_id,
        'payment_terms', p_payment_terms,
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'variant_id', x.variant_id,
            'cartons', x.cartons
          ) ORDER BY x.variant_id, x.cartons)
          FROM jsonb_to_recordset(p_lines) AS x(variant_id uuid, cartons integer)
        ), '[]'::jsonb)
      )::text);
    ELSE
      v_fingerprint := md5(jsonb_build_object(
        'shop_id', p_shop_id,
        'payment_terms', p_payment_terms,
        'lines', 'invalid'
      )::text);
    END IF;

    SELECT * INTO v_existing FROM public.sales WHERE client_reference = p_client_reference;
    IF FOUND THEN
      IF v_existing.salesperson_id <> v_uid THEN
        RAISE EXCEPTION 'This client reference belongs to another request' USING ERRCODE = '42501';
      END IF;
      IF v_existing.idempotency_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'This client reference was already used with different sale data';
      END IF;
      RETURN jsonb_build_object(
        'sale_id', v_existing.id,
        'sale_number', v_existing.sale_number,
        'status', v_existing.status,
        'grand_total', v_existing.grand_total,
        'idempotent', true
      );
    END IF;
  END IF;

  IF p_payment_terms NOT IN ('cash', 'upi', 'credit') THEN
    RAISE EXCEPTION 'Choose cash, UPI or credit';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one product line';
  END IF;

  SELECT * INTO v_shop FROM public.shops WHERE id = p_shop_id;
  IF NOT FOUND OR v_shop.status <> 'approved' THEN
    RAISE EXCEPTION 'Select an approved shop';
  END IF;
  IF v_role NOT IN ('owner', 'admin') AND NOT public.api_is_assigned(p_shop_id) THEN
    RAISE EXCEPTION 'You are not assigned to this shop' USING ERRCODE = '42501';
  END IF;

  IF p_payment_terms = 'credit' THEN
    SELECT blocked INTO v_credit_blocked FROM public.credit_controls WHERE id;
    IF COALESCE(v_credit_blocked, false) THEN
      RAISE EXCEPTION 'Credit sales are currently blocked by the owner';
    END IF;
  END IF;

  SELECT count(*), count(DISTINCT variant_id)
  INTO v_count, v_distinct
  FROM jsonb_to_recordset(p_lines) AS x(variant_id uuid, cartons integer);

  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'Each product may appear only once per sale';
  END IF;

  v_sale_id := gen_random_uuid();
  v_status := CASE WHEN p_payment_terms = 'credit' THEN 'pending_credit_approval' ELSE 'confirmed' END;

  INSERT INTO public.sales (
    id, shop_id, salesperson_id, status, payment_terms, business_date,
    confirmed_at, confirmed_by, currency, subtotal, tax_total, grand_total,
    tax_mode, tax_snapshot, client_reference, idempotency_fingerprint
  ) VALUES (
    v_sale_id, p_shop_id, v_uid, v_status, p_payment_terms, v_business_date,
    CASE WHEN v_status = 'confirmed' THEN now() ELSE NULL END,
    CASE WHEN v_status = 'confirmed' THEN v_uid ELSE NULL END,
    'INR', 0, 0, 0, 'non_gst',
    jsonb_build_object('mode', 'non_gst', 'note', 'Tax treatment pending accountant review'),
    p_client_reference, v_fingerprint
  )
  RETURNING sale_number INTO v_sale_number;

  FOR v_line IN
    SELECT * FROM jsonb_to_recordset(p_lines) AS x(variant_id uuid, cartons integer)
    ORDER BY variant_id
  LOOP
    IF v_line.cartons IS NULL OR v_line.cartons <= 0 THEN
      RAISE EXCEPTION 'Carton quantities must be positive whole numbers';
    END IF;

    SELECT pv.* INTO v_variant
    FROM public.product_variants pv
    WHERE pv.id = v_line.variant_id AND pv.active
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'An inactive or unknown product was selected';
    END IF;
    SELECT * INTO v_product FROM public.products WHERE id = v_variant.product_id;
    IF NOT FOUND OR NOT v_product.active THEN
      RAISE EXCEPTION 'Product is not active';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(v_line.variant_id::text)::bigint);

    SELECT amount INTO v_price
    FROM public.shop_price_overrides
    WHERE shop_id = p_shop_id AND variant_id = v_line.variant_id
      AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
    ORDER BY valid_from DESC LIMIT 1;

    IF v_price IS NULL THEN
      SELECT amount INTO v_price
      FROM public.default_prices
      WHERE variant_id = v_line.variant_id
        AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
      ORDER BY valid_from DESC LIMIT 1;
    END IF;

    IF v_price IS NULL OR v_price <= 0 THEN
      RAISE EXCEPTION 'No active price is set for %', v_product.name;
    END IF;

    IF v_status = 'confirmed' THEN
      v_stock := public.api_stock_qty(v_line.variant_id, 'saleable');
      IF v_stock < v_line.cartons THEN
        RAISE EXCEPTION 'Insufficient stock for % (available: % cartons)', v_product.name, v_stock;
      END IF;
    END IF;

    INSERT INTO public.sale_lines (
      sale_id, variant_id, cartons, product_name_snapshot, sku_snapshot,
      pack_size_ml_snapshot, bottles_per_carton_snapshot, unit_price_snapshot,
      line_subtotal, line_total_snapshot
    ) VALUES (
      v_sale_id, v_line.variant_id, v_line.cartons, v_product.name, v_variant.sku,
      v_variant.pack_size_ml, v_variant.bottles_per_carton, v_price,
      round(v_price * v_line.cartons, 2), round(v_price * v_line.cartons, 2)
    );

    v_total := round(v_total + (v_price * v_line.cartons), 2);

    IF v_status = 'confirmed' THEN
      INSERT INTO public.inventory_movements (
        variant_id, stock_bucket, movement_type, cartons_delta,
        source_type, source_id, actor_id, reason
      ) VALUES (
        v_line.variant_id, 'saleable', 'sale', -v_line.cartons,
        'sale', v_sale_id, v_uid, 'Confirmed sale'
      );
    END IF;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Sale total must be greater than zero';
  END IF;

  UPDATE public.sales
  SET subtotal = v_total, tax_total = 0, grand_total = v_total, updated_at = now()
  WHERE id = v_sale_id;

  IF v_status = 'confirmed' THEN
    INSERT INTO public.shop_ledger_entries (
      shop_id, sale_id, entry_type, amount, entry_date, created_by
    ) VALUES (p_shop_id, v_sale_id, 'sale_debit', v_total, v_business_date, v_uid);

    v_invoice := public.api_issue_invoice(v_sale_id, v_uid);

    IF p_payment_terms IN ('cash', 'upi') THEN
      INSERT INTO public.payments (
        shop_id, recorded_by, method, amount, received_at, status
      ) VALUES (
        p_shop_id, v_uid, p_payment_terms, v_total, now(), 'submitted'
      )
      RETURNING id INTO v_payment_id;

      INSERT INTO public.payment_allocations (payment_id, sale_id, amount)
      VALUES (v_payment_id, v_sale_id, v_total);
    END IF;
  END IF;

  PERFORM public.api_audit('sale.created', 'sale', v_sale_id,
    jsonb_build_object('status', v_status, 'total', v_total, 'terms', p_payment_terms));

  RETURN jsonb_build_object(
    'sale_id', v_sale_id,
    'sale_number', v_sale_number,
    'status', v_status,
    'grand_total', v_total,
    'payment_terms', p_payment_terms,
    'business_date', v_business_date,
    'invoice_number', v_invoice ->> 'invoice_number'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_create_sale(uuid, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_create_sale(uuid, text, jsonb, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Credit approval: lock variants in variant_id order, bigint stock.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_review_credit_sale(
  p_sale_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_sale public.sales%ROWTYPE;
  v_line public.sale_lines%ROWTYPE;
  v_stock bigint;
  v_credit_blocked boolean;
  v_invoice jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can review credit sales' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF v_sale.status <> 'pending_credit_approval' THEN
    RAISE EXCEPTION 'This credit sale is no longer pending';
  END IF;

  IF p_decision = 'reject' THEN
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'A rejection reason is required';
    END IF;
    UPDATE public.sales
    SET status = 'rejected', rejected_at = now(), rejected_by = v_uid,
        rejection_reason = btrim(p_reason), updated_at = now()
    WHERE id = p_sale_id;
    PERFORM public.api_audit('sale.credit_rejected', 'sale', p_sale_id,
      jsonb_build_object('reason', p_reason));
    RETURN jsonb_build_object('sale_id', p_sale_id, 'status', 'rejected');
  END IF;

  SELECT blocked INTO v_credit_blocked FROM public.credit_controls WHERE id;
  IF COALESCE(v_credit_blocked, false) THEN
    RAISE EXCEPTION 'Credit sales are currently blocked by the owner';
  END IF;

  FOR v_line IN
    SELECT * FROM public.sale_lines WHERE sale_id = p_sale_id ORDER BY variant_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_line.variant_id::text)::bigint);
    v_stock := public.api_stock_qty(v_line.variant_id, 'saleable');
    IF v_stock < v_line.cartons THEN
      RAISE EXCEPTION 'Insufficient stock for % (available: % cartons)',
        v_line.product_name_snapshot, v_stock;
    END IF;
    INSERT INTO public.inventory_movements (
      variant_id, stock_bucket, movement_type, cartons_delta,
      source_type, source_id, actor_id, reason
    ) VALUES (
      v_line.variant_id, 'saleable', 'sale', -v_line.cartons,
      'sale', p_sale_id, v_uid, 'Approved credit sale'
    );
  END LOOP;

  UPDATE public.sales
  SET status = 'confirmed', confirmed_at = now(), confirmed_by = v_uid, updated_at = now()
  WHERE id = p_sale_id;

  INSERT INTO public.shop_ledger_entries (
    shop_id, sale_id, entry_type, amount, entry_date, created_by
  ) VALUES (
    v_sale.shop_id, p_sale_id, 'sale_debit', v_sale.grand_total,
    (now() AT TIME ZONE 'Asia/Kolkata')::date, v_uid
  );

  v_invoice := public.api_issue_invoice(p_sale_id, v_uid);

  PERFORM public.api_audit('sale.credit_approved', 'sale', p_sale_id, '{}'::jsonb);

  RETURN jsonb_build_object(
    'sale_id', p_sale_id,
    'status', 'confirmed',
    'invoice_number', v_invoice ->> 'invoice_number'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_review_credit_sale(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_review_credit_sale(uuid, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Payments: duplicate-sale rejection, cent normalization, scoped idempotency.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_record_payment(
  p_shop_id uuid,
  p_method text,
  p_amount numeric,
  p_received_at timestamptz,
  p_external_reference text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_client_reference uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_existing public.payments%ROWTYPE;
  v_payment_id uuid;
  v_alloc record;
  v_alloc_total numeric := 0;
  v_balance numeric;
  v_sale public.sales%ROWTYPE;
  v_count integer := 0;
  v_distinct integer := 0;
  v_fingerprint text;
  v_amount numeric;
  v_external text;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_method NOT IN ('cash', 'upi', 'bank_transfer') THEN
    RAISE EXCEPTION 'Choose cash, UPI or bank transfer';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop_id AND status = 'approved') THEN
    RAISE EXCEPTION 'Select an approved shop';
  END IF;
  IF v_role NOT IN ('owner', 'admin') AND NOT public.api_is_assigned(p_shop_id) THEN
    RAISE EXCEPTION 'You are not assigned to this shop' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION 'Invalid allocation data';
  END IF;

  v_amount := round(p_amount, 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Payment amount must round to at least 0.01';
  END IF;
  v_external := NULLIF(btrim(p_external_reference), '');

  SELECT count(*), count(DISTINCT x.sale_id)
  INTO v_count, v_distinct
  FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric);

  FOR v_alloc IN
    SELECT x.sale_id, round(x.amount, 2) AS amount
    FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric)
    ORDER BY x.sale_id
  LOOP
    IF v_alloc.sale_id IS NULL THEN
      RAISE EXCEPTION 'Every allocation must reference a sale';
    END IF;
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amounts must round to at least 0.01';
    END IF;
    v_alloc_total := v_alloc_total + v_alloc.amount;
  END LOOP;

  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'Each sale may appear only once in a payment';
  END IF;

  IF v_alloc_total > v_amount THEN
    RAISE EXCEPTION 'Allocations cannot exceed the payment amount';
  END IF;

  -- Idempotency is resolved before balance validation so a replay still
  -- returns the original result after that payment was verified.
  IF p_client_reference IS NOT NULL THEN
    v_fingerprint := md5(jsonb_build_object(
      'shop_id', p_shop_id,
      'method', p_method,
      'amount', v_amount,
      'external_reference', v_external,
      'allocations', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sale_id', x.sale_id,
          'amount', round(x.amount, 2)
        ) ORDER BY x.sale_id)
        FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric)
      ), '[]'::jsonb)
    )::text);

    SELECT * INTO v_existing FROM public.payments WHERE payment_reference = p_client_reference;
    IF FOUND THEN
      IF v_existing.recorded_by <> v_uid THEN
        RAISE EXCEPTION 'This client reference belongs to another request' USING ERRCODE = '42501';
      END IF;
      IF v_existing.idempotency_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'This client reference was already used with different payment data';
      END IF;
      RETURN jsonb_build_object(
        'payment_id', v_existing.id,
        'status', v_existing.status,
        'idempotent', true
      );
    END IF;
  END IF;

  FOR v_alloc IN
    SELECT x.sale_id, round(x.amount, 2) AS amount
    FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric)
    ORDER BY x.sale_id
  LOOP
    SELECT * INTO v_sale FROM public.sales WHERE id = v_alloc.sale_id;
    IF NOT FOUND OR v_sale.shop_id <> p_shop_id OR v_sale.status <> 'confirmed' THEN
      RAISE EXCEPTION 'An allocation references an invalid sale';
    END IF;
    v_balance := public.api_sale_balance(v_alloc.sale_id);
    IF v_alloc.amount > v_balance THEN
      RAISE EXCEPTION 'Allocation exceeds the outstanding balance for sale #%', v_sale.sale_number;
    END IF;
  END LOOP;

  INSERT INTO public.payments (
    payment_reference, shop_id, recorded_by, method, amount, received_at,
    external_reference, status, idempotency_fingerprint
  ) VALUES (
    COALESCE(p_client_reference, gen_random_uuid()), p_shop_id, v_uid,
    p_method, v_amount, COALESCE(p_received_at, now()),
    v_external, 'submitted', v_fingerprint
  )
  RETURNING id INTO v_payment_id;

  INSERT INTO public.payment_allocations (payment_id, sale_id, amount)
  SELECT v_payment_id, x.sale_id, round(x.amount, 2)
  FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric);

  PERFORM public.api_audit('payment.submitted', 'payment', v_payment_id,
    jsonb_build_object('amount', v_amount, 'method', p_method));

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'status', 'submitted',
    'amount', v_amount,
    'allocated', v_alloc_total
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_record_payment(uuid, text, numeric, timestamptz, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_record_payment(uuid, text, numeric, timestamptz, text, jsonb, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Verification: lock every affected sale in id order before validating and
-- allocating, so two verifications cannot spend the same balance.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_verify_payment(
  p_payment_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_payment public.payments%ROWTYPE;
  v_alloc record;
  v_allocated numeric := 0;
  v_remaining numeric;
  v_balance numeric;
  v_sale public.sales%ROWTYPE;
  v_take numeric;
  v_receipt public.payment_receipts%ROWTYPE;
  v_shop public.shops%ROWTYPE;
  v_lock record;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can verify payments' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('verify', 'reject') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;
  IF v_payment.status <> 'submitted' THEN
    RAISE EXCEPTION 'This payment has already been reviewed';
  END IF;

  IF p_decision = 'reject' THEN
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'A rejection reason is required';
    END IF;
    UPDATE public.payments
    SET status = 'rejected', rejected_by = v_uid, rejected_at = now(),
        rejection_reason = btrim(p_reason), updated_at = now()
    WHERE id = p_payment_id;
    PERFORM public.api_audit('payment.rejected', 'payment', p_payment_id,
      jsonb_build_object('reason', p_reason));
    RETURN jsonb_build_object('payment_id', p_payment_id, 'status', 'rejected');
  END IF;

  -- Deterministic lock order (sale id) across explicit allocations and every
  -- open sale of this shop. Concurrent verifications queue instead of
  -- observing the same balance.
  FOR v_lock IN
    SELECT s.id
    FROM public.sales AS s
    WHERE s.id IN (
        SELECT pa.sale_id
        FROM public.payment_allocations AS pa
        WHERE pa.payment_id = p_payment_id
      )
      OR (
        s.shop_id = v_payment.shop_id
        AND s.status = 'confirmed'
        AND public.api_sale_balance(s.id) > 0
      )
    ORDER BY s.id
  LOOP
    PERFORM 1 FROM public.sales WHERE id = v_lock.id FOR UPDATE;
  END LOOP;

  FOR v_alloc IN
    SELECT * FROM public.payment_allocations
    WHERE payment_id = p_payment_id
    ORDER BY sale_id
  LOOP
    v_balance := public.api_sale_balance(v_alloc.sale_id);
    IF v_alloc.amount > v_balance THEN
      RAISE EXCEPTION 'Sale balance changed; allocation exceeds the current outstanding amount. Reject and record the payment again.';
    END IF;
    v_allocated := v_allocated + v_alloc.amount;
  END LOOP;

  v_remaining := round(v_payment.amount - v_allocated, 2);

  IF v_remaining > 0 THEN
    FOR v_sale IN
      SELECT s.* FROM public.sales s
      WHERE s.shop_id = v_payment.shop_id
        AND s.status = 'confirmed'
        AND public.api_sale_balance(s.id) > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.payment_allocations pa
          WHERE pa.payment_id = p_payment_id AND pa.sale_id = s.id
        )
      ORDER BY s.business_date, s.sale_number
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_balance := public.api_sale_balance(v_sale.id);
      v_take := LEAST(v_remaining, v_balance);
      IF v_take > 0 THEN
        INSERT INTO public.payment_allocations (payment_id, sale_id, amount)
        VALUES (p_payment_id, v_sale.id, round(v_take, 2));
        v_remaining := round(v_remaining - v_take, 2);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.payments
  SET status = 'verified', verified_by = v_uid, verified_at = now(), updated_at = now()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;

  SELECT * INTO v_shop FROM public.shops WHERE id = v_payment.shop_id;

  FOR v_alloc IN
    SELECT * FROM public.payment_allocations
    WHERE payment_id = p_payment_id
    ORDER BY sale_id
  LOOP
    INSERT INTO public.shop_ledger_entries (
      shop_id, payment_allocation_id, entry_type, amount, entry_date, created_by
    ) VALUES (
      v_payment.shop_id, v_alloc.id, 'payment_credit', v_alloc.amount,
      (now() AT TIME ZONE 'Asia/Kolkata')::date, v_uid
    );
  END LOOP;

  INSERT INTO public.payment_receipts (
    payment_id, receipt_number, amount_snapshot, method_snapshot, shop_snapshot
  ) VALUES (
    p_payment_id, public.api_next_receipt_number(), v_payment.amount,
    v_payment.method,
    jsonb_build_object('id', v_shop.id, 'name', v_shop.name, 'phone', v_shop.phone)
  )
  ON CONFLICT (payment_id) DO NOTHING
  RETURNING * INTO v_receipt;

  IF v_receipt.payment_id IS NULL THEN
    SELECT * INTO v_receipt
    FROM public.payment_receipts
    WHERE payment_id = p_payment_id;
  END IF;

  PERFORM public.api_audit('payment.verified', 'payment', p_payment_id,
    jsonb_build_object('amount', v_payment.amount));

  RETURN jsonb_build_object(
    'payment_id', p_payment_id,
    'status', 'verified',
    'receipt_number', v_receipt.receipt_number,
    'unapplied', GREATEST(v_remaining, 0)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_verify_payment(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_verify_payment(uuid, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Returns: duplicate lines rejected, cumulative quantity cap, shared sale-line
-- advisory locks for submit and review.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_submit_return(
  p_sale_id uuid,
  p_reason text,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_sale public.sales%ROWTYPE;
  v_line record;
  v_sale_line public.sale_lines%ROWTYPE;
  v_return_id uuid;
  v_count integer := 0;
  v_distinct integer := 0;
  v_reserved integer := 0;
  v_lock record;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A return reason is required';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one return line';
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND OR v_sale.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed sale can be returned';
  END IF;
  IF NOT (public.api_is_admin()
      OR v_sale.salesperson_id = v_uid
      OR public.api_is_assigned(v_sale.shop_id)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT count(*), count(DISTINCT x.sale_line_id)
  INTO v_count, v_distinct
  FROM jsonb_to_recordset(p_lines) AS x(sale_line_id uuid, cartons integer, condition text);
  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'Each sale line may appear only once in a return request';
  END IF;

  -- Serialize with other submissions and with approvals for the same lines.
  FOR v_lock IN
    SELECT DISTINCT x.sale_line_id
    FROM jsonb_to_recordset(p_lines) AS x(sale_line_id uuid, cartons integer, condition text)
    WHERE x.sale_line_id IS NOT NULL
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('ethereal.return_line:' || v_lock.sale_line_id::text)::bigint
    );
  END LOOP;

  v_return_id := gen_random_uuid();
  INSERT INTO public.return_requests (id, sale_id, shop_id, submitted_by, status, reason)
  VALUES (v_return_id, p_sale_id, v_sale.shop_id, v_uid, 'submitted', btrim(p_reason));

  FOR v_line IN
    SELECT * FROM jsonb_to_recordset(p_lines)
      AS x(sale_line_id uuid, cartons integer, condition text)
    ORDER BY sale_line_id
  LOOP
    IF v_line.sale_line_id IS NULL THEN
      RAISE EXCEPTION 'Every return line must reference a sale line';
    END IF;
    IF v_line.cartons IS NULL OR v_line.cartons <= 0 THEN
      RAISE EXCEPTION 'Return quantity must be a positive whole number';
    END IF;
    IF v_line.condition NOT IN ('reusable', 'damaged') THEN
      RAISE EXCEPTION 'Return condition must be reusable or damaged';
    END IF;

    SELECT * INTO v_sale_line
    FROM public.sale_lines
    WHERE id = v_line.sale_line_id AND sale_id = p_sale_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A return line does not belong to this sale';
    END IF;

    SELECT COALESCE(SUM(rl.cartons), 0) INTO v_reserved
    FROM public.return_lines rl
    JOIN public.return_requests rr ON rr.id = rl.return_request_id
    WHERE rl.sale_line_id = v_line.sale_line_id
      AND rr.status IN ('submitted', 'approved');

    IF v_line.cartons + v_reserved > v_sale_line.cartons THEN
      RAISE EXCEPTION 'Return quantity exceeds the remaining returnable quantity for %',
        v_sale_line.product_name_snapshot;
    END IF;

    INSERT INTO public.return_lines (
      return_request_id, sale_id, sale_line_id, variant_id, cartons, condition
    ) VALUES (
      v_return_id, p_sale_id, v_line.sale_line_id, v_sale_line.variant_id,
      v_line.cartons, v_line.condition
    );
  END LOOP;

  PERFORM public.api_audit('return.submitted', 'return_request', v_return_id,
    jsonb_build_object('sale_id', p_sale_id));
  RETURN jsonb_build_object('return_id', v_return_id, 'status', 'submitted');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_submit_return(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_submit_return(uuid, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_review_return(
  p_return_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_return public.return_requests%ROWTYPE;
  v_line public.return_lines%ROWTYPE;
  v_sale_line public.sale_lines%ROWTYPE;
  v_already integer;
  v_remaining integer;
  v_credit numeric := 0;
  v_movement_type text;
  v_bucket text;
  v_lock record;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can review returns' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  SELECT * INTO v_return FROM public.return_requests WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return request not found';
  END IF;
  IF v_return.status <> 'submitted' THEN
    RAISE EXCEPTION 'This return request has already been reviewed';
  END IF;

  IF p_decision = 'reject' THEN
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'A rejection reason is required';
    END IF;
    UPDATE public.return_requests
    SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
        review_reason = btrim(p_reason)
    WHERE id = p_return_id;
    PERFORM public.api_audit('return.rejected', 'return_request', p_return_id,
      jsonb_build_object('reason', p_reason));
    RETURN jsonb_build_object('return_id', p_return_id, 'status', 'rejected');
  END IF;

  -- Serialize on the shared sale lines first, then on inventory variants.
  FOR v_lock IN
    SELECT DISTINCT rl.sale_line_id
    FROM public.return_lines rl
    WHERE rl.return_request_id = p_return_id
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext('ethereal.return_line:' || v_lock.sale_line_id::text)::bigint
    );
  END LOOP;

  FOR v_lock IN
    SELECT DISTINCT rl.variant_id
    FROM public.return_lines rl
    WHERE rl.return_request_id = p_return_id
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_lock.variant_id::text)::bigint);
  END LOOP;

  FOR v_line IN
    SELECT * FROM public.return_lines
    WHERE return_request_id = p_return_id
    ORDER BY sale_line_id
  LOOP
    SELECT * INTO v_sale_line FROM public.sale_lines WHERE id = v_line.sale_line_id;

    SELECT COALESCE(SUM(rl.approved_cartons), 0) INTO v_already
    FROM public.return_lines rl
    JOIN public.return_requests rr ON rr.id = rl.return_request_id
    WHERE rl.sale_line_id = v_line.sale_line_id
      AND rr.status = 'approved';

    v_remaining := v_sale_line.cartons - v_already;
    IF v_line.cartons > v_remaining THEN
      RAISE EXCEPTION 'Return exceeds the remaining returnable quantity for %',
        v_sale_line.product_name_snapshot;
    END IF;

    IF v_line.condition = 'reusable' THEN
      v_movement_type := 'return_reusable';
      v_bucket := 'saleable';
    ELSE
      v_movement_type := 'return_damaged';
      v_bucket := 'damaged';
    END IF;

    INSERT INTO public.inventory_movements (
      variant_id, stock_bucket, movement_type, cartons_delta,
      source_type, source_id, actor_id, reason
    ) VALUES (
      v_line.variant_id, v_bucket, v_movement_type, v_line.cartons,
      'return_request', p_return_id, v_uid, 'Approved return'
    );

    UPDATE public.return_lines
    SET approved_cartons = cartons
    WHERE id = v_line.id;

    v_credit := v_credit + (v_line.cartons * v_sale_line.unit_price_snapshot);
  END LOOP;

  UPDATE public.return_requests
  SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(),
      review_reason = NULLIF(btrim(p_reason), '')
  WHERE id = p_return_id;

  INSERT INTO public.shop_ledger_entries (
    shop_id, sale_id, return_request_id, entry_type, amount, entry_date, created_by
  ) VALUES (
    v_return.shop_id, v_return.sale_id, p_return_id, 'return_credit',
    round(v_credit, 2), (now() AT TIME ZONE 'Asia/Kolkata')::date, v_uid
  );

  PERFORM public.api_audit('return.approved', 'return_request', p_return_id,
    jsonb_build_object('credit', round(v_credit, 2)));

  RETURN jsonb_build_object(
    'return_id', p_return_id,
    'status', 'approved',
    'credit', round(v_credit, 2)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_review_return(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_review_return(uuid, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Stock receipts: replay returns an idempotent result, verifies payload and
-- actor, and writes no duplicate audit event.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_receive_stock(
  p_variant_id uuid,
  p_cartons integer,
  p_reason text DEFAULT NULL,
  p_client_reference uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_key uuid := COALESCE(p_client_reference, gen_random_uuid());
  v_product text;
  v_rows integer := 0;
  v_existing public.inventory_movements%ROWTYPE;
  v_saleable bigint;
  v_damaged bigint;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can receive stock' USING ERRCODE = '42501';
  END IF;
  IF p_cartons IS NULL OR p_cartons <= 0 THEN
    RAISE EXCEPTION 'Cartons received must be greater than zero';
  END IF;

  SELECT p.name || ' · ' || pv.bottles_per_carton || ' bottles'
  INTO v_product
  FROM public.product_variants pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.id = p_variant_id AND pv.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product variant not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_variant_id::text)::bigint);

  INSERT INTO public.inventory_movements (
    variant_id, stock_bucket, movement_type, cartons_delta,
    source_type, source_id, idempotency_key, actor_id, reason
  ) VALUES (
    p_variant_id, 'saleable', 'received', p_cartons,
    'manual_receipt', gen_random_uuid(), v_key, v_uid,
    COALESCE(NULLIF(btrim(p_reason), ''), 'Stock received')
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  v_saleable := public.api_stock_qty(p_variant_id, 'saleable');
  v_damaged := public.api_stock_qty(p_variant_id, 'damaged');

  IF v_rows = 0 THEN
    SELECT * INTO v_existing
    FROM public.inventory_movements
    WHERE idempotency_key = v_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Stock receipt conflict could not be resolved';
    END IF;
    IF v_existing.actor_id <> v_uid
      OR v_existing.variant_id <> p_variant_id
      OR v_existing.cartons_delta <> p_cartons
      OR v_existing.source_type <> 'manual_receipt'
    THEN
      RAISE EXCEPTION 'This client reference was already used for a different stock receipt'
        USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object(
      'variant_id', p_variant_id,
      'saleable', v_saleable,
      'damaged', v_damaged,
      'idempotent', true
    );
  END IF;

  PERFORM public.api_audit('inventory.received', 'product_variant', p_variant_id,
    jsonb_build_object('cartons', p_cartons, 'product', v_product));

  RETURN jsonb_build_object(
    'variant_id', p_variant_id,
    'saleable', v_saleable,
    'damaged', v_damaged,
    'idempotent', false
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_receive_stock(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_receive_stock(uuid, integer, text, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Stock adjustment: same per-variant lock as every other stock mutation, and
-- bigint balance arithmetic so a large aggregate cannot overflow 32 bits.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_adjust_stock(
  p_variant_id uuid,
  p_bucket text,
  p_cartons_delta integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_current bigint;
  v_after bigint;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can adjust stock' USING ERRCODE = '42501';
  END IF;
  IF p_bucket NOT IN ('saleable', 'damaged') THEN
    RAISE EXCEPTION 'Invalid stock bucket';
  END IF;
  IF p_cartons_delta IS NULL OR p_cartons_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment must be a non-zero number of cartons';
  END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required for a stock adjustment';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE id = p_variant_id) THEN
    RAISE EXCEPTION 'Product variant not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_variant_id::text)::bigint);
  v_current := public.api_stock_qty(p_variant_id, p_bucket);
  v_after := v_current + p_cartons_delta;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Adjustment would make % stock negative (current: %)', p_bucket, v_current;
  END IF;

  INSERT INTO public.inventory_movements (
    variant_id, stock_bucket, movement_type, cartons_delta,
    source_type, source_id, actor_id, reason
  ) VALUES (
    p_variant_id, p_bucket, 'adjustment', p_cartons_delta,
    'manual_adjustment', gen_random_uuid(), v_uid, btrim(p_reason)
  );

  PERFORM public.api_audit('inventory.adjusted', 'product_variant', p_variant_id,
    jsonb_build_object('bucket', p_bucket, 'delta', p_cartons_delta, 'reason', p_reason));

  RETURN jsonb_build_object(
    'variant_id', p_variant_id,
    'saleable', public.api_stock_qty(p_variant_id, 'saleable'),
    'damaged', public.api_stock_qty(p_variant_id, 'damaged')
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_adjust_stock(uuid, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_adjust_stock(uuid, text, integer, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Inventory list: wide stock recordset so the bigint aggregate round-trips.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_inventory_list(p_limit integer DEFAULT 150)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_stock jsonb;
  v_moves jsonb;
BEGIN
  IF public.api_role() IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'variant_id', c.variant_id,
    'product_name', c.product_name,
    'sku', c.sku,
    'pack_size_ml', c.pack_size_ml,
    'bottles_per_carton', c.bottles_per_carton,
    'saleable', c.stock_saleable,
    'damaged', c.stock_damaged,
    'default_price', c.default_price
  ) ORDER BY c.pack_size_ml), '[]'::jsonb)
  INTO v_stock
  FROM jsonb_to_recordset(public.api_catalog()) AS c(
    variant_id uuid, product_name text, sku text, pack_size_ml integer,
    bottles_per_carton integer, stock_saleable bigint, stock_damaged bigint,
    default_price numeric
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'variant_id', m.variant_id,
    'product_name', p.name,
    'bottles_per_carton', pv.bottles_per_carton,
    'stock_bucket', m.stock_bucket,
    'movement_type', m.movement_type,
    'cartons_delta', m.cartons_delta,
    'source_type', m.source_type,
    'source_id', m.source_id,
    'reason', m.reason,
    'actor_name', pr.full_name,
    'occurred_at', m.occurred_at
  ) ORDER BY m.occurred_at DESC), '[]'::jsonb)
  INTO v_moves
  FROM (
    SELECT * FROM public.inventory_movements
    ORDER BY occurred_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 150), 1)
  ) m
  JOIN public.product_variants pv ON pv.id = m.variant_id
  JOIN public.products p ON p.id = pv.product_id
  JOIN public.profiles pr ON pr.id = m.actor_id;

  RETURN jsonb_build_object('stock', v_stock, 'movements', v_moves);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_inventory_list(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_inventory_list(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- Team list: explicit NULL-safe deny. `NULL NOT IN (...)` is NULL, not TRUE,
-- so the original CASE fell through to the ELSE branch for pending/disabled
-- accounts and returned the whole directory.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_team_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := public.api_role();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'full_name', p.full_name,
      'email', p.email,
      'role', p.role::text,
      'status', p.status::text,
      'avatar_url', p.avatar_url,
      'created_at', p.created_at,
      'approved_at', p.approved_at,
      'shop_count', (SELECT COUNT(*) FROM public.shop_salespeople ss WHERE ss.salesperson_id = p.id)
    ) ORDER BY
        CASE p.status::text WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        p.full_name), '[]'::jsonb)
    FROM public.profiles p
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_team_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_team_list() TO authenticated;

-- ----------------------------------------------------------------------------
-- Employee status: the NULL-safe deny above is unrelated here; the fix is the
-- global owner-membership advisory lock plus an active-owner invariant that
-- also covers moving the last owner to `pending`, not only `disabled`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_set_employee_status(
  p_profile_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_target public.profiles%ROWTYPE;
  v_owner_count bigint;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can manage employees' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('pending', 'approved', 'disabled') THEN
    RAISE EXCEPTION 'Invalid employee status';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ethereal.owner_membership')::bigint);

  SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;
  IF v_target.role::text = 'owner' AND v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change an owner account' USING ERRCODE = '42501';
  END IF;
  IF v_role = 'admin' AND v_target.role::text IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Admins can only manage salesperson accounts' USING ERRCODE = '42501';
  END IF;
  IF p_profile_id = v_uid AND p_status <> 'approved' THEN
    RAISE EXCEPTION 'You cannot disable or unapprove your own account';
  END IF;

  IF v_target.role::text = 'owner'
    AND v_target.status::text = 'approved'
    AND p_status <> 'approved'
  THEN
    SELECT COUNT(*) INTO v_owner_count
    FROM public.profiles
    WHERE role::text = 'owner' AND status = 'approved';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'The last active owner cannot be disabled or unapproved';
    END IF;
  END IF;

  UPDATE public.profiles
  SET status = p_status,
      approved_at = CASE WHEN p_status = 'approved' THEN COALESCE(approved_at, now()) ELSE approved_at END,
      approved_by = CASE WHEN p_status = 'approved' THEN COALESCE(approved_by, v_uid) ELSE approved_by END,
      disabled_at = CASE WHEN p_status = 'disabled' THEN now() ELSE NULL END,
      updated_at = now()
  WHERE id = p_profile_id;

  PERFORM public.api_audit('employee.' || p_status, 'profile', p_profile_id,
    jsonb_build_object('status', p_status));

  RETURN jsonb_build_object('id', p_profile_id, 'status', p_status);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_set_employee_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_set_employee_status(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Employee role: same owner-membership lock. Only demoting a currently active
-- owner is constrained, so a pending owner can still be reclassified.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_set_employee_role(
  p_profile_id uuid,
  p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_target public.profiles%ROWTYPE;
  v_owner_count bigint;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change roles' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('owner', 'admin', 'salesperson') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ethereal.owner_membership')::bigint);

  SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF v_target.role::text = 'owner'
    AND v_target.status::text = 'approved'
    AND p_role <> 'owner'
  THEN
    SELECT COUNT(*) INTO v_owner_count
    FROM public.profiles
    WHERE role::text = 'owner' AND status = 'approved';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'The last owner cannot be demoted';
    END IF;
  END IF;

  UPDATE public.profiles
  SET role = p_role,
      status = CASE WHEN p_role IN ('owner', 'admin') THEN 'approved' ELSE status END,
      approved_at = CASE WHEN p_role IN ('owner', 'admin') THEN COALESCE(approved_at, now()) ELSE approved_at END,
      approved_by = CASE WHEN p_role IN ('owner', 'admin') THEN COALESCE(approved_by, v_uid) ELSE approved_by END,
      disabled_at = CASE WHEN p_role IN ('owner', 'admin') THEN NULL ELSE disabled_at END,
      updated_at = now()
  WHERE id = p_profile_id;

  PERFORM public.api_audit('employee.role_changed', 'profile', p_profile_id,
    jsonb_build_object('role', p_role));

  RETURN jsonb_build_object('id', p_profile_id, 'role', p_role);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_set_employee_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_set_employee_role(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Audit log: same NULL-safe deny as api_team_list().
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_audit_log(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := public.api_role();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'action', a.action,
      'entity_type', a.entity_type,
      'entity_id', a.entity_id,
      'actor_name', p.full_name,
      'occurred_at', a.occurred_at,
      'metadata', a.safe_metadata
    ) ORDER BY a.occurred_at DESC), '[]'::jsonb)
    FROM (
      SELECT * FROM public.audit_events
      ORDER BY occurred_at DESC
      LIMIT GREATEST(COALESCE(p_limit, 200), 1)
    ) a
    LEFT JOIN public.profiles p ON p.id = a.actor_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_audit_log(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_audit_log(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- Dashboard: keep cash-received metrics, add explicitly named applied
-- (allocation) metrics so unapplied cash cannot be mistaken for settlement.
-- Stock recordset widened to bigint to match api_stock_qty().
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_month_start date := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)::date;
  v_today_sales numeric := 0;
  v_today_count integer := 0;
  v_collected numeric := 0;
  v_applied_today numeric := 0;
  v_outstanding numeric := 0;
  v_month_sales numeric := 0;
  v_month_collected numeric := 0;
  v_applied_month numeric := 0;
  v_month_expenses numeric := 0;
  v_pending_credit integer := 0;
  v_pending_payments integer := 0;
  v_pending_returns integer := 0;
  v_pending_expenses integer := 0;
  v_pending_shops integer := 0;
  v_pending_employees integer := 0;
  v_stock jsonb;
  v_recent jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(s.grand_total), 0), COUNT(*)
  INTO v_today_sales, v_today_count
  FROM public.sales s
  WHERE s.business_date = v_today AND s.status = 'confirmed'
    AND (public.api_is_admin() OR s.salesperson_id = v_uid OR public.api_is_assigned(s.shop_id));

  SELECT COALESCE(SUM(p.amount), 0)
  INTO v_collected
  FROM public.payments p
  WHERE p.status = 'verified'
    AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date = v_today
    AND (public.api_is_admin() OR p.recorded_by = v_uid OR public.api_is_assigned(p.shop_id));

  SELECT COALESCE(SUM(pa.amount), 0)
  INTO v_applied_today
  FROM public.payment_allocations pa
  JOIN public.payments p ON p.id = pa.payment_id
  WHERE p.status = 'verified'
    AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date = v_today
    AND (public.api_is_admin() OR p.recorded_by = v_uid OR public.api_is_assigned(p.shop_id));

  SELECT COALESCE(SUM(public.api_sale_balance(s.id)), 0)
  INTO v_outstanding
  FROM public.sales s
  WHERE s.status = 'confirmed'
    AND (public.api_is_admin() OR s.salesperson_id = v_uid OR public.api_is_assigned(s.shop_id));

  SELECT COALESCE(SUM(s.grand_total), 0)
  INTO v_month_sales
  FROM public.sales s
  WHERE s.status = 'confirmed' AND s.business_date >= v_month_start
    AND (public.api_is_admin() OR s.salesperson_id = v_uid OR public.api_is_assigned(s.shop_id));

  SELECT COALESCE(SUM(p.amount), 0)
  INTO v_month_collected
  FROM public.payments p
  WHERE p.status = 'verified'
    AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date >= v_month_start
    AND (public.api_is_admin() OR p.recorded_by = v_uid OR public.api_is_assigned(p.shop_id));

  SELECT COALESCE(SUM(pa.amount), 0)
  INTO v_applied_month
  FROM public.payment_allocations pa
  JOIN public.payments p ON p.id = pa.payment_id
  WHERE p.status = 'verified'
    AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date >= v_month_start
    AND (public.api_is_admin() OR p.recorded_by = v_uid OR public.api_is_assigned(p.shop_id));

  SELECT COALESCE(SUM(e.amount), 0)
  INTO v_month_expenses
  FROM public.expense_claims e
  WHERE e.status IN ('approved', 'paid')
    AND e.expense_date >= v_month_start
    AND (public.api_is_admin() OR e.submitted_by = v_uid);

  SELECT COUNT(*) INTO v_pending_credit FROM public.sales
  WHERE status = 'pending_credit_approval'
    AND (public.api_is_admin() OR salesperson_id = v_uid OR public.api_is_assigned(shop_id));

  SELECT COUNT(*) INTO v_pending_payments FROM public.payments
  WHERE status = 'submitted'
    AND (public.api_is_admin() OR recorded_by = v_uid OR public.api_is_assigned(shop_id));

  SELECT COUNT(*) INTO v_pending_returns FROM public.return_requests
  WHERE status = 'submitted'
    AND (public.api_is_admin() OR submitted_by = v_uid OR public.api_is_assigned(shop_id));

  SELECT COUNT(*) INTO v_pending_expenses FROM public.expense_claims
  WHERE status = 'submitted'
    AND (public.api_is_admin() OR submitted_by = v_uid);

  IF public.api_is_admin() THEN
    SELECT COUNT(*) INTO v_pending_shops FROM public.shops WHERE status = 'pending';
    SELECT COUNT(*) INTO v_pending_employees FROM public.profiles WHERE status = 'pending';
  ELSE
    SELECT COUNT(*) INTO v_pending_shops FROM public.shops
    WHERE status = 'pending' AND submitted_by = v_uid;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'variant_id', c.variant_id,
    'product_name', c.product_name,
    'bottles_per_carton', c.bottles_per_carton,
    'pack_size_ml', c.pack_size_ml,
    'saleable', c.stock_saleable,
    'damaged', c.stock_damaged,
    'default_price', c.default_price
  ) ORDER BY c.pack_size_ml), '[]'::jsonb)
  INTO v_stock
  FROM jsonb_to_recordset(public.api_catalog()) AS c(
    variant_id uuid, product_name text, pack_size_ml integer,
    bottles_per_carton integer, stock_saleable bigint, stock_damaged bigint,
    default_price numeric
  );

  v_recent := public.api_sales_list(NULL, NULL, 6);

  RETURN jsonb_build_object(
    'business_date', v_today,
    'today_sales', v_today_sales,
    'today_transactions', v_today_count,
    'collected_today', v_collected,
    'applied_today', v_applied_today,
    'outstanding', v_outstanding,
    'month_sales', v_month_sales,
    'month_collected', v_month_collected,
    'applied_month', v_applied_month,
    'month_expenses', v_month_expenses,
    'pending_credit_sales', v_pending_credit,
    'pending_payments', v_pending_payments,
    'pending_returns', v_pending_returns,
    'pending_expenses', v_pending_expenses,
    'pending_shops', v_pending_shops,
    'pending_employees', v_pending_employees,
    'stock', v_stock,
    'recent_sales', v_recent
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_dashboard() TO authenticated;

-- ----------------------------------------------------------------------------
-- Re-assert helper revokes: CREATE OR REPLACE (and the DROP/CREATE of
-- api_stock_qty above) must not leave an internal helper reachable.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.api_stock_qty(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_sale_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_open_sales(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_audit(text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_next_invoice_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_next_receipt_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_issue_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;

