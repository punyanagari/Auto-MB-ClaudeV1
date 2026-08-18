import { createHash, randomUUID } from 'node:crypto';
import {
  isExtractionError,
  AddTenderChecklistItemRequestSchema,
  AttachTenderChecklistDocumentRequestSchema,
  ConfirmTenderRequestSchema,
  LinkTenderAwardLetterRequestSchema,
  TenderDetailSchema,
  TenderListResponseSchema,
  TenderNoticeSchema,
  TenderNoticeUploadQuerySchema,
  UpdateTenderStatusRequestSchema,
  type TenderChecklistItem,
  type TenderChecklistValidity,
  type TenderDetail,
  type TenderNotice,
  type TenderNoticeExtractionError,
  type TenderNoticeProposal,
  type TenderStatus,
  type TenderStatusEvent,
  type TenderSummary,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { extractPdfText, PdfToTextConfigurationError } from '@auto-mb/documents';
import type { ObjectStorage } from '@auto-mb/documents';
import { reviewTenderNotice, type TenderNoticeReview } from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import {
  isWriterRole,
  membershipOf,
  RESTRICTED_CREDENTIAL_CATEGORY,
} from '../authz.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import {
  audit,
  errorResponses,
  EXPIRY_WARNING_DAYS,
  IdParamsSchema,
  optionalTrimmed,
  requireTrimmed,
  upstreamErrorResponses,
} from './shared.js';

/**
 * The tender pipeline (migration 0083) — the pre-award half of the
 * ledger.
 *
 * Four things distinguish it from every other module here, and each is a
 * decision rather than an omission:
 *
 *   1. **No Work.** A tender belongs to no Work, because the Work is what
 *      winning it produces. There is therefore no `assertWorkAccess` and
 *      no work-scope predicate — RLS on `organisation_id` is the whole of
 *      the isolation, exactly as it is for the company document library
 *      this module reads from.
 *   2. **Propose, then confirm.** The NIT upload writes a
 *      `tender_notices` row holding what the machine read and nothing
 *      authoritative (`AGENTS.md` rule 10). The `tenders` row is written
 *      only by `POST /api/tender-notices/:id/confirm`, from the values a
 *      human sent back — not from the payload. The reading is
 *      synchronous, unlike the LOA's: six labelled fields off a short
 *      notice is one `pdftotext` run, and making it a job would buy
 *      nothing but a poll on the intake screen.
 *   3. **iREPS is tracked, never driven.** The portal has no public API;
 *      it is operated by a human with a CAPTCHA, an OTP and a local DSC.
 *      Everything in the status trail is that human saying what they did.
 *      The copy on the screen says so, and there is no code here that
 *      could grow into a filing client.
 *   4. **Award conversion is a deep link, not a second door.** An awarded
 *      tender points the operator at the ordinary LOA intake and records
 *      which letter came back (`POST /api/tenders/:id/award-letter`). The
 *      Work is created by the LOA confirm route it always was, and is
 *      read here through `loa_documents.confirmed_work_id`.
 *
 * Writes are `role: 'writer'` (owner or office) and deliberately NOT a
 * new membership authority. The three that exist — issue, cancel,
 * statutory — are authorities over documents this organisation puts its
 * name to. Assembling a bid package is ordinary office work on ordinary
 * organisation data, and `routes/company-documents.ts` settled the same
 * question the same way one migration earlier.
 *
 * ponytail: no deadline reminder. The register colours a closing date and
 * the Dashboard does not know about tenders yet. Wave D owns scheduled
 * notification; wire `GET /api/tenders` into it there rather than growing
 * a job here.
 */

/** The storage area segment for this module. `assertSafeObjectKey`
 * accepts `[a-z]+` only, which is why it is one word. */
const STORAGE_AREA = 'nit';

const ChecklistItemParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
    itemId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

/* --- reading ------------------------------------------------------------ */

interface TenderRow {
  id: string;
  tender_number: string;
  authority: string;
  title: string;
  bid_closes_at_local: string;
  bid_closes_at: Date;
  days_to_close: number;
  status: TenderStatus;
  estimated_value: string | null;
  emd_amount: string | null;
  eligibility_summary: string | null;
  ireps_reference: string | null;
  notice_id: string | null;
  notice_filename: string | null;
  award_loa_document_id: string | null;
  award_loa_filename: string | null;
  award_work_id: string | null;
  award_work_code: string | null;
}

interface ChecklistRow {
  id: string;
  tender_id: string;
  title: string;
  mandatory: boolean;
  company_document_id: string | null;
  company_document_title: string | null;
  restricted: boolean;
  company_document_archived: boolean;
  company_document_version_number: number | null;
  expires_on: string | null;
  validity: TenderChecklistValidity | null;
  expires_in_days_at_close: number | null;
  blocking: boolean;
  created_at: Date;
}

/**
 * Every tender of the bound organisation, or one of them.
 *
 * The closing moment is rendered back through `organisations.timezone`
 * rather than handed to the client as an instant. The column stores an
 * instant because a tender closes at a moment; the screen and the edit
 * field both want the wall clock the notice printed, and deriving it in
 * SQL means a browser in another timezone cannot make a deadline look
 * like a different day.
 *
 * `days_to_close` is likewise the database's arithmetic on the
 * database's clock, so two people in one organisation never disagree
 * about how long is left.
 */
