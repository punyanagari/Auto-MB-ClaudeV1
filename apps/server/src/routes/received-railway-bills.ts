import { createHash } from 'node:crypto';
import {
  DiscardReceivedRailwayBillRequestSchema,
  ReceivedRailwayBillListResponseSchema,
  ReceivedRailwayBillSchema,
  ReceivedRailwayBillUploadQuerySchema,
  UuidSchema,
  type PdfSignatureReport,
  type ReceivedRailwayBill,
  type StoredPdfSignatureStatus,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess } from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { extractPdfText, PdfToTextConfigurationError } from '@auto-mb/documents';
import type { MalwareScanner } from '../malware-scan.js';
import type { ObjectStorage } from '@auto-mb/documents';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import { verifyUploadedPdf } from '@auto-mb/documents';
import type { TrustAnchorStore } from '@auto-mb/documents';
import {
  parseReceivedRailwayBill,
  RailwayBillParseError,
} from '../railway-bill-parse.js';
import { assessRailwayBillVerdict } from '../railway-bill-verdict.js';
import { audit, upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Recording the railway's own On-Account Bill.
 *
 * This is the only document in the product that arrives rather than
 * leaves, and the route is shaped by that one fact. Nothing here accepts
 * a bill number, a date, an amount or a measurement from the caller: they
 * are read out of the uploaded PDF and inserted from the parse. The
 * request carries a file and a filename, and that is all it is allowed to
 * carry.
 *
 * The machinery is the machinery every other inbound PDF uses — the same
 * `consumeUpload` magic-byte gate, the same ClamAV scan, the same
 * Poppler-only extraction, the same `ObjectStorage` boundary, the same
 * `verifyUploadedPdf` verdict written once beside the bytes. What is new
 * is only the parse and the link.
 */

const IdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });

interface ReceivedRailwayBillRow {
  readonly id: string;
  readonly work_id: string;
  readonly measurement_book_id: string;
  readonly measurement_book_number: string | null;
  readonly bill_number: string;
  readonly bill_date: string;
  readonly bill_amount: string;
  readonly rate_inclusive_of_gst: boolean;
  readonly measurement_number: string;
  readonly measurement_sequence: number;
  readonly agreement_number: string | null;
  readonly letter_number: string;
  readonly original_filename: string;
  readonly sha256: string;
  readonly size_bytes: string;
  readonly signature_status: StoredPdfSignatureStatus;
  readonly signature_verdict: unknown;
  readonly discarded_at: Date | null;
  readonly created_at: Date;
}

/** The columns every read of this table selects, so a new field is added
 * in one place rather than in four queries that drift apart. */
const BILL_COLUMNS = `
  b.id, b.work_id, b.measurement_book_id, b.bill_number,
  b.bill_date::text as bill_date, b.bill_amount::text as bill_amount,
  b.rate_inclusive_of_gst, b.measurement_number, b.measurement_sequence,
  b.agreement_number, b.letter_number, b.original_filename, b.sha256,
  b.size_bytes::text as size_bytes, b.signature_status, b.signature_verdict,
  b.discarded_at, b.created_at, m.mb_number as measurement_book_number
`;

