-- ============================================================================
-- Ethereal Co. — controlled first-owner bootstrap
-- ============================================================================
-- Public signup must never be able to claim business ownership. The designated
-- owner is provisioned by a trusted project operator after verifying Auth identity.
-- This migration is intentionally forward-only; historical migrations are preserved.

CREATE OR REPLACE FUNCTION public.api_claim_owner()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION
    'Self-service owner claiming is disabled. Ask the trusted project operator to provision the designated owner.'
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.api_claim_owner() FROM PUBLIC, anon, authenticated;
