# Ethereal Co. — Staging Deployment Runbook

**Status: HOLD — do not deploy this migration package yet.** This runbook describes a future, explicitly approved staging release. It is not authorization to connect to Supabase, execute SQL, run a migration, or write to Storage. Local remediation and regression coverage have since been added for the previously identified authorization, return-limit, payment-allocation, idempotency, and owner-bootstrap issues; the local suite passes. That is not a substitute for independent security review or a real Supabase-compatible rehearsal with actual concurrent database sessions. Keep the eight-file release set and both historical drafts unchanged until those external gates are complete.

## Target and scope

- Intended isolated staging project: `zvnnnplpjkwmnaukthgp`.
- Production application project, explicitly excluded: `jojfscpsaqfcazqzkjio`.
- Never infer a target from a dashboard branch label. Before each future remote operation, compare the configured project ref and linked-project identity with the owner-approved staging reference. Abort on mismatch.

## Controlled first-owner bootstrap

- Public signup must never grant a user the ability to claim the first owner role. Migration 008 revokes authenticated execution of `api_claim_owner()`; the cloud UI does not expose self-service owner claiming.
- Create/invite the designated owner through the trusted Supabase Auth operator workflow. Verify the email and Auth user ID out-of-band before changing the profile.
- As the trusted project operator only (never from the browser), promote that exact Auth user:

```sql
UPDATE public.profiles AS p
SET role = 'owner', status = 'approved',
    approved_at = COALESCE(p.approved_at, now()),
    approved_by = p.id, disabled_at = NULL
FROM auth.users AS u
WHERE p.id = u.id
  AND lower(u.email) = lower('<DESIGNATED_OWNER_EMAIL>');
```

- Verify exactly one approved owner exists before enabling ordinary team onboarding. Never expose service-role credentials in frontend code.

- No production connection or deployment is part of this runbook.
- The prior read-only inspection found no public business relations, no public API functions, no `public.profiles`, no project `supabase_migrations.schema_migrations` ledger, zero Auth users by aggregate count, and no Storage buckets. Re-inspect under separately approved read-only authorization immediately before any future staging deployment; these facts can become stale.

## Explicit migration order

The intended current business package is these eight files, in timestamp order:

1. `supabase/migrations/20261118000100_business_schema.sql`
2. `supabase/migrations/20261118000200_business_core_rpcs.sql`
3. `supabase/migrations/20261118000300_business_sales_rpcs.sql`
4. `supabase/migrations/20261118000400_business_payment_rpcs.sql`
5. `supabase/migrations/20261118000500_business_inventory_return_expense_rpcs.sql`
6. `supabase/migrations/20261118000600_business_dashboard_team_rpcs.sql`
7. `supabase/migrations/20261118000700_business_security_integrity_remediation.sql`
8. `supabase/migrations/20261118000800_controlled_owner_bootstrap.sql`

Do **not** run a generic `supabase db push` against the current migration directory. It also contains these historical drafts, which must not be included implicitly:

- `supabase/migrations/20261117000100_phase1_foundation.sql`
- `supabase/migrations/20261117000200_phase1_commerce_ledgers.sql`

The drafts create overlapping schema/types/policies, have prior security-review findings, and are not approved as a deployment base. Preserve both originals. Before any deployment, the owner/operator must reconcile project history and create an explicit, reviewed release plan that selects only the eight 20261118 files. Do not rename/delete the drafts merely to influence the CLI; use an isolated reviewed migration directory/worktree or another documented selection process, then verify the exact migration plan before execution.

## Required go/no-go gates

Do not proceed until all are true:

- The findings in `reports/ETHEREAL_SIX_MIGRATION_SECURITY_RELEASE_REVIEW.pdf` are addressed and independently reviewed. In particular, fix list-RPC NULL authorization, cumulative/concurrent return limits, payment allocation serialization and amount rounding, and bootstrap/last-owner races.
- Re-run local SQL parsing, contract checks, and automated tests against the corrected package. Add regression tests for each fix and concurrent operations.
- Obtain owner/security approval for the exact eight-file package and migration-history strategy.
- Verify staging target ref and project identity; production ref must not match.
- Obtain a fresh read-only object/history/Auth/Storage inventory. Reconcile all existing objects and identify whether any data must be preserved.
- Define an owner-approved backup/restore point and confirm restoration access before writes.
- Rehearse the exact selected migration set on a disposable Supabase project with compatible PostgreSQL/Auth/Storage/PostgREST behavior.
- Approve Storage bucket and object-policy configuration separately; these migrations do not provision the frontend's `profile-picture` bucket.