async function readTenders(
  tx: TransactionSql,
  tenderId: string | null,
): Promise<TenderRow[]> {
  return tx<TenderRow[]>`
    select
      t.id,
      t.tender_number,
      t.authority,
      t.title,
      to_char(t.bid_closes_at at time zone o.timezone, 'YYYY-MM-DD"T"HH24:MI')
        as bid_closes_at_local,
      t.bid_closes_at,
      (
        (t.bid_closes_at at time zone o.timezone)::date
        - (now() at time zone o.timezone)::date
      )::int as days_to_close,
      t.status,
      t.estimated_value::text as estimated_value,
      t.emd_amount::text as emd_amount,
      t.eligibility_summary,
      t.ireps_reference,
      n.id as notice_id,
      n.original_filename as notice_filename,
      t.award_loa_document_id,
      l.original_filename as award_loa_filename,
      l.confirmed_work_id as award_work_id,
      w.work_code as award_work_code
    from tenders t
    join organisations o on o.id = t.organisation_id
    left join tender_notices n on n.confirmed_tender_id = t.id
    left join loa_documents l on l.id = t.award_loa_document_id
    left join works w on w.id = l.confirmed_work_id
    where ${tenderId === null ? tx`true` : tx`t.id = ${tenderId}`}
    -- The register's order and the index in 0083: soonest deadline first.
    order by t.bid_closes_at, t.id
  `;
}

/**
 * The checklist, with each attached credential read AGAINST THIS
 * TENDER'S closing date.
 *
 * This is the join the module exists for. The company document library
 * (migration 0079) answers "is this certificate valid TODAY"; a bid needs
 * "will it be valid on the day this tender is opened", and the two give
 * different answers precisely when it matters — a certificate lapsing in
 * three weeks is green in the library and useless for a bid closing in
 * four.
 *
 * Derived on read, never stored, for the reason 0079 gives: an answer to
 * a question about a date is wrong the morning after it is written.
 */
async function readChecklist(
  tx: TransactionSql,
  tenderId: string | null,
  options: { readonly includeRestricted: boolean },
): Promise<ChecklistRow[]> {
  // The same rule `routes/company-documents.ts` applies to the library
  // read, from the same constant, because this read reaches the same
  // rows. A financial credential's NAME is what is withheld — the line,
  // its validity and its blocking state stay, so no count moves with the
  // reader's role. Applied in SQL rather than by blanking the result,
  // for the reason the library gives: one code path, and no unfiltered
  // row escaping through a branch somebody adds later.
  const identity = options.includeRestricted
    ? tx`false`
    : tx`cd.category = ${RESTRICTED_CREDENTIAL_CATEGORY}`;
  return tx<ChecklistRow[]>`
    with line as (
      select
        ci.id,
        ci.tender_id,
        ci.title,
        ci.mandatory,
        ci.company_document_id,
        ci.created_at,
        ${identity} as restricted,
        cd.title as company_document_title,
        cd.archived_at as company_document_archived_at,
        v.version_number as company_document_version_number,
        v.expires_on,
        (t.bid_closes_at at time zone o.timezone)::date as closes_on
      from tender_checklist_items ci
      join tenders t on t.id = ci.tender_id
      join organisations o on o.id = t.organisation_id
      left join company_documents cd on cd.id = ci.company_document_id
      -- The version a bid would attach: the credential's latest. An older
      -- version having lapsed is not news.
      --
      -- A LATERAL limit-1 per attached line rather than a DISTINCT ON
      -- over the whole table. The CTE read every version of every
      -- credential in the organisation and threw away all but the newest
      -- of each — work proportional to the LIBRARY's history for a
      -- question about the handful of credentials this checklist
      -- attaches. The lateral descends the
      -- (organisation, document, version_number) unique index once per
      -- line, and answers nothing for a line with no credential at all.
      left join lateral (
        select version_number, expires_on
        from company_document_versions cdv
        where cdv.company_document_id = ci.company_document_id
        order by cdv.version_number desc
        limit 1
      ) v on true
      where ${tenderId === null ? tx`true` : tx`ci.tender_id = ${tenderId}`}
    )
    select
      id,
      tender_id,
      title,
      mandatory,
      restricted,
      -- Everything that NAMES the credential is withheld from a caller
      -- the category rule excludes. What survives is the fact that a
      -- credential is attached and how it reads, which is what the
      -- checklist is for.
      case when restricted then null else company_document_id end
        as company_document_id,
      case when restricted then null else company_document_title end
        as company_document_title,
      case when restricted then null else company_document_version_number end
        as company_document_version_number,
      case when restricted then null else expires_on::text end as expires_on,
      (company_document_archived_at is not null) as company_document_archived,
      case
        when company_document_id is null then null
        -- A credential with no version behind it has no file to attach.
        -- Unreachable today (a credential and its first version are
        -- written in one transaction and versions cannot be deleted), and
        -- asserted rather than assumed, because the alternative reading
        -- of a null expiry below is "never expires".
        when company_document_version_number is null then 'expired'
        when expires_on is null then 'none'
        -- A certificate that lapses BEFORE the closing day is not valid
        -- on it. One that lapses ON it still is: "valid until" includes
        -- the day it names.
        when expires_on < closes_on then 'expired'
        when expires_on <= closes_on + ${EXPIRY_WARNING_DAYS}::int then 'expiring'
        else 'valid'
      end as validity,
      case
        when restricted then null
        else (expires_on - closes_on)::int
      end as expires_in_days_at_close,
      (
        mandatory
        and (
          company_document_id is null
          -- Attaching an archived credential is refused, but archiving
          -- one that is ALREADY attached is not — the library has no idea
          -- which bids point at it. A credential the organisation has
          -- retired is not one it can put in a bid, whatever its expiry
          -- says, so it blocks here without being called "expired".
          or company_document_archived_at is not null
          or company_document_version_number is null
          or (expires_on is not null and expires_on < closes_on)
        )
      ) as blocking,
      created_at
    from line
    order by created_at, id
  `;
}

