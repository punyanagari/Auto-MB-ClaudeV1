import {
  CancelCorrespondenceLetterRequestSchema,
  CorrespondenceListQuerySchema,
  CorrespondenceListResponseSchema,
  CorrespondenceThreadOptionsResponseSchema,
  RegisterInwardLetterQuerySchema,
  WriteOutwardLetterRequestSchema,
  type CorrespondenceCounts,
  type CorrespondenceEntry,
  type CorrespondenceStatus,
  type CorrespondenceTab,
  type ErrorCode,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { ObjectStorage } from '@auto-mb/documents';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import {
  renderOutwardLetterHtml,
  type OutwardLetterSnapshot,
} from '../correspondence-html.js';
import { financialYearLabel } from '../financial-year.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import {
  keysetPage,
  sqlLimit,
  workScopedCursorRowId,
  type WorkScope,
} from '../pagination.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
  storePdfUpload,
} from '../upload-guards.js';
import {
  audit,
  errorResponses,
  IdParamsSchema,
  optionalTrimmed,
  requireTrimmed,
  upstreamErrorResponses,
} from './shared.js';

/**
 * The correspondence register (migration 0086).
 *
 * A works contract is executed on paper as much as on site, and until this
 * module the product modelled none of the letters. It models two of them —
 * the outward letter this organisation writes and the inward letter that
 * arrives — and DELIBERATELY models neither of the other two kinds the
 * screen shows.
 *
 * ## The integration decision, stated once
 *
 * The register's four tabs read three tables:
 *
 *   Outward / Inward     `correspondence_letters`, this module's own
 *   Extension requests   `extension_requests` (0011, 0029), read only
 *   Inspection letters   `inspection_calls` (0082), read only
 *
 * `routes/extensions.ts` already numbers an extension-of-time letter,
 * renders its PDF, stores the railway's reply and moves the Work's
 * completion date when the reply lands. `routes/inspections.ts` already
 * holds both halves of an inspection call letter — the outward request as
 * `INS/<work>/<n>` and the agency's inward letter as `agency_call_number`
 * with its scan in `inspection_call_documents`. Writing either of them
 * into a letters table as well would give one letter two homes that can
 * disagree about its number, its date or its state. So this module reads
 * them, projects them into one row shape, and never writes them. The tabs
 * link back to the module that owns each record.
 *
 * ## Work-scope
 *
 * A letter may belong to a Work, and a member scoped to `assigned` must
 * not read the letters of a Work they are not on. Every read below carries
 * the same predicate — the letter's Work is one the caller may see, or the
 * letter belongs to no Work at all. A general letter (an invitation to
 * quote, arriving before there is a Work) is organisation-wide by nature
 * and is visible to every member. The counts obey it too, or the tab
 * labels would leak the size of a register the caller cannot read.
 *
 * ponytail: the composer's "reply to" picker lists the whole visible
 * register. That is the same tens-to-hundreds of rows the register itself
 * renders and it is one round trip; add a search parameter when an
 * organisation's correspondence outgrows a select.
 */

/** The storage area segment. `assertSafeObjectKey` accepts `[a-z]+` only,
 * which is why it is one word. */
const STORAGE_AREA = 'letters';

/** `2026-27` -> `26-27`. The design contract's letter numbers abbreviate
 * the financial year to its two two-digit halves (`OUT/26-27/047` at
 * `fdfe5ef`); the counter and the stored column keep the unambiguous
 * four-digit form so nothing has to guess the century back. */
function shortFinancialYear(fyLabel: string): string {
  return fyLabel.slice(2);
}

function letterNumberOf(
  direction: 'outward' | 'inward',
  fyLabel: string,
  sequence: number,
): string {
  const prefix = direction === 'outward' ? 'OUT' : 'IN';
  return `${prefix}/${shortFinancialYear(fyLabel)}/${String(sequence).padStart(3, '0')}`;
}

interface LetterRow {
  id: string;
  direction: 'outward' | 'inward';
  letter_number: string;
  letter_date: string;
  subject: string;
  counterparty_name: string;
  work_id: string | null;
  work_code: string | null;
  sender_reference: string | null;
  sender_letter_date: string | null;
  response_due_on: string | null;
  reply_to_number: string | null;
  cancelled_at: Date | null;
  answered: boolean;
}

