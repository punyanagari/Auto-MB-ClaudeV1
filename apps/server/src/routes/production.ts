import {
  BomResponseSchema,
  CancelJobCardRequestSchema,
  CreateDispatchRequestSchema,
  CreateJobCardRequestSchema,
  JobCardDetailSchema,
  JobCardListQuerySchema,
  JobCardListResponseSchema,
  ProductionItemListResponseSchema,
  ProductionItemSchema,
  RecordComponentSerialRequestSchema,
  SaveBomLineRequestSchema,
  SaveProductionItemRequestSchema,
  UpdateJobCardRequestSchema,
  withKeysetQuery,
  type BomNode,
  type ComponentSlot,
  type Dispatch,
  type ErrorCode,
  type FinishedSerial,
  type JobCardDetail,
  type JobCardStatus,
  type JobCardSummary,
  type MaterialRequirement,
  type ProductionItem,
  type ProductionSpecification,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { assertWorkOperable } from '../work-status.js';
import { financialYearLabel } from '../financial-year.js';
import { httpError } from '../http.js';
import { keysetPage, sqlLimit } from '../pagination.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  audit,
  errorResponses,
  IdParamsSchema,
  optionalTrimmed,
  requireTrimmed,
} from './shared.js';

/**
 * OEM production (migration 0084).
 *
 * The mock's three screens — `app/production/page.tsx` (the register),
 * `app/production/items/page.tsx` (the item master and its recursive
 * bill of material) and `components/production-job-card-page.tsx` (one
 * job card, four tabs) — at fdfe5ef.
 *
 * WHO MAY DO WHAT, and why the split falls where it does:
 *
 *   * The item master and the bill of material are `role: 'writer'`.
 *     They are product design, which is office work, and the same role
 *     that governs every other master.
 *   * Raising, revising and completing a job card, minting a unit's
 *     serial, scanning a component into it and releasing it are
 *     `role: 'evidence'`. This is shop-floor work — the same footing as
 *     recording a delivery or an installation, and the same reason: the
 *     people holding the hardware are the people who record it.
 *   * Cancelling a job card carries the `cancel` authority, as every
 *     other cancel of a numbered record does.
 *
 * LOCK ORDER, extending the ordering `routes/inspections.ts` declares:
 * works -> work_items -> production_job_cards -> production_serials. No
 * path here takes a Work lock after a job-card lock.
 *
 * ponytail: no material SHORTAGE is computed. Shortage is requirement
 * minus on-hand, on-hand is the Inventory pack's stock ledger, and it
 * does not exist yet. The requirement — the honest half — is served;
 * subtract the other half when the ledger lands rather than shipping a
 * column of zeroes that reads as "nothing is short".
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0084 raises with SQLSTATEs from the 23D block, one per rule,
 * so a guard that fires because a writer reached the table by another
 * path surfaces as the same 409 an operator would have got from the
 * route — not as an unexplained 500. The route checks each of these
 * first, under its locks; this is the concurrent arm of the same rules.
 *
 * 23503 is here for the same reason at one remove: it is what PostgreSQL
 * raises when a unit that has been despatched, or one with components
 * consumed into it, is deleted. Migration 0084 § 4 makes that refusal
 * the foreign key's job rather than a guard's, so the mapping has to
 * live where the other refusals do.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23D01': [
    'PRODUCTION_BOM_CYCLE',
    'Another edit closed a loop in this bill of material while the line was being added.',
  ],
  '23D02': [
    'PRODUCTION_BOM_LINE_INVALID',
    'The parent or the component stopped being a legal end of this line while it was being added.',
  ],
  '23D03': [
    'PRODUCTION_ITEM_INVALID',
    'The item changed underneath this edit; re-open it and try again.',
  ],
  '23D04': [
    'PRODUCTION_ITEM_IN_USE',
    'The item is still in use by an open job card and cannot be retired.',
  ],
  '23D11': [
    'PRODUCTION_JOB_CARD_STATE_INVALID',
    'The job card moved to another state while this was being recorded.',
  ],
  '23D12': [
    'PRODUCTION_JOB_CARD_STATE_INVALID',
    'The job card was completed or cancelled while this was being recorded.',
  ],
  '23D13': [
    'PRODUCTION_JOB_CARD_INCOMPLETE',
    'The job card’s unit count changed while it was being completed.',
  ],
  '23D14': [
    'PRODUCTION_QUANTITY_EXCEEDED',
    'The job card produced its last planned unit while this one was being serialised.',
  ],
  '23D15': [
    'PRODUCTION_COMPONENT_SERIAL_INVALID',
    'The unit was despatched or its bill of material changed while the component was being scanned.',
  ],
  '23D16': [
    'PRODUCTION_DISPATCH_INVALID',
    'The job card was cancelled, the date moved past the organisation’s today, or a unit lost a component serial while the release was being recorded.',
  ],
  '23D17': [
    'PRODUCTION_DISPATCH_INVALID',
    'The organisation has no resolvable calendar date, so a despatch cannot be dated. Set the organisation timezone in Settings.',
  ],
  '23503': [
    'PRODUCTION_SERIAL_LOCKED',
    'The unit has components consumed into it or has already been despatched, so it can no longer be removed.',
  ],
};

/**
 * Every named refusal migration 0084 can raise. The test
 * `production.integration` asserts that this set is exactly the set of
 * ERRCODEs in the migration text, so a guard added there without a
 * mapping here fails the build instead of reaching an operator as a 500.
 */
export const PRODUCTION_DATABASE_REFUSAL_CODES: readonly string[] =
  Object.keys(DATABASE_REFUSALS);

/**
 * A CHECK violation, mapped rather than surfaced.
 *
 * The 23D codes above are the rules this migration states deliberately.
 * 23514 is everything the COLUMNS refuse — a name that trims to one
 * character, a part number of forty-one — and without this it arrives as
 * an unexplained 500. The route trims and length-checks first
 * (`trimmedField`), so reaching here means a writer got past that; the
 * answer is still a 400 naming the shape rather than a server error.
 */
function isCheckViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    String(error.code) === '23514'
  );
}

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  if (isCheckViolation(error)) {
    throw httpError(
      400,
      'PRODUCTION_ITEM_INVALID',
      'A value in this request is outside the shape its column allows — check the lengths and that nothing is blank.',
    );
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    String(error.code) === '23505'
  );
}

/**
 * The organisation's own date, so "not in the future" means the
 * operator's today rather than the server's UTC day. The same function
 * migration 0082's liveness comparison uses, so a release recorded at
 * 00:30 IST is not refused as tomorrow's.
 *
 * Module-local, as it is in `inspections.ts`, `payments.ts` and
 * `bill-payments.ts`: three lines of SQL repeated is cheaper to read
 * than an import that hides which date a route is asking about.
 *
 * An UNRESOLVABLE date is refused, not defaulted. The first version
 * returned a `9999-12-31` sentinel, which is the worst of both answers:
 * every future-date check passes, every financial-year label reads
 * 9999-00, and the operator is told nothing. There is no organisation
 * without a timezone in practice — the column is NOT NULL — so this
 * fires only when the row itself is unreachable, and saying so is the
 * honest answer.
 */
