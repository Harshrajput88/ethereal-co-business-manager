# Ethereal Co. — Phase 2 Release & Migration Plan

**Date:** 18 November 2026  
**Status: HOLD — no staging or production deployment is authorized.**

This document is the canonical migration manifest for the current release candidate. It supersedes the older eight-migration instructions. No SQL has been applied to staging or production.

## 1. Exact migration package

Apply only these nine files, in filename order:

| Order | Migration |
|---:|---|
| 1 | `20261118000100_business_schema.sql` |
| 2 | `20261118000200_business_core_rpcs.sql` |
| 3 | `20261118000300_business_sales_rpcs.sql` |
| 4 | `20261118000400_business_payment_rpcs.sql` |
| 5 | `20261118000500_business_inventory_return_expense_rpcs.sql` |
| 6 | `20261118000600_business_dashboard_team_rpcs.sql` |
| 7 | `20261118000700_business_security_integrity_remediation.sql` |
| 8 | `20261118000800_controlled_owner_bootstrap.sql` |
| 9 | `20261118000900_revoke_public_rls_auto_enable.sql` |

The exact release hashes for all nine files must be calculated from the frozen release commit immediately before deployment and recorded in the approval record. Earlier hashes in superseded versions of this plan are not authoritative for this nine-file package.

**Excluded historical drafts:** `20261117000100_phase1_foundation.sql` and `20261117000200_phase1_commerce_ledgers.sql`. Preserve them byte-for-byte. Never run a generic `supabase db push` while these drafts remain in the migration directory. Use a reviewed explicit migration selection and verify the exact plan before execution.

## 1A. Frozen CI hash record

