import {
  GstRateSchema,
  HsnCodeSchema,
  PAYMENT_MATRIX_CATEGORIES,
  PaymentMatrixResponseSchema,
  PaymentMatrixRowSchema,
  PaymentSetupResponseSchema,
  SavePaymentSetupRequestSchema,
  SetWorkItemPaymentCategoryRequestSchema,
  UpsertPaymentMatrixRowRequestSchema,
  UuidSchema,
  WorkItemPaymentCategoryResponseSchema,
  type PaymentMatrixCategory,
  type PaymentMatrixRow,
  type SetWorkItemPaymentCategoryRequest,
  type UpsertPaymentMatrixRowRequest,
} from '@auto-mb/contracts';
import { parseDecimalToMinorUnits } from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { auditDiff } from '../audit-diff.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { assertWorkOperable } from '../work-status.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Milestone 8 phase 1: the per-Work payment matrix and item category
 * assignment (legacy spec §8, rule R10; ADR-0006 decision 5).
 *
 * The matrix is per-Work payment CONFIGURATION, not an issued document:
 * rows upsert (last write wins under a row lock) and delete freely,
 * because every finalised Measurement Book snapshots the category and
 * percentages it billed with — configuration edits never alter a
 * finalised record. Per R10 there is deliberately no per-item
 * percentage entry.
 *
 * The item's category itself is likewise payment configuration, not
 * the contract baseline (quantities/rates/descriptions), so its edit
 * route runs under the writer role rather than the amendment approval
 * engine, with a full before/after audit trail.
 */

const MatrixParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
    category: Type.String({ pattern: '^[A-Z_]{1,40}$' }),
  },
  { additionalProperties: false },
);

interface MatrixRowRecord {
  id: string;
  work_id: string;
  category: PaymentMatrixCategory;
  pct_supply: string;
  pct_installation: string;
  pct_pac: string;
  pct_final_bill: string;
  category_label: string | null;
  created_at: Date;
  updated_at: Date;
}

