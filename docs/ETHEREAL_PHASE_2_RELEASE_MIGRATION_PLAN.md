# Ethereal Co. — Phase 2 Release & Migration Plan

**Date:** 18 November 2026
**Status:** Local remediation complete; **awaiting owner approval**. Nothing in
this plan has been executed against staging or production.

## 1. Release set

Exactly eight migrations, applied in filename order:

| Order | File | SHA-256 |
|-------|------|---------|
| 1 | `20261118000100_business_schema.sql` | `4AA1BB4A5BCB723D67DE0D2B633D5D0CDA1BB835368E105E48E418BF8F3B50FB` |
| 2 | `20261118000200_business_core_rpcs.sql` | `2F23D236278C120F3172FA6442FB390874AC1BC144E3948001D6BB910BAE9FF5` |
| 3 | `20261118000300_business_sales_rpcs.sql` | `A9C619F438A06423CDC9182EFCD329EC98EBE242D836D8428D23DF389F386CCA` |
| 4 | `20261118000400_business_payment_rpcs.sql` | `89401F07102D1A08ABB80C27A8FBB4F05CD29EAE1A3DAB52578D7E1424A05144` |
| 5 | `20261118000500_business_inventory_return_expense_rpcs.sql` | `F438A12D4E732053B0ADAF19B2BB9E64AF8DB5E974020673456BC0954CD86626` |
| 6 | `20261118000600_business_dashboard_team_rpcs.sql` | `05022AF79B4CD7B3D517DA848C2B29294B5FDC50AAAE9FCEBDF5E7A1DC7E6051` |
| 7 | `20261118000700_business_security_integrity_remediation.sql` | `16D30D467602C9CB909511424DC0330065F920EE6B9DA4D269BEB13F12A3ABC6` |
| 8 | `20261118000800_controlled_owner_bootstrap.sql` | **Re-hash before release packaging** |

**Excluded:** `20261117000100_phase1_foundation.sql` and
`20261117000200_phase1_commerce_ledgers.sql` are historical drafts. Keep them
byte-for-byte; do not apply, rename, delete, or mark them applied. Because they
sit in the CLI migration directory, **never run a generic `supabase db push`**.
Use a reviewed release directory containing only the eight files above.

> The remediation and owner-bootstrap files must be re-hashed from the exact release commit immediately before packing. Do not treat an unverified hash as authoritative; record both verified values in the deployment log.

## 2. Preconditions (all must be true)

1. Owner approval recorded for this exact hash set.
2. A disposable Supabase-compatible environment (or local PostgreSQL service)
   is available for rehearsal. Do **not** rehearse on production.
3. The target has been inspected read-only and its state matches the assumption
   that migrations 1–6 are not yet applied (or that an equivalent schema is
   already present with compatible definitions).
4. Preflight checks:

```sql
-- a. Excluded drafts must not be in target history
select version from supabase_migrations.schema_migrations
where version like '20261117%';

-- b. Release versions must be absent (fresh apply) or already fully applied
select version from supabase_migrations.schema_migrations
where version in ('20261118000100','20261118000200','20261118000300',
                  '20261118000400','20261118000500','20261118000600',
                  '20261118000700','20261118000800');

-- c. Pre-existing duplicate return lines (would abort the unique index)
select return_request_id, sale_line_id, count(*)
from public.return_lines
group by 1, 2 having count(*) > 1;

-- d. Existing signup trigger (must be absent, or ours and AFTER INSERT FOR EACH ROW)
select t.tgname, p.oid::regprocedure as fn, t.tgtype
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal;

-- e. Existing conflicting SKU/product pair (LOW finding)
select pv.sku, pv.product_id, p.name
from public.product_variants pv join public.products p on p.id = pv.product_id
where pv.sku in ('ETC-500ML-24','ETC-1L-12');

-- f. Objects from migrations 1–6 that the remediation replaces must exist
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('api_team_list','api_audit_log','api_claim_owner',
                  'api_verify_payment','api_record_payment','api_submit_return',
                  'api_review_return','api_receive_stock','api_adjust_stock',
                  'api_stock_qty','api_dashboard','api_set_employee_status',
                  'api_set_employee_role');
```

