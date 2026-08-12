import {
  ApiErrorSchema,
  BudgetaryQuotationDetailResponseSchema,
  BudgetaryQuotationListResponseSchema,
  CreateBudgetaryQuotationRequestSchema,
  SaveBudgetaryQuotationLinesRequestSchema,
  SetBudgetaryQuotationOutcomeRequestSchema,
  type BudgetaryQuotation,
  type BudgetaryQuotationDetailResponse,
  type BudgetaryQuotationLine,
  type BudgetaryQuotationLineInput,
  type CreateBudgetaryQuotationRequest,
  type SaveBudgetaryQuotationLinesRequest,
  type SetBudgetaryQuotationOutcomeRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { requireAuthority, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../number-series.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { canonicalRateText } from '../rate-text.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/**
 * Budgetary quotations (migration 0033; legacy spec §5.8).
 *
 * A priced offer made OUTWARD, before any award: to a private customer,
 * or to a railway officer assembling a tender's schedule. It carries NO
 * Work — a BQ normally precedes the award that would create one — so
 * nothing here touches `works`, `work_items`, or `assertWorkAccess`; the
 * organisation binding is the only scope there is.
 *
 * Lifecycle, in the delivery challan's posture throughout:
 *
 *   draft  -> issued (gapless `BQ-NN` per ORGANISATION, taken under the
 *             counter row lock, the customer snapshotted and the total
 *             frozen)
 *   issued -> expired | converted | withdrawn
 *
 * There is no cancellation and no deletion after issue: an offer that
 * lapsed is `expired`, one that won is `converted`, one the contractor
 * took back is `withdrawn`, and all three keep the number forever
 * (engineering rule 8). Only a draft can be edited or deleted; the 0033
 * `budgetary_quotation_lines_draft_only` trigger backstops the line half
 * of that against every writer, and the routes refuse first so the
 * operator reads a 409 rather than a raw trigger message.
 *
 * MONEY is never taken from the client. Every line amount is
 * `quantity * rate` computed in exact SQL numeric arithmetic, and the
 * document total is their SQL sum — never JavaScript floating point
 * (engineering rule 5).
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const NOT_FOUND_CODE = 'BUDGETARY_QUOTATION_NOT_FOUND';
const NOT_FOUND_MESSAGE = 'No such budgetary quotation.';

interface QuotationRow {
  id: string;
  customer_contact_id: string | null;
  addressed_to: string;
  subject: string;
  status: BudgetaryQuotation['status'];
  bq_number: string | null;
  sequence_number: number | null;
  bq_date: string;
  valid_until: string | null;
  notes: string | null;
  total_amount: string | null;
  created_at: Date;
  issued_at: Date | null;
}

const QUOTATION_COLUMNS = `
  id, customer_contact_id, addressed_to, subject, status, bq_number,
  sequence_number, bq_date::text as bq_date, valid_until::text as valid_until,
  notes, total_amount::text as total_amount, created_at, issued_at
`;

function toQuotation(row: QuotationRow): BudgetaryQuotation {
  return {
    id: row.id,
    customerContactId: row.customer_contact_id,
    addressedTo: row.addressed_to,
    subject: row.subject,
    status: row.status,
    bqNumber: row.bq_number,
    sequenceNumber: row.sequence_number,
    bqDate: row.bq_date,
    validUntil: row.valid_until,
    notes: row.notes,
    totalAmount: row.total_amount,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
  };
}

interface QuotationLineRow {
  id: string;
  line_number: number;
  description: string;
  hsn_code: string | null;
  unit_code: string;
  quantity: string;
  rate: string;
  gst_rate: string | null;
  line_amount: string;
}

const LINE_COLUMNS = `
  id, line_number, description, hsn_code, unit_code,
  quantity::text as quantity, rate::text as rate,
  gst_rate::text as gst_rate, line_amount::text as line_amount
`;

function toQuotationLine(row: QuotationLineRow): BudgetaryQuotationLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    description: row.description,
    hsnCode: row.hsn_code,
    unitCode: row.unit_code,
    quantity: row.quantity,
    rate: canonicalRateText(row.rate),
    gstRate: row.gst_rate,
    lineAmount: row.line_amount,
  };
}

/** The customer as the offer named them, frozen at issue. Master edits
 * and retirements never rewrite an issued document (engineering rule 7),
 * so the contact FK survives only as provenance. Null on a quotation
 * addressed to a stranger — `addressed_to` is then the whole record of
 * who it went to. */
interface CustomerSnapshot {
  contactId: string;
  designation: string;
  contactPerson: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  pincode: string | null;
  stateCode: string | null;
}

