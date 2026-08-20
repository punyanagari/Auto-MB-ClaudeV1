import {
  BillListResponseSchema,
  BillSchema,
  InstallSerialRequestSchema,
  InstrumentListResponseSchema,
  InstrumentSchema,
  KeysetQuerySchema,
  MbEntryListResponseSchema,
  ReceiptSchema,
  RecordReceiptRequestSchema,
  RecordSerialsRequestSchema,
  SaveInstrumentRequestSchema,
  SerialListResponseSchema,
  UpdateBillStatusRequestSchema,
  UpdateInstrumentRequestSchema,
  type Bill,
  type Instrument,
  type MbEntry,
  type Receipt,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { auditDiff } from '../audit-diff.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { requireWorkBoundChallan } from './challans.js';
import { audit, errorResponses, IdParamsSchema } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

interface InstrumentRow {
  id: string;
  work_id: string;
  kind: Instrument['kind'];
  reference: string;
  amount: string | null;
  issued_on: string;
  expires_on: string | null;
  status: Instrument['status'];
  notes: string | null;
  created_at: Date;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    workId: row.work_id,
    kind: row.kind,
    reference: row.reference,
    amount: row.amount,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

/** True when a DecimalString denotes a value greater than zero, decided
 * on the digits themselves — never binary floating-point arithmetic
 * (engineering rule 5). The schema pattern guarantees the shape, so a
 * leading '-' is the only sign and any non-zero digit means positive. */
function isPositiveDecimal(value: string): boolean {
  return !value.startsWith('-') && /[1-9]/.test(value);
}

interface MbEntryRow {
  id: string;
  work_item_id: string;
  item_number: string;
  delivery_challan_id: string | null;
  measured_quantity: string;
  measured_on: string;
  mb_book_ref: string | null;
  remarks: string | null;
  bill_id: string | null;
  created_at: Date;
}

function toMbEntry(row: MbEntryRow): MbEntry {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    deliveryChallanId: row.delivery_challan_id,
    measuredQuantity: row.measured_quantity,
    measuredOn: row.measured_on,
    mbBookRef: row.mb_book_ref,
    remarks: row.remarks,
    billId: row.bill_id,
    createdAt: row.created_at.toISOString(),
  };
}

interface BillRow {
  id: string;
  work_id: string;
  bill_number: number;
  status: Bill['status'];
  lines_snapshot: unknown;
  total_amount: string;
  mb_id: string | null;
  created_at: Date;
  submitted_at: Date | null;
  paid_at: Date | null;
}

function toBill(row: BillRow): Bill {
  return {
    id: row.id,
    workId: row.work_id,
    billNumber: row.bill_number,
    status: row.status,
    totalAmount: row.total_amount,
    linesSnapshot: parseJsonbColumn(row.lines_snapshot),
    createdAt: row.created_at.toISOString(),
    submittedAt: row.submitted_at?.toISOString() ?? null,
    paidAt: row.paid_at?.toISOString() ?? null,
    mbId: row.mb_id,
  };
}

export function registerRetentionRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // --- Delivery receipt ---------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/receipt',
      schema: {
        params: IdParamsSchema,
        body: RecordReceiptRequestSchema,
        response: { 201: ReceiptSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: challanId } = request.params;
      const body = request.body;
      const receipt = await tenant(async (tx) => {
        // The row lock serialises receipt recording against concurrent
        // cancellation: whichever transaction wins, the other sees the
        // final status.
        const [challan] = await tx<{ status: string; work_id: string | null }[]>`
            select status, work_id from delivery_challans
            where id = ${challanId}
            for update
          `;
        if (!challan) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        // A receipt is site evidence against a Work's delivery; a
        // standalone challan (0056) has no Work and its receipt row
        // could not satisfy challan_receipts.work_id anyway.
        const workId = requireWorkBoundChallan(challan);
        await assertWorkAccess(tx, user.id, workId);
        if (challan.status !== 'issued') {
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            'Receipts are recorded against issued challans.',
          );
        }
        const [row] = await tx<
          {
            id: string;
            received_on: string;
            received_by: string;
            remarks: string | null;
            created_at: Date;
          }[]
        >`
            insert into challan_receipts (
              organisation_id, delivery_challan_id, work_id, received_on,
              received_by, remarks, recorded_by_user_id
            )
            values (
              ${organisationId}, ${challanId}, ${workId},
              ${body.receivedOn}, ${body.receivedBy}, ${body.remarks ?? null},
              ${user.id}
            )
            returning id, received_on::text as received_on, received_by,
                      remarks, created_at
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'RECEIPT_EXISTS',
              'A receipt is already recorded for this challan.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('receipt insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'challan.received',
          'challan_receipts',
          row.id,
          {
            challanId,
            receivedOn: body.receivedOn,
          },
        );
        return {
          id: row.id,
          deliveryChallanId: challanId,
          receivedOn: row.received_on,
          receivedBy: row.received_by,
          remarks: row.remarks,
          createdAt: row.created_at.toISOString(),
        } satisfies Receipt;
      });
      return reply.status(201).send(receipt);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/challans/:id/receipt',
      schema: {
        params: IdParamsSchema,
        response: { 200: ReceiptSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: challanId } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string | null }[]>`
          select work_id from delivery_challans where id = ${challanId}
        `;
        if (!ref) {
          throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such Delivery Challan.');
        }
        await assertWorkAccess(tx, user.id, requireWorkBoundChallan(ref));
        const [row] = await tx<
          {
            id: string;
            received_on: string;
            received_by: string;
            remarks: string | null;
            created_at: Date;
          }[]
        >`
          select id, received_on::text as received_on, received_by, remarks,
                 created_at
          from challan_receipts where delivery_challan_id = ${challanId}
        `;
        if (!row) {
          throw httpError(404, 'RECEIPT_NOT_FOUND', 'No receipt recorded yet.');
        }
        return {
          id: row.id,
          deliveryChallanId: challanId,
          receivedOn: row.received_on,
          receivedBy: row.received_by,
          remarks: row.remarks,
          createdAt: row.created_at.toISOString(),
        } satisfies Receipt;
      });
    },
  );

  // --- Serial traceability ------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/challans/:id/serials',
      schema: {
        params: IdParamsSchema,
        body: RecordSerialsRequestSchema,
        response: { 201: SerialListResponseSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: challanId } = request.params;
      const body = request.body;
      const serials = await tenant(async (tx) => {
        // Lock the line so the quantity cap cannot race.
        const [line] = await tx<
          {
            id: string;
            work_id: string | null;
            work_item_id: string | null;
            quantity: string;
            challan_status: string;
          }[]
        >`
            select dci.id, dci.work_id, dci.work_item_id,
                   dci.quantity::text as quantity, dc.status as challan_status
            from delivery_challan_items dci
            join delivery_challans dc on dc.id = dci.delivery_challan_id
            where dci.id = ${body.challanItemId}
              and dci.delivery_challan_id = ${challanId}
            for update of dci, dc
          `;
        if (!line) {
          throw httpError(404, 'CHALLAN_ITEM_NOT_FOUND', 'No such challan line.');
        }
        // R6 traceability is a Work-ITEM guarantee: a serial identifies a
        // physical unit of a sanctioned item, and installation reads it
        // back through work_item_id. A manual (non-LOA) line names no
        // such item, and a standalone challan has no Work at all — both
        // are refused by name here, and the 0056 trigger holds the same
        // rule against direct SQL.
        if (line.work_item_id === null || line.work_id === null) {
          throw httpError(
            400,
            'SERIALS_REQUIRE_WORK_ITEM_LINE',
            'Serials are recorded against a Work item line; this line carries material that is not on the Work’s schedule.',
          );
        }
        const lineWorkId = line.work_id;
        // Serials are recorded post-issue (the historical evidence
        // flow) or on the draft (required before issue for items with
        // requires_serials). Cancelled challans take no new evidence.
        if (line.challan_status !== 'issued' && line.challan_status !== 'draft') {
          throw httpError(
            409,
            'CHALLAN_STATUS_CONFLICT',
            'Serials are recorded against draft or issued challans.',
          );
        }
        await assertWorkAccess(tx, user.id, lineWorkId);
        const [existing] = await tx<{ count: string }[]>`
            select count(*)::text as count from challan_item_serials
            where delivery_challan_item_id = ${body.challanItemId}
          `;
        const already = Number(existing?.count ?? '0');
        if (already + body.serialNumbers.length > Math.floor(Number(line.quantity))) {
          throw httpError(
            409,
            'SERIAL_LIMIT',
            `This line shipped ${line.quantity}; ${String(already)} serials are already recorded.`,
          );
        }
        // The serials are written as ONE statement, so the collision that
        // used to be named by the failing row's own insert is named here
        // instead: every serial already recorded in this Work, plus any
        // the request repeats, found in one read and reported in request
        // order — the same serial the per-row loop reached first. The
        // unique index still decides a genuine race, and the catch below
        // keeps that a clean 409.
        const taken = await tx<{ serial_number: string }[]>`
            select serial_number from challan_item_serials
            where work_id = ${lineWorkId}
              and serial_number = any(${body.serialNumbers}::text[])
          `;
        const takenSet = new Set(taken.map((row) => row.serial_number));
        const seen = new Set<string>();
        for (const serialNumber of body.serialNumbers) {
          if (takenSet.has(serialNumber) || seen.has(serialNumber)) {
            throw httpError(
              409,
              'DUPLICATE_SERIAL',
              `Serial ${serialNumber} already exists in this Work.`,
            );
          }
          seen.add(serialNumber);
        }
        await tx`
            insert into challan_item_serials (
              organisation_id, work_id, delivery_challan_id,
              delivery_challan_item_id, serial_number
            )
            select ${organisationId}, ${lineWorkId}, ${challanId},
                   ${body.challanItemId}, requested.serial_number
            from unnest(${body.serialNumbers}::text[])
              as requested(serial_number)
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'DUPLICATE_SERIAL',
              'One of these serials was recorded in this Work concurrently; reload the line and retry.',
            );
          }
          throw error;
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'serials.recorded',
          'challan_item_serials',
          challanId,
          {
            challanItemId: body.challanItemId,
            count: body.serialNumbers.length,
          },
        );
        return listSerials(tx, lineWorkId);
      });
      return reply.status(201).send(serials);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/serials/:id/installation',
      schema: {
        params: IdParamsSchema,
        body: InstallSerialRequestSchema,
        response: { 200: SerialListResponseSchema, ...errorResponses },
      },
      role: 'evidence',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const serials = await tenant(async (tx) => {
        const [serial] = await tx<
          {
            work_id: string;
            installed_on: string | null;
            installation_remarks: string | null;
          }[]
        >`
            select work_id, installed_on::text as installed_on,
                   installation_remarks
            from challan_item_serials where id = ${id}
            for update
          `;
        if (!serial) {
          throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
        }
        await assertWorkAccess(tx, user.id, serial.work_id);
        // A serial covered by a live quantity-level installation record
        // (Milestone 7) is managed through that record: cancel it to
        // release the serial instead of editing the per-serial date.
        const [attachment] = await tx<{ installation_id: string }[]>`
            select installation_id from installation_serials
            where challan_item_serial_id = ${id} and released_at is null
          `;
        if (attachment) {
          throw httpError(
            409,
            'SERIAL_ATTACHED_TO_INSTALLATION',
            'This serial is covered by an installation record; cancel that record to release it.',
          );
        }
        const [updated] = await tx<{ work_id: string }[]>`
            update challan_item_serials
            set installed_on = ${body.installedOn},
                installation_remarks = ${body.remarks ?? null}
            where id = ${id}
            returning work_id
          `;
        if (!updated) {
          throw httpError(404, 'SERIAL_NOT_FOUND', 'No such serial record.');
        }
        // Re-recording an installation overwrites the previous date, so
        // the trail keeps the old value alongside the new one.
        const changes = auditDiff(
          {
            installedOn: serial.installed_on,
            installationRemarks: serial.installation_remarks,
          },
          {
            installedOn: body.installedOn,
            installationRemarks: body.remarks ?? null,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'serial.installed',
          'challan_item_serials',
          id,
          { before: changes.before, after: changes.after },
        );
        return listSerials(tx, updated.work_id);
      });
      return serials;
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/serials',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: SerialListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return listSerials(tx, workId, query);
      });
    },
  );

  // --- Contract instruments -----------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/instruments',
      schema: {
        params: IdParamsSchema,
        response: { 200: InstrumentListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const rows = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return tx<InstrumentRow[]>`
            select id, work_id, kind, reference, amount::text as amount,
                   issued_on::text as issued_on, expires_on::text as expires_on,
                   status, notes, created_at
            from work_instruments
            where work_id = ${workId}
            order by kind, issued_on, reference
          `;
      });
      return { instruments: rows.map(toInstrument) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/instruments',
      schema: {
        params: IdParamsSchema,
        body: SaveInstrumentRequestSchema,
        response: { 201: InstrumentSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const instrument = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The works row lock every sibling child-creating route takes
        // (challans.ts, issue-challans.ts, installations.ts, pac.ts).
        // Without it this route read the Work and inserted against it in
        // two statements with no serialisation, so a Work could be
        // withdrawn between the read and the insert and the instrument
        // would land on a superseded Work — the eligibility census having
        // already seen an empty register. `for update of w` locks the
        // Work alone; the joined organisations row is read, not locked.
        const [work] = await tx<{ id: string; letter_date: string; today: string }[]>`
            select w.id, w.letter_date::text as letter_date,
                   (now() at time zone o.timezone)::date::text as today
            from works w
            join organisations o on o.id = w.organisation_id
            where w.id = ${workId} and w.deleted_at is null
            for update of w
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        // Product invariant 8, the same window every other dated record
        // obeys (challans 0010, installations 0017, PACs 0022): the
        // issue date is never in the future, in the organisation's own
        // timezone rather than the server clock. A typo'd year hides
        // the instrument from the dashboard expiry sweep while still
        // counting toward the PBG coverage sum, silently clearing the
        // "under value" alert for a guarantee that does not yet exist.
        if (body.issuedOn > work.today) {
          throw httpError(
            400,
            'INSTRUMENT_ISSUED_ON_INVALID',
            `The issue date cannot be in the future (today is ${work.today}).`,
          );
        }
        // Deliberately NOT refused when the issue date precedes the LOA
        // letter date: a 'doc' instrument (tender document, or an EMD /
        // bid security later converted) legitimately predates the
        // letter, and paper records are back-dated. It is recorded as a
        // warning on the audit event instead.
        const issuedBeforeLetterDate = body.issuedOn < work.letter_date;
        if (body.expiresOn !== undefined && body.expiresOn < body.issuedOn) {
          throw httpError(
            400,
            'INSTRUMENT_EXPIRY_INVALID',
            `The expiry date ${body.expiresOn} cannot precede the issue date ${body.issuedOn}. Check the year on the instrument — an expiry before issue reads as a lapsed guarantee on the dashboard for the rest of the Work.`,
          );
        }
        // Legacy §5.5: a performance guarantee must record what it
        // secures. The dashboard sums active pbg amounts against
        // works.pbg_required_amount, so a NULL or zero amount keeps
        // showing "under value" for a guarantee actually lodged, with
        // nothing to distinguish it from a real shortfall. 'pac' and
        // 'doc' instruments legitimately carry no amount.
        if (
          body.kind === 'pbg' &&
          (body.amount === undefined || !isPositiveDecimal(body.amount))
        ) {
          throw httpError(
            400,
            'INSTRUMENT_AMOUNT_REQUIRED',
            'A performance guarantee must record the amount it secures, greater than zero — the dashboard checks that sum against the required PBG value.',
          );
        }
        const [row] = await tx<InstrumentRow[]>`
            insert into work_instruments (
              organisation_id, work_id, kind, reference, amount, issued_on,
              expires_on, notes, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.kind}, ${body.reference},
              ${body.amount ?? null}, ${body.issuedOn}, ${body.expiresOn ?? null},
              ${body.notes ?? null}, ${user.id}
            )
            returning id, work_id, kind, reference, amount::text as amount,
                      issued_on::text as issued_on, expires_on::text as expires_on,
                      status, notes, created_at
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'INSTRUMENT_EXISTS',
              'This instrument reference already exists for the Work.',
            );
          }
          throw error;
        });
        if (!row) throw new Error('instrument insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'instrument.created',
          'work_instruments',
          row.id,
          {
            workId,
            kind: body.kind,
            reference: body.reference,
            // The soft half of the date rule: accepted, but recorded so
            // an instrument issued before the LOA is visible in the
            // trail rather than silent.
            issuedBeforeLetterDate,
          },
        );
        return toInstrument(row);
      });
      return reply.status(201).send(instrument);
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/instruments/:id',
      schema: {
        params: IdParamsSchema,
        body: UpdateInstrumentRequestSchema,
        response: { 200: InstrumentSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // The row lock serialises concurrent status edits, and the locked
        // values are the audit trail's before-image.
        const [existing] = await tx<
          {
            work_id: string;
            status: string;
            issued_on: string;
            expires_on: string | null;
            notes: string | null;
          }[]
        >`
          select work_id, status, issued_on::text as issued_on,
                 expires_on::text as expires_on, notes
          from work_instruments where id = ${id}
          for update
        `;
        if (!existing) {
          throw httpError(404, 'INSTRUMENT_NOT_FOUND', 'No such instrument.');
        }
        await assertWorkAccess(tx, user.id, existing.work_id);
        // This route can move expires_on on its own, so the issue/expiry
        // ordering is re-proved against the STORED issue date.
        if (body.expiresOn !== undefined && body.expiresOn < existing.issued_on) {
          throw httpError(
            400,
            'INSTRUMENT_EXPIRY_INVALID',
            `The expiry date ${body.expiresOn} cannot precede the issue date ${existing.issued_on}. Check the year on the renewal or extension letter.`,
          );
        }
        if (
          body.status !== undefined &&
          existing.status !== body.status &&
          existing.status !== 'active'
        ) {
          throw httpError(
            409,
            'INSTRUMENT_STATUS_TERMINAL',
            `A ${existing.status} instrument cannot change status.`,
          );
        }
        const [row] = await tx<InstrumentRow[]>`
          update work_instruments
          set status = coalesce(${body.status ?? null}, status),
              expires_on = coalesce(${body.expiresOn ?? null}, expires_on),
              notes = coalesce(${body.notes ?? null}, notes)
          where id = ${id}
          returning id, work_id, kind, reference, amount::text as amount,
                    issued_on::text as issued_on, expires_on::text as expires_on,
                    status, notes, created_at
        `;
        if (!row) throw httpError(404, 'INSTRUMENT_NOT_FOUND', 'No such instrument.');
        const changes = auditDiff(
          {
            status: existing.status,
            expiresOn: existing.expires_on,
            notes: existing.notes,
          },
          {
            status: body.status ?? existing.status,
            expiresOn: body.expiresOn ?? existing.expires_on,
            notes: body.notes ?? existing.notes,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'instrument.updated',
          'work_instruments',
          id,
          { before: changes.before, after: changes.after },
        );
        return toInstrument(row);
      });
    },
  );

  // --- Measurement Book ---------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/mb-entries',
      schema: {
        params: IdParamsSchema,
        querystring: KeysetQuerySchema,
        response: { 200: MbEntryListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const query = request.query;
      const paged = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // Site measurements read oldest first — the register is a diary,
        // so the keyset runs FORWARD on (measured_on, created_at, id).
        // The id is the tie-break that makes the sort total: a day's
        // measurements are typed up in one sitting and share a
        // measured_on, and a batch insert can share a created_at.
        // The cursor must name an entry OF THIS WORK — an id from another
        // Work is refused as CURSOR_INVALID, indistinguishable from a
        // nonexistent one; see `cursorRowId` for the oracle this closes.
        const cursor = await cursorRowId(tx, 'mb_entries', query.cursor, workId);
        const rows = await tx<MbEntryRow[]>`
            select mb.id, mb.work_item_id, wi.item_number,
                   mb.delivery_challan_id, mb.measured_quantity::text as measured_quantity,
                   mb.measured_on::text as measured_on, mb.mb_book_ref, mb.remarks,
                   mb.bill_id, mb.created_at
            from mb_entries mb
            join work_items wi on wi.id = mb.work_item_id
            where mb.work_id = ${workId}
              and (${cursor === null} or
                (mb.measured_on, mb.created_at, mb.id) > (
                  select c.measured_on, c.created_at, c.id from mb_entries c
                  where c.id = ${cursor}))
            order by mb.measured_on, mb.created_at, mb.id
            limit ${sqlLimit(query.limit)}
          `;
        return keysetPage(rows, query.limit, (row) => row.id);
      });
      return { entries: paged.rows.map(toMbEntry), nextCursor: paged.nextCursor };
    },
  );

  /*
   * There is deliberately NO POST here.
   *
   * `mb_entries` is the Milestone-5 loose site-measurement register, and
   * ADR-0006 decision 2 already replaced its billing role: a bill is
   * raised from a FINALIZED Measurement Book, which sweeps the delivered
   * and installed quantities itself. Leaving a manual write open meant a
   * Work could be measured two ways that never met, only one of which
   * reaches a bill — and the manual one carried its own delivered-
   * quantity ceiling, a second copy of a rule the Measurement Book
   * engine already enforces.
   *
   * The route was REMOVED rather than deprecated (owner-sanctioned,
   * 2026-08-19). The rows already recorded keep their GET above, still
   * gate Delivery Challan cancellation, and still export — retiring a
   * writer is not deleting a record.
   */

  // --- Bills ----------------------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/bills',
      schema: {
        params: IdParamsSchema,
        response: { 200: BillListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const { rows, summary } = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        // The Work has to exist, and be live, before its money is
        // reported. Without this the register answered zeros for an
        // unknown id and for another organisation's Work alike —
        // indistinguishable from a Work of one's own that nobody has
        // billed yet, which is the empty-register lie about a register.
        //
        // `deleted_at is null` is the merged tree's liveness predicate
        // (migration 0071). It is defence in depth here rather than a
        // reachable case: superseding refuses while any bill exists, so a
        // Work carrying bills cannot be withdrawn. It is written anyway,
        // because relying on that would be relying on a rule that lives
        // in another module and could be relaxed there.
        const [live] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (live === undefined) {
          throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        }
        const bills = await tx<BillRow[]>`
          select id, work_id, bill_number, status, lines_snapshot,
                 total_amount::text as total_amount, mb_id, created_at,
                 submitted_at, paid_at
          from bills where work_id = ${workId}
          order by bill_number desc
        `;
        // The Work's billing position, added up where the money lives.
        // The screen above this list draws three tiles from it, and a
        // browser summing `totalAmount` over the array beside it would be
        // doing float arithmetic on decimal strings — the thing
        // engineering rule 5 forbids, on the figures an operator reads
        // as their claim.
        //
        // `measured` reads the finalized Measurement Books rather than
        // recomputing anything: `total_amount` on a finalized book is the
        // sum of its line-rounded line totals, written once at finalize
        // and never recomputed (migration 0024), so this exposes the MB
        // computation layer's own answer instead of a second opinion
        // about it. Cancelled books are excluded — a cancelled book
        // sanctioned nothing that stands — and drafts carry no total at
        // all. `billed` needs no status filter: a bill is prepared,
        // submitted, then paid, and every one of those is claimed.
        const [totals] = await tx<
          { measured: string; billed: string; unbilled: string }[]
        >`
          with measured as (
            select coalesce(sum(mb.total_amount), 0)::numeric(18,2) as total
            from measurement_books mb
            where mb.work_id = ${workId} and mb.status = 'finalized'
          ),
          billed as (
            select coalesce(sum(b.total_amount), 0)::numeric(18,2) as total
            from bills b where b.work_id = ${workId}
          )
          select measured.total::text as measured,
                 billed.total::text as billed,
                 -- Floored at zero for the same reason the mock floors it
                 -- (Auto-MB-Vercel-du app/works/[code]/page.tsx at
                 -- fdfe5ef): a bill can only be prepared from a finalized
                 -- book, so a negative remainder is not reachable, and
                 -- reporting one as a negative claim would be worse than
                 -- reporting nothing left to claim.
                 greatest(measured.total - billed.total, 0)
                   ::numeric(18,2)::text as unbilled
          from measured, billed
        `;
        if (!totals) throw new Error('bill summary returned no row');
        return { rows: bills, summary: totals };
      });
      return { bills: rows.map(toBill), summary };
    },
  );

  // The Milestone 5 sweep endpoint (POST /api/works/:id/bills — every
  // unbilled mb_entry at 100% of measured value) is REMOVED (ADR-0006
  // decision 4): bills are now prepared from a finalized Measurement
  // Book (POST /api/measurement-books/:id/bill in
  // measurement-books.ts), whose snapshot prices each stage through the
  // payment matrix. mb_entries are site measurement HISTORY: their own
  // write route was removed on 2026-08-19 (owner-sanctioned), so they
  // are neither a billing input nor recordable — see the note where the
  // POST used to live, above.

  tenantRoute(
    {
      method: 'POST',
      url: '/api/bills/:id/status',
      schema: {
        params: IdParamsSchema,
        body: UpdateBillStatusRequestSchema,
        response: { 200: BillSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const [current] = await tx<{ status: Bill['status']; work_id: string }[]>`
          select status, work_id from bills where id = ${id} for update
        `;
        if (!current) throw httpError(404, 'BILL_NOT_FOUND', 'No such bill.');
        await assertWorkAccess(tx, user.id, current.work_id);
        // Deliberately NO completed-Work refusal here (R8). The freeze on
        // a completed Work covers its OPERATIONAL record — the quantities
        // the 100%-executed predicate was measured against, and the
        // documents that carry them. A bill moving prepared -> submitted
        // -> paid records what the payer did with a bill already prepared;
        // it moves no quantity and creates no document. Payment legitimately
        // continues for months after execution finishes, so refusing it
        // would force an operator to reopen a finished Work merely to
        // record that the railway paid.
        const allowed =
          (current.status === 'prepared' && body.status === 'submitted') ||
          (current.status === 'submitted' && body.status === 'paid');
        if (!allowed) {
          throw httpError(
            409,
            'BILL_STATUS_CONFLICT',
            `A ${current.status} bill cannot move to ${body.status}.`,
          );
        }
        // Recording money as received rests on the railway having settled
        // the measurement behind it (migration 0066). Until the railway's
        // own signed On-Account Bill has closed the Measurement Book,
        // "paid" would be an assertion with nothing behind it.
        //
        // Enforced here AND by `app_private.guard_bill_paid_needs_closed_book`.
        // The improvement programme's recurring finding 2 is that this
        // repository enforces security twice and money once; a money rule
        // living only in a handler is one forgotten import from being no
        // rule at all.
        if (body.status === 'paid') {
          const [book] = await tx<{ closed_at: Date | null }[]>`
            select mb.closed_at from bills b
            join measurement_books mb on mb.id = b.mb_id
            where b.id = ${id}
          `;
          if (book?.closed_at == null) {
            throw httpError(
              409,
              'BILL_MEASUREMENT_BOOK_NOT_CLOSED',
              "This bill's Measurement Book is not closed by a verified railway bill.",
            );
          }
          // And the money has to be accounted for (migration 0067).
          // Before the payment register existed, `paid` was a word with
          // no amount behind it — the specific complaint pack P15 was
          // written for. It now asserts that the receipts and the
          // deductions between them reach the railway's own figure.
          //
          // Enforced here AND by
          // `app_private.guard_bill_paid_needs_full_settlement`, for the
          // same reason the closure gate above is enforced twice.
          const [position] = await tx<
            { outstanding: string | null; reference: string | null }[]
          >`
            select app_private.bill_settlement_reference(${id})::text as reference,
                   (app_private.bill_settlement_reference(${id})
                     - app_private.bill_settled_total(${id}))::text as outstanding
          `;
          if (position?.outstanding == null || Number(position.outstanding) !== 0) {
            throw httpError(
              409,
              'BILL_NOT_FULLY_SETTLED',
              position?.outstanding == null
                ? 'This bill has no settled railway amount to account for.'
                : `${position.outstanding} of the railway's ${String(position.reference)} is still outstanding; record the receipt and its deductions first.`,
            );
          }
        }
        const [row] = await tx<BillRow[]>`
          update bills
          set status = ${body.status},
              submitted_at = case when ${body.status} = 'submitted' then now() else submitted_at end,
              paid_at = case when ${body.status} = 'paid' then now() else paid_at end
          where id = ${id}
          returning id, work_id, bill_number, status, lines_snapshot,
                    total_amount::text as total_amount, mb_id, created_at,
                    submitted_at, paid_at
        `;
        if (!row) throw new Error('bill status update returned no row');
        await audit(tx, organisationId, user.id, `bill.${body.status}`, 'bills', id, {
          before: { status: current.status },
          after: { status: body.status },
        });
        return toBill(row);
      });
    },
  );
}

