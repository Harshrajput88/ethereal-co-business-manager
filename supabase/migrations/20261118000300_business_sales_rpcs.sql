-- ============================================================================
-- Ethereal Co. — catalog, pricing and sales RPCs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Catalog with effective default price and derived stock
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN '[]'::jsonb ELSE (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'variant_id', v.variant_id,
      'product_id', v.product_id,
      'product_name', v.product_name,
      'sku', v.sku,
      'pack_size_ml', v.pack_size_ml,
      'bottles_per_carton', v.bottles_per_carton,
      'label', v.product_name || ' · ' || v.bottles_per_carton || ' bottles/carton',
      'active', v.active,
      'default_price', v.default_price,
      'stock_saleable', public.api_stock_qty(v.variant_id, 'saleable'),
      'stock_damaged', public.api_stock_qty(v.variant_id, 'damaged')
    ) ORDER BY v.pack_size_ml), '[]'::jsonb)
    FROM (
      SELECT pv.id AS variant_id, pv.product_id, p.name AS product_name,
             pv.sku, pv.pack_size_ml, pv.bottles_per_carton,
             (pv.active AND p.active) AS active,
             (SELECT dp.amount FROM public.default_prices dp
              WHERE dp.variant_id = pv.id
                AND dp.valid_from <= now()
                AND (dp.valid_to IS NULL OR dp.valid_to > now())
              ORDER BY dp.valid_from DESC LIMIT 1) AS default_price
      FROM public.product_variants pv
      JOIN public.products p ON p.id = pv.product_id
    ) v
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_catalog() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_shop_prices(p_shop_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN '[]'::jsonb ELSE (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', o.id,
      'shop_id', o.shop_id,
      'shop_name', s.name,
      'variant_id', o.variant_id,
      'product_name', p.name,
      'sku', pv.sku,
      'bottles_per_carton', pv.bottles_per_carton,
      'amount', o.amount,
      'default_amount', (
        SELECT dp.amount FROM public.default_prices dp
        WHERE dp.variant_id = o.variant_id
          AND dp.valid_from <= now()
          AND (dp.valid_to IS NULL OR dp.valid_to > now())
        ORDER BY dp.valid_from DESC LIMIT 1
      ),
      'valid_from', o.valid_from
    ) ORDER BY s.name, pv.pack_size_ml), '[]'::jsonb)
    FROM public.shop_price_overrides o
    JOIN public.shops s ON s.id = o.shop_id
    JOIN public.product_variants pv ON pv.id = o.variant_id
    JOIN public.products p ON p.id = pv.product_id
    WHERE (p_shop_id IS NULL OR o.shop_id = p_shop_id)
      AND (o.valid_from <= now() AND (o.valid_to IS NULL OR o.valid_to > now()))
      AND (public.api_is_admin() OR public.api_is_assigned(o.shop_id))
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_shop_prices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_shop_prices(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_set_default_price(p_variant_id uuid, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can set prices' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Price must be greater than zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE id = p_variant_id) THEN
    RAISE EXCEPTION 'Product variant not found';
  END IF;

  UPDATE public.default_prices
  SET valid_to = now()
  WHERE variant_id = p_variant_id AND valid_to IS NULL;

  INSERT INTO public.default_prices (variant_id, amount, valid_from, set_by)
  VALUES (p_variant_id, round(p_amount, 2), now(), v_uid);

  PERFORM public.api_audit('price.default_set', 'product_variant', p_variant_id,
    jsonb_build_object('amount', round(p_amount, 2)));
  RETURN jsonb_build_object('variant_id', p_variant_id, 'amount', round(p_amount, 2));
END;
$function$;
REVOKE ALL ON FUNCTION public.api_set_default_price(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_set_default_price(uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_set_shop_price(
  p_shop_id uuid,
  p_variant_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can set shop prices' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Price must be greater than zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop_id AND status = 'approved') THEN
    RAISE EXCEPTION 'Shop must be approved before setting a price';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_variants WHERE id = p_variant_id) THEN
    RAISE EXCEPTION 'Product variant not found';
  END IF;

  UPDATE public.shop_price_overrides
  SET valid_to = now()
  WHERE shop_id = p_shop_id AND variant_id = p_variant_id AND valid_to IS NULL;

  INSERT INTO public.shop_price_overrides (shop_id, variant_id, amount, valid_from, set_by)
  VALUES (p_shop_id, p_variant_id, round(p_amount, 2), now(), v_uid);

  PERFORM public.api_audit('price.shop_set', 'shop', p_shop_id,
    jsonb_build_object('variant_id', p_variant_id, 'amount', round(p_amount, 2)));
  RETURN jsonb_build_object('shop_id', p_shop_id, 'variant_id', p_variant_id, 'amount', round(p_amount, 2));
END;
$function$;
REVOKE ALL ON FUNCTION public.api_set_shop_price(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_set_shop_price(uuid, uuid, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_clear_shop_price(p_shop_id uuid, p_variant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can change shop prices' USING ERRCODE = '42501';
  END IF;

  UPDATE public.shop_price_overrides
  SET valid_to = now()
  WHERE shop_id = p_shop_id AND variant_id = p_variant_id AND valid_to IS NULL;

  PERFORM public.api_audit('price.shop_cleared', 'shop', p_shop_id,
    jsonb_build_object('variant_id', p_variant_id));
  RETURN jsonb_build_object('shop_id', p_shop_id, 'variant_id', p_variant_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_clear_shop_price(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_clear_shop_price(uuid, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Sales
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
  v_stock integer;
  v_count integer := 0;
  v_distinct integer := 0;
  v_existing public.sales%ROWTYPE;
  v_credit_blocked boolean;
  v_payment_id uuid;
  v_invoice jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_client_reference IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.sales WHERE client_reference = p_client_reference;
    IF FOUND THEN
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
    tax_mode, tax_snapshot, client_reference
  ) VALUES (
    v_sale_id, p_shop_id, v_uid, v_status, p_payment_terms, v_business_date,
    CASE WHEN v_status = 'confirmed' THEN now() ELSE NULL END,
    CASE WHEN v_status = 'confirmed' THEN v_uid ELSE NULL END,
    'INR', 0, 0, 0, 'non_gst',
    jsonb_build_object('mode', 'non_gst', 'note', 'Tax treatment pending accountant review'),
    p_client_reference
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
  v_stock integer;
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

  FOR v_line IN SELECT * FROM public.sale_lines WHERE sale_id = p_sale_id LOOP
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

CREATE OR REPLACE FUNCTION public.api_sales_list(
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
      'id', s.id,
      'sale_number', s.sale_number,
      'business_date', s.business_date,
      'status', s.status,
      'payment_terms', s.payment_terms,
      'shop_id', s.shop_id,
      'shop_name', sh.name,
      'salesperson_id', s.salesperson_id,
      'salesperson_name', pr.full_name,
      'subtotal', s.subtotal,
      'grand_total', s.grand_total,
      'paid', COALESCE((
        SELECT SUM(pa.amount) FROM public.payment_allocations pa
        JOIN public.payments p ON p.id = pa.payment_id
        WHERE pa.sale_id = s.id AND p.status = 'verified'
      ), 0),
      'returned', COALESCE((
        SELECT SUM(e.amount) FROM public.shop_ledger_entries e
        WHERE e.sale_id = s.id AND e.entry_type = 'return_credit'
      ), 0),
      'balance', public.api_sale_balance(s.id),
      'invoice_number', (SELECT i.invoice_number FROM public.invoices i WHERE i.sale_id = s.id),
      'created_at', s.created_at
    ) ORDER BY s.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT s.* FROM public.sales s
      WHERE (p_from IS NULL OR s.business_date >= p_from)
        AND (p_to IS NULL OR s.business_date <= p_to)
        AND (public.api_is_admin()
          OR s.salesperson_id = (SELECT auth.uid())
          OR public.api_is_assigned(s.shop_id))
      ORDER BY s.created_at DESC
      LIMIT GREATEST(COALESCE(p_limit, 300), 1)
    ) s
    JOIN public.shops sh ON sh.id = s.shop_id
    JOIN public.profiles pr ON pr.id = s.salesperson_id
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_sales_list(date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_sales_list(date, date, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_sale_detail(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale public.sales%ROWTYPE;
  v_shop public.shops%ROWTYPE;
  v_person public.profiles%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_role text := public.api_role();
BEGIN
  IF (SELECT auth.uid()) IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found';
  END IF;
  IF NOT (public.api_is_admin()
      OR v_sale.salesperson_id = (SELECT auth.uid())
      OR public.api_is_assigned(v_sale.shop_id)) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_shop FROM public.shops WHERE id = v_sale.shop_id;
  SELECT * INTO v_person FROM public.profiles WHERE id = v_sale.salesperson_id;
  SELECT * INTO v_invoice FROM public.invoices WHERE sale_id = p_sale_id;

  RETURN jsonb_build_object(
    'id', v_sale.id,
    'sale_number', v_sale.sale_number,
    'status', v_sale.status,
    'payment_terms', v_sale.payment_terms,
    'business_date', v_sale.business_date,
    'subtotal', v_sale.subtotal,
    'grand_total', v_sale.grand_total,
    'paid', COALESCE((
      SELECT SUM(pa.amount) FROM public.payment_allocations pa
      JOIN public.payments p ON p.id = pa.payment_id
      WHERE pa.sale_id = v_sale.id AND p.status = 'verified'
    ), 0),
    'balance', public.api_sale_balance(v_sale.id),
    'shop', jsonb_build_object(
      'id', v_shop.id, 'name', v_shop.name, 'phone', v_shop.phone,
      'address_line1', v_shop.address_line1, 'address_line2', v_shop.address_line2,
      'city', v_shop.city, 'state', v_shop.state, 'postal_code', v_shop.postal_code
    ),
    'salesperson', jsonb_build_object('id', v_person.id, 'name', v_person.full_name),
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'variant_id', l.variant_id,
        'product_name', l.product_name_snapshot, 'sku', l.sku_snapshot,
        'pack_size_ml', l.pack_size_ml_snapshot,
        'bottles_per_carton', l.bottles_per_carton_snapshot,
        'cartons', l.cartons, 'unit_price', l.unit_price_snapshot,
        'line_total', l.line_total_snapshot
      ) ORDER BY l.product_name_snapshot)
      FROM public.sale_lines l WHERE l.sale_id = v_sale.id
    ), '[]'::jsonb),
    'invoice', CASE WHEN v_invoice.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_invoice.id,
      'invoice_number', v_invoice.invoice_number,
      'issued_at', v_invoice.issued_at,
      'seller', v_invoice.seller_snapshot,
      'buyer', v_invoice.buyer_snapshot,
      'tax_mode', v_invoice.tax_mode,
      'subtotal', v_invoice.subtotal_snapshot,
      'grand_total', v_invoice.grand_total_snapshot,
      'lines', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'product_name', il.product_name_snapshot,
          'sku', il.sku_snapshot,
          'cartons', il.cartons,
          'unit_price', il.unit_price_snapshot,
          'bottles_per_carton', il.bottles_per_carton_snapshot,
          'line_total', il.total_snapshot
        ) ORDER BY il.product_name_snapshot)
        FROM public.invoice_lines il WHERE il.invoice_id = v_invoice.id
      ), '[]'::jsonb)
    ) END,
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'method', p.method, 'amount', p.amount,
        'status', p.status, 'received_at', p.received_at,
        'verified_at', p.verified_at,
        'allocated', COALESCE((
          SELECT SUM(pa.amount) FROM public.payment_allocations pa
          WHERE pa.payment_id = p.id AND pa.sale_id = v_sale.id
        ), 0)
      ) ORDER BY p.created_at DESC)
      FROM public.payments p
      WHERE EXISTS (
        SELECT 1 FROM public.payment_allocations pa
        WHERE pa.payment_id = p.id AND pa.sale_id = v_sale.id
      )
    ), '[]'::jsonb),
    'returns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'status', r.status, 'reason', r.reason,
        'submitted_at', r.submitted_at, 'reviewed_at', r.reviewed_at,
        'review_reason', r.review_reason,
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'product_name', sl.product_name_snapshot,
            'cartons', rl.cartons,
            'approved_cartons', rl.approved_cartons,
            'condition', rl.condition
          ))
          FROM public.return_lines rl
          JOIN public.sale_lines sl ON sl.id = rl.sale_line_id
          WHERE rl.return_request_id = r.id
        ), '[]'::jsonb)
      ) ORDER BY r.submitted_at DESC)
      FROM public.return_requests r WHERE r.sale_id = v_sale.id
    ), '[]'::jsonb)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_sale_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_sale_detail(uuid) TO authenticated;
