-- ============================================================================
-- Ethereal Co. — core helpers, shops, catalog and pricing RPCs
-- All writes are transactional. Browser sends intent only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Internal helpers (not granted to browser roles)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_stock_qty(
  p_variant_id uuid,
  p_bucket text DEFAULT 'saleable'
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(SUM(m.cartons_delta), 0)::integer
  FROM public.inventory_movements AS m
  WHERE m.variant_id = p_variant_id
    AND m.stock_bucket = p_bucket
$function$;
REVOKE ALL ON FUNCTION public.api_stock_qty(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_sale_balance(p_sale_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT GREATEST(
    s.grand_total
    - COALESCE((
        SELECT SUM(pa.amount)
        FROM public.payment_allocations AS pa
        JOIN public.payments AS p ON p.id = pa.payment_id
        WHERE pa.sale_id = s.id AND p.status = 'verified'
      ), 0)
    - COALESCE((
        SELECT SUM(e.amount)
        FROM public.shop_ledger_entries AS e
        WHERE e.sale_id = s.id AND e.entry_type = 'return_credit'
      ), 0),
    0
  )
  FROM public.sales AS s
  WHERE s.id = p_sale_id
$function$;
REVOKE ALL ON FUNCTION public.api_sale_balance(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_open_sales(p_shop_id uuid)
RETURNS TABLE (
  sale_id uuid,
  sale_number bigint,
  business_date date,
  grand_total numeric,
  balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT s.id, s.sale_number, s.business_date, s.grand_total,
         public.api_sale_balance(s.id) AS balance
  FROM public.sales AS s
  WHERE s.shop_id = p_shop_id
    AND s.status = 'confirmed'
    AND public.api_sale_balance(s.id) > 0
  ORDER BY s.business_date ASC, s.sale_number ASC
$function$;
REVOKE ALL ON FUNCTION public.api_open_sales(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  INSERT INTO public.audit_events (actor_id, action, entity_type, entity_id, safe_metadata)
  VALUES ((SELECT auth.uid()), p_action, p_entity_type, p_entity_id,
          COALESCE(p_metadata, '{}'::jsonb))
$function$;
REVOKE ALL ON FUNCTION public.api_audit(text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_next_invoice_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT 'ETC-INV-'
    || to_char((now() AT TIME ZONE 'Asia/Kolkata'), 'YYYYMM')
    || '-'
    || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
$function$;
REVOKE ALL ON FUNCTION public.api_next_invoice_number() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.api_next_receipt_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT 'ETC-RCPT-'
    || to_char((now() AT TIME ZONE 'Asia/Kolkata'), 'YYYYMM')
    || '-'
    || lpad(nextval('public.receipt_number_seq')::text, 6, '0')
$function$;
REVOKE ALL ON FUNCTION public.api_next_receipt_number() FROM PUBLIC, anon, authenticated;

-- Freeze seller/buyer/line snapshots for a confirmed sale. Idempotent per sale.
CREATE OR REPLACE FUNCTION public.api_issue_invoice(p_sale_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale public.sales%ROWTYPE;
  v_shop public.shops%ROWTYPE;
  v_settings public.business_settings%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_created boolean := false;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE sale_id = p_sale_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'invoice_id', v_invoice.id,
      'invoice_number', v_invoice.invoice_number
    );
  END IF;

  SELECT * INTO v_sale FROM public.sales WHERE id = p_sale_id;
  SELECT * INTO v_shop FROM public.shops WHERE id = v_sale.shop_id;
  SELECT * INTO v_settings FROM public.business_settings WHERE id;

  INSERT INTO public.invoices (
    sale_id, invoice_number, status, issued_by,
    seller_snapshot, buyer_snapshot, currency, tax_mode,
    subtotal_snapshot, tax_snapshot, grand_total_snapshot
  ) VALUES (
    p_sale_id,
    public.api_next_invoice_number(),
    'issued',
    p_actor,
    jsonb_build_object(
      'name', v_settings.business_name,
      'tagline', v_settings.tagline,
      'address', v_settings.address,
      'phone', v_settings.phone,
      'email', v_settings.email,
      'gstin', v_settings.gstin
    ),
    jsonb_build_object(
      'name', v_shop.name,
      'phone', v_shop.phone,
      'email', v_shop.email,
      'address_line1', v_shop.address_line1,
      'address_line2', v_shop.address_line2,
      'locality', v_shop.locality,
      'city', v_shop.city,
      'state', v_shop.state,
      'postal_code', v_shop.postal_code
    ),
    'INR',
    COALESCE(v_sale.tax_mode, 'non_gst'),
    v_sale.subtotal,
    COALESCE(v_sale.tax_snapshot, '{"mode":"non_gst"}'::jsonb),
    v_sale.grand_total
  )
  RETURNING * INTO v_invoice;
  v_created := true;

  IF v_created THEN
    INSERT INTO public.invoice_lines (
      invoice_id, product_name_snapshot, sku_snapshot,
      pack_size_ml_snapshot, bottles_per_carton_snapshot, cartons,
      unit_price_snapshot, subtotal_snapshot, total_snapshot
    )
    SELECT v_invoice.id, l.product_name_snapshot, l.sku_snapshot,
           l.pack_size_ml_snapshot, l.bottles_per_carton_snapshot, l.cartons,
           l.unit_price_snapshot, l.line_subtotal, l.line_total_snapshot
    FROM public.sale_lines AS l
    WHERE l.sale_id = p_sale_id;
  END IF;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice.id,
    'invoice_number', v_invoice.invoice_number
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.api_issue_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Bootstrap and self-service profile
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_needs_first_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM public.profiles WHERE role::text = 'owner')
$function$;
REVOKE ALL ON FUNCTION public.api_needs_first_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_needs_first_owner() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_claim_owner()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE role::text = 'owner') THEN
    RAISE EXCEPTION 'An owner account already exists' USING ERRCODE = '42501';
  END IF;

  UPDATE public.profiles
  SET role = 'owner', status = 'approved', approved_at = now(),
      approved_by = v_uid, disabled_at = NULL, updated_at = now()
  WHERE id = v_uid;

  INSERT INTO public.audit_events (actor_id, action, entity_type, entity_id, safe_metadata)
  VALUES (v_uid, 'owner.claimed', 'profile', v_uid, '{}'::jsonb);

  RETURN jsonb_build_object('id', v_uid, 'role', 'owner', 'status', 'approved');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_claim_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_claim_owner() TO authenticated;

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

  RETURN jsonb_build_object('id', v_uid, 'avatar_url', v_url);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_update_my_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_update_my_avatar(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Business settings and credit control
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_business_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN NULL ELSE (
    SELECT jsonb_build_object(
      'business_name', s.business_name,
      'tagline', s.tagline,
      'address', s.address,
      'phone', s.phone,
      'email', s.email,
      'gstin', s.gstin,
      'invoice_prefix', s.invoice_prefix,
      'updated_at', s.updated_at
    ) FROM public.business_settings AS s WHERE s.id
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_business_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_business_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_update_business_settings(
  p_business_name text,
  p_tagline text,
  p_address text,
  p_phone text,
  p_email text,
  p_gstin text
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
  IF v_uid IS NULL OR v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change business settings' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_business_name), '') IS NULL THEN
    RAISE EXCEPTION 'Business name is required';
  END IF;

  UPDATE public.business_settings
  SET business_name = btrim(p_business_name),
      tagline = COALESCE(p_tagline, ''),
      address = COALESCE(p_address, ''),
      phone = COALESCE(p_phone, ''),
      email = COALESCE(p_email, ''),
      gstin = COALESCE(p_gstin, ''),
      updated_by = v_uid,
      updated_at = now()
  WHERE id;

  PERFORM public.api_audit('settings.updated', 'business_settings', NULL, '{}'::jsonb);
  RETURN public.api_business_settings();
END;
$function$;
REVOKE ALL ON FUNCTION public.api_update_business_settings(text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_update_business_settings(text, text, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_credit_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN NULL ELSE (
    SELECT jsonb_build_object(
      'blocked', c.blocked,
      'reason', c.reason,
      'changed_at', c.changed_at
    ) FROM public.credit_controls AS c WHERE c.id
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_credit_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_credit_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_set_credit_block(p_blocked boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change credit control' USING ERRCODE = '42501';
  END IF;
  IF p_blocked AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to block credit sales';
  END IF;

  UPDATE public.credit_controls
  SET blocked = p_blocked, reason = NULLIF(btrim(p_reason), ''),
      changed_by = v_uid, changed_at = now()
  WHERE id;

  PERFORM public.api_audit(
    CASE WHEN p_blocked THEN 'credit.blocked' ELSE 'credit.unblocked' END,
    'credit_controls', NULL,
    jsonb_build_object('reason', p_reason)
  );
  RETURN public.api_credit_status();
END;
$function$;
REVOKE ALL ON FUNCTION public.api_set_credit_block(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_set_credit_block(boolean, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Shops
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_shops_list()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'phone', s.phone,
    'email', s.email,
    'address_line1', s.address_line1,
    'address_line2', s.address_line2,
    'locality', s.locality,
    'city', s.city,
    'state', s.state,
    'postal_code', s.postal_code,
    'latitude', s.latitude,
    'longitude', s.longitude,
    'status', s.status,
    'notes', s.notes,
    'rejection_reason', s.rejection_reason,
    'submitted_by', s.submitted_by,
    'submitted_by_name', (SELECT p.full_name FROM public.profiles p WHERE p.id = s.submitted_by),
    'reviewed_at', s.reviewed_at,
    'created_at', s.created_at,
    'salespeople', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.full_name, 'is_primary', ss.is_primary
      ) ORDER BY ss.is_primary DESC, p.full_name)
      FROM public.shop_salespeople ss
      JOIN public.profiles p ON p.id = ss.salesperson_id
      WHERE ss.shop_id = s.id
    ), '[]'::jsonb),
    'outstanding', COALESCE((
      SELECT SUM(public.api_sale_balance(x.id))
      FROM public.sales x
      WHERE x.shop_id = s.id AND x.status = 'confirmed'
    ), 0)
  ) ORDER BY
      CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      s.name), '[]'::jsonb)
  FROM public.shops AS s
  WHERE public.api_role() IS NOT NULL
    AND (public.api_is_admin() OR public.api_is_assigned(s.id) OR s.submitted_by = (SELECT auth.uid()))
$function$;
REVOKE ALL ON FUNCTION public.api_shops_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_shops_list() TO authenticated;

CREATE OR REPLACE FUNCTION public.api_submit_shop(
  p_name text,
  p_phone text,
  p_email text,
  p_address_line1 text,
  p_address_line2 text,
  p_locality text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_notes text,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_name), '') IS NULL THEN
    RAISE EXCEPTION 'Shop name is required';
  END IF;
  IF (p_latitude IS NULL) <> (p_longitude IS NULL) THEN
    RAISE EXCEPTION 'Latitude and longitude must be provided together';
  END IF;
  IF p_latitude IS NOT NULL AND (p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180) THEN
    RAISE EXCEPTION 'Invalid coordinates';
  END IF;

  INSERT INTO public.shops (
    name, phone, email, address_line1, address_line2, locality, city, state,
    postal_code, notes, latitude, longitude, status, submitted_by
  ) VALUES (
    btrim(p_name), NULLIF(btrim(p_phone), ''), NULLIF(btrim(p_email), ''),
    NULLIF(btrim(p_address_line1), ''), NULLIF(btrim(p_address_line2), ''),
    NULLIF(btrim(p_locality), ''), NULLIF(btrim(p_city), ''),
    NULLIF(btrim(p_state), ''), NULLIF(btrim(p_postal_code), ''),
    NULLIF(btrim(p_notes), ''), p_latitude, p_longitude, 'pending', v_uid
  )
  RETURNING id INTO v_id;

  PERFORM public.api_audit('shop.submitted', 'shop', v_id,
    jsonb_build_object('name', p_name));
  RETURN jsonb_build_object('id', v_id, 'status', 'pending');
END;
$function$;
REVOKE ALL ON FUNCTION public.api_submit_shop(text, text, text, text, text, text, text, text, text, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_submit_shop(text, text, text, text, text, text, text, text, text, text, numeric, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_review_shop(
  p_shop_id uuid,
  p_decision text,
  p_reason text,
  p_primary_salesperson_id uuid DEFAULT NULL,
  p_additional_salesperson_ids uuid[] DEFAULT ARRAY[]::uuid[]
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
  v_person uuid;
  v_first boolean := true;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can review shops' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'inactive') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;
  SELECT * INTO v_shop FROM public.shops WHERE id = p_shop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shop not found';
  END IF;
  IF p_decision = 'rejected' AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'A rejection reason is required';
  END IF;

  IF p_decision = 'approved' THEN
    IF p_primary_salesperson_id IS NULL THEN
      RAISE EXCEPTION 'Choose a primary salesperson before approving a shop';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = p_primary_salesperson_id AND status = 'approved'
        AND role::text IN ('salesperson', 'admin')
    ) THEN
      RAISE EXCEPTION 'The primary salesperson must be an approved employee';
    END IF;

    DELETE FROM public.shop_salespeople WHERE shop_id = p_shop_id;

    INSERT INTO public.shop_salespeople (shop_id, salesperson_id, is_primary, assigned_by)
    VALUES (p_shop_id, p_primary_salesperson_id, true, v_uid);

    FOREACH v_person IN ARRAY COALESCE(p_additional_salesperson_ids, ARRAY[]::uuid[])
    LOOP
      IF v_person <> p_primary_salesperson_id THEN
        INSERT INTO public.shop_salespeople (shop_id, salesperson_id, is_primary, assigned_by)
        VALUES (p_shop_id, v_person, false, v_uid)
        ON CONFLICT (shop_id, salesperson_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  UPDATE public.shops
  SET status = p_decision,
      reviewed_by = v_uid,
      reviewed_at = now(),
      rejection_reason = CASE WHEN p_decision = 'rejected' THEN btrim(p_reason) ELSE NULL END,
      updated_at = now()
  WHERE id = p_shop_id;

  PERFORM public.api_audit('shop.' || p_decision, 'shop', p_shop_id,
    jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('id', p_shop_id, 'status', p_decision);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_review_shop(uuid, text, text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_review_shop(uuid, text, text, uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_assign_shop_salespeople(
  p_shop_id uuid,
  p_primary_salesperson_id uuid,
  p_additional_salesperson_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_person uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can assign shops' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE id = p_shop_id AND status = 'approved') THEN
    RAISE EXCEPTION 'Approve the shop before assigning salespeople';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_primary_salesperson_id AND status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Primary salesperson must be an approved employee';
  END IF;

  DELETE FROM public.shop_salespeople WHERE shop_id = p_shop_id;
  INSERT INTO public.shop_salespeople (shop_id, salesperson_id, is_primary, assigned_by)
  VALUES (p_shop_id, p_primary_salesperson_id, true, v_uid);

  FOREACH v_person IN ARRAY COALESCE(p_additional_salesperson_ids, ARRAY[]::uuid[])
  LOOP
    IF v_person <> p_primary_salesperson_id THEN
      INSERT INTO public.shop_salespeople (shop_id, salesperson_id, is_primary, assigned_by)
      VALUES (p_shop_id, v_person, false, v_uid)
      ON CONFLICT (shop_id, salesperson_id) DO NOTHING;
    END IF;
  END LOOP;

  PERFORM public.api_audit('shop.assignments_updated', 'shop', p_shop_id, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_shop_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_assign_shop_salespeople(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_assign_shop_salespeople(uuid, uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_add_shop_visit(p_shop_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT public.api_is_admin() AND NOT public.api_is_assigned(p_shop_id) THEN
    RAISE EXCEPTION 'You are not assigned to this shop' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.shop_visits (shop_id, visited_by, visit_note)
  VALUES (p_shop_id, v_uid, NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_add_shop_visit(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_add_shop_visit(uuid, text) TO authenticated;
