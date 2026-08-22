import {
  DiscardImportedInvoiceSchema,
  type ErrorCode,
  ImportedInvoiceDetailSchema,
  ImportedInvoiceImportResultSchema,
  ImportedInvoiceListSchema,
  ImportedInvoiceQuerySchema,
  ImportedInvoiceUploadQuerySchema,
  RelinkImportedInvoiceSchema,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { CsvParseError } from '../csv.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { keysetPage, registerKeyset, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_CSV_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import {
  ZohoInvoiceImportError,
  matchContact,
  proposeWorkLink,
  readZohoInvoiceCsv,
  type ContactCandidate,
  type WorkCandidate,
  type WorkLinkProposal,
  type ZohoInvoice,
} from '../zoho-invoices.js';
import {
  IdParamsSchema,
  audit,
  errorResponses,
  requireTrimmed,
  writeRefusals,
} from './shared.js';

/**
 * The historical Zoho Books invoice register (migration 0115).
 *
 * ## The shape of the feature, in two calls against the same bytes
 *
 * `POST /api/imported-invoices/import?mode=preview` parses the export,
 * proposes a Work for every invoice it can, matches every customer it can,
 * and answers with the whole list — including, by name, every invoice it
 * COULD NOT link. It writes nothing. `?mode=commit` does the identical
 * reading and then inserts.
 *
 * ## Why there is no staging table, where 0094 has one
 *
 * 0094 stages because its rows are judged against a live register that can
 * change between the upload and the commit: a contact somebody adds by
 * hand in between turns a row that validated cleanly into a duplicate, and
 * the operator has to be able to read eleven refusals and fix a workbook.
 *
 * Nothing here is judged against a live register. The export is machine
 * generated, every row of it is admissible history, and the only judgement
 * made is which Work each invoice belongs to — which the SAME file answers
 * the same way whenever it is read. So the preview is a pure function of
 * the bytes, and re-sending the bytes to commit is exactly equivalent to
 * committing a staged copy of them, minus a table, a lifecycle, five
 * states and a supersession rule.
 *
 * The two things a staging table would have bought are bought otherwise:
 * committing twice is safe because the partial unique index on
 * `(organisation_id, zoho_invoice_id) WHERE discarded_at IS NULL` makes the
 * second one a no-op, and the operator's decision is recorded because every
 * imported invoice writes its own audit event naming the file it came from.
 * The index is partial and this route's own "already imported" check
 * carries the same `discarded_at is null`, so a discarded invoice is
 * genuinely absent to both: discarding a row imported from the wrong file
 * and uploading the corrected export is the register's correction path,
 * and it only works if the two agree.
 *
 * ## Permissions
 *
 * The `import` authority (owner ruling, migration 0094) on top of the
 * writer role, for 0094's reason: pointing a file at a register is a
 * different act from adding one row to it. The register's READS carry the
 * writer role alone — which invoices this organisation raised in 2023 is
 * ordinary register history, and gating it on the import authority would
 * send every member who is not a founding owner into a 403 on a screen the
 * rail draws for them.
 *
 * ## Work scope
 *
 * The register is narrowed by work-scope, and the predicate has an arm the
 * shared helpers do not: `work_id IS NULL OR the Work is in scope`. A
 * private order billed against no LOA belongs to the organisation rather
 * than to any Work, so hiding it from an 'assigned'-scoped member would
 * hide the private half of the business from everyone but an owner. A
 * linked invoice carries its Work's CODE on the wire, so leaving those
 * unscoped would have leaked the existence of Works a member may not see.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0115 raises from the 23X block, one code per rule, so a guard
 * that fires because a route's own check lost a race surfaces as the same
 * 409 an operator would have got from the route — not as an unexplained
 * 500.
 *
 * The four PostgreSQL-native codes beneath them are BACKSTOPS, and they
 * exist because this route's input is a file rather than a form. The
 * reader refuses a calendar-invalid date, an over-wide figure and an
 * impossible tax rate up front, with a row number, in the preview — that
 * is where an operator can act. These say something honest if one ever
 * reaches the insert anyway: a 409 naming the file, rather than a 500
 * whose reason is only in the server log.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23X01': [
    'IMPORTED_INVOICE_IMMUTABLE',
    'A historical invoice records what the Zoho export said; only its Work link, its customer link and its discard can change.',
  ],
  '23X02': [
    'IMPORTED_INVOICE_IMMUTABLE',
    'The lines of a historical invoice record what the Zoho export said and cannot be changed.',
  ],
  // 22008 datetime_field_overflow, 22003 numeric_value_out_of_range,
  // 23514 check_violation, 23503 foreign_key_violation.
  '22008': [
    'ZOHO_EXPORT_UNREADABLE',
    'That export carries a date no calendar has. Correct it in Zoho Books, export again, and read the file before importing it.',
  ],
  '22003': [
    'ZOHO_EXPORT_UNREADABLE',
    'That export carries a figure too large for this register to store. Read the file first: the preview names the row and the column.',
  ],
  '23514': [
    'ZOHO_EXPORT_UNREADABLE',
    'That export carries a value this register refuses. Read the file first: the preview names the row and the column.',
  ],
  '23503': [
    'WORK_NOT_FOUND',
    'That Work is no longer on this organisation’s register, so nothing can be filed against it.',
  ],
};

const rethrowWriteRefusal = writeRefusals(DATABASE_REFUSALS);

/** How many invoices the register returns when the caller asks for no
 * page. The whole history is 638 rows and a clerk scrolls it; this is the
 * ceiling on one response, not on the register. */
