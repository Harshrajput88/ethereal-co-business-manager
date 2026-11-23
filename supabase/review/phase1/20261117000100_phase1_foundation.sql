-- DRAFT ONLY — Phase 1 foundation for a clean, single-business Ethereal Co. DB.
-- NEVER apply until the current public schema, Auth hooks, grants, Storage and
-- migration history have been reviewed and this draft has been owner-approved.
-- This file has not been run or validated against any database.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'salesperson');
CREATE TYPE public.employee_status AS ENUM ('pending', 'approved', 'disabled');
CREATE TYPE public.shop_status AS ENUM ('pending', 'approved', 'rejected', 'inactive');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 160),
  email text NOT NULL,
  role public.app_role NOT NULL DEFAULT 'salesperson',
  status public.employee_status NOT NULL DEFAULT 'pending',
  avatar_url text,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL) OR status = 'disabled'),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
CREATE INDEX profiles_role_status_idx ON public.profiles(role, status);

-- Signup creates pending salesperson only; never reads role from user metadata.
-- SECURITY DEFINER is restricted to this trigger use, has a fixed search_path,
-- and EXECUTE is not granted to API roles. Reconcile with any existing hook first.
CREATE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, role, status)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), 'New employee'),
    COALESCE(NEW.email, ''),
    'salesperson',
    'pending'
  );
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Non-recursive server-side lookup for RLS. Fixed path; returns only boolean/role.
CREATE FUNCTION public.current_employee_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.role
  FROM public.profiles AS p
  WHERE p.id = (SELECT auth.uid())
    AND p.status = 'approved'
$function$;
REVOKE ALL ON FUNCTION public.current_employee_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_employee_role() TO authenticated;

CREATE TABLE public.shops (
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
  status public.shop_status NOT NULL DEFAULT 'pending',
  notes text,
  submitted_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CHECK ((status IN ('approved', 'rejected', 'inactive')) = (reviewed_at IS NOT NULL)),
  CHECK ((status IN ('approved', 'rejected', 'inactive')) = (reviewed_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR NULLIF(btrim(rejection_reason), '') IS NOT NULL)
);
CREATE INDEX shops_status_created_idx ON public.shops(status, created_at DESC);
CREATE INDEX shops_submitted_by_created_idx ON public.shops(submitted_by, created_at DESC);

CREATE TABLE public.shop_salespeople (
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  salesperson_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  assigned_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, salesperson_id)
);
CREATE UNIQUE INDEX shop_one_primary_salesperson_idx
  ON public.shop_salespeople(shop_id) WHERE is_primary;
CREATE INDEX shop_salespeople_person_idx
  ON public.shop_salespeople(salesperson_id, shop_id);

CREATE FUNCTION public.is_shop_assigned(p_shop_id uuid)
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
REVOKE ALL ON FUNCTION public.is_shop_assigned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_shop_assigned(uuid) TO authenticated;

CREATE TABLE public.shop_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  visited_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  visited_at timestamptz NOT NULL DEFAULT now(),
  visit_note text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);
CREATE INDEX shop_visits_shop_time_idx ON public.shop_visits(shop_id, visited_at DESC);
CREATE INDEX shop_visits_actor_time_idx ON public.shop_visits(visited_by, visited_at DESC);

CREATE TABLE public.shop_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  storage_path text NOT NULL UNIQUE CHECK (length(storage_path) > 0),
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shop_photos_shop_idx ON public.shop_photos(shop_id, created_at DESC);

CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.product_variants (
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
CREATE INDEX product_variants_product_active_idx ON public.product_variants(product_id, active);

CREATE TABLE public.default_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  set_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    variant_id WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
);
CREATE INDEX default_prices_variant_from_idx ON public.default_prices(variant_id, valid_from DESC);

CREATE TABLE public.shop_price_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  set_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    shop_id WITH =,
    variant_id WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
);
CREATE INDEX shop_price_override_lookup_idx
  ON public.shop_price_overrides(shop_id, variant_id, valid_from DESC);

CREATE TABLE public.credit_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT blocked OR NULLIF(btrim(reason), '') IS NOT NULL)
);
INSERT INTO public.credit_controls(id) VALUES (true);

CREATE TABLE public.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_metadata) = 'object')
);
CREATE INDEX audit_events_entity_time_idx
  ON public.audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx
  ON public.audit_events(actor_id, occurred_at DESC);

