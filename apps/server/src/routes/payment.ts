import {
  ApiErrorSchema,
  PAYMENT_MATRIX_CATEGORIES,
  PaymentMatrixResponseSchema,
  PaymentMatrixRowSchema,
  SetWorkItemPaymentCategoryRequestSchema,
  UpsertPaymentMatrixRowRequestSchema,
  WorkItemPaymentCategoryResponseSchema,
  type PaymentMatrixCategory,
  type PaymentMatrixRow,
  type SetWorkItemPaymentCategoryRequest,
  type UpsertPaymentMatrixRowRequest,
} from '@auto-mb/contracts';
import { parseDecimalToMinorUnits } from '@auto-mb/loa-parser';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { jsonb } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { auditDiff } from '../audit-diff.js';
import { assertWorkAccess, requireWriterRole } from '../authz.js';
import { httpError } from '../http.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

/**
 * Milestone 8 phase 1: the per-Work payment matrix and item category
 * assignment (legacy spec §8, rule R10; ADR-0006 decision 5).
 *
 * The matrix is per-Work payment CONFIGURATION, not an issued document:
 * rows upsert (last write wins under a row lock) and delete freely,
 * because every finalised Measurement Book snapshots the category and
 * percentages it billed with — configuration edits never alter a
 * finalised record. Per R10 there is deliberately no per-item
 * percentage entry.
 *
 * The item's category itself is likewise payment configuration, not
 * the contract baseline (quantities/rates/descriptions), so its edit
 * route runs under the writer role rather than the amendment approval
 * engine, with a full before/after audit trail.
 */

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
  404: ApiErrorSchema,
  409: ApiErrorSchema,
} as const;

const IdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

const MatrixParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    }),
    category: Type.String({ pattern: '^[A-Z_]{1,40}$' }),
  },
  { additionalProperties: false },
);

async function audit(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, entity_id, details
    )
    values (
      ${organisationId}, ${userId}, ${action}, ${entityType}, ${entityId},
      ${jsonb(tx, details)}
    )
  `;
}

interface MatrixRowRecord {
  id: string;
  work_id: string;
  category: PaymentMatrixCategory;
  pct_supply: string;
  pct_installation: string;
  pct_pac: string;
  pct_final_bill: string;
  created_at: Date;
  updated_at: Date;
}

function toMatrixRow(row: MatrixRowRecord): PaymentMatrixRow {
  return {
    id: row.id,
    workId: row.work_id,
    category: row.category,
    pctSupply: row.pct_supply,
    pctInstallation: row.pct_installation,
    pctPac: row.pct_pac,
    pctFinalBill: row.pct_final_bill,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function assertMatrixCategory(raw: string): PaymentMatrixCategory {
  if (!(PAYMENT_MATRIX_CATEGORIES as readonly string[]).includes(raw)) {
    throw httpError(
      400,
      'CATEGORY_INVALID',
      `Unknown payment category ${raw}. Valid categories: ${PAYMENT_MATRIX_CATEGORIES.join(', ')}.`,
    );
  }
  return raw as PaymentMatrixCategory;
}

const STAGE_FIELDS = [
  ['pctSupply', 'supply'],
  ['pctInstallation', 'installation'],
  ['pctPac', 'PAC'],
  ['pctFinalBill', 'final bill'],
] as const;

/** Validates the four stage percentages in exact integer minor units
 * (scale 2, i.e. hundredths of a percent) — never floats. Each must be
 * 0–100 with at most two decimals, and the four must sum to exactly
 * 100 (R10). Returns nothing; throws the friendly 400 the matrix
 * editor surfaces inline. The database CHECKs hold the same invariants
 * against every writer. */
function assertPercentagesSumTo100(body: UpsertPaymentMatrixRowRequest): void {
  let total = 0n;
  for (const [field, label] of STAGE_FIELDS) {
    const minor = parseDecimalToMinorUnits(body[field], 2);
    if (minor === null || minor < 0n || minor > 10000n) {
      throw httpError(
        400,
        'PERCENTAGE_INVALID',
        `The ${label} percentage must be between 0 and 100 with at most two decimal places.`,
      );
    }
    total += minor;
  }
  if (total !== 10000n) {
    throw httpError(
      400,
      'PERCENTAGES_SUM_INVALID',
      'The four stage percentages (supply, installation, PAC, final bill) must sum to exactly 100.',
    );
  }
}

const MATRIX_COLUMNS_SQL = `
  id, work_id, category, pct_supply::text as pct_supply,
  pct_installation::text as pct_installation, pct_pac::text as pct_pac,
  pct_final_bill::text as pct_final_bill, created_at, updated_at
