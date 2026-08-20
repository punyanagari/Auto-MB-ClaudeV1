import { createHash } from 'node:crypto';
import {
  ConfirmRailwayMeasurementLineSchema,
  DiscardRailwayMeasurementRequestSchema,
  RailwayMeasurementResponseSchema,
  RailwayMeasurementUploadQuerySchema,
  UuidSchema,
  type RailwayMeasurement,
  type RailwayMeasurementLine,
  type RailwayMeasurementMatchStatus,
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
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import {
  matchRailwayMeasurement,
  type MeasurementLineVerdict,
} from '../railway-measurement-match.js';
import { parseRailwayMeasurement } from '../railway-measurement-parse.js';
import { readStoredLines } from './measurement-books/internal.js';
import { audit, upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * The railway's own measurement, and the gate it holds (migration 0111).
 *
 * ## Where this sits
 *
 * `received-railway-bills.ts` records the document that says the railway
 * agreed and how much it owes. IWRCMS does not produce that bill out of
 * nothing: it produces it from a MEASUREMENT its own system holds, and
 * until that measurement is on file here and agrees with the agency's
 * finalized Measurement Book, everything downstream — the bill, the
 * closure, the `paid` flag that rests on the closure — is resting on an
 * unverified middle.
 *
 * So this module owns the middle document. Its machinery is the machinery
 * every other inbound PDF uses and nothing here is new: the same
 * `consumeUpload` magic-byte gate, the same ClamAV scan, the same
 * Poppler-only extraction, the same tenant-prefixed `ObjectStorage` key,
 * the same discard-rather-than-delete exit. What is new is the MATCH and
 * the gate it feeds.
 *
 * ## The three outcomes, and the one that is not a bypass
 *
 * A measurement is `matched`, `mismatched`, or `unreadable`. The first
 * opens the gate; the second closes it and names the differing lines; the
 * third opens it only after a member has confirmed EVERY line of the
 * Measurement Book by hand, one recorded, audited act per line.
 *
 * A mismatch is deliberately not confirmable. It is a disagreement about
 * quantities, not a reading problem, and clicking past it would make the
 * whole comparison theatre. The database refuses it too
 * (`guard_railway_measurement_confirmation`, 23V05), so the distinction
 * does not rest on this file remembering it.
 *
 * ## The upload is not a claim
 *
 * As with the bill, nothing here is typed by an operator. The measurement
 * number and the LOA number are read off the page and checked against the
 * book; the quantities and the remarks are read and compared. The request
 * carries a file and a filename and that is all it may carry.
 */

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });

interface MeasurementRow {
  readonly id: string;
  readonly work_id: string;
  readonly measurement_book_id: string;
  readonly original_filename: string;
  readonly sha256: string;
  readonly size_bytes: string;
  readonly match_status: RailwayMeasurementMatchStatus;
  readonly line_verdicts: unknown;
  readonly discarded_at: Date | null;
  readonly created_at: Date;
}

/** The columns every read of this table selects, so a new field is added
 * in one place rather than in four queries that drift apart. */
const MEASUREMENT_COLUMNS = `
  m.id, m.work_id, m.measurement_book_id, m.original_filename, m.sha256,
  m.size_bytes::text as size_bytes, m.match_status, m.line_verdicts,
  m.discarded_at, m.created_at
`;

interface ConfirmationRow {
  readonly item_number: string;
  readonly confirmed_by_user_id: string;
  readonly confirmed_at: Date;
}

/**
 * Assembles the wire shape from the stored reading and the confirmations
 * recorded against it.
 *
 * `settles` is DERIVED here and stored nowhere, for the reason
 * `assessRailwayBillVerdict` is derived on the way out: it is a reading of
 * two facts that both live elsewhere — the match status on the row, the
 * confirmations in their own table — and a third copy of the answer is a
 * third thing that can be wrong. The database's own gate computes the
 * same predicate from the same two facts
 * (`guard_railway_bill_needs_measurement`), which is what makes this
 * screen and that gate incapable of disagreeing.
 */
