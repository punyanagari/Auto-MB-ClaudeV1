# APPROVED-085: GSTIN uniqueness — hard DB constraint or service-layer duplicate detection
Status: APPROVED — via dashboard 2026-08-05
Decision: Option A
Authorizes: DC-47
Scope: packages/db/migrations/** packages/db/test/contacts-master.dbtest.ts
Filed by: orchestrator (fable) on 2026-08-05
Deadline: before the Phase-B contacts import ticket is dispatched  ·  Default if silent: Option A
Blocks: nothing today (DC-47 merges with Option A in place; Option B is one trivial migration later)

## The question

DC-47 landed `UNIQUE (tenant_id, gstin_normalized)` on `contacts`. The DC-47
review (cross-model, 2026-08-05) flagged this as a product decision taken at
the strictest point without escalation: PRODUCT-SPEC §9's only stated
rejection rule is "duplicates rejected on designation + station"; GSTIN is
described as format-validated and uppercased for *detection*. Measured by
effect: same GSTIN + different designation + different station → hard
`duplicate key` rejection. Two offices/branches of one organisation in one
state legitimately share a GSTIN, and §9's documented 126-contact Zoho
import would hard-fail on the first shared-GSTIN pair.

## Option A (in place today, default): keep the hard unique

One GSTIN = one contact row per tenant. Strictest data integrity; duplicate
entry is impossible rather than detected. The Phase-B import flow must
pre-dedupe or merge shared-GSTIN branch offices into one contact. Reversal
cost if wrong: one trivial `DROP CONSTRAINT` migration.

## Option B: demote to service-layer detection

Drop the unique constraint (keep `gstin_normalized` for comparison); the
service layer warns/asks on a GSTIN match instead of the database rejecting.
Matches §9's "detection" wording; supports shared-GSTIN branches natively;
costs the hard guarantee (duplicates become possible wherever service code
forgets to check).

## Recommendation

Option A until the Phase-B import ticket is scoped, then revisit with the
real Zoho export in hand — the import data will answer whether shared-GSTIN
branch contacts actually occur in this tenant's book. The asymmetry favors
starting strict: A→B is one migration; B→A after duplicates exist requires a
data cleanup.
