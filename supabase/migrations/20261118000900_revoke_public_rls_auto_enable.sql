-- ============================================================================
-- Ethereal Co. — Supabase platform event-trigger privilege hardening
-- ============================================================================
-- Supabase staging exposes a platform-owned event-trigger function in public.
-- Its trigger remains owned by postgres and continues to run on DDL; browser
-- roles do not need EXECUTE permission to cause the event trigger to fire.
-- Keep execution limited to the trusted database operator.
DO $migration$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END
$migration$;