`;

export function registerPaymentRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/works/:id/payment-matrix',
    {
      schema: {
        params: IdParamsSchema,
        response: { 200: PaymentMatrixResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId } = request.params as { id: string };
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        const rows = (await tx.unsafe(
          `select ${MATRIX_COLUMNS_SQL}
           from payment_matrices where work_id = $1
           order by category`,
          [workId],
        )) as unknown as MatrixRowRecord[];
        return { rows: rows.map(toMatrixRow) };
      });
    },
  );

  app.put(
    '/api/works/:id/payment-matrix/:category',
    {
      schema: {
        params: MatrixParamsSchema,
        body: UpsertPaymentMatrixRowRequestSchema,
        response: { 200: PaymentMatrixRowSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId, category: rawCategory } = request.params as {
        id: string;
        category: string;
      };
      const category = assertMatrixCategory(rawCategory);
      const body = request.body as UpsertPaymentMatrixRowRequest;
      assertPercentagesSumTo100(body);
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
          select id from works where id = ${workId} and deleted_at is null
        `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');

        // Row lock (when the row exists) serialises concurrent upserts
        // for the same category so the before/after audit pairs stay
        // truthful; the ON CONFLICT upsert below makes the write itself
        // atomic either way — last write wins cleanly, no duplicate-key
        // corruption.
        const [existing] = await tx<
          {
            pct_supply: string;
            pct_installation: string;
            pct_pac: string;
            pct_final_bill: string;
          }[]
        >`
          select pct_supply::text as pct_supply,
                 pct_installation::text as pct_installation,
                 pct_pac::text as pct_pac,
                 pct_final_bill::text as pct_final_bill
          from payment_matrices
          where work_id = ${workId} and category = ${category}
          for update
        `;

        const rows = (await tx.unsafe(
          `insert into payment_matrices (
             organisation_id, work_id, category, pct_supply,
             pct_installation, pct_pac, pct_final_bill, created_by_user_id
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (organisation_id, work_id, category) do update set
             pct_supply = excluded.pct_supply,
             pct_installation = excluded.pct_installation,
             pct_pac = excluded.pct_pac,
             pct_final_bill = excluded.pct_final_bill
           returning ${MATRIX_COLUMNS_SQL}`,
          [
            organisationId,
            workId,
            category,
            body.pctSupply,
            body.pctInstallation,
            body.pctPac,
            body.pctFinalBill,
            user.id,
          ],
        )) as unknown as MatrixRowRecord[];
        const row = rows[0];
        if (!row) throw new Error('payment matrix upsert returned no row');

        const changes = auditDiff(
          existing === undefined
            ? {}
            : {
                pctSupply: existing.pct_supply,
                pctInstallation: existing.pct_installation,
                pctPac: existing.pct_pac,
                pctFinalBill: existing.pct_final_bill,
              },
          {
            pctSupply: row.pct_supply,
            pctInstallation: row.pct_installation,
            pctPac: row.pct_pac,
            pctFinalBill: row.pct_final_bill,
          },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          existing === undefined
            ? 'payment_matrix.row_created'
            : 'payment_matrix.row_updated',
          'payment_matrices',
          row.id,
          {
            workId,
            category,
            before: changes.before,
            after: changes.after,
          },
        );
        return toMatrixRow(row);
      });
    },
  );

  app.delete(
    '/api/works/:id/payment-matrix/:category',
    {
      schema: {
        params: MatrixParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workId, category: rawCategory } = request.params as {
        id: string;
        category: string;
      };
      const category = assertMatrixCategory(rawCategory);
      await withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertWorkAccess(tx, user.id, workId);
        // Deleting configuration is legitimate here: finalised MBs
        // snapshot their percentages, so removing a row only affects
        // FUTURE resolution (which will fail precisely if the row is
        // still needed).
        const [deleted] = await tx<
          {
            id: string;
            pct_supply: string;
            pct_installation: string;
            pct_pac: string;
            pct_final_bill: string;
          }[]
        >`
          delete from payment_matrices
          where work_id = ${workId} and category = ${category}
          returning id, pct_supply::text as pct_supply,
                    pct_installation::text as pct_installation,
                    pct_pac::text as pct_pac,
                    pct_final_bill::text as pct_final_bill
        `;
        if (!deleted) {
          throw httpError(
            404,
            'MATRIX_ROW_NOT_FOUND',
            `This Work has no ${category} payment matrix row.`,
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'payment_matrix.row_deleted',
          'payment_matrices',
          deleted.id,
          {
            workId,
            category,
            before: {
              pctSupply: deleted.pct_supply,
              pctInstallation: deleted.pct_installation,
              pctPac: deleted.pct_pac,
              pctFinalBill: deleted.pct_final_bill,
            },
            after: {},
          },
        );
      });
      return reply.status(204).send();
    },
  );

  app.patch(
    '/api/work-items/:id/payment-category',
    {
      schema: {
        params: IdParamsSchema,
        body: SetWorkItemPaymentCategoryRequestSchema,
        response: { 200: WorkItemPaymentCategoryResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      const { id: workItemId } = request.params as { id: string };
      const body = request.body as SetWorkItemPaymentCategoryRequest;
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireWriterRole(tx, user.id);
        // Row lock: serialises concurrent category edits so the
        // before/after audit pairs chain truthfully.
        const [item] = await tx<
          {
            id: string;
            work_id: string;
            item_number: string;
            payment_category: string | null;
          }[]
        >`
          select id, work_id, item_number, payment_category
          from work_items
          where id = ${workItemId} and deleted_at is null
          for update
        `;
        if (!item) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        await assertWorkAccess(tx, user.id, item.work_id);

        const [updated] = await tx<
          { id: string; item_number: string; payment_category: string | null }[]
        >`
          update work_items
          set payment_category = ${body.paymentCategory}
          where id = ${workItemId}
          returning id, item_number, payment_category
        `;
        if (!updated) {
          throw httpError(404, 'WORK_ITEM_NOT_FOUND', 'No such Work item.');
        }
        const changes = auditDiff(
          { paymentCategory: item.payment_category },
          { paymentCategory: updated.payment_category },
        );
        await audit(
          tx,
          organisationId,
          user.id,
          'work_item.payment_category_changed',
          'work_items',
          workItemId,
          {
            workId: item.work_id,
            itemNumber: item.item_number,
            before: changes.before,
            after: changes.after,
          },
        );
        return {
          id: updated.id,
          itemNumber: updated.item_number,
          paymentCategory:
            updated.payment_category as SetWorkItemPaymentCategoryRequest['paymentCategory'],
        };
      });
    },
  );
}
