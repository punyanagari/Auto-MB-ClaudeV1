import { createHash, randomUUID } from 'node:crypto';
import {
  BillingBaselineMeasurementQuerySchema,
  BillingBaselineUploadQuerySchema,
  ConfirmBillingBaselineLineRequestSchema,
  SetBillingBaselineLinesRequestSchema,
  SetWorkDeductionsRequestSchema,
  WorkBillingBaselineResponseSchema,
  type BillingBaselineBillSource,
  type DeductionHead,
  type WorkBillingBaseline,
  type WorkBillingBaselineLine,
  type WorkBillingBaselineResponse,
  type WorkDeductionEntry,
  type WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import {
  extractPdfText,
  PdfToTextConfigurationError,
  type ObjectStorage,
} from '@auto-mb/documents';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { proposeBaselineLine } from '../billing-baseline-propose.js';
import { httpError } from '../http.js';
import { addDecimalStrings } from '../mb-remark.js';
import { subtractDecimalStrings } from '../mb-compute.js';
import type { MalwareScanner } from '../malware-scan.js';
import {
  loadPaymentMatrix,
  resolvePaymentPercentages,
  type PaymentMatrixPercentages,
} from '../payment-matrix.js';
import { parseRailwayMeasurement } from '../railway-measurement-parse.js';
import { canonicalRateText } from '../rate-text.js';
import {
  parseReceivedRailwayBill,
  RailwayBillParseError,
} from '../railway-bill-parse.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import { audit, upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * The opening billing position of a pre-system Work (migration 0114;
 * owner ruling, live-testing corrections item 23).
 *
 * ## The shape of the flow, in the order an operator meets it
 *
 *   1. upload the LAST RAILWAY BILL. The document that says what has been
 *      paid, read by 0066's own machinery. A bill this product cannot read
 *      is recorded with its four figures typed instead — 0111's
 *      `unreadable` posture applied one document further back.
 *   2. upload the LAST MEASUREMENT SHEET, optionally. What the payments
 *      were FOR, item by item; read by 0111's parser and turned into a
 *      per-item proposal by `billing-baseline-propose.ts`.
 *   3. correct any line that needs it, then confirm each one BY NAME.
 *   4. lock. From that moment the Measurement Book engine adds these
 *      figures to its prior-cumulative memory and the Work's MB counter
 *      resumes at the railway's own sequence plus one.
 *
 * ## Two layers, as everywhere else in this tree
 *
 * Every rule below is refused here with a named 409 and again in the
 * database by migration 0114's guards (23W01..23W06). The route exists so
 * an operator gets a sentence and a remedy; the guards exist because a
 * route is one forgotten import away from being no rule at all, and this
 * is money.
 *
 * ## The authority
 *
 * `issue`, which is the authority every other settlement document in this
 * tree runs under (0066's bill, 0111's measurement). One authority
 * uploads and confirms, exactly as 0111 § "TWO THINGS THIS MODEL DOES NOT
 * DO" records for itself and for the same reason: in a two-person agency
 * a separation of duties can mean nobody may confirm anything. Splitting
 * it needs an owner ruling, not a pack's decision.
 */

interface BaselineRow {
  id: string;
  work_id: string;
  bill_number: string;
  bill_date: string;
  bill_amount: string;
  bill_source: BillingBaselineBillSource;
  bill_filename: string;
  bill_sha256: string;
  last_mb_sequence_number: number;
  measurement_filename: string | null;
  locked_at: Date | null;
  locked_by_user_id: string | null;
  created_at: Date;
}

const BASELINE_COLUMNS = `
  b.id, b.work_id, b.bill_number, b.bill_date::text as bill_date,
  b.bill_amount::text as bill_amount, b.bill_source, b.bill_filename,
  b.bill_sha256, b.last_mb_sequence_number, b.measurement_filename,
  b.locked_at, b.locked_by_user_id, b.created_at
`;

