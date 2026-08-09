import { ApiErrorSchema } from '@auto-mb/contracts';
import type { FastifyInstance } from 'fastify';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import { requireOrganisationHeader, withBoundTenant } from '../tenant-context.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
} as const;

function parseColumns<T extends Record<string, unknown>>(
  rows: readonly T[],
  jsonbColumns: readonly (keyof T)[],
): T[] {
  return rows.map((row) => {
    const parsed = { ...row };
    for (const column of jsonbColumns) {
      parsed[column] = parseJsonbColumn(row[column]) as T[typeof column];
    }
    return parsed;
  });
}

/**
 * Full-organisation export (docs/SECURITY.md §incident/export procedures;
 * Milestone 4 support tooling). Owner-only: this is the tenant's complete
 * business record — data portability for the contractor, and the escape
 * hatch an incident procedure needs. RLS scopes every query; nothing here
 * names the organisation id in SQL.
 */
export function registerExportRoutes(
  app: FastifyInstance,
  auth: Auth,
  database: Sql,
): void {
  app.get(
    '/api/export',
    { schema: { response: { ...errorResponses } } },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      return withBoundTenant(database, organisationId, user.id, async (tx) => {
        await requireOwner(tx, user.id);

        const [organisation] = await tx<Record<string, unknown>[]>`
          select id, name, slug, timezone, status, created_at,
                 address, gstin, contact_phone, contact_email,
                 logo_object_key, logo_media_type
          from organisations
        `;
        const members = await tx<Record<string, unknown>[]>`
          select user_id, role, work_scope, can_issue_documents,
                 can_cancel_documents, status, created_at
          from organisation_memberships order by created_at
        `;
        const assignments = await tx<Record<string, unknown>[]>`
          select user_id, work_id, created_at
          from work_assignments order by created_at
        `;
        const works = await tx<Record<string, unknown>[]>`
          select * from works where deleted_at is null order by created_at
        `;
        const schedules = await tx<Record<string, unknown>[]>`
          select * from work_schedules order by work_id, position
        `;
        const items = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from work_items where deleted_at is null
            order by work_id, item_number
          `,
          ['source_evidence'],
        );
        const documents = parseColumns(
          await tx<Record<string, unknown>[]>`
            select id, object_key, original_filename, sha256, media_type,
                   size_bytes, extraction_status, extraction_payload,
                   confirmed_work_id, uploaded_by_user_id, created_at
            from loa_documents order by created_at
          `,
          ['extraction_payload'],
        );
        const challans = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from delivery_challans order by created_at
          `,
          ['consignee_snapshot', 'issued_snapshot'],
        );
        const challanItems = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from delivery_challan_items
            order by delivery_challan_id, position
          `,
          ['source_evidence'],
        );
        const receipts = await tx<Record<string, unknown>[]>`
          select * from challan_receipts order by created_at
        `;
        const serials = await tx<Record<string, unknown>[]>`
          select * from challan_item_serials order by created_at
        `;
        const instruments = await tx<Record<string, unknown>[]>`
          select * from work_instruments order by created_at
        `;
        const mbEntries = await tx<Record<string, unknown>[]>`
          select * from mb_entries order by measured_on, created_at
        `;
        const bills = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from bills order by work_id, bill_number
          `,
          ['lines_snapshot'],
        );
        const installations = await tx<Record<string, unknown>[]>`
          select * from installations order by installed_on, created_at, id
        `;
        const installationSerials = await tx<Record<string, unknown>[]>`
          select * from installation_serials order by created_at, id
        `;
        const approvalRequests = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from approval_requests order by created_at, id
          `,
          ['proposed', 'diff'],
        );
        const correctionNotices = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from correction_notices order by created_at, id
          `,
          ['snapshot'],
        );
        // Recorded first so the export contains its own audit record.
        await tx`
          insert into audit_events (
            organisation_id, actor_user_id, action, entity_type, details
          )
          values (
            ${organisationId}, ${user.id}, 'organisation.exported',
            'organisations', '{}'::jsonb
          )
        `;
        const auditEvents = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from audit_events order by occurred_at, id
          `,
          ['details'],
        );

        // A portable manifest of every stored object the record refers
        // to — logo, uploaded LOAs, rendered and signed challan PDFs —
        // with the recorded hashes, so an offboarding or incident package
        // can fetch and verify the bytes (external re-audit).
        const objectManifest = [
          ...(organisation && organisation.logo_object_key !== null
            ? [
                {
                  kind: 'organisation-logo',
                  objectKey: organisation.logo_object_key,
                  sha256: null,
                },
              ]
            : []),
          ...documents.map((document) => ({
            kind: 'loa-document',
            objectKey: document.object_key,
            sha256: document.sha256,
          })),
          ...challans.flatMap((challan) => [
            ...(challan.rendered_object_key !== null
              ? [
                  {
                    kind: 'challan-rendered-pdf',
                    objectKey: challan.rendered_object_key,
                    sha256: challan.rendered_sha256 ?? null,
                  },
                ]
              : []),
            ...(challan.signed_copy_object_key !== null
              ? [
                  {
                    kind: 'challan-signed-copy',
                    objectKey: challan.signed_copy_object_key,
                    sha256: challan.signed_copy_sha256 ?? null,
                  },
                ]
              : []),
          ]),
          ...correctionNotices.flatMap((notice) =>
            notice.rendered_object_key !== null
              ? [
                  {
                    kind: 'correction-notice-rendered-pdf',
                    objectKey: notice.rendered_object_key,
                    sha256: notice.rendered_sha256 ?? null,
                  },
                ]
              : [],
          ),
        ];

        return {
          exportedAt: new Date().toISOString(),
          formatVersion: 'export-v3',
          organisation,
          members,
          workAssignments: assignments,
          works,
          workSchedules: schedules,
          workItems: items,
          loaDocuments: documents,
          deliveryChallans: challans,
          deliveryChallanItems: challanItems,
          challanReceipts: receipts,
          challanItemSerials: serials,
          workInstruments: instruments,
          mbEntries,
          bills,
          installations,
          installationSerials,
          approvalRequests,
          correctionNotices,
          objectManifest,
          auditEvents,
        };
      });
    },
  );
}

async function requireOwner(tx: TransactionSql, userId: string): Promise<void> {
  const [membership] = await tx<{ role: string }[]>`
    select role from organisation_memberships where user_id = ${userId}
  `;
  if (membership?.role !== 'owner') {
    throw httpError(
      403,
      'OWNER_REQUIRED',
      'Only an organisation owner may export the organisation.',
    );
  }
}
