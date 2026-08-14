import { createHash } from 'node:crypto';
import {
  BackfillExtensionRequestSchema,
  BackfillExtensionResponseSchema,
  ExtensionRequestDetailResponseSchema,
  RespondExtensionRequestSchema,
  SaveExtensionRequestSchema,
  SetCompletionDateRequestSchema,
  WorkCompletionResponseSchema,
  type ExtensionRequest,
  type ExtensionRequestDetailResponse,
  type WorkCompletionResponse,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { isApprover } from './amendments.js';
import { draftConflictError } from '../draft-conflict.js';
import {
  EXTENSION_TEMPLATE_VERSION,
  MANUAL_TEMPLATE_VERSION,
  renderExtensionHtml,
  type ExtensionSnapshot,
} from '../extension-html.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import {
  assertNotMalware,
  consumeUpload,
  MAX_PDF_UPLOAD_BYTES,
} from '../upload-guards.js';
import type { ObjectStorage } from '@auto-mb/documents';
import { assertWorkOperable } from '../work-status.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(
      Type.Union([Type.Literal('rendered'), Type.Literal('response')]),
    ),
  },
  { additionalProperties: false },
);

interface ExtensionRow {
  id: string;
  work_id: string;
  status: ExtensionRequest['status'];
  source: ExtensionRequest['source'];
  proposed_completion_date: string;
  reason: string;
  addressee: string;
  letter_date: string | null;
  sequence_number: number | null;
  request_number: string | null;
  manual_reference: string | null;
  template_version: string | null;
  rendered_object_key: string | null;
  response_object_key: string | null;
  response_outcome: ExtensionRequest['responseOutcome'];
  granted_completion_date: string | null;
  created_at: Date;
  finalised_at: Date | null;
  responded_at: Date | null;
}

const EXTENSION_COLUMNS = `
  id, work_id, status, source,
  proposed_completion_date::text as proposed_completion_date,
  reason, addressee, letter_date::text as letter_date, sequence_number,
  request_number, manual_reference, template_version, rendered_object_key,
  response_object_key,
  response_outcome, granted_completion_date::text as granted_completion_date,
  created_at, finalised_at, responded_at
`;

function toExtensionRequest(row: ExtensionRow): ExtensionRequest {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    source: row.source,
    proposedCompletionDate: row.proposed_completion_date,
    reason: row.reason,
    addressee: row.addressee,
    letterDate: row.letter_date,
    sequenceNumber: row.sequence_number,
    requestNumber: row.request_number,
    manualReference: row.manual_reference,
    templateVersion: row.template_version,
    renderedAvailable: row.rendered_object_key !== null,
    responseDocumentAvailable: row.response_object_key !== null,
    responseOutcome: row.response_outcome,
    grantedCompletionDate: row.granted_completion_date,
    createdAt: row.created_at.toISOString(),
    finalisedAt: row.finalised_at?.toISOString() ?? null,
    respondedAt: row.responded_at?.toISOString() ?? null,
  };
}

async function readDetail(
  tx: TransactionSql,
  extensionId: string,
): Promise<ExtensionRequestDetailResponse> {
  const [row] = await tx<(ExtensionRow & { finalised_snapshot: unknown })[]>`
    select ${tx.unsafe(EXTENSION_COLUMNS)}, finalised_snapshot
    from extension_requests where id = ${extensionId}
  `;
  if (!row) throw httpError(404, 'EXTENSION_NOT_FOUND', 'No such extension request.');
  return {
    extensionRequest: toExtensionRequest(row),
    finalisedSnapshot: parseJsonbColumn(row.finalised_snapshot),
  };
}