## Pre-deployment checklist

1. Freeze the reviewed SQL artifacts and record cryptographic hashes, repository revision, reviewer, approval, and intended target.
2. Confirm the project ref from local link metadata and the Supabase CLI target banner. Stop on any ambiguity or mismatch.
3. Inspect migration ledger/history and compare against every intended migration ID. The prior inspection did not find the usual project ledger; resolve that explicitly rather than assuming “all pending” or “all applied.”
4. Inspect current schema, extensions, owners, grants, RLS policies, Auth triggers/functions, and Storage buckets/policies. Use metadata and approved aggregate counts only; do not export private records.
5. Reconcile compatibility for existing `profiles`, role type/enum, signup triggers, sequences, policies, and all objects created with `IF NOT EXISTS`. The DDL is not a general-purpose schema merge for arbitrary partially existing tables.
6. Verify the Auth configuration, email confirmation behavior, signup metadata contract, redirect URLs, and availability of a controlled owner bootstrap account.
7. Create and verify a recoverable pre-deployment backup. Record who can restore it and the expected restoration time.
8. Run the exact proposed eight-file plan in a disposable rehearsal environment; capture migration output, object/grant/RLS checks, and rollback rehearsal results.
9. Confirm no older 20261117 drafts appear in the plan and no command can target production.
10. Obtain separate, explicit owner authorization for the staging database write. This review itself does not provide that authorization.

## Backup requirements

- Use the Supabase-supported project backup/PITR or a documented logical backup appropriate to the project. Confirm the backup completes and can be restored before proceeding.
- Preserve Auth user identity state and Storage configuration/objects as applicable; a public-schema-only dump may not restore those systems.
- Record the backup timestamp, target ref, retention, restore operator, and restore procedure without putting secrets in the repository.
- Even though the previous snapshot showed an empty public schema and zero Auth users, still take a backup: the snapshot may be stale and platform-managed objects/configuration are not equivalent to business data.

## Deployment procedure — only after approval

1. Reconfirm the exact staging ref immediately before the write and exclude production.
2. Use the separately approved, explicit migration selection—not a generic push while the older drafts are present.
3. Apply migrations 1–8 above sequentially. Stop at the first error; do not continue or manually mark history applied to bypass a failure.
4. Capture migration output and resulting migration-history IDs. Verify each file is recorded exactly once.
5. Request/reload the PostgREST schema cache using the approved Supabase mechanism only after all DDL completes.
6. Provision `profile-picture` and narrowly scoped Storage policies in a separate reviewed step, only if explicitly approved.

## Auth and first-owner setup

- Confirm Auth is enabled and the signup flow generates an `auth.users` row. Migration 1 creates `api_handle_new_auth_user()` and installs `on_auth_user_created` only if a trigger with that name is absent.
- Verify there is exactly one intended signup trigger and that it creates a pending salesperson profile without trusting role/status from user metadata.
- Migration 008 intentionally disables self-service owner claiming; `api_claim_owner()` must remain unavailable to `PUBLIC`, `anon`, and `authenticated`.
- Create/invite the designated owner through the trusted Auth operator workflow, verify the email and Auth user ID out-of-band, and provision that profile using the operator-only SQL above. Never use a browser RPC or browser-supplied metadata to promote an account.
- Test pending, approved, disabled, salesperson, admin, and owner authorization. Disabled/pending accounts must not receive list data or invoke privileged operations.

## Storage setup