/** The reference slot carries whichever of the two facts the row has: the
 * sender's own number as they printed it (with the date on their paper
 * where they dated it), or the number of the letter this one answers. The
 * design contract renders one line there and a letter never has both — an
 * outward letter has no sender reference and an inward reply that also
 * quotes its own number keeps its own. */
function referenceOf(row: LetterRow): string | null {
  if (row.sender_reference !== null) {
    return row.sender_letter_date !== null
      ? `${row.sender_reference} · ${row.sender_letter_date}`
      : row.sender_reference;
  }
  return row.reply_to_number;
}

function letterStatusOf(row: LetterRow): CorrespondenceStatus {
  if (row.cancelled_at !== null) return 'cancelled';
  if (row.answered) return 'replied';
  return row.direction === 'outward' ? 'sent' : 'received';
}

function toLetterEntry(row: LetterRow): CorrespondenceEntry {
  return {
    id: row.id,
    source: 'letter',
    direction: row.direction,
    number: row.letter_number,
    date: row.letter_date,
    counterparty: row.counterparty_name,
    subject: row.subject,
    workId: row.work_id,
    workCode: row.work_code,
    reference: referenceOf(row),
    status: letterStatusOf(row),
    extensionUntil: null,
    replyDueOn: row.response_due_on,
    // Both directions always have a document: the outward letter renders
    // on demand from frozen columns, and 0086 refuses an inward row
    // without its scan.
    documentAvailable: true,
  };
}

/** The work-scope predicate, in one place so the register, the counts and
 * the cursor cannot drift apart. A letter with no Work is everyone's. */
function visibleLetters(tx: TransactionSql, scope: WorkScope) {
  return tx`(
    ${scope.full}
    or l.work_id is null
    or exists (
      select 1 from work_assignments wa
      where wa.work_id = l.work_id and wa.user_id = ${scope.userId}
    )
  )`;
}

function visibleWorkRows(tx: TransactionSql, scope: WorkScope, column: string) {
  return tx`(
    ${scope.full}
    or exists (
      select 1 from work_assignments wa
      where wa.work_id = ${tx.unsafe(column)} and wa.user_id = ${scope.userId}
    )
  )`;
}

/**
 * {@link cursorRowId} for the letters register, proven against the same
 * predicate its rows are.
 *
 * Neither shared helper fits. `cursorRowId` proves the cursor
 * organisation-wide, which on a work-scoped register leaves the oracle its
 * own docstring describes: 200 for a forbidden row's id and 400 for a
 * nonexistent one discloses existence, and the keyset predicate then
 * compares against that row's date, so a caller paging with chosen cursors
 * can binary-search a letter they may not read down to its date.
 * `workScopedCursorRowId` closes that but refuses a general letter, whose
 * `work_id` is null and which every member may read.
 *
 * So the predicate is `visibleLetters` verbatim, and a cursor that fails
 * it is refused exactly as a nonexistent one is — same status, same code,
 * same sentence.
 */
async function letterCursorRowId(
  tx: TransactionSql,
  scope: WorkScope,
  cursor: string | undefined,
): Promise<string | null> {
  if (cursor === undefined) return null;
  const [row] = await tx<{ id: string }[]>`
    select l.id from correspondence_letters l
    where l.id = ${cursor} and ${visibleLetters(tx, scope)}
  `;
  if (!row) {
    throw httpError(
      400,
      'CURSOR_INVALID',
      'The pagination cursor does not name a row in this register.',
    );
  }
  return row.id;
}

async function readLetters(
  tx: TransactionSql,
  scope: WorkScope,
  direction: 'outward' | 'inward',
  limit: number | undefined,
  cursor: string | null,
): Promise<LetterRow[]> {
  return tx<LetterRow[]>`
    select
      l.id,
      l.direction,
      l.letter_number,
      l.letter_date::text as letter_date,
      l.subject,
      l.counterparty_name,
      l.work_id,
      w.work_code,
      l.sender_reference,
      l.sender_letter_date::text as sender_letter_date,
      l.response_due_on::text as response_due_on,
      parent.letter_number as reply_to_number,
      l.cancelled_at,
      exists (
        select 1 from correspondence_letters reply
        where reply.reply_to_letter_id = l.id and reply.cancelled_at is null
      ) as answered
    from correspondence_letters l
    left join works w on w.id = l.work_id
    left join correspondence_letters parent on parent.id = l.reply_to_letter_id
    where l.direction = ${direction}
      and ${visibleLetters(tx, scope)}
      and (${cursor === null} or
        (l.letter_date, l.id) < (
          select c.letter_date, c.id from correspondence_letters c
          where c.id = ${cursor}))
    order by l.letter_date desc, l.id desc
    limit ${sqlLimit(limit)}
  `;
}

