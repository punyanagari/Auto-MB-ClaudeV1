import {
  byItemNumber,
  CancelInspectionCallRequestSchema,
  CreateInspectionCallRequestSchema,
  InspectionCallListResponseSchema,
  InspectionCallSchema,
  KeysetQuerySchema,
  ReceiveCallLetterQuerySchema,
  SaveInspectionChecklistRequestSchema,
  SaveInspectionClausesRequestSchema,
  UploadInspectionCertificateQuerySchema,
  UploadInspectionEvidenceQuerySchema,
  WorkInspectionConfigSchema,
  type ErrorCode,
  type InspectionAgency,
  type InspectionCall,
  type InspectionCallDocument,
  type InspectionCallItem,
  type InspectionCallStatus,
  type InspectionChecklistField,
  type InspectionClauseAgency,
  type InspectionDocumentKind,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { ObjectStorage } from '@auto-mb/documents';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope, requireOwnerRole } from '../authz.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { keysetPage, sqlLimit, workScopedCursorRowId } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
  storePdfUpload,
} from '../upload-guards.js';
import { assertWorkOperable } from '../work-status.js';
import {
  audit,
  errorResponses,
  IdParamsSchema,
  requireTrimmed,
  upstreamErrorResponses,
} from './shared.js';

/**
 * The railway inspection lifecycle (migration 0082).
 *
 * Nothing manufactured for Indian Railways despatches until RDSO or RITES
 * has inspected it at the vendor's premises and issued a certificate. This
 * module records that: the CLAUSE that says which items are inspected and
 * by whom, the CHECKLIST of papers the agency demands, and the CALL — one
 * inspection from outward request to certificate, which is also the job
 * card the evidence hangs off.
 *
 * ## The interlock
 *
 * `gates_dispatch` on a clause is the reason this module is not merely a
 * filing cabinet. An item carrying it cannot be despatched BEYOND THE
 * QUANTITY a live certificate of its own agency covers. The comparison is
 * cumulative and lives in one SQL function
 * (`app_private.inspection_dispatch_shortfall`), which `routes/challans.ts`
 * calls inside the issue transaction — at the same altitude as the
 * delivery ceiling, under the same `work_items` locks — and which the
 * backstop trigger on `delivery_challans` calls too. One arithmetic, two
 * enforcement points.
 *
 * It is off by default and off for every Work that existed before the
 * migration, because the default is the ABSENCE of a clause row rather
 * than a column somebody has to remember to leave false.
 *
 * ## Lock order
 *
 * works -> work_items -> inspection_calls, everywhere, so no two paths of
 * this module and the challan module can deadlock:
 *
 *   * the clause mapping takes `work_items FOR UPDATE` before it writes
 *     `gates_dispatch`, and the challan issue takes the same locks before
 *     it reads the flag;
 *   * the challan issue then takes `inspection_calls FOR SHARE` on the
 *     calls its answer depends on, and withdrawal takes the call row FOR
 *     UPDATE — so a withdrawal cannot land between the gate's read and the
 *     issue's commit.
 *
 * ## Permissions, and why no new authority
 *
 * The per-feature matrix already carries what this needs, and the company
 * document library made the same call for the same reason:
 *
 *   * The clause MAPPING (which agency, whose premises, how much) is Work
 *     master data — `role: 'writer'`.
 *   * The `gatesDispatch` SWITCH, and any agency change on an item that
 *     is gated, require an owner: both decide what a despatch is allowed
 *     to rest on, which is the class of act `works.allow_excess_delivery`
 *     already reserves to the owner. Checked inline rather than declared,
 *     because it fires only when one of those actually moves.
 *   * Raising a call is outward correspondence with a government agency —
 *     `role: 'writer'`.
 *   * Receiving the letter, attaching evidence and uploading the
 *     certificate are `role: 'evidence'`: this is site and QA work,
 *     exactly like recording a delivery or an installation.
 *   * Cancelling carries the `cancel` authority, as every other cancel of
 *     a numbered record does.
 *
 * ponytail: no PDF is GENERATED here — the mock's checklist offers
 * "Generate" for a datasheet or an undertaking, and there is no template
 * behind it in this application. Every paper is an upload. Wire a
 * generator in when the templates exist rather than shipping a button that
 * fakes a filename.
 */

/** The storage area segment for this module. `assertSafeObjectKey` accepts
 * `[a-z]+` only, which is why it is one word. */
const STORAGE_AREA = 'inspection';