const PAGE_LIMIT = 100;

/**
 * The columns every read of the register selects, so a new field is added
 * in one place rather than in three queries that drift apart — the shape
 * `routes/received-railway-bills.ts` keeps for the same reason.
 *
 * THE `::text` CASTS ON THE DATES ARE THE POINT OF THIS EXISTING. A
 * date-only column comes back from the driver as a `Date`, and a `Date`
 * serialised into a response is a timezone round-trip: `2024-07-19`
 * leaves as `2024-07-19T00:00:00.000Z` and, an hour's offset later,
 * arrives somewhere as the eighteenth. AGENTS.md rule 6 refuses that, and
 * `select i.*` was how it got in — this list is what makes the refusal
 * mechanical. (Caught by the integration test below, not by review.)
 *
 * `raw_row` and `qr_payload` are deliberately ABSENT: the raw row is the
 * truth source rather than a field of the wire model, and the QR payload
 * is a kilobyte of e-invoice JWT nothing on screen renders. Both are read
 * from the table by anybody who needs them.
 */
const INVOICE_COLUMNS = `
  i.id, i.source, i.zoho_invoice_id, i.invoice_number,
  i.invoice_date::text as invoice_date,
  i.customer_name, i.customer_gstin, i.place_of_supply, i.contact_id,
  i.contact_match_method, i.zoho_status, i.issued, i.irn, i.ack_number,
  i.ack_date::text as ack_date, i.reference_text, i.sub_total, i.total,
  i.balance, i.round_off, i.work_id, i.link_method, i.discarded_at,
  i.discard_reason, i.created_at,
  w.work_code, (w.deleted_at is not null) as work_withdrawn,
  c.designation as contact_name,
  (select count(*)::int from imported_invoice_lines l
    where l.imported_invoice_id = i.id) as line_count,
  -- The TallyPrime cross-reference (0119). Three facts in one lateral
  -- rather than three correlated subqueries, because they are three
  -- readings of the same rows: how many vouchers correspond, the one
  -- voucher's own number where exactly one does, and whether the two
  -- systems disagree about the value.
  --
  -- The voucher number is deliberately NULL where several correspond:
  -- rendering the first of three would name one document and imply it
  -- was the only one, which is worse than saying "3 vouchers".
  t.voucher_count as tally_voucher_count,
  case when t.voucher_count = 1 then t.voucher_number else null end
    as tally_voucher_number,
  coalesce(t.disputed, false) as disputed,
  -- Ruled on, and ruled back IN. A 'tally_correct' ruling does not
  -- restore the row, so it does not count as resolved for this purpose --
  -- the register holds the figure that ruling rejected.
  coalesce(t.dispute_resolved, false) as dispute_resolved
`;

/** The cross-reference read every statement above joins. Written once so
 * the page and its totals cannot end up describing different links. */
const TALLY_LINK_JOIN = `
  left join lateral (
    select count(*)::int as voucher_count,
           min(tl.tally_voucher_number) as voucher_number,
           bool_or(tl.disputed) as disputed,
           bool_and(
             not tl.disputed
             or (tl.resolution is not null and tl.resolution <> 'tally_correct')
           ) as dispute_resolved
    from tally_invoice_links tl
    where tl.organisation_id = i.organisation_id
      and tl.imported_invoice_id = i.id
  ) t on true
`;

/** The lines of one invoice. `raw_row` is absent for the reason above. */
const LINE_COLUMNS = `
  id, position, item_name, item_description, quantity, usage_unit,
  item_price, item_total, hsn_sac, supply_type, cgst_rate, sgst_rate,
  igst_rate, cgst_amount, sgst_amount, igst_amount
`;

interface InvoiceRow {
  id: string;
  source: string;
  zoho_invoice_id: string | null;
  invoice_number: string;
  invoice_date: string;
  customer_name: string;
  customer_gstin: string | null;
  place_of_supply: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_match_method: string | null;
  zoho_status: string | null;
  issued: boolean;
  irn: string | null;
  ack_number: string | null;
  ack_date: string | null;
  reference_text: string | null;
  sub_total: string | null;
  total: string;
  balance: string | null;
  round_off: string | null;
  work_id: string | null;
  work_code: string | null;
  work_withdrawn: boolean;
  link_method: string | null;
  line_count: number;
  tally_voucher_count: number;
  tally_voucher_number: string | null;
  disputed: boolean;
  dispute_resolved: boolean;
  discarded_at: string | null;
  discard_reason: string | null;
  created_at: string;
}

interface LineRow {
  id: string;
  position: number;
  item_name: string | null;
  item_description: string | null;
  quantity: string | null;
  usage_unit: string | null;
  item_price: string | null;
  item_total: string | null;
  hsn_sac: string | null;
  supply_type: string | null;
  cgst_rate: string | null;
  sgst_rate: string | null;
  igst_rate: string | null;
  cgst_amount: string | null;
  sgst_amount: string | null;
  igst_amount: string | null;
}

function toInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    source: row.source as 'zoho' | 'tally',
    zohoInvoiceId: row.zoho_invoice_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    customerName: row.customer_name,
    customerGstin: row.customer_gstin,
    placeOfSupply: row.place_of_supply,
    contactId: row.contact_id,
    contactName: row.contact_name,
    contactMatchMethod: row.contact_match_method as 'gstin' | 'name' | 'manual' | null,
    zohoStatus: row.zoho_status,
    issued: row.issued,
    irn: row.irn,
    ackNumber: row.ack_number,
    ackDate: row.ack_date,
    referenceText: row.reference_text,
    subTotal: row.sub_total,
    total: row.total,
    balance: row.balance,
    roundOff: row.round_off,
    workId: row.work_id,
    workCode: row.work_code,
    workWithdrawn: row.work_withdrawn,
    linkMethod: row.link_method as 'pl_code' | 'loa_match' | 'manual' | null,
    lineCount: row.line_count,
    tallyVoucherCount: row.tally_voucher_count,
    tallyVoucherNumber: row.tally_voucher_number,
    disputed: row.disputed,
    disputeResolved: row.dispute_resolved,
    discardedAt:
      row.discarded_at === null ? null : new Date(row.discarded_at).toISOString(),
    discardReason: row.discard_reason,
    importedAt: new Date(row.created_at).toISOString(),
  };
}

interface TallyLinkRow {
  id: string;
  tally_guid: string;
  tally_voucher_type: string;
  tally_voucher_date: string;
  tally_voucher_number: string | null;
  tally_reference: string | null;
  tally_party_ledger: string;
  tally_amount: string;
  match_method: string;
  match_evidence: string | null;
  disputed: boolean;
  component_tally_total: string | null;
  component_invoice_total: string | null;
  resolution: string | null;
  resolved_at: string | null;
}

function toTallyLink(row: TallyLinkRow) {
  return {
    id: row.id,
    tallyGuid: row.tally_guid,
    voucherType: row.tally_voucher_type as 'Sales' | 'Credit Note' | 'Debit Note',
    voucherDate: row.tally_voucher_date,
    voucherNumber: row.tally_voucher_number,
    reference: row.tally_reference,
    partyLedger: row.tally_party_ledger,
    amount: row.tally_amount,
    matchMethod: row.match_method as
      'origin' | 'exact_number' | 'serial_tolerant' | 'manual',
    matchEvidence: row.match_evidence,
    disputed: row.disputed,
    componentTallyTotal: row.component_tally_total,
    componentInvoiceTotal: row.component_invoice_total,
    resolution: row.resolution as
      'tally_correct' | 'zoho_correct' | 'accepted_gap' | null,
    resolvedAt:
      row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  };
}

function toLine(row: LineRow) {
  return {
    id: row.id,
    position: row.position,
    itemName: row.item_name,
    itemDescription: row.item_description,
    quantity: row.quantity,
    usageUnit: row.usage_unit,
    itemPrice: row.item_price,
    itemTotal: row.item_total,
    hsnSac: row.hsn_sac,
    supplyType: row.supply_type,
    cgstRate: row.cgst_rate,
    sgstRate: row.sgst_rate,
    igstRate: row.igst_rate,
    cgstAmount: row.cgst_amount,
    sgstAmount: row.sgst_amount,
    igstAmount: row.igst_amount,
  };
}

/**
 * The candidate Works a proposal may name, narrowed by the caller's own
 * work-scope.
 *
 * Scoping the CANDIDATES rather than filtering the proposals afterwards is
 * the difference between "this member cannot link to that Work" and "this
 * member is told that Work exists". Bounded by the organisation's Works,
 * which is tens of rows.
 */
async function candidateWorks(
  tx: TransactionSql,
  userId: string,
): Promise<WorkCandidate[]> {
  const full = await hasFullWorkScope(tx, userId);
  const rows = await tx<{ id: string; work_code: string; letter_number: string }[]>`
    select w.id, w.work_code, w.letter_number
    from works w
    where w.deleted_at is null
      and (${full} or exists (
        select 1 from work_assignments wa
        where wa.work_id = w.id and wa.user_id = ${userId}
      ))
  `;
  return rows.map((row) => ({
    id: row.id,
    workCode: row.work_code,
    letterNumber: row.letter_number,
  }));
}

/** Live contacts, for the GSTIN-then-name match. Retired contacts are
 * excluded: matching a historical invoice onto a party the organisation
 * has since retired would revive it in every picker that reads the join. */
async function candidateContacts(tx: TransactionSql): Promise<ContactCandidate[]> {
  const rows = await tx<{ id: string; designation: string; gstin: string | null }[]>`
    select id, designation, gstin from contacts where active
  `;
  return rows.map((row) => ({
    id: row.id,
    name: row.designation,
    gstin: row.gstin,
  }));
}

/** The Indian financial year's bounds: 1 April of `year` to 31 March of
 * the next. Written here rather than derived in SQL so the boundary is one
 * expression a reader can check. */
function financialYearBounds(year: number): readonly [string, string] {
  return [`${String(year)}-04-01`, `${String(year + 1)}-03-31`];
}

