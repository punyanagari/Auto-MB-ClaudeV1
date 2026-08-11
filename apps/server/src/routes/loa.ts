import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
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
  type UploadLoaQuery,
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
import type { FastifyInstance } from 'fastify';
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
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/** What loa_documents.extraction_payload holds for a parsed document:
 * both extracted text views plus the parser's review payload, all verbatim.
 * A failed extraction stores { error } instead. */
interface ExtractionPayload {
  readonly sourceText: string;
  readonly rawSourceText: string;
  readonly review: LoaReviewPayload;
}

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

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
 * block for that item â€” corrections never overwrite evidence.
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
 * the same value, compared in exact integer minor units â€” never float
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
 * proposal (verbatim, from the STORED extraction payload â€” never from the
 * client) plus the provenance verdict. Values that match the parser's
 * complete proposal are 'parser'; anything else â€” including a requirement
 * entered for a letter whose clause the parser could not read â€” is
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
 * date window measures from â€” delivery challans, installations, PAC
 * certificates and Measurement Books all refuse a date before it, with
 * "today" as their ceiling. A Work confirmed with a letter date in the
 * FUTURE therefore has an empty legal window: no challan, installation,
 * PAC certificate or MB can ever be dated on it, and the dashboard's PBG
 * due date (letter_date + pbg_submission_days) is wrong for the life of
 * the Work. Nothing repairs it either â€” no route rewrites
 * works.letter_date, and the Work cannot be deleted â€” so a mistyped year
 * would brick the Work and burn its work code and letter number forever.
 * Refusal, not a warning, is right: no LOA is dated after the day it is
 * filed.
 *
 * "Today" is the organisation's own timezone (default Asia/Kolkata),
 * never the server clock, mirroring assertChallanDate in challans.ts â€” a
 * same-day IST confirmation made after 18:30 UTC is legitimate.
 * Back-dating stays COMPLETELY unrestricted: a contractor onboarding
 * from paper confirms letters years old. */