export function toReceivedRailwayBill(
  row: ReceivedRailwayBillRow,
): ReceivedRailwayBill {
  const verdict =
    (parseJsonbColumn(row.signature_verdict) as PdfSignatureReport | null) ?? null;
  // Assessed on the way out rather than stored: the rule is the owner's
  // ruling, not a fact about the document, and a ruling that changes must
  // not need a data migration to take effect. The stored verdict is the
  // evidence; this is the reading of it.
  const assessment = assessRailwayBillVerdict(row.signature_status, verdict);
  return {
    id: row.id,
    workId: row.work_id,
    measurementBookId: row.measurement_book_id,
    measurementBookNumber: row.measurement_book_number,
    billNumber: row.bill_number,
    billDate: row.bill_date,
    billAmount: row.bill_amount,
    rateInclusiveOfGst: row.rate_inclusive_of_gst,
    measurementNumber: row.measurement_number,
    measurementSequence: row.measurement_sequence,
    agreementNumber: row.agreement_number,
    letterNumber: row.letter_number,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    signatureStatus: row.signature_status,
    signatureVerdict: verdict,
    settleable: assessment.acceptable,
    settlementRefusal: assessment.refusal,
    settlementRefusalDetail: assessment.detail,
    discardedAt: row.discarded_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Reads the live railway bill recorded against a Measurement Book, if
 * there is one. Shared with the closure gate in the measurement-book
 * routes so both surfaces read the same row through the same query.
 */
export async function liveRailwayBillForBook(
  tx: TransactionSql,
  measurementBookId: string,
  options: { readonly lock?: boolean } = {},
): Promise<ReceivedRailwayBill | null> {
  // `for update of b` locks the bill row and NOT the joined book, which
  // is what the callers want: the book is already locked by the time they
  // get here, and locking it again through a join would say something
  // different about lock order.
  const rows = options.lock
    ? await tx<ReceivedRailwayBillRow[]>`
        select ${tx.unsafe(BILL_COLUMNS)}
        from received_railway_bills b
        join measurement_books m on m.id = b.measurement_book_id
        where b.measurement_book_id = ${measurementBookId}
          and b.discarded_at is null
        for update of b
      `
    : await tx<ReceivedRailwayBillRow[]>`
        select ${tx.unsafe(BILL_COLUMNS)}
        from received_railway_bills b
        join measurement_books m on m.id = b.measurement_book_id
        where b.measurement_book_id = ${measurementBookId}
          and b.discarded_at is null
      `;
  const [row] = rows;
  return row === undefined ? null : toReceivedRailwayBill(row);
}

export function registerReceivedRailwayBillRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
  pdfTrustAnchors: TrustAnchorStore,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'POST',
      url: '/api/measurement-books/:id/received-railway-bill',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: ReceivedRailwayBillUploadQuerySchema,
        response: { 201: ReceivedRailwayBillSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: "the railway's On-Account Bill",
      });
      const { id: measurementBookId } = request.params;
      const { filename } = request.query;

      // Authorise and establish what this bill would have to match BEFORE
      // spending a scan, an extraction and a signature verification on it.
      // Same ordering as every other upload route in the tree.
      const expected = await tenant(async (tx) => {
        const [book] = await tx<
          {
            id: string;
            work_id: string;
            status: string;
            sequence_number: number | null;
            letter_number: string;
            closed_at: Date | null;
          }[]
        >`
          select m.id, m.work_id, m.status, m.sequence_number,
                 w.letter_number, m.closed_at
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
            'A railway bill settles a finalized Measurement Book; this one is ' +
              `${book.status}.`,
          );
        }
        // A closed measurement takes no further bills. Without this the
        // one-live-bill index does not stop a second one — it is partial
        // on `discarded_at IS NULL`, so discarding the bill that closed
        // the book would free the slot, and the closure would end up
        // resting on a retired document while a new one sat beside it.
        if (book.closed_at !== null) {
          throw httpError(
            409,
            'MB_ALREADY_CLOSED',
            'This measurement is already closed; it takes no further railway bills.',
          );
        }
        return book;
      });

      await assertNotMalware(scanner, body);

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
        throw httpError(
          400,
          'RAILWAY_BILL_EXTRACTION_FAILED',
          'The bill has no readable text layer.',
          { field: 'text' },
        );
      }

      let parsed;
      try {
        parsed = parseReceivedRailwayBill(layoutText);
      } catch (error) {
        if (error instanceof RailwayBillParseError) {
          throw httpError(400, 'RAILWAY_BILL_EXTRACTION_FAILED', error.message, {
            field: error.field,
          });
        }
        throw error;
      }

      // The bill names the letter it was raised under. Filing it against a
      // Work whose letter number is a different one would attach real money
      // to the wrong contract, so it is refused rather than warned about.
      if (parsed.letterNumber !== expected.letter_number) {
        throw httpError(
          409,
          'RAILWAY_BILL_NOT_FOR_WORK',
          `This bill is raised under LOA ${parsed.letterNumber}; this Work is ` +
            `${expected.letter_number}.`,
        );
      }

      // The link, and the whole point of the pack: by measurement SEQUENCE.
      // The Measurement Book prints `.../OAM/L2/02` and the bill raised from
      // it prints `.../OAM/FL2/02`, so the strings never match and the
      // sequences always do.
      if (parsed.measurement.sequence !== expected.sequence_number) {
        throw httpError(
          409,
          'RAILWAY_BILL_MEASUREMENT_UNMATCHED',
          `This bill settles measurement ${String(parsed.measurement.sequence)} ` +
            `(${parsed.measurement.raw}); this Measurement Book is measurement ` +
            `${String(expected.sequence_number ?? 0)}.`,
        );
      }

      const signature = verifyUploadedPdf(body, pdfTrustAnchors, request.log);

      const billId = crypto.randomUUID();
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/railwaybill/${billId}.pdf`;
      await storage.put(objectKey, body);

      const result = await tenant(async (tx) => {
        // Re-read under the row lock: the book could have been cancelled
        // while the scan, extraction and verification ran.
        const [book] = await tx<
          {
            status: string;
            sequence_number: number | null;
            closed_at: Date | null;
          }[]
        >`
          select status, sequence_number, closed_at from measurement_books
          where id = ${measurementBookId} for update
        `;
        if (book === undefined || book.status !== 'finalized') {
          throw httpError(
            409,
            'MB_NOT_FINALIZED',
            'The Measurement Book stopped being finalized while the bill was read.',
          );
        }
        if (book.closed_at !== null) {
          throw httpError(
            409,
            'MB_ALREADY_CLOSED',
            'This measurement was closed while the bill was being read.',
          );
        }
        const existing = await liveRailwayBillForBook(tx, measurementBookId);
        if (existing !== null) {
          throw httpError(
            409,
            'RAILWAY_BILL_ALREADY_RECORDED',
            `Bill ${existing.billNumber} is already recorded against this measurement.`,
          );
        }

        const [row] = await tx<ReceivedRailwayBillRow[]>`
          with inserted as (
            insert into received_railway_bills (
              id, organisation_id, work_id, measurement_book_id, object_key,
              original_filename, sha256, media_type, size_bytes, bill_number,
              bill_date, bill_amount, rate_inclusive_of_gst, measurement_number,
              measurement_sequence, agreement_number, letter_number,
              extraction_payload, signature_status, signature_verdict,
              signature_verified_at, uploaded_by_user_id
            )
            values (
              ${billId}, ${organisationId}, ${expected.work_id},
              ${measurementBookId}, ${objectKey}, ${filename}, ${sha256},
              'application/pdf', ${body.length}, ${parsed.billNumber},
              ${parsed.billDate}, ${parsed.billAmount},
              ${parsed.rateInclusiveOfGst}, ${parsed.measurement.raw},
              ${parsed.measurement.sequence}, ${parsed.agreementNumber},
              ${parsed.letterNumber}, ${jsonb(tx, parsed)},
              ${signature.status}, ${jsonb(tx, signature.verdict)},
              ${signature.verifiedAt}, ${user.id}
            )
            returning *
          )
          select ${tx.unsafe(BILL_COLUMNS)}
          from inserted b
          join measurement_books m on m.id = b.measurement_book_id
        `;
        if (row === undefined) throw new Error('railway bill insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'received_railway_bill.recorded',
          'received_railway_bills',
          billId,
          {
            measurementBookId,
            billNumber: parsed.billNumber,
            billDate: parsed.billDate,
            billAmount: parsed.billAmount,
            measurementNumber: parsed.measurement.raw,
            measurementSequence: parsed.measurement.sequence,
            rateInclusiveOfGst: parsed.rateInclusiveOfGst,
            signatureStatus: signature.status,
            sha256,
          },
        );
        return toReceivedRailwayBill(row);
      });
      return reply.status(201).send(result);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/received-railway-bills',
      schema: {
        params: IdParamsSchema,
        response: { 200: ReceivedRailwayBillListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const rows = await tx<ReceivedRailwayBillRow[]>`
          select ${tx.unsafe(BILL_COLUMNS)}
          from received_railway_bills b
          join measurement_books m on m.id = b.measurement_book_id
          where b.work_id = ${workId}
          order by b.bill_date desc, b.id
        `;
        return { bills: rows.map(toReceivedRailwayBill) };
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/received-railway-bills/:id/discard',
      schema: {
        params: IdParamsSchema,
        body: DiscardReceivedRailwayBillRequestSchema,
        response: { 200: ReceivedRailwayBillSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reason } = request.body;
      return tenant(async (tx) => {
        // Read once WITHOUT a lock, only to learn which book this bill
        // belongs to. The locks are then taken book-first, in the same
        // order the closure route takes them, so the two cannot interleave
        // and cannot deadlock.
        const [located] = await tx<{ measurement_book_id: string }[]>`
          select measurement_book_id from received_railway_bills where id = ${id}
        `;
        if (located === undefined) {
          throw httpError(404, 'RAILWAY_BILL_NOT_FOUND', 'No such railway bill.');
        }
        const [book] = await tx<
          {
            id: string;
            closed_at: Date | null;
            closed_by_received_bill_id: string | null;
          }[]
        >`
          select id, closed_at, closed_by_received_bill_id from measurement_books
          where id = ${located.measurement_book_id} for update
        `;
        const [current] = await tx<
          { work_id: string; discarded_at: Date | null; bill_number: string }[]
        >`
          select work_id, discarded_at, bill_number
          from received_railway_bills where id = ${id} for update
        `;
        if (current === undefined) {
          throw httpError(404, 'RAILWAY_BILL_NOT_FOUND', 'No such railway bill.');
        }
        await assertWorkAccess(tx, user.id, current.work_id);
        if (current.discarded_at !== null) {
          throw httpError(
            409,
            'RAILWAY_BILL_ALREADY_DISCARDED',
            'This railway bill is already discarded.',
          );
        }
        // A bill that closed a Measurement Book is not detachable: the
        // closure is append-once in the database (migration 0066) and
        // discarding the evidence behind it would leave a closed
        // measurement with nothing supporting it.
        //
        // Re-read UNDER the book lock above, so a closure that committed
        // between this request arriving and this line is visible. Read
        // without that lock, this check is the losing half of a write skew.
        if (book !== undefined && book.closed_at !== null) {
          throw httpError(
            409,
            'MB_ALREADY_CLOSED',
            book.closed_by_received_bill_id === id
              ? 'This bill closed its Measurement Book and cannot be discarded.'
              : 'This measurement is already closed, so its bills are fixed.',
          );
        }
        const [row] = await tx<ReceivedRailwayBillRow[]>`
          with updated as (
            update received_railway_bills
            set discarded_at = now(), discarded_by_user_id = ${user.id},
                discard_reason = ${reason ?? null}
            where id = ${id}
            returning *
          )
          select ${tx.unsafe(BILL_COLUMNS)}
          from updated b
          join measurement_books m on m.id = b.measurement_book_id
        `;
        if (row === undefined) throw new Error('railway bill discard returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'received_railway_bill.discarded',
          'received_railway_bills',
          id,
          { billNumber: current.bill_number, reason: reason ?? null },
        );
        return toReceivedRailwayBill(row);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/received-railway-bills/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const bill = await tenant(async (tx) => {
        const [row] = await tx<
          { work_id: string; object_key: string; original_filename: string }[]
        >`
          select work_id, object_key, original_filename
          from received_railway_bills where id = ${id}
        `;
        if (row === undefined) {
          throw httpError(404, 'RAILWAY_BILL_NOT_FOUND', 'No such railway bill.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return row;
      });
      const bytes = await storage.get(bill.object_key);
      return reply
        .header(
          'content-disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(bill.original_filename)}`,
        )
        .type('application/pdf')
        .send(bytes);
    },
  );
}