interface StatusEventRow {
  id: string;
  tender_id: string;
  from_status: TenderStatus | null;
  to_status: TenderStatus;
  note: string | null;
  actor_user_id: string;
  occurred_at: Date;
}

function toChecklistItem(row: ChecklistRow): TenderChecklistItem {
  return {
    id: row.id,
    title: row.title,
    mandatory: row.mandatory,
    companyDocumentId: row.company_document_id,
    companyDocumentTitle: row.company_document_title,
    restricted: row.restricted,
    companyDocumentArchived: row.company_document_archived,
    companyDocumentVersionNumber:
      row.company_document_version_number === null
        ? null
        : Number(row.company_document_version_number),
    expiresOn: row.expires_on,
    validity: row.validity,
    expiresInDaysAtClose:
      row.expires_in_days_at_close === null
        ? null
        : Number(row.expires_in_days_at_close),
    blocking: row.blocking,
    createdAt: row.created_at.toISOString(),
  };
}

function toStatusEvent(row: StatusEventRow): TenderStatusEvent {
  return {
    id: row.id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at.toISOString(),
  };
}

interface ChecklistCounts {
  readonly total: number;
  readonly blocking: number;
}

/**
 * The per-tender counts, tallied in ONE pass over the checklist.
 *
 * `toSummary` used to filter the whole array per tender, which is
 * `tenders x lines` on a register that reads both across the whole
 * organisation — quadratic in the thing the screen exists to grow.
 *
 * Deliberately tallied here rather than as a `group by` beside the
 * register query: the blocking rule is four clauses about archival,
 * versions and dates, and a second SQL copy of it is a second thing to
 * keep in step with the first. One reader defines what blocking means;
 * this counts what it decided.
 */
function countChecklists(
  checklist: readonly ChecklistRow[],
): ReadonlyMap<string, ChecklistCounts> {
  const counts = new Map<string, { total: number; blocking: number }>();
  for (const line of checklist) {
    const tally = counts.get(line.tender_id) ?? { total: 0, blocking: 0 };
    tally.total += 1;
    if (line.blocking) tally.blocking += 1;
    counts.set(line.tender_id, tally);
  }
  return counts;
}

const NO_LINES: ChecklistCounts = { total: 0, blocking: 0 };

function toSummary(row: TenderRow, counts: ChecklistCounts): TenderSummary {
  return {
    id: row.id,
    tenderNumber: row.tender_number,
    authority: row.authority,
    title: row.title,
    bidClosesAtLocal: row.bid_closes_at_local,
    bidClosesAt: row.bid_closes_at.toISOString(),
    daysToClose: Number(row.days_to_close),
    status: row.status,
    checklistTotal: counts.total,
    checklistBlocking: counts.blocking,
  };
}

async function readTenderList(
  tx: TransactionSql,
  includeRestricted: boolean,
): Promise<TenderSummary[]> {
  const [tenders, checklist] = await Promise.all([
    readTenders(tx, null),
    readChecklist(tx, null, { includeRestricted }),
  ]);
  const counts = countChecklists(checklist);
  return tenders.map((row) => toSummary(row, counts.get(row.id) ?? NO_LINES));
}

async function readTenderDetail(
  tx: TransactionSql,
  tenderId: string,
  includeRestricted: boolean,
): Promise<TenderDetail> {
  const [rows, checklist, events] = await Promise.all([
    readTenders(tx, tenderId),
    readChecklist(tx, tenderId, { includeRestricted }),
    tx<StatusEventRow[]>`
      select id, tender_id, from_status, to_status, note, actor_user_id, occurred_at
      from tender_status_events
      where tender_id = ${tenderId}
      order by occurred_at, id
    `,
  ]);
  const row = rows[0];
  if (row === undefined) throw tenderNotFound();
  return {
    ...toSummary(row, countChecklists(checklist).get(row.id) ?? NO_LINES),
    estimatedValue: row.estimated_value,
    emdAmount: row.emd_amount,
    eligibilitySummary: row.eligibility_summary,
    irepsReference: row.ireps_reference,
    noticeId: row.notice_id,
    noticeFilename: row.notice_filename,
    award:
      row.award_loa_document_id === null
        ? null
        : {
            loaDocumentId: row.award_loa_document_id,
            loaFilename: row.award_loa_filename ?? '',
            workId: row.award_work_id,
            workCode: row.award_work_code,
          },
    checklist: checklist.map(toChecklistItem),
    statusEvents: events.map(toStatusEvent),
  };
}

/* --- the notice --------------------------------------------------------- */

interface NoticeRow {
  id: string;
  original_filename: string;
  sha256: string;
  size_bytes: string;
  extraction_status: 'review' | 'failed';
  extraction_payload: unknown;
  confirmed_tender_id: string | null;
  created_at: Date;
}

/** The stored payload, read defensively: it is jsonb, so the type system
 * has no hold on it and a row written by an older shape must degrade to
 * "no proposal" rather than to a 500. */
/** One extracted field, as `@auto-mb/loa-parser` shapes it. Checked
 * rather than asserted, because it arrives from jsonb. */
function isField(value: unknown): value is TenderNoticeReview['tenderNumber'] {
  if (typeof value !== 'object' || value === null) return false;
  const field = value as Record<string, unknown>;
  return (
    (typeof field['value'] === 'string' || field['value'] === null) &&
    (typeof field['raw'] === 'string' || field['raw'] === null) &&
    typeof field['needsReview'] === 'boolean'
  );
}