const FILENAME_REFUSAL = 'Give the uploaded file a name.';

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0082 raises with SQLSTATEs from the 23C block, one per rule,
 * so a guard that fires because a writer reached the table by another path
 * surfaces as the same 409 an operator would have got from the route —
 * not as an unexplained 500. The route checks each of these first, under
 * its locks; this is the concurrent arm of the same rules.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23C01': [
    'INSPECTION_CALL_STATE_INVALID',
    'The inspection call moved to another state while this was being recorded.',
  ],
  '23C02': [
    'INSPECTION_CALL_CLOSED',
    'The inspection call was closed or withdrawn while this was being recorded.',
  ],
  '23C03': [
    'INSPECTION_CALL_INCOMPLETE',
    'A mandatory document or the certificate went missing while the call was being closed.',
  ],
  '23C04': [
    'INSPECTION_CALL_STATE_INVALID',
    'The call left the requested state while its item coverage was being changed.',
  ],
  '23C05': [
    'INSPECTION_CERTIFICATE_MISSING',
    'A live inspection certificate stopped covering this despatch while it was being issued.',
  ],
  '23C06': [
    'INSPECTION_CALL_NOT_FOUND',
    'The inspection call was not found in this organisation.',
  ],
  // Migration 0116's own block. The route refuses a non-vendor contact
  // first, in a sentence naming it; this is the arm that holds when the
  // contact loses its vendor role between the check and the write.
  '23Y01': [
    'INSPECTION_VENDOR_INVALID',
    'The inspection vendor must be a contact carrying the vendor role.',
  ],
  // The generic CHECK-violation backstop. Every named rule above and every
  // route-level refusal fires first; what remains is a stored shape rule —
  // a premises or name that is blank, padded with spaces, or longer than
  // the column allows, or a call snapshot missing its copied text — and a
  // named 409 beats the bare 500 it used to surface as.
  '23514': [
    'INSPECTION_CLAUSE_INVALID',
    'A stored inspection rule refused this write — most often a premises or name that is blank, starts or ends with spaces, or is longer than the field allows.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/** The same refusal, restated to say WHICH row of the clause table it is
 * about: the message gains the item number and the payload carries the
 * `workItemId`, so a client can point at the row instead of the operator
 * hunting a long schedule for it. Anything that is not a curated refusal
 * passes through untouched. */
function namedForItem(
  error: unknown,
  workItemId: string,
  itemNumber: string | undefined,
): unknown {
  if (
    error instanceof Error &&
    'expose' in error &&
    'statusCode' in error &&
    'code' in error &&
    typeof error.statusCode === 'number'
  ) {
    return httpError(
      error.statusCode,
      error.code as ErrorCode,
      itemNumber === undefined ? error.message : `Item ${itemNumber}: ${error.message}`,
      { workItemId },
    );
  }
  return error;
}

// --- Row shapes -------------------------------------------------------------

interface CallRow {
  id: string;
  work_id: string;
  work_code: string;
  sequence_number: number;
  agency: InspectionAgency;
  status: InspectionCallStatus;
  requested_on: string;
  agency_call_number: string | null;
  call_letter_received_on: string | null;
  certificate_number: string | null;
  certificate_date: string | null;
  certificate_valid_until: string | null;
  certificate_live: boolean;
  vendor_contact_id: string | null;
  vendor_address_id: string | null;
  vendor_name: string | null;
  vendor_premises: string | null;
  cancellation_reason: string | null;
  created_at: Date;
}

interface CallItemRow {
  inspection_call_id: string;
  work_item_id: string;
  item_number: string;
  description: string;
  quantity: string;
}

interface CallDocumentRow {
  inspection_call_id: string;
  id: string;
  kind: InspectionDocumentKind;
  label: string;
  mandatory: boolean;
  original_filename: string | null;
  sha256: string | null;
  size_bytes: string | null;
  uploaded_at: Date | null;
}

interface AdvisoryChallanRow {
  inspection_call_id: string;
  challan_id: string;
  challan_number: string;
  challan_date: string;
  item_number: string;
  quantity: string;
}

/** `INS/<work code>/<sequence>` — the outward request's identity. Built
 * for display rather than stored, because both halves are already columns
 * and a third copy is a third thing that can disagree. */
function callReferenceOf(workCode: string, sequenceNumber: number): string {
  return `INS/${workCode}/${String(sequenceNumber).padStart(3, '0')}`;
}

function toCall(
  row: CallRow,
  items: readonly CallItemRow[],
  documents: readonly CallDocumentRow[],
  advisory: readonly AdvisoryChallanRow[],
): InspectionCall {
  return {
    id: row.id,
    workId: row.work_id,
    workCode: row.work_code,
    callReference: callReferenceOf(row.work_code, Number(row.sequence_number)),
    agency: row.agency,
    status: row.status,
    requestedOn: row.requested_on,
    agencyCallNumber: row.agency_call_number,
    callLetterReceivedOn: row.call_letter_received_on,
    certificateNumber: row.certificate_number,
    certificateDate: row.certificate_date,
    certificateValidUntil: row.certificate_valid_until,
    certificateLive: row.certificate_live,
    vendorContactId: row.vendor_contact_id,
    vendorAddressId: row.vendor_address_id,
    vendorName: row.vendor_name,
    vendorPremises: row.vendor_premises,
    cancellationReason: row.cancellation_reason,
    advisoryIssuedChallans: advisory.map((challan) => ({
      challanId: challan.challan_id,
      challanNumber: challan.challan_number,
      challanDate: challan.challan_date,
      itemNumber: challan.item_number,
      quantity: challan.quantity,
    })),
    // Natural order: `item_number` is text, so the SQL sorts A1/10 before
    // A1/2 — not the order the schedule this call cites is written in.
    items: byItemNumber(
      items.map((item): InspectionCallItem => ({
        workItemId: item.work_item_id,
        itemNumber: item.item_number,
        description: item.description,
        quantity: item.quantity,
      })),
    ),
    documents: documents.map((document): InspectionCallDocument => ({
      id: document.id,
      kind: document.kind,
      label: document.label,
      mandatory: document.mandatory,
      originalFilename: document.original_filename,
      sha256: document.sha256,
      sizeBytes: document.size_bytes === null ? null : Number(document.size_bytes),
      uploadedAt: document.uploaded_at?.toISOString() ?? null,
    })),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The call rows for a set of ids, with their items, documents and the
 * challans issued under their certificate.
 *
 * `certificate_live` comes from `app_private.inspection_certificate_live`
 * against `app_private.organisation_today` — the same two functions the
 * dispatch gate uses, so the flag a screen shows and the refusal a
 * despatch meets cannot disagree, and neither of them is decided by UTC's
 * idea of today when the operator is on IST.
 */
async function loadCalls(
  tx: TransactionSql,
  organisationId: string,
  callIds: readonly string[],
): Promise<Map<string, InspectionCall>> {
  const loaded = new Map<string, InspectionCall>();
  if (callIds.length === 0) return loaded;

  const rows = await tx<CallRow[]>`
    select ic.id, ic.work_id, w.work_code, ic.sequence_number, ic.agency,
           ic.status,
           ic.requested_on::text as requested_on,
           ic.agency_call_number,
           ic.call_letter_received_on::text as call_letter_received_on,
           ic.certificate_number,
           ic.certificate_date::text as certificate_date,
           ic.certificate_valid_until::text as certificate_valid_until,
           app_private.inspection_certificate_live(
             ic.status, ic.certificate_valid_until,
             (select app_private.organisation_today(${organisationId}))
           ) as certificate_live,
           ic.vendor_contact_id, ic.vendor_address_id, ic.vendor_name,
           ic.vendor_premises, ic.cancellation_reason, ic.created_at
    from inspection_calls ic
    join works w on w.id = ic.work_id
    where ic.id = any(${callIds}::uuid[])
  `;
  const items = await tx<CallItemRow[]>`
    select ici.inspection_call_id, ici.work_item_id, wi.item_number,
           coalesce(wi.effective_description, wi.description) as description,
           ici.quantity::text as quantity
    from inspection_call_items ici
    join work_items wi on wi.id = ici.work_item_id
    where ici.inspection_call_id = any(${callIds}::uuid[])
    order by wi.item_number
  `;
  const documents = await tx<CallDocumentRow[]>`
    select inspection_call_id, id, kind, label, mandatory, original_filename,
           sha256, size_bytes::text as size_bytes, uploaded_at
    from inspection_call_documents
    where inspection_call_id = any(${callIds}::uuid[])
    order by position, label
  `;
  // ADVISORY, and the contract says so. There is no recorded link from a
  // challan to the certificate that permitted it — the certificate is a
  // condition of issue, not a field on the document — so this matches by
  // item and by the challan falling inside the certificate's own window.
  // It over-reports when two calls covered one item in the same window and
  // under-reports nothing, which is the right direction for a list whose
  // only job is to tell somebody which lorries to chase.
  const advisory = await tx<AdvisoryChallanRow[]>`
    select ici.inspection_call_id, dc.id as challan_id,
           dc.challan_number, dc.challan_date::text as challan_date,
           wi.item_number, dci.quantity::text as quantity
    from inspection_calls ic
    join inspection_call_items ici on ici.inspection_call_id = ic.id
    join work_items wi on wi.id = ici.work_item_id
    join delivery_challan_items dci on dci.work_item_id = ici.work_item_id
    join delivery_challans dc on dc.id = dci.delivery_challan_id
    where ic.id = any(${callIds}::uuid[])
      and ic.status in ('closed', 'cancelled')
      and ic.certificate_date is not null
      and dc.status = 'issued'
      and dc.challan_date >= ic.certificate_date
      and (ic.certificate_valid_until is null
           or dc.challan_date <= ic.certificate_valid_until)
    order by dc.challan_date, dc.challan_number, wi.item_number
  `;

  const itemsByCall = groupBy(items, (row) => row.inspection_call_id);
  const documentsByCall = groupBy(documents, (row) => row.inspection_call_id);
  const advisoryByCall = groupBy(advisory, (row) => row.inspection_call_id);
  for (const row of rows) {
    loaded.set(
      row.id,
      toCall(
        row,
        itemsByCall.get(row.id) ?? [],
        documentsByCall.get(row.id) ?? [],
        advisoryByCall.get(row.id) ?? [],
      ),
    );
  }
  return loaded;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(key(row));
    if (bucket === undefined) grouped.set(key(row), [row]);
    else bucket.push(row);
  }
  return grouped;
}

async function readCall(
  tx: TransactionSql,
  organisationId: string,
  callId: string,
): Promise<InspectionCall> {
  const loaded = await loadCalls(tx, organisationId, [callId]);
  const call = loaded.get(callId);
  if (call === undefined) {
    throw httpError(404, 'INSPECTION_CALL_NOT_FOUND', 'No such inspection call.');
  }
  return call;
}

interface LockedCall {
  readonly id: string;
  readonly workId: string;
  readonly status: InspectionCallStatus;
  readonly workStatus: string;
}

/** Loads a call for mutation: proves it exists, proves the caller reaches
 * its Work, and takes the row lock so two writers cannot both read the
 * same state and both act on it. The lock is taken AFTER the caller's
 * `work_items` locks wherever both are held, keeping the module's one
 * lock order. */
async function loadCallForUpdate(
  tx: TransactionSql,
  userId: string,
  callId: string,
): Promise<LockedCall> {
  const [row] = await tx<
    {
      id: string;
      work_id: string;
      status: InspectionCallStatus;
      work_status: string;
    }[]
  >`
    select ic.id, ic.work_id, ic.status, w.status as work_status
    from inspection_calls ic
    join works w on w.id = ic.work_id
    where ic.id = ${callId}
    for no key update of ic
  `;
  if (!row) {
    throw httpError(404, 'INSPECTION_CALL_NOT_FOUND', 'No such inspection call.');
  }
  await assertWorkAccess(tx, userId, row.work_id);
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    workStatus: row.work_status,
  };
}

/** A terminal call takes no further changes. Refused here in a sentence
 * and again by the 0082 transition trigger, which is the posture this
 * repository takes wherever an issued record can be reached by more than
 * one path. */
function assertCallOpen(status: InspectionCallStatus, act: string): void {
  if (status === 'closed' || status === 'cancelled') {
    throw httpError(
      409,
      'INSPECTION_CALL_CLOSED',
      `This inspection call is ${status} and is a finished record; ${act} is no longer possible.`,
    );
  }
}

function assertCallStatus(
  status: InspectionCallStatus,
  expected: InspectionCallStatus,
  requirement: string,
): void {
  assertCallOpen(status, requirement);
  if (status !== expected) {
    throw httpError(409, 'INSPECTION_CALL_STATE_INVALID', requirement);
  }
}

/** Every act that ADVANCES a call is an operational act on the Work, so a
 * completed or superseded Work refuses it exactly as it refuses a challan
 * (R8). Withdrawal is deliberately NOT in this set: revoking a certificate
 * has to stay available on a Work whose paperwork is closed, because a
 * certificate can be withdrawn after the last despatch. */
function assertCallAdvanceable(call: LockedCall, act: string): void {
  assertWorkOperable(call.workStatus, act);
}

interface AttachedFile {
  readonly objectKey: string;
  readonly sha256: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly userId: string;
}

/** Fills (or replaces) the file half of an existing evidence row. The 0082
 * trigger refuses this once the call is terminal and refuses any change to
 * the demand itself, so the SET list below is the whole of what may
 * legitimately move. */
async function attachFile(
  tx: TransactionSql,
  documentId: string,
  file: AttachedFile,
): Promise<void> {
  await tx`
    update inspection_call_documents
    set object_key = ${file.objectKey},
        original_filename = ${file.filename},
        sha256 = ${file.sha256},
        size_bytes = ${file.sizeBytes},
        uploaded_by_user_id = ${file.userId},
        uploaded_at = now()
    where id = ${documentId}
  `.catch(rethrowWriteRefusal);
}

/** Creates a singular document row (the inward letter, the certificate)
 * carrying its file, or refills the one that is already there. The partial
 * unique indexes in 0082 are what make "one per call" true; this reads the
 * existing row first so a replacement is an update rather than a
 * constraint violation the operator has to interpret. */
async function upsertSingularDocument(
  tx: TransactionSql,
  organisationId: string,
  callId: string,
  kind: 'call_letter' | 'certificate',
  label: string,
  file: AttachedFile,
): Promise<void> {
  const [existing] = await tx<{ id: string }[]>`
    select id from inspection_call_documents
    where inspection_call_id = ${callId} and kind = ${kind}
  `;
  if (existing) {
    await attachFile(tx, existing.id, file);
    return;
  }
  await tx`
    insert into inspection_call_documents (
      organisation_id, inspection_call_id, kind, label, mandatory, position,
      object_key, original_filename, sha256, size_bytes,
      uploaded_by_user_id, uploaded_at
    )
    values (
      ${organisationId}, ${callId}, ${kind}, ${label}, true,
      ${kind === 'call_letter' ? 0 : 9000},
      ${file.objectKey}, ${file.filename}, ${file.sha256},
      ${file.sizeBytes}, ${file.userId}, now()
    )
  `.catch(rethrowWriteRefusal);
}

// --- Routes -----------------------------------------------------------------

export function registerInspectionRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  // ---- The Work's inspection clause tab -----------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/inspection-config',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkInspectionConfigSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return readWorkConfig(tx, workId);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/inspection-clauses',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: SaveInspectionClausesRequestSchema,
        response: { 200: WorkInspectionConfigSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const { clauses } = request.body;
      await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ status: string }[]>`
          select status from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'configuring inspection clauses');

        // Duplicate rows in one request would make the mapping ambiguous
        // and the last write would silently win.
        const seen = new Set<string>();
        for (const clause of clauses) {
          if (seen.has(clause.workItemId)) {
            throw httpError(
              400,
              'INSPECTION_CLAUSE_INVALID',
              'One item appears twice in the clause mapping; each item carries one clause.',
            );
          }
          seen.add(clause.workItemId);
          // The 0082 CHECK refuses this too. Said here first so the
          // operator gets the reason rather than a constraint name.
          if (
            clause.gatesDispatch &&
            clause.agency !== 'RDSO' &&
            clause.agency !== 'RITES'
          ) {
            throw httpError(
              400,
              'INSPECTION_CLAUSE_INVALID',
              'Only an RDSO or RITES item can gate despatch; consignee inspection happens after the material arrives.',
            );
          }
        }

        // The `work_items` row lock, taken in id order, is the pairing
        // half of the dispatch gate: `routes/challans.ts` takes the same
        // locks before it reads `gates_dispatch`, so a toggle and an issue
        // of the same Work serialise in either order rather than racing.
        const items = await tx<{ id: string; item_number: string }[]>`
          select id, item_number from work_items
          where work_id = ${workId} and deleted_at is null
          order by id
          for update
        `;
        const known = new Set(items.map((item) => item.id));
        const numberOf = new Map(items.map((item) => [item.id, item.item_number]));
        for (const clause of clauses) {
          if (!known.has(clause.workItemId)) {
            throw httpError(
              404,
              'WORK_ITEM_NOT_FOUND',
              'One of the items in the clause mapping is not on this Work.',
            );
          }
        }

        // WHAT NEEDS THE OWNER. Not the mapping — which agency inspects
        // which item is clerical work — but any change to what a despatch
        // is allowed to rest on. That is the gate flag, and it is ALSO the
        // agency on a gated item: remapping a gated item from RDSO to
        // RITES silently discards every RDSO certificate the gate was
        // counting, which releases or blocks despatch just as surely as
        // the flag does. Both are the class of act
        // `works.allow_excess_delivery` reserves to the owner.
        const before = await tx<
          {
            work_item_id: string;
            gates_dispatch: boolean;
            agency: string;
            vendor_contact_id: string | null;
            vendor_address_id: string | null;
            vendor_premises: string | null;
          }[]
        >`
          select work_item_id, gates_dispatch, agency,
                 vendor_contact_id, vendor_address_id, vendor_premises
          from inspection_clauses
          where work_id = ${workId}
        `;
        const previous = new Map(before.map((row) => [row.work_item_id, row]));
        const ownerActRequired =
          clauses.some((clause) => {
            const was = previous.get(clause.workItemId);
            if (clause.gatesDispatch !== (was?.gates_dispatch ?? false)) return true;
            // An agency change only matters where the gate is on — before
            // the change or after it.
            const gated = clause.gatesDispatch || (was?.gates_dispatch ?? false);
            return gated && was !== undefined && was.agency !== clause.agency;
          }) ||
          // A clause dropped from the submission takes its gate with it.
          before.some(
            (row) =>
              row.gates_dispatch &&
              !clauses.some((clause) => clause.workItemId === row.work_item_id),
          );
        if (ownerActRequired) await requireOwnerRole(tx, user.id);

        // Whole-table replace, because that is how the screen edits it: a
        // table of rows saved together. A partial write would leave the
        // gate configured half from the old state and half from the new.
        const kept = clauses
          .filter((clause) => clause.agency !== null)
          .map((clause) => clause.workItemId);
        await tx`
          delete from inspection_clauses
          where work_id = ${workId}
            and (${kept.length === 0} or work_item_id <> all(${kept}::uuid[]))
        `;
        const written = clauses.filter((clause) => clause.agency !== null);
        // The premises of every CHANGED citation, proved against the
        // contacts master before a single row is written: a half-written
        // mapping would leave the gate configured from two states at
        // once, which is the reason this whole save is a whole-table
        // replace.
        //
        // A citation the submission left exactly as stored is NOT
        // re-proved. The save being a whole-table replace, re-proving
        // every row would let one retired vendor or address brick the
        // whole tab — no other item could be edited until the one
        // citation was cleared. Retirement withdraws a master from being
        // NEWLY cited; it does not invalidate configuration that already
        // cites it (the next CALL raised under it is where a retired
        // master is refused, with the item named).
        //
        // Distinct citations resolve once, not once per row: a 129-item
        // schedule inspected at one vendor is one lookup.
        const premises = new Map<string, ResolvedPremises>();
        const resolved = new Map<string, ResolvedPremises>();
        for (const clause of written) {
          const was = previous.get(clause.workItemId);
          const free = normaliseText(clause.vendorPremises);
          if (
            was !== undefined &&
            was.vendor_contact_id === (clause.vendorContactId ?? null) &&
            was.vendor_address_id === (clause.vendorAddressId ?? null) &&
            was.vendor_premises === free
          ) {
            premises.set(clause.workItemId, {
              vendorContactId: was.vendor_contact_id,
              vendorAddressId: was.vendor_address_id,
              vendorName: null,
              vendorAddress: null,
              vendorPremises: was.vendor_premises,
            });
            continue;
          }
          const key = `${clause.vendorContactId ?? ''}|${clause.vendorAddressId ?? ''}|${free ?? ''}`;
          let proof = resolved.get(key);
          if (proof === undefined) {
            proof = await resolvePremises(tx, clause).catch((error: unknown) => {
              // The refusal names WHICH row, or the operator is left
              // hunting a long schedule for the one citation a 409
              // refuses to identify.
              throw namedForItem(
                error,
                clause.workItemId,
                numberOf.get(clause.workItemId),
              );
            });
            resolved.set(key, proof);
          }
          premises.set(clause.workItemId, proof);
        }
        if (written.length > 0) {
          // One statement, not one per row: the house pattern
          // (`insert into … select … from unnest(...)`), because this runs
          // inside the transaction holding every `work_items` lock of the
          // Work and a per-row round-trip would hold them for the length
          // of the schedule.
          //
          // Every array is sent as text and cast here, the boolean one
          // included: the driver infers a scalar bool from a JavaScript
          // boolean array, and PostgreSQL then refuses to cast that to
          // boolean[]. Text in, one explicit cast out, is the shape that
          // does not depend on driver inference.
          await tx`
            insert into inspection_clauses (
              organisation_id, work_id, work_item_id, agency,
              inspection_quantity, vendor_contact_id, vendor_address_id,
              vendor_premises, gates_dispatch, created_by_user_id
            )
            select ${organisationId}, ${workId}, clause.work_item_id,
                   clause.agency, clause.inspection_quantity,
                   clause.vendor_contact_id, clause.vendor_address_id,
                   clause.vendor_premises, clause.gates_dispatch, ${user.id}
            from unnest(
              ${written.map((clause) => clause.workItemId)}::uuid[],
              ${written.map((clause) => String(clause.agency))}::text[],
              ${written.map((clause) => clause.inspectionQuantity)}::text[]::quantity_amount[],
              ${written.map((clause) => premises.get(clause.workItemId)?.vendorContactId ?? null)}::text[]::uuid[],
              ${written.map((clause) => premises.get(clause.workItemId)?.vendorAddressId ?? null)}::text[]::uuid[],
              ${written.map((clause) => premises.get(clause.workItemId)?.vendorPremises ?? null)}::text[],
              ${written.map((clause) => String(clause.gatesDispatch))}::text[]::boolean[]
            ) as clause(
              work_item_id, agency, inspection_quantity, vendor_contact_id,
              vendor_address_id, vendor_premises, gates_dispatch
            )
            on conflict (organisation_id, work_item_id) do update
            set agency = excluded.agency,
                inspection_quantity = excluded.inspection_quantity,
                vendor_contact_id = excluded.vendor_contact_id,
                vendor_address_id = excluded.vendor_address_id,
                vendor_premises = excluded.vendor_premises,
                gates_dispatch = excluded.gates_dispatch
          `.catch(rethrowWriteRefusal);
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection.clauses_saved',
          'works',
          workId,
          {
            mapped: kept.length,
            gated: clauses.filter((clause) => clause.gatesDispatch).length,
          },
        );
      });
      // The read runs in its OWN transaction, after the write committed.
      // Re-reading inside the writing transaction would report the Work's
      // state as only this session can see it — including every
      // `work_items` row it still holds locked — and would hold those
      // locks for the length of a screen-sized read.
      return tenant(async (tx) => readWorkConfig(tx, workId));
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/inspection-checklist',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: SaveInspectionChecklistRequestSchema,
        response: { 200: WorkInspectionConfigSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const { agency, scope, fields } = request.body;
      await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        const labels = new Set<string>();
        const trimmed = fields.map((field) => ({
          label: requireTrimmed(field.label, 'Give every checklist document a name.'),
          mandatory: field.mandatory,
        }));
        for (const field of trimmed) {
          if (labels.has(field.label.toLowerCase())) {
            throw httpError(
              409,
              'INSPECTION_CLAUSE_INVALID',
              `The ${agency} checklist already demands "${field.label}".`,
            );
          }
          labels.add(field.label.toLowerCase());
        }

        // Replace the scope's list wholesale. Calls already raised keep
        // their own snapshot rows and are untouched by this — which is the
        // whole reason the snapshot exists.
        const scopedWorkId = scope === 'organisation' ? null : workId;
        await tx`
          delete from inspection_checklist_fields
          where agency = ${agency}
            and work_id is not distinct from ${scopedWorkId}
        `;
        if (trimmed.length > 0) {
          await tx`
            insert into inspection_checklist_fields (
              organisation_id, work_id, agency, label, mandatory, position
            )
            select ${organisationId}, ${scopedWorkId}, ${agency}, field.label,
                   field.mandatory, field.position
            from unnest(
              ${trimmed.map((field) => field.label)}::text[],
              ${trimmed.map((field) => String(field.mandatory))}::text[]::boolean[],
              ${trimmed.map((_, position) => String(position))}::text[]::int[]
            ) as field(label, mandatory, position)
          `;
        }
        // Two literal call sites rather than one with a ternary entity
        // type: `test/audit-timeline-census` reads the entity type off
        // the source, and a computed one is a write site it cannot see.
        if (scope === 'organisation') {
          await audit(
            tx,
            organisationId,
            user.id,
            'inspection.checklist_saved',
            'organisations',
            organisationId,
            { agency, scope, fields: trimmed.length },
          );
        } else {
          await audit(
            tx,
            organisationId,
            user.id,
            'inspection.checklist_saved',
            'works',
            workId,
            { agency, scope, fields: trimmed.length },
          );
        }
      });
      return tenant(async (tx) => readWorkConfig(tx, workId));
    },
  );

  // ---- The Inspection register --------------------------------------------

  tenantRoute(
    {
      method: 'GET',
      url: '/api/inspection-calls',
      schema: {
        querystring: KeysetQuerySchema,
        response: { 200: InspectionCallListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        const full = await hasFullWorkScope(tx, user.id);
        const cursor = await workScopedCursorRowId(
          tx,
          'inspection_calls',
          query.cursor,
          { userId: user.id, full },
        );
        const page = await tx<{ id: string; created_at: Date }[]>`
          select ic.id, ic.created_at
          from inspection_calls ic
          join works w on w.id = ic.work_id
          where w.deleted_at is null
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = ic.work_id and wa.user_id = ${user.id}
            ))
            and (${cursor === null} or
              (ic.created_at, ic.id) < (
                select c.created_at, c.id from inspection_calls c
                where c.id = ${cursor}))
          order by ic.created_at desc, ic.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const paged = keysetPage(page, query.limit, (row) => row.id);
        const loaded = await loadCalls(
          tx,
          organisationId,
          paged.rows.map((row) => row.id),
        );

        // The number the workspace leads with: items whose clause gates
        // despatch and whose certified quantity no longer covers what has
        // already gone out — that is, the items a delivery challan would
        // be refused for today. Computed with the gate's own liveness
        // function rather than a second copy of the date comparison, and
        // scoped by the same work-scope filter as the list.
        const [awaiting] = await tx<{ count: string }[]>`
          select count(*)::text as count
          from inspection_clauses c
          join work_items wi on wi.id = c.work_item_id
          join works w on w.id = c.work_id
          where c.gates_dispatch
            and wi.deleted_at is null
            and w.deleted_at is null
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = c.work_id and wa.user_id = ${user.id}
            ))
            and coalesce((
              select sum(dci.quantity)
              from delivery_challan_items dci
              join delivery_challans dc on dc.id = dci.delivery_challan_id
              where dci.work_item_id = c.work_item_id and dc.status = 'issued'
            ), 0) >= coalesce((
              select sum(ici.quantity)
              from inspection_call_items ici
              join inspection_calls ic on ic.id = ici.inspection_call_id
              where ici.work_item_id = c.work_item_id
                and ici.work_id = c.work_id
                and ic.agency = c.agency
                and app_private.inspection_certificate_live(
                      ic.status, ic.certificate_valid_until,
                      (select app_private.organisation_today(${organisationId})))
            ), 0)
        `;
        return {
          nextCursor: paged.nextCursor,
          awaitingCertificate: Number(awaiting?.count ?? 0),
          calls: paged.rows.flatMap((row) => {
            const call = loaded.get(row.id);
            return call === undefined ? [] : [call];
          }),
        };
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/inspection-calls/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: InspectionCallSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [row] = await tx<{ work_id: string }[]>`
          select work_id from inspection_calls where id = ${id}
        `;
        if (!row) {
          throw httpError(404, 'INSPECTION_CALL_NOT_FOUND', 'No such inspection call.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return readCall(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/inspection-calls',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        body: CreateInspectionCallRequestSchema,
        response: { 201: InspectionCallSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const created = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ status: string; work_code: string }[]>`
          select status, work_code from works
          where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'raising an inspection call');
        if (body.requestedOn > (await todayOf(tx, organisationId))) {
          throw httpError(
            400,
            'INSPECTION_DATE_INVALID',
            'The request date cannot be in the future.',
          );
        }

        // Every item must be on this Work and mapped to the agency being
        // called. Calling RDSO for a RITES item would produce a
        // certificate the dispatch gate refuses to count, because the gate
        // matches the clause's agency.
        const itemIds = body.items.map((item) => item.workItemId);
        const mapped = await tx<
          { id: string; item_number: string; agency: InspectionClauseAgency | null }[]
        >`
          select wi.id, wi.item_number, c.agency
          from work_items wi
          left join inspection_clauses c on c.work_item_id = wi.id
          where wi.work_id = ${workId} and wi.deleted_at is null
            and wi.id = any(${itemIds}::uuid[])
        `;
        if (mapped.length !== new Set(itemIds).size) {
          throw httpError(
            404,
            'WORK_ITEM_NOT_FOUND',
            'One of the items on this call is not on the Work.',
          );
        }
        const mismatched = mapped
          .filter((item) => item.agency !== body.agency)
          .map((item) => item.item_number)
          .sort();
        if (mismatched.length > 0) {
          throw httpError(
            409,
            'INSPECTION_CLAUSE_INVALID',
            `These items are not mapped to ${body.agency} on this Work's inspection clause: ${mismatched.join(', ')}.`,
          );
        }

        // The house counter upsert (0001's challan counters). This claims
        // the number without locking the WORKS row, which used to serialise
        // every inspection call against every other writer of the Work —
        // an MB finalize, a challan issue, an amendment apply — for no
        // reason but a sequence.
        const [claimed] = await tx<{ sequence_number: number }[]>`
          insert into inspection_call_counters (organisation_id, work_id, next_value)
          values (${organisationId}, ${workId}, 2)
          on conflict (organisation_id, work_id) do update
          set next_value = inspection_call_counters.next_value + 1,
              updated_at = now()
          returning (next_value - 1) as sequence_number
        `;
        if (!claimed) throw new Error('inspection call counter returned no row');

        // THE PREMISES SNAPSHOT. The call is a record of a request that
        // went out, so the vendor's NAME and the ADDRESS TEXT are copied
        // here and the ids are kept only as provenance: renaming the
        // vendor or retiring the address afterwards must not rewrite what
        // the agency was sent (AGENTS.md rule 7).
        const premises = await resolvePremises(tx, body);
        // A named vendor with no premises text anywhere — no chosen
        // address, no typed free text — has nowhere to send the agency,
        // and the call's snapshot CHECK refuses the row as an unmapped
        // 23514. A clause may legitimately hold just the vendor; the CALL
        // is where the gap has to be closed, so it is refused here in a
        // sentence.
        if (
          premises.vendorContactId !== null &&
          premises.vendorAddress === null &&
          premises.vendorPremises === null
        ) {
          throw httpError(
            400,
            'INSPECTION_CLAUSE_INVALID',
            'This vendor has no premises for the call — pick one of its saved addresses or type the premises, then raise the call again.',
          );
        }
        const [call] = await tx<{ id: string }[]>`
          insert into inspection_calls (
            organisation_id, work_id, sequence_number, agency, requested_on,
            vendor_contact_id, vendor_address_id, vendor_name,
            vendor_premises, created_by_user_id
          )
          values (
            ${organisationId}, ${workId}, ${Number(claimed.sequence_number)},
            ${body.agency}, ${body.requestedOn},
            ${premises.vendorContactId}, ${premises.vendorAddressId},
            ${premises.vendorName},
            ${premises.vendorAddress ?? premises.vendorPremises}, ${user.id}
          )
          returning id
        `.catch(rethrowWriteRefusal);
        if (!call) throw new Error('inspection call insert returned no row');

        await tx`
          insert into inspection_call_items (
            organisation_id, inspection_call_id, work_id, work_item_id, quantity
          )
          select ${organisationId}, ${call.id}, ${workId}, item.work_item_id,
                 item.quantity
          from unnest(
            ${body.items.map((item) => item.workItemId)}::uuid[],
            ${body.items.map((item) => item.quantity)}::text[]::quantity_amount[]
          ) as item(work_item_id, quantity)
        `.catch(rethrowWriteRefusal);

        // THE CHECKLIST SNAPSHOT. Copied, not joined: the template is
        // configuration the operator keeps editing, and a call in progress
        // must stay held to the list it was raised under. The Work's own
        // list wins; with none, the organisation default applies, which is
        // what stops a newly created Work raising calls against nothing.
        await tx`
          insert into inspection_call_documents (
            organisation_id, inspection_call_id, kind, label, mandatory, position
          )
          select ${organisationId}, ${call.id}, 'evidence', label, mandatory,
                 position + 1
          from inspection_checklist_fields f
          where f.agency = ${body.agency}
            and f.work_id is not distinct from (
              select case when exists (
                select 1 from inspection_checklist_fields o
                where o.work_id = ${workId} and o.agency = ${body.agency}
              ) then ${workId}::uuid else null end
            )
        `;

        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.raised',
          'inspection_calls',
          call.id,
          { agency: body.agency, items: body.items.length },
        );
        return readCall(tx, organisationId, call.id);
      });
      return reply.status(201).send(created);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/inspection-calls/:id/call-letter',
      role: 'evidence',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: ReceiveCallLetterQuerySchema,
        response: { 200: InspectionCallSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const filename = requireTrimmed(request.query.filename, FILENAME_REFUSAL);
      const agencyCallNumber = requireTrimmed(
        request.query.agencyCallNumber,
        'Enter the number the agency put on its call letter.',
      );
      const { receivedOn } = request.query;
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the inspection call letter',
      });

      const LETTER_ONCE =
        'The inward call letter is recorded once, on a call that has been requested and not yet answered.';

      // Authorisation, field shape and state BEFORE the scan: an
      // unauthorised caller, a blank filename, or an upload against a call
      // that has already moved on must not spend scanner capacity. Same
      // ordering as the company document library and `routes/loa.ts`.
      await tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        assertCallStatus(call.status, 'requested', LETTER_ONCE);
        assertCallAdvanceable(call, 'recording an inspection call letter');
      });
      await assertNotMalware(scanner, bytes);
      const stored = await storePdfUpload(storage, organisationId, STORAGE_AREA, bytes);

      return tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        assertCallStatus(call.status, 'requested', LETTER_ONCE);
        assertCallAdvanceable(call, 'recording an inspection call letter');
        const [existing] = await tx<{ requested_on: string }[]>`
          select requested_on::text as requested_on from inspection_calls
          where id = ${id}
        `;
        if (existing && receivedOn < existing.requested_on) {
          throw httpError(
            400,
            'INSPECTION_DATE_INVALID',
            'The call letter cannot be dated before the request that asked for it.',
          );
        }
        await upsertSingularDocument(
          tx,
          organisationId,
          id,
          'call_letter',
          `Inward call letter ${agencyCallNumber}`,
          {
            objectKey: stored.objectKey,
            sha256: stored.sha256,
            filename,
            sizeBytes: bytes.length,
            userId: user.id,
          },
        );
        await tx`
          update inspection_calls
          set status = 'scheduled',
              agency_call_number = ${agencyCallNumber},
              call_letter_received_on = ${receivedOn}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.letter_received',
          'inspection_calls',
          id,
          { agencyCallNumber, receivedOn },
        );
        return readCall(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/inspection-call-documents/:id/file',
      role: 'evidence',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: UploadInspectionEvidenceQuerySchema,
        response: { 200: InspectionCallSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const filename = requireTrimmed(request.query.filename, FILENAME_REFUSAL);
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the inspection document',
      });

      const document = await tenant(async (tx) => loadOpenDocument(tx, user.id, id));
      await assertNotMalware(scanner, bytes);
      const stored = await storePdfUpload(storage, organisationId, STORAGE_AREA, bytes);

      return tenant(async (tx) => {
        const reloaded = await loadOpenDocument(tx, user.id, id);
        await attachFile(tx, id, {
          objectKey: stored.objectKey,
          sha256: stored.sha256,
          filename,
          sizeBytes: bytes.length,
          userId: user.id,
        });
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.document_attached',
          'inspection_calls',
          reloaded.callId,
          { label: document.label, sha256: stored.sha256 },
        );
        return readCall(tx, organisationId, reloaded.callId);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/inspection-calls/:id/certificate',
      role: 'evidence',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        querystring: UploadInspectionCertificateQuerySchema,
        response: { 200: InspectionCallSchema, ...upstreamErrorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const filename = requireTrimmed(request.query.filename, FILENAME_REFUSAL);
      const certificateNumber = requireTrimmed(
        request.query.certificateNumber,
        'Enter the number printed on the inspection certificate.',
      );
      const { certificateDate, validUntil } = request.query;
      const { bytes } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the inspection certificate',
      });
      if (validUntil !== undefined && validUntil < certificateDate) {
        throw httpError(
          400,
          'INSPECTION_DATE_INVALID',
          'The certificate cannot lapse before the day it was issued.',
        );
      }

      const CERTIFICATE_AFTER_LETTER =
        'Record the inward call letter before the certificate; a certificate answers an inspection that was actually called.';

      await tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        assertCallStatus(call.status, 'scheduled', CERTIFICATE_AFTER_LETTER);
        assertCallAdvanceable(call, 'recording an inspection certificate');
        // A certificate dated in the future is a typo, and it would make
        // the gate count a lot nobody has inspected yet. The bound is the
        // ORGANISATION's today, not UTC's.
        if (certificateDate > (await todayOf(tx, organisationId))) {
          throw httpError(
            400,
            'INSPECTION_DATE_INVALID',
            'The certificate date cannot be in the future.',
          );
        }
      });
      await assertNotMalware(scanner, bytes);
      const stored = await storePdfUpload(storage, organisationId, STORAGE_AREA, bytes);

      return tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        assertCallStatus(call.status, 'scheduled', CERTIFICATE_AFTER_LETTER);
        assertCallAdvanceable(call, 'recording an inspection certificate');
        await upsertSingularDocument(
          tx,
          organisationId,
          id,
          'certificate',
          `Inspection certificate ${certificateNumber}`,
          {
            objectKey: stored.objectKey,
            sha256: stored.sha256,
            filename,
            sizeBytes: bytes.length,
            userId: user.id,
          },
        );
        // The certificate IS the result. An agency that accepted the
        // material says so by issuing one, so there is no second field
        // recording the same fact and no way for the two to disagree.
        await tx`
          update inspection_calls
          set certificate_number = ${certificateNumber},
              certificate_date = ${certificateDate},
              certificate_valid_until = ${validUntil ?? null}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.certificate_recorded',
          'inspection_calls',
          id,
          {
            certificateNumber,
            certificateDate,
            validUntil: validUntil ?? null,
            sha256: stored.sha256,
          },
        );
        return readCall(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/inspection-calls/:id/close',
      role: 'writer',
      schema: {
        params: IdParamsSchema,
        response: { 200: InspectionCallSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        assertCallStatus(
          call.status,
          'scheduled',
          'A call closes once the inward letter has been recorded against it.',
        );
        assertCallAdvanceable(call, 'closing an inspection call');

        // The close gate, said in a sentence naming what is missing. The
        // 0082 transition trigger enforces the same conditions, but it can
        // only refuse — this is where the operator learns which paper to
        // fetch.
        const outstanding = await tx<{ label: string }[]>`
          select label from inspection_call_documents
          where inspection_call_id = ${id} and mandatory and object_key is null
          order by position, label
        `;
        const [certificate] = await tx<{ id: string }[]>`
          select id from inspection_call_documents
          where inspection_call_id = ${id} and kind = 'certificate'
            and object_key is not null
        `;
        const missing = [
          ...outstanding.map((row) => row.label),
          ...(certificate ? [] : ['the inspection certificate']),
        ];
        if (missing.length > 0) {
          throw httpError(
            409,
            'INSPECTION_CALL_INCOMPLETE',
            `This call cannot close while these are outstanding: ${missing.join(', ')}.`,
          );
        }

        await tx`
          update inspection_calls
          set status = 'closed', closed_at = now(), closed_by_user_id = ${user.id}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.closed',
          'inspection_calls',
          id,
          {},
        );
        return readCall(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/inspection-calls/:id/cancel',
      role: 'writer',
      authority: 'cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelInspectionCallRequestSchema,
        response: { 200: InspectionCallSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const reason = requireTrimmed(
        request.body.reason,
        'State why the inspection call is being withdrawn.',
      );
      return tenant(async (tx) => {
        const call = await loadCallForUpdate(tx, user.id, id);
        // A CLOSED call is cancellable here, and that is the interlock's
        // release valve rather than an oversight. An agency does withdraw
        // a certificate; when it does, the items it covered must stop
        // being despatchable at once, and because the gate reads
        // `status = 'closed'` the withdrawal needs no second mechanism.
        //
        // No `assertWorkOperable`: a certificate can be revoked after the
        // Work's own paperwork has closed, and refusing the withdrawal
        // would leave the gate believing a certificate that no longer
        // exists.
        if (call.status === 'cancelled') {
          throw httpError(
            409,
            'INSPECTION_CALL_CLOSED',
            'This inspection call is already cancelled.',
          );
        }
        // What went out under it, recorded in the audit trail at the
        // moment of withdrawal — because that is when somebody has to
        // decide which despatches to chase, and the advisory match gets
        // harder to reconstruct as more challans are issued.
        const affected = await readCall(tx, organisationId, id);
        await tx`
          update inspection_calls
          set status = 'cancelled', cancelled_at = now(),
              cancelled_by_user_id = ${user.id}, cancellation_reason = ${reason}
          where id = ${id}
        `.catch(rethrowWriteRefusal);
        await audit(
          tx,
          organisationId,
          user.id,
          'inspection_call.cancelled',
          'inspection_calls',
          id,
          {
            reason,
            advisoryIssuedChallans: affected.advisoryIssuedChallans.map((challan) => ({
              challanNumber: challan.challanNumber,
              challanDate: challan.challanDate,
              itemNumber: challan.itemNumber,
              quantity: challan.quantity,
            })),
          },
        );
        return readCall(tx, organisationId, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      // Addressed by the document's own id, the shape
      // `/api/company-document-versions/:id/file` already uses.
      url: '/api/inspection-call-documents/:id/file',
      schema: {
        params: IdParamsSchema,
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const document = await tenant(async (tx) => {
        const [row] = await tx<
          {
            object_key: string | null;
            original_filename: string | null;
            work_id: string;
          }[]
        >`
          select d.object_key, d.original_filename, ic.work_id
          from inspection_call_documents d
          join inspection_calls ic on ic.id = d.inspection_call_id
          where d.id = ${id}
        `;
        if (!row || row.object_key === null) {
          throw httpError(
            404,
            'INSPECTION_DOCUMENT_NOT_FOUND',
            'No such inspection document, or nothing has been uploaded against it yet.',
          );
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        return {
          objectKey: row.object_key,
          filename: row.original_filename ?? 'document.pdf',
        };
      });
      const bytes = await storage.get(document.objectKey);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
      );
      return reply.send(bytes);
    },
  );
}

// --- Shared reads -----------------------------------------------------------

/** The organisation's own date, so a "not in the future" check means the
 * operator's today rather than the server's UTC day. The same function the
 * dispatch gate's liveness comparison uses (migration 0082), so a
 * certificate accepted today cannot be one the gate treats as tomorrow's. */
async function todayOf(tx: TransactionSql, organisationId: string): Promise<string> {
  const [row] = await tx<{ today: string }[]>`
    select app_private.organisation_today(${organisationId})::text as today
  `;
  return row?.today ?? '9999-12-31';
}

function normaliseText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Where an inspection is held, as the caller stated it (migration 0116). */
interface PremisesInput {
  readonly vendorContactId?: string | null;
  readonly vendorAddressId?: string | null;
  readonly vendorPremises: string | null;
}

/** The same, proved against the masters and ready to store. */
interface ResolvedPremises {
  readonly vendorContactId: string | null;
  readonly vendorAddressId: string | null;
  /** The vendor's designation as it reads NOW. The clause discards it
   * (configuration joins live); the call snapshots it. */
  readonly vendorName: string | null;
  /** The chosen master address, or the typed free text. Never both — the
   * 0116 CHECKs refuse the pair on the clause, and the call's snapshot
   * CHECK refuses a vendor with no text at all. */
  readonly vendorAddress: string | null;
  readonly vendorPremises: string | null;
}

/**
 * Proves an inspection premises against the contacts master.
 *
 * Three refusals, all of them things the database also refuses — the
 * route says them first so the operator reads a sentence rather than a
 * constraint name, and the database says them again so a writer arriving
 * another way, or a role revoked between the check and the write, cannot
 * slip past (`23Y01` and the composite foreign key).
 */
async function resolvePremises(
  tx: TransactionSql,
  input: PremisesInput,
): Promise<ResolvedPremises> {
  const contactId = input.vendorContactId ?? null;
  const addressId = input.vendorAddressId ?? null;
  const free = normaliseText(input.vendorPremises);

  if (contactId === null) {
    if (addressId !== null) {
      throw httpError(
        400,
        'CONTACT_ADDRESS_INVALID',
        'Name the vendor whose address this is, or clear the address.',
      );
    }
    return {
      vendorContactId: null,
      vendorAddressId: null,
      vendorName: null,
      vendorAddress: null,
      vendorPremises: free,
    };
  }

  const [vendor] = await tx<
    { designation: string; is_vendor: boolean; active: boolean }[]
  >`
    select designation, is_vendor, active from contacts where id = ${contactId}
  `;
  if (!vendor) throw httpError(404, 'CONTACT_NOT_FOUND', 'No such contact.');
  if (!vendor.is_vendor) {
    throw httpError(
      409,
      'INSPECTION_VENDOR_INVALID',
      'Inspections are held at a vendor’s premises — give this contact the vendor role, or pick another.',
    );
  }
  if (!vendor.active) {
    throw httpError(
      409,
      'CONTACT_RETIRED',
      'This vendor is retired — reactivate it or pick another.',
    );
  }

  if (addressId === null) {
    // A named vendor with no address chosen still needs somewhere to send
    // the agency, and free text beside a master vendor is exactly what
    // 0082's sub-vendor case looks like.
    return {
      vendorContactId: contactId,
      vendorAddressId: null,
      vendorName: vendor.designation,
      vendorAddress: null,
      vendorPremises: free,
    };
  }
  if (free !== null) {
    throw httpError(
      400,
      'CONTACT_ADDRESS_INVALID',
      'Choose a saved address or type the premises, not both.',
    );
  }

  const [address] = await tx<{ address: string; active: boolean }[]>`
    select address, active from contact_addresses
    where id = ${addressId} and contact_id = ${contactId}
  `;
  if (!address) {
    throw httpError(
      404,
      'CONTACT_ADDRESS_NOT_FOUND',
      'No such address on this vendor.',
    );
  }
  if (!address.active) {
    throw httpError(
      409,
      'CONTACT_ADDRESS_RETIRED',
      'That address is retired — reactivate it or pick another.',
    );
  }
  return {
    vendorContactId: contactId,
    vendorAddressId: addressId,
    vendorName: vendor.designation,
    vendorAddress: address.address,
    vendorPremises: null,
  };
}

/** An evidence row on a call that is still open, with the caller's reach
 * over its Work proven. The parent call is locked, not merely read: the
 * upload and a concurrent close must not both believe the checklist was
 * complete. */
async function loadOpenDocument(
  tx: TransactionSql,
  userId: string,
  documentId: string,
): Promise<{ callId: string; label: string }> {
  const [row] = await tx<
    { inspection_call_id: string; label: string; kind: InspectionDocumentKind }[]
  >`
    select d.inspection_call_id, d.label, d.kind
    from inspection_call_documents d
    where d.id = ${documentId}
  `;
  if (!row) {
    throw httpError(
      404,
      'INSPECTION_DOCUMENT_NOT_FOUND',
      'No such inspection document.',
    );
  }
  const call = await loadCallForUpdate(tx, userId, row.inspection_call_id);
  assertCallOpen(call.status, 'attaching a document');
  assertCallAdvanceable(call, 'attaching an inspection document');
  // The inward letter and the certificate carry facts beyond their bytes —
  // the agency's number, the certificate's validity window — so they are
  // replaced through their own routes, which record those facts too.
  if (row.kind !== 'evidence') {
    throw httpError(
      409,
      'INSPECTION_CALL_STATE_INVALID',
      'Replace the call letter or the certificate through its own action, so its number and dates are recorded with it.',
    );
  }
  return { callId: row.inspection_call_id, label: row.label };
}

async function readWorkConfig(tx: TransactionSql, workId: string) {
  const items = await tx<
    {
      work_item_id: string;
      item_number: string;
      description: string;
      unit_code: string;
      awarded_quantity: string;
      manufactured_quantity: string;
      agency: InspectionClauseAgency | null;
      inspection_quantity: string | null;
      vendor_contact_id: string | null;
      vendor_name: string | null;
      vendor_address_id: string | null;
      vendor_address: string | null;
      vendor_premises: string | null;
      gates_dispatch: boolean;
    }[]
  >`
    select wi.id as work_item_id, wi.item_number,
           coalesce(wi.effective_description, wi.description) as description,
           coalesce(wi.effective_unit, wi.unit_code) as unit_code,
           coalesce(wi.effective_quantity, wi.awarded_quantity)::text as awarded_quantity,
           -- What the OEM has actually produced is not a fact this product
           -- holds; delivered quantity is the closest honest proxy, and it
           -- is what the mapping screen's "OEM manufactured" column reads.
           coalesce(sum(dci.quantity) filter (where dc.status = 'issued'), 0)::text
             as manufactured_quantity,
           c.agency,
           c.inspection_quantity::text as inspection_quantity,
           -- Joined LIVE, not snapshotted: a clause is configuration, so
           -- an address corrected in the master should reach the next
           -- call raised under it. The call is where the copy happens.
           c.vendor_contact_id, v.designation as vendor_name,
           c.vendor_address_id, va.address as vendor_address,
           c.vendor_premises,
           coalesce(c.gates_dispatch, false) as gates_dispatch
    from work_items wi
    left join inspection_clauses c on c.work_item_id = wi.id
    left join contacts v on v.id = c.vendor_contact_id
    left join contact_addresses va on va.id = c.vendor_address_id
    left join delivery_challan_items dci on dci.work_item_id = wi.id
    left join delivery_challans dc on dc.id = dci.delivery_challan_id
    where wi.work_id = ${workId} and wi.deleted_at is null
    group by wi.id, c.agency, c.inspection_quantity, c.vendor_contact_id,
             v.designation, c.vendor_address_id, va.address,
             c.vendor_premises, c.gates_dispatch
    order by wi.item_number
  `;
  // Both scopes in one read: the Work's own rows where it has them, and
  // the organisation default where it does not. `inherited` is what the
  // screen needs to say whether editing creates an override.
  const fields = await tx<
    {
      agency: InspectionAgency;
      label: string;
      mandatory: boolean;
      is_default: boolean;
    }[]
  >`
    select agency, label, mandatory, (work_id is null) as is_default
    from inspection_checklist_fields
    where work_id is null or work_id = ${workId}
    order by agency, position, label
  `;
  const checklists = {
    RDSO: checklistFor(fields, 'RDSO'),
    RITES: checklistFor(fields, 'RITES'),
  };
  return {
    items: byItemNumber(
      items.map((row) => ({
        workItemId: row.work_item_id,
        itemNumber: row.item_number,
        description: row.description,
        unitCode: row.unit_code,
        awardedQuantity: row.awarded_quantity,
        manufacturedQuantity: row.manufactured_quantity,
        agency: row.agency,
        inspectionQuantity: row.inspection_quantity,
        vendorContactId: row.vendor_contact_id,
        vendorName: row.vendor_name,
        vendorAddressId: row.vendor_address_id,
        vendorAddress: row.vendor_address,
        vendorPremises: row.vendor_premises,
        gatesDispatch: row.gates_dispatch,
      })),
    ),
    checklists,
  };
}

/** The Work's own list if it has one, otherwise the organisation default —
 * the same precedence the call's checklist snapshot applies, written once
 * so the screen and the snapshot cannot disagree about which list is in
 * force. */
function checklistFor(
  rows: readonly {
    agency: InspectionAgency;
    label: string;
    mandatory: boolean;
    is_default: boolean;
  }[],
  agency: InspectionAgency,
): { inherited: boolean; fields: InspectionChecklistField[] } {
  const forAgency = rows.filter((row) => row.agency === agency);
  const own = forAgency.filter((row) => !row.is_default);
  const source = own.length > 0 ? own : forAgency.filter((row) => row.is_default);
  return {
    inherited: own.length === 0,
    fields: source.map((row) => ({ label: row.label, mandatory: row.mandatory })),
  };
}