async function readCompletion(
  tx: TransactionSql,
  workId: string,
): Promise<WorkCompletionResponse> {
  const [work] = await tx<
    {
      original_completion_date: string | null;
      current_completion_date: string | null;
    }[]
  >`
    select original_completion_date::text as original_completion_date,
           current_completion_date::text as current_completion_date
    from works where id = ${workId} and deleted_at is null
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  const rows = await tx<ExtensionRow[]>`
    select ${tx.unsafe(EXTENSION_COLUMNS)}
    from extension_requests
    where work_id = ${workId}
    order by created_at desc, id
  `;
  return {
    completion: {
      originalCompletionDate: work.original_completion_date,
      currentCompletionDate: work.current_completion_date,
    },
    extensionRequests: rows.map(toExtensionRequest),
  };
}

/** Locks the extension request row for the rest of the transaction and
 * returns it; every state transition starts here so concurrent requests
 * serialise (same discipline as the challan routes). */
async function lockExtension(
  tx: TransactionSql,
  extensionId: string,
): Promise<ExtensionRow> {
  const [row] = await tx<ExtensionRow[]>`
    select ${tx.unsafe(EXTENSION_COLUMNS)}
    from extension_requests where id = ${extensionId}
    for update
  `;
  if (!row) throw httpError(404, 'EXTENSION_NOT_FOUND', 'No such extension request.');
  return row;
}

function requireStatus(
  row: ExtensionRow,
  statuses: readonly ExtensionRequest['status'][],
): void {
  if (!statuses.includes(row.status)) {
    throw httpError(
      409,
      'EXTENSION_STATUS_CONFLICT',
      `This operation requires a ${statuses.join(' or ')} extension request (current status: ${row.status}).`,
    );
  }
}

interface WorkCompletionRow {
  work_code: string;
  title: string;
  letter_number: string;
  letter_date: string;
  status: string;
  original_completion_date: string | null;
  current_completion_date: string | null;
}

/** Locks the works row so completion-date reads and writes serialise
 * against concurrent finalise/respond transactions. */
async function lockWork(
  tx: TransactionSql,
  workId: string,
): Promise<WorkCompletionRow> {
  const [work] = await tx<WorkCompletionRow[]>`
    select work_code, title, letter_number, letter_date::text as letter_date,
           status,
           original_completion_date::text as original_completion_date,
           current_completion_date::text as current_completion_date
    from works where id = ${workId} and deleted_at is null
    for update
  `;
  if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  return work;
}

/** Product contract: the letter date is never in the future ("today" in
 * the organisation's own timezone) and never precedes the Work's LOA
 * letter date — the same window the challan date obeys. */
async function assertLetterDate(
  tx: TransactionSql,
  workId: string,
  letterDate: string,
): Promise<void> {
  const [bounds] = await tx<{ letter_date: string; today: string }[]>`
    select w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId}
  `;
  if (!bounds) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  if (letterDate > bounds.today) {
    throw httpError(
      400,
      'LETTER_DATE_INVALID',
      `The letter date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (letterDate < bounds.letter_date) {
    throw httpError(
      400,
      'LETTER_DATE_INVALID',
      `The letter date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

/** The proposed date must extend the Work's current completion date; a
 * Work without a completion date cannot ask for an extension. The DB
 * trigger re-proves both at insert and at finalise. */
function assertProposedExtends(
  work: WorkCompletionRow,
  proposedCompletionDate: string,
): void {
  if (work.current_completion_date === null) {
    throw httpError(
      409,
      'COMPLETION_NOT_SET',
      'Set the Work completion date before requesting an extension.',
    );
  }
  // ISO dates compare correctly as strings.
  if (proposedCompletionDate <= work.current_completion_date) {
    throw httpError(
      400,
      'EXTENSION_DATE_INVALID',
      `The proposed completion date must be after the current completion date (${work.current_completion_date}).`,
    );
  }
}

export function registerExtensionRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  // --- Completion dates -----------------------------------------------------
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/completion',
      schema: {
        params: IdParamsSchema,
        response: { 200: WorkCompletionResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        return readCompletion(tx, workId);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/works/:id/completion-dates',
      schema: {
        params: IdParamsSchema,
        body: SetCompletionDateRequestSchema,
        response: { 200: WorkCompletionResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        if (work.current_completion_date !== null) {
          throw httpError(
            409,
            'COMPLETION_ALREADY_SET',
            'The completion date is already set; it changes only through a responded extension request.',
          );
        }
        // ISO dates compare correctly as strings.
        if (body.completionDate < work.letter_date) {
          throw httpError(
            400,
            'COMPLETION_DATE_INVALID',
            `The completion date cannot precede the LOA letter date (${work.letter_date}).`,
          );
        }
        // The one-time set: original and current start equal; the works
        // trigger blocks every later free-form edit.
        await tx`
          update works
          set original_completion_date = ${body.completionDate},
              current_completion_date = ${body.completionDate}
          where id = ${workId}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'work.completion_date_set',
          'works',
          workId,
          { completionDate: body.completionDate },
        );
        return readCompletion(tx, workId);
      });
    },
  );

  // --- Extension request lifecycle -------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/extension-requests',
      schema: {
        params: IdParamsSchema,
        body: SaveExtensionRequestSchema,
        response: { 201: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const detail = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        // R8: a completed Work accepts no new operational documents.
        // lockWork holds the works row, so this serialises against
        // completion; the 0031 insert guard is the database backstop.
        assertWorkOperable(work.status, 'raising an extension request');
        assertProposedExtends(work, body.proposedCompletionDate);
        if (body.letterDate !== undefined) {
          await assertLetterDate(tx, workId, body.letterDate);
        }
        // One draft per Work: the partial unique index is the proof;
        // this lookup (under the work row lock, which serialises
        // concurrent creates) surfaces the existing draft's id in the
        // 409 for the client to open.
        const [existing] = await tx<{ id: string }[]>`
            select id from extension_requests
            where work_id = ${workId} and status = 'draft'
          `;
        if (existing) {
          throw draftConflictError(
            'EXTENSION_DRAFT_EXISTS',
            'This Work already has a draft extension request; finalise or delete it first.',
            existing.id,
          );
        }
        const [created] = await tx<{ id: string }[]>`
            insert into extension_requests (
              organisation_id, work_id, proposed_completion_date, reason,
              addressee, letter_date, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.proposedCompletionDate},
              ${body.reason}, ${body.addressee}, ${body.letterDate ?? null},
              ${user.id}
            )
            returning id
          `;
        if (!created) throw new Error('extension insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.created',
          'extension_requests',
          created.id,
          { workId, proposedCompletionDate: body.proposedCompletionDate },
        );
        return readDetail(tx, created.id);
      });
      return reply.status(201).send(detail);
    },
  );

  // Manual back-fill (§5.5): a paper letter issued before the software
  // was adopted enters the register as a FINALISED record on arrival — it
  // takes the paper reference and letter date, transcribes the letter's
  // content, and occupies the NEXT sequence slot under the same counter
  // row lock as a software finalisation, so numbering stays gapless and
  // serialised. It never touches the one-draft slot: a draft for the NEXT
  // letter may exist alongside. Back-fill letters in paper order — each
  // proposed date must extend the then-current completion date, exactly
  // as it did on paper.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/extension-requests/backfill',
      schema: {
        params: IdParamsSchema,
        body: BackfillExtensionRequestSchema,
        response: { 201: BackfillExtensionResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const result = await tenant(async (tx) => {
        // Consuming a number slot is the same act of authority as
        // finalising — the issue authority gates both.
        await assertWorkAccess(tx, user.id, workId);
        const work = await lockWork(tx, workId);
        // R8: a completed Work accepts no new operational documents —
        // a back-filled paper letter consumes a number slot like any
        // other finalisation.
        assertWorkOperable(work.status, 'back-filling an extension letter');
        assertProposedExtends(work, body.proposedCompletionDate);
        await assertLetterDate(tx, workId, body.letterDate);
        if (work.original_completion_date === null) {
          throw new Error('completion dates disappeared under the work row lock');
        }

        // §5.5: warn — without blocking — when the paper letter is
        // dated after the first software-generated letter (a letter
        // from the software era should itself have been generated).
        const warnings: string[] = [];
        const [firstSoftware] = await tx<{ letter_date: string }[]>`
            select min(letter_date)::text as letter_date
            from extension_requests
            where work_id = ${workId} and source = 'software'
              and status <> 'draft' and letter_date is not null
            having min(letter_date) is not null
          `;
        if (
          firstSoftware !== undefined &&
          body.letterDate > firstSoftware.letter_date
        ) {
          warnings.push(
            `This letter is dated ${body.letterDate}, after the first software-generated letter (${firstSoftware.letter_date}); check that it really was issued on paper.`,
          );
        }

        const [counter] = await tx<{ next_value: number }[]>`
            insert into extension_request_counters (organisation_id, work_id)
            values (${organisationId}, ${workId})
            on conflict (organisation_id, work_id)
            do update set next_value = extension_request_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('extension counter upsert returned no row');
        const sequence = counter.next_value;
        const requestNumber = `${work.work_code}-Extension-${String(sequence).padStart(2, '0')}`;

        const [organisation] = await tx<{ name: string }[]>`
            select name from organisations
            where id = app_private.current_organisation_id()
          `;
        const finalisedAt = new Date().toISOString();
        // The snapshot preserves what was transcribed; the PAPER letter
        // remains the legal document (manual records are never
        // rendered), so the template version marks the record as a
        // transcription, not a generated letter.
        const snapshot: ExtensionSnapshot = {
          templateVersion: MANUAL_TEMPLATE_VERSION,
          organisationName: organisation?.name ?? '',
          requestNumber,
          manualReference: body.reference,
          letterDate: body.letterDate,
          addressee: body.addressee,
          reason: body.reason,
          work: {
            workCode: work.work_code,
            title: work.title,
            letterNumber: work.letter_number,
            letterDate: work.letter_date,
          },
          originalCompletionDate: work.original_completion_date,
          currentCompletionDate: work.current_completion_date ?? '',
          proposedCompletionDate: body.proposedCompletionDate,
          finalisedAt,
        };

        const [created] = await tx<{ id: string }[]>`
            insert into extension_requests (
              organisation_id, work_id, status, source, manual_reference,
              proposed_completion_date, reason, addressee, letter_date,
              sequence_number, request_number, finalised_snapshot,
              template_version, created_by_user_id, finalised_by_user_id,
              finalised_at
            )
            values (
              ${organisationId}, ${workId}, 'finalised', 'manual',
              ${body.reference}, ${body.proposedCompletionDate}, ${body.reason},
              ${body.addressee}, ${body.letterDate}, ${sequence},
              ${requestNumber}, ${jsonb(tx, snapshot)},
              ${MANUAL_TEMPLATE_VERSION}, ${user.id}, ${user.id}, ${finalisedAt}
            )
            returning id
          `;
        if (!created) throw new Error('extension back-fill insert returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.manual_backfilled',
          'extension_requests',
          created.id,
          {
            workId,
            requestNumber,
            sequence,
            manualReference: body.reference,
            letterDate: body.letterDate,
            proposedCompletionDate: body.proposedCompletionDate,
            warnings,
          },
        );
        const detail = await readDetail(tx, created.id);
        return { ...detail, warnings };
      });
      return reply.status(201).send(result);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/extension-requests/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from extension_requests where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'EXTENSION_NOT_FOUND', 'No such extension request.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/extension-requests/:id',
      schema: {
        params: IdParamsSchema,
        body: SaveExtensionRequestSchema,
        response: { 200: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['draft']);
        const work = await lockWork(tx, extension.work_id);
        assertProposedExtends(work, body.proposedCompletionDate);
        if (body.letterDate !== undefined) {
          await assertLetterDate(tx, extension.work_id, body.letterDate);
        }
        await tx`
          update extension_requests
          set proposed_completion_date = ${body.proposedCompletionDate},
              reason = ${body.reason}, addressee = ${body.addressee},
              letter_date = ${body.letterDate ?? null}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.updated',
          'extension_requests',
          id,
          { proposedCompletionDate: body.proposedCompletionDate },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/extension-requests/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        if (extension.source === 'manual' && extension.status !== 'draft') {
          // §5.5: a manual back-fill is deletable, but only by an
          // amendment-approval holder, only while it is the TOP of the
          // sequence (numbers never gain gaps — the 0029 trigger both
          // enforces this under the counter row lock and rolls the
          // counter back so the slot is reused), and only before a
          // response is recorded (a responded record anchors the
          // completion-date ledger). Software-generated finalised letters
          // have no delete path at all.
          if (!(await isApprover(tx, user.id))) {
            throw httpError(
              403,
              'AUTHORITY_REQUIRED',
              'Deleting a manual back-fill requires the amendment-approval authority.',
            );
          }
          if (extension.status !== 'finalised') {
            throw httpError(
              409,
              'EXTENSION_STATUS_CONFLICT',
              'A responded manual back-fill anchors the completion-date record and cannot be deleted.',
            );
          }
          const [top] = await tx<{ id: string }[]>`
            select id from extension_requests
            where work_id = ${extension.work_id} and sequence_number is not null
            order by sequence_number desc
            limit 1
          `;
          if (top?.id !== id) {
            throw httpError(
              409,
              'EXTENSION_NOT_TOP_OF_SEQUENCE',
              'Only the newest extension letter may be deleted — the sequence never gains gaps.',
            );
          }
          await tx`delete from extension_requests where id = ${id}`;
          await audit(
            tx,
            organisationId,
            user.id,
            'extension.manual_backfill_deleted',
            'extension_requests',
            id,
            {
              workId: extension.work_id,
              requestNumber: extension.request_number,
              sequence: extension.sequence_number,
              manualReference: extension.manual_reference,
            },
          );
          return;
        }
        requireStatus(extension, ['draft']);
        await tx`delete from extension_requests where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.deleted',
          'extension_requests',
          id,
          { workId: extension.work_id },
        );
      });
      return reply.status(204).send(null);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/extension-requests/:id/finalise',
      schema: {
        params: IdParamsSchema,
        response: { 201: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        // Finalising assigns a legal number — the same authority
        // discipline as issuing a challan or preparing a bill.
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['draft']);
        const work = await lockWork(tx, extension.work_id);
        // Revalidate at finalise: the current completion date may have
        // moved since the draft was written.
        assertProposedExtends(work, extension.proposed_completion_date);
        if (extension.letter_date === null) {
          throw httpError(
            400,
            'LETTER_DATE_REQUIRED',
            'Set the letter date on the draft before finalising.',
          );
        }
        if (work.original_completion_date === null) {
          throw new Error('completion dates disappeared under the work row lock');
        }

        // Serialised per-Work numbering: the counter row lock orders
        // concurrent finalisations; a rolled-back transaction rolls the
        // counter back with it, so numbers are gapless per Work.
        const [counter] = await tx<{ next_value: number }[]>`
            insert into extension_request_counters (organisation_id, work_id)
            values (${organisationId}, ${extension.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = extension_request_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
        if (!counter) throw new Error('extension counter upsert returned no row');
        const sequence = counter.next_value;
        const requestNumber = `${work.work_code}-Extension-${String(sequence).padStart(2, '0')}`;

        const [organisation] = await tx<{ name: string }[]>`
            select name from organisations
            where id = app_private.current_organisation_id()
          `;
        const finalisedAt = new Date().toISOString();
        const snapshot: ExtensionSnapshot = {
          templateVersion: EXTENSION_TEMPLATE_VERSION,
          organisationName: organisation?.name ?? '',
          requestNumber,
          letterDate: extension.letter_date,
          addressee: extension.addressee,
          reason: extension.reason,
          work: {
            workCode: work.work_code,
            title: work.title,
            letterNumber: work.letter_number,
            letterDate: work.letter_date,
          },
          originalCompletionDate: work.original_completion_date,
          currentCompletionDate: work.current_completion_date ?? '',
          proposedCompletionDate: extension.proposed_completion_date,
          finalisedAt,
        };

        await tx`
            update extension_requests
            set status = 'finalised', sequence_number = ${sequence},
                request_number = ${requestNumber},
                finalised_snapshot = ${jsonb(tx, snapshot)},
                template_version = ${EXTENSION_TEMPLATE_VERSION},
                finalised_by_user_id = ${user.id}, finalised_at = ${finalisedAt}
            where id = ${id}
          `;
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.finalised',
          'extension_requests',
          id,
          {
            requestNumber,
            sequence,
            proposedCompletionDate: extension.proposed_completion_date,
          },
        );
        return readDetail(tx, id);
      });
      return reply.status(201).send(detail);
    },
  );

  // --- The letter PDF ---------------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/extension-requests/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // Snapshot read and PDF write live in separate transactions so the
      // slow external call holds no database locks; the legal content is
      // the immutable finalised snapshot, so re-rendering reproduces the
      // letter. Branding is presentation from the current profile.
      const { snapshot, branding } = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['finalised', 'responded']);
        if (extension.source === 'manual') {
          // The PAPER letter is the legal record of a back-fill; a
          // generated look-alike could be mistaken for the original.
          throw httpError(
            409,
            'EXTENSION_MANUAL_NOT_RENDERABLE',
            'Manual back-fill records are transcriptions of paper letters and are never rendered; the paper letter is the record.',
          );
        }
        const [row] = await tx<{ finalised_snapshot: unknown }[]>`
            select finalised_snapshot from extension_requests where id = ${id}
          `;
        const [organisation] = await tx<
          {
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
            select address, gstin, contact_phone, contact_email,
                   logo_object_key, logo_media_type
            from organisations
            where id = app_private.current_organisation_id()
          `;
        return {
          snapshot: parseJsonbColumn(row?.finalised_snapshot) as ExtensionSnapshot,
          branding: organisation ?? null,
        };
      });

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo object must not block a finalised letter.
          request.log.warn({ err: error }, 'extension render: logo unavailable');
        }
      }
      const html = renderExtensionHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the finalised request is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'extension render failed');
        },
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/ext/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return tenant(async (tx) => {
        const updated = await tx`
          update extension_requests
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status in ('finalised', 'responded')
        `;
        if (updated.count === 0) {
          // The request stopped being finalised while Gotenberg rendered;
          // the stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'EXTENSION_STATUS_CONFLICT',
            'The extension request is no longer finalised; the render was discarded.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.rendered',
          'extension_requests',
          id,
          { sha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  // Draft preview (§5.5: "Draft PDF watermarked DRAFT"). The preview
  // renders the LIVE draft with a diagonal DRAFT watermark and no number
  // — numbers exist only from finalisation — and is streamed straight
  // back, never stored: the 0011 checks rightly forbid render state on a
  // draft, and a draft has no immutable snapshot to store evidence
  // against. Any member with access to the Work may preview (the same
  // audience the stored-PDF GET serves).
  tenantRoute(
    {
      method: 'GET',
      url: '/api/extension-requests/:id/draft-preview',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { snapshot, branding } = await tenant(async (tx) => {
        const [extension] = await tx<ExtensionRow[]>`
            select ${tx.unsafe(EXTENSION_COLUMNS)}
            from extension_requests where id = ${id}
          `;
        if (!extension) {
          throw httpError(404, 'EXTENSION_NOT_FOUND', 'No such extension request.');
        }
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['draft']);
        const [work] = await tx<
          {
            work_code: string;
            title: string;
            letter_number: string;
            letter_date: string;
            original_completion_date: string | null;
            current_completion_date: string | null;
          }[]
        >`
            select work_code, title, letter_number,
                   letter_date::text as letter_date,
                   original_completion_date::text as original_completion_date,
                   current_completion_date::text as current_completion_date
            from works where id = ${extension.work_id} and deleted_at is null
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const [organisation] = await tx<
          {
            name: string;
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
            select name, address, gstin, contact_phone, contact_email,
                   logo_object_key, logo_media_type
            from organisations
            where id = app_private.current_organisation_id()
          `;
        const preview: ExtensionSnapshot = {
          templateVersion: EXTENSION_TEMPLATE_VERSION,
          organisationName: organisation?.name ?? '',
          // No number exists before finalisation; the preview says so.
          requestNumber: 'DRAFT',
          letterDate: extension.letter_date ?? '(letter date not set)',
          addressee: extension.addressee,
          reason: extension.reason,
          work: {
            workCode: work.work_code,
            title: work.title,
            letterNumber: work.letter_number,
            letterDate: work.letter_date,
          },
          originalCompletionDate: work.original_completion_date ?? '—',
          currentCompletionDate: work.current_completion_date ?? '—',
          proposedCompletionDate: extension.proposed_completion_date,
          finalisedAt: '',
        };
        return { snapshot: preview, branding: organisation ?? null };
      });

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          request.log.warn({ err: error }, 'extension draft preview: logo unavailable');
        }
      }
      const html = renderExtensionHtml(
        snapshot,
        {
          ...(logoDataUri !== undefined ? { logoDataUri } : {}),
          address: branding?.address ?? null,
          gstin: branding?.gstin ?? null,
          contactPhone: branding?.contact_phone ?? null,
          contactEmail: branding?.contact_email ?? null,
        },
        { draftWatermark: true },
      );
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the draft is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'extension draft preview failed');
        },
      });
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="extension-${id}-draft-preview.pdf"`,
      );
      return reply.send(pdf);
    },
  );

  // --- The railway's response -------------------------------------------------
  tenantRoute(
    {
      method: 'POST',
      url: '/api/extension-requests/:id/response-document',
      bodyLimit: MAX_PDF_UPLOAD_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { bytes: body } = consumeUpload(request.body, {
        format: 'pdf',
        description: 'the railway response',
      });
      // Authorisation before the expensive scan (ops batch): an
      // unauthorised caller must not spend scanner capacity.
      await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence (signed-copy pattern).
      const responseSha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/extresponse/${id}-${responseSha256.slice(0, 16)}.pdf`;
      return tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['finalised']);
        await storage.put(objectKey, body);
        await tx`
          update extension_requests
          set response_object_key = ${objectKey},
              response_sha256 = ${responseSha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.response_document_uploaded',
          'extension_requests',
          id,
          { sizeBytes: body.length, sha256: responseSha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/extension-requests/:id/respond',
      schema: {
        params: IdParamsSchema,
        body: RespondExtensionRequestSchema,
        response: { 200: ExtensionRequestDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        const extension = await lockExtension(tx, id);
        await assertWorkAccess(tx, user.id, extension.work_id);
        requireStatus(extension, ['finalised']);
        if (extension.response_object_key === null) {
          throw httpError(
            409,
            'RESPONSE_DOCUMENT_REQUIRED',
            'Upload the railway response document before recording the outcome.',
          );
        }
        const work = await lockWork(tx, extension.work_id);

        let granted: string | null = null;
        if (body.outcome === 'accepted') {
          if (
            body.grantedCompletionDate !== undefined &&
            body.grantedCompletionDate !== extension.proposed_completion_date
          ) {
            throw httpError(
              400,
              'EXTENSION_GRANTED_DATE_INVALID',
              'An accepted response grants exactly the proposed date; use "modified" for a different date.',
            );
          }
          granted = extension.proposed_completion_date;
        } else if (body.outcome === 'modified') {
          if (body.grantedCompletionDate === undefined) {
            throw httpError(
              400,
              'EXTENSION_GRANTED_DATE_REQUIRED',
              'A modified response must carry the granted completion date.',
            );
          }
          granted = body.grantedCompletionDate;
        } else if (body.grantedCompletionDate !== undefined) {
          throw httpError(
            400,
            'EXTENSION_GRANTED_DATE_INVALID',
            'A rejected response grants no date.',
          );
        }
        if (granted !== null && work.current_completion_date !== null) {
          // ISO dates compare correctly as strings. The granted date must
          // still extend the ledger: another extension answered in the
          // meantime may already have moved the current date past it.
          if (granted <= work.current_completion_date) {
            throw httpError(
              400,
              'EXTENSION_GRANTED_DATE_INVALID',
              `The granted date must be after the current completion date (${work.current_completion_date}).`,
            );
          }
        }

        // The extension row moves to responded FIRST: the works trigger
        // accepts the completion-date change only when it finds this row,
        // written in the same transaction, granting exactly this date.
        await tx`
          update extension_requests
          set status = 'responded', response_outcome = ${body.outcome},
              granted_completion_date = ${granted},
              responded_by_user_id = ${user.id}, responded_at = now()
          where id = ${id}
        `;
        if (granted !== null) {
          await tx`
            update works
            set current_completion_date = ${granted}
            where id = ${extension.work_id}
          `;
          await audit(
            tx,
            organisationId,
            user.id,
            'work.completion_date_extended',
            'works',
            extension.work_id,
            {
              extensionRequestId: id,
              requestNumber: extension.request_number,
              outcome: body.outcome,
              grantedCompletionDate: granted,
            },
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'extension.responded',
          'extension_requests',
          id,
          {
            outcome: body.outcome,
            grantedCompletionDate: granted,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/extension-requests/:id/pdf',
      schema: { params: IdParamsSchema, querystring: PdfQuerySchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const { kind = 'rendered' } = request.query;
      const key = await tenant(async (tx) => {
        const [row] = await tx<
          {
            work_id: string;
            rendered_object_key: string | null;
            response_object_key: string | null;
          }[]
        >`
            select work_id, rendered_object_key, response_object_key
            from extension_requests where id = ${id}
          `;
        if (!row) {
          throw httpError(404, 'EXTENSION_NOT_FOUND', 'No such extension request.');
        }
        await assertWorkAccess(tx, user.id, row.work_id);
        const found =
          kind === 'rendered' ? row.rendered_object_key : row.response_object_key;
        if (found === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            kind === 'rendered'
              ? 'This extension request has not been rendered yet.'
              : 'No railway response has been uploaded for this request.',
          );
        }
        return found;
      });
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="extension-${id}-${kind}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