const PROPOSAL_FIELDS = [
  'tenderNumber',
  'authority',
  'title',
  'bidClosesAtLocal',
  'estimatedValue',
  'emdAmount',
  'eligibility',
] as const;

/** Every field present and field-shaped, and the summary the screen
 * counts from actually there. */
function isReview(value: unknown): value is TenderNoticeReview {
  if (typeof value !== 'object' || value === null) return false;
  const review = value as Record<string, unknown>;
  if (!PROPOSAL_FIELDS.every((name) => isField(review[name]))) return false;
  const needsReview = review['needsReview'];
  if (typeof needsReview !== 'object' || needsReview === null) return false;
  const summary = needsReview as Record<string, unknown>;
  return (
    typeof summary['total'] === 'number' &&
    typeof summary['identityUnresolved'] === 'boolean'
  );
}

function proposalOf(payload: unknown): {
  proposal: TenderNoticeProposal | null;
  error: TenderNoticeExtractionError | null;
} {
  if (typeof payload !== 'object' || payload === null) {
    return { proposal: null, error: null };
  }
  const record = payload as { review?: unknown; error?: unknown };
  if (typeof record.error === 'string') {
    return {
      proposal: null,
      // A stored string that is not one of the two the writer below can
      // produce is a row from a shape this code no longer knows. It reads
      // as the generic failure rather than being handed to a client
      // verbatim.
      error: isExtractionError(record.error) ? record.error : 'extraction_failed',
    };
  }
  // Validated, not cast. The docstring above promises a row written by an
  // older shape degrades to "no proposal" rather than to a 500, and a
  // bare `as` promises nothing: `review.needsReview.total` on a payload
  // missing `needsReview` throws inside the response serialiser, which is
  // a 500 on a GET that should have answered "nothing to review".
  if (!isReview(record.review)) return { proposal: null, error: null };
  const review = record.review;
  return {
    proposal: {
      tenderNumber: review.tenderNumber,
      authority: review.authority,
      title: review.title,
      bidClosesAtLocal: review.bidClosesAtLocal,
      estimatedValue: review.estimatedValue,
      emdAmount: review.emdAmount,
      eligibility: review.eligibility,
      needsReviewTotal: review.needsReview.total,
      identityUnresolved: review.needsReview.identityUnresolved,
    },
    error: null,
  };
}

function toNotice(row: NoticeRow): TenderNotice {
  const { proposal, error } = proposalOf(row.extraction_payload);
  return {
    id: row.id,
    originalFilename: row.original_filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    extractionStatus: row.extraction_status,
    proposal,
    extractionError: error,
    confirmedTenderId: row.confirmed_tender_id,
    createdAt: row.created_at.toISOString(),
  };
}

async function readNotice(tx: TransactionSql, noticeId: string): Promise<NoticeRow> {
  const [row] = await tx<NoticeRow[]>`
    select id, original_filename, sha256, size_bytes, extraction_status,
           extraction_payload, confirmed_tender_id, created_at
    from tender_notices
    where id = ${noticeId}
  `;
  if (!row) {
    throw httpError(404, 'TENDER_NOTICE_NOT_FOUND', 'No such tender notice.');
  }
  return row;
}

/* --- refusals ----------------------------------------------------------- */

function tenderNotFound(): Error {
  return httpError(404, 'TENDER_NOT_FOUND', 'No such tender.');
}

/** PostgreSQL's unique-violation SQLSTATE. The partial and case-folded
 * unique indexes in 0083 are the arbiters under concurrency, not a
 * read-then-write check two writers can both pass. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}

/** The transition trigger in 0083 raises `check_violation` for an illegal
 * move, which is the same SQLSTATE a CHECK constraint raises. Mapping it
 * to a named 409 keeps the refusal a sentence rather than a 500. */
function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23514';
}

function statusConflict(message: string): Error {
  return httpError(409, 'TENDER_STATUS_CONFLICT', message);
}

