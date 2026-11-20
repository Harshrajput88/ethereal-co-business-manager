-- Server-side financial reporting. Keeps raw transaction lists out of the browser.
-- This is an additive migration; the frozen nine-migration release set is unchanged.
CREATE OR REPLACE FUNCTION public.api_financial_report(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_role text := public.api_role();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  WITH
  visible_sales AS (
    SELECT s.id, s.shop_id, s.salesperson_id, s.business_date, s.grand_total,
           public.api_sale_balance(s.id) AS balance,
           COALESCE((SELECT SUM(e.amount) FROM public.shop_ledger_entries e
             WHERE e.sale_id = s.id AND e.entry_type = 'return_credit'), 0) AS returned
    FROM public.sales s
    WHERE s.status = 'confirmed'
      AND (p_from IS NULL OR s.business_date >= p_from)
      AND (p_to IS NULL OR s.business_date <= p_to)
      AND (v_role IN ('owner','admin') OR s.salesperson_id = v_uid OR public.api_is_assigned(s.shop_id))
  ),
  visible_payments AS (
    SELECT p.id, p.shop_id, p.method, p.amount, p.received_at
    FROM public.payments p
    WHERE p.status = 'verified'
      AND (p_from IS NULL OR (p.received_at AT TIME ZONE 'Asia/Kolkata')::date >= p_from)
      AND (p_to IS NULL OR (p.received_at AT TIME ZONE 'Asia/Kolkata')::date <= p_to)
      AND (v_role IN ('owner','admin') OR p.recorded_by = v_uid OR public.api_is_assigned(p.shop_id))
  ),
  visible_expenses AS (
    SELECT e.id, e.category, e.amount, e.expense_date
    FROM public.expense_claims e
    WHERE e.status IN ('approved','paid')
      AND (p_from IS NULL OR e.expense_date >= p_from)
      AND (p_to IS NULL OR e.expense_date <= p_to)
      AND (v_role IN ('owner','admin') OR e.submitted_by = v_uid)
  ),
  shop_rows AS (
    SELECT sh.name,
      COALESCE(ss.revenue,0) AS revenue, COALESCE(ss.returns,0) AS returns,
      COALESCE(ss.outstanding,0) AS outstanding,
      COALESCE(pp.collections,0) AS collections,
      COALESCE(ss.transactions,0) AS transactions
    FROM public.shops sh
    LEFT JOIN (
      SELECT shop_id, SUM(grand_total) revenue, SUM(returned) returns,
             SUM(balance) outstanding, COUNT(*) transactions
      FROM visible_sales GROUP BY shop_id
    ) ss ON ss.shop_id = sh.id
    LEFT JOIN (
      SELECT shop_id, SUM(amount) collections FROM visible_payments GROUP BY shop_id
    ) pp ON pp.shop_id = sh.id
    WHERE ss.shop_id IS NOT NULL OR pp.shop_id IS NOT NULL
  ),
  people_rows AS (
    SELECT pr.full_name AS name, SUM(vs.grand_total) revenue,
           COUNT(*)::integer transactions, SUM(vs.balance) outstanding
    FROM visible_sales vs JOIN public.profiles pr ON pr.id = vs.salesperson_id
    GROUP BY pr.full_name
  ),
  daily_rows AS (
    SELECT d.date,
      SUM(d.revenue)::numeric AS revenue, SUM(d.collections)::numeric AS collections
    FROM (
      SELECT business_date AS date, grand_total AS revenue, 0::numeric AS collections FROM visible_sales
      UNION ALL
      SELECT (received_at AT TIME ZONE 'Asia/Kolkata')::date, 0::numeric, amount FROM visible_payments
    ) d GROUP BY d.date
  ),
  method_rows AS (
    SELECT method, SUM(amount) amount FROM visible_payments GROUP BY method
  ),
  category_rows AS (
    SELECT category, SUM(amount) amount FROM visible_expenses GROUP BY category
  ),
  totals AS (
    SELECT COALESCE(SUM(grand_total),0) revenue,
           COALESCE(SUM(returned),0) returns,
           COALESCE(SUM(balance),0) outstanding,
           COUNT(*)::integer transactions
    FROM visible_sales
  ),
  payment_totals AS (SELECT COALESCE(SUM(amount),0) collections FROM visible_payments),
  expense_totals AS (SELECT COALESCE(SUM(amount),0) expenses FROM visible_expenses)
  SELECT jsonb_build_object(
    'revenue', t.revenue,
    'returns', t.returns,
    'netRevenue', t.revenue - t.returns,
    'collections', pt.collections,
    'outstanding', t.outstanding,
    'expenses', et.expenses,
    'net', t.revenue - t.returns - et.expenses,
    'transactions', t.transactions,
    'byShop', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name', name, 'revenue', revenue, 'returns', returns,
      'outstanding', outstanding, 'collections', collections, 'transactions', transactions
    ) ORDER BY revenue DESC) FROM shop_rows), '[]'::jsonb),
    'bySalesperson', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'name', name, 'revenue', revenue, 'transactions', transactions, 'outstanding', outstanding
    ) ORDER BY revenue DESC) FROM people_rows), '[]'::jsonb),
    'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'date', date, 'revenue', revenue, 'collections', collections
    ) ORDER BY date) FROM daily_rows), '[]'::jsonb),
    'methods', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'method', method, 'amount', amount
    ) ORDER BY amount DESC) FROM method_rows), '[]'::jsonb),
    'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'category', category, 'amount', amount
    ) ORDER BY amount DESC) FROM category_rows), '[]'::jsonb),
    'products', public.api_product_report(p_from, p_to)
  ) INTO v_result
  FROM totals t CROSS JOIN payment_totals pt CROSS JOIN expense_totals et;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.api_financial_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.api_financial_report(date, date) TO authenticated;
