import { createHash } from 'node:crypto';
import {
  ConfirmWorkRequestSchema,
  LoaDocumentDetailSchema,
  PAYMENT_MATRIX_CATEGORIES,
  LoaDocumentListResponseSchema,
  UploadLoaQuerySchema,
  WorkDetailResponseSchema,
  WorkListResponseSchema,
  type ConfirmPaymentMatrixRow,
  type ConfirmPbgRequirement,
  type ConfirmWorkItem,
  type ConfirmWorkRequest,
  type LoaDocument,
  type LoaDocumentDetail,
  type PaymentMatrixCategory,
  type Work,
  type WorkSchedule,
} from '@auto-mb/contracts';
import {
  parseDecimalToMinorUnits,
  reviewLoaLetter,
  type LoaReviewPayload,
  type PerformanceGuaranteeField,
} from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { auditDiff } from '../audit-diff.js';
import {
  assertWorkAccess,
  hasFullWorkScope,
  membershipOf,
  requireWriterRole,
} from '../authz.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { extractLoaPdfText } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import { assertNotMalware } from '../upload-guards.js';
import type { ObjectStorage } from '../storage.js';
import { upstreamErrorResponses as errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/** What loa_documents.extraction_payload holds for a parsed document:
 * both extracted text views plus the parser's review payload, all verbatim.
 * A failed extraction stores { error } instead. */
interface ExtractionPayload {
  readonly sourceText: string;
  readonly rawSourceText: string;
  readonly review: LoaReviewPayload;
}

// Params are validated with a pattern rather than the uuid format so the
// check does not depend on the ajv instance's format registry.
const DocumentParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface LoaDocumentRow {
  id: string;
  original_filename: string;
  sha256: string;
  size_bytes: string | number;
  extraction_status: LoaDocument['extractionStatus'];
  confirmed_work_id: string | null;
  created_at: Date;
  extraction_payload?: unknown;
}

function toDocument(row: LoaDocumentRow): LoaDocument {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    extractionStatus: row.extraction_status,
    confirmedWorkId: row.confirmed_work_id,
    createdAt: row.created_at.toISOString(),
  };
}

function toDocumentDetail(row: LoaDocumentRow): LoaDocumentDetail {
  return {
    ...toDocument(row),
    extractionPayload: parseJsonbColumn(row.extraction_payload),
  };
}

interface WorkRow {
  id: string;
  work_code: string;
  letter_number: string;
  letter_date: string;
  title: string;
  advertised_value: string;
  contract_value: string;
  pricing_shape: Work['pricingShape'];
  letter_percentage: string | null;
  letter_percentage_direction: Work['letterPercentageDirection'];
  pbg_required_amount: string | null;
  pbg_submission_days: number | null;
  pbg_extension_days: number | null;
  pbg_penal_interest_percent: string | null;
  status: Work['status'];
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_note: string | null;
  created_at: Date;
}

function toWork(row: WorkRow): Work {
  return {
    id: row.id,
    workCode: row.work_code,
    letterNumber: row.letter_number,
    letterDate: row.letter_date,
    title: row.title,
    advertisedValue: row.advertised_value,
    contractValue: row.contract_value,
    pricingShape: row.pricing_shape,
    letterPercentage: row.letter_percentage,
    letterPercentageDirection: row.letter_percentage_direction,
    pbgRequiredAmount: row.pbg_required_amount,
    pbgSubmissionDays: row.pbg_submission_days,
    pbgExtensionDays: row.pbg_extension_days,
    pbgPenalInterestPercent: row.pbg_penal_interest_percent,
    status: row.status,
    // R8 completion state (migration 0031); all null while active.
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    completedByUserId: row.completed_by_user_id,
    completionNote: row.completion_note,
    createdAt: row.created_at.toISOString(),
  };
}

/** Links a confirmed item back to the parsed row it came from, so the
 * work_items.source_evidence column carries the parser's verbatim source
 * block for that item — corrections never overwrite evidence.
 *
 * Every item must resolve: a parsed row's sourceRef must point at a real
 * row of the stored extraction payload, and a reviewer-added row must
 * declare itself with `manualEntry: true` (recorded as an explicit
 * manual-entry marker). A confirmed Work therefore never carries an
 * unresolved evidence link. */