async function loadTender(
  tx: TransactionSql,
  tenderId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<{ id: string; status: TenderStatus; tender_number: string }> {
  // Two statements rather than an interpolated FOR UPDATE: the lock is a
  // structural choice of the caller, and this keeps the SQL built by the
  // tagged template alone.
  type Row = { id: string; status: TenderStatus; tender_number: string };
  const [row] = options.forUpdate
    ? await tx<Row[]>`
        select id, status, tender_number from tenders where id = ${tenderId} for update
      `
    : await tx<Row[]>`
        select id, status, tender_number from tenders where id = ${tenderId}
      `;
  if (!row) throw tenderNotFound();
  return row;
}

export function registerTenderRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- NIT intake: propose ---------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tender-notices',
      role: 'writer',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        querystring: TenderNoticeUploadQuerySchema,
        response: { 201: TenderNoticeSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const filename = requireTrimmed(
        request.query.filename,
        'The tender notice needs a filename.',
      );
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the tender notice',
      });

      // Authorisation BEFORE the expensive work. The declared `role`
      // guard runs first inside every bound transaction the handler
      // opens, so opening an otherwise empty one here is what stops an
      // unauthorised caller spending a malware scan and a pdftotext run.
      // The same ordering `routes/company-documents.ts` and
      // `routes/loa.ts` use, minus their extra pre-checks: a notice has
      // no name to collide with and duplicates are legitimate (a
      // corrigendum re-issues the same notice).
      await tenant(() => Promise.resolve());
      await assertNotMalware(scanner, bytes);

      let sourceText: string | null = null;
      let failure: TenderNoticeExtractionError | null = null;
      try {
        sourceText = await extractPdfText(bytes);
      } catch (error) {
        // A misconfigured extraction binary is an operator fault, not a
        // fault in the uploaded document: reporting it as "upload a
        // searchable PDF" sends the user chasing the wrong problem. Same
        // split `routes/contract-sources.ts` makes.
        if (error instanceof PdfToTextConfigurationError) {
          throw httpError(
            503,
            'PDF_TEXT_EXTRACTION_UNAVAILABLE',
            'PDF text extraction is not correctly configured on the server. No document was rejected; contact your administrator.',
            { reason: error.message },
          );
        }
        // The thrown message is a `pdftotext` diagnostic: it can carry the
        // temporary file path, the argument vector, and whatever the
        // binary wrote to stderr about the document. None of that is the
        // operator's business, all of it is stored forever in a jsonb
        // column, and the organisation export hands the column back. So
        // the ROW gets a stable enum the screen can render and the log
        // gets the detail, which is the split rule 11 already asks for
        // on request bodies.
        failure = 'pdf_unreadable';
        request.log.warn(
          { err: error, noticeFilename: filename },
          'tender notice text extraction failed',
        );
      }

      // Unlike the LOA, a notice that could not be read is STORED rather
      // than refused. The PDF is the tender document either way, the
      // operator can still open it, and typing seven fields by hand off a
      // scan is the ordinary case for a photocopied notice — refusing the
      // upload would leave them with nowhere to put it.
      const noticeId = randomUUID();
      const objectKey = `${organisationId}/${STORAGE_AREA}/${noticeId}.pdf`;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // OUTSIDE the transaction, exactly as routes/loa.ts and
      // routes/company-documents.ts do it: a failure after this point
      // leaves an inert orphan object, where the opposite ordering would
      // leave a row promising bytes that are not there.
      await storage.put(objectKey, bytes);

      const review = sourceText === null ? null : reviewTenderNotice(sourceText);

      const stored = await tenant(async (tx) => {
        const [row] = await tx<NoticeRow[]>`
          insert into tender_notices (
            id, organisation_id, object_key, original_filename, sha256,
            media_type, size_bytes, extraction_status, extraction_payload,
            uploaded_by_user_id
          )
          values (
            ${noticeId}, ${organisationId}, ${objectKey}, ${filename}, ${sha256},
            'application/pdf', ${bytes.length},
            ${review === null ? 'failed' : 'review'},
            ${
              review === null
                ? tx.json({ error: failure ?? 'extraction_failed' })
                : tx.json({ sourceText, review } as never)
            },
            ${user.id}
          )
          returning id, original_filename, sha256, size_bytes, extraction_status,
                    extraction_payload, confirmed_tender_id, created_at
        `;
        if (!row) throw new Error('tender notice insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'tender_notice.uploaded',
          'tender_notices',
          noticeId,
          {
            filename,
            sha256,
            sizeBytes: bytes.length,
            extractionStatus: row.extraction_status,
            needsReview: review?.needsReview.total ?? null,
          },
        );
        return row;
      });
      return reply.status(201).send(toNotice(stored));
    },
  );

  /* Reading one notice back. No screen calls this today — the intake
     holds the proposal in memory from the upload response — and it is
     kept rather than deleted because the notice id is the durable half of
     the intake: a row exists, `GET /api/tender-notices/:id/file` below
     serves its bytes to anyone holding that id, and a surface that hands
     out the file but refuses the metadata beside it is the asymmetry, not
     the route. It is also what the census tests exercise the reader
     through. The unused client method WAS deleted. */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/tender-notices/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: TenderNoticeSchema, ...errorResponses },
      },
    },
    async ({ request, tenant }) =>
      tenant(async (tx) => toNotice(await readNotice(tx, request.params.id))),
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tender-notices/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, tenant }) => {
      const notice = await tenant(async (tx) => {
        const [row] = await tx<{ object_key: string; original_filename: string }[]>`
          select object_key, original_filename from tender_notices
          where id = ${request.params.id}
        `;
        if (!row) {
          throw httpError(404, 'TENDER_NOTICE_NOT_FOUND', 'No such tender notice.');
        }
        return row;
      });
      const bytes = await storage.get(notice.object_key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(notice.original_filename)}`,
      );
      return reply.send(bytes);
    },
  );

  /* --- NIT intake: confirm ---------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tender-notices/:id/confirm',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: ConfirmTenderRequestSchema,
        response: { 201: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: noticeId } = request.params;
      const body = request.body;
      const facts = trimmedTenderFacts(body);

      const created = await tenant(async (tx) => {
        // Locked, because two reviewers confirming the same notice must
        // not produce two tenders. The one-way column and its unique
        // constraint in 0083 are the second layer.
        const [notice] = await tx<
          {
            id: string;
            extraction_status: string;
            confirmed_tender_id: string | null;
          }[]
        >`
          select id, extraction_status, confirmed_tender_id
          from tender_notices where id = ${noticeId} for update
        `;
        if (!notice) {
          throw httpError(404, 'TENDER_NOTICE_NOT_FOUND', 'No such tender notice.');
        }
        if (notice.confirmed_tender_id !== null) {
          throw httpError(
            409,
            'TENDER_NOTICE_ALREADY_CONFIRMED',
            'That notice has already been confirmed into a tender. Open the tender instead.',
            { tenderId: notice.confirmed_tender_id },
          );
        }

        const tenderId = await insertTender(tx, {
          organisationId,
          userId: user.id,
          ...facts,
        });
        await tx`
          update tender_notices
          set confirmed_tender_id = ${tenderId}
          where id = ${noticeId}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tender.confirmed',
          'tenders',
          tenderId,
          { noticeId, tenderNumber: facts.tenderNumber },
        );
        return readTenderDetail(tx, tenderId, true);
      });
      return reply.status(201).send(created);
    },
  );

  /* --- the register ----------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tenders',
      schema: { response: { 200: TenderListResponseSchema, ...errorResponses } },
    },
    async ({ user, tenant }) =>
      tenant(async (tx) => ({
        tenders: await readTenderList(
          tx,
          isWriterRole(await membershipOf(tx, user.id)),
        ),
      })),
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tenders/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) =>
      tenant(async (tx) =>
        readTenderDetail(
          tx,
          request.params.id,
          isWriterRole(await membershipOf(tx, user.id)),
        ),
      ),
  );

  /* --- correcting the facts ---------------------------------------------- */

  tenantRoute(
    {
      method: 'PATCH',
      url: '/api/tenders/:id',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: ConfirmTenderRequestSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const facts = trimmedTenderFacts(request.body);
      return tenant(async (tx) => {
        const tender = await loadTender(tx, id, { forUpdate: true });
        // Only a draft. A tender that has been submitted carries the
        // facts a bid went out under, and an opened or decided one is
        // history; the 0083 guard says the same thing to a writer that
        // reached the table some other way.
        if (tender.status !== 'drafted') {
          throw statusConflict(
            `This tender is ${tender.status}, so its facts are the ones the bid went out under and no longer change. Record what happened as a step instead.`,
          );
        }

        const [updated] = await tx<{ tender_number: string }[]>`
          update tenders
          set tender_number = ${facts.tenderNumber},
              authority = ${facts.authority},
              title = ${facts.title},
              bid_closes_at = (
                select ${facts.bidClosesAtLocal}::text::timestamp
                  at time zone o.timezone
                from organisations o
                where o.id = ${organisationId}
              ),
              estimated_value = ${facts.estimatedValue}::money_amount,
              emd_amount = ${facts.emdAmount}::money_amount,
              eligibility_summary = ${facts.eligibilitySummary}
          where id = ${id}
          returning tender_number
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'TENDER_EXISTS',
              `A tender numbered "${facts.tenderNumber}" is already recorded. Open it instead of renaming this one onto it.`,
            );
          }
          throw error;
        });
        if (!updated) throw tenderNotFound();

        await audit(tx, organisationId, user.id, 'tender.corrected', 'tenders', id, {
          from: { tenderNumber: tender.tender_number },
          to: {
            tenderNumber: facts.tenderNumber,
            authority: facts.authority,
            title: facts.title,
            bidClosesAtLocal: facts.bidClosesAtLocal,
            estimatedValue: facts.estimatedValue,
            emdAmount: facts.emdAmount,
          },
        });
        return readTenderDetail(tx, id, true);
      });
    },
  );

  /* --- the status trail ------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tenders/:id/status',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: UpdateTenderStatusRequestSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { status } = request.body;
      // Both are free text the operator types and both are CHECK-guarded
      // in 0083 (`btrim(x) = x`, and a length floor on the note). A note
      // of three spaces was a 500.
      const note = optionalTrimmed(request.body.note);
      const irepsReference = optionalTrimmed(request.body.irepsReference);
      return tenant(async (tx) => {
        const tender = await loadTender(tx, id, { forUpdate: true });
        if (tender.status === status) {
          throw statusConflict(`This tender is already ${status}.`);
        }

        // Submission is the one transition this product can refuse
        // honestly. A mandatory line with nothing attached, or attached
        // to a credential that will have lapsed by the closing date, is a
        // package that would be rejected at the other end; saying so here
        // is the entire value of keeping the checklist.
        if (status === 'submitted') {
          const blocking = (
            await readChecklist(tx, id, { includeRestricted: true })
          ).filter((line) => line.blocking).length;
          if (blocking > 0) {
            throw statusConflict(
              `${String(blocking)} mandatory checklist ${blocking === 1 ? 'line is' : 'lines are'} unanswered or attached to a credential that will have expired by the closing date. Attach a valid version, or remove the line, before recording the submission.`,
            );
          }
        }

        await tx`
          update tenders
          set status = ${status},
              ireps_reference = coalesce(${irepsReference ?? null}, ireps_reference)
          where id = ${id}
        `.catch((error: unknown) => {
          if (isCheckViolation(error)) {
            throw statusConflict(
              `A tender cannot move from ${tender.status} to ${status}.`,
            );
          }
          throw error;
        });
        await tx`
          insert into tender_status_events (
            organisation_id, tender_id, from_status, to_status, note, actor_user_id
          )
          values (
            ${organisationId}, ${id}, ${tender.status}, ${status},
            ${note ?? null}, ${user.id}
          )
        `.catch((error: unknown) => {
          // The trail's own CHECKs — the status pair and the note's shape.
          // The transition is already guarded above, so reaching one here
          // means the note is the problem, and it is the only free text
          // in the statement.
          if (isCheckViolation(error)) {
            throw httpError(
              400,
              'FIELD_TOO_LONG',
              'The note on a tender step is at most 1000 characters.',
            );
          }
          throw error;
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'tender.status_changed',
          'tenders',
          id,
          {
            from: tender.status,
            to: status,
            irepsReference: irepsReference ?? null,
          },
        );
        return readTenderDetail(tx, id, true);
      });
    },
  );

  /* --- the bid checklist ------------------------------------------------ */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tenders/:id/checklist',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: AddTenderChecklistItemRequestSchema,
        response: { 201: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const title = requireTrimmed(
        request.body.title,
        'Name the document the tender asks for.',
      );
      const mandatory = request.body.mandatory ?? true;
      const detail = await tenant(async (tx) => {
        // Locked, for the same reason the status route locks: a
        // submission recorded concurrently would otherwise read a
        // checklist this transaction is still changing, and the two
        // would commit a submitted bid with a blocking line on it.
        const tender = await loadTender(tx, id, { forUpdate: true });
        assertChecklistOpen(tender.status);
        await tx`
          insert into tender_checklist_items (
            organisation_id, tender_id, title, mandatory, created_by_user_id
          )
          values (${organisationId}, ${id}, ${title}, ${mandatory}, ${user.id})
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'TENDER_CHECKLIST_ITEM_EXISTS',
              `This checklist already asks for "${title}".`,
            );
          }
          throw error;
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'tender.checklist_item_added',
          'tenders',
          id,
          { title, mandatory },
        );
        return readTenderDetail(tx, id, true);
      });
      return reply.status(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tenders/:id/checklist/:itemId/document',
      role: 'writer',
      schema: {
        params: ChecklistItemParamsSchema,
        body: AttachTenderChecklistDocumentRequestSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id, itemId } = request.params;
      const { companyDocumentId } = request.body;
      return tenant(async (tx) => {
        // Locked, for the same reason the status route locks: a
        // submission recorded concurrently would otherwise read a
        // checklist this transaction is still changing, and the two
        // would commit a submitted bid with a blocking line on it.
        const tender = await loadTender(tx, id, { forUpdate: true });
        assertChecklistOpen(tender.status);
        await assertChecklistItem(tx, id, itemId);

        if (companyDocumentId !== null) {
          // The credential must exist, in THIS organisation (RLS makes
          // that automatic) and still be offered. Attaching an archived
          // credential to a live bid is the mistake worth naming.
          const [credential] = await tx<{ id: string; archived_at: Date | null }[]>`
            select id, archived_at from company_documents where id = ${companyDocumentId}
          `;
          if (!credential) {
            throw httpError(
              404,
              'COMPANY_DOCUMENT_NOT_FOUND',
              'No such company document.',
            );
          }
          if (credential.archived_at !== null) {
            throw httpError(
              409,
              'COMPANY_DOCUMENT_ARCHIVED',
              'That company document is archived, so it cannot be attached to a bid. Add it to the library again first.',
            );
          }
        }

        // The three columns move together or not at all — the 0083 shape
        // CHECK says so — which is why they are set in one statement from
        // one condition rather than assembled in TypeScript.
        await tx`
          update tender_checklist_items
          set company_document_id = ${companyDocumentId},
              attached_at = case
                when ${companyDocumentId}::uuid is null then null else now()
              end,
              attached_by_user_id = case
                when ${companyDocumentId}::uuid is null then null else ${user.id}
              end
          -- Keyed on BOTH ids, not on the line alone. The helper above
          -- proved the pairing, but it proved it in an earlier statement,
          -- and a WHERE that does not repeat the constraint is one
          -- refactor away from writing to a line of another tender in the
          -- same organisation — which RLS permits, because it is the same
          -- tenant.
          where id = ${itemId} and tender_id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          companyDocumentId === null
            ? 'tender.checklist_document_detached'
            : 'tender.checklist_document_attached',
          'tenders',
          id,
          { itemId, companyDocumentId },
        );
        return readTenderDetail(tx, id, true);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/tenders/:id/checklist/:itemId',
      role: 'writer',
      schema: {
        params: ChecklistItemParamsSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id, itemId } = request.params;
      return tenant(async (tx) => {
        // Locked, for the same reason the status route locks: a
        // submission recorded concurrently would otherwise read a
        // checklist this transaction is still changing, and the two
        // would commit a submitted bid with a blocking line on it.
        const tender = await loadTender(tx, id, { forUpdate: true });
        assertChecklistOpen(tender.status);
        const item = await assertChecklistItem(tx, id, itemId);
        await tx`
          delete from tender_checklist_items
          where id = ${itemId} and tender_id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tender.checklist_item_removed',
          'tenders',
          id,
          { itemId, title: item.title },
        );
        return readTenderDetail(tx, id, true);
      });
    },
  );

  /* --- award conversion -------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tenders/:id/award-letter',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: LinkTenderAwardLetterRequestSchema,
        response: { 200: TenderDetailSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { loaDocumentId } = request.body;
      return tenant(async (tx) => {
        const tender = await loadTender(tx, id, { forUpdate: true });
        if (tender.status !== 'awarded') {
          throw httpError(
            409,
            'TENDER_NOT_AWARDED',
            'Record the award first. A Letter of Acceptance only belongs to a tender that was won.',
          );
        }
        const [letter] = await tx<{ id: string }[]>`
          select id from loa_documents
          where id = ${loaDocumentId} and document_kind = 'loa'
        `;
        if (!letter) {
          throw httpError(404, 'DOCUMENT_NOT_FOUND', 'No such LOA document.');
        }
        // Written once. `is not distinct from` admits the SAME letter
        // again — the upload screen retries the link and must not be
        // refused for succeeding twice — and refuses a DIFFERENT one,
        // which would silently move the tender onto another Work through
        // `loa_documents.confirmed_work_id`. The unique index catches the
        // other direction, two tenders claiming one letter.
        const repointed = await tx`
          update tenders set award_loa_document_id = ${loaDocumentId}
          where id = ${id}
            and (
              award_loa_document_id is null
              or award_loa_document_id = ${loaDocumentId}
            )
        `.catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw httpError(
              409,
              'TENDER_ALREADY_AWARDED',
              'That Letter of Acceptance is already recorded against another tender.',
            );
          }
          throw error;
        });
        if (repointed.count === 0) {
          throw httpError(
            409,
            'TENDER_ALREADY_AWARDED',
            'A different Letter of Acceptance is already recorded against this tender. The letter that awarded a tender does not change.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'tender.award_letter_linked',
          'tenders',
          id,
          {
            loaDocumentId,
          },
        );
        return readTenderDetail(tx, id, true);
      });
    },
  );
}

/** The checklist is a list of what to assemble while the bid is being
 * assembled. From submission onwards it is the record of what was
 * submitted, and a record is not edited. */