function toBaseline(row: BaselineRow): WorkBillingBaseline {
  return {
    id: row.id,
    workId: row.work_id,
    billNumber: row.bill_number,
    billDate: row.bill_date,
    billAmount: row.bill_amount,
    billSource: row.bill_source,
    billFilename: row.bill_filename,
    billSha256: row.bill_sha256,
    lastMbSequenceNumber: row.last_mb_sequence_number,
    measurementFilename: row.measurement_filename,
    lockedAt: row.locked_at?.toISOString() ?? null,
    lockedByUserId: row.locked_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

interface LineRow {
  work_item_id: string;
  item_number: string;
  description: string;
  unit_code: string;
  prior_supplied: string;
  prior_installed: string;
  prior_pac: string;
  prior_final_bill: string;
  amount: string;
  proposed_supplied: string | null;
  proposed_installed: string | null;
  proposed_pac: string | null;
  proposed_final_bill: string | null;
  proposed_amount: string | null;
  proposed_from_remark: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: Date | null;
}

async function readBaseline(
  tx: TransactionSql,
  workId: string,
): Promise<BaselineRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${BASELINE_COLUMNS} from work_billing_baselines b where b.work_id = $1`,
    [workId],
  )) as unknown as BaselineRow[];
  return rows[0];
}

async function readBaselineById(
  tx: TransactionSql,
  id: string,
  lock: boolean,
): Promise<BaselineRow | undefined> {
  const rows = (await tx.unsafe(
    `select ${BASELINE_COLUMNS} from work_billing_baselines b where b.id = $1${
      lock ? ' for update' : ''
    }`,
    [id],
  )) as unknown as BaselineRow[];
  return rows[0];
}

async function readLines(
  tx: TransactionSql,
  baselineId: string,
): Promise<WorkBillingBaselineLine[]> {
  const rows = await tx<LineRow[]>`
    select l.work_item_id, wi.item_number, wi.description, wi.unit_code,
           l.prior_supplied::text as prior_supplied,
           l.prior_installed::text as prior_installed,
           l.prior_pac::text as prior_pac,
           l.prior_final_bill::text as prior_final_bill,
           l.amount::text as amount,
           l.proposed_supplied::text as proposed_supplied,
           l.proposed_installed::text as proposed_installed,
           l.proposed_pac::text as proposed_pac,
           l.proposed_final_bill::text as proposed_final_bill,
           l.proposed_amount::text as proposed_amount,
           l.proposed_from_remark,
           l.confirmed_by_user_id, l.confirmed_at
    from work_billing_baseline_lines l
    join work_items wi on wi.id = l.work_item_id
    where l.work_billing_baseline_id = ${baselineId}
    order by wi.item_number
  `;
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    description: row.description,
    unitCode: row.unit_code,
    priorSupplied: row.prior_supplied,
    priorInstalled: row.prior_installed,
    priorPac: row.prior_pac,
    priorFinalBill: row.prior_final_bill,
    amount: row.amount,
    proposedSupplied: row.proposed_supplied,
    proposedInstalled: row.proposed_installed,
    proposedPac: row.proposed_pac,
    proposedFinalBill: row.proposed_final_bill,
    proposedAmount: row.proposed_amount,
    proposedFromRemark: row.proposed_from_remark,
    confirmedByUserId: row.confirmed_by_user_id,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
  }));
}

async function readDeductions(
  tx: TransactionSql,
  workId: string,
): Promise<WorkDeductionEntry[]> {
  const rows = await tx<
    {
      head: DeductionHead;
      amount: string;
      note: string | null;
      recorded_by_user_id: string;
      updated_at: Date;
    }[]
  >`
    select head, amount::text as amount, note, recorded_by_user_id, updated_at
    from work_deduction_entries
    where work_id = ${workId}
    order by head
  `;
  return rows.map((row) => ({
    head: row.head,
    amount: row.amount,
    note: row.note,
    recordedByUserId: row.recorded_by_user_id,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * The whole opening position of one Work, and the receivables arithmetic
 * derived from it.
 *
 * Derived HERE rather than on the screen, for the reason every money
 * figure in this product is: `apps/web` renders and does not compute
 * (AGENTS.md § Architecture boundaries), and a net receivable computed in
 * two places is two net receivables.
 */
async function readPosition(
  tx: TransactionSql,
  workId: string,
): Promise<WorkBillingBaselineResponse> {
  const baseline = await readBaseline(tx, workId);
  const lines = baseline === undefined ? [] : await readLines(tx, baseline.id);
  // Cancelled counts as numbered, exactly as 0114's guard says: a
  // cancelled book still took a number out of the Work's series.
  const [numbered] = await tx<{ id: string }[]>`
    select id from measurement_books
    where work_id = ${workId} and status in ('finalized', 'cancelled')
    limit 1
  `;
  const deductions = await readDeductions(tx, workId);
  const gross = lines.reduce(
    (total, line) => addDecimalStrings(total, line.amount),
    '0.00',
  );
  const withheld = deductions.reduce(
    (total, entry) => addDecimalStrings(total, entry.amount),
    '0.00',
  );
  const net = subtractDecimalStrings(gross, withheld);
  return {
    baseline: baseline === undefined ? null : toBaseline(baseline),
    openable: numbered === undefined,
    lines,
    deductions,
    grossBilledToDate: gross,
    deductionsTotal: withheld,
    // Floored at zero: deductions exceeding the gross is a data error
    // somebody has to look at, not a negative receivable to be reported
    // as if it were a fact about the contract.
    netReceivable: net.startsWith('-') ? '0.00' : net,
  };
}

/** The 0114 guards, translated into the named refusals a screen can act
 * on. Every one of them is ALSO refused earlier in the handler under a
 * row lock; this is the arm that holds when two operators act at once. */
const BASELINE_SQLSTATES: Readonly<Record<string, readonly [string, string]>> = {
  '23W01': [
    'BILLING_BASELINE_WORK_ALREADY_BILLED',
    'This Work has already finalized a Measurement Book here, so its billing history is recorded in this system and has no opening baseline.',
  ],
  '23W02': [
    'BILLING_BASELINE_LOCKED',
    'This billing baseline is locked; every Measurement Book raised since counts from it.',
  ],
  '23W03': [
    'BILLING_BASELINE_LINES_UNCONFIRMED',
    'Every baseline line has to be confirmed before the opening position can be locked.',
  ],
  '23W04': [
    'BILLING_BASELINE_LOCKED',
    'The lines of a locked billing baseline are frozen.',
  ],
  '23W05': [
    'BILLING_BASELINE_LOCKED',
    'The opening deductions were locked with this Work’s billing baseline.',
  ],
  '23W06': [
    'BILLING_BASELINE_ITEM_NOT_FOUND',
    'A baseline line names an item that is not live on this Work.',
  ],
};

function nameBaselineRefusal(error: unknown): unknown {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    const named = BASELINE_SQLSTATES[error.code];
    if (named !== undefined) {
      return httpError(409, named[0] as never, named[1]);
    }
  }
  return error;
}

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export function registerBillingBaselineRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/billing-baseline',
      schema: {
        params: IdParams,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return readPosition(tx, workId);
      });
    },
  );

  /**
   * The bill upload, which is what creates the baseline.
   *
   * Order of operations is the tree's standard one and it matters:
   * authorise and establish what this document would have to be BEFORE
   * spending a malware scan and a text extraction on it, scan, read, and
   * only then write bytes and a row.
   *
   * A bill whose text cannot be read is not refused. The four figures
   * arrive on the query instead and the row records `bill_source =
   * 'recorded'`, which says on the row itself that a person typed them.
   * What IS refused is a readable bill whose figures are also typed: two
   * claims about one document, with no honest way to pick between them.
   */
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/billing-baseline',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParams,
        querystring: BillingBaselineUploadQuerySchema,
        response: { 201: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: "the Work's last railway bill",
      });
      const { id: workId } = request.params;
      const query = request.query;

      const items = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const existing = await readBaseline(tx, workId);
        if (existing !== undefined) {
          throw httpError(
            409,
            'BILLING_BASELINE_EXISTS',
            'This Work already has an opening billing baseline; delete the draft one or read the locked one.',
          );
        }
        await assertNoSystemHistory(tx, workId);
        return loadPricedItems(tx, workId);
      });

      await assertNotMalware(scanner, body);

      let layoutText = '';
      try {
        layoutText = await extractPdfText(body);
      } catch (error) {
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'The server cannot read PDF text at the moment.',
          );
        }
        // Anything else is a fact about THIS document — a scan, no text
        // layer — which is exactly what the recorded path is for.
      }

      const typed =
        query.billNumber !== undefined ||
        query.billDate !== undefined ||
        query.billAmount !== undefined ||
        query.lastMbSequenceNumber !== undefined;

      let source: BillingBaselineBillSource = 'recorded';
      let extraction: unknown = null;
      let billNumber = query.billNumber ?? '';
      let billDate = query.billDate ?? '';
      let billAmount = query.billAmount ?? '';
      let sequence = query.lastMbSequenceNumber ?? 0;
      try {
        const parsed = parseReceivedRailwayBill(layoutText);
        if (typed) {
          throw httpError(
            409,
            'BILLING_BASELINE_BILL_UNREADABLE',
            `This bill states its own number, date, amount and measurement (${parsed.billNumber}); remove the typed figures and upload it again.`,
          );
        }
        source = 'extracted';
        extraction = parsed;
        billNumber = parsed.billNumber;
        billDate = parsed.billDate;
        billAmount = parsed.billAmount;
        sequence = parsed.measurement.sequence;
      } catch (error) {
        if (error !== null && typeof error === 'object' && 'statusCode' in error) {
          throw error;
        }
        if (!(error instanceof RailwayBillParseError) && !(error instanceof Error)) {
          throw error;
        }
        if (
          query.billNumber === undefined ||
          query.billDate === undefined ||
          query.billAmount === undefined ||
          query.lastMbSequenceNumber === undefined
        ) {
          throw httpError(
            400,
            'BILLING_BASELINE_BILL_UNREADABLE',
            "This bill's own text could not be read, so its number, date, amount and measurement sequence have to be recorded with the upload.",
          );
        }
      }

      const baselineId = randomUUID();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/billingbaseline/${baselineId}.pdf`;
      await storage.put(objectKey, body);

      const position = await tenant(async (tx) => {
        // Re-read under the Work lock: a Measurement Book could have been
        // finalized, or a second baseline started, while the scan and the
        // extraction ran.
        await tx`select id from works where id = ${workId} for update`;
        if ((await readBaseline(tx, workId)) !== undefined) {
          throw httpError(
            409,
            'BILLING_BASELINE_EXISTS',
            'An opening billing baseline was started on this Work while this bill was being read.',
          );
        }
        await assertNoSystemHistory(tx, workId);
        await tx`
          insert into work_billing_baselines (
            id, organisation_id, work_id, bill_object_key, bill_filename,
            bill_sha256, bill_media_type, bill_size_bytes, bill_source,
            bill_extraction, bill_number, bill_date, bill_amount,
            last_mb_sequence_number, created_by_user_id
          )
          values (
            ${baselineId}, ${organisationId}, ${workId}, ${objectKey},
            ${query.filename}, ${sha256}, 'application/pdf', ${body.length},
            ${source},
            ${extraction === null ? null : tx.json(extraction as never)},
            ${billNumber}, ${billDate}, ${billAmount}, ${sequence}, ${user.id}
          )
        `;
        // One line per priced item, empty, in one statement (the
        // finalize.ts unnest pattern). The baseline states a position for
        // EVERY item — a stage left silently at zero because nobody made
        // a row for it is the failure this table exists to prevent — and
        // the confirmation count the lock reads is over exactly these.
        await tx`
          insert into work_billing_baseline_lines (
            organisation_id, work_billing_baseline_id, work_id, work_item_id
          )
          select ${organisationId}, ${baselineId}, ${workId}, item_id
          from unnest(
            ${items.map((item) => item.workItemId)}::uuid[]
          ) as t(item_id)
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.created',
          'work_billing_baselines',
          baselineId,
          { workId, billNumber, billDate, billSource: source, items: items.length },
        );
        return readPosition(tx, workId);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
      return reply.status(201).send(position);
    },
  );

  /**
   * The measurement sheet, and the proposal it produces.
   *
   * Separate from the bill upload rather than folded into it, because the
   * two documents answer different questions and an agency very often has
   * one and not the other. A sheet uploaded here PROPOSES; it never
   * confirms, and it never overwrites a figure an operator has already
   * confirmed — the proposal columns sit beside the stated ones for
   * exactly that reason.
   */
  tenantRoute(
    {
      method: 'POST',
      url: '/api/billing-baselines/:id/measurement',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParams,
        querystring: BillingBaselineMeasurementQuerySchema,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: "the Work's last railway measurement sheet",
      });
      const { id } = request.params;
      const { filename } = request.query;

      const target = await tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id);
        return { workId: baseline.work_id };
      });

      await assertNotMalware(scanner, body);

      let parsed;
      try {
        parsed = parseRailwayMeasurement(await extractPdfText(body));
      } catch (error) {
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'The server cannot read PDF text at the moment.',
          );
        }
        throw httpError(
          400,
          'BILLING_BASELINE_BILL_UNREADABLE',
          "This measurement sheet's item table could not be read; enter the opening lines by hand instead.",
        );
      }

      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/billingbaseline/${id}-measurement.pdf`;
      await storage.put(objectKey, body);

      return tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id, true);
        const items = await loadPricedItems(tx, baseline.work_id);
        // The sheet keys its items the way the railway prints them; the
        // matcher's own normalisation (A/01 and A/1 are one item) is the
        // rule this reuses rather than re-derives.
        const byItem = new Map(
          parsed.items.map((item) => [normaliseItemNumber(item.itemNumber), item]),
        );
        const proposals = items.flatMap((item) => {
          const found = byItem.get(normaliseItemNumber(item.itemNumber));
          if (found === undefined || item.percentages === null) return [];
          const proposal = proposeBaselineLine({
            remark: found.remark,
            percentages: item.percentages,
            effectiveRate: item.effectiveRate,
          });
          if (proposal === null) return [];
          return [{ workItemId: item.workItemId, remark: found.remark, ...proposal }];
        });
        // One statement over every proposed line (the finalize.ts unnest
        // pattern). Confirmed lines are left exactly as they are: a
        // proposal arriving after a person has signed off a figure must
        // not move it, and must not quietly unsign it either.
        if (proposals.length > 0) {
          await tx`
            update work_billing_baseline_lines l set
              proposed_supplied = p.supplied,
              proposed_installed = p.installed,
              proposed_pac = p.pac,
              proposed_final_bill = p.final_bill,
              proposed_amount = p.amount,
              proposed_from_remark = p.remark,
              prior_supplied = p.supplied,
              prior_installed = p.installed,
              prior_pac = p.pac,
              prior_final_bill = p.final_bill,
              amount = p.amount
            from unnest(
              ${proposals.map((entry) => entry.workItemId)}::uuid[],
              ${proposals.map((entry) => entry.priorSupplied)}::numeric(18,3)[],
              ${proposals.map((entry) => entry.priorInstalled)}::numeric(18,3)[],
              ${proposals.map((entry) => entry.priorPac)}::numeric(18,3)[],
              ${proposals.map((entry) => entry.priorFinalBill)}::numeric(18,3)[],
              ${proposals.map((entry) => entry.amount)}::numeric(18,2)[],
              ${proposals.map((entry) => entry.remark)}::text[]
            ) as p(work_item_id, supplied, installed, pac, final_bill, amount, remark)
            where l.work_billing_baseline_id = ${id}
              and l.work_item_id = p.work_item_id
              and l.confirmed_at is null
          `;
        }
        const proposed = proposals.length;
        await tx`
          update work_billing_baselines set
            measurement_object_key = ${objectKey},
            measurement_filename = ${filename},
            measurement_sha256 = ${sha256},
            measurement_size_bytes = ${body.length},
            measurement_extraction = ${tx.json(parsed as never)}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.proposed',
          'work_billing_baselines',
          id,
          {
            workId: target.workId,
            itemsRead: parsed.items.length,
            linesProposed: proposed,
          },
        );
        return readPosition(tx, baseline.work_id);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/billing-baselines/:id/lines',
      schema: {
        params: IdParams,
        body: SetBillingBaselineLinesRequestSchema,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { lines } = request.body;
      // Refused up front rather than resolved by ordering: with the
      // update batched into one statement, two rows for one item would
      // leave "which one won" to the planner.
      if (new Set(lines.map((line) => line.workItemId)).size !== lines.length) {
        throw httpError(
          400,
          'DUPLICATE_ENTRY',
          'Each baseline line appears at most once in a statement.',
        );
      }
      return tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id, true);
        // One statement over every stated line (the finalize.ts unnest
        // pattern). A figure that MOVES loses its confirmation: the
        // confirmation was a statement about the numbers that were there,
        // and carrying it across an edit would put a member's name on a
        // figure they never saw.
        const updated = await tx<{ work_item_id: string }[]>`
          update work_billing_baseline_lines l set
            prior_supplied = v.supplied,
            prior_installed = v.installed,
            prior_pac = v.pac,
            prior_final_bill = v.final_bill,
            amount = v.amount,
            confirmed_by_user_id = case
              when (l.prior_supplied, l.prior_installed, l.prior_pac,
                    l.prior_final_bill, l.amount)
                   is distinct from
                   (v.supplied, v.installed, v.pac, v.final_bill, v.amount)
              then null else l.confirmed_by_user_id end,
            confirmed_at = case
              when (l.prior_supplied, l.prior_installed, l.prior_pac,
                    l.prior_final_bill, l.amount)
                   is distinct from
                   (v.supplied, v.installed, v.pac, v.final_bill, v.amount)
              then null else l.confirmed_at end
          from unnest(
            ${lines.map((line) => line.workItemId)}::uuid[],
            ${lines.map((line) => line.priorSupplied)}::numeric(18,3)[],
            ${lines.map((line) => line.priorInstalled)}::numeric(18,3)[],
            ${lines.map((line) => line.priorPac)}::numeric(18,3)[],
            ${lines.map((line) => line.priorFinalBill)}::numeric(18,3)[],
            ${lines.map((line) => line.amount)}::numeric(18,2)[]
          ) as v(work_item_id, supplied, installed, pac, final_bill, amount)
          where l.work_billing_baseline_id = ${id}
            and l.work_item_id = v.work_item_id
          returning l.work_item_id
        `;
        if (updated.length !== lines.length) {
          throw httpError(
            404,
            'BILLING_BASELINE_ITEM_NOT_FOUND',
            'This opening baseline has no line for that item.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.lines_set',
          'work_billing_baselines',
          id,
          { workId: baseline.work_id, lines: lines.length },
        );
        return readPosition(tx, baseline.work_id);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/billing-baselines/:id/lines/confirm',
      schema: {
        params: IdParams,
        body: ConfirmBillingBaselineLineRequestSchema,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { itemNumber } = request.body;
      return tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id, true);
        const [confirmed] = await tx<{ work_item_id: string }[]>`
          update work_billing_baseline_lines l set
            confirmed_by_user_id = ${user.id},
            confirmed_at = now()
          from work_items wi
          where wi.id = l.work_item_id
            and wi.item_number = ${itemNumber}
            and l.work_billing_baseline_id = ${id}
          returning l.work_item_id
        `;
        if (confirmed === undefined) {
          throw httpError(
            404,
            'BILLING_BASELINE_ITEM_NOT_FOUND',
            'This opening baseline has no line for that item.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.line_confirmed',
          'work_billing_baselines',
          id,
          { workId: baseline.work_id, itemNumber },
        );
        return readPosition(tx, baseline.work_id);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
    },
  );

  /**
   * The lock, and the two things it does beyond setting a timestamp.
   *
   * It moves the Work's Measurement Book counter to the railway's own
   * sequence plus one, so the next book this product numbers continues
   * the series instead of restarting it at 01 beside a railway register
   * already at 04. The counter's own 0003 decrease guard means this can
   * only ever move the series FORWARD, which is the right shape: a
   * baseline can start a Work's numbering late and can never rewind it.
   *
   * And from this moment `computeForBook` adds these lines to its
   * prior-cumulative memory, so the next Measurement Book bills the
   * DELTA over what the railway already paid rather than re-billing the
   * lot.
   */
  tenantRoute(
    {
      method: 'POST',
      url: '/api/billing-baselines/:id/lock',
      schema: {
        params: IdParams,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id, true);
        const unconfirmed = await tx<{ item_number: string }[]>`
          select wi.item_number
          from work_billing_baseline_lines l
          join work_items wi on wi.id = l.work_item_id
          where l.work_billing_baseline_id = ${id} and l.confirmed_at is null
          order by wi.item_number
        `;
        if (unconfirmed.length > 0) {
          throw httpError(
            409,
            'BILLING_BASELINE_LINES_UNCONFIRMED',
            `These baseline lines are not confirmed yet: ${unconfirmed
              .map((row) => row.item_number)
              .join(', ')}.`,
          );
        }
        await assertNoSystemHistory(tx, baseline.work_id);
        await tx`
          update work_billing_baselines
          set locked_at = now(), locked_by_user_id = ${user.id}
          where id = ${id}
        `;
        const next = baseline.last_mb_sequence_number + 1;
        await tx`
          insert into measurement_book_counters (organisation_id, work_id, next_value)
          values (${organisationId}, ${baseline.work_id}, ${next})
          on conflict (organisation_id, work_id) do update
            set next_value = greatest(measurement_book_counters.next_value, ${next})
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.locked',
          'work_billing_baselines',
          id,
          {
            workId: baseline.work_id,
            lastMbSequenceNumber: baseline.last_mb_sequence_number,
            nextMbSequenceNumber: next,
          },
        );
        return readPosition(tx, baseline.work_id);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/billing-baselines/:id',
      schema: { params: IdParams, response: { 204: Type.Null(), ...errorResponses } },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const baseline = await requireUnlocked(tx, user.id, id, true);
        // The lines go with it. An unlocked baseline is a form somebody
        // is filling in, and abandoning one leaves nothing behind — the
        // deductions stay, because they are recorded per Work and are not
        // this document's.
        await tx`
          delete from work_billing_baseline_lines
          where work_billing_baseline_id = ${id}
        `;
        await tx`delete from work_billing_baselines where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'work_billing_baseline.deleted',
          'work_billing_baselines',
          id,
          { workId: baseline.work_id },
        );
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/deductions',
      schema: {
        params: IdParams,
        body: SetWorkDeductionsRequestSchema,
        response: { 200: WorkBillingBaselineResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const { deductions } = request.body;
      const heads = deductions.map((entry) => entry.head);
      if (new Set(heads).size !== heads.length) {
        throw httpError(
          400,
          'DUPLICATE_ENTRY',
          'Each deduction head appears at most once.',
        );
      }
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const baseline = await readBaseline(tx, workId);
        if (baseline?.locked_at != null) {
          throw httpError(
            409,
            'BILLING_BASELINE_LOCKED',
            'The opening deductions were locked with this Work’s billing baseline.',
          );
        }
        // Wholesale: a head left out of the request means nothing was
        // withheld under it, which is a statement and not an omission.
        await tx`
          delete from work_deduction_entries
          where work_id = ${workId} and head <> all(${heads}::text[])
        `;
        if (deductions.length > 0) {
          await tx`
            insert into work_deduction_entries (
              organisation_id, work_id, head, amount, note, recorded_by_user_id
            )
            select ${organisationId}, ${workId}, t.head, t.amount, t.note, ${user.id}
            from unnest(
              ${deductions.map((entry) => entry.head)}::text[],
              ${deductions.map((entry) => entry.amount)}::numeric(18,2)[],
              ${deductions.map((entry) => entry.note ?? null)}::text[]
            ) as t(head, amount, note)
            on conflict (organisation_id, work_id, head) do update
              set amount = excluded.amount,
                  note = excluded.note,
                  recorded_by_user_id = excluded.recorded_by_user_id
          `;
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'work_deduction_entry.recorded',
          'work_deduction_entries',
          // Keyed on the WORK, like work_retention_terms: there is one
          // opening deduction position per Work rather than a document
          // per act, and the timeline reads it by that key.
          workId,
          { workId, heads },
        );
        return readPosition(tx, workId);
      }).catch((error: unknown) => {
        throw nameBaselineRefusal(error);
      });
    },
  );
}

/** `A/01` and `A/1` are one item — the railway zero-pads and this
 * product's schedules do not. The same fold `railway-measurement-match.ts`
 * applies, and deliberately no more of one: a schedule letter is not a
 * number and `A/1` must never read as `B/1`. */
function normaliseItemNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? String(Number(segment)) : segment))
    .join('/');
}

interface PricedItem {
  readonly workItemId: string;
  readonly itemNumber: string;
  readonly effectiveRate: string;
  /** Null where the item's category resolves through no matrix row —
   * exactly the state a draft Measurement Book warns about. Such an item
   * still gets a baseline LINE; it simply gets no proposal, because there
   * are no percentages to attribute the railway's remark to. */
  readonly percentages: PaymentMatrixPercentages | null;
}

async function loadPricedItems(
  tx: TransactionSql,
  workId: string,
): Promise<readonly PricedItem[]> {
  const matrix = await loadPaymentMatrix(tx, workId);
  const rows = await tx<
    {
      id: string;
      item_number: string;
      payment_category: string | null;
      effective_rate: string;
    }[]
  >`
    select wi.id, wi.item_number, wi.payment_category,
           coalesce(wi.effective_unit_rate, wi.effective_rate)::text as effective_rate
    from work_items wi
    where wi.work_id = ${workId} and wi.deleted_at is null
    order by wi.item_number
  `;
  return rows.map((row) => {
    const resolution = resolvePaymentPercentages(
      matrix,
      row.payment_category as WorkItemPaymentCategory | null,
    );
    return {
      workItemId: row.id,
      itemNumber: row.item_number,
      effectiveRate: canonicalRateText(row.effective_rate),
      percentages: resolution.resolved ? resolution.percentages : null,
    };
  });
}

/**
 * The rule that keeps a baseline from becoming a back door into a live
 * Work's history: an opening position states what happened BEFORE this
 * product, so a Work that has numbered a Measurement Book here has
 * nothing to open.
 *
 * A CANCELLED book counts as well as a finalized one — it still took a
 * number out of the Work's series — which is exactly what 0114's guard
 * says, in the same words.
 */
async function assertNoSystemHistory(
  tx: TransactionSql,
  workId: string,
): Promise<void> {
  const [book] = await tx<{ mb_number: string | null }[]>`
    select mb_number from measurement_books
    where work_id = ${workId} and status in ('finalized', 'cancelled')
    order by sequence_number
    limit 1
  `;
  if (book) {
    throw httpError(
      409,
      'BILLING_BASELINE_WORK_ALREADY_BILLED',
      `This Work has already numbered Measurement Book ${book.mb_number ?? ''} in this system, so its billing history is recorded here and has no opening baseline.`,
    );
  }
}

async function requireUnlocked(
  tx: TransactionSql,
  userId: string,
  id: string,
  lock = false,
): Promise<BaselineRow> {
  const baseline = await readBaselineById(tx, id, lock);
  if (baseline === undefined) {
    throw httpError(
      404,
      'BILLING_BASELINE_NOT_FOUND',
      'No such opening billing baseline.',
    );
  }
  await assertWorkAccess(tx, userId, baseline.work_id);
  if (baseline.locked_at !== null) {
    throw httpError(
      409,
      'BILLING_BASELINE_LOCKED',
      'This billing baseline is locked; every Measurement Book raised since counts from it.',
    );
  }
  return baseline;
}