async function todayOf(tx: TransactionSql, organisationId: string): Promise<string> {
  const [row] = await tx<{ today: string | null }[]>`
    select app_private.organisation_today(${organisationId})::text as today
  `;
  if (!row?.today) {
    throw httpError(
      409,
      'PRODUCTION_DISPATCH_INVALID',
      'The organisation has no resolvable calendar date, so this cannot be dated. Set the organisation timezone in Settings.',
    );
  }
  return row.today;
}

/**
 * Proves the Work is one this organisation may still act on, after
 * proving the caller may reach it.
 *
 * A completed Work takes no new records — that is what `work-status`
 * says for every other Work-linked write, and a job card raised against
 * a Work whose contract is closed is exactly the kind of record the rule
 * exists to stop. A card with NO Work skips it: there is no Work to be
 * completed, and a private purchase order is not governed by any Work's
 * status.
 */
async function assertWorkWritable(
  tx: TransactionSql,
  userId: string,
  workId: string,
  action: string,
): Promise<void> {
  await assertWorkAccess(tx, userId, workId);
  const [work] = await tx<{ status: string }[]>`
    select status from works where id = ${workId} and deleted_at is null
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  assertWorkOperable(work.status, action);
}

/** `PP-26-081` — the mock's job-card number. Built for display rather
 * than stored, because both halves are already columns and a third copy
 * is a third thing that can disagree (`routes/inspections.ts` builds its
 * call reference the same way). */
function jobCardNumberOf(fyLabel: string, sequenceNumber: number): string {
  return `PP-${fyLabel.slice(2, 4)}-${String(sequenceNumber).padStart(3, '0')}`;
}

/** `PP-26-081/D1` — one release from a job card. */
function dispatchNumberOf(jobNumber: string, sequenceNumber: number): string {
  return `${jobNumber}/D${String(sequenceNumber)}`;
}

// --- Row shapes -------------------------------------------------------------

interface ItemRow {
  id: string;
  item_code: string;
  name: string;
  category: string;
  unit: string;
  manufactured: boolean;
  serial_prefix: string | null;
  serial_controlled: boolean;
  specifications: unknown;
  active: boolean;
  created_at: Date;
}

const ITEM_COLUMNS = `
  id, item_code, name, category, unit, manufactured, serial_prefix,
  serial_controlled, specifications, active, created_at
`;

/** The stored jsonb, narrowed back to the shape its CHECK constraint
 * guarantees. The parse is the shared helper's; the narrowing is here
 * because `parseJsonbColumn` answers `unknown` on purpose. */
function specificationsOf(raw: unknown): ProductionSpecification[] {
  const parsed = parseJsonbColumn(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as ProductionSpecification[];
}

function toItem(row: ItemRow): ProductionItem {
  return {
    id: row.id,
    itemCode: row.item_code,
    name: row.name,
    category: row.category,
    unit: row.unit,
    manufactured: row.manufactured,
    serialPrefix: row.serial_prefix,
    serialControlled: row.serial_controlled,
    specifications: specificationsOf(row.specifications),
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

interface JobCardRow {
  id: string;
  fy_label: string;
  sequence_number: number;
  item_id: string;
  item_code: string;
  item_name: string;
  quantity: number;
  work_id: string | null;
  work_code: string | null;
  source_reference: string;
  customer_name: string | null;
  status: JobCardStatus;
  due_date: string;
  completed_on: string | null;
  cancellation_reason: string | null;
  manufactured_count: number;
  dispatched_count: number;
  material_lines: number;
}

/**
 * One job card with its derived counts.
 *
 * `manufactured` and `dispatched` are COUNTED here rather than stored on
 * the card, which is the whole disagreement with the mock's data shape:
 * its `ProductionPlan` carries both as fields, and its own fixture then
 * contradicts them. A count cannot drift from the rows it counts.
 */
const JOB_CARD_SELECT = `
  select j.id, j.fy_label, j.sequence_number, j.item_id,
         i.item_code, i.name as item_name, j.quantity,
         j.work_id, w.work_code,
         j.source_reference, j.customer_name, j.status,
         j.due_date::text as due_date, j.completed_on::text as completed_on,
         j.cancellation_reason,
         (select count(*)::int from production_serials s
           where s.organisation_id = j.organisation_id and s.job_card_id = j.id)
           as manufactured_count,
         (select count(*)::int from production_dispatch_serials d
           where d.organisation_id = j.organisation_id and d.job_card_id = j.id)
           as dispatched_count,
         (select count(*)::int from production_bom_lines b
           where b.organisation_id = j.organisation_id and b.parent_item_id = j.item_id)
           as material_lines
  from production_job_cards j
  join production_items i
    on i.organisation_id = j.organisation_id and i.id = j.item_id
  left join works w on w.organisation_id = j.organisation_id and w.id = j.work_id
`;

function toSummary(row: JobCardRow): JobCardSummary {
  return {
    id: row.id,
    number: jobCardNumberOf(row.fy_label, row.sequence_number),
    sourceType: row.work_id === null ? 'private' : 'work',
    sourceReference: row.source_reference,
    workId: row.work_id,
    workCode: row.work_code,
    // Null on a Work-sourced card: `works` carries no party name, and
    // the view shows the Work code there instead of guessing one.
    customer: row.customer_name,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    quantity: row.quantity,
    manufactured: row.manufactured_count,
    dispatched: row.dispatched_count,
    materialLines: row.material_lines,
    status: row.status,
    dueDate: row.due_date,
    completedOn: row.completed_on,
    cancellationReason: row.cancellation_reason,
  };
}

// --- Bill-of-material explosion --------------------------------------------

interface BomRowShape {
  line_id: string;
  parent_line_id: string | null;
  depth: number;
  item_id: string;
  item_code: string;
  name: string;
  unit: string;
  quantity: string;
  effective_quantity: string;
  serial_controlled: boolean;
  has_children: boolean;
  pruned: boolean;
}

/**
 * The exploded bill of material below one item, flattened.
 *
 * Recursive in SQL rather than in a loop of round trips, and with a
 * CYCLE clause even though migration 0084's trigger refuses cycles:
 * belt-and-braces on a READ is free, and a read that could hang is worse
 * than one that returns a truncated tree. The depth bound is the
 * migration's own, read from the database so the two cannot drift.
 */
async function readBom(
  tx: TransactionSql,
  organisationId: string,
  rootItemId: string,
): Promise<{ readonly nodes: readonly BomNode[]; readonly truncated: boolean }> {
  const rows = await tx<BomRowShape[]>`
    with recursive explosion as (
      select line.id as line_id,
             null::uuid as parent_line_id,
             0 as depth,
             line.component_item_id as item_id,
             -- Cast out of the quantity_amount domain (0065): a
             -- recursive term multiplies to plain numeric, and
             -- PostgreSQL refuses a CTE whose two arms disagree on type.
             line.quantity::numeric as quantity,
             line.quantity::numeric as effective_quantity
      from production_bom_lines line
      where line.organisation_id = ${organisationId}
        and line.parent_item_id = ${rootItemId}
      union all
      select child.id,
             explosion.line_id,
             explosion.depth + 1,
             child.component_item_id,
             child.quantity::numeric,
             explosion.effective_quantity * child.quantity
      from production_bom_lines child
      join explosion on explosion.item_id = child.parent_item_id
      where child.organisation_id = ${organisationId}
        and explosion.depth + 1 < app_private.production_bom_max_depth()
    ) cycle item_id set is_cycle using path
    select explosion.line_id, explosion.parent_line_id, explosion.depth,
           explosion.item_id, item.item_code, item.name, item.unit,
           explosion.quantity::text as quantity,
           explosion.effective_quantity::text as effective_quantity,
           item.serial_controlled,
           exists (
             select 1 from production_bom_lines below
             where below.organisation_id = ${organisationId}
               and below.parent_item_id = explosion.item_id
           ) as has_children,
           -- This node sits at the cap AND has a bill of its own, so the
           -- walk stopped with children unread. The response says so
           -- rather than drawing half a bill and calling it the bill.
           (explosion.depth + 1 >= app_private.production_bom_max_depth()
            and exists (
              select 1 from production_bom_lines below
              where below.organisation_id = ${organisationId}
                and below.parent_item_id = explosion.item_id
            )) as pruned
    from explosion
    join production_items item
      on item.organisation_id = ${organisationId} and item.id = explosion.item_id
    where not explosion.is_cycle
    order by explosion.depth, item.name, explosion.line_id
  `;
  return {
    nodes: rows.map((row) => ({
      lineId: row.line_id,
      parentLineId: row.parent_line_id,
      depth: row.depth,
      itemId: row.item_id,
      itemCode: row.item_code,
      name: row.name,
      unit: row.unit,
      quantity: row.quantity,
      effectiveQuantity: row.effective_quantity,
      serialControlled: row.serial_controlled,
      hasChildren: row.has_children,
    })),
    truncated: rows.some((row) => row.pruned),
  };
}

/**
 * What the whole job card asks of each distinct part.
 *
 * The explosion is `app_private.production_bom_requirements`, which
 * aggregates per LEVEL rather than enumerating paths. The recursive CTE
 * that used to live here walked one row per path, so a bill of material
 * where two sub-assemblies share a part — the ordinary case, not a
 * pathological one — doubled its row count at every level the part
 * reappeared, and it ran on every read of a job card under that card's
 * row lock. A ten-level shared lattice measured 1022 rows against the
 * function's 18, for the same arithmetic.
 *
 * The multiplication by the planned quantity stays in SQL over
 * `numeric`; nothing here touches floating point (AGENTS.md rule 5).
 */
async function readMaterials(
  tx: TransactionSql,
  organisationId: string,
  itemId: string,
  quantity: number,
): Promise<readonly MaterialRequirement[]> {
  const rows = await tx<
    {
      item_id: string;
      item_code: string;
      name: string;
      unit: string;
      required: string;
      serial_controlled: boolean;
    }[]
  >`
    select requirement.item_id, item.item_code, item.name, item.unit,
           (requirement.quantity_per_unit * ${quantity})::text as required,
           item.serial_controlled
    from app_private.production_bom_requirements(${organisationId}, ${itemId})
      as requirement
    join production_items item
      on item.organisation_id = ${organisationId} and item.id = requirement.item_id
    order by item.name
  `;
  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    name: row.name,
    unit: row.unit,
    required: row.required,
    serialControlled: row.serial_controlled,
  }));
}

/**
 * The per-unit component slots: the serial-controlled parts at the TOP
 * level of the product's bill, and how many of each one unit takes.
 *
 * Top level only, and that is a real bound rather than an oversight. A
 * serial-controlled part nested inside a sub-assembly is consumed into
 * that SUB-ASSEMBLY, which is itself a manufactured item with a job card
 * and a genealogy of its own; recording it against the finished board
 * would put the same part in two units' records. The mock's own job card
 * filters top-level too (`item.bom.filter(n => n.serialControlled)`),
 * though by accident rather than by argument — its material explosion
 * recurses while its serial capture does not.
 */
async function readComponentSlots(
  tx: TransactionSql,
  organisationId: string,
  itemId: string,
): Promise<readonly ComponentSlot[]> {
  const rows = await tx<
    {
      component_item_id: string;
      item_code: string;
      name: string;
      required: number;
    }[]
  >`
    select line.component_item_id, item.item_code, item.name,
           ceil(line.quantity)::int as required
    from production_bom_lines line
    join production_items item
      on item.organisation_id = line.organisation_id
     and item.id = line.component_item_id
    where line.organisation_id = ${organisationId}
      and line.parent_item_id = ${itemId}
      and item.serial_controlled
    order by item.name
  `;
  return rows.map((row) => ({
    componentItemId: row.component_item_id,
    componentItemCode: row.item_code,
    name: row.name,
    required: row.required,
  }));
}

async function readSerials(
  tx: TransactionSql,
  organisationId: string,
  jobCardId: string,
): Promise<readonly FinishedSerial[]> {
  const units = await tx<
    {
      id: string;
      serial_number: string;
      dispatched_on: string | null;
      created_at: Date;
    }[]
  >`
    select s.id, s.serial_number, d.dispatched_on::text as dispatched_on,
           s.created_at
    from production_serials s
    left join production_dispatch_serials ds
      on ds.organisation_id = s.organisation_id and ds.production_serial_id = s.id
    left join production_dispatches d
      on d.organisation_id = ds.organisation_id and d.id = ds.production_dispatch_id
    where s.organisation_id = ${organisationId} and s.job_card_id = ${jobCardId}
    order by s.sequence_number
  `;
  if (units.length === 0) return [];
  const components = await tx<
    {
      id: string;
      finished_serial_id: string;
      component_item_id: string;
      item_code: string;
      name: string;
      serial_number: string;
    }[]
  >`
    select c.id, c.finished_serial_id, c.component_item_id,
           item.item_code, item.name, c.serial_number
    from production_component_serials c
    join production_items item
      on item.organisation_id = c.organisation_id and item.id = c.component_item_id
    where c.organisation_id = ${organisationId}
      and c.finished_serial_id in ${tx(units.map((unit) => unit.id))}
    order by item.name, c.serial_number
  `;
  return units.map((unit) => ({
    id: unit.id,
    serialNumber: unit.serial_number,
    dispatchedOn: unit.dispatched_on,
    components: components
      .filter((component) => component.finished_serial_id === unit.id)
      .map((component) => ({
        id: component.id,
        componentItemId: component.component_item_id,
        componentItemCode: component.item_code,
        componentName: component.name,
        serialNumber: component.serial_number,
      })),
    createdAt: unit.created_at.toISOString(),
  }));
}

async function readDispatches(
  tx: TransactionSql,
  organisationId: string,
  jobCardId: string,
  jobNumber: string,
): Promise<readonly Dispatch[]> {
  const rows = await tx<
    {
      id: string;
      sequence_number: number;
      dispatched_on: string;
      remarks: string | null;
      serial_numbers: string[];
      created_at: Date;
    }[]
  >`
    select d.id, d.sequence_number, d.dispatched_on::text as dispatched_on,
           d.remarks,
           coalesce(
             array_agg(s.serial_number order by s.sequence_number)
               filter (where s.id is not null),
             '{}'::text[]
           ) as serial_numbers,
           d.created_at
    from production_dispatches d
    left join production_dispatch_serials ds
      on ds.organisation_id = d.organisation_id and ds.production_dispatch_id = d.id
    left join production_serials s
      on s.organisation_id = ds.organisation_id and s.id = ds.production_serial_id
    where d.organisation_id = ${organisationId} and d.job_card_id = ${jobCardId}
    group by d.id
    order by d.sequence_number
  `;
  return rows.map((row) => ({
    id: row.id,
    number: dispatchNumberOf(jobNumber, row.sequence_number),
    dispatchedOn: row.dispatched_on,
    remarks: row.remarks,
    serialNumbers: row.serial_numbers,
    createdAt: row.created_at.toISOString(),
  }));
}

/** One job card and everything its four tabs render. */
async function readJobCardDetail(
  tx: TransactionSql,
  organisationId: string,
  jobCardId: string,
): Promise<JobCardDetail> {
  const [row] = await tx<JobCardRow[]>`
    ${tx.unsafe(JOB_CARD_SELECT)} where j.id = ${jobCardId}
  `;
  if (!row) {
    throw httpError(404, 'PRODUCTION_JOB_CARD_NOT_FOUND', 'No such job card.');
  }
  const summary = toSummary(row);
  const [materials, serials, slots, dispatches] = await Promise.all([
    readMaterials(tx, organisationId, row.item_id, row.quantity),
    readSerials(tx, organisationId, jobCardId),
    readComponentSlots(tx, organisationId, row.item_id),
    readDispatches(tx, organisationId, jobCardId, summary.number),
  ]);
  // Readiness comes from `app_private.production_job_card_dispatch_ready`,
  // the SAME expression the register's tile counts with. It used to be
  // computed here in TypeScript while the tile counted something else in
  // SQL, so a card could appear under "Dispatch ready" and then say
  // "Units outstanding" when opened — which is precisely the
  // self-contradiction `docs/UX.md` § 11b accuses the mock of.
  const [readiness] = await tx<{ ready: boolean }[]>`
    select app_private.production_job_card_dispatch_ready(
      ${organisationId}, ${jobCardId}
    ) as ready
  `;
  const dispatchReady = readiness?.ready ?? false;
  return {
    ...summary,
    materials: [...materials],
    serials: [...serials],
    componentSlots: [...slots],
    dispatches: [...dispatches],
    dispatchReady,
  };
}

// --- Work scope -------------------------------------------------------------

/**
 * The register's scope predicate, in one place because the list, the
 * counts and the cursor validation must all use the same one.
 *
 * A card with NO Work is organisation-wide, which is `docs/UX.md`
 * § Settled information architecture's rule for a document that belongs
 * to no Work — there is nowhere else for it to live and nobody it could
 * be scoped to. A card that names a Work follows the Work.
 */
function scopePredicate(
  tx: TransactionSql,
  full: boolean,
  userId: string,
): ReturnType<TransactionSql> {
  return tx`(
    ${full} or j.work_id is null or exists (
      select 1 from work_assignments wa
      where wa.work_id = j.work_id and wa.user_id = ${userId}
    )
  )`;
}

/**
 * Proves a cursor names a row of THIS register before it is used as a
 * position in it.
 *
 * `workScopedCursorRowId` in `pagination.ts` cannot serve here: it joins
 * `work_assignments` on the row's `work_id`, which is NULL for a private
 * order, so every organisation-wide card would fail validation. The
 * predicate below is the register's own, for the reason that module
 * states — a cursor validated more loosely than the rows it positions is
 * an existence oracle, and one paged with chosen cursors recovers the
 * sort key of a record the caller may not read.
 */
async function jobCardCursorRowId(
  tx: TransactionSql,
  cursor: string | undefined,
  full: boolean,
  userId: string,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select j.id from production_job_cards j
    where j.id = ${cursor} and ${scopePredicate(tx, full, userId)}
  `;
  if (!row) {
    throw httpError(
      400,
      'CURSOR_INVALID',
      'The pagination cursor does not name a row in this register.',
    );
  }
  return row.id;
}