function assertChecklistOpen(status: TenderStatus): void {
  if (status !== 'drafted') {
    throw httpError(
      409,
      'TENDER_CHECKLIST_LOCKED',
      'This bid has already been submitted, so its checklist is now the record of what went out and can no longer be changed.',
    );
  }
}

async function assertChecklistItem(
  tx: TransactionSql,
  tenderId: string,
  itemId: string,
): Promise<{ title: string }> {
  const [row] = await tx<{ title: string }[]>`
    select title from tender_checklist_items
    where id = ${itemId} and tender_id = ${tenderId}
  `;
  if (!row) {
    throw httpError(
      404,
      'TENDER_CHECKLIST_ITEM_NOT_FOUND',
      'No such line on this tender checklist.',
    );
  }
  return row;
}

interface TenderFacts {
  readonly tenderNumber: string;
  readonly authority: string;
  readonly title: string;
  readonly bidClosesAtLocal: string;
  readonly estimatedValue: string | null;
  readonly emdAmount: string | null;
  readonly eligibilitySummary: string | null;
}

/** The schemas' `minLength: 1` admits a string of spaces, and the 0083
 * CHECKs refuse an untrimmed value, so the trim happens here and an empty
 * result is refused in words rather than as a constraint name. */
function trimmedTenderFacts(body: {
  tenderNumber: string;
  authority: string;
  title: string;
  bidClosesAtLocal: string;
  estimatedValue?: string;
  emdAmount?: string;
  eligibilitySummary?: string;
}): TenderFacts {
  const refusal =
    'A tender needs its number, the inviting authority, and what it is for.';
  const tenderNumber = requireTrimmed(body.tenderNumber, refusal);
  const authority = requireTrimmed(body.authority, refusal);
  const title = requireTrimmed(body.title, refusal);
  // The schema's own floor, re-applied after the trim: '   ab   ' passes
  // `minLength: 3` and is two characters of title.
  if (title.length < 3) throw httpError(400, 'FIELD_TOO_SHORT', refusal);
  return {
    tenderNumber,
    authority,
    title,
    bidClosesAtLocal: body.bidClosesAtLocal,
    estimatedValue: body.estimatedValue ?? null,
    emdAmount: body.emdAmount ?? null,
    eligibilitySummary: optionalTrimmed(body.eligibilitySummary) ?? null,
  };
}

