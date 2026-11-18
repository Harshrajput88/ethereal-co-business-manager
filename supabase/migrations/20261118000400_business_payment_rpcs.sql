-- ============================================================================
-- Ethereal Co. — payment recording, verification and receivables RPCs
-- ============================================================================

CREATE OR REPLACE FUNCTION public.api_shop_open_sales(p_shop_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN public.api_role() IS NULL THEN '[]'::jsonb
    WHEN NOT (public.api_is_admin() OR public.api_is_assigned(p_shop_id)) THEN '[]'::jsonb
    ELSE (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'sale_id', o.sale_id,
        'sale_number', o.sale_number,
        'business_date', o.business_date,
        'grand_total', o.grand_total,
        'balance', o.balance
      ) ORDER BY o.business_date, o.sale_number), '[]'::jsonb)
      FROM public.api_open_sales(p_shop_id) AS o
    )
  END
$function$;
REVOKE ALL ON FUNCTION public.api_shop_open_sales(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_shop_open_sales(uuid) TO authenticated;

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
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_client_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payments WHERE payment_reference = p_client_reference;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'payment_id', v_existing.id, 'status', v_existing.status, 'idempotent', true
      );
    END IF;
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

  FOR v_alloc IN
    SELECT * FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric)
  LOOP
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 THEN
      RAISE EXCEPTION 'Allocation amounts must be greater than zero';
    END IF;
    SELECT * INTO v_sale FROM public.sales WHERE id = v_alloc.sale_id;
    IF NOT FOUND OR v_sale.shop_id <> p_shop_id OR v_sale.status <> 'confirmed' THEN
      RAISE EXCEPTION 'An allocation references an invalid sale';
    END IF;
    v_balance := public.api_sale_balance(v_alloc.sale_id);
    IF v_alloc.amount > v_balance THEN
      RAISE EXCEPTION 'Allocation exceeds the outstanding balance for sale #%', v_sale.sale_number;
    END IF;
    v_alloc_total := v_alloc_total + v_alloc.amount;
  END LOOP;

  IF v_alloc_total > round(p_amount, 2) THEN
    RAISE EXCEPTION 'Allocations cannot exceed the payment amount';
  END IF;

  INSERT INTO public.payments (
    payment_reference, shop_id, recorded_by, method, amount, received_at,
    external_reference, status
  ) VALUES (
    COALESCE(p_client_reference, gen_random_uuid()), p_shop_id, v_uid,
    p_method, round(p_amount, 2), COALESCE(p_received_at, now()),
    NULLIF(btrim(p_external_reference), ''), 'submitted'
  )
  RETURNING id INTO v_payment_id;

  INSERT INTO public.payment_allocations (payment_id, sale_id, amount)
  SELECT v_payment_id, x.sale_id, round(x.amount, 2)
  FROM jsonb_to_recordset(p_allocations) AS x(sale_id uuid, amount numeric);

  PERFORM public.api_audit('payment.submitted', 'payment', v_payment_id,
    jsonb_build_object('amount', round(p_amount, 2), 'method', p_method));

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'status', 'submitted',
    'amount', round(p_amount, 2),
    'allocated', v_alloc_total
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_record_payment(uuid, text, numeric, timestamptz, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_record_payment(uuid, text, numeric, timestamptz, text, jsonb, uuid) TO authenticated;

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

  -- Validate recorded allocations and compute how much is still unapplied.
  FOR v_alloc IN
    SELECT * FROM public.payment_allocations WHERE payment_id = p_payment_id
  LOOP
    v_balance := public.api_sale_balance(v_alloc.sale_id);
    IF v_alloc.amount > v_balance THEN
      RAISE EXCEPTION 'Sale balance changed; allocation exceeds the current outstanding amount. Reject and record the payment again.';
    END IF;
    v_allocated := v_allocated + v_alloc.amount;
  END LOOP;

  v_remaining := round(v_payment.amount - v_allocated, 2);

  -- Apply any unallocated amount to the oldest outstanding invoices (FIFO).
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
    SELECT * FROM public.payment_allocations WHERE payment_id = p_payment_id
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

CREATE OR REPLACE FUNCTION public.api_payments_list(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_limit integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN '[]'::jsonb ELSE (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'shop_id', p.shop_id,
      'shop_name', sh.name,
      'recorded_by', p.recorded_by,
      'recorded_by_name', pr.full_name,
      'method', p.method,
      'amount', p.amount,
      'received_at', p.received_at,
      'external_reference', p.external_reference,
      'status', p.status,
      'verified_at', p.verified_at,
      'rejection_reason', p.rejection_reason,
      'receipt_number', (SELECT r.receipt_number FROM public.payment_receipts r WHERE r.payment_id = p.id),
      'allocations', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sale_id', pa.sale_id,
          'sale_number', s.sale_number,
          'amount', pa.amount
        ) ORDER BY s.sale_number)
        FROM public.payment_allocations pa
        JOIN public.sales s ON s.id = pa.sale_id
        WHERE pa.payment_id = p.id
      ), '[]'::jsonb)
    ) ORDER BY p.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT p.* FROM public.payments p
      WHERE ((p_from IS NULL AND p_to IS NULL)
          OR (p.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN COALESCE(p_from, '1900-01-01'::date) AND COALESCE(p_to, '2999-12-31'::date))
        AND (public.api_is_admin()
          OR p.recorded_by = (SELECT auth.uid())
          OR public.api_is_assigned(p.shop_id))
      ORDER BY p.created_at DESC
      LIMIT GREATEST(COALESCE(p_limit, 300), 1)
    ) p
    JOIN public.shops sh ON sh.id = p.shop_id
    JOIN public.profiles pr ON pr.id = p.recorded_by
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_payments_list(date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_payments_list(date, date, integer) TO authenticated;