export function registerImportedInvoiceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  malwareScanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- the register ------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/imported-invoices',
      schema: {
        querystring: ImportedInvoiceQuerySchema,
        response: { 200: ImportedInvoiceListSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, tenantSnapshot }) => {
      const query = request.query;
      return await tenantSnapshot(async (tx) => {
        if (query.work !== undefined) {
          await assertWorkAccess(tx, user.id, query.work);
        }
        const full = await hasFullWorkScope(tx, user.id);
        const [fyFrom, fyTo] =
          query.financialYear === undefined
            ? [null, null]
            : financialYearBounds(query.financialYear);

        // THE KEY TUPLE IS STATED ONCE, and the ORDER BY and the keyset
        // comparison are both derived from it — the shared machinery every
        // other register here uses, rather than a fourth hand-written copy
        // of it. No `?sort` yet: this register is read newest-first and
        // nothing has asked for the other direction, so the parameter is
        // omitted rather than added speculatively. `registerKeyset` takes
        // the direction as an argument and will take it the day a
        // querystring offers one.
        const seek = registerKeyset(undefined, query.cursor, {
          table: 'imported_invoices',
          alias: 'i',
          columns: ['invoice_date', 'id'],
        });
        // The cursor is proven against the SAME predicate the rows are.
        // `workScopedCursorRowId` cannot serve this register: it refuses a
        // row whose `work_id` is null, and here that is a private order
        // every member may read. Refused exactly as a nonexistent cursor
        // is — same status, same code, same sentence — so the two stay
        // indistinguishable and the register cannot be used as an oracle.
        let cursor: string | null = null;
        if (seek.cursor !== undefined) {
          const [row] = await tx<{ id: string }[]>`
            select i.id from imported_invoices i
            where i.id = ${seek.cursor}
              and (i.work_id is null or ${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = i.work_id and wa.user_id = ${user.id}
              ))
          `;
          if (!row) {
            throw httpError(
              400,
              'CURSOR_INVALID',
              'The pagination cursor does not name a row in this register.',
            );
          }
          cursor = row.id;
        }

        const limit = query.limit ?? PAGE_LIMIT;
        // One predicate, written once and composed into both statements —
        // the page and its totals must not be able to disagree about which
        // register they are describing.
        const filters = tx`
          (i.work_id is null or ${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = i.work_id and wa.user_id = ${user.id}
          ))
          and (${query.includeDiscarded === true} or i.discarded_at is null)
          and (${query.work ?? null}::uuid is null or i.work_id = ${query.work ?? null})
          and (${query.customer ?? null}::text is null
               or lower(btrim(i.customer_name)) = lower(btrim(${query.customer ?? null})))
          and (${query.linked ?? null}::text is null
               or (${query.linked ?? null} = 'linked') = (i.work_id is not null))
          and (${fyFrom}::date is null or i.invoice_date between ${fyFrom} and ${fyTo})
          and (${query.source ?? null}::text is null
               or i.source = ${query.source ?? null})
        `;
        /* OWNER RULING 21: a disputed figure joins no sum. Written as an
           EXISTS over the cross-reference rather than as a column on the
           register, because that is where the disagreement lives (0119
           § A) — and stated once here so the two statements below cannot
           end up disagreeing about which invoices are out of the total. */
        /* WHAT COSTS AN INVOICE ITS PLACE IN THE TOTAL is a disputed
           correspondence the owner has NOT ruled back in — ruling 21 in
           both halves. `zoho_correct` and `accepted_gap` restore the row;
           `tally_correct` does not, because the figure this register
           holds is Zoho's and that is the one the owner ruled against, so
           counting it would report a number nobody believes. A row
           carrying several disputed links needs every one of them ruled
           back in, which is why this is an EXISTS over the ones that are
           not rather than a NOT EXISTS over the ones that are. */
        const disputedInvoice = tx`
          exists (
            select 1 from tally_invoice_links tl
            where tl.organisation_id = i.organisation_id
              and tl.imported_invoice_id = i.id
              and tl.disputed
              and (tl.resolution is null or tl.resolution = 'tally_correct')
          )
        `;
        /* Every disputed correspondence, ruled on or not — the count the
           screen reports beside the one above, so an operator can see
           what is left to decide rather than only what it costs. */
        const disputedAtAll = tx`
          exists (
            select 1 from tally_invoice_links tl
            where tl.organisation_id = i.organisation_id
              and tl.imported_invoice_id = i.id
              and tl.disputed
          )
        `;
        const rows = await tx<InvoiceRow[]>`
          select ${tx.unsafe(INVOICE_COLUMNS)}
          from imported_invoices i
          left join works w on w.id = i.work_id
          left join contacts c on c.id = i.contact_id
          ${tx.unsafe(TALLY_LINK_JOIN)}
          where ${filters}
            -- The sort key is read and compared inside PostgreSQL, at the
            -- precision it stores, rather than being round-tripped through
            -- the driver (pagination.ts states the reasoning in full).
            and ${seek.predicate(tx, cursor)}
          order by ${tx.unsafe(seek.orderBy)}
          limit ${sqlLimit(limit)}
        `;
        // Totals over the WHOLE filtered register, so the header does not
        // change as the operator pages — and computed ONLY for the first
        // page. A request carrying a cursor is continuing a walk whose
        // totals the screen already has and does not redraw, so recounting
        // is an aggregate over every row the caller may see to answer a
        // question nobody re-asked.
        /* Zoho's Void is a cancelled document: it is part of the record,
           it stays in the register and it is stored verbatim, but it
           billed nobody anything, so adding it to "what we have billed"
           would overstate the history by whatever was cancelled. Compared
           case-insensitively, because that column is the export's own
           spelling. A DISPUTED invoice is excluded from the same sum for
           the parallel reason (ruling 21) — see the filter below. */
        const totalRows =
          cursor !== null
            ? []
            : await tx<
                {
                  invoice_count: number;
                  linked_count: number;
                  total_value: string;
                  tally_sourced_count: number;
                  disputed_count: number;
                  disputed_unresolved_count: number;
                  earliest_date: string | null;
                  latest_date: string | null;
                }[]
              >`
                select count(*)::int as invoice_count,
                       count(i.work_id)::int as linked_count,
                       count(*) filter (
                         where i.source = 'tally')::int as tally_sourced_count,
                       count(*) filter (
                         where ${disputedAtAll})::int as disputed_count,
                       count(*) filter (
                         where ${disputedInvoice})::int as disputed_unresolved_count,
                       /* Void invoices are out of the SUM and out of
                          nothing else, and so are disputed ones — the
                          first billed nobody anything and the second is
                          a figure the two systems do not agree on
                          (ruling 21). Both stay on the register, and the
                          header says what the total leaves out. */
                       coalesce(sum(i.total) filter (
                         where lower(coalesce(i.zoho_status, '')) <> 'void'
                           and not ${disputedInvoice}
                       ), 0)::text as total_value,
                       -- The span of the filtered register, so the
                       -- screen's financial-year filter offers every year
                       -- the register actually covers rather than the
                       -- years one page of it happened to contain.
                       min(i.invoice_date)::text as earliest_date,
                       max(i.invoice_date)::text as latest_date
                from imported_invoices i
                where ${filters}
              `;
        const totals = totalRows[0] ?? null;
        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          invoices: page.rows.map(toInvoice),
          nextCursor: seek.tag(page.nextCursor),
          totals:
            totals === null
              ? null
              : {
                  invoiceCount: totals.invoice_count,
                  linkedCount: totals.linked_count,
                  totalValue: totals.total_value,
                  tallySourcedCount: totals.tally_sourced_count,
                  disputedCount: totals.disputed_count,
                  disputedUnresolvedCount: totals.disputed_unresolved_count,
                  earliestDate: totals.earliest_date,
                  latestDate: totals.latest_date,
                },
        };
      });
    },
  );

  /* --- one invoice -------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/imported-invoices/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: ImportedInvoiceDetailSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, tenantSnapshot }) => {
      const { id } = request.params;
      return await tenantSnapshot(async (tx) => {
        const invoice = await readInvoice(tx, id);
        if (invoice.work_id !== null) {
          // The same 404 the register's own predicate would produce, from
          // the same helper every Work-addressed route uses — so reading a
          // forbidden invoice by id is indistinguishable from reading one
          // that does not exist.
          await assertWorkAccess(tx, user.id, invoice.work_id);
        }
        // THE SHARED READING, not a second one assembled here. This route
        // built its own `{ invoice, lines }` and was the one place that
        // did not gain `tallyLinks` when the detail did — which surfaced
        // as a 500 from response validation rather than as a missing
        // field, because a response that fails its own schema is an
        // internal error with nothing named.
        return await readImportedInvoiceDetail(tx, id);
      });
    },
  );

  /* --- importing ---------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imported-invoices/import',
      schema: {
        querystring: ImportedInvoiceUploadQuerySchema,
        response: { 200: ImportedInvoiceImportResultSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
      bodyLimit: MAX_CSV_UPLOAD_BYTES,
    },
    async ({ request, user, organisationId, tenant }) => {
      const { bytes } = consumeUpload(request.body, {
        format: 'csv',
        description: 'the Zoho Books invoice export',
        code: 'ZOHO_EXPORT_UNREADABLE',
      });
      // STRIP FIRST, THEN TRIM, for `imports.ts`'s reason: the other order
      // lets a control character survive the blank check and then vanish,
      // leaving an untrimmed value for a CHECK to refuse as a 500.
      const filename = requireTrimmed(
        request.query.filename.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''),
        'Name the file being imported.',
      );

      // AUTHORISE BEFORE ANYTHING EXPENSIVE TOUCHES THE BYTES, which is the
      // order every other upload route keeps: an empty bound transaction
      // runs the membership, role and authority checks, so an
      // unauthenticated stranger's file never reaches the scanner or the
      // parser.
      await tenant(() => Promise.resolve());
      await assertNotMalware(malwareScanner, bytes);

      // NOT UTF-8 IS A REFUSAL, not something to import. `toString('utf8')`
      // never fails: a byte sequence it cannot decode becomes U+FFFD, so a
      // file saved as Windows-1252 — which is what Excel writes when an
      // operator opens the export and re-saves it — imports cleanly with a
      // replacement character wherever a rupee sign, a dash or an accented
      // name was. Nothing downstream can tell that from a customer whose
      // name genuinely contains one, and the register is immutable, so the
      // mojibake is permanent. Cheaper to say so now, with the remedy.
      const text = bytes.toString('utf8');
      if (text.includes('�')) {
        throw httpError(
          400,
          'ZOHO_EXPORT_UNREADABLE',
          'That file is not UTF-8 text, so some characters in it cannot be read. Export the invoice register from Zoho Books again and upload it without opening and re-saving it in Excel.',
        );
      }

      let parsed: ZohoInvoice[];
      try {
        parsed = readZohoInvoiceCsv(text);
      } catch (cause: unknown) {
        if (cause instanceof ZohoInvoiceImportError) {
          throw httpError(
            400,
            'ZOHO_EXPORT_UNREADABLE',
            `Row ${String(cause.rowNumber)}: ${cause.message}`,
          );
        }
        if (cause instanceof CsvParseError) {
          throw httpError(400, 'ZOHO_EXPORT_UNREADABLE', cause.message);
        }
        throw cause;
      }

      const commit = request.query.mode === 'commit';
      return await tenant(async (tx) => {
        const works = await candidateWorks(tx, user.id);
        const contacts = await candidateContacts(tx);

        // LIVE ROWS ONLY, which is the same predicate the partial unique
        // index carries. A discarded invoice is one the operator withdrew
        // in order to import a corrected copy; counting it as present
        // would answer that corrected import with "already imported",
        // write nothing, and report success — leaving the register holding
        // only the withdrawn row. The index and this check have to agree
        // about what "already there" means, or the preview describes a
        // different import from the one the commit performs.
        const existing = new Set(
          (
            await tx<{ zoho_invoice_id: string }[]>`
              select zoho_invoice_id from imported_invoices
              where zoho_invoice_id = any(${tx.array(
                parsed.map((invoice) => invoice.zohoInvoiceId),
              )}::text[])
                and discarded_at is null
            `
          ).map((row) => row.zoho_invoice_id),
        );

        const workById = new Map(works.map((work) => [work.id, work]));
        const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
        const judged = parsed.map((invoice) => {
          const proposal: WorkLinkProposal | null = proposeWorkLink(invoice, works);
          const contact = matchContact(invoice, contacts);
          return { invoice, proposal, contact };
        });

        const fresh = judged.filter(
          ({ invoice }) => !existing.has(invoice.zohoInvoiceId),
        );

        let importedCount = 0;
        if (commit && fresh.length > 0) {
          // ONE STATEMENT for the invoices and one for the lines. A
          // per-invoice loop over 638 rows inside a transaction is exactly
          // what `test/query-write-loop-census.test.ts` exists to prevent,
          // and there is nothing to isolate here: `on conflict do nothing`
          // makes a row that lost a race to a concurrent upload a skip
          // rather than a failure.
          // The column list is the keys of the row objects rather than a
          // written-out spread, and that is a deliberate departure from
          // `imports.ts` next door: the driver's typed helper runs out of
          // overloads well below this table's twenty-six columns, and a
          // hand-written list of twenty-six identifiers is a
          // missing-comma bug waiting to be found by a customer. Every row
          // is built by the same expression, so every row has the same
          // keys, and each value is an explicit null rather than an
          // omission — which is the property that makes deriving the
          // columns from the first row safe.
          const inserted = await tx<{ id: string; zoho_invoice_id: string }[]>`
            insert into imported_invoices ${tx(
              fresh.map(({ invoice, proposal, contact }) => ({
                organisation_id: organisationId,
                // Stated rather than left to the column default (0119),
                // because the shape check ties it to `zoho_invoice_id`
                // and a reader of this insert should see which half of
                // the register it writes.
                source: 'zoho',
                zoho_invoice_id: invoice.zohoInvoiceId,
                invoice_number: invoice.invoiceNumber,
                invoice_date: invoice.invoiceDate,
                customer_zoho_id: invoice.customerZohoId,
                customer_name: invoice.customerName,
                customer_gstin: invoice.customerGstin,
                place_of_supply: invoice.placeOfSupply,
                contact_id: contact?.contactId ?? null,
                contact_match_method: contact?.method ?? null,
                zoho_status: invoice.zohoStatus,
                irn: invoice.irn,
                ack_number: invoice.ackNumber,
                ack_date: invoice.ackDate,
                qr_payload: invoice.qrPayload,
                reference_text: invoice.referenceText,
                sub_total: invoice.subTotal,
                total: invoice.total,
                balance: invoice.balance,
                round_off: invoice.roundOff,
                work_id: proposal?.workId ?? null,
                link_method: proposal?.method ?? null,
                linked_by_user_id: proposal === null ? null : user.id,
                linked_at: proposal === null ? null : new Date().toISOString(),
                raw_row: tx.json(invoice.rawRow as never),
                imported_by_user_id: user.id,
              })),
            )}
            -- The inference clause names the PARTIAL index, because that
            -- is the constraint being deferred to: without the WHERE,
            -- PostgreSQL finds no matching arbiter and the statement is a
            -- 42P10 rather than a skip.
            on conflict (organisation_id, zoho_invoice_id)
              where discarded_at is null
              do nothing
            returning id, zoho_invoice_id
          `.catch(rethrowWriteRefusal);

          // Mapped by Zoho id rather than by position: `returning` states
          // no order, and `do nothing` may drop rows out of the middle.
          const idOf = new Map(
            inserted.map((row) => [row.zoho_invoice_id, row.id] as const),
          );
          importedCount = inserted.length;

          const lineRows = fresh.flatMap(({ invoice }) => {
            const invoiceId = idOf.get(invoice.zohoInvoiceId);
            if (invoiceId === undefined) return [];
            return invoice.lines.map((line) => ({
              organisation_id: organisationId,
              imported_invoice_id: invoiceId,
              position: line.position,
              item_name: line.itemName,
              item_description: line.itemDescription,
              quantity: line.quantity,
              usage_unit: line.usageUnit,
              item_price: line.itemPrice,
              item_total: line.itemTotal,
              hsn_sac: line.hsnSac,
              supply_type: line.supplyType,
              cgst_rate: line.cgstRate,
              sgst_rate: line.sgstRate,
              igst_rate: line.igstRate,
              cgst_amount: line.cgstAmount,
              sgst_amount: line.sgstAmount,
              igst_amount: line.igstAmount,
              raw_row: tx.json(line.rawRow as never),
            }));
          });
          if (lineRows.length > 0) {
            await tx`
              insert into imported_invoice_lines ${tx(lineRows)}
            `.catch(rethrowWriteRefusal);
          }

          // ONE AUDIT EVENT PER IMPORTED INVOICE, in one statement. The
          // filename rides in the payload, which is what turns "where did
          // this invoice come from" into a question answerable from the
          // invoice rather than only from whoever ran the import.
          //
          // Written as an INSERT … SELECT over two unnested arrays rather
          // than through the driver's row helper, and the shape is not a
          // preference. `test/audit-timeline-census.test.ts` reads this
          // server's source for the action and entity type of every
          // audit_events write, and it can only read them where the two
          // literals sit side by side. A row-helper build puts an object
          // key between them, which makes the site unreadable — and an
          // unreadable site is a hole in the census, which is the one
          // thing that census exists to refuse.
          const auditIds: string[] = [];
          const auditDetails: string[] = [];
          for (const { invoice, proposal } of fresh) {
            const invoiceId = idOf.get(invoice.zohoInvoiceId);
            if (invoiceId === undefined) continue;
            auditIds.push(invoiceId);
            auditDetails.push(
              JSON.stringify({
                filename,
                zohoInvoiceId: invoice.zohoInvoiceId,
                invoiceNumber: invoice.invoiceNumber,
                workId: proposal?.workId ?? null,
                linkMethod: proposal?.method ?? null,
              }),
            );
          }
          if (auditIds.length > 0) {
            await tx`
              insert into audit_events (
                organisation_id, actor_user_id, action, entity_type,
                entity_id, details
              )
              select ${organisationId}, ${user.id},
                     'imported_invoice.imported', 'imported_invoices',
                     v.entity_id::uuid, v.details::jsonb
              from unnest(
                ${tx.array(auditIds)}::uuid[],
                ${tx.array(auditDetails)}::text[]
              ) as v(entity_id, details)
            `;
          }
        }

        const unmatched = [
          ...new Set(
            fresh
              .filter(({ contact }) => contact === null)
              .map(({ invoice }) => invoice.customerName),
          ),
        ].sort();

        return {
          mode: request.query.mode,
          filename,
          invoiceCount: parsed.length,
          lineCount: parsed.reduce((total, invoice) => total + invoice.lines.length, 0),
          alreadyImportedCount: parsed.length - fresh.length,
          proposedLinkCount: fresh.filter(({ proposal }) => proposal !== null).length,
          unlinkedCount: fresh.filter(({ proposal }) => proposal === null).length,
          matchedContactCount: fresh.filter(({ contact }) => contact !== null).length,
          importedCount,
          invoices: judged.map(({ invoice, proposal, contact }) => ({
            zohoInvoiceId: invoice.zohoInvoiceId,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            customerName: invoice.customerName,
            total: invoice.total,
            alreadyImported: existing.has(invoice.zohoInvoiceId),
            workId: proposal?.workId ?? null,
            workCode:
              proposal === null
                ? null
                : (workById.get(proposal.workId)?.workCode ?? null),
            linkMethod: proposal?.method ?? null,
            linkEvidence: proposal?.evidence.slice(0, 300) ?? null,
            contactId: contact?.contactId ?? null,
            contactName:
              contact === null
                ? null
                : (contactById.get(contact.contactId)?.name ?? null),
          })),
          unmatchedCustomers: unmatched,
        };
      });
    },
  );

  /* --- the two annotations ------------------------------------------------ */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imported-invoices/:id/link',
      schema: {
        params: IdParamsSchema,
        body: RelinkImportedInvoiceSchema,
        response: { 200: ImportedInvoiceDetailSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return await tenant(async (tx) => {
        // INSIDE the bound transaction, not before it. A body check that
        // runs ahead of the membership wall answers 400 to a stranger
        // where every other tenant route answers 403 — which is a
        // difference an unauthorised caller can read, and which
        // `test/route-inventory.integration.test.ts` sweeps every route
        // for. It caught exactly this.
        if (body.workId === undefined && body.contactId === undefined) {
          throw httpError(
            400,
            'IMPORTED_INVOICE_LINK_EMPTY',
            'Send a Work, a customer, or null for either, to change what this invoice is filed against.',
          );
        }
        const invoice = await readInvoiceForUpdate(tx, id);
        if (invoice.discarded_at !== null) {
          throw httpError(
            409,
            'IMPORTED_INVOICE_DISCARDED',
            'This historical invoice was discarded, so it cannot be filed against anything.',
          );
        }
        // BOTH ENDS OF THE MOVE. Access to the Work it is going TO is the
        // obvious check; access to the one it is coming FROM is the one a
        // route forgets, and without it an 'assigned'-scoped member could
        // unfile an invoice from a Work they may not see.
        if (invoice.work_id !== null)
          await assertWorkAccess(tx, user.id, invoice.work_id);
        if (body.workId !== undefined && body.workId !== null) {
          await assertWorkAccess(tx, user.id, body.workId);
          // AND THAT IT IS STILL A WORK. `assertWorkAccess` answers "may
          // this member see it", which a superseded Work (0071) still
          // passes — so without this an invoice could be filed against a
          // contract the workspace no longer lists, producing a register
          // row whose only link is to a 404. The same `deleted_at is null`
          // the importer's own candidate list applies, so a person cannot
          // reach by hand a Work the proposal would never have offered.
          const [live] = await tx<{ id: string }[]>`
            select id from works where id = ${body.workId} and deleted_at is null
          `;
          if (!live) {
            throw httpError(
              404,
              'WORK_NOT_FOUND',
              'That Work has been withdrawn, so nothing can be filed against it.',
            );
          }
        }
        if (body.contactId !== undefined && body.contactId !== null) {
          const [contact] = await tx<{ id: string }[]>`
            select id from contacts where id = ${body.contactId} and active
          `;
          if (!contact) {
            throw httpError(
              404,
              'CONTACT_NOT_FOUND',
              'No such customer in the contacts master.',
            );
          }
        }

        /* OMITTING A HALF LEAVES IT ALONE — its provenance included.
           The contract says so and the earlier reading did not honour it:
           it recomputed BOTH halves from the merged value, so a request
           that only moved the Work also restamped the contact link as a
           person's manual choice and, worse, overwrote a `gstin` match
           with `name`. A relink that rewrites provenance nobody asked it
           to touch destroys the only record of how a link was arrived at,
           which is the thing that makes the link auditable at all.

           So each half is written only when its key was PRESENT in the
           body, and the provenance columns move with the value they
           describe. A link set here is `manual` on both sides: a person
           chose it, and recording that as `name` would claim an automatic
           match that never happened. */
        const relinkWork = body.workId !== undefined;
        const relinkContact = body.contactId !== undefined;
        const nextWork = relinkWork ? body.workId : invoice.work_id;
        const nextContact = relinkContact ? body.contactId : invoice.contact_id;
        await tx`
          update imported_invoices
          set work_id = case when ${relinkWork} then ${nextWork ?? null}::uuid
                             else work_id end,
              link_method = case
                when not ${relinkWork} then link_method
                when ${nextWork ?? null}::uuid is null then null
                else 'manual' end,
              linked_by_user_id = case
                when not ${relinkWork} then linked_by_user_id
                when ${nextWork ?? null}::uuid is null then null
                else ${user.id} end,
              linked_at = case
                when not ${relinkWork} then linked_at
                when ${nextWork ?? null}::uuid is null then null
                else now() end,
              contact_id = case when ${relinkContact} then ${nextContact ?? null}::uuid
                                else contact_id end,
              contact_match_method = case
                when not ${relinkContact} then contact_match_method
                when ${nextContact ?? null}::uuid is null then null
                else 'manual' end
          where id = ${id}
        `.catch(rethrowWriteRefusal);

        await audit(
          tx,
          organisationId,
          user.id,
          'imported_invoice.relinked',
          'imported_invoices',
          id,
          {
            workId: nextWork,
            previousWorkId: invoice.work_id,
            contactId: nextContact,
            previousContactId: invoice.contact_id,
          },
        );
        return await readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imported-invoices/:id/discard',
      schema: {
        params: IdParamsSchema,
        body: DiscardImportedInvoiceSchema,
        response: { 200: ImportedInvoiceDetailSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const reason = requireTrimmed(
        request.body.reason,
        'Say why this historical invoice is being withdrawn.',
      );
      return await tenant(async (tx) => {
        const invoice = await readInvoiceForUpdate(tx, id);
        if (invoice.discarded_at !== null) {
          throw httpError(
            409,
            'IMPORTED_INVOICE_DISCARDED',
            'This historical invoice has already been discarded.',
          );
        }
        if (invoice.work_id !== null)
          await assertWorkAccess(tx, user.id, invoice.work_id);
        await tx`
          update imported_invoices
          set discarded_at = now(), discarded_by_user_id = ${user.id},
              discard_reason = ${reason}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'imported_invoice.discarded',
          'imported_invoices',
          id,
          { reason },
        );
        return await readDetail(tx, id);
      });
    },
  );
}

/* --- reads shared by the routes above --------------------------------------- */

async function readInvoice(tx: TransactionSql, id: string): Promise<InvoiceRow> {
  const [row] = await tx<InvoiceRow[]>`
    select ${tx.unsafe(INVOICE_COLUMNS)}
    from imported_invoices i
    left join works w on w.id = i.work_id
    left join contacts c on c.id = i.contact_id
    ${tx.unsafe(TALLY_LINK_JOIN)}
    where i.id = ${id}
  `;
  if (!row) {
    throw httpError(404, 'IMPORTED_INVOICE_NOT_FOUND', 'No such historical invoice.');
  }
  return row;
}

/** The same read under the row lock, for the two routes that write. Taken
 * before either check so a concurrent discard cannot land between the read
 * and the update. */
async function readInvoiceForUpdate(
  tx: TransactionSql,
  id: string,
): Promise<InvoiceRow> {
  const [locked] = await tx<{ id: string }[]>`
    select id from imported_invoices where id = ${id} for update
  `;
  if (!locked) {
    throw httpError(404, 'IMPORTED_INVOICE_NOT_FOUND', 'No such historical invoice.');
  }
  return await readInvoice(tx, id);
}

/**
 * One historical invoice, its lines, and the TallyPrime correspondences
 * it carries (0119).
 *
 * EXPORTED because the Tally route's resolution act answers with it: a
 * person rules on a disagreement and gets back the invoice as it now
 * stands, including whether it has rejoined the billed total. Building a
 * second reading of the same record there would let the two drift.
 */
export async function readImportedInvoiceDetail(tx: TransactionSql, id: string) {
  const invoice = await readInvoice(tx, id);
  const lines = await tx<LineRow[]>`
    select ${tx.unsafe(LINE_COLUMNS)} from imported_invoice_lines
    where imported_invoice_id = ${id}
    order by position
  `;
  const links = await tx<TallyLinkRow[]>`
    select id, tally_guid, tally_voucher_type,
           tally_voucher_date::text as tally_voucher_date,
           tally_voucher_number, tally_reference, tally_party_ledger,
           tally_amount, match_method, match_evidence, disputed,
           component_tally_total, component_invoice_total, resolution, resolved_at
    from tally_invoice_links
    where imported_invoice_id = ${id}
    order by tally_voucher_date, tally_guid
  `;
  return {
    invoice: toInvoice(invoice),
    lines: lines.map(toLine),
    tallyLinks: links.map(toTallyLink),
  };
}

async function readDetail(tx: TransactionSql, id: string) {
  return await readImportedInvoiceDetail(tx, id);
}
