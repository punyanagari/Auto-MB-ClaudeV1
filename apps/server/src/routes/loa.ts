import { createHash } from 'node:crypto';
import {
  ConfirmWorkRequestSchema,
  DiscardLoaDocumentRequestSchema,
  DiscardLoaDocumentResponseSchema,
  ListLoaDocumentsQuerySchema,
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
  type ConfirmWorkSchedule,
  type LoaDocument,
  type LoaDocumentDetail,
  type PdfSignatureReport,
  type LoaLetterNumberMatch,
  type PaymentMatrixCategory,
  type Work,
  type WorkItemPaymentCategory,
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
import { acceptedRateFrom, type AcceptedRateBasis } from '../accepted-rate.js';
import { assertGstRateNotified } from '../gst-rates.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { assertExtractedValuesUnmodified } from '../loa-extracted-values.js';
import { extractLoaPdfText, PdfToTextConfigurationError } from '../loa-extract.js';
import type { MalwareScanner } from '../malware-scan.js';
import { canonicalRateText } from '../rate-text.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import { verifyUploadedPdf } from '../document-signature-evidence.js';
import { assertAmcStagePercentages } from './payment.js';
import type { TrustAnchorStore } from '../pdf-signature.js';
import type { ObjectStorage } from '../storage.js';
import { audit, upstreamErrorResponses as errorResponses } from './shared.js';
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

interface LoaDocumentRow {
  id: string;
  original_filename: string;
  sha256: string;
  size_bytes: string | number;
  extraction_status: LoaDocument['extractionStatus'];
  confirmed_work_id: string | null;
  created_at: Date;
  extraction_payload?: unknown;
  signature_status: LoaDocument['signatureStatus'];
  signature_verdict?: unknown;
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
    signatureStatus: row.signature_status,
  };
}

function toDocumentDetail(
  row: LoaDocumentRow,
  letterNumberMatches: readonly LoaLetterNumberMatch[],
): LoaDocumentDetail {
  return {
    ...toDocument(row),
    extractionPayload: parseJsonbColumn(row.extraction_payload),
    letterNumberMatches: [...letterNumberMatches],
    // Null only when the row predates migration 0060; the status column
    // says `not_checked` in exactly that case and never claims the
    // document is unsigned.
    signatureVerdict:
      (parseJsonbColumn(row.signature_verdict) as PdfSignatureReport | null) ?? null,
  };
}

/** The letter number the parser read off this document, or null when the
 * extraction failed or the clause could not be located. Read from the
 * STORED payload, never from a client. */