interface ExtensionEntryRow {
  id: string;
  work_id: string;
  work_code: string;
  status: 'draft' | 'finalised' | 'responded';
  response_outcome: 'accepted' | 'modified' | 'rejected' | null;
  request_number: string | null;
  manual_reference: string | null;
  addressee: string;
  letter_date: string | null;
  created_on: string;
  proposed_completion_date: string;
  granted_completion_date: string | null;
  rendered: boolean;
}

/**
 * The extension-of-time letters, as the register shows them.
 *
 * A projection, never a copy. The number, the addressee and the dates are
 * `extension_requests`' own; the subject is this register's word for what
 * every one of these letters is, because the extensions module stores the
 * grounds and no subject line.
 *
 * A draft has no number yet and no letter date, so the register orders by
 * `created_at` — which is also what its cursor is proven against — and
 * falls back to the creation date in the date column. Both are stated
 * here rather than in SQL so the ordering and the display agree.
 */
async function readExtensionEntries(
  tx: TransactionSql,
  scope: WorkScope,
  limit: number | undefined,
  cursor: string | null,
): Promise<ExtensionEntryRow[]> {
  return tx<ExtensionEntryRow[]>`
    select
      e.id,
      e.work_id,
      w.work_code,
      e.status,
      e.response_outcome,
      e.request_number,
      e.manual_reference,
      e.addressee,
      e.letter_date::text as letter_date,
      (e.created_at at time zone o.timezone)::date::text as created_on,
      e.proposed_completion_date::text as proposed_completion_date,
      e.granted_completion_date::text as granted_completion_date,
      (e.rendered_object_key is not null) as rendered
    from extension_requests e
    join works w on w.id = e.work_id
    join organisations o on o.id = e.organisation_id
    where ${visibleWorkRows(tx, scope, 'e.work_id')}
      and (${cursor === null} or
        (e.created_at, e.id) < (
          select c.created_at, c.id from extension_requests c
          where c.id = ${cursor}))
    order by e.created_at desc, e.id desc
    limit ${sqlLimit(limit)}
  `;
}

function extensionStatusOf(row: ExtensionEntryRow): CorrespondenceStatus {
  if (row.status === 'draft') return 'draft';
  if (row.status === 'finalised') return 'sent';
  return row.response_outcome === 'rejected' ? 'rejected' : 'approved';
}

function toExtensionEntry(row: ExtensionEntryRow): CorrespondenceEntry {
  return {
    id: row.id,
    source: 'extension',
    // Always outward: the extensions module records the railway's answer
    // as an outcome on this same row, not as a letter of its own.
    direction: 'outward',
    number: row.request_number ?? 'Not yet numbered',
    date: row.letter_date ?? row.created_on,
    counterparty: row.addressee,
    subject: 'Request for extension of the completion period',
    workId: row.work_id,
    workCode: row.work_code,
    reference: row.manual_reference,
    status: extensionStatusOf(row),
    // The date actually granted once the railway has answered, otherwise
    // the date asked for. A modified grant is the fact that matters.
    extensionUntil: row.granted_completion_date ?? row.proposed_completion_date,
    replyDueOn: null,
    documentAvailable: row.rendered,
  };
}

interface InspectionEntryRow {
  id: string;
  work_id: string;
  work_code: string;
  sequence_number: number;
  agency: string;
  status: 'requested' | 'scheduled' | 'closed' | 'cancelled';
  requested_on: string;
  agency_call_number: string | null;
  call_letter_received_on: string | null;
  call_letter_available: boolean;
}

/**
 * The inspection call letters, as the register shows them.
 *
 * One CALL produces up to two letters — our outward request, and the
 * agency's inward call letter once it arrives — and the register shows
 * both, which is why one row here can become two entries. The design
 * contract draws exactly that pair.
 */