function sourceEvidenceFor(
  payload: ExtractionPayload | null,
  item: ConfirmWorkItem,
): Record<string, unknown> {
  if (item.manualEntry === true) {
    if (item.sourceRef) {
      throw httpError(
        400,
        'ITEM_EVIDENCE_CONFLICT',
        `Item ${item.itemNumber} claims both a parsed source row and manual entry; it must carry exactly one.`,
      );
    }
    return {
      resolved: true,
      manualEntry: true,
      note: 'Row added by the reviewer at confirmation; the parsed letter has no corresponding item row.',
    };
  }
  if (!item.sourceRef) {
    throw httpError(
      400,
      'ITEM_EVIDENCE_REQUIRED',
      `Item ${item.itemNumber} carries neither a sourceRef into the parsed letter nor a manualEntry marker.`,
    );
  }
  const ref = item.sourceRef;
  const parsed = payload?.review.items.find(
    (candidate) =>
      (candidate.schedule?.id ?? 'UNBOUND') === ref.scheduleId &&
      candidate.itemSno === ref.itemSno,
  );
  if (!parsed) {
    throw httpError(
      400,
      'SOURCE_REF_UNRESOLVED',
      `Item ${item.itemNumber} references parsed row ${ref.scheduleId}#${ref.itemSno}, which the stored extraction payload does not contain.`,
    );
  }
  return {
    sourceRef: ref,
    resolved: true,
    qty: parsed.qty,
    qtyUnit: parsed.qtyUnit,
    unitRate: parsed.unitRate,
    bidAmount: parsed.bidAmount,
    reconciliation: parsed.reconciliation,
    needsReview: parsed.needsReview,
    raw: parsed.raw,
  };
}

/** True when the submitted decimal string and the parser's float denote
 * the same value, compared in exact integer minor units — never float
 * arithmetic. A parser value that does not round-trip through
 * `String()` into a plain decimal (never observed on the corpus) simply
 * compares unequal. */
function decimalMatchesParserValue(
  submitted: string | undefined,
  parserValue: number | null,
  scale: number,
): boolean {
  if (submitted === undefined || parserValue === null) {
    return submitted === undefined && parserValue === null;
  }
  const submittedMinor = parseDecimalToMinorUnits(submitted, scale);
  const parserMinor = parseDecimalToMinorUnits(String(parserValue), scale);
  return submittedMinor !== null && submittedMinor === parserMinor;
}

/** Builds works.pbg_requirement_source: the parser's printed raw block and
 * proposal (verbatim, from the STORED extraction payload — never from the
 * client) plus the provenance verdict. Values that match the parser's
 * complete proposal are 'parser'; anything else — including a requirement
 * entered for a letter whose clause the parser could not read — is
 * 'corrected'. */
function pbgRequirementSourceFor(
  payload: ExtractionPayload | null,
  requirement: ConfirmPbgRequirement,
): Record<string, unknown> {
  const parser: PerformanceGuaranteeField | null =
    payload?.review.header.performanceGuarantee ?? null;
  const matchesParser =
    parser !== null &&
    decimalMatchesParserValue(requirement.requiredAmount, parser.amountFigures, 2) &&
    requirement.submissionDays === parser.submissionDays &&
    (requirement.extensionDays ?? null) === parser.extensionDays &&
    decimalMatchesParserValue(
      requirement.penalInterestPercent,
      parser.penalInterestPercent,
      3,
    );
  return {
    provenance: matchesParser ? 'parser' : 'corrected',
    raw: parser?.raw ?? null,
    parser:
      parser === null
        ? null
        : {
            amountFigures: parser.amountFigures,
            amountWords: parser.amountWords,
            submissionDays: parser.submissionDays,
            extensionDays: parser.extensionDays,
            penalInterestPercent: parser.penalInterestPercent,
            needsReview: parser.needsReview,
          },
  };
}