Expected: (a) empty, (b) empty or all eight present, (c) empty, (d) empty or one
matching trigger, (e) empty or the expected seeded pair, (f) all 13 functions
present if 1–6 are already applied.

## 3. Rehearsal sequence (disposable environment only)

1. Snapshot the empty/legacy schema and record the ledger state.
2. Apply migrations 1–6; run the documented smoke checks (catalog, team list,
   one cash sale, one credit sale, one payment verification).
3. Apply migration 7, then migration 8 in filename order. Each must commit
   atomically; any exception rolls that file back.
4. Functional checks:
   - `api_team_list()` / `api_audit_log()` return `[]` for a pending and a
     disabled profile, and data for owner/admin.
   - Authenticated execution of `api_claim_owner()` is denied after migration 8; the designated owner is provisioned only by a trusted project operator.
   - Two overlapping verification sessions for two payments against one sale:
     exactly one succeeds, the other raises `Sale balance changed`; sale balance
     never negative.
   - Two overlapping return approvals for one sale line: exactly one succeeds.
   - Replaying a payment/sale/stock reference with a different payload raises;
     replaying the identical payload returns `idempotent: true`.
   - `api_stock_qty` reports `bigint` and totals beyond 2 147 483 647.
5. Post-apply object audit:

```sql
select oid::regprocedure, prorettype::regtype
from pg_proc where proname = 'api_stock_qty';

select indexname from pg_indexes
where tablename = 'return_lines' and indexname = 'return_lines_request_line_unique';

select tgname, tgtype, tgfoid::regprocedure
from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;
```

## 4. Production/staging apply (after separate approval)

1. Freeze writes (maintenance window) for the duration; these migrations change
   authorization and allocation behaviour.
2. Take a logical backup and record the current ledger.
3. Apply the eight files in order in a single reviewed transaction **or** via
   the CLI with the release directory; confirm each version is recorded exactly
   once.
4. Re-run §3 and a representative read-only smoke set.
5. Unfreeze; monitor `api_verify_payment` lock waits, `api_team_list` errors and
   PostgREST schema cache reload.

## 5. Rollback approach

The remediation is **additive and function-replacing**, so application rollback
is possible without data loss for the schema itself. It is not a full data
rollback: rows written under the new rules remain.

**Application rollback (safe, minutes):**

1. Re-apply the *original* definitions from `20261118000200`–`20261118000600`
   for every replaced function (`CREATE OR REPLACE` restores prior bodies; run
   `DROP FUNCTION public.api_stock_qty(uuid, text);` then re-create the
   `integer` version from `20261118000200` because the return type changed).
2. Leave `idempotency_fingerprint` columns and the unique index in place — they
   are additive and the original bodies ignore them. Dropping the index is only
   safe after confirming no duplicate lines exist.
3. Verify: `api_team_list`/`api_audit_log` revert to prior behaviour, payments
   verify without sale locks (old risk returns). **Rolling back reintroduces the
   HIGH findings**, so it is a break-glass option, not a normal path.

**Forward fix preferred:** ship a new migration that corrects the specific
function rather than reverting the whole remediation.

**Full teardown (only for an unused/disposable environment):** drop the two
columns and the unique index *after* re-applying the original functions; then
remove the ledger row for `20261118000700` through the controlled procedure —
never fabricate or delete ledger rows on a live project.

## 6. Go / No-Go gate

GO to staging rehearsal when:

- Owner approves the hashes in §1.
- `npm test`, `npm run lint`, `npm run build` pass on the release commit.
- Preflight §2 is clean on the disposable target.

GO to production only when:

- Staging rehearsal (including real concurrent verification/return/owner races)
  passes with no over-allocation, no over-return, and no unauthorized reads.
- The auth signup trigger check passes on the target.
- Backup and rollback rehearsal are complete.

Until then the release remains **NO-GO for production**.