/**
 * Writes the confirmed tender and the first row of its trail.
 *
 * The closing wall clock is bound to the organisation's timezone HERE, in
 * SQL, against the organisation's own row — never in JavaScript against
 * the server process's `TZ`. That is what makes "closes 15:00" mean the
 * same instant regardless of where the server or the reviewer is sitting.
 *
 * The `::text::timestamp` double cast is load-bearing and is not
 * decoration. Written as `$n::timestamp`, PostgreSQL resolves the
 * parameter's type as `timestamp`, postgres.js sees that type and runs
 * the string through `new Date(...).toISOString()` before sending it —
 * and `new Date('2026-09-18T15:00')` is read in the SERVER PROCESS's
 * timezone, so the value that arrives is already shifted by that offset
 * and a 15:00 close silently becomes 09:30. Pinning the parameter to
 * `text` keeps the driver's hands off it and leaves the one conversion
 * that should happen — the organisation's — to the line below.
 */
async function insertTender(
  tx: TransactionSql,
  input: TenderFacts & { readonly organisationId: string; readonly userId: string },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into tenders (
      organisation_id, tender_number, authority, title, bid_closes_at,
      estimated_value, emd_amount, eligibility_summary, created_by_user_id
    )
    select
      ${input.organisationId}, ${input.tenderNumber}, ${input.authority},
      ${input.title},
      (${input.bidClosesAtLocal}::text::timestamp at time zone o.timezone),
      ${input.estimatedValue}::money_amount, ${input.emdAmount}::money_amount,
      ${input.eligibilitySummary}, ${input.userId}
    from organisations o
    where o.id = ${input.organisationId}
    returning id
  `.catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw httpError(
        409,
        'TENDER_EXISTS',
        `A tender numbered "${input.tenderNumber}" is already recorded. Open it instead of creating a second one.`,
      );
    }
    throw error;
  });
  if (!row) throw new Error('tender insert returned no row');
  await tx`
    insert into tender_status_events (
      organisation_id, tender_id, from_status, to_status, note, actor_user_id
    )
    values (
      ${input.organisationId}, ${row.id}, null, 'drafted',
      'Created from the tender notice.', ${input.userId}
    )
  `;
  return row.id;
}
