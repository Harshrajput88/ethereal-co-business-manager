-- ============================================================================
-- Ethereal Co. — inventory, returns and expense RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Inventory
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
    bottles_per_carton integer, stock_saleable integer, stock_damaged integer,
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

  PERFORM public.api_audit('inventory.received', 'product_variant', p_variant_id,
    jsonb_build_object('cartons', p_cartons, 'product', v_product));

  RETURN jsonb_build_object(
    'variant_id', p_variant_id,
    'saleable', public.api_stock_qty(p_variant_id, 'saleable'),
    'damaged', public.api_stock_qty(p_variant_id, 'damaged')
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_receive_stock(uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_receive_stock(uuid, integer, text, uuid) TO authenticated;

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
  v_current integer;
  v_after integer;
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
-- Returns
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
  v_count integer;
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

  v_return_id := gen_random_uuid();
  INSERT INTO public.return_requests (id, sale_id, shop_id, submitted_by, status, reason)
  VALUES (v_return_id, p_sale_id, v_sale.shop_id, v_uid, 'submitted', btrim(p_reason));

  SELECT COUNT(*) INTO v_count
  FROM jsonb_to_recordset(p_lines) AS x(sale_line_id uuid, cartons integer, condition text);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Add at least one return line';
  END IF;

  FOR v_line IN
    SELECT * FROM jsonb_to_recordset(p_lines)
      AS x(sale_line_id uuid, cartons integer, condition text)
  LOOP
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

    IF v_line.cartons > v_sale_line.cartons THEN
      RAISE EXCEPTION 'Return quantity exceeds the quantity sold';
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

  FOR v_line IN SELECT * FROM public.return_lines WHERE return_request_id = p_return_id LOOP
    SELECT * INTO v_sale_line FROM public.sale_lines WHERE id = v_line.sale_line_id;
    SELECT COALESCE(SUM(rl.approved_cartons), 0) INTO v_already
    FROM public.return_lines rl
    JOIN public.return_requests rr ON rr.id = rl.return_request_id
    WHERE rl.sale_line_id = v_line.sale_line_id
      AND rr.status = 'approved';

    v_remaining := v_sale_line.cartons - v_already;
    IF v_line.cartons > v_remaining THEN
      RAISE EXCEPTION 'Return exceeds the remaining returnable quantity for %', v_sale_line.product_name_snapshot;
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

CREATE OR REPLACE FUNCTION public.api_returns_list(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN '[]'::jsonb ELSE (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'sale_id', r.sale_id,
      'sale_number', s.sale_number,
      'shop_id', r.shop_id,
      'shop_name', sh.name,
      'submitted_by', r.submitted_by,
      'submitted_by_name', pr.full_name,
      'status', r.status,
      'reason', r.reason,
      'submitted_at', r.submitted_at,
      'reviewed_at', r.reviewed_at,
      'review_reason', r.review_reason,
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'product_name', sl.product_name_snapshot,
          'cartons', rl.cartons,
          'approved_cartons', rl.approved_cartons,
          'condition', rl.condition,
          'unit_price', sl.unit_price_snapshot
        ))
        FROM public.return_lines rl
        JOIN public.sale_lines sl ON sl.id = rl.sale_line_id
        WHERE rl.return_request_id = r.id
      ), '[]'::jsonb)
    ) ORDER BY r.submitted_at DESC), '[]'::jsonb)
    FROM (
      SELECT r.* FROM public.return_requests r
      WHERE (public.api_is_admin()
        OR r.submitted_by = (SELECT auth.uid())
        OR public.api_is_assigned(r.shop_id))
      ORDER BY r.submitted_at DESC
      LIMIT GREATEST(COALESCE(p_limit, 200), 1)
    ) r
    JOIN public.sales s ON s.id = r.sale_id
    JOIN public.shops sh ON sh.id = r.shop_id
    JOIN public.profiles pr ON pr.id = r.submitted_by
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_returns_list(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_returns_list(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- Expenses
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_expenses_list(
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
      'id', e.id,
      'submitted_by', e.submitted_by,
      'submitted_by_name', pr.full_name,
      'expense_date', e.expense_date,
      'category', e.category,
      'description', e.description,
      'amount', e.amount,
      'status', e.status,
      'review_reason', e.review_reason,
      'reviewed_at', e.reviewed_at,
      'paid_at', e.paid_at,
      'created_at', e.created_at
    ) ORDER BY e.expense_date DESC, e.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT e.* FROM public.expense_claims e
      WHERE (p_from IS NULL OR e.expense_date >= p_from)
        AND (p_to IS NULL OR e.expense_date <= p_to)
        AND (public.api_is_admin() OR e.submitted_by = (SELECT auth.uid()))
      ORDER BY e.expense_date DESC, e.created_at DESC
      LIMIT GREATEST(COALESCE(p_limit, 300), 1)
    ) e
    JOIN public.profiles pr ON pr.id = e.submitted_by
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_expenses_list(date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_expenses_list(date, date, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_submit_expense(
  p_expense_date date,
  p_category text,
  p_description text,
  p_amount numeric,
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
  v_existing public.expense_claims%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_client_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expense_claims WHERE claim_reference = p_client_reference;
    IF FOUND THEN
      RETURN jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'idempotent', true);
    END IF;
  END IF;
  IF NULLIF(btrim(p_category), '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required';
  END IF;
  IF NULLIF(btrim(p_description), '') IS NULL THEN
    RAISE EXCEPTION 'Expense description is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Expense amount must be greater than zero';
  END IF;

  INSERT INTO public.expense_claims (
    claim_reference, submitted_by, expense_date, category, description, amount, status
  ) VALUES (
    COALESCE(p_client_reference, gen_random_uuid()), v_uid,
    COALESCE(p_expense_date, (now() AT TIME ZONE 'Asia/Kolkata')::date),
    btrim(p_category), btrim(p_description), round(p_amount, 2), 'submitted'
  )
  RETURNING id INTO v_id;

  PERFORM public.api_audit('expense.submitted', 'expense_claim', v_id,
    jsonb_build_object('amount', round(p_amount, 2), 'category', p_category));
  RETURN jsonb_build_object('id', v_id, 'status', 'submitted');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_submit_expense(date, text, text, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_submit_expense(date, text, text, numeric, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_review_expense(
  p_expense_id uuid,
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
  v_expense public.expense_claims%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can review expenses' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  SELECT * INTO v_expense FROM public.expense_claims WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  IF v_expense.status <> 'submitted' THEN
    RAISE EXCEPTION 'This expense has already been reviewed';
  END IF;
  IF v_expense.submitted_by = v_uid THEN
    RAISE EXCEPTION 'You cannot approve or reject your own expense';
  END IF;

  IF p_decision = 'reject' THEN
    IF NULLIF(btrim(p_reason), '') IS NULL THEN
      RAISE EXCEPTION 'A rejection reason is required';
    END IF;
    UPDATE public.expense_claims
    SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
        review_reason = btrim(p_reason), updated_at = now()
    WHERE id = p_expense_id;
  ELSE
    UPDATE public.expense_claims
    SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(),
        review_reason = NULLIF(btrim(p_reason), ''), updated_at = now()
    WHERE id = p_expense_id;
  END IF;

  PERFORM public.api_audit('expense.' || p_decision || 'd', 'expense_claim', p_expense_id,
    jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object(
    'id', p_expense_id,
    'status', CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_review_expense(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_review_expense(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_mark_expense_paid(p_expense_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_expense public.expense_claims%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can settle expenses' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_expense FROM public.expense_claims WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  IF v_expense.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved expense can be marked as paid';
  END IF;

  UPDATE public.expense_claims
  SET status = 'paid', paid_at = now(), paid_by = v_uid, updated_at = now()
  WHERE id = p_expense_id;

  PERFORM public.api_audit('expense.paid', 'expense_claim', p_expense_id, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_expense_id, 'status', 'paid');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_mark_expense_paid(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_mark_expense_paid(uuid) TO authenticated;