function parsedLetterNumber(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const review = (payload as { review?: unknown }).review;
  if (review === null || typeof review !== 'object') return null;
  const header = (review as { header?: unknown }).header;
  if (header === null || typeof header !== 'object') return null;
  const letterNumber = (header as { letterNumber?: unknown }).letterNumber;
  if (letterNumber === null || typeof letterNumber !== 'object') return null;
  const value = (letterNumber as { value?: unknown }).value;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Earlier intakes of the same letter number, within the organisation.
 *
 * A repeated letter number is NOT a refusal. Railways revise letters:
 * a corrigendum, a re-issue after a corrected schedule, an amended
 * acceptance — all print the number the first letter printed, and the
 * later file is the one the contractor must work from. Refusing it would
 * strand the revision; saying nothing would let the reviewer spend an
 * afternoon correcting rows only to have the confirm refused, because
 * works.letter_number is unique forever (PRODUCT.md invariant 2). So the
 * reviewer is warned, and told exactly which earlier intake it collides
 * with.
 *
 * Confirmed documents are reported through their Work rather than twice:
 * once a letter has become a Work, the Work is the thing the reviewer
 * needs to open. Discarded documents are not reported at all — they were
 * withdrawn, and naming them would be an alarm about nothing. */
async function loadLetterNumberMatches(
  tx: TransactionSql,
  documentId: string,
  letterNumber: string | null,
): Promise<LoaLetterNumberMatch[]> {
  if (letterNumber === null) return [];
  const documents = await tx<
    {
      id: string;
      original_filename: string;
      extraction_status: string;
      created_at: Date;
    }[]
  >`
    select id, original_filename, extraction_status, created_at
    from loa_documents
    where document_kind = 'loa'
      and id <> ${documentId}
      and confirmed_work_id is null
      and extraction_status <> 'discarded'
      and extraction_payload -> 'review' -> 'header' -> 'letterNumber' ->> 'value'
          = ${letterNumber}
    order by created_at, id
  `;
  const works = await tx<
    { id: string; work_code: string; status: string; created_at: Date }[]
  >`
    select id, work_code, status, created_at
    from works
    where letter_number = ${letterNumber} and deleted_at is null
    order by created_at, id
  `;
  return [
    ...documents.map((row) => ({
      kind: 'document' as const,
      id: row.id,
      letterNumber,
      label: row.original_filename,
      status: row.extraction_status,
      confirmedWorkId: null,
      at: row.created_at.toISOString(),
    })),
    ...works.map((row) => ({
      kind: 'work' as const,
      id: row.id,
      letterNumber,
      label: row.work_code,
      status: row.status,
      confirmedWorkId: row.id,
      at: row.created_at.toISOString(),
    })),
  ];
}

const DOCUMENT_STATE_WORDS: Record<string, string> = {
  pending: 'waiting for extraction',
  processing: 'being extracted',
  review: 'waiting for review',
  confirmed: 'confirmed',
  failed: 'extraction failed',
  discarded: 'discarded',
};

/** Refuses a BYTE-IDENTICAL re-upload, naming the document the
 * organisation already holds.
 *
 * The hash is over the file itself, so this catches exactly one thing:
 * the same PDF sent twice. A revised letter — different bytes, same
 * letter number — is a different document and passes; the reviewer is
 * warned about it instead (loadLetterNumberMatches).
 *
 * Discarded documents are excluded on purpose: withdrawing an upload has
 * to leave the operator free to send the very same file again, which is
 * the ordinary repair after discarding one by mistake.
 *
 * This is a usability refusal, not a database invariant, so it is not
 * backed by a unique index: an organisation that has already uploaded
 * the same letter twice (the state this change exists to give an exit
 * from) must still migrate. Two byte-identical uploads racing inside the
 * same millisecond can therefore both land; the check runs again inside
 * the writing transaction, which narrows that window to the overlap of
 * two transactions rather than the whole scan-and-extract. */
async function assertNotDuplicateUpload(
  tx: TransactionSql,
  sha256: string,
): Promise<void> {
  const [existing] = await tx<
    {
      id: string;
      original_filename: string;
      extraction_status: LoaDocument['extractionStatus'];
      confirmed_work_id: string | null;
      created_at: Date;
    }[]
  >`
    select id, original_filename, extraction_status, confirmed_work_id, created_at
    from loa_documents
    where document_kind = 'loa'
      and sha256 = ${sha256}
      and extraction_status <> 'discarded'
    order by created_at, id
    limit 1
  `;
  if (!existing) return;
  const uploadedOn = existing.created_at.toISOString().slice(0, 10);
  const state =
    DOCUMENT_STATE_WORDS[existing.extraction_status] ?? existing.extraction_status;
  const outcome =
    existing.confirmed_work_id === null
      ? 'It has not been confirmed into a Work.'
      : 'It has already been confirmed into a Work.';
  throw httpError(
    409,
    'LOA_DOCUMENT_DUPLICATE',
    `This is the same file as ${existing.original_filename}, uploaded on ${uploadedOn} and ${state}. ${outcome} Open that document instead, or discard it first if you meant to replace it.`,
    {
      existingRecordId: existing.id,
      originalFilename: existing.original_filename,
      uploadedAt: existing.created_at.toISOString(),
      extractionStatus: existing.extraction_status,
      confirmedWorkId: existing.confirmed_work_id,
    },
  );
}

/**
 * The accepted-rate basis for every schedule in a confirmation (owner
 * ruling 1, migration 0063). The reviewer never supplies it: it is the
 * letter's own percentage, taken from the confirmed header on a
 * letter-percentage letter and from the STORED parse's per-schedule
 * headers otherwise.
 *
 * Per-schedule is not a variant of letter-level — a per-schedule letter
 * legitimately mixes both percentage AND direction across its own
 * schedules (PL276-GTL: 7.77% above, 8.88% above, 49.49% below, 28.28%
 * below), so there is no single letter figure to fall back to.
 */
function acceptedBasisByScheduleId(
  payload: ExtractionPayload | null,
): ReadonlyMap<string, AcceptedRateBasis> {
  const bases = new Map<string, AcceptedRateBasis>();
  // `extraction_payload` is JSONB and older rows carry other shapes — a
  // synthetic identity-only payload, a failed extraction's `{ error }` —
  // so every level is narrowed rather than assumed, exactly as
  // loa-extracted-values.ts narrows the same column. A payload that
  // carries no recognisable totals block simply yields no bases, and the
  // caller's own refusal decides whether that is fatal.
  const totals = (payload as unknown as Record<string, unknown> | null)?.['review'];
  const shape =
    typeof totals === 'object' && totals !== null
      ? (totals as Record<string, unknown>)['pricingShape']
      : null;
  const entries =
    typeof shape === 'object' && shape !== null
      ? (shape as Record<string, unknown>)['scheduleTotals']
      : null;
  if (!Array.isArray(entries)) return bases;

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const scheduleId = entry['scheduleId'];
    const percentage = entry['percentage'];
    const direction = entry['direction'];
    if (
      typeof scheduleId !== 'string' ||
      typeof percentage !== 'number' ||
      !Number.isFinite(percentage) ||
      (direction !== 'below' && direction !== 'above' && direction !== 'at_par')
    ) {
      continue;
    }
    bases.set(scheduleId, { percentage: percentage.toFixed(3), direction });
  }
  return bases;
}