- The migrations store avatar/evidence paths but do not create buckets or Storage policies.
- Provision only the required bucket(s) after owner approval. Decide public/private access, file-size and MIME restrictions, object naming/ownership, read URLs, overwrite behavior, and deletion lifecycle.
- Policies must bind object paths to `auth.uid()` and minimize cross-user access; never rely on frontend checks alone.
- Smoke-test upload, read, replacement and unauthorized cross-user access using non-production test accounts. Do not use real personal images/receipts in test fixtures.

## Post-deployment database verification

Verify from staging metadata and an authenticated test client:

- Migration ledger contains exactly the reviewed eight current IDs; neither 20261117 draft is applied.
- All expected tables, constraints, indexes, sequences, and seed products exist.
- Every browser-visible business table has RLS enabled and expected policies; no unintended direct write grants exist.
- All SECURITY DEFINER functions have a fixed safe `search_path`, intended ownership, and least-privilege EXECUTE grants. `PUBLIC` and `anon` must not execute business RPCs; internal helpers must not be client-callable.
- All 42 frontend RPC signatures and argument names match `docs/SUPABASE_RPC_INVENTORY.md`; intended browser RPCs are executable by `authenticated`, with the deliberate exception that `api_claim_owner()` is revoked from `PUBLIC`, `anon`, and `authenticated` by migration 008.
- Pending/disabled users return no protected data. Salespeople are limited to their assigned shops; admin and owner powers match the permission matrix.
- Audit events are written for state changes and do not contain credentials or unnecessary sensitive data.
- Stock, payment, return, invoice, and ledger invariants hold after test transactions and reversals/rollback.
- `profile-picture` bucket/policies exist only if separately approved; test that unauthorized users cannot read/write another user's objects.

## Staging smoke tests

Use disposable Auth accounts and clearly marked test data. Verify:

1. Sign-up creates one pending profile; sign-in, sign-out, and session restore work.
2. Authenticated calls to `api_claim_owner()` are denied; the designated owner is provisioned only by the trusted project operator, and a second account cannot self-promote.
3. Pending/disabled users cannot retrieve `api_team_list`, `api_audit_log`, business settings, or other protected data.
4. Owner creates a product price and shop; salesperson assignment boundaries are enforced.
5. Cash/UPI sale totals, invoice snapshots, stock deduction, submitted payment, verification, allocation, receipt, and outstanding balance reconcile.
6. Credit sale approval/rejection works; stock changes only on approval and is concurrency-safe.
7. Payment with explicit allocations and FIFO remainder cannot over-allocate under concurrent verification; rounding remains within payment and sale balances.
8. Return requests cannot exceed original sold quantity across duplicate lines, multiple requests, or concurrent approvals; reusable/damaged stock and return credit reconcile.
9. Stock receive/adjust/sale/return concurrency cannot drive saleable stock below zero; retries are idempotent and do not create duplicate audit events.
10. Expense submit/review/settlement, reports, dashboard, team permissions, and audit log work for each role.
11. Profile update and approved avatar upload work; all other user's profile/storage access is denied.
12. Browser network responses show the intended staging project and no silent demo fallback. Production remains untouched.

## Rollback and recovery

- Prefer a forward corrective migration for application defects once business writes have started; do not delete append-only audit, inventory, allocation, invoice, or ledger rows as an ad hoc rollback.
- Before real staging data is introduced, a failed DDL deployment may be recoverable by restoring the verified pre-deployment backup. Confirm the exact Supabase restore/PITR behavior and whether Auth/Storage state is included before relying on it.
- If any migration fails, stop immediately, preserve logs, record the last completed migration, and obtain owner/operator review. Do not edit migration history or rerun modified SQL in place.
- Rehearse a full restore and recovery plan before release. If restore is selected, restore the whole approved recovery point consistently across database/Auth/Storage as supported, then re-verify the target and migration history.
- After user/business data exists, rollback requires a documented impact assessment and restore decision. Reversing schema alone may lose data or violate append-only/audit invariants.
- No automated destructive down-migrations are supplied by this package. Do not `DROP` objects or truncate data as a routine rollback.

## Approval boundary

This is a local review/runbook only. No remote connection, SQL execution, Supabase modification, migration, Storage write, or deployment is authorized. Stop and await separate explicit owner approval before any database write.