/**
 * The Work's serial register.
 *
 * `page` is omitted by the two mutation routes that answer with the whole
 * register after recording — they are showing the operator what the Work
 * now carries, not paging it — and supplied by the read route, which
 * accepts `limit`/`cursor`. Omitting it reads every row, exactly as this
 * helper did before it could page (see `pagination.ts`).
 *
 * Ordering is by serial number, so the keyset runs on
 * (serial_number, id): serial numbers are unique per work ITEM, not per
 * Work, so the id is what makes the sort total and the cursor exact.
 */
async function listSerials(
  tx: TransactionSql,
  workId: string,
  page: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<{
  serials: {
    id: string;
    deliveryChallanId: string | null;
    challanItemId: string | null;
    origin: 'delivery' | 'installation';
    challanNumber: string | null;
    itemDescription: string;
    serialNumber: string;
    installedOn: string | null;
    installationRemarks: string | null;
    workItemId: string;
    challanStatus: 'draft' | 'issued' | 'cancelled' | null;
    installationId: string | null;
    installationLocation: string | null;
  }[];
  nextCursor: string | null;
}> {
  // The cursor must name a serial OF THIS WORK — an id from another Work
  // is refused as CURSOR_INVALID, indistinguishable from a nonexistent
  // one; see `cursorRowId` for the oracle this closes.
  const cursor = await cursorRowId(tx, 'challan_item_serials', page.cursor, workId);
  const rows = await tx<
    {
      id: string;
      delivery_challan_id: string | null;
      delivery_challan_item_id: string | null;
      origin: 'delivery' | 'installation';
      challan_number: string | null;
      description_snapshot: string;
      serial_number: string;
      installed_on: string | null;
      installation_remarks: string | null;
      work_item_id: string;
      challan_status: 'draft' | 'issued' | 'cancelled' | null;
      installation_id: string | null;
      installation_location: string | null;
    }[]
  >`
    select s.id, s.delivery_challan_id, s.delivery_challan_item_id, s.origin,
           dc.challan_number,
           -- Off the challan line for a delivered serial (a snapshot,
           -- frozen at despatch) and off the Work item for one recorded at
           -- installation, which never had a line to snapshot.
           coalesce(dci.description_snapshot, wi.effective_description,
                    wi.description) as description_snapshot,
           s.serial_number,
           s.installed_on::text as installed_on, s.installation_remarks,
           coalesce(dci.work_item_id, s.work_item_id) as work_item_id,
           dc.status as challan_status,
           inst.id as installation_id,
           inst.location_name as installation_location
    from challan_item_serials s
    -- LEFT since migration 0108. An inner join here made a serial recorded
    -- at an installation invisible to the Work's own register: absent from
    -- the traced-serial count, absent from every consumer of this list, and
    -- silently missing from a register that claims to be the Work's.
    left join delivery_challans dc on dc.id = s.delivery_challan_id
    left join delivery_challan_items dci on dci.id = s.delivery_challan_item_id
    left join work_items wi on wi.id = s.work_item_id
    -- Milestone 7: the live quantity-level installation record covering
    -- this serial, if any (released attachments no longer count).
    left join installation_serials att
      on att.challan_item_serial_id = s.id and att.released_at is null
    left join installations inst on inst.id = att.installation_id
    where s.work_id = ${workId}
      and (${cursor === null} or (s.serial_number, s.id) > (
        select c.serial_number, c.id from challan_item_serials c
        where c.id = ${cursor}))
    order by s.serial_number, s.id
    limit ${sqlLimit(page.limit)}
  `;
  const paged = keysetPage(rows, page.limit, (row) => row.id);
  return {
    serials: paged.rows.map((row) => ({
      id: row.id,
      deliveryChallanId: row.delivery_challan_id,
      challanItemId: row.delivery_challan_item_id,
      origin: row.origin,
      challanNumber: row.challan_number,
      itemDescription: row.description_snapshot,
      serialNumber: row.serial_number,
      installedOn: row.installed_on,
      installationRemarks: row.installation_remarks,
      workItemId: row.work_item_id,
      challanStatus: row.challan_status,
      installationId: row.installation_id,
      installationLocation: row.installation_location,
    })),
    nextCursor: paged.nextCursor,
  };
}
