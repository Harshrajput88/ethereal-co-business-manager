-- Cursor-paged operational histories. Kept pending review; not part of release migrations.
-- Each page fetches limit + 1 rows and uses a stable descending composite key.
CREATE OR REPLACE FUNCTION public.api_sales_page(p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 300)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
WITH page AS (
 SELECT s.* FROM public.sales s
 WHERE (p_from IS NULL OR s.business_date >= p_from) AND (p_to IS NULL OR s.business_date <= p_to)
 AND (public.api_is_admin() OR s.salesperson_id=(SELECT auth.uid()) OR public.api_is_assigned(s.shop_id))
 AND (p_cursor IS NULL OR (s.created_at,s.id) < ((p_cursor->>'created_at')::timestamptz,(p_cursor->>'id')::uuid))
 ORDER BY s.created_at DESC,s.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000)+1
), kept AS (SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000))
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
'id',s.id,'sale_number',s.sale_number,'business_date',s.business_date,'status',s.status,'payment_terms',s.payment_terms,
'shop_id',s.shop_id,'shop_name',sh.name,'salesperson_id',s.salesperson_id,'salesperson_name',pr.full_name,
'subtotal',s.subtotal,'grand_total',s.grand_total,
'paid',COALESCE((SELECT SUM(pa.amount) FROM public.payment_allocations pa JOIN public.payments p ON p.id=pa.payment_id WHERE pa.sale_id=s.id AND p.status='verified'),0),
'returned',COALESCE((SELECT SUM(e.amount) FROM public.shop_ledger_entries e WHERE e.sale_id=s.id AND e.entry_type='return_credit'),0),
'balance',public.api_sale_balance(s.id),'invoice_number',(SELECT i.invoice_number FROM public.invoices i WHERE i.sale_id=s.id),'created_at',s.created_at
) ORDER BY s.created_at DESC,s.id DESC) FROM kept s JOIN public.shops sh ON sh.id=s.shop_id JOIN public.profiles pr ON pr.id=s.salesperson_id),'[]'::jsonb),
'has_more',(SELECT count(*)>LEAST(GREATEST(COALESCE(p_limit,300),1),1000) FROM page),
'next_cursor',(SELECT jsonb_build_object('created_at',s.created_at,'id',s.id) FROM kept s ORDER BY s.created_at ASC,s.id ASC LIMIT 1))
END;
$function$;
REVOKE ALL ON FUNCTION public.api_sales_page(date,date,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_sales_page(date,date,jsonb,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_payments_page(p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 300)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
WITH page AS (
 SELECT p.* FROM public.payments p
 WHERE ((p_from IS NULL AND p_to IS NULL) OR (p.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN COALESCE(p_from,'1900-01-01'::date) AND COALESCE(p_to,'2999-12-31'::date))
 AND (public.api_is_admin() OR p.recorded_by=(SELECT auth.uid()) OR public.api_is_assigned(p.shop_id))
 AND (p_cursor IS NULL OR (p.created_at,p.id) < ((p_cursor->>'created_at')::timestamptz,(p_cursor->>'id')::uuid))
 ORDER BY p.created_at DESC,p.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000)+1
), kept AS (SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000))
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
'id',p.id,'shop_id',p.shop_id,'shop_name',sh.name,'recorded_by',p.recorded_by,'recorded_by_name',pr.full_name,
'method',p.method,'amount',p.amount,'received_at',p.received_at,'external_reference',p.external_reference,'status',p.status,
'verified_at',p.verified_at,'rejection_reason',p.rejection_reason,
'receipt_number',(SELECT r.receipt_number FROM public.payment_receipts r WHERE r.payment_id=p.id),
'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object('sale_id',pa.sale_id,'sale_number',s.sale_number,'amount',pa.amount) ORDER BY s.sale_number)
FROM public.payment_allocations pa JOIN public.sales s ON s.id=pa.sale_id WHERE pa.payment_id=p.id),'[]'::jsonb)
) ORDER BY p.created_at DESC,p.id DESC) FROM kept p JOIN public.shops sh ON sh.id=p.shop_id JOIN public.profiles pr ON pr.id=p.recorded_by),'[]'::jsonb),
'has_more',(SELECT count(*)>LEAST(GREATEST(COALESCE(p_limit,300),1),1000) FROM page),
'next_cursor',(SELECT jsonb_build_object('created_at',p.created_at,'id',p.id) FROM kept p ORDER BY p.created_at ASC,p.id ASC LIMIT 1))
END;
$function$;
REVOKE ALL ON FUNCTION public.api_payments_page(date,date,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_payments_page(date,date,jsonb,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_returns_page(p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
WITH page AS (
 SELECT r.* FROM public.return_requests r
 WHERE (public.api_is_admin() OR r.submitted_by=(SELECT auth.uid()) OR public.api_is_assigned(r.shop_id))
 AND (p_cursor IS NULL OR (r.submitted_at,r.id) < ((p_cursor->>'submitted_at')::timestamptz,(p_cursor->>'id')::uuid))
 ORDER BY r.submitted_at DESC,r.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000)+1
), kept AS (SELECT * FROM page ORDER BY submitted_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,200),1),1000))
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
'id',r.id,'sale_id',r.sale_id,'sale_number',s.sale_number,'shop_id',r.shop_id,'shop_name',sh.name,
'submitted_by',r.submitted_by,'submitted_by_name',pr.full_name,'status',r.status,'reason',r.reason,
'submitted_at',r.submitted_at,'reviewed_at',r.reviewed_at,'review_reason',r.review_reason,
'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('product_name',sl.product_name_snapshot,'cartons',rl.cartons,
'approved_cartons',rl.approved_cartons,'condition',rl.condition,'unit_price',sl.unit_price_snapshot))
FROM public.return_lines rl JOIN public.sale_lines sl ON sl.id=rl.sale_line_id WHERE rl.return_request_id=r.id),'[]'::jsonb)
) ORDER BY r.submitted_at DESC,r.id DESC) FROM kept r JOIN public.sales s ON s.id=r.sale_id JOIN public.shops sh ON sh.id=r.shop_id JOIN public.profiles pr ON pr.id=r.submitted_by),'[]'::jsonb),
'has_more',(SELECT count(*)>LEAST(GREATEST(COALESCE(p_limit,200),1),1000) FROM page),
'next_cursor',(SELECT jsonb_build_object('submitted_at',r.submitted_at,'id',r.id) FROM kept r ORDER BY r.submitted_at ASC,r.id ASC LIMIT 1))
END;
$function$;
REVOKE ALL ON FUNCTION public.api_returns_page(jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_returns_page(jsonb,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_expenses_page(p_from date DEFAULT NULL,p_to date DEFAULT NULL,p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 300)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
WITH page AS (
 SELECT e.* FROM public.expense_claims e
 WHERE (p_from IS NULL OR e.expense_date>=p_from) AND (p_to IS NULL OR e.expense_date<=p_to)
 AND (public.api_is_admin() OR e.submitted_by=(SELECT auth.uid()))
 AND (p_cursor IS NULL OR (e.expense_date,e.created_at,e.id) <
 ((p_cursor->>'expense_date')::date,(p_cursor->>'created_at')::timestamptz,(p_cursor->>'id')::uuid))
 ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000)+1
), kept AS (SELECT * FROM page ORDER BY expense_date DESC,created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,300),1),1000))
SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(jsonb_build_object(
'id',e.id,'submitted_by',e.submitted_by,'submitted_by_name',pr.full_name,'expense_date',e.expense_date,
'category',e.category,'description',e.description,'amount',e.amount,'status',e.status,'review_reason',e.review_reason,
'reviewed_at',e.reviewed_at,'paid_at',e.paid_at,'created_at',e.created_at
) ORDER BY e.expense_date DESC,e.created_at DESC,e.id DESC) FROM kept e JOIN public.profiles pr ON pr.id=e.submitted_by),'[]'::jsonb),
'has_more',(SELECT count(*)>LEAST(GREATEST(COALESCE(p_limit,300),1),1000) FROM page),
'next_cursor',(SELECT jsonb_build_object('expense_date',e.expense_date,'created_at',e.created_at,'id',e.id) FROM kept e ORDER BY e.expense_date ASC,e.created_at ASC,e.id ASC LIMIT 1))
END;
$function$;
REVOKE ALL ON FUNCTION public.api_expenses_page(date,date,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_expenses_page(date,date,jsonb,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.api_inventory_movements_page(p_cursor jsonb DEFAULT NULL,p_limit integer DEFAULT 150)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_stock jsonb; v_items jsonb; v_more boolean; v_next jsonb;
BEGIN
 IF public.api_role() IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('variant_id',c.variant_id,'product_name',c.product_name,'sku',c.sku,
 'pack_size_ml',c.pack_size_ml,'bottles_per_carton',c.bottles_per_carton,'saleable',c.stock_saleable,
 'damaged',c.stock_damaged,'default_price',c.default_price) ORDER BY c.pack_size_ml),'[]'::jsonb)
 INTO v_stock FROM jsonb_to_recordset(public.api_catalog()) AS c(variant_id uuid,product_name text,sku text,
 pack_size_ml integer,bottles_per_carton integer,stock_saleable integer,stock_damaged integer,default_price numeric);
 WITH page AS (SELECT m.* FROM public.inventory_movements m
 WHERE (p_cursor IS NULL OR (m.occurred_at,m.id) < ((p_cursor->>'occurred_at')::timestamptz,(p_cursor->>'id')::uuid))
 ORDER BY m.occurred_at DESC,m.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,150),1),1000)+1),
 kept AS (SELECT * FROM page ORDER BY occurred_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,150),1),1000))
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'variant_id',m.variant_id,'product_name',p.name,
 'bottles_per_carton',pv.bottles_per_carton,'stock_bucket',m.stock_bucket,'movement_type',m.movement_type,
 'cartons_delta',m.cartons_delta,'source_type',m.source_type,'source_id',m.source_id,'reason',m.reason,
 'actor_name',pr.full_name,'occurred_at',m.occurred_at) ORDER BY m.occurred_at DESC,m.id DESC),'[]'::jsonb),
 (SELECT count(*)>LEAST(GREATEST(COALESCE(p_limit,150),1),1000) FROM page),
 (SELECT jsonb_build_object('occurred_at',m.occurred_at,'id',m.id) FROM kept m ORDER BY m.occurred_at ASC,m.id ASC LIMIT 1)
 INTO v_items,v_more,v_next FROM kept m JOIN public.product_variants pv ON pv.id=m.variant_id
 JOIN public.products p ON p.id=pv.product_id JOIN public.profiles pr ON pr.id=m.actor_id;
 RETURN jsonb_build_object('stock',v_stock,'movements',v_items,'has_more',COALESCE(v_more,false),'next_cursor',v_next);
END;
$function$;
REVOKE ALL ON FUNCTION public.api_inventory_movements_page(jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.api_inventory_movements_page(jsonb,integer) TO authenticated;