// --- Routes -----------------------------------------------------------------

export function registerProductionRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // --- The item master ------------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/production/items',
      schema: {
        querystring: Type.Object(
          { includeRetired: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: { 200: ProductionItemListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) => {
      const includeRetired = request.query.includeRetired === true;
      return tenant(async (tx) => {
        const rows = await tx<ItemRow[]>`
          select ${tx.unsafe(ITEM_COLUMNS)}
          from production_items
          where (${includeRetired} or active)
          order by manufactured desc, lower(category), lower(name)
        `;
        return { items: rows.map(toItem) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/items',
      schema: {
        body: SaveProductionItemRequestSchema,
        response: { 201: ProductionItemSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const item = await tenant(async (tx) => {
        // Field validation runs INSIDE the bound transaction, not ahead
        // of it. `tenant()` is where membership is proven, so a refusal
        // raised before it would answer a non-member 400 and tell them
        // which field was wrong about an organisation they cannot reach
        // — which `route-inventory` refuses for every tenant route.
        const fields = itemFieldsOf(request.body);
        const [inserted] = await tx<ItemRow[]>`
          insert into production_items (
            organisation_id, item_code, name, category, unit, manufactured,
            serial_prefix, serial_controlled, specifications, created_by_user_id
          )
          values (
            ${organisationId}, ${fields.itemCode}, ${fields.name},
            ${fields.category}, ${fields.unit}, ${fields.manufactured},
            ${fields.serialPrefix}, ${fields.serialControlled},
            ${jsonb(tx, fields.specifications)}, ${user.id}
          )
          returning ${tx.unsafe(ITEM_COLUMNS)}
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) throw itemExists();
          return rethrowWriteRefusal(error);
        });
        if (!inserted) throw new Error('production item insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'production_item.created',
          'production_items',
          inserted.id,
          { itemCode: fields.itemCode, manufactured: fields.manufactured },
        );
        return toItem(inserted);
      });
      return reply.status(201).send(item);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/production/items/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveProductionItemRequestSchema,
        response: { 200: ProductionItemSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const fields = itemFieldsOf(request.body);
        const [updated] = await tx<ItemRow[]>`
          update production_items
          set item_code = ${fields.itemCode}, name = ${fields.name},
              category = ${fields.category}, unit = ${fields.unit},
              manufactured = ${fields.manufactured},
              serial_prefix = ${fields.serialPrefix},
              serial_controlled = ${fields.serialControlled},
              specifications = ${jsonb(tx, fields.specifications)}
          where id = ${id}
          returning ${tx.unsafe(ITEM_COLUMNS)}
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) throw itemExists();
          return rethrowWriteRefusal(error);
        });
        if (!updated) {
          throw httpError(404, 'PRODUCTION_ITEM_NOT_FOUND', 'No such production item.');
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'production_item.updated',
          'production_items',
          id,
          { itemCode: fields.itemCode, manufactured: fields.manufactured },
        );
        return toItem(updated);
      });
    },
  );

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/production/items/:id/active',
      schema: {
        params: IdParamsSchema,
        body: Type.Object({ active: Type.Boolean() }, { additionalProperties: false }),
        response: { 200: ProductionItemSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { active } = request.body;
      return tenant(async (tx) => {
        const [updated] = await tx<ItemRow[]>`
          update production_items set active = ${active}
          where id = ${id}
          returning ${tx.unsafe(ITEM_COLUMNS)}
        `.catch(rethrowWriteRefusal);
        if (!updated) {
          throw httpError(404, 'PRODUCTION_ITEM_NOT_FOUND', 'No such production item.');
        }
        await audit(
          tx,
          organisationId,
          user.id,
          active ? 'production_item.reactivated' : 'production_item.retired',
          'production_items',
          id,
          { itemCode: updated.item_code },
        );
        return toItem(updated);
      });
    },
  );

  // --- The bill of material -------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/production/items/:id/bom',
      schema: {
        params: IdParamsSchema,
        response: { 200: BomResponseSchema, ...errorResponses },
      },
    },
    async ({ request, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        await assertItemExists(tx, id);
        return await readBom(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/items/:id/bom',
      schema: {
        params: IdParamsSchema,
        body: SaveBomLineRequestSchema,
        response: { 201: BomResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const bom = await tenant(async (tx) => {
        await assertItemExists(tx, id);
        const [line] = await tx<{ id: string }[]>`
          insert into production_bom_lines (
            organisation_id, parent_item_id, component_item_id, quantity,
            created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${body.componentItemId}, ${body.quantity},
            ${user.id}
          )
          returning id
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'PRODUCTION_BOM_LINE_EXISTS',
              'This bill of material already names that component. Change the quantity on the existing line instead of adding a second one.',
            );
          }
          return rethrowWriteRefusal(error);
        });
        if (!line) throw new Error('bom line insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'production_bom_line.added',
          'production_bom_lines',
          line.id,
          { parentItemId: id, componentItemId: body.componentItemId },
        );
        return await readBom(tx, organisationId, id);
      });
      return reply.status(201).send(bom);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/production/bom-lines/:id',
      schema: {
        params: IdParamsSchema,
        body: Type.Object(
          { quantity: SaveBomLineRequestSchema.properties.quantity },
          { additionalProperties: false },
        ),
        response: { 200: BomResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { quantity } = request.body;
      return tenant(async (tx) => {
        const [updated] = await tx<{ parent_item_id: string }[]>`
          update production_bom_lines set quantity = ${quantity}
          where id = ${id}
          returning parent_item_id
        `.catch(rethrowWriteRefusal);
        if (!updated) throw bomLineNotFound();
        await audit(
          tx,
          organisationId,
          user.id,
          'production_bom_line.updated',
          'production_bom_lines',
          id,
          { quantity },
        );
        return await readBom(tx, organisationId, updated.parent_item_id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/production/bom-lines/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: BomResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [removed] = await tx<{ parent_item_id: string }[]>`
          delete from production_bom_lines where id = ${id}
          returning parent_item_id
        `;
        if (!removed) throw bomLineNotFound();
        await audit(
          tx,
          organisationId,
          user.id,
          'production_bom_line.removed',
          'production_bom_lines',
          id,
          { parentItemId: removed.parent_item_id },
        );
        return await readBom(tx, organisationId, removed.parent_item_id);
      });
    },
  );

  // --- The job-card register ------------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/production/job-cards',
      schema: {
        querystring: withKeysetQuery(JobCardListQuerySchema),
        response: { 200: JobCardListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const full = await hasFullWorkScope(tx, user.id);
        if (query.workId !== undefined) {
          await assertWorkAccess(tx, user.id, query.workId);
        }
        const scope = scopePredicate(tx, full, user.id);
        const cursorId = await jobCardCursorRowId(tx, query.cursor, full, user.id);
        const rows = await tx<JobCardRow[]>`
          ${tx.unsafe(JOB_CARD_SELECT)}
          where ${scope}
            and (${query.workId ?? null}::uuid is null or j.work_id = ${query.workId ?? null})
            and (${query.status ?? null}::text is null or j.status = ${query.status ?? null})
            and (${cursorId}::uuid is null or (j.due_date, j.id) > (
              select c.due_date, c.id from production_job_cards c
              where c.id = ${cursorId}))
          order by j.due_date, j.id
          limit ${sqlLimit(query.limit)}
        `;
        const page = keysetPage(rows, query.limit, (row) => row.id);
        // The tiles count the whole register, not the page: a keyset page
        // is a window, and a stat that changed as an operator paged would
        // be reporting the window rather than the workload.
        const [counts] = await tx<
          { open_count: number; in_production_count: number; ready_count: number }[]
        >`
          select
            count(*) filter (
              where j.status in ('planned', 'in_production'))::int as open_count,
            count(*) filter (where j.status = 'in_production')::int
              as in_production_count,
            count(*) filter (
              where app_private.production_job_card_dispatch_ready(
                j.organisation_id, j.id
              ))::int as ready_count
          from production_job_cards j
          where ${scope}
        `;
        return {
          jobCards: page.rows.map(toSummary),
          nextCursor: page.nextCursor,
          openCount: counts?.open_count ?? 0,
          inProductionCount: counts?.in_production_count ?? 0,
          dispatchReadyCount: counts?.ready_count ?? 0,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/production/job-cards/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const detail = await readJobCardDetail(tx, organisationId, id);
        if (detail.workId !== null) await assertWorkAccess(tx, user.id, detail.workId);
        return detail;
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/job-cards',
      schema: {
        body: CreateJobCardRequestSchema,
        response: { 201: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const detail = await tenant(async (tx) => {
        const sourceReference = trimmedField(
          body.sourceReference,
          1,
          200,
          'Name the schedule line or purchase order this job card is for.',
        );
        const customerName = optionalTrimmed(body.customerName);
        // Exactly one source. The database CHECK says the same thing;
        // this is the layer that says it in a sentence naming the field.
        if ((body.workId === undefined) === (customerName === undefined)) {
          throw httpError(
            400,
            'PRODUCTION_JOB_CARD_STATE_INVALID',
            'A job card serves either a Work or a private customer — name exactly one.',
          );
        }
        if (body.workId !== undefined) {
          await assertWorkWritable(
            tx,
            user.id,
            body.workId,
            'raising a job card against it',
          );
        }
        const fyLabel = financialYearLabel(await todayOf(tx, organisationId));
        // The house counter upsert (0001's challan counters): the number
        // is claimed without locking anything else, so two operators
        // raising cards at once serialise on the counter row alone.
        const [claimed] = await tx<{ sequence_number: number }[]>`
          insert into production_job_card_counters (
            organisation_id, fy_label, next_value
          )
          values (${organisationId}, ${fyLabel}, 2)
          on conflict (organisation_id, fy_label) do update
          set next_value = production_job_card_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!claimed) throw new Error('job card counter returned no row');
        const [created] = await tx<{ id: string }[]>`
          insert into production_job_cards (
            organisation_id, fy_label, sequence_number, item_id, quantity,
            work_id, source_reference, customer_name, due_date,
            created_by_user_id
          )
          values (
            ${organisationId}, ${fyLabel}, ${Number(claimed.sequence_number)},
            ${body.itemId}, ${body.quantity}, ${body.workId ?? null},
            ${sourceReference}, ${customerName ?? null}, ${body.dueDate},
            ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!created) throw new Error('job card insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'production_job_card.raised',
          'production_job_cards',
          created.id,
          {
            number: jobCardNumberOf(fyLabel, Number(claimed.sequence_number)),
            itemId: body.itemId,
            quantity: body.quantity,
          },
        );
        return readJobCardDetail(tx, organisationId, created.id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/production/job-cards/:id',
      schema: {
        params: IdParamsSchema,
        body: UpdateJobCardRequestSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const sourceReference = trimmedField(
          body.sourceReference,
          1,
          200,
          'Name the schedule line or purchase order this job card is for.',
        );
        await assertJobCardAccess(tx, user.id, id, 'revising a job card on it');
        const [updated] = await tx<{ id: string }[]>`
          update production_job_cards
          set quantity = ${body.quantity}, source_reference = ${sourceReference},
              due_date = ${body.dueDate}
          where id = ${id}
          returning id
        `.catch(rethrowWriteRefusal);
        if (!updated) throw jobCardNotFound();
        await audit(
          tx,
          organisationId,
          user.id,
          'production_job_card.revised',
          'production_job_cards',
          id,
          { quantity: body.quantity, dueDate: body.dueDate },
        );
        return readJobCardDetail(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/job-cards/:id/complete',
      schema: {
        params: IdParamsSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const card = await lockJobCard(tx, user.id, id, {
          operableFor: 'completing a job card on it',
        });
        if (card.status !== 'in_production') {
          throw httpError(
            409,
            'PRODUCTION_JOB_CARD_STATE_INVALID',
            `A job card is completed from in production, and this one is ${card.status}.`,
          );
        }
        const [made] = await tx<{ total: number }[]>`
          select count(*)::int as total from production_serials
          where job_card_id = ${id}
        `;
        const total = made?.total ?? 0;
        if (total < card.quantity) {
          throw httpError(
            409,
            'PRODUCTION_JOB_CARD_INCOMPLETE',
            `${String(total)} of ${String(card.quantity)} units have been serialised. Serialise the rest, or reduce the planned quantity to what was built.`,
          );
        }
        await tx`
          update production_job_cards
          set status = 'completed',
              completed_on = app_private.organisation_today(${organisationId})
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'production_job_card.completed',
          'production_job_cards',
          id,
          { units: total },
        );
        return readJobCardDetail(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/job-cards/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelJobCardRequestSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const reason = trimmedField(
          request.body.reason,
          3,
          500,
          'Say why the job card is being cancelled, in at least three characters.',
        );
        const card = await lockJobCard(tx, user.id, id);
        if (card.status === 'completed' || card.status === 'cancelled') {
          throw httpError(
            409,
            'PRODUCTION_JOB_CARD_STATE_INVALID',
            `Job card ${card.number} is already ${card.status}.`,
          );
        }
        await tx`
          update production_job_cards
          set status = 'cancelled', cancellation_reason = ${reason}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'production_job_card.cancelled',
          'production_job_cards',
          id,
          { reason },
        );
        return readJobCardDetail(tx, organisationId, id);
      });
    },
  );

  // --- Serials --------------------------------------------------------------

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/job-cards/:id/serials',
      schema: {
        params: IdParamsSchema,
        response: { 201: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        const card = await lockJobCard(tx, user.id, id, {
          operableFor: 'recording a unit on it',
        });
        if (card.status === 'completed' || card.status === 'cancelled') {
          throw httpError(
            409,
            'PRODUCTION_JOB_CARD_STATE_INVALID',
            `Job card ${card.number} is ${card.status} and produces no more units.`,
          );
        }
        const [made] = await tx<{ total: number }[]>`
          select count(*)::int as total from production_serials
          where job_card_id = ${id}
        `;
        if ((made?.total ?? 0) >= card.quantity) {
          throw httpError(
            409,
            'PRODUCTION_QUANTITY_EXCEEDED',
            `Job card ${card.number} has already produced its planned ${String(card.quantity)} units.`,
          );
        }
        const [item] = await tx<{ serial_prefix: string | null }[]>`
          select serial_prefix from production_items where id = ${card.itemId}
        `;
        if (!item?.serial_prefix) {
          throw httpError(
            409,
            'PRODUCTION_ITEM_INVALID',
            'The item has no serial series, so no unit can be named.',
          );
        }
        // The counter is the item's, not the job card's: the series runs
        // across every card that ever built this product, which is what
        // makes a serial identify a unit rather than a unit-of-a-batch.
        const [claimed] = await tx<{ sequence_number: number }[]>`
          insert into production_serial_counters (
            organisation_id, production_item_id, next_value
          )
          values (${organisationId}, ${card.itemId}, 2)
          on conflict (organisation_id, production_item_id) do update
          set next_value = production_serial_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!claimed) throw new Error('serial counter returned no row');
        const sequence = Number(claimed.sequence_number);
        const serialNumber = `${item.serial_prefix}-${String(sequence).padStart(5, '0')}`;
        const [unit] = await tx<{ id: string }[]>`
          insert into production_serials (
            organisation_id, job_card_id, item_id, serial_number,
            sequence_number, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${card.itemId}, ${serialNumber},
            ${sequence}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!unit) throw new Error('production serial insert returned no row');
        // The first unit is what moves the card into production. A
        // separate control for it would be a button that says "I am
        // about to start" next to the act of starting.
        if (card.status === 'planned') {
          await tx`
            update production_job_cards set status = 'in_production' where id = ${id}
          `.catch(rethrowWriteRefusal);
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'production_serial.recorded',
          'production_serials',
          unit.id,
          { jobCardId: id, serialNumber },
        );
        return readJobCardDetail(tx, organisationId, id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/production/serials/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [unit] = await tx<{ job_card_id: string; serial_number: string }[]>`
          select job_card_id, serial_number from production_serials
          where id = ${id}
        `;
        if (!unit) {
          throw httpError(404, 'PRODUCTION_SERIAL_NOT_FOUND', 'No such unit.');
        }
        await lockJobCard(tx, user.id, unit.job_card_id, {
          operableFor: 'recording units on it',
        });
        // The unit's number is NOT released: the counter never rewinds,
        // because the label was already printed.
        await tx`
          delete from production_serials where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'production_serial.removed',
          'production_serials',
          id,
          { jobCardId: unit.job_card_id, serialNumber: unit.serial_number },
        );
        return readJobCardDetail(tx, organisationId, unit.job_card_id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/serials/:id/components',
      schema: {
        params: IdParamsSchema,
        body: RecordComponentSerialRequestSchema,
        response: { 201: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const detail = await tenant(async (tx) => {
        const serialNumber = trimmedField(
          body.serialNumber,
          1,
          100,
          'Scan or type the component serial.',
        );
        const [unit] = await tx<{ job_card_id: string }[]>`
          select job_card_id from production_serials where id = ${id}
        `;
        if (!unit) {
          throw httpError(404, 'PRODUCTION_SERIAL_NOT_FOUND', 'No such unit.');
        }
        await lockJobCard(tx, user.id, unit.job_card_id, {
          operableFor: 'recording units on it',
        });
        const [recorded] = await tx<{ id: string }[]>`
          insert into production_component_serials (
            organisation_id, finished_serial_id, component_item_id,
            serial_number, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${body.componentItemId}, ${serialNumber},
            ${user.id}
          )
          returning id
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'PRODUCTION_COMPONENT_SERIAL_EXISTS',
              `Component serial ${serialNumber} is already recorded inside another unit. One physical part cannot be in two places.`,
            );
          }
          return rethrowWriteRefusal(error);
        });
        if (!recorded) throw new Error('component serial insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'production_component_serial.consumed',
          'production_component_serials',
          recorded.id,
          { finishedSerialId: id, serialNumber },
        );
        return readJobCardDetail(tx, organisationId, unit.job_card_id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/production/component-serials/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [row] = await tx<{ job_card_id: string; serial_number: string }[]>`
          select s.job_card_id, c.serial_number
          from production_component_serials c
          join production_serials s
            on s.organisation_id = c.organisation_id and s.id = c.finished_serial_id
          where c.id = ${id}
        `;
        if (!row) {
          throw httpError(
            404,
            'PRODUCTION_COMPONENT_SERIAL_NOT_FOUND',
            'No such component record.',
          );
        }
        await lockJobCard(tx, user.id, row.job_card_id, {
          operableFor: 'recording units on it',
        });
        await tx`
          delete from production_component_serials where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'production_component_serial.removed',
          'production_component_serials',
          id,
          { serialNumber: row.serial_number },
        );
        return readJobCardDetail(tx, organisationId, row.job_card_id);
      });
    },
  );

  // --- Despatch: the boundary Inventory consumes ----------------------------

  tenantRoute(
    {
      method: 'POST',
      url: '/api/production/job-cards/:id/dispatches',
      schema: {
        params: IdParamsSchema,
        body: CreateDispatchRequestSchema,
        response: { 201: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const detail = await tenant(async (tx) => {
        const remarks = optionalTrimmed(body.remarks);
        const card = await lockJobCard(tx, user.id, id, {
          operableFor: 'releasing units on it',
        });
        if (card.status === 'cancelled') {
          throw httpError(
            409,
            'PRODUCTION_DISPATCH_INVALID',
            `Job card ${card.number} is cancelled and releases nothing.`,
          );
        }
        const today = await todayOf(tx, organisationId);
        if (body.dispatchedOn > today) {
          throw httpError(
            400,
            'PRODUCTION_DISPATCH_INVALID',
            'A despatch cannot be dated in the future.',
          );
        }
        const serialIds = [...new Set(body.serialIds)];
        // Every named unit must belong to THIS card and still be in the
        // factory. The composite keys refuse the first on insert anyway;
        // asking here is what turns a foreign-key error into a sentence
        // naming how many units were wrong.
        const [eligible] = await tx<{ total: number }[]>`
          select count(*)::int as total
          from production_serials s
          where s.id in ${tx(serialIds)}
            and s.job_card_id = ${id}
            and not exists (
              select 1 from production_dispatch_serials d
              where d.organisation_id = s.organisation_id
                and d.production_serial_id = s.id
            )
        `;
        if ((eligible?.total ?? 0) !== serialIds.length) {
          throw httpError(
            409,
            'PRODUCTION_DISPATCH_INVALID',
            'Some of the named units do not belong to this job card, or have already left the factory.',
          );
        }
        // A unit still owing a component serial its bill of material
        // calls for is not finished, and letting it leave would close its
        // component record with the record incomplete.
        const [incomplete] = await tx<{ total: number }[]>`
          select count(*)::int as total
          from production_serials s
          join production_bom_lines line
            on line.organisation_id = s.organisation_id
           and line.parent_item_id = s.item_id
          join production_items component
            on component.organisation_id = line.organisation_id
           and component.id = line.component_item_id
          where s.id in ${tx(serialIds)}
            and component.serial_controlled
            and (
              select count(*) from production_component_serials c
              where c.organisation_id = s.organisation_id
                and c.finished_serial_id = s.id
                and c.component_item_id = line.component_item_id
            ) < ceil(line.quantity)
        `;
        if ((incomplete?.total ?? 0) > 0) {
          throw httpError(
            409,
            'PRODUCTION_DISPATCH_INVALID',
            'Some of the named units are still missing component serials their bill of material calls for.',
          );
        }
        const [claimed] = await tx<{ sequence_number: number }[]>`
          insert into production_dispatch_counters (
            organisation_id, job_card_id, next_value
          )
          values (${organisationId}, ${id}, 2)
          on conflict (organisation_id, job_card_id) do update
          set next_value = production_dispatch_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!claimed) throw new Error('dispatch counter returned no row');
        const [dispatch] = await tx<{ id: string }[]>`
          insert into production_dispatches (
            organisation_id, job_card_id, sequence_number, dispatched_on,
            remarks, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${Number(claimed.sequence_number)},
            ${body.dispatchedOn}, ${remarks ?? null}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!dispatch) throw new Error('dispatch insert returned no row');
        await tx`
          insert into production_dispatch_serials (
            organisation_id, production_dispatch_id, production_serial_id,
            job_card_id
          )
          select ${organisationId}, ${dispatch.id}, s.id, ${id}
          from production_serials s
          where s.id in ${tx(serialIds)}
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'PRODUCTION_DISPATCH_INVALID',
              'One of the named units left the factory while this release was being recorded.',
            );
          }
          return rethrowWriteRefusal(error);
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'production_dispatch.released',
          'production_dispatches',
          dispatch.id,
          {
            number: dispatchNumberOf(card.number, Number(claimed.sequence_number)),
            units: serialIds.length,
          },
        );
        return readJobCardDetail(tx, organisationId, id);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/production/dispatches/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: JobCardDetailSchema, ...errorResponses },
      },
      role: 'evidence',
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [dispatch] = await tx<{ job_card_id: string }[]>`
          select job_card_id from production_dispatches where id = ${id}
        `;
        if (!dispatch) {
          throw httpError(404, 'PRODUCTION_DISPATCH_NOT_FOUND', 'No such despatch.');
        }
        await lockJobCard(tx, user.id, dispatch.job_card_id, {
          operableFor: 'withdrawing a release on it',
        });

        // Inventory's ledger has taken these units onto a shelf, so the
        // release is no longer production's alone to withdraw (0087).
        //
        // The foreign key below refuses this delete anyway — that is what
        // § 7 promised, and it still holds against every writer. What it
        // cannot do is SAY anything: a 23503 reaches the operator as a
        // bare conflict with no remedy, on the one screen where the
        // remedy is the whole answer. Naming it here is what makes
        // STOCK_DISPATCH_RECEIVED's advice reachable from the path that
        // earns it.
        const [received] = await tx<{ id: string }[]>`
          select id from stock_movements where production_dispatch_id = ${id}
        `;
        if (received) {
          throw httpError(
            409,
            'STOCK_DISPATCH_RECEIVED',
            'These units are already on a stock shelf, so this release cannot be withdrawn. Correct the quantity with a stock adjustment instead.',
          );
        }

        // Lines first: nothing cascades, deliberately. Inventory's stock
        // ledger references the header (migration 0084 § 7), and that
        // foreign key is what refuses this delete when the check above
        // loses a race; a cascade would have quietly taken the ledger's
        // anchor with it.
        await tx`
          delete from production_dispatch_serials where production_dispatch_id = ${id}
        `.catch(rethrowWriteRefusal);
        await tx`
          delete from production_dispatches where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'production_dispatch.withdrawn',
          'production_dispatches',
          id,
          { jobCardId: dispatch.job_card_id },
        );
        return readJobCardDetail(tx, organisationId, dispatch.job_card_id);
      });
    },
  );
}

// --- Shared refusals and small helpers --------------------------------------

function itemExists(): Error {
  return httpError(
    409,
    'PRODUCTION_ITEM_EXISTS',
    'Another item already carries this part number or serial series. A retired item keeps both, because the code is printed on labels.',
  );
}

function bomLineNotFound(): Error {
  return httpError(
    404,
    'PRODUCTION_BOM_LINE_NOT_FOUND',
    'No such bill-of-material line.',
  );
}

function jobCardNotFound(): Error {
  return httpError(404, 'PRODUCTION_JOB_CARD_NOT_FOUND', 'No such job card.');
}

/** Trims the request's strings and settles the manufactured item's
 * implied fields, so the CHECK in migration 0084 is met by a route that
 * said why rather than by a 23514 the caller reads as a 500. */
/**
 * A trust-boundary string, trimmed AND length-checked against the shape
 * its column allows.
 *
 * `requireTrimmed` refuses a value of nothing but spaces, which is not
 * the whole of the problem: a schema's `minLength: 2` is measured BEFORE
 * trimming, so `' a '` passes the contract, reaches the column as `'a'`,
 * and the CHECK refuses it as a 23514 the caller reads as a 500. The
 * bound is re-applied here, on the trimmed value, which is the value the
 * column will actually see.
 */
function trimmedField(
  value: string,
  min: number,
  max: number,
  refusal: string,
): string {
  const trimmed = requireTrimmed(value, refusal);
  if (trimmed.length < min || trimmed.length > max) {
    throw httpError(400, 'FIELD_TOO_SHORT', refusal);
  }
  return trimmed;
}

function itemFieldsOf(body: {
  itemCode: string;
  name: string;
  category: string;
  unit: string;
  manufactured: boolean;
  serialPrefix?: string;
  serialControlled?: boolean;
  specifications?: readonly ProductionSpecification[];
}): {
  itemCode: string;
  name: string;
  category: string;
  unit: string;
  manufactured: boolean;
  serialPrefix: string | null;
  serialControlled: boolean;
  specifications: readonly ProductionSpecification[];
} {
  const serialPrefix = optionalTrimmed(body.serialPrefix)?.toUpperCase();
  if (body.manufactured && serialPrefix === undefined) {
    throw httpError(
      400,
      'PRODUCTION_ITEM_INVALID',
      'A manufactured item needs a serial series, because every unit it produces is named from it.',
    );
  }
  // Trimmed and then bounded, for the reason `trimmedField` states: the
  // jsonb CHECK measures the stored value, and a blank pair is dropped
  // rather than refused because the form leaves one behind whenever an
  // operator adds a row and changes their mind.
  const specifications = (body.specifications ?? [])
    .map((spec) => ({ attribute: spec.attribute.trim(), value: spec.value.trim() }))
    .filter((spec) => spec.attribute.length > 0 && spec.value.length > 0)
    .map((spec) => ({
      attribute: spec.attribute.slice(0, 100),
      value: spec.value.slice(0, 200),
    }));
  return {
    itemCode: trimmedField(
      body.itemCode,
      2,
      40,
      'Give the item a part number of two to forty characters.',
    ).toUpperCase(),
    name: trimmedField(
      body.name,
      2,
      200,
      'Give the item a name of at least two characters.',
    ),
    category: trimmedField(
      body.category,
      2,
      100,
      'Give the item a category of at least two characters.',
    ),
    unit: trimmedField(body.unit, 1, 20, 'Give the item a unit.'),
    manufactured: body.manufactured,
    serialPrefix: serialPrefix ?? null,
    // A manufactured item is always serial controlled: the CHECK in
    // migration 0084 binds the two, and a job card that produced
    // unnameable units would be a job card that produced nothing.
    serialControlled: body.manufactured || body.serialControlled === true,
    specifications,
  };
}

async function assertItemExists(tx: TransactionSql, itemId: string): Promise<void> {
  const [item] = await tx<{ id: string }[]>`
    select id from production_items where id = ${itemId}
  `;
  if (!item) {
    throw httpError(404, 'PRODUCTION_ITEM_NOT_FOUND', 'No such production item.');
  }
}

interface LockedJobCard {
  readonly id: string;
  readonly number: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly status: JobCardStatus;
}

/**
 * Reads a job card under its own row lock, after proving the caller may
 * reach the Work it serves.
 *
 * The lock is what makes every count taken afterwards hold: the planned
 * quantity is a ceiling on units, and two operators serialising the last
 * unit at the same moment would otherwise both read the same count. The
 * trigger in migration 0084 takes the same lock, so the two layers
 * queue in the same order rather than deadlocking against each other.
 */
async function lockJobCard(
  tx: TransactionSql,
  userId: string,
  jobCardId: string,
  options: { readonly operableFor?: string } = {},
): Promise<LockedJobCard> {
  const [card] = await tx<
    {
      id: string;
      fy_label: string;
      sequence_number: number;
      item_id: string;
      quantity: number;
      status: JobCardStatus;
      work_id: string | null;
    }[]
  >`
    select id, fy_label, sequence_number, item_id, quantity, status, work_id
    from production_job_cards
    where id = ${jobCardId}
    for update
  `;
  if (!card) throw jobCardNotFound();
  // Reading a card is not writing to it, so the operable check belongs to
  // the callers that mutate — `lockJobCard` is taken by the detail read
  // too. Access is proved either way.
  if (card.work_id !== null) {
    if (options.operableFor === undefined) {
      await assertWorkAccess(tx, userId, card.work_id);
    } else {
      await assertWorkWritable(tx, userId, card.work_id, options.operableFor);
    }
  }
  return {
    id: card.id,
    number: jobCardNumberOf(card.fy_label, card.sequence_number),
    itemId: card.item_id,
    quantity: card.quantity,
    status: card.status,
  };
}

async function assertJobCardAccess(
  tx: TransactionSql,
  userId: string,
  jobCardId: string,
  operableFor: string,
): Promise<void> {
  await lockJobCard(tx, userId, jobCardId, { operableFor });
}