/**
 * Which parsed schedule a confirmation's schedule stands for, by the
 * `sourceRef` its own parsed rows carry.
 *
 * A payload schedule holding rows from two different parsed schedules
 * would have no single accepted percentage, and recording either would
 * make the stored figure a lie about half its items. That is refused
 * rather than resolved. A schedule of purely manual rows binds to nothing,
 * which is not an error — see the note on manual rows below.
 */
function parsedScheduleIdOf(
  schedule: ConfirmWorkSchedule,
  payload: ExtractionPayload | null,
): { id: string | null } | { conflict: readonly string[] } {
  const ids = new Set<string>();
  for (const item of schedule.items) {
    if (item.manualEntry === true) continue;
    const ref = item.sourceRef;
    if (!ref) continue; // ITEM_EVIDENCE_REQUIRED names this, per item.
    // Only refs that actually RESOLVE count. An unresolvable one is
    // SOURCE_REF_UNRESOLVED's to report, per item and by name — counting
    // it here would answer a bogus reference with a confusing complaint
    // about schedules spanning each other.
    const resolves = payload?.review.items?.some(
      (candidate) =>
        (candidate.schedule?.id ?? 'UNBOUND') === ref.scheduleId &&
        candidate.itemSno === ref.itemSno,
    );
    if (resolves === true) ids.add(ref.scheduleId);
  }
  if (ids.size > 1) return { conflict: [...ids].sort() };
  return { id: ids.size === 1 ? ([...ids][0] ?? null) : null };
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
  gst_basis: Work['gstBasis'];
  gst_rate: string;
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
    gstBasis: row.gst_basis,
    gstRate: row.gst_rate,
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
    // The AMC row's extra rule (migration 0068), shared verbatim with
    // the per-row upsert so confirmation and later edits cannot diverge:
    // an AMC item is never delivered and never installed, so those two
    // stages can never carry a quantity.
    assertAmcStagePercentages(row.category, row);
  }
}

