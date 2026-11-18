-- ============================================================================
-- Ethereal Co. — dashboard, team, audit and seed data
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Seed the two carton products once. Prices remain owner-set.
-- ----------------------------------------------------------------------------
INSERT INTO public.products (name)
VALUES ('500 ml Water'), ('1 Litre Water')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.product_variants (product_id, sku, pack_size_ml, bottles_per_carton)
SELECT p.id, 'ETC-500ML-24', 500, 24
FROM public.products p WHERE p.name = '500 ml Water'
ON CONFLICT (sku) DO NOTHING;

INSERT INTO public.product_variants (product_id, sku, pack_size_ml, bottles_per_carton)
SELECT p.id, 'ETC-1L-12', 1000, 12
FROM public.products p WHERE p.name = '1 Litre Water'
ON CONFLICT (sku) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Team management
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_team_list()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN public.api_role() NOT IN ('owner', 'admin') THEN '[]'::jsonb
    ELSE (
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
    )
  END
$function$;
REVOKE ALL ON FUNCTION public.api_team_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_team_list() TO authenticated;

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
  v_owner_count integer;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the owner or an admin can manage employees' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('pending', 'approved', 'disabled') THEN
    RAISE EXCEPTION 'Invalid employee status';
  END IF;

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
  IF p_profile_id = v_uid AND p_status = 'disabled' THEN
    RAISE EXCEPTION 'You cannot disable your own account';
  END IF;

  IF p_status = 'disabled' AND v_target.role::text = 'owner' THEN
    SELECT COUNT(*) INTO v_owner_count FROM public.profiles WHERE role::text = 'owner' AND status = 'approved';
    IF v_owner_count <= 1 THEN
      RAISE EXCEPTION 'The last active owner cannot be disabled';
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
  v_owner_count integer;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL OR v_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the owner can change roles' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('owner', 'admin', 'salesperson') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT * INTO v_target FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF v_target.role::text = 'owner' AND p_role <> 'owner' THEN
    SELECT COUNT(*) INTO v_owner_count FROM public.profiles WHERE role::text = 'owner' AND status = 'approved';
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
-- Dashboard
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
  v_outstanding numeric := 0;
  v_month_sales numeric := 0;
  v_month_collected numeric := 0;
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
    bottles_per_carton integer, stock_saleable integer, stock_damaged integer,
    default_price numeric
  );

  v_recent := public.api_sales_list(NULL, NULL, 6);

  RETURN jsonb_build_object(
    'business_date', v_today,
    'today_sales', v_today_sales,
    'today_transactions', v_today_count,
    'collected_today', v_collected,
    'outstanding', v_outstanding,
    'month_sales', v_month_sales,
    'month_collected', v_month_collected,
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
-- Product-wise sales report (used by the Reports page)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_product_report(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE WHEN public.api_role() IS NULL THEN '[]'::jsonb ELSE (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'product_name', x.product_name,
      'sku', x.sku,
      'bottles_per_carton', x.bottles_per_carton,
      'cartons', x.cartons,
      'revenue', x.revenue
    ) ORDER BY x.revenue DESC), '[]'::jsonb)
    FROM (
      SELECT l.product_name_snapshot AS product_name,
             l.sku_snapshot AS sku,
             l.bottles_per_carton_snapshot AS bottles_per_carton,
             SUM(l.cartons)::int AS cartons,
             SUM(l.line_total_snapshot) AS revenue
      FROM public.sale_lines l
      JOIN public.sales s ON s.id = l.sale_id
      WHERE s.status = 'confirmed'
        AND (p_from IS NULL OR s.business_date >= p_from)
        AND (p_to IS NULL OR s.business_date <= p_to)
        AND (public.api_is_admin()
          OR s.salesperson_id = (SELECT auth.uid())
          OR public.api_is_assigned(s.shop_id))
      GROUP BY l.product_name_snapshot, l.sku_snapshot, l.bottles_per_carton_snapshot
    ) x
  ) END
$function$;
REVOKE ALL ON FUNCTION public.api_product_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_product_report(date, date) TO authenticated;

-- ----------------------------------------------------------------------------
-- Audit trail (owner/admin only)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.api_audit_log(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN public.api_role() NOT IN ('owner', 'admin') THEN '[]'::jsonb
    ELSE (
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
    )
  END
$function$;
REVOKE ALL ON FUNCTION public.api_audit_log(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_audit_log(integer) TO authenticated;

-- ----------------------------------------------------------------------------
-- Final guard: no browser role may execute internal helpers.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.api_stock_qty(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_sale_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_open_sales(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_audit(text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_next_invoice_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_next_receipt_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_issue_invoice(uuid, uuid) FROM PUBLIC, anon, authenticated;