CREATE FUNCTION public.reject_immutable_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION public.reject_immutable_change() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON public.audit_events
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();
CREATE TRIGGER shop_visits_append_only
BEFORE UPDATE OR DELETE ON public.shop_visits
FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_change();

-- Default-deny grants: subsequent functions/policies must explicitly grant access.
REVOKE ALL ON public.profiles, public.shops, public.shop_salespeople,
  public.shop_visits, public.shop_photos, public.products, public.product_variants,
  public.default_prices, public.shop_price_overrides, public.credit_controls,
  public.audit_events
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.audit_events_id_seq FROM PUBLIC, anon, authenticated;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shops FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_salespeople ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_salespeople FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_photos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.default_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.default_prices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.shop_price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_price_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE public.credit_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;

GRANT SELECT ON public.profiles, public.shops, public.shop_salespeople,
  public.shop_visits, public.shop_photos, public.products, public.product_variants,
  public.default_prices, public.shop_price_overrides, public.credit_controls
TO authenticated;
GRANT INSERT (id, name, phone, email, address_line1, address_line2, locality,
  city, state, postal_code, latitude, longitude, notes, submitted_by)
ON public.shops TO authenticated;
GRANT INSERT (shop_id, visited_by, visit_note, latitude, longitude)
ON public.shop_visits TO authenticated;
GRANT INSERT (shop_id, storage_path, uploaded_by, caption)
ON public.shop_photos TO authenticated;

CREATE POLICY profiles_read_self_or_admin ON public.profiles
FOR SELECT TO authenticated
USING (id = (SELECT auth.uid()) OR public.current_employee_role() IN ('owner', 'admin'));
CREATE POLICY shops_read_scope ON public.shops
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR (
    public.current_employee_role() IS NOT NULL
    AND (public.is_shop_assigned(id) OR submitted_by = (SELECT auth.uid()))
  )
);
CREATE POLICY shops_submit_pending ON public.shops
FOR INSERT TO authenticated
WITH CHECK (
  submitted_by = (SELECT auth.uid())
  AND status = 'pending'
  AND reviewed_by IS NULL
  AND reviewed_at IS NULL
  AND rejection_reason IS NULL
  AND public.current_employee_role() IN ('owner', 'admin', 'salesperson')
);
CREATE POLICY shop_assignments_read_scope ON public.shop_salespeople
FOR SELECT TO authenticated
USING (
  (
    public.current_employee_role() IS NOT NULL
    AND salesperson_id = (SELECT auth.uid())
  )
  OR public.current_employee_role() IN ('owner', 'admin')
);
CREATE POLICY shop_visits_read_scope ON public.shop_visits
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR public.is_shop_assigned(shop_id)
);
CREATE POLICY shop_visits_insert_assigned ON public.shop_visits
FOR INSERT TO authenticated
WITH CHECK (
  visited_by = (SELECT auth.uid())
  AND public.current_employee_role() IN ('owner', 'admin', 'salesperson')
  AND (
    public.current_employee_role() IN ('owner', 'admin')
    OR public.is_shop_assigned(shop_id)
  )
);
CREATE POLICY shop_photos_read_scope ON public.shop_photos
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR public.is_shop_assigned(shop_id)
);
CREATE POLICY shop_photos_insert_assigned ON public.shop_photos
FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by = (SELECT auth.uid())
  AND public.current_employee_role() IN ('owner', 'admin', 'salesperson')
  AND (
    public.current_employee_role() IN ('owner', 'admin')
    OR public.is_shop_assigned(shop_id)
  )
);
CREATE POLICY catalog_read_approved ON public.products
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin', 'salesperson'));
CREATE POLICY variants_read_approved ON public.product_variants
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin', 'salesperson'));
CREATE POLICY default_prices_read_approved ON public.default_prices
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin', 'salesperson'));
CREATE POLICY shop_prices_read_scope ON public.shop_price_overrides
FOR SELECT TO authenticated
USING (
  public.current_employee_role() IN ('owner', 'admin')
  OR public.is_shop_assigned(shop_id)
);
CREATE POLICY credit_control_read_approved ON public.credit_controls
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin', 'salesperson'));
CREATE POLICY audit_read_admin ON public.audit_events
FOR SELECT TO authenticated
USING (public.current_employee_role() IN ('owner', 'admin'));

-- Explicitly no direct UPDATE/DELETE policy or grants for protected workflows.