export function registerLoaRoutes(
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
      url: '/api/loa-documents',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        querystring: UploadLoaQuerySchema,
        response: { 201: LoaDocumentDetailSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { filename } = request.query;

      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the LOA',
      });
      const sha256 = createHash('sha256').update(body).digest('hex');

      // Authorisation BEFORE any expensive work: an unauthorised caller
      // must not be able to spend a malware scan or a pdftotext run. The
      // duplicate refusal rides along for the same reason — re-sending a
      // file the organisation already holds should cost nothing.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertNotDuplicateUpload(tx, sha256);
      });
      await assertNotMalware(scanner, body);

      // Signature verification runs on the bytes as received, before
      // anything else touches them, and its verdict is stored with the
      // row it describes (migration 0060). It never refuses the upload:
      // an unsigned or badly-signed letter is still the letter the
      // organisation was sent, and refusing it here would take the
      // decision away from the owner, who has to make it per document
      // type. Pure CPU, so it runs outside the transaction.
      const signature = verifyUploadedPdf(body, pdfTrustAnchors, request.log);

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
        // A misconfigured extraction binary would otherwise persist a
        // permanently 'failed' document for a perfectly good letter, and
        // hide an operator fault as a per-document one. Refuse the upload
        // instead: nothing is written, and re-uploading after the server is
        // fixed succeeds. (The stored object is orphaned under its UUID key,
        // the same tolerated outcome as any other post-storage failure.)
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'PDF text extraction is not correctly configured on the server. The letter was not stored for review; contact your administrator.',
            { reason: error.message },
          );
        }
        payload = {
          error: error instanceof Error ? error.message : 'extraction failed',
        };
        status = 'failed';
      }

      const stored = await tenant(async (tx) => {
        // Re-checked inside the writing transaction: the role could have
        // been revoked while the scan and extraction ran, and the same
        // file could have been uploaded by somebody else.
        await requireWriterRole(tx, user.id);
        await assertNotDuplicateUpload(tx, sha256);

        const [inserted] = await tx<LoaDocumentRow[]>`
            insert into loa_documents (
              id, organisation_id, object_key, original_filename, sha256,
              media_type, size_bytes, extraction_status, extraction_payload,
              uploaded_by_user_id, signature_status, signature_verdict,
              signature_verified_at
            )
            values (
              ${documentId}, ${organisationId}, ${objectKey}, ${filename},
              ${sha256}, 'application/pdf', ${body.length}, ${status},
              ${jsonb(tx, payload)}, ${user.id}, ${signature.status},
              ${jsonb(tx, signature.verdict)}, ${signature.verifiedAt}
            )
            returning id, original_filename, sha256, size_bytes,
                      extraction_status, confirmed_work_id, created_at,
                      extraction_payload, signature_status, signature_verdict
          `;
        if (!inserted) throw new Error('loa_documents insert returned no row');

        await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id, details
            )
            values (
              ${organisationId}, ${user.id}, 'loa.uploaded', 'loa_documents',
              ${documentId},
              ${jsonb(tx, {
                filename,
                sha256,
                sizeBytes: body.length,
                extractionStatus: status,
                signatureStatus: signature.status,
              })}
            )
          `;
        // Computed in the same transaction that inserted the row, so the
        // reviewer is warned about a colliding letter number from the
        // moment the upload answers.
        const letterNumberMatches = await loadLetterNumberMatches(
          tx,
          documentId,
          parsedLetterNumber(payload),
        );
        return { inserted, letterNumberMatches };
      });
      return reply
        .status(201)
        .send(toDocumentDetail(stored.inserted, stored.letterNumberMatches));
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/loa-documents',
      schema: {
        querystring: ListLoaDocumentsQuerySchema,
        response: { 200: LoaDocumentListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const includeDiscarded = request.query.includeDiscarded ?? false;
      const rows = await tenant(async (tx) => {
        // Owner/office run the upload/review workflow and see every
        // document. Site/viewer members see only documents already
        // confirmed into Works within their scope — unconfirmed uploads
        // (and their extraction payloads) are the writers' workspace
        // (external re-audit).
        const membership = await membershipOf(tx, user.id);
        const writer = membership?.role === 'owner' || membership?.role === 'office';
        if (writer) {
          // Discarded documents leave the working list by default; the
          // row itself is retention material and stays readable to the
          // writers who run intake, on request.
          return tx<LoaDocumentRow[]>`
              select id, original_filename, sha256, size_bytes,
                     extraction_status, confirmed_work_id, created_at,
                     signature_status
              from loa_documents
              where document_kind = 'loa'
                and (${includeDiscarded} or extraction_status <> 'discarded')
              order by created_at desc, id
            `;
        }
        // Site/viewer members read only through a confirmed Work, and a
        // discarded document never has one, so their branch needs no
        // discard clause.
        const full = membership !== undefined && membership.work_scope !== 'assigned';
        return tx<LoaDocumentRow[]>`
            select id, original_filename, sha256, size_bytes,
                   extraction_status, confirmed_work_id, created_at,
                   signature_status
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
                   extraction_payload, signature_status, signature_verdict
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
        return {
          found,
          letterNumberMatches: await loadLetterNumberMatches(
            tx,
            found.id,
            parsedLetterNumber(parseJsonbColumn(found.extraction_payload)),
          ),
        };
      });
      return toDocumentDetail(row.found, row.letterNumberMatches);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/loa-documents/:id/discard',
      schema: {
        params: DocumentParamsSchema,
        body: DiscardLoaDocumentRequestSchema,
        response: { 200: DiscardLoaDocumentResponseSchema, ...errorResponses },
      },
      // The same gate as upload: whoever may put an intake package into
      // the organisation may take an unconfirmed one back out. No
      // explicit cancel authority is demanded — unlike the cancel of an
      // issued challan or a PAC certificate, discarding here withdraws
      // nothing from the quantity ledger and voids no numbered document,
      // because a discardable document has never become one.
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { reason } = request.body;
      return tenant(async (tx) => {
        const [existing] = await tx<
          {
            extraction_status: string;
            confirmed_work_id: string | null;
            original_filename: string;
          }[]
        >`
          select extraction_status, confirmed_work_id, original_filename
          from loa_documents
          where id = ${id} and document_kind = 'loa'
          for update
        `;
        if (!existing) {
          throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
        }
        if (existing.extraction_status === 'discarded') {
          throw httpError(
            409,
            'DOCUMENT_DISCARDED',
            'This LOA document has already been discarded.',
          );
        }
        // The named refusal. A confirmed letter is the Work's source of
        // truth: every work_item's source_evidence points into this
        // document's extraction payload, so discarding it would leave the
        // Work's evidence pointing at a document the product presents as
        // thrown away. The 0055 trigger refuses the same move at the
        // database, for every writer.
        if (
          existing.extraction_status === 'confirmed' ||
          existing.confirmed_work_id !== null
        ) {
          throw httpError(
            409,
            'DOCUMENT_CONFIRMED',
            `${existing.original_filename} has already been confirmed into a Work and is that Work's source of truth, so it cannot be discarded. Nothing was changed.`,
            { confirmedWorkId: existing.confirmed_work_id },
          );
        }
        const [discarded] = await tx<LoaDocumentRow[]>`
          update loa_documents
          set extraction_status = 'discarded', discarded_at = now(),
              discarded_by_user_id = ${user.id},
              discard_reason = ${reason ?? null}
          where id = ${id}
          returning id, original_filename, sha256, size_bytes,
                    extraction_status, confirmed_work_id, created_at,
                    signature_status
        `;
        if (!discarded) throw new Error('loa_documents discard returned no row');

        // The supporting contract documents belong to the intake package,
        // not to themselves: a NIT or tender specification exists only as
        // evidence attached to this letter, and the 0055 trigger refuses
        // to attach a new one to a discarded letter. They go together.
        const supporting = await tx<{ id: string; original_filename: string }[]>`
          update loa_documents
          set extraction_status = 'discarded', discarded_at = now(),
              discarded_by_user_id = ${user.id},
              discard_reason = ${reason ?? null}
          where parent_loa_document_id = ${id}
            and extraction_status <> 'discarded'
          returning id, original_filename
        `;

        await audit(tx, organisationId, user.id, 'loa.discarded', 'loa_documents', id, {
          filename: existing.original_filename,
          before: { extractionStatus: existing.extraction_status },
          after: { extractionStatus: 'discarded' },
          reason: reason ?? null,
          supportingDocumentIds: supporting.map((row) => row.id),
        });
        // One row per discarded supporting document, written as a single
        // statement (the shared `audit` helper writes exactly one row, so
        // this insert is inline like the other multi-row audit writes).
        if (supporting.length > 0) {
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, entity_id,
              details
            )
            select ${organisationId}, ${user.id}, 'contract_source.discarded',
                   'loa_documents', doc.id, doc.details::jsonb
            from unnest(
              ${supporting.map((row) => row.id)}::uuid[],
              ${supporting.map((row) =>
                JSON.stringify({
                  filename: row.original_filename,
                  parentLoaDocumentId: id,
                  reason: reason ?? null,
                }),
              )}::text[]
            ) as doc(id, details)
          `;
        }
        return {
          document: toDocument(discarded),
          discardedSupportingDocumentIds: supporting.map((row) => row.id),
        };
      });
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
        if (document.extraction_status === 'discarded') {
          throw httpError(
            409,
            'DOCUMENT_DISCARDED',
            'This LOA document was discarded and can no longer become a Work. Upload the letter again if it was discarded by mistake.',
          );
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

        // THE EXTRACTED-VALUE LOCK (owner ruling, 2026-08-13). Every value
        // the stored parse established and did not flag is read-only; the
        // reviewer may only fill the holes the parser itself declared.
        // Derived per letter from the STORED payload — see
        // src/loa-extracted-values.ts for the rule and its exclusions. It
        // runs before the Work is inserted, so a refusal saves nothing.
        const valueLock = assertExtractedValuesUnmodified(payload?.review, body);

        // The reviewer-confirmed PBG requirement lands on the Work in
        // this same atomic transaction; its provenance payload is built
        // from the STORED extraction payload, never from the client.
        const pbg = body.pbgRequirement;
        const pbgSource =
          pbg === undefined ? null : pbgRequirementSourceFor(payload, pbg);

        // The GST basis (migration 0062). The parser proposes nothing —
        // the letter is silent on GST — so this is the reviewer's
        // statement, defaulted to the common case: an Indian works
        // contract quoting rates inclusive of 18% GST. Everything
        // downstream that compares money against this Work's contract
        // value reads it back from here (src/executed-value.ts).
        const gstBasis = body.gstBasis ?? 'inclusive';
        const gstRate = body.gstRate ?? '18.00';
        // Notified as of the LETTER date, not today: the basis is a fact
        // about rates quoted in a letter signed then. Same master and same
        // refusal every other tax-bearing document uses.
        await assertGstRateNotified(tx, gstRate, body.letterDate, 'GST basis');
        // The column is numeric(5,2) CHECK (>= 0 AND < 100); GstRateSchema
        // admits '100', so that one value is refused here with a message
        // rather than by an unmapped CHECK violation.
        if (Number(gstRate) >= 100) {
          throw httpError(
            400,
            'GST_RATE_INVALID',
            `A GST rate of ${gstRate}% is not a rate any letter is quoted against. Give the slab the LOA's rates refer to — 18% for an ordinary works contract.`,
          );
        }

        const [work] = await tx<WorkRow[]>`
            insert into works (
              organisation_id, work_code, letter_number, letter_date, title,
              advertised_value, contract_value, pricing_shape,
              letter_percentage, letter_percentage_direction,
              gst_basis, gst_rate,
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
              ${gstBasis}, ${gstRate},
              ${pbg?.requiredAmount ?? null}, ${pbg?.submissionDays ?? null},
              ${pbg?.extensionDays ?? null}, ${pbg?.penalInterestPercent ?? null},
              ${pbgSource === null ? null : jsonb(tx, pbgSource)},
              ${user.id}
            )
            returning id, work_code, letter_number, letter_date::text as letter_date,
                      title, advertised_value, contract_value, pricing_shape,
                      letter_percentage, letter_percentage_direction,
                      gst_basis, gst_rate::text as gst_rate,
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

        // The accepted-rate basis (ruling 1, migration 0063). On a
        // letter-percentage letter the confirmed header carries it, and
        // the header has already been through the extracted-value lock —
        // so it is either the letter's own figure or a hole a human filled,
        // never an invention. On a per-schedule letter it comes from the
        // stored parse, per schedule.
        const letterBasis: AcceptedRateBasis | null =
          body.pricingShape === 'letter_percentage' &&
          body.letterPercentage !== undefined &&
          body.letterPercentageDirection !== undefined
            ? {
                percentage: body.letterPercentage,
                direction: body.letterPercentageDirection,
              }
            : null;
        const scheduleBases = acceptedBasisByScheduleId(payload);

        // Every schedule is resolved and every rate derived BEFORE a
        // single row is written: a confirmation that refuses still saves
        // nothing (the whole handler is one transaction either way), and
        // the schedules and their items then land as one statement each
        // instead of one round-trip per schedule and per item — a full
        // BOQ used to cost hundreds of round-trips inside the
        // transaction that holds the Work.
        const prepared = body.schedules.map((schedule, index) => {
          const binding = parsedScheduleIdOf(schedule, payload);
          if ('conflict' in binding) {
            throw httpError(
              400,
              'SCHEDULE_SPANS_MULTIPLE_PARSED_SCHEDULES',
              `Schedule ${schedule.scheduleCode} holds rows from more than one schedule of the letter (${binding.conflict.join(', ')}). Each schedule accepts one accepted-rate percentage, so its rows must come from one printed schedule. Nothing was saved.`,
            );
          }
          // The one basis that governs every parsed row in this schedule.
          const basis =
            letterBasis ??
            (binding.id === null ? null : (scheduleBases.get(binding.id) ?? null));
          if (basis === null && binding.id !== null) {
            // A per-schedule letter whose header block did not yield a
            // self-consistent percentage. Refused rather than stored at
            // the advertised rate: silently billing the advertised rate is
            // precisely the defect ruling 1 exists to end, and it is worth
            // more to stop here than to create a Work whose every future
            // money figure is wrong by the tender percentage.
            throw httpError(
              400,
              'ACCEPTED_PERCENTAGE_UNREADABLE',
              `The accepted-rate percentage for schedule ${binding.id} could not be read from the letter, so this schedule's rates cannot be derived. The item table prints advertised rates; without the percentage the rate the railway pays is unknown. Discard this LOA document and upload a clearer copy. Nothing was saved.`,
              { scheduleCode: schedule.scheduleCode, parsedScheduleId: binding.id },
            );
          }
          return {
            position: index + 1,
            scheduleCode: schedule.scheduleCode,
            title: schedule.title,
            percentage: basis?.percentage ?? null,
            direction: basis?.direction ?? null,
            items: schedule.items.map((item) => {
              // The submitted rate is the one PRINTED in the letter — that
              // is what the extracted-value lock holds it to. The accepted
              // rate is derived here, on the server, and is what every
              // downstream money figure is measured at.
              //
              // A MANUAL row is not adjusted. It carries no printed rate to
              // move: the reviewer typed a rate for a line the letter's item
              // table does not contain, and applying a tender rebate to a
              // hand-entered figure would silently change a number a human
              // chose deliberately. Its advertised and accepted rates are the
              // same figure, which is exactly what "at the rate entered"
              // means.
              const advertisedRate = item.effectiveRate;
              const acceptedRate =
                item.manualEntry === true || basis === null
                  ? advertisedRate
                  : acceptedRateFrom(advertisedRate, basis);
              return {
                item,
                evidence: sourceEvidenceFor(payload, item),
                advertisedRate,
                acceptedRate,
              };
            }),
          };
        });

        // Positions are assigned above and unique within the Work, so
        // they identify each returned schedule row without depending on
        // the order a multi-row INSERT happens to return.
        const scheduleRows = await tx<{ id: string; position: number }[]>`
            insert into work_schedules (
              organisation_id, work_id, schedule_code, title, position,
              accepted_percentage, accepted_percentage_direction
            )
            select ${organisationId}, ${work.id}, s.schedule_code, s.title,
                   s.position, s.accepted_percentage,
                   s.accepted_percentage_direction
            from unnest(
              ${prepared.map((schedule) => schedule.scheduleCode)}::text[],
              ${prepared.map((schedule) => schedule.title)}::text[],
              ${prepared.map((schedule) => schedule.position)}::int[],
              ${prepared.map((schedule) => schedule.percentage)}::numeric(6,3)[],
              ${prepared.map((schedule) => schedule.direction)}::text[]
            ) as s(
              schedule_code, title, position, accepted_percentage,
              accepted_percentage_direction
            )
            returning id, position
          `;
        const scheduleIdByPosition = new Map(
          scheduleRows.map((row) => [row.position, row.id]),
        );
        const scheduleIdOf = (position: number): string => {
          const scheduleId = scheduleIdByPosition.get(position);
          if (scheduleId === undefined) {
            throw new Error('work_schedules insert returned no row');
          }
          return scheduleId;
        };

        // One flat list across every schedule. Item numbers are unique
        // within a Work (the constraint whose 23505 becomes
        // DUPLICATE_ENTRY below), so they identify the returned ids.
        // Money and quantities travel as the exact decimal strings the
        // request carried and are cast by PostgreSQL to each column's
        // numeric type — never through a JS float.
        const itemsToInsert = prepared.flatMap((schedule) =>
          schedule.items.map((entry) => ({
            ...entry,
            scheduleId: scheduleIdOf(schedule.position),
          })),
        );
        const itemRows =
          itemsToInsert.length === 0
            ? []
            : await tx<{ id: string; item_number: string }[]>`
                insert into work_items (
                  organisation_id, work_id, schedule_id, item_number,
                  description, unit_code, awarded_quantity,
                  advertised_rate, effective_rate,
                  payment_category, source_evidence
                )
                select ${organisationId}, ${work.id}, i.schedule_id,
                       i.item_number, i.description, i.unit_code,
                       i.awarded_quantity, i.advertised_rate, i.effective_rate,
                       i.payment_category, i.source_evidence::jsonb
                from unnest(
                  ${itemsToInsert.map((entry) => entry.scheduleId)}::uuid[],
                  ${itemsToInsert.map((entry) => entry.item.itemNumber)}::text[],
                  ${itemsToInsert.map((entry) => entry.item.description)}::text[],
                  ${itemsToInsert.map((entry) => entry.item.unitCode)}::text[],
                  ${itemsToInsert.map((entry) => entry.item.awardedQuantity)}::numeric(18,3)[],
                  ${itemsToInsert.map((entry) => entry.advertisedRate)}::numeric(18,6)[],
                  ${itemsToInsert.map((entry) => entry.acceptedRate)}::numeric(18,6)[],
                  ${itemsToInsert.map((entry) => entry.item.paymentCategory ?? null)}::text[],
                  ${itemsToInsert.map((entry) => JSON.stringify(entry.evidence))}::text[]
                ) as i(
                  schedule_id, item_number, description, unit_code,
                  awarded_quantity, advertised_rate, effective_rate,
                  payment_category, source_evidence
                )
                returning id, item_number
              `;
        const itemIdByNumber = new Map(
          itemRows.map((row) => [row.item_number, row.id]),
        );
        const itemIdOf = (itemNumber: string): string => {
          const itemId = itemIdByNumber.get(itemNumber);
          if (itemId === undefined) {
            throw new Error('work_items insert returned no row');
          }
          return itemId;
        };

        const schedules: WorkSchedule[] = prepared.map((schedule) => ({
          id: scheduleIdOf(schedule.position),
          scheduleCode: schedule.scheduleCode,
          title: schedule.title,
          position: schedule.position,
          items: schedule.items.map((entry) => ({
            id: itemIdOf(entry.item.itemNumber),
            scheduleId: scheduleIdOf(schedule.position),
            itemNumber: entry.item.itemNumber,
            description: entry.item.description,
            unitCode: entry.item.unitCode,
            awardedQuantity: entry.item.awardedQuantity,
            // The DERIVED rate, not the submitted one: the response says
            // what was stored, and what the Work will be billed at.
            effectiveRate: entry.acceptedRate,
            advertisedRate: entry.advertisedRate,
            // Serial traceability is switched on per item after
            // confirmation, once the contractor knows which items
            // ship serialised equipment.
            requiresSerials: false,
            // Milestone 8: reviewer-set at confirmation (the parser
            // never proposes it); editable later via the payment
            // category route.
            paymentCategory: entry.item.paymentCategory ?? null,
          })),
        }));

        const matrixRows = body.paymentMatrix ?? [];
        if (matrixRows.length > 0) {
          await tx`
              insert into payment_matrices (
                organisation_id, work_id, category, pct_supply,
                pct_installation, pct_pac, pct_final_bill, created_by_user_id
              )
              select ${organisationId}, ${work.id}, m.category, m.pct_supply,
                     m.pct_installation, m.pct_pac, m.pct_final_bill, ${user.id}
              from unnest(
                ${matrixRows.map((matrixRow) => matrixRow.category)}::text[],
                ${matrixRows.map((matrixRow) => matrixRow.pctSupply)}::numeric(5,2)[],
                ${matrixRows.map((matrixRow) => matrixRow.pctInstallation)}::numeric(5,2)[],
                ${matrixRows.map((matrixRow) => matrixRow.pctPac)}::numeric(5,2)[],
                ${matrixRows.map((matrixRow) => matrixRow.pctFinalBill)}::numeric(5,2)[]
              ) as m(
                category, pct_supply, pct_installation, pct_pac, pct_final_bill
              )
            `;
        }

        // A discarded supporting document is excluded: it was withdrawn
        // from the package before confirmation and is terminal, so
        // stamping this Work onto it would both misrepresent the evidence
        // and trip the 0055 immutability guard.
        await tx`
            update loa_documents
            set confirmed_work_id = ${work.id},
                extraction_status = case
                  when id = ${documentId} then 'confirmed'
                  else extraction_status
                end
            where (id = ${documentId} or parent_loa_document_id = ${documentId})
              and extraction_status <> 'discarded'
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
                // The GST basis this Work's executed value will forever be
                // computed on, and whether the reviewer stated it or took
                // the default. Recorded because the basis is not visible in
                // any document: if a Work's execution percentage is ever
                // disputed, this row is the only evidence of which way the
                // question was answered, and by whom.
                gst: {
                  basis: gstBasis,
                  rate: gstRate,
                  stated: body.gstBasis !== undefined,
                },
                // The extracted-value lock's verdict, so the trail shows
                // what was held to the letter, which holes the reviewer
                // filled, and what the payload did with the parsed rows.
                extractedValueLock: {
                  lockedFieldsVerified: valueLock.lockedFieldsVerified,
                  letterHolesFilled: valueLock.letterHolesFilled,
                  itemHolesFilled: valueLock.itemHolesFilled,
                  manualRows: valueLock.manualRows,
                  parsedRowsOmitted: valueLock.parsedRowsOmitted,
                },
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
                   gst_basis, gst_rate::text as gst_rate,
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
                 gst_basis, gst_rate::text as gst_rate,
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
            payment_category: WorkItemPaymentCategory | null;
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
