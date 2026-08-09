import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelIssueChallanRequestSchema,
  IssueChallanDetailResponseSchema,
  IssueChallanListResponseSchema,
  SaveIssueChallanRequestSchema,
  type CancelIssueChallanRequest,
  type IssueChallan,
  type IssueChallanDetailResponse,
  type IssueChallanLine,
  type SaveIssueChallanRequest,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { assertWorkAccess, requireAuthority, requireWriterRole } from '../authz.js';
import { draftConflictError, nameDraftConflict } from '../draft-conflict.js';
import { httpError } from '../http.js';
import {
  ISSUE_CHALLAN_TEMPLATE_VERSION,
  renderIssueChallanHtml,
  type IssueChallanSnapshot,
} from '../issue-challan-html.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { MalwareScanner } from '../malware-scan.js';
import { assertNotMalware } from '../upload-guards.js';
import { requireUser } from '../session.js';
import type { ObjectStorage } from '../storage.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';
import { assertWorkOperable } from '../work-status.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
  502: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const PdfQuerySchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal('rendered'), Type.Literal('signed')])),
  },
  { additionalProperties: false },
);

const PDF_MAGIC = Buffer.from('%PDF-');
const MAX_PDF_BYTES = 25 * 1024 * 1024;

interface IssueChallanRow {
  id: string;
  work_id: string;
  status: IssueChallan['status'];
  movement_type: IssueChallan['movementType'];
  challan_date: string;
  challan_number: string | null;
  sequence_number: number | null;
  prefix: string;
  issued_to_name: string;
  issued_to_role: string | null;
  location: string | null;
  remarks: string | null;
  template_version: string | null;
  rendered_object_key: string | null;
  signed_copy_object_key: string | null;
  cancellation_note: string | null;
  created_at: Date;
  issued_at: Date | null;
  cancelled_at: Date | null;
}

const ISSUE_CHALLAN_COLUMNS = `
  id, work_id, status, movement_type, challan_date::text as challan_date,
  challan_number, sequence_number, prefix, issued_to_name, issued_to_role,
  location, remarks, template_version, rendered_object_key,
  signed_copy_object_key, cancellation_note, created_at, issued_at,
  cancelled_at
`;

function toIssueChallan(row: IssueChallanRow): IssueChallan {
  return {
    id: row.id,
    workId: row.work_id,
    status: row.status,
    movementType: row.movement_type,
    challanDate: row.challan_date,
    challanNumber: row.challan_number,
    sequenceNumber: row.sequence_number,
    prefix: row.prefix,
    issuedToName: row.issued_to_name,
    issuedToRole: row.issued_to_role,
    location: row.location,
    remarks: row.remarks,
    templateVersion: row.template_version,
    renderedAvailable: row.rendered_object_key !== null,
    signedCopyAvailable: row.signed_copy_object_key !== null,
    cancellationNote: row.cancellation_note,
    createdAt: row.created_at.toISOString(),
    issuedAt: row.issued_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
  };
}

interface IssueChallanLineRow {
  id: string;
  work_item_id: string | null;
  item_number: string | null;
  description_snapshot: string;
  unit_snapshot: string;
  quantity: string;
  position: number;
}

function toIssueChallanLine(row: IssueChallanLineRow): IssueChallanLine {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    itemNumber: row.item_number,
    description: row.description_snapshot,
    unit: row.unit_snapshot,
    quantity: row.quantity,
    position: row.position,
  };
}

async function readLines(
  tx: TransactionSql,
  challanId: string,
): Promise<IssueChallanLine[]> {
  const rows = await tx<IssueChallanLineRow[]>`
    select icl.id, icl.work_item_id, wi.item_number,
           icl.description_snapshot, icl.unit_snapshot,
           icl.quantity::text as quantity, icl.position
    from issue_challan_lines icl
    left join work_items wi on wi.id = icl.work_item_id
    where icl.issue_challan_id = ${challanId}
    order by icl.position
  `;
  return rows.map(toIssueChallanLine);
}