interface ContactRow {
  id: string;
  designation: string;
  contact_person: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  pincode: string | null;
  state_code: string | null;
  is_client: boolean;
  active: boolean;
}

const CONTACT_COLUMNS = `
  id, designation, contact_person, address, phone, email, gstin, pincode,
  state_code, is_client, active
`;

function toCustomerSnapshot(row: ContactRow): CustomerSnapshot {
  return {
    contactId: row.id,
    designation: row.designation,
    contactPerson: row.contact_person,
    address: row.address,
    phone: row.phone,
    email: row.email,
    gstin: row.gstin,
    pincode: row.pincode,
    stateCode: row.state_code,
  };
}

function isNumericOverflow(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '22003';
}

/**
 * Text as the DATABASE will judge it. Every text CHECK in 0033 measures
 * `length(btrim(x))`, and `btrim` removes SPACES only, while JavaScript's
 * `trim()` removes every whitespace character. A unit code of a single
 * TAB therefore satisfies the contract schema (whose patterns mirror
 * btrim), trims to nothing here, and would reach the column as a 23514 —
 * a status-less error the operator reads as a bare 500. Trimmed text is
 * also what gets STORED, so the record says what the operator meant.
 */
function trimmedAtLeast(
  value: string,
  minLength: number,
  code: string,
  message: string,
): string {
  const trimmed = value.trim();
  if (trimmed.length < minLength) throw httpError(400, code, message);
  return trimmed;
}

interface QuotationHeader {
  customerContactId: string | null;
  addressedTo: string;
  subject: string;
  bqDate: string;
  validUntil: string | null;
  notes: string | null;
}

/** The create/update body as it will be stored. The one rule the schema
 * cannot express is the validity window: `budgetary_quotations_validity`
 * reads `valid_until >= bq_date`, a relation between two fields. ISO
 * dates compare correctly as strings (engineering rule 6 — no timezone
 * round-trip). */
function normaliseHeader(body: CreateBudgetaryQuotationRequest): QuotationHeader {
  const addressedTo = trimmedAtLeast(
    body.addressedTo,
    2,
    'ADDRESSEE_REQUIRED',
    'The quotation must name who it is addressed to — at least two characters that are not blank.',
  );
  const subject = trimmedAtLeast(
    body.subject,
    3,
    'SUBJECT_REQUIRED',
    'The quotation needs a subject — at least three characters that are not blank.',
  );
  const notes =
    body.notes === undefined
      ? null
      : trimmedAtLeast(
          body.notes,
          3,
          'NOTES_INVALID',
          'The notes must be at least three characters that are not blank, or omitted entirely.',
        );
  const validUntil = body.validUntil ?? null;
  if (validUntil !== null && validUntil < body.bqDate) {
    throw httpError(
      400,
      'BQ_VALIDITY_INVALID',
      `The offer cannot expire (${validUntil}) before it is dated (${body.bqDate}).`,
    );
  }
  return {
    customerContactId: body.customerContactId ?? null,
    addressedTo,
    subject,
    bqDate: body.bqDate,
    validUntil,
    notes,
  };
}