The following SHA-256 values were emitted by successful GitHub Actions CI run [#16](https://github.com/Harshrajput88/ethereal-co-business-manager/actions/runs/44483604519) for release commit `4f85817138573b116d90490a349114160bf306eb`. These values identify the exact SQL file bytes tested by that run; recalculate and compare them again if any migration file changes.

| Migration | SHA-256 |
|---|---|
| `20261118000100_business_schema.sql` | `4aa1bb4a5bcb723d67de0d2b633d5d0cda1bb835368e105e48e418bf8f3b50fb` |
| `20261118000200_business_core_rpcs.sql` | `2f23d236278c120f3172fa6442fb390874ac1bc144e3948001d6bb910bae9ff5` |
| `20261118000300_business_sales_rpcs.sql` | `a9c619f438a06423cdc9182efcd329ec98ebe242d836d8428d23df389f386cca` |
| `20261118000400_business_payment_rpcs.sql` | `89401f07102d1a08abb80c27a8fbb4f05cd29eae1a3dab52578d7e1424a05144` |
| `20261118000500_business_inventory_return_expense_rpcs.sql` | `f438a12d4e732053b0adaf19b2bb9e64af8db5e974020673456bc0954cd86626` |
| `20261118000600_business_dashboard_team_rpcs.sql` | `05022af79b4cd7b3d517da848c2b29294b5fdc50aaae9fcebdf5e7a1dc7e6051` |
| `20261118000700_business_security_integrity_remediation.sql` | `16d30d467602c9cb909511424dc0330065f920ee6b9da4d269beb13f12a3abc6` |
| `20261118000800_controlled_owner_bootstrap.sql` | `03a0f3b4c73331532bf027260e3ddca570fcdf327d0382777aa3e3162be45e98` |
| `20261118000900_revoke_public_rls_auto_enable.sql` | `8bbaed3624146df4dc78da915fae0eab5540fb23608dd13f6dbd1932c527e9cd` |

CI run #16 completed automated tests, manifest generation, lint, and production build successfully. This is a reproducibility record, **not** independent security approval or proof of live Supabase concurrency.

## 2. Current security and feature boundaries

- Migration 007 contains business authorization and integrity remediation.
- Migration 008 disables public self-service owner claiming. The designated owner must be provisioned by a trusted project operator after verifying the Auth identity. No browser RPC may promote an owner.
- Migration 009 revokes `PUBLIC`, `anon`, and `authenticated` execution on the platform-owned `public.rls_auto_enable()` function while leaving the platform event trigger attached.
- Profile-picture upload is **not deployable yet**. The frontend expects a `profile-picture` Storage bucket, but this release does not provision it or its object policies. Do not make the bucket public as a workaround. Either provision a separately reviewed private bucket and owner-scoped policies with upload/read/replacement tests, or keep avatar upload disabled until that work is approved.
- No production connection or deployment is part of this plan.

## 3. Preconditions — all required

1. Independent security review of the exact nine migration files and their SHA-256 hashes.
2. Owner approval for those exact hashes, repository commit, target project ref, and migration-history strategy.
3. Fresh read-only inspection of the intended staging project, including project identity, schema, migration ledger, Auth configuration/users, Storage buckets/policies, grants, RLS, triggers, and functions.
4. A verified pre-deployment backup and a successful restore rehearsal. Confirm whether database, Auth, and Storage state are covered; do not assume a database-only dump is a complete project recovery.
5. Rehearsal of the exact nine-file set on a disposable Supabase-compatible environment, including real concurrent database sessions and Auth/PostgREST/RLS checks. Local PGlite tests are useful regression coverage but do not substitute for this.
6. Full local automated tests, lint, and production build on the frozen release commit.
7. No migration-history mismatch, no accidental inclusion of either 20261117 draft, and no ambiguity about the staging target.
8. Separate explicit authorization before any staging database write.

## 4. Rehearsal and staging verification

Use disposable Auth accounts and clearly marked test data. Verify:

- Migration ledger records exactly the nine reviewed IDs once each; neither historical draft is present.
- Expected tables, constraints, indexes, sequences, triggers, functions, ownership, grants, and RLS policies exist.
- Pending and disabled accounts cannot read protected business data or execute privileged RPCs.
- Authenticated users cannot execute `api_claim_owner()`; only trusted operator provisioning can create the designated owner.
- `PUBLIC` / `anon` / `authenticated` cannot execute `public.rls_auto_enable()`; the platform event trigger remains attached and functions normally during DDL.
- Sales, stock deduction, credit approval, payment verification/allocation, returns, expenses, invoices, reports, and audit events reconcile.
- Concurrent payment verification cannot over-allocate a sale; concurrent return approvals cannot exceed sold quantities; stock cannot become negative; idempotent retries do not duplicate transactions.
- The browser connects to the intended staging project and does not silently fall back to demo data.
- Avatar upload remains disabled unless a separately approved private Storage bucket and policies have been provisioned and tested, including cross-user denial.

Run Supabase security, performance, and health advisors after deployment. Resolve all unexpected findings before considering production.

## 5. Backup, recovery, and rollback

- Record backup timestamp, target ref, scope, retention, restore operator, and recovery procedure.
- Verify restoration access and rehearse recovery before writes. A public-schema-only dump is not sufficient evidence that Auth and Storage can be recovered.
- Stop immediately on the first migration error. Preserve logs and the last completed migration ID. Do not edit migration history or rerun modified SQL in place.
- Prefer forward corrective migrations after business data exists. Do not drop or truncate append-only audit, inventory, allocation, invoice, or ledger records as an ad hoc rollback.
- Restore only from the approved recovery point after an impact assessment and with a consistent database/Auth/Storage recovery plan.

## 6. Deployment order and approval boundary

1. Freeze the exact repository commit and calculate SHA-256 hashes for all nine SQL files.
2. Complete independent review, full local checks, disposable rehearsal, and backup/restore rehearsal.
3. Obtain explicit approval for the exact hashes and staging target `zvnnnplpjkwmnaukthgp`.
4. Reconfirm project identity and fresh migration/schema/Auth/Storage inventory immediately before writing.
5. Apply only the reviewed nine-file set to staging, in order. Stop at the first error.
6. Verify migration history, grants, RLS, advisor findings, Auth/RPC behavior, and all business smoke tests.
7. Production project `jojfscpsaqfcazqzkjio` remains out of scope. It requires a separate review, backup, and explicit production approval after staging passes.

**Current decision: NO-GO for database writes.** This plan is preparation, not authorization.