async function readInspectionEntries(
  tx: TransactionSql,
  scope: WorkScope,
  limit: number | undefined,
  cursor: string | null,
): Promise<InspectionEntryRow[]> {
  return tx<InspectionEntryRow[]>`
    select
      ic.id,
      ic.work_id,
      w.work_code,
      ic.sequence_number,
      ic.agency,
      ic.status,
      ic.requested_on::text as requested_on,
      ic.agency_call_number,
      ic.call_letter_received_on::text as call_letter_received_on,
      exists (
        select 1 from inspection_call_documents d
        where d.inspection_call_id = ic.id
          and d.kind = 'call_letter'
          and d.object_key is not null
      ) as call_letter_available
    from inspection_calls ic
    join works w on w.id = ic.work_id
    where ${visibleWorkRows(tx, scope, 'ic.work_id')}
      and (${cursor === null} or
        (ic.created_at, ic.id) < (
          select c.created_at, c.id from inspection_calls c
          where c.id = ${cursor}))
    order by ic.created_at desc, ic.id desc
    limit ${sqlLimit(limit)}
  `;
}

function inspectionEntriesOf(row: InspectionEntryRow): CorrespondenceEntry[] {
  const callReference = `INS/${row.work_code}/${String(row.sequence_number)}`;
  const outward: CorrespondenceEntry = {
    id: row.id,
    source: 'inspection',
    direction: 'outward',
    number: callReference,
    date: row.requested_on,
    counterparty: row.agency,
    subject: `${row.agency} inspection call placing request`,
    workId: row.work_id,
    workCode: row.work_code,
    reference: null,
    status: row.status === 'cancelled' ? 'cancelled' : 'sent',
    extensionUntil: null,
    replyDueOn: null,
    // The outward request is a record of an act, not a document this
    // product renders: 0082 stores no letter for it.
    documentAvailable: false,
  };
  if (row.agency_call_number === null || row.call_letter_received_on === null) {
    return [outward];
  }
  return [
    outward,
    {
      id: row.id,
      source: 'inspection',
      direction: 'inward',
      number: row.agency_call_number,
      date: row.call_letter_received_on,
      counterparty: row.agency,
      subject: `Inward call letter linked to ${callReference}`,
      workId: row.work_id,
      workCode: row.work_code,
      reference: callReference,
      status: 'received',
      extensionUntil: null,
      replyDueOn: null,
      documentAvailable: row.call_letter_available,
    },
  ];
}

/** Every tab's count, on every request. The design contract draws all
 * four numbers in the tab list whichever tab is open, so answering only
 * the open tab's count would leave three of them stale or absent. */
async function readCounts(
  tx: TransactionSql,
  scope: WorkScope,
): Promise<CorrespondenceCounts> {
  const [row] = await tx<
    {
      outward: string;
      inward: string;
      extensions: string;
      inspection: string;
    }[]
  >`
    select
      (select count(*) from correspondence_letters l
        where l.direction = 'outward' and ${visibleLetters(tx, scope)}) as outward,
      (select count(*) from correspondence_letters l
        where l.direction = 'inward' and ${visibleLetters(tx, scope)}) as inward,
      (select count(*) from extension_requests e
        where ${visibleWorkRows(tx, scope, 'e.work_id')}) as extensions,
      -- A call with its inward letter recorded shows as two rows, so the
      -- count adds the letters rather than the calls.
      (select count(*) + count(ic.agency_call_number) from inspection_calls ic
        where ${visibleWorkRows(tx, scope, 'ic.work_id')}) as inspection
  `;
  return {
    outward: Number(row?.outward ?? 0),
    inward: Number(row?.inward ?? 0),
    extensions: Number(row?.extensions ?? 0),
    inspection: Number(row?.inspection ?? 0),
  };
}

async function readAwaitingExtensionResponses(
  tx: TransactionSql,
  scope: WorkScope,
): Promise<number> {
  const [row] = await tx<{ awaiting: string }[]>`
    select count(*) as awaiting from extension_requests e
    where e.status = 'finalised' and ${visibleWorkRows(tx, scope, 'e.work_id')}
  `;
  return Number(row?.awaiting ?? 0);
}