async function readDetail(
  tx: TransactionSql,
  challanId: string,
): Promise<IssueChallanDetailResponse> {
  const [row] = await tx<(IssueChallanRow & { issued_snapshot: unknown })[]>`
    select ${tx.unsafe(ISSUE_CHALLAN_COLUMNS)}, issued_snapshot
    from issue_challans where id = ${challanId}
  `;
  if (!row) throw httpError(404, 'ISSUE_CHALLAN_NOT_FOUND', 'No such Issue Challan.');
  return {
    issueChallan: toIssueChallan(row),
    lines: await readLines(tx, challanId),
    issuedSnapshot: parseJsonbColumn(row.issued_snapshot),
  };
}

/** Product contract, shared with Delivery Challans: a document date is
 * never in the future and never before the Work's LOA letter date, with
 * "today" evaluated in the organisation's own timezone. The 0014 trigger
 * makes the invariant hold against every writer; this validates first
 * with friendly errors. */
async function assertIssueChallanDate(
  tx: TransactionSql,
  workId: string,
  challanDate: string,
): Promise<void> {
  const [bounds] = await tx<{ letter_date: string; today: string }[]>`
    select w.letter_date::text as letter_date,
           (now() at time zone o.timezone)::date::text as today
    from works w
    join organisations o on o.id = w.organisation_id
    where w.id = ${workId}
  `;
  if (!bounds) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
  // ISO dates compare correctly as strings.
  if (challanDate > bounds.today) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot be in the future (today is ${bounds.today}).`,
    );
  }
  if (challanDate < bounds.letter_date) {
    throw httpError(
      400,
      'CHALLAN_DATE_INVALID',
      `The challan date cannot precede the LOA letter date (${bounds.letter_date}).`,
    );
  }
}

/** Locks the challan row for the rest of the transaction and returns it.
 * Every state transition starts here so concurrent requests serialise. */
async function lockIssueChallan(
  tx: TransactionSql,
  challanId: string,
): Promise<IssueChallanRow> {
  const [row] = await tx<IssueChallanRow[]>`
    select ${tx.unsafe(ISSUE_CHALLAN_COLUMNS)}
    from issue_challans where id = ${challanId}
    for update
  `;
  if (!row) throw httpError(404, 'ISSUE_CHALLAN_NOT_FOUND', 'No such Issue Challan.');
  return row;
}

function requireStatus(row: IssueChallanRow, status: IssueChallan['status']): void {
  if (row.status !== status) {
    throw httpError(
      409,
      'ISSUE_CHALLAN_STATUS_CONFLICT',
      `This operation requires a ${status} Issue Challan (current status: ${row.status}).`,
    );
  }
}

export interface NormalisedHeader {
  issuedToName: string;
  issuedToRole: string | null;
  location: string | null;
  remarks: string | null;
}

/** Trims the free-text snapshot fields with friendly errors; the 0014
 * CHECK constraints enforce the same bounds on btrimmed values, so
 * whitespace padding must not slip past the contract's raw minLength.
 * (Exported for the correction flow's replacement proposals.) */
export function normaliseHeader(body: SaveIssueChallanRequest): NormalisedHeader {
  const issuedToName = body.issuedToName.trim();
  if (issuedToName.length < 2) {
    throw httpError(
      400,
      'ISSUED_TO_REQUIRED',
      'Name at least 2 characters long is required for the receiving party.',
    );
  }
  const optional = (value: string | undefined, field: string): string | null => {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length < 2 && field !== 'remarks') {
      throw httpError(
        400,
        'FIELD_TOO_SHORT',
        `The ${field} must be at least 2 characters when given.`,
      );
    }
    return trimmed;
  };
  return {
    issuedToName,
    issuedToRole: optional(body.issuedToRole, 'issued-to role'),
    location: optional(body.location, 'location'),
    remarks: optional(body.remarks, 'remarks'),
  };
}

/** Replaces the challan's lines from the request. Work-item lines
 * snapshot description/unit from the live Work item; manual lines carry
 * their own description/unit — quantities are free of any awarded or
 * delivered ceiling BY DESIGN (Issue Challans may exceed work
 * quantities; legacy spec §5.3). (Exported for the correction flow,
 * which writes replacement drafts through the same path.) */
export async function writeLines(
  tx: TransactionSql,
  organisationId: string,
  challanId: string,
  workId: string,
  body: SaveIssueChallanRequest,
): Promise<void> {
  await tx`
    delete from issue_challan_lines where issue_challan_id = ${challanId}
  `;
  for (const [index, line] of body.lines.entries()) {
    if (!(Number(line.quantity) > 0)) {
      throw httpError(
        400,
        'QUANTITY_INVALID',
        'Every line quantity must be greater than zero.',
      );
    }
    if ('workItemId' in line) {
      const [inserted] = await tx<{ id: string }[]>`
        insert into issue_challan_lines (
          organisation_id, issue_challan_id, work_id, work_item_id,
          description_snapshot, unit_snapshot, quantity, position
        )
        select ${organisationId}, ${challanId}, ${workId}, wi.id,
               wi.description, wi.unit_code, ${line.quantity}, ${index + 1}
        from work_items wi
        where wi.id = ${line.workItemId} and wi.work_id = ${workId}
          and wi.deleted_at is null
        returning id
      `.catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === '23505') {
          throw httpError(
            409,
            'DUPLICATE_ITEM',
            'The same Work item appears more than once on this Issue Challan.',
          );
        }
        throw error;
      });
      if (!inserted) {
        throw httpError(
          404,
          'WORK_ITEM_NOT_FOUND',
          'A selected item does not belong to this Work.',
        );
      }
    } else {
      const description = line.description.trim();
      const unit = line.unit.trim();
      if (description.length < 3 || unit.length === 0) {
        throw httpError(
          400,
          'MANUAL_LINE_INVALID',
          'Manual lines need a description of at least 3 characters and a unit.',
        );
      }
      await tx`
        insert into issue_challan_lines (
          organisation_id, issue_challan_id, work_id, work_item_id,
          description_snapshot, unit_snapshot, quantity, position
        )
        values (
          ${organisationId}, ${challanId}, ${workId}, null,
          ${description}, ${unit}, ${line.quantity}, ${index + 1}
        )
      `;
    }
  }
}

async function auditIssueChallan(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  challanId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, 'issue_challans',
      ${challanId}, ${jsonb(tx, details)}
    )
  `;
}