function assertPbgRequirementCoherent(body: ConfirmWorkRequest): void {
  if (body.pbgRequirement === undefined) return;
  const amountMinor = parseDecimalToMinorUnits(body.pbgRequirement.requiredAmount, 2);
  if (amountMinor === null || amountMinor <= 0n) {
    throw httpError(
      400,
      'PBG_AMOUNT_INVALID',
      'The PBG required amount must be a positive rupee amount with at most two decimal places.',
    );
  }
}

/** True when a YYYY-MM-DD string names a day that actually exists.
 * Decided component-wise against a UTC construction, so no local
 * timezone ever touches the legal date value (engineering rule 6). */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const at = new Date(Date.UTC(year, month - 1, day));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  );
}

/** Product contract: the LOA letter date is the FLOOR every downstream
 * date window measures from — delivery challans, installations, PAC
 * certificates and Measurement Books all refuse a date before it, with
 * "today" as their ceiling. A Work confirmed with a letter date in the
 * FUTURE therefore has an empty legal window: no challan, installation,
 * PAC certificate or MB can ever be dated on it, and the dashboard's PBG
 * due date (letter_date + pbg_submission_days) is wrong for the life of
 * the Work. Nothing repairs it either — no route rewrites
 * works.letter_date, and the Work cannot be deleted — so a mistyped year
 * would brick the Work and burn its work code and letter number forever.
 * Refusal, not a warning, is right: no LOA is dated after the day it is
 * filed.
 *
 * "Today" is the organisation's own timezone (default Asia/Kolkata),
 * never the server clock, mirroring assertChallanDate in challans.ts — a
 * same-day IST confirmation made after 18:30 UTC is legitimate.
 * Back-dating stays COMPLETELY unrestricted: a contractor onboarding
 * from paper confirms letters years old. */