function toMatrixRow(row: MatrixRowRecord): PaymentMatrixRow {
  return {
    id: row.id,
    workId: row.work_id,
    category: row.category,
    pctSupply: row.pct_supply,
    pctInstallation: row.pct_installation,
    pctPac: row.pct_pac,
    pctFinalBill: row.pct_final_bill,
    categoryLabel: row.category_label,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function assertMatrixCategory(raw: string): PaymentMatrixCategory {
  if (!(PAYMENT_MATRIX_CATEGORIES as readonly string[]).includes(raw)) {
    throw httpError(
      400,
      'PAYMENT_MATRIX_CATEGORY_INVALID',
      `Unknown payment category ${raw}. Valid categories: ${PAYMENT_MATRIX_CATEGORIES.join(', ')}.`,
    );
  }
  return raw as PaymentMatrixCategory;
}

const STAGE_FIELDS = [
  ['pctSupply', 'supply'],
  ['pctInstallation', 'installation'],
  ['pctPac', 'PAC'],
  ['pctFinalBill', 'final bill'],
] as const;

/** Validates the four stage percentages in exact integer minor units
 * (scale 2, i.e. hundredths of a percent) — never floats. Each must be
 * 0–100 with at most two decimals, and the four must sum to exactly
 * 100 (R10). Returns nothing; throws the friendly 400 the matrix
 * editor surfaces inline. The database CHECKs hold the same invariants
 * against every writer. */
function assertPercentagesSumTo100(body: UpsertPaymentMatrixRowRequest): void {
  let total = 0n;
  for (const [field, label] of STAGE_FIELDS) {
    const minor = parseDecimalToMinorUnits(body[field], 2);
    if (minor === null || minor < 0n || minor > 10000n) {
      throw httpError(
        400,
        'PAYMENT_MATRIX_PERCENTAGE_INVALID',
        `The ${label} percentage must be between 0 and 100 with at most two decimal places.`,
      );
    }
    total += minor;
  }
  if (total !== 10000n) {
    throw httpError(
      400,
      'PAYMENT_MATRIX_SUM_INVALID',
      'The four stage percentages (supply, installation, PAC, final bill) must sum to exactly 100.',
    );
  }
}

/**
 * The AMC row's extra rule (migration 0068), stated where the operator
 * can act on it.
 *
 * An AMC item takes no Delivery Challan line and no installation record,
 * so its supply and installation stage deltas are permanently zero and
 * any percentage on either would bill nothing, forever. The database
 * CHECK `payment_matrices_amc_bills_on_certification` holds this against
 * every writer; this function is the same rule said in the operator's
 * vocabulary and BEFORE the write, because a raw constraint violation
 * reaches the screen as an opaque 500 with a constraint name in it.
 *
 * Shared by the per-row upsert and by the initial matrix submitted at
 * LOA confirmation, so the two cannot drift.
 */
export function assertAmcStagePercentages(
  category: string,
  row: UpsertPaymentMatrixRowRequest,
): void {
  if (category !== 'AMC') return;
  const offending = (
    [
      ['pctSupply', 'supply'],
      ['pctInstallation', 'installation'],
    ] as const
  ).filter(([field]) => parseDecimalToMinorUnits(row[field], 2) !== 0n);
  if (offending.length === 0) return;
  throw httpError(
    400,
    'PAYMENT_MATRIX_AMC_STAGE_INVALID',
    `The ${offending
      .map(([, label]) => label)
      .join(
        ' and ',
      )} percentage${offending.length > 1 ? 's' : ''} of the AMC row must be 0. Annual maintenance is certified rather than delivered or installed, so those two stages can never carry a quantity and value placed on them could never be billed. Put the AMC row's 100 on the PAC and final-bill stages.`,
  );
}

interface BilledLineRecord {
  work_item_id: string;
  id: string;
  mb_number: string | null;
}

/** One item whose category the caller is about to move, already locked
 * and read. The three guards below all speak about a SET of these,
 * because the payment-setup save changes many at once and a guard that
 * ran per item would be one round trip per item. */
interface ItemUnderChange {
  readonly id: string;
  readonly itemNumber: string;
}

/**
 * The first item, in item-number order, that a guard's rows implicate —
 * and every row belonging to it.
 *
 * A set-based guard finds every offender in one query, but a refusal
 * names ONE item, with its own records in it, exactly as the per-item
 * route always did. Item-number order makes the choice deterministic:
 * the same request refuses with the same sentence every time, rather
 * than with whichever row the planner returned first.
 */
function firstOffender<T extends { work_item_id: string }>(
  items: readonly ItemUnderChange[],
  rows: readonly T[],
): { readonly item: ItemUnderChange; readonly rows: readonly T[] } | undefined {
  if (rows.length === 0) return undefined;
  const implicated = new Set(rows.map((row) => row.work_item_id));
  const item = [...items]
    .filter((candidate) => implicated.has(candidate.id))
    .sort((left, right) => left.itemNumber.localeCompare(right.itemNumber))[0];
  if (item === undefined) return undefined;
  return { item, rows: rows.filter((row) => row.work_item_id === item.id) };
}

/**
 * An item's payment category is frozen once a Measurement Book has
 * BILLED it (legacy spec §8, rule R10; ADR-0006 decisions 3 and 5).
 *
 * The Measurement Book engine reads the item's CURRENT category and
 * resolves the CURRENT matrix row at both preview and finalize, and the
 * only memory it carries forward is prior STAGE QUANTITY — there is no
 * prior-value or prior-percentage memory. Re-categorising a billed item
 * therefore re-opens stages the earlier bill already paid: an item paid
 * in full through a SUPPLY row of 100/0/0/0, flipped to
 * SUPPLY_AND_INSTALLATION at 60/30/5/5, bills its installation stage a
 * second time on the next MB and overruns the item's own value.
 *
 * The bar is BILLING, not evidence. Mis-categorised items are ordinary
 * on a fresh Work and correcting them stays free — including after
 * deliveries, installations and PAC certificates have been recorded —
 * right up to the first Measurement Book that bills the item. Clearing
 * a billed item back to uncategorised, and categorising a billed item
 * that was billed while uncategorised, carry the identical hazard and
 * are refused the same way; the remedy for both is the one the product
 * already uses for a wrong finalised bill (ADR-0006 decision 3), a
 * compensating entry on a subsequent MB.
 *
 * The evidence predicate is the one the 0030 omission guard already
 * uses: a line on a non-cancelled Measurement Book carrying a non-zero
 * delta or prior. A finalised MB writes one line per item of the Work,
 * including all-zero lines for the items it did not bill, so the line
 * alone is not billing.
 */
async function assertItemsNotBilled(
  tx: TransactionSql,
  items: readonly ItemUnderChange[],
): Promise<void> {
  if (items.length === 0) return;
  const billed = await tx<BilledLineRecord[]>`
    select mbl.work_item_id, mb.id, mb.mb_number
    from measurement_book_lines mbl
    join measurement_books mb on mb.id = mbl.measurement_book_id
    where mbl.work_item_id = any(${items.map((item) => item.id)}::uuid[])
      and mb.status <> 'cancelled'
      and (
        mbl.delta_supplied <> 0 or mbl.delta_installed <> 0
        or mbl.delta_pac <> 0 or mbl.delta_final_bill <> 0
        or mbl.prior_supplied <> 0 or mbl.prior_installed <> 0
        or mbl.prior_pac <> 0 or mbl.prior_final_bill <> 0
      )
    order by mb.mb_number
  `;
  const offender = firstOffender(items, billed);
  if (offender === undefined) return;
  const { item, rows } = offender;
  const names = rows.map((row) => row.mb_number ?? row.id);
  throw httpError(
    409,
    'ITEM_BILLED_IN_MB',
    `Item ${item.itemNumber} is already billed in Measurement Book${names.length > 1 ? 's' : ''} ${names.join(', ')}, so its payment category can no longer be changed — that Measurement Book billed with the category and stage percentages in force at the time, and changing them now would bill stages a second time. Correct the billed amount with a compensating entry on the next Measurement Book instead.`,
    {
      workItemId: item.id,
      itemNumber: item.itemNumber,
      billedMeasurementBooks: rows.map((row) => ({
        id: row.id,
        mbNumber: row.mb_number,
      })),
    },
  );
}

/**
 * Refuses moving an item INTO the AMC category while any Delivery
 * Challan line or installation record names it (migration 0068).
 *
 * The AMC category asserts a structural fact about the item — annual
 * maintenance is served and certified, never delivered and never
 * installed — and the database enforces it going forward with two
 * triggers. Neither trigger can speak about rows already written, so an
 * item that HAS moved would land in a state the schema forbids and the
 * completion predicate cannot read honestly: it would owe certified
 * quantity while carrying delivered quantity that nothing measures any
 * more. The remedy is to cancel the movement, not to relabel it, so the
 * refusal names each holding document.
 *
 * Cancelled challans and cancelled installations do not count. They
 * released their quantities, so the item has moved nothing.
 */
async function assertItemsHaveNoMovement(
  tx: TransactionSql,
  items: readonly ItemUnderChange[],
): Promise<void> {
  if (items.length === 0) return;
  const ids = items.map((item) => item.id);
  const movement = await tx<{ work_item_id: string; kind: string; label: string }[]>`
    select dci.work_item_id, 'delivery_challan' as kind,
           coalesce(dc.challan_number, dc.id::text) as label
    from delivery_challan_items dci
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    where dci.work_item_id = any(${ids}::uuid[]) and dc.status <> 'cancelled'
    union all
    select i.work_item_id, 'installation', i.installed_on::text
    from installations i
    where i.work_item_id = any(${ids}::uuid[]) and i.status = 'recorded'
    order by 2, 3
  `;
  const offender = firstOffender(items, movement);
  if (offender === undefined) return;
  const { item, rows } = offender;
  throw httpError(
    409,
    'ITEM_HAS_MOVEMENT',
    `Item ${item.itemNumber} cannot become an AMC item: annual maintenance is certified rather than delivered or installed, and this item already carries movement — ${nameFirst(
      rows.map((row) =>
        row.kind === 'delivery_challan'
          ? `delivery challan ${row.label}`
          : `installation dated ${row.label}`,
      ),
    )}. Cancel those records first if the item really is a maintenance schedule.`,
    { workItemId: item.id, itemNumber: item.itemNumber },
  );
}

/**
 * Refuses moving an item OUT of the AMC category while any non-cancelled
 * acceptance certificate names it — the symmetric half of
 * `assertItemHasNoMovement`.
 *
 * An AMC item certifies against its SANCTIONED quantity; every other
 * category certifies against its INSTALLED total (R18, migration 0068).
 * An AMC item can therefore be legitimately certified up to its full
 * sanctioned quantity with nothing installed at all, and relabelling it
 * afterwards leaves certified far above installed — a state R18 exists
 * to make unreachable. The consequences are not cosmetic: the PAC screen
 * reports a NEGATIVE available quantity, further certificates are capped
 * against a ceiling the item has already passed, the certified
 * quantities start billing through the new category's own PAC stage
 * percentage with nothing installed behind them, and the completion
 * predicate silently changes which dimension it measures the item on.
 *
 * `assertItemNotBilled` does not cover this. It refuses a category
 * change once a Measurement Book has billed the item, but certificates
 * are recorded long before they are billed, and the whole window between
 * is unguarded without this.
 *
 * The remedy is to cancel the certificates — which releases their
 * quantities — not to relabel around them, so the refusal names them.
 */
async function assertItemsHaveNoCertification(
  tx: TransactionSql,
  items: readonly ItemUnderChange[],
): Promise<void> {
  if (items.length === 0) return;
  const certificates = await tx<
    { work_item_id: string; reference: string; certified: string }[]
  >`
    select pci.work_item_id, pc.reference,
           pci.certified_quantity::text as certified
    from pac_certificate_items pci
    join pac_certificates pc on pc.id = pci.pac_certificate_id
    where pci.work_item_id = any(${items.map((item) => item.id)}::uuid[])
      and pc.status = 'recorded'
    order by pc.reference
  `;
  const offender = firstOffender(items, certificates);
  if (offender === undefined) return;
  const { item, rows } = offender;
  throw httpError(
    409,
    'ITEM_HAS_CERTIFICATION',
    `Item ${item.itemNumber} cannot leave the AMC category: it is certified against its sanctioned quantity, which only a maintenance item may be, and moving it would leave more certified than installed — ${nameFirst(
      rows.map((row) => `certificate ${row.reference} for ${row.certified}`),
    )}. Cancel those certificates first, which releases their quantities.`,
    { workItemId: item.id, itemNumber: item.itemNumber },
  );
}

/**
 * Names at most the first three records and counts the rest.
 *
 * A refusal has to be readable in a toast. An item with sixty
 * certificates against it would otherwise produce a sentence no operator
 * finishes, and the first few plus a total say the same thing — the same
 * shape `amendments.ts` uses for its own record enumerations.
 */
function nameFirst(labels: readonly string[]): string {
  const shown = labels.slice(0, 3).join('; ');
  const rest = labels.length - 3;
  return rest > 0 ? `${shown} and ${String(rest)} more` : shown;
}

/**
 * Refuses a Work left with an item that resolves to a matrix row which
 * does not exist.
 *
 * The authority for the payment-setup save's one added rule, run on the
 * FINAL state inside the transaction, so it reads what was actually
 * written rather than what was submitted — a save that changed nothing
 * on a Work that was already incomplete is refused for the same reason
 * as one that made it incomplete, and neither can be talked past by a
 * client that computed the coverage differently.
 *
 * The resolution is the one `payment-matrix.ts` performs at billing
 * time: an item's own category, and nothing at all when it has none. A
 * categorised item deliberately does not fall back, so a SUPPLY item on
 * a Work with only an UNCATEGORISED row is uncovered and named here.
 *
 * An item with NO category chosen is skipped, not named (migration
 * 0105). It resolves through no row, so there is no row this save could
 * be asked to add — the remedy is a decision on the item, and the
 * Measurement Book asks for it by item name at finalisation. Naming a
 * category here for an item that has none would send the operator to
 * configure a row that changes nothing.
 */
async function assertEveryItemResolves(
  tx: TransactionSql,
  workId: string,
): Promise<void> {
  const uncovered = await tx<{ category: string }[]>`
    select distinct wi.payment_category as category
    from work_items wi
    where wi.work_id = ${workId} and wi.deleted_at is null
      and wi.payment_category is not null
      and not exists (
        select 1 from payment_matrices pm
        where pm.work_id = wi.work_id
          and pm.category = wi.payment_category
      )
    order by 1
  `;
  if (uncovered.length === 0) return;
  const names = uncovered.map((row) => row.category);
  throw httpError(
    400,
    'PAYMENT_MATRIX_ROW_MISSING',
    `This Work has items that would bill through ${names.join(
      ', ',
    )}, and it has no payment matrix row for ${
      names.length > 1 ? 'those categories' : 'that category'
    }. Enter the four stage percentages for ${
      names.length > 1 ? 'them' : 'it'
    } — a Measurement Book cannot be finalized until the row${
      names.length > 1 ? 's exist' : ' exists'
    }. Nothing was saved.`,
    { categories: names },
  );
}

const MATRIX_COLUMNS_SQL = `
  id, work_id, category, pct_supply::text as pct_supply,
  pct_installation::text as pct_installation, pct_pac::text as pct_pac,
  pct_final_bill::text as pct_final_bill, category_label,
  created_at, updated_at
`;

/**
 * Writes one matrix row and its audit event, inside a caller's
 * transaction and after the caller has proved access to the Work.
 *
 * Shared by the per-row upsert route and the payment-setup save, so the
 * row lock, the ON CONFLICT upsert and the before/after audit pair are
 * the same act in both — a second copy is how one of them comes to skip
 * the lock or write a diff against nothing. Percentage validation stays
 * with the CALLER: both validate every row before opening the
 * transaction, so a refusal writes nothing at all.
 */
async function writeMatrixRow(
  tx: TransactionSql,
  args: {
    readonly organisationId: string;
    readonly userId: string;
    readonly workId: string;
    readonly category: PaymentMatrixCategory;
    readonly body: UpsertPaymentMatrixRowRequest;
  },
): Promise<MatrixRowRecord> {
  const { organisationId, userId, workId, category, body } = args;

  // Row lock (when the row exists) serialises concurrent upserts
  // for the same category so the before/after audit pairs stay
  // truthful; the ON CONFLICT upsert below makes the write itself
  // atomic either way — last write wins cleanly, no duplicate-key
  // corruption.
  const [existing] = await tx<
    {
      pct_supply: string;
      pct_installation: string;
      pct_pac: string;
      pct_final_bill: string;
      category_label: string | null;
    }[]
  >`
    select pct_supply::text as pct_supply,
           pct_installation::text as pct_installation,
           pct_pac::text as pct_pac,
           pct_final_bill::text as pct_final_bill,
           category_label
    from payment_matrices
    where work_id = ${workId} and category = ${category}
    for update
  `;

  // The residual row's per-Work name (migration 0105), and only that
  // row's. Refused here as well as by the CHECK: a caller labelling the
  // SUPPLY row is asking for a second name for a category the whole
  // product agrees on, and a constraint violation would not say so.
  if (body.categoryLabel !== undefined && category !== 'UNCATEGORISED') {
    throw httpError(
      400,
      'PAYMENT_MATRIX_CATEGORY_LABEL_NOT_ALLOWED',
      'Only the uncategorised-items row carries a per-Work name; the other categories are named the same on every Work.',
    );
  }
  // Omitted keeps what is stored; explicit null clears it. A blank or
  // all-space name is a cleared name, not a name made of spaces.
  const label =
    body.categoryLabel === undefined
      ? (existing?.category_label ?? null)
      : body.categoryLabel === null || body.categoryLabel.trim().length === 0
        ? null
        : body.categoryLabel.trim();

  const rows = (await tx.unsafe(
    `insert into payment_matrices (
       organisation_id, work_id, category, pct_supply,
       pct_installation, pct_pac, pct_final_bill, category_label,
       created_by_user_id
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organisation_id, work_id, category) do update set
       pct_supply = excluded.pct_supply,
       pct_installation = excluded.pct_installation,
       pct_pac = excluded.pct_pac,
       pct_final_bill = excluded.pct_final_bill,
       category_label = excluded.category_label
     returning ${MATRIX_COLUMNS_SQL}`,
    [
      organisationId,
      workId,
      category,
      body.pctSupply,
      body.pctInstallation,
      body.pctPac,
      body.pctFinalBill,
      label,
      userId,
    ],
  )) as unknown as MatrixRowRecord[];
  const row = rows[0];
  if (!row) throw new Error('payment matrix upsert returned no row');

  const changes = auditDiff(
    existing === undefined
      ? {}
      : {
          pctSupply: existing.pct_supply,
          pctInstallation: existing.pct_installation,
          pctPac: existing.pct_pac,
          pctFinalBill: existing.pct_final_bill,
          categoryLabel: existing.category_label,
        },
    {
      pctSupply: row.pct_supply,
      pctInstallation: row.pct_installation,
      pctPac: row.pct_pac,
      pctFinalBill: row.pct_final_bill,
      categoryLabel: row.category_label,
    },
  );
  await audit(
    tx,
    organisationId,
    userId,
    existing === undefined
      ? 'payment_matrix.row_created'
      : 'payment_matrix.row_updated',
    'payment_matrices',
    row.id,
    { workId, category, before: changes.before, after: changes.after },
  );
  return row;
}

type ItemCategoryValue = SetWorkItemPaymentCategoryRequest['paymentCategory'];

interface ItemCategoryAssignment {
  readonly workItemId: string;
  readonly paymentCategory: ItemCategoryValue;
  /** The value was the dialog's keyword proposal, accepted untouched.
   * Recorded on the audit event; it grants nothing. */
  readonly proposed?: boolean;
}

/**
 * Sets the payment category of a SET of items and writes their audit
 * events, given the Work row the caller has already locked and proved
 * access to.
 *
 * Shared by the per-item PATCH (which passes one) and the payment-setup
 * save (which passes up to five hundred). Everything that decides
 * whether a change is ALLOWED lives here — R8, the billing freeze and
 * the two AMC guards — so a caller cannot acquire the write without
 * them.
 *
 * Written as a SET rather than as a loop over one, which is the shape
 * `routes/challans.ts` already uses for its lines: one `= any(...) order
 * by id for update` to take every row lock in a deterministic order, the
 * three guards once each over the whole set, one `unnest` update, and
 * one audit insert. A loop would have taken four round trips per item —
 * a 129-item Work costs five hundred of them, inside a transaction
 * holding the Work's row lock the whole time.
 *
 * `source` is the act the change came from, when the caller is not the
 * plain per-item edit. The PATCH omits it and its audit details are
 * unchanged; the payment-setup save names itself, so a reviewer reading
 * a category that turned out wrong can tell a bulk save from a
 * deliberate single correction — and, with `proposed`, an accepted
 * keyword proposal from a typed choice.
 */
async function writeItemPaymentCategories(
  tx: TransactionSql,
  args: {
    readonly organisationId: string;
    readonly userId: string;
    readonly work: { readonly id: string; readonly status: string };
    readonly entries: readonly ItemCategoryAssignment[];
    readonly source?: string;
  },
): Promise<
  {
    id: string;
    itemNumber: string;
    paymentCategory: ItemCategoryValue;
  }[]
> {
  const { organisationId, userId, work, entries, source } = args;
  if (entries.length === 0) return [];

  // R8: a completed Work is closed to edits until it is reopened.
  // The category decides which quantity the completion predicate
  // measured, so changing it under a completed Work would rewrite
  // the basis of a closure that has already been recorded.
  assertWorkOperable(work.status, "changing an item's payment category");

  // Row locks in id order, taken in ONE statement before anything is
  // read off the rows — the works -> work_items order every writer takes,
  // and the ordering that stops two concurrent saves of overlapping item
  // sets from deadlocking against each other. The `work_id` predicate is
  // what makes this safe for a caller holding a Work rather than an
  // item: an id belonging to another Work — or to another tenant, which
  // RLS has already hidden — is simply not found, and the short count
  // below turns that into a 404 rather than a silent partial write.
  const wantedIds = [...new Set(entries.map((entry) => entry.workItemId))].sort();
  const locked = await tx<
    {
      id: string;
      work_id: string;
      item_number: string;
      payment_category: string | null;
    }[]
  >`
    select id, work_id, item_number, payment_category
    from work_items
    where id = any(${wantedIds}::uuid[]) and work_id = ${work.id}
      and deleted_at is null
    order by id
    for update
  `;
  if (locked.length !== wantedIds.length) {
    throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
  }
  const current = new Map(locked.map((item) => [item.id, item]));

  // The category is configuration only until a Measurement Book
  // bills the item; after that it is part of what was paid. Re-
  // submitting the value the item already carries changes nothing
  // and stays a harmless no-op, so the guards run only over the
  // items whose value actually moves.
  //
  // The two AMC guards are symmetric on purpose. Moving IN is
  // refused while the item carries movement, because an AMC item
  // takes none; moving OUT is refused while it carries
  // certificates, because those were capped at the sanctioned
  // quantity under the AMC rule and every other category caps at
  // the installed total. Guarding only one direction leaves the
  // other as a way to reach exactly the state the guard exists to
  // prevent.
  const moving = entries.filter(
    (entry) =>
      entry.paymentCategory !== current.get(entry.workItemId)?.payment_category,
  );
  const under = (subset: readonly ItemCategoryAssignment[]): ItemUnderChange[] =>
    subset.map((entry) => ({
      id: entry.workItemId,
      itemNumber: current.get(entry.workItemId)?.item_number ?? entry.workItemId,
    }));
  await assertItemsNotBilled(tx, under(moving));
  await assertItemsHaveNoMovement(
    tx,
    under(moving.filter((entry) => entry.paymentCategory === 'AMC')),
  );
  await assertItemsHaveNoCertification(
    tx,
    under(
      moving.filter(
        (entry) => current.get(entry.workItemId)?.payment_category === 'AMC',
      ),
    ),
  );

  const updated = await tx<
    { id: string; item_number: string; payment_category: string | null }[]
  >`
    update work_items wi
    set payment_category = requested.payment_category
    from unnest(
      ${entries.map((entry) => entry.workItemId)}::uuid[],
      ${entries.map((entry) => entry.paymentCategory)}::text[]
    ) as requested(work_item_id, payment_category)
    where wi.id = requested.work_item_id and wi.work_id = ${work.id}
      and wi.deleted_at is null
    returning wi.id, wi.item_number, wi.payment_category
  `;
  if (updated.length !== wantedIds.length) {
    throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
  }

  // One statement for the whole set. The shared `audit` helper writes
  // exactly one row, so a multi-row event is inlined here — the shape
  // `routes/challans.ts` and `routes/loa.ts` already use for their own
  // batched events.
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    select ${organisationId}, ${userId}, 'work_item.payment_category_changed',
           'work_items', changed.id, changed.details::jsonb
    from unnest(
      ${entries.map((entry) => entry.workItemId)}::uuid[],
      ${entries.map((entry) => {
        const before = current.get(entry.workItemId)?.payment_category ?? null;
        const changes = auditDiff(
          { paymentCategory: before },
          { paymentCategory: entry.paymentCategory },
        );
        return JSON.stringify({
          workId: work.id,
          itemNumber: current.get(entry.workItemId)?.item_number,
          before: changes.before,
          after: changes.after,
          ...(source === undefined
            ? {}
            : { source, proposed: entry.proposed === true }),
        });
      })}::text[]
    ) as changed(id, details)
  `;

  const byId = new Map(updated.map((item) => [item.id, item]));
  return entries.map((entry) => {
    const item = byId.get(entry.workItemId);
    if (item === undefined) {
      throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
    }
    return {
      id: item.id,
      itemNumber: item.item_number,
      paymentCategory: item.payment_category as ItemCategoryValue,
    };
  });
}

/* --- Item tax facts (migration 0033) -----------------------------------
 *
 * PATCH /api/work-items/:id/tax-facts writes the three columns 0033 added
 * to `work_items`: the HSN/SAC code, the total GST rate, and whether the
 * item is a service. They sit beside the payment category above because
 * they are the same KIND of thing — per-item configuration an operator
 * corrects, not the awarded baseline the amendment engine guards — so
 * they take the same writer role, the same item row lock and the same
 * `assertWorkAccess`, and refuse on a completed Work like every other
 * writer (R8).
 *
 * There is no billing freeze here of the sort the payment category
 * carries. A GST tax invoice snapshots the HSN and the rate it charged,
 * exactly as every other issued document snapshots what it printed, so
 * correcting a mistyped HSN never rewrites an invoice already sent — and
 * an item whose code was wrong must stay correctable, because the IRP
 * refuses the next e-invoice line until it is.
 *
 * The field shapes are the contract's own primitives (HsnCodeSchema,
 * GstRateSchema — each the exact bound of its column's CHECK) so a
 * mistyped code is a 400 naming the field rather than a 23514 surfacing
 * as an opaque 500. `undefined` leaves a field as it was; an explicit
 * null clears it, which is a real operation — an HSN entered against the
 * wrong item has to be removable. `isService` has no null: its column is
 * NOT NULL DEFAULT false. */
const SetWorkItemTaxFactsRequestSchema = Type.Object(
  {
    hsnCode: Type.Optional(Type.Union([HsnCodeSchema, Type.Null()])),
    gstRate: Type.Optional(Type.Union([GstRateSchema, Type.Null()])),
    isService: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const WorkItemTaxFactsResponseSchema = Type.Object(
  {
    id: UuidSchema,
    itemNumber: Type.String(),
    hsnCode: Type.Union([HsnCodeSchema, Type.Null()]),
    gstRate: Type.Union([GstRateSchema, Type.Null()]),
    isService: Type.Boolean(),
  },
  { additionalProperties: false },
);

interface TaxFactsRow {
  id: string;
  item_number: string;
  hsn_code: string | null;
  /** `::text` from numeric(5,2): the exact stored decimal, never a float. */
  gst_rate: string | null;
  is_service: boolean;
}

export function registerPaymentRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/payment-matrix',
      schema: {
        params: IdParamsSchema,
        response: { 200: PaymentMatrixResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = (await tx.unsafe(
          `select ${MATRIX_COLUMNS_SQL}
           from payment_matrices where work_id = $1
           order by category`,
          [workId],
        )) as unknown as MatrixRowRecord[];
        return { rows: rows.map(toMatrixRow) };
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/payment-matrix/:category',
      schema: {
        params: MatrixParamsSchema,
        body: UpsertPaymentMatrixRowRequestSchema,
        response: { 200: PaymentMatrixRowSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId, category: rawCategory } = request.params;
      const category = assertMatrixCategory(rawCategory);
      const body = request.body;
      assertPercentagesSumTo100(body);
      assertAmcStagePercentages(category, body);
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        return toMatrixRow(
          await writeMatrixRow(tx, {
            organisationId,
            userId: user.id,
            workId,
            category,
            body,
          }),
        );
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/works/:id/payment-matrix/:category',
      schema: {
        params: MatrixParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId, category: rawCategory } = request.params;
      const category = assertMatrixCategory(rawCategory);
      await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // Deleting configuration is legitimate here: finalised MBs
        // snapshot their percentages, so removing a row only affects
        // FUTURE resolution (which will fail precisely if the row is
        // still needed).
        const [deleted] = await tx<
          {
            id: string;
            pct_supply: string;
            pct_installation: string;
            pct_pac: string;
            pct_final_bill: string;
          }[]
        >`
          delete from payment_matrices
          where work_id = ${workId} and category = ${category}
          returning id, pct_supply::text as pct_supply,
                    pct_installation::text as pct_installation,
                    pct_pac::text as pct_pac,
                    pct_final_bill::text as pct_final_bill
        `;
        if (!deleted) {
          throw httpError(
            404,
            'MATRIX_ROW_NOT_FOUND',
            `This Work has no ${category} payment matrix row.`,
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'payment_matrix.row_deleted',
          'payment_matrices',
          deleted.id,
          {
            workId,
            category,
            before: {
              pctSupply: deleted.pct_supply,
              pctInstallation: deleted.pct_installation,
              pctPac: deleted.pct_pac,
              pctFinalBill: deleted.pct_final_bill,
            },
            after: {},
          },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/work-items/:id/payment-category',
      schema: {
        params: IdParamsSchema,
        body: SetWorkItemPaymentCategoryRequestSchema,
        response: { 200: WorkItemPaymentCategoryResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workItemId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Works lock FIRST, then the item — the works -> work_items order
        // every other writer takes, so this cannot invert a lock order
        // and deadlock. The sibling tax-facts PATCH below does exactly
        // this, and the category edit is the same kind of act: per-item
        // configuration on a Work that must still be open.
        //
        // The lock is also what makes the AMC guards below sound. A
        // Delivery Challan draft save takes the works lock and locks the
        // work_items rows its lines name (routes/challans.ts), and
        // installation recording locks the item — so a category change
        // racing either of them waits rather than reading a state the
        // other is about to invalidate.
        const [work] = await tx<{ id: string; status: string }[]>`
          select id, status from works
          where id = (
              select work_id from work_items
              where id = ${workItemId} and deleted_at is null
            )
            and deleted_at is null
          for update
        `;
        if (!work) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertWorkAccess(tx, user.id, work.id);
        const [updated] = await writeItemPaymentCategories(tx, {
          organisationId,
          userId: user.id,
          work,
          entries: [{ workItemId, paymentCategory: body.paymentCategory }],
        });
        if (updated === undefined) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        return updated;
      });
    },
  );

  /**
   * POST /api/works/:id/payment-setup — the whole payment configuration
   * of one Work in one transaction, which is what the post-creation
   * payment setup dialog offers as a single Save.
   *
   * It is a composition, not a new authority: every matrix row goes
   * through `writeMatrixRow` after the same percentage/sum/AMC
   * validation the per-row upsert applies, and every item through
   * `writeItemPaymentCategories` with its R8, billing-freeze and AMC
   * guards. What the single request buys is atomicity — a save that
   * refuses one item leaves the Work exactly as it was, rather than
   * three rows in and no way for the operator to know which.
   *
   * It adds ONE rule of its own, and it is a rule about the Work rather
   * than about the request: when the transaction is done, every item of
   * the Work must resolve to a matrix row that exists. That is the state
   * a Measurement Book refuses to finalize in, days later and to
   * whoever happens to be billing, and a setup dialog that could leave
   * the Work in it would be asking the question for nothing. Checked on
   * the FINAL state read back from the database rather than on what the
   * browser believed, because the client's view of the Work is a
   * snapshot and another operator may have moved an item under it.
   *
   * Lock order is the one every Work-scoped writer takes: the works row
   * first, then work_items, and the items in a deterministic order so
   * two concurrent saves of the same Work queue instead of deadlocking.
   */
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/payment-setup',
      schema: {
        params: IdParamsSchema,
        body: SavePaymentSetupRequestSchema,
        response: { 200: PaymentSetupResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;

      // Everything decidable without the database is decided first, so a
      // malformed submission never opens a transaction.
      const seenCategory = new Set<string>();
      for (const row of body.matrixRows) {
        if (seenCategory.has(row.category)) {
          throw httpError(
            400,
            'PAYMENT_MATRIX_CATEGORY_DUPLICATE',
            `The payment setup names ${row.category} more than once.`,
          );
        }
        seenCategory.add(row.category);
        assertPercentagesSumTo100(row);
        assertAmcStagePercentages(row.category, row);
      }
      const seenItem = new Set<string>();
      for (const entry of body.itemCategories) {
        if (seenItem.has(entry.workItemId)) {
          throw httpError(
            400,
            'DUPLICATE_ITEM',
            'The payment setup names the same Work item more than once, with no way to tell which category was meant. Nothing was saved.',
            { workItemId: entry.workItemId },
          );
        }
        seenItem.add(entry.workItemId);
      }

      return tenant(async (tx) => {
        // Work scope FIRST, then the works row lock — the order the
        // sibling PUT takes. A member who may not see this Work is
        // refused before they can make anyone else wait on its row, and
        // a 404 for an out-of-scope Work costs no lock at all.
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock before any work_items row — the order every
        // other Work-scoped writer takes, so this cannot invert a lock
        // order and deadlock against a challan save or a completion.
        const [work] = await tx<{ id: string; status: string }[]>`
          select id, status from works
          where id = ${workId} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // At most one row per category (six), so the loop is bounded by
        // the vocabulary rather than by the request, and each row still
        // takes its own lock and writes its own before/after pair.
        for (const row of [...body.matrixRows].sort((left, right) =>
          left.category.localeCompare(right.category),
        )) {
          await writeMatrixRow(tx, {
            organisationId,
            userId: user.id,
            workId,
            category: row.category,
            body: row,
          });
        }

        const items = await writeItemPaymentCategories(tx, {
          organisationId,
          userId: user.id,
          work,
          entries: body.itemCategories,
          source: 'payment_setup',
        });

        await assertEveryItemResolves(tx, workId);
        return { items };
      });
    },
  );

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/work-items/:id/tax-facts',
      schema: {
        params: IdParamsSchema,
        body: SetWorkItemTaxFactsRequestSchema,
        response: { 200: WorkItemTaxFactsResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workItemId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Lock the Work row FIRST, then the item — the order every other
        // Work-scoped writer takes (routes/work-completion.ts locks these
        // same two rows in exactly this order), so a tax-fact edit racing
        // a completion waits rather than deadlocking. The subquery only
        // READS work_items, so it takes no lock of its own and cannot
        // invert the order. A foreign or missing item leaves the subquery
        // empty and the Work unfound: 404, never a hint that the id
        // exists in some other tenant.
        const [work] = await tx<{ id: string; status: string }[]>`
          select id, status from works
          where id = (
              select work_id from work_items
              where id = ${workItemId} and deleted_at is null
            )
            and deleted_at is null
          for update
        `;
        if (!work) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertWorkAccess(tx, user.id, work.id);
        // R8: a completed Work is closed to edits until it is reopened.
        // The lock above serialises this against the completion itself.
        assertWorkOperable(work.status, "changing an item's tax facts");

        // The item row lock serialises concurrent tax-fact edits so the
        // before/after audit pairs chain truthfully, exactly as the
        // category edit above does.
        const [item] = await tx<(TaxFactsRow & { work_id: string })[]>`
          select id, work_id, item_number, hsn_code,
                 gst_rate::text as gst_rate, is_service
          from work_items
          where id = ${workItemId} and deleted_at is null
          for update
        `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }

        // `undefined` means "leave as it was"; an explicit null clears.
        const next = {
          hsn_code: body.hsnCode !== undefined ? body.hsnCode : item.hsn_code,
          gst_rate: body.gstRate !== undefined ? body.gstRate : item.gst_rate,
          is_service: body.isService !== undefined ? body.isService : item.is_service,
        };
        const [updated] = await tx<TaxFactsRow[]>`
          update work_items set
            hsn_code = ${next.hsn_code},
            gst_rate = ${next.gst_rate},
            is_service = ${next.is_service}
          where id = ${workItemId}
          returning id, item_number, hsn_code,
                    gst_rate::text as gst_rate, is_service
        `;
        if (!updated) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }

        const changes = auditDiff(
          {
            hsnCode: item.hsn_code,
            gstRate: item.gst_rate,
            isService: item.is_service,
          },
          {
            hsnCode: updated.hsn_code,
            gstRate: updated.gst_rate,
            isService: updated.is_service,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'work_item.tax_facts_changed',
          'work_items',
          workItemId,
          {
            workId: item.work_id,
            itemNumber: item.item_number,
            before: changes.before,
            after: changes.after,
          },
        );
        return {
          id: updated.id,
          itemNumber: updated.item_number,
          hsnCode: updated.hsn_code,
          gstRate: updated.gst_rate,
          isService: updated.is_service,
        };
      });
    },
  );
}