export function registerIssueChallanRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
  scanner: MalwareScanner,
): void {
  app.get(
    '/api/works/:id/issue-challans',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: IssueChallanListResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const rows = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await assertWorkAccess(tx, user.id, workId);
          return tx<IssueChallanRow[]>`
            select ${tx.unsafe(ISSUE_CHALLAN_COLUMNS)}
            from issue_challans
            where work_id = ${workId}
            order by created_at desc, id
          `;
        },
      );
      return { issueChallans: rows.map(toIssueChallan) };
    },
  );

  app.post(
    '/api/works/:id/issue-challans',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveIssueChallanRequestSchema,
        response: { 201: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      const body = request.body as SaveIssueChallanRequest;
      const header = normaliseHeader(body);

      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx): Promise<IssueChallanDetailResponse> => {
          await requireWriterRole(tx, user.id);
          await assertWorkAccess(tx, user.id, workId);
          // The works row lock pairs with the one POST
          // /api/works/:id/complete holds, so a draft can never appear
          // behind a completed Work's refusals (the 0031 insert guard
          // backstops it in the database).
          const [work] = await tx<{ status: string; work_code: string }[]>`
            select status, work_code from works
            where id = ${workId} and deleted_at is null
            for update
          `;
          if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
          assertWorkOperable(work.status, 'drafting an issue challan');
          await assertIssueChallanDate(tx, workId, body.challanDate);

          // One open draft per Work (also enforced by the partial unique
          // index): answered with the existing draft's id so the client
          // can open it directly.
          const [existing] = await tx<{ id: string }[]>`
            select id from issue_challans
            where work_id = ${workId} and status = 'draft'
          `;
          if (existing) {
            throw draftConflictError(
              'DRAFT_EXISTS',
              'This Work already has a draft Issue Challan; open, issue, or delete it first.',
              existing.id,
            );
          }

          // Numbering series per §7: default prefix <work_code>-IC.
          const prefix = `${work.work_code}-IC`;
          const [created] = await tx<{ id: string }[]>`
            insert into issue_challans (
              organisation_id, work_id, movement_type, challan_date, prefix,
              issued_to_name, issued_to_role, location, remarks,
              created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.movementType},
              ${body.challanDate}, ${prefix}, ${header.issuedToName},
              ${header.issuedToRole}, ${header.location}, ${header.remarks},
              ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              // Concurrent creates raced past the pre-check above; the
              // partial unique index is the arbiter. The transaction is
              // aborted, so the route-level catch names the winner from
              // a fresh read.
              throw httpError(
                409,
                'DRAFT_EXISTS',
                'This Work already has a draft Issue Challan; open, issue, or delete it first.',
              );
            }
            throw error;
          });
          if (!created) throw new Error('issue challan insert returned no row');

          await writeLines(tx, organisationId, created.id, workId, body);
          await auditIssueChallan(
            tx,
            organisationId,
            user.id,
            'issue_challan.created',
            created.id,
            {
              workId,
              movementType: body.movementType,
              lineCount: body.lines.length,
            },
          );
          return readDetail(tx, created.id);
        },
      ).catch(async (error: unknown) => {
        // The unique-index race path could not name the winning draft
        // inside its aborted transaction; do it from a fresh read.
        throw await nameDraftConflict(error, 'DRAFT_EXISTS', () =>
          withBoundTenant(database, organisationId, user.id, async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from issue_challans
              where work_id = ${workId} and status = 'draft'
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  app.get(
    '/api/issue-challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const [ref] = await tx<{ work_id: string }[]>`
          select work_id from issue_challans where id = ${id}
        `;
        if (!ref) {
          throw httpError(404, 'ISSUE_CHALLAN_NOT_FOUND', 'No such Issue Challan.');
        }
        await assertWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  app.put(
    '/api/issue-challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: SaveIssueChallanRequestSchema,
        response: { 200: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as SaveIssueChallanRequest;
      const header = normaliseHeader(body);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockIssueChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        await assertIssueChallanDate(tx, challan.work_id, body.challanDate);
        await tx`
          update issue_challans
          set challan_date = ${body.challanDate},
              movement_type = ${body.movementType},
              issued_to_name = ${header.issuedToName},
              issued_to_role = ${header.issuedToRole},
              location = ${header.location},
              remarks = ${header.remarks}
          where id = ${id}
        `;
        await writeLines(tx, organisationId, id, challan.work_id, body);
        await auditIssueChallan(
          tx,
          organisationId,
          user.id,
          'issue_challan.updated',
          id,
          {
            movementType: body.movementType,
            lineCount: body.lines.length,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.delete(
    '/api/issue-challans/:id',
    {
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockIssueChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'draft');
        await tx`delete from issue_challan_lines where issue_challan_id = ${id}`;
        await tx`delete from issue_challans where id = ${id}`;
        await auditIssueChallan(
          tx,
          organisationId,
          user.id,
          'issue_challan.deleted',
          id,
          { workId: challan.work_id },
        );
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/issue-challans/:id/issue',
    {
      schema: {
        params: IdParamsSchema,
        response: { 201: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const detail = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireAuthority(tx, user.id, 'issue');
          const challan = await lockIssueChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          requireStatus(challan, 'draft');

          // The works row lock pairs with the one POST
          // /api/works/:id/complete holds, so an issue and a completion
          // on the same Work serialise; the 0031 issue-challan update
          // guard backstops the refusal in the database.
          const [work] = await tx<
            {
              work_code: string;
              title: string;
              letter_number: string;
              letter_date: string;
              status: string;
            }[]
          >`
            select work_code, title, letter_number,
                   letter_date::text as letter_date, status
            from works where id = ${challan.work_id}
            for update
          `;
          if (!work) throw new Error('issue challan without a Work');

          // R8: a completed Work accepts no new operational documents.
          assertWorkOperable(work.status, 'issuing an issue challan');

          // Deliberately NO quantity ceiling here: Issue Challan
          // quantities may exceed the awarded (and delivered) quantities
          // by design — they track material movement, not the delivery
          // ledger (legacy spec §5.3).

          // Serialised per-Work numbering: the counter row lock orders
          // concurrent issues; a rolled-back transaction rolls the
          // counter back with it, so numbers are gapless per Work.
          const [counter] = await tx<{ next_value: number }[]>`
            insert into issue_challan_counters (organisation_id, work_id)
            values (${organisationId}, ${challan.work_id})
            on conflict (organisation_id, work_id)
            do update set next_value = issue_challan_counters.next_value + 1,
                          updated_at = now()
            returning next_value
          `;
          if (!counter) throw new Error('counter upsert returned no row');
          const sequence = counter.next_value;
          const challanNumber = `${challan.prefix}/${String(sequence)}`;

          const [organisation] = await tx<{ name: string }[]>`
            select name from organisations
          `;
          const lines = await tx<IssueChallanLineRow[]>`
            select icl.id, icl.work_item_id, wi.item_number,
                   icl.description_snapshot, icl.unit_snapshot,
                   icl.quantity::text as quantity, icl.position
            from issue_challan_lines icl
            left join work_items wi on wi.id = icl.work_item_id
            where icl.issue_challan_id = ${id}
            order by icl.position
          `;

          const issuedAt = new Date().toISOString();
          const snapshot: IssueChallanSnapshot = {
            templateVersion: ISSUE_CHALLAN_TEMPLATE_VERSION,
            organisationName: organisation?.name ?? '',
            challanNumber,
            challanDate: challan.challan_date,
            issuedAt,
            movementType: challan.movement_type,
            work: {
              workCode: work.work_code,
              title: work.title,
              letterNumber: work.letter_number,
              letterDate: work.letter_date,
            },
            issuedTo: {
              name: challan.issued_to_name,
              role: challan.issued_to_role,
              location: challan.location,
            },
            remarks: challan.remarks,
            lines: lines.map((line) => ({
              position: line.position,
              itemNumber: line.item_number,
              description: line.description_snapshot,
              unit: line.unit_snapshot,
              quantity: line.quantity,
            })),
          };

          await tx`
            update issue_challans
            set status = 'issued', challan_number = ${challanNumber},
                sequence_number = ${sequence},
                issued_snapshot = ${jsonb(tx, snapshot)},
                issued_by_user_id = ${user.id}, issued_at = ${issuedAt},
                template_version = ${ISSUE_CHALLAN_TEMPLATE_VERSION}
            where id = ${id}
          `.catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === '23505') {
              throw httpError(
                409,
                'NUMBER_CONFLICT',
                `Issue Challan number ${challanNumber} already exists in this organisation.`,
              );
            }
            throw error;
          });

          await auditIssueChallan(
            tx,
            organisationId,
            user.id,
            'issue_challan.issued',
            id,
            {
              challanNumber,
              sequence,
              movementType: challan.movement_type,
            },
          );
          return readDetail(tx, id);
        },
      );
      return reply.status(201).send(detail);
    },
  );

  app.post(
    '/api/issue-challans/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: CancelIssueChallanRequestSchema,
        response: { 200: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body as CancelIssueChallanRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireAuthority(tx, user.id, 'cancel');
        const challan = await lockIssueChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        // R8: a completed Work's operational record is frozen in both
        // directions — cancelling an issued document is as much a change
        // to it as raising a new one. Lock order is the creation paths' —
        // document row first, then works — so cancel and completion
        // serialise; the 0032 issue-challan update guard is the database
        // backstop.
        const [work] = await tx<{ status: string }[]>`
          select status from works
          where id = ${challan.work_id} and deleted_at is null
          for update
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        assertWorkOperable(work.status, 'cancelling an issue challan');
        await tx`
          update issue_challans
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${body.note}
          where id = ${id}
        `;
        await auditIssueChallan(
          tx,
          organisationId,
          user.id,
          'issue_challan.cancelled',
          id,
          {
            challanNumber: challan.challan_number,
            note: body.note,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/issue-challans/:id/render',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };

      // Snapshot read and PDF write live in separate transactions so the
      // slow external call holds no database locks; the legal content is
      // the immutable issued snapshot, so re-rendering reproduces the
      // record. Branding (logo, company details) is presentation and
      // comes from the organisation's current profile.
      const { snapshot, branding } = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          await requireWriterRole(tx, user.id);
          const challan = await lockIssueChallan(tx, id);
          await assertWorkAccess(tx, user.id, challan.work_id);
          requireStatus(challan, 'issued');
          const [row] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from issue_challans where id = ${id}
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
          `;
          return {
            snapshot: parseJsonbColumn(row?.issued_snapshot) as IssueChallanSnapshot,
            branding: organisation ?? null,
          };
        },
      );

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key && branding.logo_media_type) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo object must not block an issued document.
          request.log.warn({ err: error }, 'issue challan render: logo unavailable');
        }
      }
      const html = renderIssueChallanHtml(snapshot, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const form = new FormData();
      form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
      let pdf: Buffer;
      try {
        const response = await fetch(`${gotenbergUrl}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
        });
        if (!response.ok) {
          throw new Error(`Gotenberg answered ${String(response.status)}`);
        }
        pdf = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        request.log.error({ err: error }, 'issue challan render failed');
        throw httpError(
          502,
          'RENDER_FAILED',
          'The PDF service is unavailable; the issued challan is unaffected — retry later.',
        );
      }
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/ic/${id}.pdf`;
      await storage.put(objectKey, pdf);

      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        const updated = await tx`
          update issue_challans
          set rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id} and status = 'issued'
        `;
        if (updated.count === 0) {
          // The challan stopped being issued while Gotenberg rendered; the
          // stored PDF is an orphan, not evidence — no audit entry.
          throw httpError(
            409,
            'ISSUE_CHALLAN_STATUS_CONFLICT',
            'The Issue Challan is no longer issued; the render was discarded.',
          );
        }
        await auditIssueChallan(
          tx,
          organisationId,
          user.id,
          'issue_challan.rendered',
          id,
          { sha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.post(
    '/api/issue-challans/:id/signed-copy',
    {
      bodyLimit: MAX_PDF_BYTES,
      schema: {
        params: IdParamsSchema,
        response: { 200: IssueChallanDetailResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw httpError(
          400,
          'PDF_REQUIRED',
          'Send the signed copy as an application/pdf request body.',
        );
      }
      if (!body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
        throw httpError(400, 'NOT_A_PDF', 'The uploaded file is not a PDF.');
      }
      // Authorisation before the expensive scan: an unauthorised caller
      // must not spend scanner capacity.
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
      });
      await assertNotMalware(scanner, body);
      // Content-addressed key: a replacement upload gets a new object and
      // never overwrites earlier evidence; the hash is recorded like the
      // rendered PDF's.
      const signedSha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `${organisationId}/icsigned/${id}-${signedSha256.slice(0, 16)}.pdf`;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        const challan = await lockIssueChallan(tx, id);
        await assertWorkAccess(tx, user.id, challan.work_id);
        requireStatus(challan, 'issued');
        await storage.put(objectKey, body);
        await tx`
          update issue_challans
          set signed_copy_object_key = ${objectKey},
              signed_copy_sha256 = ${signedSha256}
          where id = ${id}
        `;
        await auditIssueChallan(
          tx,
          organisationId,
          user.id,
          'issue_challan.signed_copy_uploaded',
          id,
          { sizeBytes: body.length, sha256: signedSha256 },
        );
        return readDetail(tx, id);
      });
    },
  );

  app.get(
    '/api/issue-challans/:id/pdf',
    {
      schema: { params: IdParamsSchema, querystring: PdfQuerySchema },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id } = request.params as { id: string };
      const { kind = 'rendered' } = request.query as { kind?: 'rendered' | 'signed' };
      const key = await withBoundTenant(
        database,
        organisationId,
        user.id,
        async (tx) => {
          const [row] = await tx<
            {
              work_id: string;
              rendered_object_key: string | null;
              signed_copy_object_key: string | null;
            }[]
          >`
            select work_id, rendered_object_key, signed_copy_object_key
            from issue_challans where id = ${id}
          `;
          if (!row) {
            throw httpError(404, 'ISSUE_CHALLAN_NOT_FOUND', 'No such Issue Challan.');
          }
          await assertWorkAccess(tx, user.id, row.work_id);
          const found =
            kind === 'rendered' ? row.rendered_object_key : row.signed_copy_object_key;
          if (found === null) {
            throw httpError(
              404,
              'PDF_NOT_AVAILABLE',
              kind === 'rendered'
                ? 'This Issue Challan has not been rendered yet.'
                : 'No signed copy has been uploaded for this Issue Challan.',
            );
          }
          return found;
        },
      );
      const bytes = await storage.get(key);
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="issue-challan-${id}-${kind}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
