# Ethereal Co. Business Manager — Implementation Roadmap

**Gate:** Architecture and read-only metadata package must be reviewed before implementation. This roadmap is proposed and dependency-aware.

## Phase 0 — Review and verify

- Run `supabase/inspection/readonly_metadata_audit.sql` manually only after environment/role approval; compare staging and local migration history without changing either.
- Confirm whether the observed `profiles` table and its policies/grants/functions match current reports.
- Resolve architecture decisions listed in `ETHEREAL_TARGET_ARCHITECTURE.md`; approve scope, roles, tenant boundary, data definitions, and public/private split.
- **Exit:** signed-off schema/RLS design, verified inventory, prioritized user journeys, and test/backup/recovery plan.

## Phase 1 — Foundations and access control

- Establish migration conventions and local disposable test environment; create reviewed migrations only after Phase 0 approval.
- Implement business membership and role model, profile lifecycle, owner-controlled approvals, audit event strategy, and baseline RLS.
- Add database tests for cross-business isolation, pending/disabled users, role boundaries, self-escalation denial, and storage ownership.
- **Exit:** all permission tests pass under real authenticated roles; no service-role key reaches browser bundle.

## Phase 2 — Catalog and shops

- Implement products/variants, packaging rules, shop records, assignments, and effective-dated pricing based on approved decisions.
- Add validation, indexes, import/export strategy, and catalog/shop UI.
- **Tests:** constraints and date boundary tests; role-specific CRUD; salesperson assignment isolation; accessibility and responsive UI.

## Phase 3 — Orders and payments

- Implement order creation and lifecycle with immutable price snapshots, atomic totals, payment capture/allocation, and audited corrections.
- Add idempotency for retried submissions and server-side validation; do not use client totals as authority.
- **Tests:** transaction rollback/atomicity, duplicate submission, partial/full payments, invalid status transitions, concurrent updates, role isolation, and timezone/business-date boundaries.

## Phase 4 — Inventory and reporting

- Implement append-only stock movements and reconcile projections; define returns, wastage, and adjustment controls before coding.
- Build reports from agreed definitions; paginate and index measured query patterns.
- **Tests:** ledger reconciliation, no unauthorized adjustment, report totals against fixtures, date ranges/timezone, and query performance baselines.

## Phase 5 — Public website and PWA readiness

- Deliver a separately bounded public website and private installable PWA; define cache exclusions for authenticated/private content.
- Add offline read-only behavior only where safe; communicate when write actions need connectivity.
- **Tests:** no private data in public routes/cache, install/update flow, network loss/recovery, browser compatibility, accessibility, and mobile regression.

## Phase 6 — Release and operations

- Review security findings, migration rollback/forward-recovery plan, backups, monitoring, audit retention, support playbooks, and staged rollout.
- Deploy to staging first; obtain explicit release approval before production changes.
- **Tests:** end-to-end role journeys, restore rehearsal, migration rehearsal on disposable/staging data, smoke tests, and rollback decision rehearsal.

## Cross-cutting quality gates

- Every schema change reviewed and versioned; no ad hoc production SQL.
- RLS tests cover allow and deny cases for every table, role, and tenant boundary.
- Business mutations are server validated, transactional, auditable, and idempotent where retries are possible.
- UI includes loading, empty, error, and permission-denied states; forms validate on client and server.
- CI runs lint, unit, database-policy/integration, and end-to-end tests; secrets are scanned and never bundled.
- Preserve existing working authentication/profile flows unless an explicitly reviewed replacement has parity and regression tests.

## Dependencies and sequencing

Phase 0 decisions precede schema. Identity/membership and RLS precede all business modules. Catalog and shops precede orders; orders precede payment reporting; inventory rules precede stock workflows. Public/private boundaries and cache policy precede PWA rollout. Release operations and restore rehearsal precede production. No phase authorizes database or production access by itself.