async function assertLetterDateCoherent(
  tx: TransactionSql,
  organisationId: string,
  letterDate: string,
): Promise<void> {
  // A day that does not exist ('2026-02-31') must never reach Postgres,
  // where it surfaces as an opaque 500 — and it compares LATER than
  // '2026-02-28' in the string comparison below, so the future bound
  // would not catch it either. The route holds this itself rather than
  // relying on the request schema's pattern.
  if (!isCalendarDate(letterDate)) {
    throw httpError(
      400,
      'LETTER_DATE_INVALID',
      `${letterDate} is not a real calendar date; enter the LOA letter date as YYYY-MM-DD.`,
    );
  }
  const [bounds] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations where id = ${organisationId}
  `;
  // withBoundTenant has already proved the caller's membership binds to
  // this organisation, so a missing row is an internal invariant break.
  if (!bounds) throw new Error('organisation row missing for the bound tenant');
  // ISO dates compare correctly as strings.
  if (letterDate > bounds.today) {
    throw httpError(
      400,
      'LETTER_DATE_INVALID',
      `The LOA letter date cannot be in the future (today is ${bounds.today}). Check the year printed on the letter — the letter date anchors every later document date and cannot be corrected once the Work is confirmed.`,
    );
  }
}

function assertPricingShapeCoherent(body: ConfirmWorkRequest): void {
  const withPercentage = body.pricingShape === 'letter_percentage';
  const hasPercentage =
    body.letterPercentage !== undefined && body.letterPercentageDirection !== undefined;
  const hasNeither =
    body.letterPercentage === undefined && body.letterPercentageDirection === undefined;
  if ((withPercentage && !hasPercentage) || (!withPercentage && !hasNeither)) {
    throw httpError(
      400,
      'PRICING_SHAPE_INVALID',
      'letter_percentage requires a percentage and direction; per_schedule forbids them.',
    );
  }
}

function assertInitialPaymentMatrix(
  rows: readonly ConfirmPaymentMatrixRow[] | undefined,
): void {
  if (rows === undefined) return;
  const seen = new Set<PaymentMatrixCategory>();
  for (const row of rows) {
    if (!(PAYMENT_MATRIX_CATEGORIES as readonly string[]).includes(row.category)) {
      throw httpError(
        400,
        'PAYMENT_MATRIX_CATEGORY_INVALID',
        `Unknown payment category ${row.category}.`,
      );
    }
    if (seen.has(row.category)) {
      throw httpError(
        400,
        'PAYMENT_MATRIX_CATEGORY_DUPLICATE',
        `The initial payment matrix contains ${row.category} more than once.`,
      );
    }
    seen.add(row.category);
    let total = 0n;
    for (const [field, label] of [
      ['pctSupply', 'supply'],
      ['pctInstallation', 'installation'],
      ['pctPac', 'PAC'],
      ['pctFinalBill', 'final bill'],
    ] as const) {
      const value = parseDecimalToMinorUnits(row[field], 2);
      if (value === null || value < 0n || value > 10000n) {
        throw httpError(
          400,
          'PAYMENT_MATRIX_PERCENTAGE_INVALID',
          `The ${label} percentage for ${row.category} must be between 0 and 100 with at most two decimal places.`,
        );
      }
      total += value;
    }
    if (total !== 10000n) {
      throw httpError(
        400,
        'PAYMENT_MATRIX_SUM_INVALID',
        `The four percentages for ${row.category} must sum to exactly 100.`,
      );
    }
  }
}

export function registerLoaRoutes(
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
      url: '/api/loa-documents',
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        querystring: UploadLoaQuerySchema,
        response: { 201: LoaDocumentDetailSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { filename } = request.query;

      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the LOA as an application/pdf request body.',
        );
      }
      // Magic bytes, not just the declared content type (docs/SECURITY.md).
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      // Authorisation BEFORE any expensive work: an unauthorised caller
      // must not be able to spend a malware scan or a pdftotext run.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);

      const sha256 = createHash('sha256').update(body).digest('hex');
      const documentId = crypto.randomUUID();
      const objectKey = `${organisationId}/loa/${documentId}.pdf`;

      // Storage write and extraction run OUTSIDE the tenant transaction:
      // pdftotext may take tens of seconds and must not hold a pooled
      // connection. A failure here leaves at worst an orphan object under
      // a UUID key, never a database row without its document.
      await storage.put(objectKey, body);
      let status: LoaDocument['extractionStatus'];
      let payload: ExtractionPayload | { error: string };
      try {
        const { layoutText: sourceText, rawText: rawSourceText } =
          await extractLoaPdfText(body);
        payload = {
          sourceText,
          rawSourceText,
          review: reviewLoaLetter(sourceText, { rawItemText: rawSourceText }),
        };
        status = 'review';
      } catch (error) {
        payload = {
          error: error instanceof Error ? error.message : 'extraction failed',
        };
        status = 'failed';
      }

      const row = await tenant(async (tx) => {
        // Re-checked inside the writing transaction: the role could
        // have been revoked while the scan and extraction ran.
        await requireWriterRole(tx, user.id);

        const [inserted] = await tx<LoaDocumentRow[]>`
            insert into loa_documents (
              id, organisation_id, object_key, original_filename, sha256,
              media_type, size_bytes, extraction_status, extraction_payload,
              uploaded_by_user_id
            )
            values (
              ${documentId}, ${organisationId}, ${objectKey}, ${filename},
              ${sha256}, 'application/pdf', ${body.length}, ${status},
              ${jsonb(tx, payload)}, ${user.id}
            )
            returning id, original_filename, sha256, size_bytes,
                      extraction_status, confirmed_work_id, created_at,
                      extraction_payload
          `;
        if (!inserted) throw new Error('loa_documents insert returned no row');

        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'loa.uploaded', 'loa_documents',
              ${documentId},
              ${jsonb(tx, { filename, sha256, sizeBytes: body.length, extractionStatus: status })}
            )
          `;
        return inserted;
      });
      return reply.status(201).send(toDocumentDetail(row));
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/loa-documents',
      schema: {
        response: { 200: LoaDocumentListResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }) => {
      const rows = await tenant(async (tx) => {
        // Owner/office run the upload/review workflow and see every
        // document. Site/viewer members see only documents already
        // confirmed into Works within their scope — unconfirmed uploads
        // (and their extraction payloads) are the writers' workspace
        // (external re-audit).
        const membership = await membershipOf(tx, user.id);
        const writer = membership?.role === 'owner' || membership?.role === 'office';
        if (writer) {
          return tx<LoaDocumentRow[]>`
              select id, original_filename, sha256, size_bytes,
                     extraction_status, confirmed_work_id, created_at
              from loa_documents
              where document_kind = 'loa'
              order by created_at desc, id
            `;
        }
        const full = membership !== undefined && membership.work_scope !== 'assigned';
        return tx<LoaDocumentRow[]>`
            select id, original_filename, sha256, size_bytes,
                   extraction_status, confirmed_work_id, created_at
            from loa_documents
            where document_kind = 'loa'
              and confirmed_work_id is not null
              and (${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = loa_documents.confirmed_work_id
                  and wa.user_id = ${user.id}
              ))
            order by created_at desc, id
          `;
      });
      return { documents: rows.map(toDocument) };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/loa-documents/:id',
      schema: {
        params: DocumentParamsSchema,
        response: { 200: LoaDocumentDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      const row = await tenant(async (tx) => {
        const [found] = await tx<LoaDocumentRow[]>`
            select id, original_filename, sha256, size_bytes,
                   extraction_status, confirmed_work_id, created_at,
                   extraction_payload
            from loa_documents
            where id = ${id} and document_kind = 'loa'
          `;
        if (!found) {
          throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
        }
        // Same visibility rule as the list; the denial is 404 so a
        // guessed identifier does not confirm the document exists.
        const membership = await membershipOf(tx, user.id);
        const writer = membership?.role === 'owner' || membership?.role === 'office';
        if (!writer) {
          let visible = false;
          if (membership !== undefined && found.confirmed_work_id !== null) {
            if (membership.work_scope !== 'assigned') {
              visible = true;
            } else {
              const [assignment] = await tx<{ id: string }[]>`
                  select id from work_assignments
                  where work_id = ${found.confirmed_work_id}
                    and user_id = ${user.id}
                `;
              visible = assignment !== undefined;
            }
          }
          if (!visible) {
            throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
          }
        }
        return found;
      });
      return toDocumentDetail(row);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/loa-documents/:id/confirm',
      schema: {
        params: DocumentParamsSchema,
        body: ConfirmWorkRequestSchema,
        response: { 201: WorkDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: documentId } = request.params;
      const body = request.body;
      assertPricingShapeCoherent(body);
      assertPbgRequirementCoherent(body);
      assertInitialPaymentMatrix(body.paymentMatrix);

      const result = await tenant(async (tx) => {
        // Needs the organisation's timezone, so it runs here rather
        // than beside the two synchronous assert* calls above.
        await assertLetterDateCoherent(tx, organisationId, body.letterDate);

        const [document] = await tx<
          { id: string; extraction_status: string; extraction_payload: unknown }[]
        >`
            select id, extraction_status, extraction_payload
            from loa_documents
            where id = ${documentId} and document_kind = 'loa'
            for update
          `;
        if (!document) {
          throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
        }
        if (document.extraction_status !== 'review') {
          throw httpError(
            409,
            'DOCUMENT_NOT_REVIEWABLE',
            `Only documents in review can be confirmed (status: ${document.extraction_status}).`,
          );
        }
        const parsedPayload = parseJsonbColumn(document.extraction_payload);
        const payload =
          parsedPayload !== null &&
          typeof parsedPayload === 'object' &&
          'review' in parsedPayload
            ? (parsedPayload as unknown as ExtractionPayload)
            : null;

        // The reviewer-confirmed PBG requirement lands on the Work in
        // this same atomic transaction; its provenance payload is built
        // from the STORED extraction payload, never from the client.
        const pbg = body.pbgRequirement;
        const pbgSource =
          pbg === undefined ? null : pbgRequirementSourceFor(payload, pbg);

        const [work] = await tx<WorkRow[]>`
            insert into works (
              organisation_id, work_code, letter_number, letter_date, title,
              advertised_value, contract_value, pricing_shape,
              letter_percentage, letter_percentage_direction,
              pbg_required_amount, pbg_submission_days, pbg_extension_days,
              pbg_penal_interest_percent, pbg_requirement_source,
              created_by_user_id
            )
            values (
              ${organisationId}, ${body.workCode}, ${body.letterNumber},
              ${body.letterDate}, ${body.title}, ${body.advertisedValue},
              ${body.contractValue}, ${body.pricingShape},
              ${body.letterPercentage ?? null},
              ${body.letterPercentageDirection ?? null},
              ${pbg?.requiredAmount ?? null}, ${pbg?.submissionDays ?? null},
              ${pbg?.extensionDays ?? null}, ${pbg?.penalInterestPercent ?? null},
              ${pbgSource === null ? null : jsonb(tx, pbgSource)},
              ${user.id}
            )
            returning id, work_code, letter_number, letter_date::text as letter_date,
                      title, advertised_value, contract_value, pricing_shape,
                      letter_percentage, letter_percentage_direction,
                      pbg_required_amount::text as pbg_required_amount,
                      pbg_submission_days, pbg_extension_days,
                      pbg_penal_interest_percent::text as pbg_penal_interest_percent,
                      status, completed_at, completed_by_user_id,
                      completion_note, created_at
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'WORK_EXISTS',
              'A Work with this work code or letter number already exists.',
            );
          }
          throw error;
        });
        if (!work) throw new Error('works insert returned no row');

        const schedules: WorkSchedule[] = [];
        for (const [index, schedule] of body.schedules.entries()) {
          const [scheduleRow] = await tx<{ id: string }[]>`
              insert into work_schedules (
                organisation_id, work_id, schedule_code, title, position
              )
              values (
                ${organisationId}, ${work.id}, ${schedule.scheduleCode},
                ${schedule.title}, ${index + 1}
              )
              returning id
            `;
          if (!scheduleRow) throw new Error('work_schedules insert returned no row');

          const items = [];
          for (const item of schedule.items) {
            const evidence = sourceEvidenceFor(payload, item);
            const [itemRow] = await tx<{ id: string }[]>`
                insert into work_items (
                  organisation_id, work_id, schedule_id, item_number,
                  description, unit_code, awarded_quantity, effective_rate,
                  payment_category, source_evidence
                )
                values (
                  ${organisationId}, ${work.id}, ${scheduleRow.id},
                  ${item.itemNumber}, ${item.description}, ${item.unitCode},
                  ${item.awardedQuantity}, ${item.effectiveRate},
                  ${item.paymentCategory ?? null}, ${jsonb(tx, evidence)}
                )
                returning id
              `;
            if (!itemRow) throw new Error('work_items insert returned no row');
            items.push({
              id: itemRow.id,
              scheduleId: scheduleRow.id,
              itemNumber: item.itemNumber,
              description: item.description,
              unitCode: item.unitCode,
              awardedQuantity: item.awardedQuantity,
              effectiveRate: item.effectiveRate,
              // Serial traceability is switched on per item after
              // confirmation, once the contractor knows which items
              // ship serialised equipment.
              requiresSerials: false,
              // Milestone 8: reviewer-set at confirmation (the parser
              // never proposes it); editable later via the payment
              // category route.
              paymentCategory: item.paymentCategory ?? null,
            });
          }
          schedules.push({
            id: scheduleRow.id,
            scheduleCode: schedule.scheduleCode,
            title: schedule.title,
            position: index + 1,
            items,
          });
        }

        for (const matrixRow of body.paymentMatrix ?? []) {
          await tx`
              insert into payment_matrices (
                organisation_id, work_id, category, pct_supply,
                pct_installation, pct_pac, pct_final_bill, created_by_user_id
              )
              values (
                ${organisationId}, ${work.id}, ${matrixRow.category},
                ${matrixRow.pctSupply}, ${matrixRow.pctInstallation},
                ${matrixRow.pctPac}, ${matrixRow.pctFinalBill}, ${user.id}
              )
            `;
        }

        await tx`
            update loa_documents
            set confirmed_work_id = ${work.id},
                extraction_status = case
                  when id = ${documentId} then 'confirmed'
                  else extraction_status
                end
            where id = ${documentId} or parent_loa_document_id = ${documentId}
          `;

        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'work.created', 'works', ${work.id},
              ${jsonb(tx, {
                loaDocumentId: documentId,
                workCode: body.workCode,
                scheduleCount: body.schedules.length,
                itemCount: body.schedules.reduce(
                  (total, schedule) => total + schedule.items.length,
                  0,
                ),
                manualItemCount: body.schedules.reduce(
                  (total, schedule) =>
                    total +
                    schedule.items.filter((item) => item.manualEntry === true).length,
                  0,
                ),
                categorisedItemCount: body.schedules.reduce(
                  (total, schedule) =>
                    total +
                    schedule.items.filter((item) => item.paymentCategory !== undefined)
                      .length,
                  0,
                ),
                paymentMatrixRows: body.paymentMatrix?.length ?? 0,
                pbgRequirement:
                  pbg === undefined
                    ? null
                    : {
                        requiredAmount: pbg.requiredAmount,
                        submissionDays: pbg.submissionDays,
                        extensionDays: pbg.extensionDays ?? null,
                        penalInterestPercent: pbg.penalInterestPercent ?? null,
                        provenance: pbgSource?.provenance ?? null,
                      },
              })}
            )
          `;

        // An 'assigned'-scoped confirmer must be able to see the Work
        // they just created: grant their assignment in this same
        // transaction, mirroring the owner-managed assignment writes
        // (identity.ts) in column set and audit shape. Owners and
        // 'all'-scope members see every Work and need no row.
        const membership = await membershipOf(tx, user.id);
        if (membership?.work_scope === 'assigned') {
          const previousAssignments = await tx<{ work_id: string }[]>`
              select work_id from work_assignments
              where user_id = ${user.id}
              order by created_at
            `;
          await tx`
              insert into work_assignments (
                organisation_id, work_id, user_id, created_by_user_id
              )
              values (${organisationId}, ${work.id}, ${user.id}, ${user.id})
            `;
          const previousWorkIds = previousAssignments.map((row) => row.work_id);
          // Assignments are a set; both sides sort so the trail matches
          // the owner-managed replace-set audits exactly.
          const assignmentChanges = auditDiff(
            { workIds: [...previousWorkIds].sort() },
            { workIds: [...previousWorkIds, work.id].sort() },
          );
          await tx`
              insert into audit_events (
                organisation_id, actor_user_id, action, entity_type, details
              )
              values (
                ${organisationId}, ${user.id}, 'membership.assignments_set',
                'work_assignments',
                ${jsonb(tx, {
                  memberUserId: user.id,
                  before: assignmentChanges.before,
                  after: assignmentChanges.after,
                })}
              )
            `;
        }

        return { work: toWork(work), schedules };
      }).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          throw httpError(
            409,
            'DUPLICATE_ENTRY',
            'A schedule code, position, or item number repeats within this Work.',
          );
        }
        throw error;
      });
      return reply.status(201).send(result);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works',
      schema: { response: { 200: WorkListResponseSchema, ...errorResponses } },
    },
    async ({ user, tenant }) => {
      const rows = await tenant(async (tx) => {
        // 'assigned'-scoped memberships list only their Works.
        const full = await hasFullWorkScope(tx, user.id);
        return tx<WorkRow[]>`
            select id, work_code, letter_number, letter_date::text as letter_date,
                   title, advertised_value, contract_value, pricing_shape,
                   letter_percentage, letter_percentage_direction,
                   pbg_required_amount::text as pbg_required_amount,
                   pbg_submission_days, pbg_extension_days,
                   pbg_penal_interest_percent::text as pbg_penal_interest_percent,
                   status, completed_at, completed_by_user_id, completion_note,
                   created_at
            from works w
            where deleted_at is null
              and (${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = w.id and wa.user_id = ${user.id}
              ))
            order by created_at desc, id
          `;
      });
      return { works: rows.map(toWork) };
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id',
      schema: {
        params: DocumentParamsSchema,
        response: { 200: WorkDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, id);
        const [work] = await tx<(WorkRow & { allow_excess_delivery: boolean })[]>`
          select id, work_code, letter_number, letter_date::text as letter_date,
                 title, advertised_value, contract_value, pricing_shape,
                 letter_percentage, letter_percentage_direction,
                 pbg_required_amount::text as pbg_required_amount,
                 pbg_submission_days, pbg_extension_days,
                 pbg_penal_interest_percent::text as pbg_penal_interest_percent,
                 status, completed_at, completed_by_user_id, completion_note,
                 created_at, allow_excess_delivery
          from works
          where id = ${id} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        const scheduleRows = await tx<
          { id: string; schedule_code: string; title: string; position: number }[]
        >`
          select id, schedule_code, title, position
          from work_schedules
          where work_id = ${id}
          order by position
        `;
        const itemRows = await tx<
          {
            id: string;
            schedule_id: string;
            item_number: string;
            description: string;
            unit_code: string;
            awarded_quantity: string;
            effective_rate: string;
            effective_quantity: string | null;
            effective_unit_rate: string | null;
            effective_description: string | null;
            effective_unit: string | null;
            amendment_added: boolean;
            requires_serials: boolean;
            payment_category:
              | 'SUPPLY'
              | 'SUPPLY_AND_INSTALLATION'
              | 'PURE_INSTALLATION'
              | 'SPARE_SUPPLY'
              | null;
            installed_quantity: string;
            pac_certified_quantity: string;
          }[]
        >`
          select id, schedule_id, item_number, description, unit_code,
                 awarded_quantity, effective_rate,
                 effective_quantity::text as effective_quantity,
                 effective_unit_rate::text as effective_unit_rate,
                 effective_description, effective_unit, amendment_added,
                 requires_serials, payment_category,
                 -- Milestone 7: the authoritative installed quantity —
                 -- SUM over non-cancelled installation records.
                 coalesce((
                   select sum(i.quantity) from installations i
                   where i.work_item_id = work_items.id and i.status = 'recorded'
                 ), 0)::text as installed_quantity,
                 -- Milestone 8 phase 1: THE pac_qty the Measurement Book
                 -- engine consumes — SUM of certified quantities over
                 -- non-cancelled PAC certificates (legacy §8).
                 coalesce((
                   select sum(pci.certified_quantity)
                   from pac_certificate_items pci
                   join pac_certificates pc on pc.id = pci.pac_certificate_id
                   where pci.work_item_id = work_items.id
                     and pc.status = 'recorded'
                 ), 0)::numeric(18,3)::text as pac_certified_quantity
          from work_items
          where work_id = ${id} and deleted_at is null
          order by item_number
        `;

        const schedules: WorkSchedule[] = scheduleRows.map((schedule) => ({
          id: schedule.id,
          scheduleCode: schedule.schedule_code,
          title: schedule.title,
          position: schedule.position,
          items: itemRows
            .filter((item) => item.schedule_id === schedule.id)
            .map((item) => ({
              id: item.id,
              scheduleId: item.schedule_id,
              itemNumber: item.item_number,
              description: item.description,
              unitCode: item.unit_code,
              awardedQuantity: item.awarded_quantity,
              effectiveRate: canonicalRateText(item.effective_rate),
              // Amendment overlays (Milestone 6): null = original applies.
              effectiveQuantity: item.effective_quantity,
              effectiveUnitRate:
                item.effective_unit_rate === null
                  ? null
                  : canonicalRateText(item.effective_unit_rate),
              effectiveDescription: item.effective_description,
              effectiveUnit: item.effective_unit,
              amendmentAdded: item.amendment_added,
              requiresSerials: item.requires_serials,
              installedQuantity: item.installed_quantity,
              // Milestone 8: null = uncategorised (resolves through the
              // Work's UNCATEGORISED matrix row).
              paymentCategory: item.payment_category,
              pacCertifiedQuantity: item.pac_certified_quantity,
            })),
        }));
        return {
          work: { ...toWork(work), allowExcessDelivery: work.allow_excess_delivery },
          schedules,
        };
      });
    },
  );
}