function toRailwayMeasurement(
  row: MeasurementRow,
  bookItemNumbers: readonly string[],
  confirmations: readonly ConfirmationRow[],
): RailwayMeasurement {
  const confirmedBy = new Map(confirmations.map((entry) => [entry.item_number, entry]));
  const stored = (parseJsonbColumn(row.line_verdicts) ??
    []) as readonly MeasurementLineVerdict[];

  // An unreadable document has no verdicts, so the lines it shows are the
  // BOOK's — otherwise the screen has an empty table and nothing to ask
  // anybody to confirm.
  const base: readonly Omit<
    RailwayMeasurementLine,
    'confirmedByUserId' | 'confirmedAt'
  >[] =
    row.match_status === 'unreadable'
      ? bookItemNumbers.map((itemNumber) => ({
          itemNumber,
          matched: false,
          refusal: null,
          detail: null,
        }))
      : stored.map((verdict) => ({
          itemNumber: verdict.itemNumber,
          matched: verdict.matched,
          refusal: verdict.refusal,
          detail: verdict.detail,
        }));

  const lines = base.map((line) => {
    const confirmation = confirmedBy.get(line.itemNumber);
    return {
      ...line,
      confirmedByUserId: confirmation?.confirmed_by_user_id ?? null,
      confirmedAt: confirmation?.confirmed_at.toISOString() ?? null,
    };
  });

  const settles =
    row.discarded_at === null &&
    (row.match_status === 'matched' ||
      (row.match_status === 'unreadable' &&
        bookItemNumbers.every((itemNumber) => confirmedBy.has(itemNumber))));

  return {
    id: row.id,
    workId: row.work_id,
    measurementBookId: row.measurement_book_id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    matchStatus: row.match_status,
    lines,
    settles,
    discardedAt: row.discarded_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/** The Measurement Book's own item numbers, in its own order. */
async function bookItemNumbersOf(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<readonly string[]> {
  const rows = await tx<{ item_number: string }[]>`
    select item_number from measurement_book_lines
    where measurement_book_id = ${measurementBookId}
    order by item_number
  `;
  return rows.map((row) => row.item_number);
}

async function confirmationsOf(
  tx: TransactionSql,
  measurementId: string,
): Promise<readonly ConfirmationRow[]> {
  return tx<ConfirmationRow[]>`
    select item_number, confirmed_by_user_id, confirmed_at
    from railway_measurement_confirmations
    where railway_measurement_id = ${measurementId}
  `;
}

/**
 * Reads the live railway measurement for a Measurement Book, if there is
 * one. Exported because the received-railway-bill route holds the same
 * gate one layer up and must read the same row through the same query.
 */
export async function liveRailwayMeasurementForBook(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<RailwayMeasurement | null> {
  const [row] = await tx<MeasurementRow[]>`
    select ${tx.unsafe(MEASUREMENT_COLUMNS)}
    from railway_measurements m
    where m.measurement_book_id = ${measurementBookId}
      and m.discarded_at is null
  `;
  if (row === undefined) return null;
  return toRailwayMeasurement(
    row,
    await bookItemNumbersOf(tx, measurementBookId),
    await confirmationsOf(tx, row.id),
  );
}

/**
 * Every measurement previously discarded against a book, newest first.
 *
 * The bypass migration 0111's header states — discard a mismatch, upload
 * something unreadable, confirm the lines — is audited but not visible
 * where the next decision is taken. This is what makes it visible: the
 * discarded rows keep their match status and their per-line verdicts, so
 * a mismatch somebody walked away from is listed beside the measurement
 * that replaced it.
 */
async function discardedRailwayMeasurementsForBook(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<readonly RailwayMeasurement[]> {
  const rows = await tx<MeasurementRow[]>`
    select ${tx.unsafe(MEASUREMENT_COLUMNS)}
    from railway_measurements m
    where m.measurement_book_id = ${measurementBookId}
      and m.discarded_at is not null
    order by m.discarded_at desc, m.id
  `;
  const itemNumbers = await bookItemNumbersOf(tx, measurementBookId);
  return Promise.all(
    rows.map(async (row) =>
      toRailwayMeasurement(row, itemNumbers, await confirmationsOf(tx, row.id)),
    ),
  );
}

/** The whole panel's payload: what stands, and what was walked away
 * from. One reader, so the four routes that answer with it cannot drift
 * into showing different halves. */
async function railwayMeasurementPayload(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<{
  measurement: RailwayMeasurement | null;
  discarded: readonly RailwayMeasurement[];
}> {
  return {
    measurement: await liveRailwayMeasurementForBook(tx, measurementBookId),
    discarded: await discardedRailwayMeasurementsForBook(tx, measurementBookId),
  };
}

/**
 * The route half of migration 0111's gate, in the words an operator can
 * act on. The database holds the same three refusals under the lock
 * (`guard_railway_bill_needs_measurement`, 23V01–23V03); this one runs
 * first, so a 409 with a remedy is the normal outcome and the SQLSTATE is
 * what a lost race produces.
 *
 * Exported and called from `received-railway-bills.ts` rather than
 * duplicated there: the two layers are allowed to be two layers, but the
 * ROUTE's copy of a rule existing twice is how the wording of a refusal
 * drifts from the wording of its remedy.
 */
export async function assertRailwayMeasurementSettles(
  tx: TransactionSql,
  measurementBookId: string,
): Promise<void> {
  const measurement = await liveRailwayMeasurementForBook(tx, measurementBookId);
  if (measurement === null) {
    throw httpError(
      409,
      'RAILWAY_MEASUREMENT_MISSING',
      'No railway measurement is on record for this Measurement Book, so the bill raised from it cannot be recorded.',
    );
  }
  if (measurement.matchStatus === 'mismatched') {
    const differing = measurement.lines
      .filter((line) => !line.matched)
      .map((line) => line.itemNumber);
    throw httpError(
      409,
      'RAILWAY_MEASUREMENT_UNMATCHED',
      `The railway's measurement disagrees with this Measurement Book on ${String(differing.length)} line(s): ${differing.join(', ')}.`,
    );
  }
  if (!measurement.settles) {
    const outstanding = measurement.lines
      .filter((line) => line.confirmedAt === null)
      .map((line) => line.itemNumber);
    throw httpError(
      409,
      'RAILWAY_MEASUREMENT_UNCONFIRMED',
      `The railway's measurement could not be read, and these lines are not confirmed against it yet: ${outstanding.join(', ')}.`,
    );
  }
}

export function registerRailwayMeasurementRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/railway-measurement',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: RailwayMeasurementUploadQuerySchema,
        response: { 201: RailwayMeasurementResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: "the railway's measurement",
      });
      const { id: measurementBookId } = request.params;
      const { filename } = request.query;

      // Authorise and establish what this measurement would have to match
      // BEFORE spending a scan and an extraction on it. Same ordering as
      // every other upload route in the tree.
      const expected = await tenant(async (tx) => {
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            sequence_number: number | null;
            letter_number: string;
          }[]
        >`
          select m.id, m.work_id, m.status, m.sequence_number, w.letter_number
          from measurement_books m
          join works w on w.id = m.work_id
          where m.id = ${measurementBookId}
        `;
        if (book === undefined) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        if (book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_NOT_FINALIZED',
            'The railway measures a finalized Measurement Book; this one is ' +
              `${book.status}.`,
          );
        }
        const existing = await liveRailwayMeasurementForBook(tx, measurementBookId);
        if (existing !== null) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_ALREADY_RECORDED',
            'A railway measurement is already recorded against this Measurement Book.',
          );
        }
        return { book, lines: await readStoredLines(tx, measurementBookId) };
      });

      await assertNotMalware(scanner, body);

      // A SERVER THAT CANNOT READ PDFs AT ALL IS NOT AN UNREADABLE
      // DOCUMENT. `PdfToTextConfigurationError` means Poppler is missing
      // or misconfigured, and letting that fall through to the fallback
      // would push every operator into confirming every line by hand
      // because of a deployment fault nobody was told about. Refused with
      // the same 503 the bill's own upload gives, before the reading.
      let layoutText: string;
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
        // Anything else is a fact about THIS document — no text layer, a
        // scan — which is exactly what the fallback is for.
        layoutText = '';
      }

      // THE READING, AND ITS THREE OUTCOMES.
      //
      // A document this parser cannot resolve is `unreadable` rather than
      // a refusal: a scanned measurement is a real thing an agency holds,
      // and migration 0111 gives it the recorded line-by-line
      // confirmation as its exit. What is NOT tolerated is a document
      // that reads cleanly and names a different Work or a different
      // measurement — that is a filing mistake with a readable answer,
      // and it is refused with the number the document actually prints.
      let matchStatus: RailwayMeasurementMatchStatus = 'unreadable';
      let verdicts: readonly MeasurementLineVerdict[] = [];
      let extraction: unknown = null;
      try {
        const parsed = parseRailwayMeasurement(layoutText);
        // The sheet prints no separate `LOA No.` field the way the bill
        // does; the LOA number is the first segment of its own
        // measurement number, which is the same fact from the same
        // string and cannot disagree with itself.
        if (parsed.measurement.contractNumber !== expected.book.letter_number) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_NOT_FOR_BOOK',
            `This measurement is taken under LOA ${parsed.measurement.contractNumber}; ` +
              `this Work is ${expected.book.letter_number}.`,
          );
        }
        if (parsed.measurement.sequence !== expected.book.sequence_number) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_NOT_FOR_BOOK',
            `This document records measurement ${String(parsed.measurement.sequence)} ` +
              `(${parsed.measurement.raw}); this Measurement Book is measurement ` +
              `${String(expected.book.sequence_number ?? 0)}.`,
          );
        }
        const match = matchRailwayMeasurement(expected.lines, parsed.items);
        matchStatus = match.status;
        verdicts = match.lines;
        extraction = parsed;
      } catch (error) {
        // A refusal this route raised itself is a refusal, not an
        // unreadable document. Only the reader's own failures — a missing
        // text layer, a grid the parser could not resolve — fall through
        // to the fallback.
        if (error !== null && typeof error === 'object' && 'statusCode' in error) {
          throw error;
        }
        request.log.info(
          { measurementBookId },
          'railway measurement could not be read; recorded for manual confirmation',
        );
      }

      const measurementId = crypto.randomUUID();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/railwaymeasurement/${measurementId}.pdf`;
      await storage.put(objectKey, body);

      const result = await tenant(async (tx) => {
        // Re-read under the row lock: the book could have been cancelled
        // while the scan and the extraction ran.
        const [book] = await tx<{ status: string }[]>`
          select status from measurement_books where id = ${measurementBookId} for update
        `;
        if (book === undefined || book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_NOT_FINALIZED',
            'The Measurement Book stopped being finalized while the measurement was read.',
          );
        }
        const existing = await liveRailwayMeasurementForBook(tx, measurementBookId);
        if (existing !== null) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_ALREADY_RECORDED',
            'A railway measurement was recorded against this Measurement Book while this one was being read.',
          );
        }
        const [row] = await tx<MeasurementRow[]>`
          with inserted as (
            insert into railway_measurements (
              id, organisation_id, work_id, measurement_book_id, object_key,
              original_filename, sha256, media_type, size_bytes, match_status,
              line_verdicts, extraction_payload, uploaded_by_user_id
            )
            values (
              ${measurementId}, ${organisationId}, ${expected.book.work_id},
              ${measurementBookId}, ${objectKey}, ${filename}, ${sha256},
              'application/pdf', ${body.length}, ${matchStatus},
              ${tx.json(verdicts as never)},
              ${extraction === null ? null : tx.json(extraction as never)},
              ${user.id}
            )
            returning *
          )
          select ${tx.unsafe(MEASUREMENT_COLUMNS)} from inserted m
        `;
        if (row === undefined)
          throw new Error('railway measurement insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'railway_measurement.recorded',
          'railway_measurements',
          measurementId,
          {
            measurementBookId,
            matchStatus,
            mismatchedLines: verdicts
              .filter((verdict) => !verdict.matched)
              .map((verdict) => verdict.itemNumber),
            sha256,
          },
        );
        return railwayMeasurementPayload(tx, measurementBookId);
      });
      return reply.status(201).send(result);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/measurement-books/:id/railway-measurement',
      schema: {
        params: IdParamsSchema,
        response: { 200: RailwayMeasurementResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: measurementBookId } = request.params;
      return tenant(async (tx) => {
        const [book] = await tx<{ work_id: string }[]>`
          select work_id from measurement_books where id = ${measurementBookId}
        `;
        if (book === undefined) {
          throw httpError(
            404,
            'MEASUREMENT_BOOK_NOT_FOUND',
            'No such Measurement Book.',
          );
        }
        await assertWorkAccess(tx, user.id, book.work_id);
        return railwayMeasurementPayload(tx, measurementBookId);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/railway-measurements/:id/confirm-line',
      schema: {
        params: IdParamsSchema,
        body: ConfirmRailwayMeasurementLineSchema,
        response: { 200: RailwayMeasurementResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { itemNumber } = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<
          {
            work_id: string;
            measurement_book_id: string;
            match_status: RailwayMeasurementMatchStatus;
            discarded_at: Date | null;
          }[]
        >`
          select work_id, measurement_book_id, match_status, discarded_at
          from railway_measurements where id = ${id} for update
        `;
        if (row === undefined) {
          throw httpError(
            404,
            'RAILWAY_MEASUREMENT_NOT_FOUND',
            'No such railway measurement.',
          );
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.discarded_at !== null) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_ALREADY_DISCARDED',
            'This railway measurement is discarded; confirming its lines would confirm nothing.',
          );
        }
        // The database refuses this too (23V05). Refused here first so the
        // operator is told what to read instead, rather than meeting a
        // SQLSTATE.
        if (row.match_status !== 'unreadable') {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_NOT_CONFIRMABLE',
            `This measurement was read and its lines are ${row.match_status}; only a measurement whose text could not be extracted is confirmed by hand.`,
          );
        }
        const itemNumbers = await bookItemNumbersOf(tx, row.measurement_book_id);
        if (!itemNumbers.includes(itemNumber)) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_LINE_UNKNOWN',
            `Item ${itemNumber} is not a line of this Measurement Book.`,
          );
        }
        // ON CONFLICT DO NOTHING rather than a refusal: confirming a line
        // twice is a double-click, and the second one changes nothing —
        // including, deliberately, who confirmed it and when.
        await tx`
          insert into railway_measurement_confirmations (
            organisation_id, railway_measurement_id, item_number, confirmed_by_user_id
          )
          values (${organisationId}, ${id}, ${itemNumber}, ${user.id})
          on conflict (organisation_id, railway_measurement_id, item_number)
          do nothing
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'railway_measurement.line_confirmed',
          'railway_measurements',
          id,
          { measurementBookId: row.measurement_book_id, itemNumber },
        );
        return railwayMeasurementPayload(tx, row.measurement_book_id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/railway-measurements/:id/discard',
      schema: {
        params: IdParamsSchema,
        body: DiscardRailwayMeasurementRequestSchema,
        response: { 200: RailwayMeasurementResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reason } = request.body;
      return tenant(async (tx) => {
        const [row] = await tx<
          { work_id: string; measurement_book_id: string; discarded_at: Date | null }[]
        >`
          select work_id, measurement_book_id, discarded_at
          from railway_measurements where id = ${id} for update
        `;
        if (row === undefined) {
          throw httpError(
            404,
            'RAILWAY_MEASUREMENT_NOT_FOUND',
            'No such railway measurement.',
          );
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        if (row.discarded_at !== null) {
          throw httpError(
            409,
            'RAILWAY_MEASUREMENT_ALREADY_DISCARDED',
            'This railway measurement is already discarded.',
          );
        }
        // A measurement a bill already rests on is not detachable. The
        // bill's own row still names the book, the gate that admitted it
        // read this measurement, and discarding the evidence would leave
        // a recorded bill with nothing behind it — the same posture 0066
        // takes for a bill that closed its book.
        const [bill] = await tx<{ bill_number: string }[]>`
          select bill_number from received_railway_bills
          where measurement_book_id = ${row.measurement_book_id}
            and discarded_at is null
        `;
        if (bill !== undefined) {
          throw httpError(
            409,
            'RAILWAY_BILL_ALREADY_RECORDED',
            `Bill ${bill.bill_number} was recorded against this measurement and rests on it; discard the bill first.`,
          );
        }
        await tx`
          update railway_measurements
          set discarded_at = now(), discarded_by_user_id = ${user.id},
              discard_reason = ${reason ?? null}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'railway_measurement.discarded',
          'railway_measurements',
          id,
          { measurementBookId: row.measurement_book_id, reason: reason ?? null },
        );
        return railwayMeasurementPayload(tx, row.measurement_book_id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/railway-measurements/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const measurement = await tenant(async (tx) => {
        const [row] = await tx<
          { work_id: string; object_key: string; original_filename: string }[]
        >`
          select work_id, object_key, original_filename
          from railway_measurements where id = ${id}
        `;
        if (row === undefined) {
          throw httpError(
            404,
            'RAILWAY_MEASUREMENT_NOT_FOUND',
            'No such railway measurement.',
          );
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return row;
      });
      const bytes = await storage.get(measurement.object_key);
      return reply
        .header(
          'content-disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(measurement.original_filename)}`,
        )
        .type('application/pdf')
        .send(bytes);
    },
  );
}