async function scopeOf(tx: TransactionSql, userId: string): Promise<WorkScope> {
  return { userId, full: await hasFullWorkScope(tx, userId) };
}

/** Today in the organisation's own timezone. A letter dated tomorrow is a
 * typo, and "tomorrow" is a question about where the organisation is, not
 * where the server or the browser is. */
async function organisationToday(tx: TransactionSql): Promise<string> {
  const [row] = await tx<{ today: string }[]>`
    select (now() at time zone timezone)::date::text as today
    from organisations
    where id = app_private.current_organisation_id()
  `;
  if (!row) throw new Error('bound organisation disappeared');
  return row.today;
}

function assertNotFuture(date: string, today: string, what: string): void {
  if (date > today) {
    throw httpError(
      400,
      'CORRESPONDENCE_DATE_IN_FUTURE',
      `${what} cannot be after today (${today}) in the organisation timezone.`,
    );
  }
}

/** The chosen addressee, snapshotted. Masters are PICKERS: the contact's
 * lifecycle is checked HERE, where the operator chooses it, and the NAME
 * is copied onto the letter so a later rename cannot readdress it. */
async function snapshotCounterparty(
  tx: TransactionSql,
  contactId: string,
): Promise<string> {
  const [contact] = await tx<{ designation: string; active: boolean }[]>`
    select designation, active from contacts where id = ${contactId}
  `;
  if (!contact) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  if (!contact.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'That contact has been retired. Pick a current one, or reinstate it in Masters.',
    );
  }
  return contact.designation;
}

/** The Work the letter is filed under, if any. Work-scope is proven the
 * same way every other Work-bearing write proves it. */