async function assertLetterDateCoherent(
  tx: TransactionSql,
  organisationId: string,
  letterDate: string,
): Promise<void> {
  // A day that does not exist ('2026-02-31') must never reach Postgres,
  // where it surfaces as an opaque 500 â€” and it compares LATER than
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
      `The LOA letter date cannot be in the future (today is ${bounds.today}). Check the year printed on the letter â€” the letter date anchors every later document date and cannot be corrected once the Work is confirmed.`,
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
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  app.post(
    '/api/loa-documents',
    {
      bodyLimiãOz¶‰ËkºwµçIÉ½È¹½‘”€ôôô€œÈÌÔÀÔœ¤ì(€€€€€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€€€€€]=I-}a%MQLœ°(€€€€€€€€€€€€€€€€]½É¬İ¥Ñ Ñ¡¥Ìİ½É¬½‘”½È±•ÑÑ•È¹Õµ‰•È…±É•…‘ä•á¥ÍÑÌ¸œ°(€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€€€€€ô¤ì(€€€€€€€€€¥˜€ …İ½É¬¤Ñ¡É½Ü¹•ÜÉÉ½È İ½É­Ì¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì((€€€€€€€€€½¹ÍĞÍ¡•‘Õ±•Ìè]½É­M¡•‘Õ±•mt€ômtì(€€€€€€€€€™½È€¡½¹ÍĞm¥¹‘•à°Í¡•‘Õ±•t½˜‰½‘ä¹Í¡•‘Õ±•Ì¹•¹ÑÉ¥•Ì ¤¤ì(€€€€€€€€€€€½¹ÍĞmÍ¡•‘Õ±•I½İt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼İ½É­}Í¡•‘Õ±•Ì€ (€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥°Í¡•‘Õ±•}½‘”°Ñ¥Ñ±”°Á½Í¥Ñ¥½¸(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íİ½É¬¹¥‘ô°€‘íÍ¡•‘Õ±”¹Í¡•‘Õ±•½‘•ô°(€€€€€€€€€€€€€€€€‘íÍ¡•‘Õ±”¹Ñ¥Ñ±•ô°€‘í¥¹‘•à€¬€Åô(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€€€€€ì(€€€€€€€€€€€¥˜€ …Í¡•‘Õ±•I½Ü¤Ñ¡É½Ü¹•ÜÉÉ½È İ½É­}Í¡•‘Õ±•Ì¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì((€€€€€€€€€€€½¹ÍĞ¥Ñ•µÌ€ômtì(€€€€€€€€€€€™½È€¡½¹ÍĞ¥Ñ•´½˜Í¡•‘Õ±”¹¥Ñ•µÌ¤ì(€€€€€€€€€€€€€½¹ÍĞ•Ù¥‘•¹”€ôÍ½ÕÉ•Ù¥‘•¹•½È¡Á…å±½…°¥Ñ•´¤ì(€€€€€€€€€€€€€½¹ÍĞm¥Ñ•µI½İt€ô…İ…¥ĞÑàñì¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼İ½É­}¥Ñ•µÌ€ (€€€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥°Í¡•‘Õ±•}¥°¥Ñ•µ}¹Õµ‰•È°(€€€€€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸°Õ¹¥Ñ}½‘”°…İ…É‘•‘}ÅÕ…¹Ñ¥Ñä°•™™•Ñ¥Ù•}É…Ñ”°(€€€€€€€€€€€€€€€€€Á…åµ•¹Ñ}…Ñ•½Éä°Í½ÕÉ•}•Ù¥‘•¹”(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íİ½É¬¹¥‘ô°€‘íÍ¡•‘Õ±•I½Ü¹¥‘ô°(€€€€€€€€€€€€€€€€€€‘í¥Ñ•´¹¥Ñ•µ9Õµ‰•Éô°€‘í¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¹ô°€‘í¥Ñ•´¹Õ¹¥Ñ½‘•ô°(€€€€€€€€€€€€€€€€€€‘í¥Ñ•´¹…İ…É‘•‘EÕ…¹Ñ¥Ñåô°€‘í¥Ñ•´¹•™™•Ñ¥Ù•I…Ñ•ô°(€€€€€€€€€€€€€€€€€€‘í¥Ñ•´¹Á…åµ•¹Ñ…Ñ•½Éä€üü¹Õ±±ô°€‘í©Í½¹ˆ¡Ñà°•Ù¥‘•¹”¥ô(€€€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€€€É•ÑÕÉ¹¥¹œ¥(€€€€€€€€€€€€€€ì(€€€€€€€€€€€€€¥˜€ …¥Ñ•µI½Ü¤Ñ¡É½Ü¹•ÜÉÉ½È İ½É­}¥Ñ•µÌ¥¹Í•ÉĞÉ•ÑÕÉ¹•¹¼É½Üœ¤ì(€€€€€€€€€€€€€¥Ñ•µÌ¹ÁÕÍ ¡ì(€€€€€€€€€€€€€€€¥è¥Ñ•µI½Ü¹¥°(€€€€€€€€€€€€€€€Í¡•‘Õ±•%èÍ¡•‘Õ±•I½Ü¹¥°(€€€€€€€€€€€€€€€¥Ñ•µ9Õµ‰•Èè¥Ñ•´¹¥Ñ•µ9Õµ‰•È°(€€€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€€€€€Õ¹¥Ñ½‘”è¥Ñ•´¹Õ¹¥Ñ½‘”°(€€€€€€€€€€€€€€€…İ…É‘•‘EÕ…¹Ñ¥Ñäè¥Ñ•´¹…İ…É‘•‘EÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€€€•™™•Ñ¥Ù•I…Ñ”è¥Ñ•´¹•™™•Ñ¥Ù•I…Ñ”°(€€€€€€€€€€€€€€€€¼¼M•É¥…°ÑÉ…•…‰¥±¥Ñä¥ÌÍİ¥Ñ¡•½¸Á•È¥Ñ•´…™Ñ•È(€€€€€€€€€€€€€€€€¼¼½¹™¥Éµ…Ñ¥½¸°½¹”Ñ¡”½¹ÑÉ…Ñ½È­¹½İÌİ¡¥ ¥Ñ•µÌ(€€€€€€€€€€€€€€€€¼¼Í¡¥ÀÍ•É¥…±¥Í••ÅÕ¥Áµ•¹Ğ¸(€€€€€€€€€€€€€€€É•ÅÕ¥É•ÍM•É¥…±Ìè™…±Í”°(€€€€€€€€€€€€€€€€¼¼5¥±•ÍÑ½¹”€àèÉ•Ù¥•İ•ÈµÍ•Ğ…Ğ½¹™¥Éµ…Ñ¥½¸€¡Ñ¡”Á…ÉÍ•È(€€€€€€€€€€€€€€€€¼¼¹•Ù•ÈÁÉ½Á½Í•Ì¥Ğ¤ì•‘¥Ñ…‰±”±…Ñ•ÈÙ¥„Ñ¡”Á…åµ•¹Ğ(€€€€€€€€€€€€€€€€¼¼…Ñ•½ÉäÉ½ÕÑ”¸(€€€€€€€€€€€€€€€Á…åµ•¹Ñ…Ñ•½Éäè¥Ñ•´¹Á…åµ•¹Ñ…Ñ•½Éä€üü¹Õ±°°(€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€ô(€€€€€€€€€€€Í¡•‘Õ±•Ì¹ÁÕÍ ¡ì(€€€€€€€€€€€€€¥èÍ¡•‘Õ±•I½Ü¹¥°(€€€€€€€€€€€€€Í¡•‘Õ±•½‘”èÍ¡•‘Õ±”¹Í¡•‘Õ±•½‘”°(€€€€€€€€€€€€€Ñ¥Ñ±”èÍ¡•‘Õ±”¹Ñ¥Ñ±”°(€€€€€€€€€€€€€Á½Í¥Ñ¥½¸è¥¹‘•à€¬€Ä°(€€€€€€€€€€€€€¥Ñ•µÌ°(€€€€€€€€€€€ô¤ì(€€€€€€€€€ô((€€€€€€€€€™½È€¡½¹ÍĞµ…ÑÉ¥áI½Ü½˜‰½‘ä¹Á…åµ•¹Ñ5…ÑÉ¥à€üümt¤ì(€€€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼Á…åµ•¹Ñ}µ…ÑÉ¥•Ì€ (€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥°…Ñ•½Éä°ÁÑ}ÍÕÁÁ±ä°(€€€€€€€€€€€€€€€ÁÑ}¥¹ÍÑ…±±…Ñ¥½¸°ÁÑ}Á…Œ°ÁÑ}™¥¹…±}‰¥±°°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íİ½É¬¹¥‘ô°€‘íµ…ÑÉ¥áI½Ü¹…Ñ•½Éåô°(€€€€€€€€€€€€€€€€‘íµ…ÑÉ¥áI½Ü¹ÁÑMÕÁÁ±åô°€‘íµ…ÑÉ¥áI½Ü¹ÁÑ%¹ÍÑ…±±…Ñ¥½¹ô°(€€€€€€€€€€€€€€€€‘íµ…ÑÉ¥áI½Ü¹ÁÑA…ô°€‘íµ…ÑÉ¥áI½Ü¹ÁÑ¥¹…±	¥±±ô°€‘íÕÍ•È¹¥‘ô(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€ì(€€€€€€€€€ô((€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€ÕÁ‘…Ñ”±½…}‘½Õµ•¹ÑÌ(€€€€€€€€€€€Í•Ğ½¹™¥Éµ•‘}İ½É­}¥€ô€‘íİ½É¬¹¥‘ô°(€€€€€€€€€€€€€€€•áÑÉ…Ñ¥½¹}ÍÑ…ÑÕÌ€ô…Í”(€€€€€€€€€€€€€€€€€İ¡•¸¥€ô€‘í‘½Õµ•¹Ñ%‘ôÑ¡•¸€½¹™¥Éµ•œ(€€€€€€€€€€€€€€€€€•±Í”•áÑÉ…Ñ¥½¹}ÍÑ…ÑÕÌ(€€€€€€€€€€€€€€€•¹(€€€€€€€€€€€İ¡•É”¥€ô€‘í‘½Õµ•¹Ñ%‘ô½ÈÁ…É•¹Ñ}±½…}‘½Õµ•¹Ñ}¥€ô€‘í‘½Õµ•¹Ñ%‘ô(€€€€€€€€€€ì((€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼…Õ‘¥Ñ}•Ù•¹ÑÌ€ (€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°…Ñ½É}ÕÍ•É}¥°…Ñ¥½¸°•¹Ñ¥Ñå}ÑåÁ”°•¹Ñ¥Ñå}¥°‘•Ñ…¥±Ì(€€€€€€€€€€€€¤(€€€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íÕÍ•È¹¥‘ô°€İ½É¬¹É•…Ñ•œ°€İ½É­Ìœ°€‘íİ½É¬¹¥‘ô°(€€€€€€€€€€€€€€‘í©Í½¹ˆ¡Ñà°ì(€€€€€€€€€€€€€€€±½…½Õµ•¹Ñ%è‘½Õµ•¹Ñ%°(€€€€€€€€€€€€€€€İ½É­½‘”è‰½‘ä¹İ½É­½‘”°(€€€€€€€€€€€€€€€Í¡•‘Õ±•½Õ¹Ğè‰½‘ä¹Í¡•‘Õ±•Ì¹±•¹Ñ °(€€€€€€€€€€€€€€€¥Ñ•µ½Õ¹Ğè‰½‘ä¹Í¡•‘Õ±•Ì¹É•‘Õ” (€€€€€€€€€€€€€€€€€€¡Ñ½Ñ…°°Í¡•‘Õ±”¤€ôøÑ½Ñ…°€¬Í¡•‘Õ±”¹¥Ñ•µÌ¹±•¹Ñ °(€€€€€€€€€€€€€€€€€€À°(€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€µ…¹Õ…±%Ñ•µ½Õ¹Ğè‰½‘ä¹Í¡•‘Õ±•Ì¹É•‘Õ” (€€€€€€€€€€€€€€€€€€¡Ñ½Ñ…°°Í¡•‘Õ±”¤€ôø(€€€€€€€€€€€€€€€€€€€Ñ½Ñ…°€¬(€€€€€€€€€€€€€€€€€€€Í¡•‘Õ±”¹¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹µ…¹Õ…±¹ÑÉä€ôôôÑÉÕ”¤¹±•¹Ñ °(€€€€€€€€€€€€€€€€€€À°(€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€…Ñ•½É¥Í•‘%Ñ•µ½Õ¹Ğè‰½‘ä¹Í¡•‘Õ±•Ì¹É•‘Õ” (€€€€€€€€€€€€€€€€€€¡Ñ½Ñ…°°Í¡•‘Õ±”¤€ôø(€€€€€€€€€€€€€€€€€€€Ñ½Ñ…°€¬(€€€€€€€€€€€€€€€€€€€Í¡•‘Õ±”¹¥Ñ•µÌ¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹Á…åµ•¹Ñ…Ñ•½Éä€„ôôÕ¹‘•™¥¹•¤(€€€€€€€€€€€€€€€€€€€€€€¹±•¹Ñ °(€€€€€€€€€€€€€€€€€€À°(€€€€€€€€€€€€€€€€¤°(€€€€€€€€€€€€€€€Á…åµ•¹Ñ5…ÑÉ¥áI½İÌè‰½‘ä¹Á…åµ•¹Ñ5…ÑÉ¥àü¹±•¹Ñ €üü€À°(€€€€€€€€€€€€€€€Á‰I•ÅÕ¥É•µ•¹Ğè(€€€€€€€€€€€€€€€€€Á‰œ€ôôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€€€ü¹Õ±°(€€€€€€€€€€€€€€€€€€€€èì(€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•‘µ½Õ¹ĞèÁ‰œ¹É•ÅÕ¥É•‘µ½Õ¹Ğ°(€€€€€€€€€€€€€€€€€€€€€€€ÍÕ‰µ¥ÍÍ¥½¹…åÌèÁ‰œ¹ÍÕ‰µ¥ÍÍ¥½¹…åÌ°(€€€€€€€€€€€€€€€€€€€€€€€•áÑ•¹Í¥½¹…åÌèÁ‰œ¹•áÑ•¹Í¥½¹…åÌ€üü¹Õ±°°(€€€€€€€€€€€€€€€€€€€€€€€Á•¹…±%¹Ñ•É•ÍÑA•É•¹ĞèÁ‰œ¹Á•¹…±%¹Ñ•É•ÍÑA•É•¹Ğ€üü¹Õ±°°(€€€€€€€€€€€€€€€€€€€€€€€ÁÉ½Ù•¹…¹”èÁ‰M½ÕÉ”ü¹ÁÉ½Ù•¹…¹”€üü¹Õ±°°(€€€€€€€€€€€€€€€€€€€€€ô°(€€€€€€€€€€€€€ô¥ô(€€€€€€€€€€€€¤(€€€€€€€€€€ì((€€€€€€€€€€¼¼¸€…ÍÍ¥¹•œµÍ½Á•½¹™¥Éµ•ÈµÕÍĞ‰”…‰±”Ñ¼Í•”Ñ¡”]½É¬(€€€€€€€€€€¼¼Ñ¡•ä©ÕÍĞÉ•…Ñ•èÉ…¹ĞÑ¡•¥È…ÍÍ¥¹µ•¹Ğ¥¸Ñ¡¥ÌÍ…µ”(€€€€€€€€€€¼¼ÑÉ…¹Í…Ñ¥½¸°µ¥ÉÉ½É¥¹œÑ¡”½İ¹•Èµµ…¹…•…ÍÍ¥¹µ•¹ĞİÉ¥Ñ•Ì(€€€€€€€€€€¼¼€¡¥‘•¹Ñ¥Ñä¹ÑÌ¤¥¸½±Õµ¸Í•Ğ…¹…Õ‘¥ĞÍ¡…Á”¸=İ¹•ÉÌ…¹(€€€€€€€€€€¼¼€…±°œµÍ½Á”µ•µ‰•ÉÌÍ•”•Ù•Éä]½É¬…¹¹••¹¼É½Ü¸(€€€€€€€€€½¹ÍĞµ•µ‰•ÉÍ¡¥À€ô…İ…¥Ğµ•µ‰•ÉÍ¡¥Á=˜¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€¥˜€¡µ•µ‰•ÉÍ¡¥Àü¹İ½É­}Í½Á”€ôôô€…ÍÍ¥¹•œ¤ì(€€€€€€€€€€€½¹ÍĞÁÉ•Ù¥½ÕÍÍÍ¥¹µ•¹ÑÌ€ô…İ…¥ĞÑàñìİ½É­}¥èÍÑÉ¥¹œõmtù€(€€€€€€€€€€€€€Í•±•Ğİ½É­}¥™É½´İ½É­}…ÍÍ¥¹µ•¹ÑÌ(€€€€€€€€€€€€€İ¡•É”ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô(€€€€€€€€€€€€€½É‘•È‰äÉ•…Ñ•‘}…Ğ(€€€€€€€€€€€€ì(€€€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼İ½É­}…ÍÍ¥¹µ•¹ÑÌ€ (€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°İ½É­}¥°ÕÍ•É}¥°É•…Ñ•‘}‰å}ÕÍ•É}¥(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€Ù…±Õ•Ì€ ‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íİ½É¬¹¥‘ô°€‘íÕÍ•È¹¥‘ô°€‘íÕÍ•È¹¥‘ô¤(€€€€€€€€€€€€ì(€€€€€€€€€€€½¹ÍĞÁÉ•Ù¥½ÕÍ]½É­%‘Ì€ôÁÉ•Ù¥½ÕÍÍÍ¥¹µ•¹ÑÌ¹µ…À ¡É½Ü¤€ôøÉ½Ü¹İ½É­}¥¤ì(€€€€€€€€€€€€¼¼ÍÍ¥¹µ•¹ÑÌ…É”„Í•Ğì‰½Ñ Í¥‘•ÌÍ½ÉĞÍ¼Ñ¡”ÑÉ…¥°µ…Ñ¡•Ì(€€€€€€€€€€€€¼¼Ñ¡”½İ¹•Èµµ…¹…•É•Á±…”µÍ•Ğ…Õ‘¥ÑÌ•á…Ñ±ä¸(€€€€€€€€€€€½¹ÍĞ…ÍÍ¥¹µ•¹Ñ¡…¹•Ì€ô…Õ‘¥Ñ¥™˜ (€€€€€€€€€€€€€ìİ½É­%‘Ìèl¸¸¹ÁÉ•Ù¥½ÕÍ]½É­%‘Ít¹Í½ÉĞ ¤ô°(€€€€€€€€€€€€€ìİ½É­%‘Ìèl¸¸¹ÁÉ•Ù¥½ÕÍ]½É­%‘Ì°İ½É¬¹¥‘t¹Í½ÉĞ ¤ô°(€€€€€€€€€€€€¤ì(€€€€€€€€€€€…İ…¥ĞÑá€(€€€€€€€€€€€€€¥¹Í•ÉĞ¥¹Ñ¼…Õ‘¥Ñ}•Ù•¹ÑÌ€ (€€€€€€€€€€€€€€€½É…¹¥Í…Ñ¥½¹}¥°…Ñ½É}ÕÍ•É}¥°…Ñ¥½¸°•¹Ñ¥Ñå}ÑåÁ”°‘•Ñ…¥±Ì(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€€Ù…±Õ•Ì€ (€€€€€€€€€€€€€€€€‘í½É…¹¥Í…Ñ¥½¹%‘ô°€‘íÕÍ•È¹¥‘ô°€µ•µ‰•ÉÍ¡¥À¹…ÍÍ¥¹µ•¹ÑÍ}Í•Ğœ°(€€€€€€€€€€€€€€€€İ½É­}…ÍÍ¥¹µ•¹ÑÌœ°(€€€€€€€€€€€€€€€€‘í©Í½¹ˆ¡Ñà°ì(€€€€€€€€€€€€€€€€€µ•µ‰•ÉUÍ•É%èÕÍ•È¹¥°(€€€€€€€€€€€€€€€€€‰•™½É”è…ÍÍ¥¹µ•¹Ñ¡…¹•Ì¹‰•™½É”°(€€€€€€€€€€€€€€€€€…™Ñ•Èè…ÍÍ¥¹µ•¹Ñ¡…¹•Ì¹…™Ñ•È°(€€€€€€€€€€€€€€€ô¥ô(€€€€€€€€€€€€€€¤(€€€€€€€€€€€€ì(€€€€€€€€€ô((€€€€€€€€€É•ÑÕÉ¸ìİ½É¬èÑ½]½É¬¡İ½É¬¤°Í¡•‘Õ±•Ìôì(€€€€€€€ô°(€€€€€€¤¹…Ñ  ¡•ÉÉ½ÈèÕ¹­¹½İ¸¤€ôøì(€€€€€€€¥˜€¡•ÉÉ½È¥¹ÍÑ…¹•½˜ÉÉ½È€˜˜€½‘”œ¥¸•ÉÉ½È€˜˜•ÉÉ½È¹½‘”€ôôô€œÈÌÔÀÔœ¤ì(€€€€€€€€€Ñ¡É½Ü¡ÑÑÁÉÉ½È (€€€€€€€€€€€€ĞÀä°(€€€€€€€€€€€€UA1%Q}9QIdœ°(€€€€€€€€€€€€Í¡•‘Õ±”½‘”°Á½Í¥Ñ¥½¸°½È¥Ñ•´¹Õµ‰•ÈÉ•Á•…ÑÌİ¥Ñ¡¥¸Ñ¡¥Ì]½É¬¸œ°(€€€€€€€€€€¤ì(€€€€€€€ô(€€€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€€€ô¤ì(€€€€€É•ÑÕÉ¸É•Á±ä¹ÍÑ…ÑÕÌ ÈÀÄ¤¹Í•¹¡É•ÍÕ±Ğ¤ì(€€€ô°(€€¤ì((€…ÁÀ¹•Ğ (€€€€œ½…Á¤½İ½É­Ìœ°(€€€ì(€€€€€Í¡•µ„èìÉ•ÍÁ½¹Í”èì€ÈÀÀè]½É­1¥ÍÑI•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìôô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞÉ½İÌ€ô…İ…¥Ğİ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ (€€€€€€€‘…Ñ…‰…Í”°(€€€€€€€½É…¹¥Í…Ñ¥½¹%°(€€€€€€€ÕÍ•È¹¥°(€€€€€€€…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€€€€¼¼€…ÍÍ¥¹•œµÍ½Á•µ•µ‰•ÉÍ¡¥ÁÌ±¥ÍĞ½¹±äÑ¡•¥È]½É­Ì¸(€€€€€€€€€½¹ÍĞ™Õ±°€ô…İ…¥Ğ¡…ÍÕ±±]½É­M½Á”¡Ñà°ÕÍ•È¹¥¤ì(€€€€€€€€€É•ÑÕÉ¸Ñàñ]½É­I½İmtù€(€€€€€€€€€€€Í•±•Ğ¥°İ½É­}½‘”°±•ÑÑ•É}¹Õµ‰•È°±•ÑÑ•É}‘…Ñ”èéÑ•áĞ…Ì±•ÑÑ•É}‘…Ñ”°(€€€€€€€€€€€€€€€€€€Ñ¥Ñ±”°…‘Ù•ÉÑ¥Í•‘}Ù…±Õ”°½¹ÑÉ…Ñ}Ù…±Õ”°ÁÉ¥¥¹}Í¡…Á”°(€€€€€€€€€€€€€€€€€€±•ÑÑ•É}Á•É•¹Ñ…”°±•ÑÑ•É}Á•É•¹Ñ…•}‘¥É•Ñ¥½¸°(€€€€€€€€€€€€€€€€€€Á‰}É•ÅÕ¥É•‘}…µ½Õ¹ĞèéÑ•áĞ…ÌÁ‰}É•ÅÕ¥É•‘}…µ½Õ¹Ğ°(€€€€€€€€€€€€€€€€€€Á‰}ÍÕ‰µ¥ÍÍ¥½¹}‘…åÌ°Á‰}•áÑ•¹Í¥½¹}‘…åÌ°(€€€€€€€€€€€€€€€€€€Á‰}Á•¹…±}¥¹Ñ•É•ÍÑ}Á•É•¹ĞèéÑ•áĞ…ÌÁ‰}Á•¹…±}¥¹Ñ•É•ÍÑ}Á•É•¹Ğ°(€€€€€€€€€€€€€€€€€€ÍÑ…ÑÕÌ°½µÁ±•Ñ•‘}…Ğ°½µÁ±•Ñ•‘}‰å}ÕÍ•É}¥°½µÁ±•Ñ¥½¹}¹½Ñ”°(€€€€€€€€€€€€€€€€€€É•…Ñ•‘}…Ğ(€€€€€€€€€€€™É½´İ½É­ÌÜ(€€€€€€€€€€€İ¡•É”‘•±•Ñ•‘}…Ğ¥Ì¹Õ±°(€€€€€€€€€€€€€…¹€ ‘í™Õ±±ô½È•á¥ÍÑÌ€ (€€€€€€€€€€€€€€€Í•±•Ğ€Ä™É½´İ½É­}…ÍÍ¥¹µ•¹ÑÌİ„(€€€€€€€€€€€€€€€İ¡•É”İ„¹İ½É­}¥€ôÜ¹¥…¹İ„¹ÕÍ•É}¥€ô€‘íÕÍ•È¹¥‘ô(€€€€€€€€€€€€€€¤¤(€€€€€€€€€€€½É‘•È‰äÉ•…Ñ•‘}…Ğ‘•ÍŒ°¥(€€€€€€€€€€ì(€€€€€€€ô°(€€€€€€¤ì(€€€€€É•ÑÕÉ¸ìİ½É­ÌèÉ½İÌ¹µ…À¡Ñ½]½É¬¤ôì(€€€ô°(€€¤ì((€…ÁÀ¹•Ğ (€€€€œ½…Á¤½İ½É­Ì¼é¥œ°(€€€ì(€€€€€Í¡•µ„èì(€€€€€€€Á…É…µÌè½Õµ•¹ÑA…É…µÍM¡•µ„°(€€€€€€€É•ÍÁ½¹Í”èì€ÈÀÀè]½É­•Ñ…¥±I•ÍÁ½¹Í•M¡•µ„°€¸¸¹•ÉÉ½ÉI•ÍÁ½¹Í•Ìô°(€€€€€ô°(€€€ô°(€€€…Íå¹Œ€¡É•ÅÕ•ÍĞ¤€ôøì(€€€€€½¹ÍĞÕÍ•È€ô…İ…¥ĞÉ•ÅÕ¥É•UÍ•È¡…ÕÑ °É•ÅÕ•ÍĞ¤ì(€€€€€½¹ÍĞ½É…¹¥Í…Ñ¥½¹%€ôÉ•ÅÕ¥É•=É…¹¥Í…Ñ¥½¹!•…‘•È (€€€€€€€É•ÅÕ•ÍĞ¹¡•…‘•ÉÍlàµ½É…¹¥Í…Ñ¥½¸µ¥t°(€€€€€€¤ì(€€€€€½¹ÍĞì¥ô€ôÉ•ÅÕ•ÍĞ¹Á…É…µÌ…Ìì¥èÍÑÉ¥¹œôì(€€€€€É•ÑÕÉ¸İ¥Ñ¡	½Õ¹‘Q•¹…¹Ğ¡‘…Ñ…‰…Í”°½É…¹¥Í…Ñ¥½¹%°ÕÍ•È¹¥°…Íå¹Œ€¡Ñà¤€ôøì(€€€€€€€…İ…¥Ğ…ÍÍ•ÉÑ]½É­•ÍÌ¡Ñà°ÕÍ•È¹¥°¥¤ì(€€€€€€€½¹ÍĞmİ½É­t€ô…İ…¥ĞÑàğ¡]½É­I½Ü€˜ì…±±½İ}•á•ÍÍ}‘•±¥Ù•Éäè‰½½±•…¸ô¥mtù€(€€€€€€€€€Í•±•Ğ¥°İ½É­}½‘”°±•ÑÑ•É}¹Õµ‰•È°±•ÑÑ•É}‘…Ñ”èéÑ•áĞ…Ì±•ÑÑ•É}‘…Ñ”°(€€€€€€€€€€€€€€€€Ñ¥Ñ±”°…‘Ù•ÉÑ¥Í•‘}Ù…±Õ”°½¹ÑÉ…Ñ}Ù…±Õ”°ÁÉ¥¥¹}Í¡…Á”°(€€€€€€€€€€€€€€€€±•ÑÑ•É}Á•É•¹Ñ…”°±•ÑÑ•É}Á•É•¹Ñ…•}‘¥É•Ñ¥½¸°(€€€€€€€€€€€€€€€€Á‰}É•ÅÕ¥É•‘}…µ½Õ¹ĞèéÑ•áĞ…ÌÁ‰}É•ÅÕ¥É•‘}…µ½Õ¹Ğ°(€€€€€€€€€€€€€€€€Á‰}ÍÕ‰µ¥ÍÍ¥½¹}‘…åÌ°Á‰}•áÑ•¹Í¥½¹}‘…åÌ°(€€€€€€€€€€€€€€€€Á‰}Á•¹…±}¥¹Ñ•É•ÍÑ}Á•É•¹ĞèéÑ•áĞ…ÌÁ‰}Á•¹…±}¥¹Ñ•É•ÍÑ}Á•É•¹Ğ°(€€€€€€€€€€€€€€€€ÍÑ…ÑÕÌ°½µÁ±•Ñ•‘}…Ğ°½µÁ±•Ñ•‘}‰å}ÕÍ•É}¥°½µÁ±•Ñ¥½¹}¹½Ñ”°(€€€€€€€€€€€€€€€€É•…Ñ•‘}…Ğ°…±±½İ}•á•ÍÍ}‘•±¥Ù•Éä(€€€€€€€€€™É½´İ½É­Ì(€€€€€€€€€İ¡•É”¥€ô€‘í¥‘ô…¹‘•±•Ñ•‘}…Ğ¥Ì¹Õ±°(€€€€€€€€ì(€€€€€€€¥˜€ …İ½É¬¤Ñ¡É½Ü¡ÑÑÁÉÉ½È ĞÀĞ°€]=I-}9=Q}=U9œ°€9¼ÍÕ ]½É¬¸œ¤ì((€€€€€€€½¹ÍĞÍ¡•‘Õ±•I½İÌ€ô…İ…¥ĞÑàğ(€€€€€€€€€ì¥èÍÑÉ¥¹œìÍ¡•‘Õ±•}½‘”èÍÑÉ¥¹œìÑ¥Ñ±”èÍÑÉ¥¹œìÁ½Í¥Ñ¥½¸è¹Õµ‰•Èõmt(€€€€€€€€ù€(€€€€€€€€€Í•±•Ğ¥°Í¡•‘Õ±•}½‘”°Ñ¥Ñ±”°Á½Í¥Ñ¥½¸(€€€€€€€€€™É½´İ½É­}Í¡•‘Õ±•Ì(€€€€€€€€€İ¡•É”İ½É­}¥€ô€‘í¥‘ô(€€€€€€€€€½É‘•È‰äÁ½Í¥Ñ¥½¸(€€€€€€€€ì(€€€€€€€½¹ÍĞ¥Ñ•µI½İÌ€ô…İ…¥ĞÑàğ(€€€€€€€€€ì(€€€€€€€€€€€¥èÍÑÉ¥¹œì(€€€€€€€€€€€Í¡•‘Õ±•}¥èÍÑÉ¥¹œì(€€€€€€€€€€€¥Ñ•µ}¹Õµ‰•ÈèÍÑÉ¥¹œì(€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸èÍÑÉ¥¹œì(€€€€€€€€€€€Õ¹¥Ñ}½‘”èÍÑÉ¥¹œì(€€€€€€€€€€€…İ…É‘•‘}ÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œì(€€€€€€€€€€€•™™•Ñ¥Ù•}É…Ñ”èÍÑÉ¥¹œì(€€€€€€€€€€€•™™•Ñ¥Ù•}ÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œğ¹Õ±°ì(€€€€€€€€€€€•™™•Ñ¥Ù•}Õ¹¥Ñ}É…Ñ”èÍÑÉ¥¹œğ¹Õ±°ì(€€€€€€€€€€€•™™•Ñ¥Ù•}‘•ÍÉ¥ÁÑ¥½¸èÍÑÉ¥¹œğ¹Õ±°ì(€€€€€€€€€€€•™™•Ñ¥Ù•}Õ¹¥ĞèÍÑÉ¥¹œğ¹Õ±°ì(€€€€€€€€€€€…µ•¹‘µ•¹Ñ}…‘‘•è‰½½±•…¸ì(€€€€€€€€€€€É•ÅÕ¥É•Í}Í•É¥…±Ìè‰½½±•…¸ì(€€€€€€€€€€€Á…åµ•¹Ñ}…Ñ•½Éäè(€€€€€€€€€€€€€ğ€MUAA1dœ(€€€€€€€€€€€€€ğ€MUAA1e}9}%9MQ11Q%=8œ(€€€€€€€€€€€€€ğ€AUI}%9MQ11Q%=8œ(€€€€€€€€€€€€€ğ€MAI}MUAA1dœ(€€€€€€€€€€€€€ğ¹Õ±°ì(€€€€€€€€€€€¥¹ÍÑ…±±•‘}ÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œì(€€€€€€€€€€€Á…}•ÉÑ¥™¥•‘}ÅÕ…¹Ñ¥ÑäèÍÑÉ¥¹œì(€€€€€€€€€õmt(€€€€€€€€ù€(€€€€€€€€€Í•±•Ğ¥°Í¡•‘Õ±•}¥°¥Ñ•µ}¹Õµ‰•È°‘•ÍÉ¥ÁÑ¥½¸°Õ¹¥Ñ}½‘”°(€€€€€€€€€€€€€€€€…İ…É‘•‘}ÅÕ…¹Ñ¥Ñä°•™™•Ñ¥Ù•}É…Ñ”°(€€€€€€€€€€€€€€€€•™™•Ñ¥Ù•}ÅÕ…¹Ñ¥ÑäèéÑ•áĞ…Ì•™™•Ñ¥Ù•}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€€€€•™™•Ñ¥Ù•}Õ¹¥Ñ}É…Ñ”èéÑ•áĞ…Ì•™™•Ñ¥Ù•}Õ¹¥Ñ}É…Ñ”°(€€€€€€€€€€€€€€€€•™™•Ñ¥Ù•}‘•ÍÉ¥ÁÑ¥½¸°•™™•Ñ¥Ù•}Õ¹¥Ğ°…µ•¹‘µ•¹Ñ}…‘‘•°(€€€€€€€€€€€€€€€€É•ÅÕ¥É•Í}Í•É¥…±Ì°Á…åµ•¹Ñ}…Ñ•½Éä°(€€€€€€€€€€€€€€€€€´´5¥±•ÍÑ½¹”€ÜèÑ¡”…ÕÑ¡½É¥Ñ…Ñ¥Ù”¥¹ÍÑ…±±•ÅÕ…¹Ñ¥ÑäƒŠP(€€€€€€€€€€€€€€€€€´´MU4½Ù•È¹½¸µ…¹•±±•¥¹ÍÑ…±±…Ñ¥½¸É•½É‘Ì¸(€€€€€€€€€€€€€€€€½…±•Í”  (€€€€€€€€€€€€€€€€€€Í•±•ĞÍÕ´¡¤¹ÅÕ…¹Ñ¥Ñä¤™É½´¥¹ÍÑ…±±…Ñ¥½¹Ì¤(€€€€€€€€€€€€€€€€€€İ¡•É”¤¹İ½É­}¥Ñ•µ}¥€ôİ½É­}¥Ñ•µÌ¹¥…¹¤¹ÍÑ…ÑÕÌ€ô€É•½É‘•œ(€€€€€€€€€€€€€€€€€¤°€À¤èéÑ•áĞ…Ì¥¹ÍÑ…±±•‘}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€€€€€´´5¥±•ÍÑ½¹”€àÁ¡…Í”€ÄèQ!Á…}ÅÑäÑ¡”5•…ÍÕÉ•µ•¹Ğ	½½¬(€€€€€€€€€€€€€€€€€´´•¹¥¹”½¹ÍÕµ•ÌƒŠPMU4½˜•ÉÑ¥™¥•ÅÕ…¹Ñ¥Ñ¥•Ì½Ù•È(€€€€€€€€€€€€€€€€€´´¹½¸µ…¹•±±•A•ÉÑ¥™¥…Ñ•Ì€¡±•…äƒ
œà¤¸(€€€€€€€€€€€€€€€€½…±•Í”  (€€€€€€€€€€€€€€€€€€Í•±•ĞÍÕ´¡Á¤¹•ÉÑ¥™¥•‘}ÅÕ…¹Ñ¥Ñä¤(€€€€€€€€€€€€€€€€€€™É½´Á…}•ÉÑ¥™¥…Ñ•}¥Ñ•µÌÁ¤(€€€€€€€€€€€€€€€€€€©½¥¸Á…}•ÉÑ¥™¥…Ñ•ÌÁŒ½¸ÁŒ¹¥€ôÁ¤¹Á…}•ÉÑ¥™¥…Ñ•}¥(€€€€€€€€€€€€€€€€€€İ¡•É”Á¤¹İ½É­}¥Ñ•µ}¥€ôİ½É­}¥Ñ•µÌ¹¥(€€€€€€€€€€€€€€€€€€€€…¹ÁŒ¹ÍÑ…ÑÕÌ€ô€É•½É‘•œ(€€€€€€€€€€€€€€€€€¤°€À¤èé¹Õµ•É¥Œ Äà°Ì¤èéÑ•áĞ…ÌÁ…}•ÉÑ¥™¥•‘}ÅÕ…¹Ñ¥Ñä(€€€€€€€€€™É½´İ½É­}¥Ñ•µÌ(€€€€€€€€€İ¡•É”İ½É­}¥€ô€‘í¥‘ô…¹‘•±•Ñ•‘}…Ğ¥Ì¹Õ±°(€€€€€€€€€½É‘•È‰ä¥Ñ•µ}¹Õµ‰•È(€€€€€€€€ì((€€€€€€€½¹ÍĞÍ¡•‘Õ±•Ìè]½É­M¡•‘Õ±•mt€ôÍ¡•‘Õ±•I½İÌ¹µ…À ¡Í¡•‘Õ±”¤€ôø€¡ì(€€€€€€€€€¥èÍ¡•‘Õ±”¹¥°(€€€€€€€€€Í¡•‘Õ±•½‘”èÍ¡•‘Õ±”¹Í¡•‘Õ±•}½‘”°(€€€€€€€€€Ñ¥Ñ±”èÍ¡•‘Õ±”¹Ñ¥Ñ±”°(€€€€€€€€€Á½Í¥Ñ¥½¸èÍ¡•‘Õ±”¹Á½Í¥Ñ¥½¸°(€€€€€€€€€¥Ñ•µÌè¥Ñ•µI½İÌ(€€€€€€€€€€€€¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹Í¡•‘Õ±•}¥€ôôôÍ¡•‘Õ±”¹¥¤(€€€€€€€€€€€€¹µ…À ¡¥Ñ•´¤€ôø€¡ì(€€€€€€€€€€€€€¥è¥Ñ•´¹¥°(€€€€€€€€€€€€€Í¡•‘Õ±•%è¥Ñ•´¹Í¡•‘Õ±•}¥°(€€€€€€€€€€€€€¥Ñ•µ9Õµ‰•Èè¥Ñ•´¹¥Ñ•µ}¹Õµ‰•È°(€€€€€€€€€€€€€‘•ÍÉ¥ÁÑ¥½¸è¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€€€Õ¹¥Ñ½‘”è¥Ñ•´¹Õ¹¥Ñ}½‘”°(€€€€€€€€€€€€€…İ…É‘•‘EÕ…¹Ñ¥Ñäè¥Ñ•´¹…İ…É‘•‘}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€•™™•Ñ¥Ù•I…Ñ”è…¹½¹¥…±I…Ñ•Q•áĞ¡¥Ñ•´¹•™™•Ñ¥Ù•}É…Ñ”¤°(€€€€€€€€€€€€€€¼¼µ•¹‘µ•¹Ğ½Ù•É±…åÌ€¡5¥±•ÍÑ½¹”€Ø¤è¹Õ±°€ô½É¥¥¹…°…ÁÁ±¥•Ì¸(€€€€€€€€€€€€€•™™•Ñ¥Ù•EÕ…¹Ñ¥Ñäè¥Ñ•´¹•™™•Ñ¥Ù•}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€•™™•Ñ¥Ù•U¹¥ÑI…Ñ”è(€€€€€€€€€€€€€€€¥Ñ•´¹•™™•Ñ¥Ù•}Õ¹¥Ñ}É…Ñ”€ôôô¹Õ±°(€€€€€€€€€€€€€€€€€€ü¹Õ±°(€€€€€€€€€€€€€€€€€€è…¹½¹¥…±I…Ñ•Q•áĞ¡¥Ñ•´¹•™™•Ñ¥Ù•}Õ¹¥Ñ}É…Ñ”¤°(€€€€€€€€€€€€€•™™•Ñ¥Ù••ÍÉ¥ÁÑ¥½¸è¥Ñ•´¹•™™•Ñ¥Ù•}‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€€€€€€€•™™•Ñ¥Ù•U¹¥Ğè¥Ñ•´¹•™™•Ñ¥Ù•}Õ¹¥Ğ°(€€€€€€€€€€€€€…µ•¹‘µ•¹Ñ‘‘•è¥Ñ•´¹…µ•¹‘µ•¹Ñ}…‘‘•°(€€€€€€€€€€€€€É•ÅÕ¥É•ÍM•É¥…±Ìè¥Ñ•´¹É•ÅÕ¥É•Í}Í•É¥…±Ì°(€€€€€€€€€€€€€¥¹ÍÑ…±±•‘EÕ…¹Ñ¥Ñäè¥Ñ•´¹¥¹ÍÑ…±±•‘}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€€€€¼¼5¥±•ÍÑ½¹”€àè¹Õ±°€ôÕ¹…Ñ•½É¥Í•€¡É•Í½±Ù•ÌÑ¡É½Õ Ñ¡”(€€€€€€€€€€€€€€¼¼]½É¬ÌU9Q=I%Mµ…ÑÉ¥àÉ½Ü¤¸(€€€€€€€€€€€€€Á…åµ•¹Ñ…Ñ•½Éäè¥Ñ•´¹Á…åµ•¹Ñ}…Ñ•½Éä°(€€€€€€€€€€€€€Á…•ÉÑ¥™¥•‘EÕ…¹Ñ¥Ñäè¥Ñ•´¹Á…}•ÉÑ¥™¥•‘}ÅÕ…¹Ñ¥Ñä°(€€€€€€€€€€€ô¤¤°(€€€€€€€ô¤¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€İ½É¬èì€¸¸¹Ñ½]½É¬¡İ½É¬¤°…±±½İá•ÍÍ•±¥Ù•Éäèİ½É¬¹…±±½İ}•á•ÍÍ}‘•±¥Ù•Éäô°(€€€€€€€€€Í¡•‘Õ±•Ì°(€€€€€€€ôì(€€€€€ô¤ì(€€€ô°(€€¤ì)ô