async function assertBqDateNotFuture(
  tx: TransactionSql,
  bqDate: string,
): Promise<void> {
  const [row] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations
  `;
  if (!row) throw new Error('bound organisation disappeared');
  if (bqDate > row.today) {
    throw httpError(
      400,
      'BQ_DATE_IN_FUTURE',
      `The quotation date cannot be after today (${row.today}) in the organisation timezone.`,
    );
  }
}

/** The picked customer, if one was picked. Masters are PICKERS: the role
 * and lifecycle are checked HERE, where the operator chooses, and never
 * again at issue — a contact retired between drafting and issue must not
 * strand a finished offer, it is simply snapshotted as it stands. */
async function requireCustomerContact(
  tx: TransactionSql,
  contactId: string,
): Promise<ContactRow> {
  const [contact] = await tx<ContactRow[]>`
    select ${tx.unsafe(CONTACT_COLUMNS)} from contacts where id = ${contactId}
  `;
  if (!contact) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  if (!contact.is_client) {
    throw httpError(
      409,
      'CONTACT_NOT_CLIENT',
      'A budgetary quotation is addressed to a client contact; this contact does not carry the client role. Address it as free text instead.',
    );
  }
  if (!contact.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'This contact is retired — reactivate it, pick another, or address the quotation as free text.',
    );
  }
  return contact;
}

/** The line amounts summed as exact decimals in SQL, so a draft screen
 * can show its value without the client adding money in floating point.
 * '0.00' on a draft with no lines yet. */
async function readPreviewTotal(
  tx: TransactionSql,
  quotationId: string,
): Promise<string> {
  const [total] = await tx<{ amount: string }[]>`
    select coalesce(sum(line_amount), 0)::numeric(18,2)::text as amount
    from budgetary_quotation_lines
    where budgetary_quotation_id = ${quotationId}
  `.catch((error: unknown) => {
    // Every line fits numeric(18,2) (the write path proves it), but five
    // hundred of them need not: the SUM cast is the one place the total
    // can exceed the column it is destined for.
    if (isNumericOverflow(error)) {
      throw httpError(
        409,
        'BQ_TOTAL_TOO_LARGE',
        'The quotation total is too large to record — check the line quantities and rates for a mistyped digit.',
      );
    }
    throw error;
  });
  return total?.amount ?? '0.00';
}

async function readLines(
  tx: TransactionSql,
  quotationId: string,
): Promise<BudgetaryQuotationLine[]> {
  const rows = await tx<QuotationLineRow[]>`
    select ${tx.unsafe(LINE_COLUMNS)}
    from budgetary_quotation_lines
    where budgetary_quotation_id = ${quotationId}
    order by line_number
  `;
  return rows.map(toQuotationLine);
}

async function readDetail(
  tx: TransactionSql,
  quotationId: string,
): Promise<BudgetaryQuotationDetailResponse> {
  const [row] = await tx<(QuotationRow & { customer_snapshot: unknown })[]>`
    select ${tx.unsafe(QUOTATION_COLUMNS)}, customer_snapshot
    from budgetary_quotations where id = ${quotationId}
  `;
  if (!row) throw httpError(404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE);
  return {
    budgetaryQuotation: toQuotation(row),
    lines: await readLines(tx, quotationId),
    customerSnapshot: parseJsonbColumn(row.customer_snapshot),
    previewTotal: await readPreviewTotal(tx, quotationId),
  };
}

/** Locks the quotation row for the rest of the transaction and returns
 * it. Every state transition starts here so concurrent requests
 * serialise; a row this tenant cannot see is a 404, never a 403 — a
 * guessed id must not confirm the document exists in some other
 * organisation. */
async function lockQuotation(
  tx: TransactionSql,
  quotationId: string,
): Promise<QuotationRow> {
  const [row] = await tx<QuotationRow[]>`
    select ${tx.unsafe(QUOTATION_COLUMNS)}
    from budgetary_quotations where id = ${quotationId}
    for update
  `;
  if (!row) throw httpError(404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE);
  return row;
}

function requireStatus(row: QuotationRow, status: BudgetaryQuotation['status']): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'BQ_STATUS_CONFLICT',
      `This operation requires a ${status} budgetary quotation (current status: ${row.status}).`,
    );
  }
}

/** REPLACES the draft's lines wholesale; `line_number` follows array
 * order. Line money is computed here, in exact SQL numeric arithmetic,
 * from the quantity and rate the client sent — a client-supplied amount
 * would be a second, disagreeing (and floating-point) authority. */
async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  quotationId: string,
  lines: readonly BudgetaryQuotationLineInput[],
): Promise<void> {
  await tx`
    delete from budgetary_quotation_lines
    where budgetary_quotation_id = ${quotationId}
  `;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const description = trimmedAtLeast(
      line.description,
      3,
      'LINE_DESCRIPTION_REQUIRED',
      `Line ${String(lineNumber)}: the description must be at least three characters that are not blank.`,
    );
    const unitCode = trimmedAtLeast(
      line.unitCode,
      1,
      'LINE_UNIT_REQUIRED',
      `Line ${String(lineNumber)}: the unit code must not be blank.`,
    );
    await tx`
      insert into budgetary_quotation_lines (
        organisation_id, budgetary_quotation_id, line_number, description,
        hsn_code, unit_code, quantity, rate, gst_rate, line_amount
      )
      values (
        ${organisationId}, ${quotationId}, ${lineNumber}, ${description},
        ${line.hsnCode ?? null}, ${unitCode}, ${line.quantity}, ${line.rate},
        ${line.gstRate ?? null},
        (${line.quantity}::numeric(18,3) * ${line.rate}::numeric(18,6))::numeric(18,2)
      )
    `.catch((error: unknown) => {
      // quantity and rate each fit their own column (the contract's
      �m�G����ƭy�    },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      // A quotation has no Work, so it has no work_scope to filter by:
      // every member of the organisation sees the organisation's offers.
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => tx<QuotationRow[]>`
          select ${tx.unsafe(QUOTATION_COLUMNS)}
          from budgetary_quotations
          order by bq_date desc, created_at desc, id
        `,
      );
      return { budgetaryQuotations: rows.map(toQuotation) };
    },
  );

  app.post(
    '/api/budgetary-quotations',
    {
      schema: {
        body: CreateBudgetaryQuotationRequestSchema,
        response: { 201: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const header = normaliseHeader(request.body as CreateBudgetaryQuotationRequest);
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          await assertBqDateNotFuture(tx, header.bqDate);
          if (header.customerContactId !== null) {
            await requireCustomerContact(tx, header.customerContactId);
          }
          // Deliberately NO one-draft rule: a contractor quotes several
          // customers at once, and 0033 carries no partial unique index
          // to say otherwise (the delivery challan's is per Work, and a
          // quotation has no Work).
          const [created] = await tx<{ id: string }[]>`
            insert into budgetary_quotations (
              organisation_id, customer_contact_id, addressed_to, subject,
              bq_date, valid_until, notes, created_by_user_id
            )
            values (
              ${organisationId}, ${header.customerContactId}, ${header.addressedTo},
              ${header.subject}, ${header.bqDate}, ${header.validUntil},
              ${header.notes}, ${user.id}
            )
            returning id
          `;
          if (!created) throw new Error('budgetary quotation insert returned no row');
          await audit(
            tx,
            organisationId,
            user.id,
            'budgetary_quotation.created',
            created.id,
            { addressedTo: header.addressedTo, subject: header.subject },
          );
          return readDetail(tx, created.id);
        },
      );
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/api/budgetary-quotations/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) =>
        readDetail(tx, id),
      );
    },
  );

  app.put(
    '/api/budgetary-quotations/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: CreateBudgetaryQuotationRequestSchema,
        response: { 200: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const header = normaliseHeader(request.body as CreateBudgetaryQuotationRequest);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertBqDateNotFuture(tx, header.bqDate);
        const quotation = await lockQuotation(tx, id);
        // An issued offer is a document that left the building: it takes
        // no edits at all, header or lines (engineering rule 7).
        requireStatus(quotation, 'draft');
        if (header.customerContactId !== null) {
          await requireCustomerContact(tx, header.customerContactId);
        }
        await tx`
          update budgetary_quotations
          set customer_contact_id = ${header.customerContactId},
              addressed_to = ${header.addressedTo}, subject = ${header.subject},
              bq_date = ${header.bqDate}, valid_until = ${header.validUntil},
              notes = ${header.notes}
          where id = ${id}
        `;
        const changes = auditDiff(
          {
            customerContactId: quotation.customer_contact_id,
            addressedTo: quotation.addressed_to,
            subject: quotation.subject,
            bqDate: quotation.bq_date,
            validUntil: quotation.valid_until,
            notes: quotation.notes,
          },
          {
            customerContactId: header.customerContactId,
            addressedTo: header.addressedTo,
            subject: header.subject,
            bqDate: header.bqDate,
            validUntil: header.validUntil,
            notes: header.notes,
          },
        );
        await audit(tx, organisationId, user.id, 'budgetary_quotation.updated', id, {
          before: changes.before,
          after: changes.after,
        });
        return readDetail(tx, id);
      });
    },
  );

  app.put(
    '/api/budgetary-quotations/:id/lines',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveBudgetaryQuotationLinesRequestSchema,
        response: { 200: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveBudgetaryQuotationLinesRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const quotation = await lockQuotation(tx, id);
        // The 0033 line trigger says the same thing in the database; the
        // refusal is made here so the operator reads a 409 with a status
        // in it rather than a raw plpgsql message as a 500.
        requireStatus(quotation, 'draft');
        const before = await readLineInputs(tx, id);
        await writeLines(tx, organisationId, id, body.lines);
        const changes = auditDiff(
          { lines: before },
          { lines: await readLineInputs(tx, id) },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'budgetary_quotation.lines_saved',
          id,
          { before: changes.before, after: changes.after },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.delete(
    '/api/budgetary-quotations/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const quotation = await lockQuotation(tx, id);
        // Drafts may be deleted; an issued offer expires, converts, or is
        // withdrawn, and keeps its number forever (engineering rule 8).
        requireStatus(quotation, 'draft');
        await tx`
          delete from budgetary_quotation_lines
          where budgetary_quotation_id = ${id}
        `;
        await tx`delete from budgetary_quotations where id = ${id}`;
        await audit(tx, organisationId, user.id, 'budgetary_quotation.deleted', id, {
          addressedTo: quotation.addressed_to,
          subject: quotation.subject,
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/budgetary-quotations/:id/issue',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'issue');
          const quotation = await lockQuotation(tx, id);
          requireStatus(quotation, 'draft');
          await assertBqDateNotFuture(tx, quotation.bq_date);

          const lines = await readLines(tx, id);
          if (lines.length === 0) {
            throw httpError(
              409,
              'BQ_EMPTY',
              'This quotation has nothing to offer — save at least one priced line before issuing it.',
            );
          }
          const totalAmount = await readPreviewTotal(tx, id);

          // Snapshot-on-use: the customer as the offer names them, frozen
          // now so retiring or renaming the contact never rewrites the
          // document. A quotation addressed to a stranger carries no
          // snapshot — `addressed_to` is the whole record.
          let customerSnapshot: CustomerSnapshot | null = null;
          if (quotation.customer_contact_id !== null) {
            const [contact] = await tx<ContactRow[]>`
              select ${tx.unsafe(CONTACT_COLUMNS)} from contacts
              where id = ${quotation.customer_contact_id}
            `;
            if (!contact) throw new Error('quotation customer contact vanished');
            customerSnapshot = toCustomerSnapshot(contact);
          }
          // SQL NULL, not the jsonb scalar `null` a bare json() would
          // write: "no snapshot" is the absence of a value, not a value.
          const snapshotParameter =
            customerSnapshot === null ? null : jsonb(tx, customerSnapshot);

          // Gapless BQ-NN per ORGANISATION (not per Work — there is no
          // Work): the counter row lock orders concurrent issues, and a
          // rolled-back transaction rolls the counter back with it, so
          // the numbers carry no gaps and are never reused. The quotation
          // row is already locked above, so the lock order is always
          // document -> counter and concurrent issues cannot deadlock.
          const [counter] = await tx<{ next_value: number }[]>`
            insert into budgetary_quotation_counters (organisation_id)
            values (${organisationId})
            on conflict (organisation_id)
            do update set next_value = budgetary_quotation_counters.next_value + 1
            returning next_value
          `;
          if (!counter) throw new Error('quotation counter upsert returned no row');
          const sequence = counter.next_value;
          const template = await loadNumberTemplate(tx, 'budgetary_quotation');
          let bqNumber: string;
          try {
            bqNumber = renderNumberTemplate(template, {
              documentDate: quotation.bq_date,
              sequence,
            });
          } catch (cause) {
            if (cause instanceof NumberTemplateError) {
              throw httpError(400, 'QUOTATION_NUMBER_UNFILLABLE', cause.message);
            }
            throw cause;
          }

          await tx`
            update budgetary_quotations
            set status = 'issued', bq_number = ${bqNumber},
                sequence_number = ${sequence}, total_amount = ${totalAmount},
                customer_snapshot = ${snapshotParameter},
                issued_by_user_id = ${user.id}, issued_at = now()
            where id = ${id}
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'NUMBER_CONFLICT',
                `Quotation number ${bqNumber} already exists in this organisation.`,
              );
            }
            throw error;
          });

          await audit(tx, organisationId, user.id, 'budgetary_quotation.issued', id, {
            bqNumber,
            sequence,
            totalAmount,
          });
          return readDetail(tx, id);
        },
      );
      return reply.status(201).send(detail);
    },
  );

  app.post(
    '/api/budgetary-quotations/:id/outcome',
    {
      schema: {
        params: IdParamsSchema,
        body: SetBudgetaryQuotationOutcomeRequestSchema,
        response: { 200: BudgetaryQuotationDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const { outcome } = request.body as SetBudgetaryQuotationOutcomeRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        // WITHDRAWING is the contractor taking back a document that left
        // the building — the same act the cancel authority exists for
        // (0033: "documents are cancelled or withdrawn, never deleted"),
        // so it answers to that authority. Recording that an offer LAPSED
        // or WON reports what the world did, not what the contractor
        // revoked, so it is ordinary owner/office bookkeeping.
        if (outcome === 'withdrawn') {
          await requireAuthority(tx, user.id, 'cancel');
        } else {
          await requireWriterRole(tx, user.id);
        }
        const quotation = await lockQuotation(tx, id);
        requireStatus(quotation, 'issued');
        // The number, the lines, and the total stay exactly as issued —
        // only the status moves, and it never moves again (the transition
        // requires `issued`).
        await tx`
          update budgetary_quotations set status = ${outcome} where id = ${id}
        `;
        await audit(tx, organisationId, user.id, `budgetary_quotation.${outcome}`, id, {
          bqNumber: quotation.bq_number,
          before: 'issued',
          after: outcome,
        });
        return readDetail(tx, id);
      });
    },
  );
}