async function assertLetterWork(
  tx: TransactionSql,
  userId: string,
  workId: string | undefined,
): Promise<string | null> {
  if (workId === undefined) return null;
  await assertWorkAccess(tx, userId, workId);
  const [work] = await tx<{ id: string }[]>`
    select id from works where id = ${workId} and deleted_at is null
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return workId;
}

/** The letter this one answers, if any. Read under the caller's own
 * work-scope, so a reply cannot be used to confirm the existence of a
 * letter on a Work the caller may not see. */
async function assertReplyTarget(
  tx: TransactionSql,
  scope: WorkScope,
  replyToLetterId: string | undefined,
): Promise<string | null> {
  if (replyToLetterId === undefined) return null;
  const [parent] = await tx<{ id: string; cancelled_at: Date | null }[]>`
    select l.id, l.cancelled_at from correspondence_letters l
    where l.id = ${replyToLetterId} and ${visibleLetters(tx, scope)}
  `;
  if (!parent) {
    throw httpError(
      404,
      'CORRESPONDENCE_LETTER_NOT_FOUND',
      'No such letter to reply to.',
    );
  }
  if (parent.cancelled_at !== null) {
    throw httpError(
      409,
      'CORRESPONDENCE_LETTER_CANCELLED',
      'That letter was cancelled and cannot be answered.',
    );
  }
  return replyToLetterId;
}

/**
 * The next serial in a direction's series for a financial year.
 *
 * The upsert-returning shape 0082 uses: one statement, no read-then-write
 * window, and the counter row is the lock. A rolled-back registration
 * rolls its number back with it, which is what keeps the series gap-free
 * — and `correspondence_letters_sequence_unique` is the second layer that
 * refuses two rows carrying serial 7 even if a counter were ever repaired
 * by hand.
 */
async function claimSequence(
  tx: TransactionSql,
  organisationId: string,
  direction: 'outward' | 'inward',
  fyLabel: string,
): Promise<number> {
  const [row] = await tx<{ sequence_number: number }[]>`
    insert into correspondence_letter_counters
      (organisation_id, direction, fy_label, next_value)
    values (${organisationId}, ${direction}, ${fyLabel}, 2)
    on conflict (organisation_id, direction, fy_label) do update
    set next_value = correspondence_letter_counters.next_value + 1,
        updated_at = now()
    returning (next_value - 1) as sequence_number
  `;
  if (!row) throw new Error('correspondence counter returned no row');
  return Number(row.sequence_number);
}

/** How 0086's named refusals reach the caller. The guards raise these
 * rather than a bare `check_violation` so a lost race arrives as the
 * conflict it is instead of an unexplained 500. */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23E01': [
    'CORRESPONDENCE_LETTER_IMMUTABLE',
    'A registered letter cannot be edited. Cancel it and file the correct one.',
  ],
  '23E02': [
    'CORRESPONDENCE_LETTER_CANCELLED',
    'That letter was already cancelled and cannot be reinstated.',
  ],
  '23E03': [
    'CORRESPONDENCE_LETTER_NOT_FOUND',
    'The letter being replied to is no longer in this organisation.',
  ],
  '23E04': [
    'CORRESPONDENCE_LETTER_CANCELLED',
    'The letter being replied to was cancelled while this one was being filed.',
  ],
  '23E05': [
    'CORRESPONDENCE_LETTER_ANSWERED',
    'This letter has been answered. Cancel the reply first, then cancel this one.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  // The unique index on (organisation, direction, financial year,
  // sequence) is the second layer under the counter. Losing to it means
  // two registrations claimed one serial, which the counter should have
  // prevented — the caller retries and takes the next one.
  if (code === '23505') {
    throw httpError(
      409,
      'CORRESPONDENCE_NUMBER_CONFLICT',
      'Another letter took that number at the same moment. File this one again.',
    );
  }
  throw error;
}

export function registerCorrespondenceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/correspondence',
      schema: {
        querystring: CorrespondenceListQuerySchema,
        response: { 200: CorrespondenceListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const tab: CorrespondenceTab = request.query.tab ?? 'outward';
      const { limit, cursor } = request.query;
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const [counts, awaitingExtensionResponses] = await Promise.all([
          readCounts(tx, scope),
          readAwaitingExtensionResponses(tx, scope),
        ]);

        if (tab === 'extensions') {
          const proven = await workScopedCursorRowId(
            tx,
            'extension_requests',
            cursor,
            scope,
          );
          const rows = await readExtensionEntries(tx, scope, limit, proven);
          const page = keysetPage(rows, limit, (row) => row.id);
          return {
            entries: page.rows.map(toExtensionEntry),
            nextCursor: page.nextCursor,
            counts,
            awaitingExtensionResponses,
          };
        }

        if (tab === 'inspection') {
          const proven = await workScopedCursorRowId(
            tx,
            'inspection_calls',
            cursor,
            scope,
          );
          const rows = await readInspectionEntries(tx, scope, limit, proven);
          const page = keysetPage(rows, limit, (row) => row.id);
          return {
            // One call can be two letters, so a page of CALLS is what the
            // cursor walks and the entry count of a page may exceed the
            // limit by the number of inward letters on it. Paging the
            // entries instead would split a call's pair across a page
            // boundary and give two rows the same cursor id.
            entries: page.rows.flatMap(inspectionEntriesOf),
            nextCursor: page.nextCursor,
            counts,
            awaitingExtensionResponses,
          };
        }

        const proven = await letterCursorRowId(tx, scope, cursor);
        const rows = await readLetters(tx, scope, tab, limit, proven);
        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          entries: page.rows.map(toLetterEntry),
          nextCursor: page.nextCursor,
          counts,
          awaitingExtensionResponses,
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/correspondence/thread-options',
      schema: {
        response: {
          200: CorrespondenceThreadOptionsResponseSchema,
          ...errorResponses,
        },
      },
    },
    async ({ user, tenant }) =>
      tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const letters = await tx<{ id: string; number: string; subject: string }[]>`
          select l.id, l.letter_number as number, l.subject
          from correspondence_letters l
          where l.cancelled_at is null and ${visibleLetters(tx, scope)}
          order by l.letter_date desc, l.id desc
        `;
        return { letters };
      }),
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/correspondence/outward',
      role: 'writer',
      schema: {
        body: WriteOutwardLetterRequestSchema,
        response: { 201: Type.Object({ id: Type.String(), number: Type.String() }) },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const input = request.body;
      const subject = requireTrimmed(input.subject, 'Give the letter a subject.');
      const body = requireTrimmed(
        input.body,
        'A letter needs something written in it.',
      );

      const created = await tenant(async (tx) => {
        const today = await organisationToday(tx);
        assertNotFuture(input.letterDate, today, 'The letter date');
        const scope = await scopeOf(tx, user.id);
        const workId = await assertLetterWork(tx, user.id, input.workId);
        const replyTo = await assertReplyTarget(tx, scope, input.replyToLetterId);
        const counterparty = await snapshotCounterparty(tx, input.contactId);

        const fyLabel = financialYearLabel(input.letterDate);
        const sequence = await claimSequence(tx, organisationId, 'outward', fyLabel);
        const letterNumber = letterNumberOf('outward', fyLabel, sequence);

        const [row] = await tx<{ id: string }[]>`
          insert into correspondence_letters (
            organisation_id, work_id, direction, letter_number, financial_year,
            sequence_number, letter_date, subject, counterparty_name, body,
            reply_to_letter_id, created_by_user_id
          )
          values (
            ${organisationId}, ${workId}, 'outward', ${letterNumber}, ${fyLabel},
            ${sequence}, ${input.letterDate}, ${subject}, ${counterparty}, ${body},
            ${replyTo}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('correspondence letter insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'correspondence_letter.dispatched',
          'correspondence_letters',
          row.id,
          { letterNumber, workId, subject, repliesTo: replyTo },
        );
        return { id: row.id, number: letterNumber };
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/correspondence/inward',
      role: 'writer',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        querystring: RegisterInwardLetterQuerySchema,
        response: {
          201: Type.Object({ id: Type.String(), number: Type.String() }),
          ...upstreamErrorResponses,
        },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const input = request.query;
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the received letter',
      });
      // Every field shape BEFORE the scan: an ill-formed request must not
      // spend scanner capacity, and a refusal raised after the object is
      // stored leaves an orphan behind.
      const filename = requireTrimmed(
        input.filename,
        'The uploaded scan needs a name.',
      );
      const subject = requireTrimmed(input.subject, 'Give the letter a subject.');
      const senderReference = optionalTrimmed(input.senderReference);

      await tenant(async (tx) => {
        const today = await organisationToday(tx);
        assertNotFuture(input.receivedOn, today, 'The received date');
        if (input.senderLetterDate !== undefined) {
          assertNotFuture(input.senderLetterDate, today, "The sender's letter date");
        }
        const scope = await scopeOf(tx, user.id);
        await assertLetterWork(tx, user.id, input.workId);
        await assertReplyTarget(tx, scope, input.replyToLetterId);
        await snapshotCounterparty(tx, input.contactId);
      });
      await assertNotMalware(scanner, bytes);

      const stored = await storePdfUpload(storage, organisationId, STORAGE_AREA, bytes);

      const created = await tenant(async (tx) => {
        // Re-proven inside the writing transaction: the checks above ran
        // in a transaction that has since committed, and a Work
        // unassigned or a contact retired in between must not land.
        const scope = await scopeOf(tx, user.id);
        const workId = await assertLetterWork(tx, user.id, input.workId);
        const replyTo = await assertReplyTarget(tx, scope, input.replyToLetterId);
        const counterparty = await snapshotCounterparty(tx, input.contactId);

        const fyLabel = financialYearLabel(input.receivedOn);
        const sequence = await claimSequence(tx, organisationId, 'inward', fyLabel);
        const letterNumber = letterNumberOf('inward', fyLabel, sequence);

        const [row] = await tx<{ id: string }[]>`
          insert into correspondence_letters (
            organisation_id, work_id, direction, letter_number, financial_year,
            sequence_number, letter_date, subject, counterparty_name,
            sender_reference, sender_letter_date, response_due_on,
            reply_to_letter_id, scan_object_key, scan_original_filename,
            scan_sha256, scan_size_bytes, created_by_user_id
          )
          values (
            ${organisationId}, ${workId}, 'inward', ${letterNumber}, ${fyLabel},
            ${sequence}, ${input.receivedOn}, ${subject}, ${counterparty},
            ${senderReference ?? null}, ${input.senderLetterDate ?? null},
            ${input.responseDueOn ?? null}, ${replyTo}, ${stored.objectKey},
            ${filename}, ${stored.sha256}, ${bytes.length}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!row) throw new Error('correspondence letter insert returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'correspondence_letter.received',
          'correspondence_letters',
          row.id,
          {
            letterNumber,
            workId,
            subject,
            senderReference: senderReference ?? null,
            sha256: stored.sha256,
          },
        );
        return { id: row.id, number: letterNumber };
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/correspondence/:id/cancel',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: CancelCorrespondenceLetterRequestSchema,
        response: { 200: Type.Object({ id: Type.String() }), ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const reason = requireTrimmed(
        request.body.reason,
        'Say why the letter is being cancelled.',
      );
      return tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const [letter] = await tx<
          { id: string; letter_number: string; cancelled_at: Date | null }[]
        >`
          select l.id, l.letter_number, l.cancelled_at
          from correspondence_letters l
          where l.id = ${id} and ${visibleLetters(tx, scope)}
          for update
        `;
        if (!letter) {
          throw httpError(
            404,
            'CORRESPONDENCE_LETTER_NOT_FOUND',
            'No such letter in this register.',
          );
        }
        if (letter.cancelled_at !== null) {
          throw httpError(
            409,
            'CORRESPONDENCE_LETTER_CANCELLED',
            'That letter is already cancelled.',
          );
        }
        await tx`
          update correspondence_letters
          set cancelled_at = now(),
              cancelled_by_user_id = ${user.id},
              cancellation_reason = ${reason}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'correspondence_letter.cancelled',
          'correspondence_letters',
          id,
          { letterNumber: letter.letter_number, reason },
        );
        return { id };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/correspondence/:id/document',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...upstreamErrorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const letter = await tenant(async (tx) => {
        const scope = await scopeOf(tx, user.id);
        const [row] = await tx<
          {
            direction: 'outward' | 'inward';
            letter_number: string;
            letter_date: string;
            subject: string;
            counterparty_name: string;
            body: string | null;
            cancellation_reason: string | null;
            scan_object_key: string | null;
            scan_original_filename: string | null;
            work_code: string | null;
            work_title: string | null;
            reply_to_number: string | null;
            organisation_name: string;
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
          select
            l.direction, l.letter_number, l.letter_date::text as letter_date,
            l.subject, l.counterparty_name, l.body, l.cancellation_reason,
            l.scan_object_key, l.scan_original_filename,
            w.work_code, w.title as work_title,
            parent.letter_number as reply_to_number,
            o.name as organisation_name, o.address, o.gstin,
            o.contact_phone, o.contact_email,
            o.logo_object_key, o.logo_media_type
          from correspondence_letters l
          left join works w on w.id = l.work_id
          left join correspondence_letters parent on parent.id = l.reply_to_letter_id
          join organisations o on o.id = l.organisation_id
          where l.id = ${id} and ${visibleLetters(tx, scope)}
        `;
        if (!row) {
          throw httpError(
            404,
            'CORRESPONDENCE_LETTER_NOT_FOUND',
            'No such letter in this register.',
          );
        }
        return row;
      });

      if (letter.direction === 'inward') {
        // The scan, as it arrived. 0086 refuses an inward row without
        // one, so this is never null.
        const bytes = await storage.get(letter.scan_object_key ?? '');
        void reply.type('application/pdf');
        void reply.header(
          'content-disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(letter.scan_original_filename ?? 'letter.pdf')}`,
        );
        return reply.send(bytes);
      }

      let logoDataUri: string | undefined;
      if (letter.logo_object_key !== null && letter.logo_media_type !== null) {
        try {
          const logo = await storage.get(letter.logo_object_key);
          logoDataUri = `data:${letter.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          request.log.warn({ err: error }, 'outward letter: logo unavailable');
        }
      }
      const snapshot: OutwardLetterSnapshot = {
        organisationName: letter.organisation_name,
        letterNumber: letter.letter_number,
        letterDate: letter.letter_date,
        counterpartyName: letter.counterparty_name,
        subject: letter.subject,
        body: letter.body ?? '',
        work:
          letter.work_code !== null
            ? { workCode: letter.work_code, title: letter.work_title ?? '' }
            : null,
        inReplyTo: letter.reply_to_number,
        cancelledReason: letter.cancellation_reason,
      };
      const html = renderOutwardLetterHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: letter.address,
        gstin: letter.gstin,
        contactPhone: letter.contact_phone,
        contactEmail: letter.contact_email,
      });
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the letter itself is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'outward letter render failed');
        },
      });
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="${letter.letter_number.replaceAll('/', '-')}.pdf"`,
      );
      return reply.send(pdf);
    },
  );
}
