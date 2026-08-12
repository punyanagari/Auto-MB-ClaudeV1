import { ApiErrorSchema } from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import { requireUser } from '../session.js';
import {
  requireOrganisationHeader,
  withBoundTenantSnapshot,
} from '../tenant-context.js';
import type { AppInstance } from '../app-instance.js';

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
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  // No 200 schema is declared (the package shape is versioned by its own
  // formatVersion field, not by the API contract), so the explicit Reply
  // generic stands in for the success type the provider cannot infer.
  app.get<{ Reply: Record<string, unknown> }>(
    '/api/export',
    { schema: { response: { ...errorResponses } } },
    async (request) => {
      const user = await requireUser(auth, request);
      const organisationId = requireOrganisationHeader(
        request.headers['x-organisation-id'],
      );
      // REPEATABLE READ, not the default READ COMMITTED. The package below
      // is built from around forty-five sequential SELECTs, and under READ
      // COMMITTED each one takes its own snapshot: a writer committing
      // midway is invisible to the earlier queries and visible to the
      // later ones, so the exported package can be referentially broken —
      // challan items whose parent challan is absent, lines pointing at a
      // document read before it existed. One snapshot for the whole
      // transaction makes the package a true picture of a single instant.
      // The transaction stays read-write for the audit event at the end.
      return withBoundTenantSnapshot(database, organisationId, user.id, async (tx) => {
        await requireOwner(tx, user.id);

        const [organisation] = await tx<Record<string, unknown>[]>`
          select * from organisations
          where id = app_private.current_organisation_id()
        `;
        const members = await tx<Record<string, unknown>[]>`
          select user_id, role, work_scope, can_issue_documents,
                 can_cancel_documents, status, created_at
          from organisation_memberships
          where organisation_id = app_private.current_organisation_id()
          order by created_at
        `;
        const assignments = await tx<Record<string, unknown>[]>`
          select user_id, work_id, created_at
          from work_assignments order by created_at
        `;
        const works = await tx<Record<string, unknown>[]>`
          select * from works order by created_at
        `;
        const schedules = await tx<Record<string, unknown>[]>`
          select * from work_schedules order by work_id, position
        `;
        const items = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from work_items order by work_id, item_number
          `,
          ['source_evidence'],
        );
        const documents = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from loa_documents order by created_at
          `,
          ['extraction_payload', 'identity_match'],
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
        const issueChallans = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from issue_challans order by created_at, id
          `,
          ['issued_snapshot'],
        );
        const issueChallanLines = await tx<Record<string, unknown>[]>`
          select * from issue_challan_lines order by issue_challan_id, position
        `;
        const instruments = await tx<Record<string, unknown>[]>`
          select * from work_instruments order by created_at
        `;
        const extensionRequests = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from extension_requests order by created_at, id
          `,
          ['finalised_snapshot'],
        );
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
        const paymentMatrices = await tx<Record<string, unknown>[]>`
          select * from payment_matrices order by work_id, category
        `;
        const pacCertificates = await tx<Record<string, unknown>[]>`
          select * from pac_certificates order by issue_date, created_at, id
        `;
        const pacCertificateItems = await tx<Record<string, unknown>[]>`
          select * from pac_certificate_items
          order by pac_certificate_id, work_item_id
        `;
        const measurementBooks = await tx<Record<string, unknown>[]>`
          select * from measurement_books order by created_at, id
        `;
        const measurementBookLines = await tx<Record<string, unknown>[]>`
          select * from measurement_book_lines
          order by measurement_book_id, item_number, id
        `;
        const mbSources = await tx<Record<string, unknown>[]>`
          select * from mb_sources order by created_at, id
        `;
        const measurementBookMergeProvenance = await tx<Record<string, unknown>[]>`
          select * from measurement_book_merge_provenance
          order by target_measurement_book_id, record_measurement_book_id,
                   source_type nulls first, source_id, id
        `;
        const importBatches = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from import_batches order by started_at, id
          `,
          ['reconciliation'],
        );
        const importRecords = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from import_records order by imported_at, id
          `,
          ['payload'],
        );
        // M6/7 retrofit (migration 0028): the unified Contacts master and
        // the Work<->consignee association. consignee_masters was never a
        // section of this export; contacts supersedes it, so the format
        // became part of the current export with the procurement/statutory set.
        const contacts = await tx<Record<string, unknown>[]>`
          select * from contacts order by created_at, id
        `;
        const workConsignees = await tx<Record<string, unknown>[]>`
          select * from work_consignees order by created_at, id
        `;
        const locationMasters = await tx<Record<string, unknown>[]>`
          select * from location_masters order by name, id
        `;
        const unitMasters = await tx<Record<string, unknown>[]>`
          select * from unit_masters order by name, id
        `;
        const organisationSignatories = await tx<Record<string, unknown>[]>`
          select * from organisation_signatories order by created_at, id
        `;
        const gstRates = await tx<Record<string, unknown>[]>`
          select * from gst_rates order by rate, effective_from, id
        `;
        const purchaseOrders = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from purchase_orders order by created_at, id
          `,
          ['vendor_snapshot'],
        );
        const purchaseOrderLines = await tx<Record<string, unknown>[]>`
          select * from purchase_order_lines order by purchase_order_id, line_number, id
        `;
        const budgetaryQuotations = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from budgetary_quotations order by created_at, id
          `,
          ['customer_snapshot'],
        );
        const budgetaryQuotationLines = await tx<Record<string, unknown>[]>`
          select * from budgetary_quotation_lines
          order by budgetary_quotation_id, line_number, id
        `;
        const taxInvoices = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from tax_invoices order by created_at, id
          `,
          ['buyer_snapshot', 'ship_to_snapshot', 'issued_snapshot'],
        );
        const taxInvoiceRenders = await tx<Record<string, unknown>[]>`
          select * from tax_invoice_renders
          order by tax_invoice_id, version, created_at, id
        `;
        const ewayBills = await tx<Record<string, unknown>[]>`
          select * from eway_bills order by created_at, id
        `;
        const creditNotes = parseColumns(
          await tx<Record<string, unknown>[]>`
            select * from credit_notes order by created_at, id
          `,
          ['issued_snapshot'],
        );
        const documentNumberSeries = await tx<Record<string, unknown>[]>`
          select * from document_number_series order by document_type
        `;
        const statutoryProviderOperations = await tx<Record<string, unknown>[]>`
          select * from statutory_provider_operations order by started_at, id
        `;
        const deliveryChallanCounters = await tx<Record<string, unknown>[]>`
          select * from delivery_challan_counters order by work_id
        `;
        const billCounters = await tx<Record<string, unknown>[]>`
          select * from bill_counters order by work_id
        `;
        const extensionRequestCounters = await tx<Record<string, unknown>[]>`
          select * from extension_request_counters order by work_id
        `;
        const issueChallanCounters = await tx<Record<string, unknown>[]>`
          select * from issue_challan_counters order by work_id
        `;
        const correctionNoticeCounters = await tx<Record<string, unknown>[]>`
          select * from correction_notice_counters order by work_id
        `;
        const measurementBookCounters = await tx<Record<string, unknown>[]>`
          select * from measurement_book_counters order by work_id
        `;
        const purchaseOrderCounters = await tx<Record<string, unknown>[]>`
          select * from purchase_order_counters order by work_id
        `;
        const budgetaryQuotationCounters = await tx<Record<string, unknown>[]>`
          select * from budgetary_quotation_counters order by organisation_id
        `;
        const taxInvoiceCounters = await tx<Record<string, unknown>[]>`
          select * from tax_invoice_counters order by fy_label
        `;
        const creditNoteCounters = await tx<Record<string, unknown>[]>`
          select * from credit_note_counters order by fy_label
        `;
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
          ...pacCertificates.flatMap((certificate) =>
            certificate.document_object_key !== null
              ? [
                  {
                    kind: 'pac-certificate-document',
                    objectKey: certificate.document_object_key,
                    sha256: certificate.document_sha256 ?? null,
                  },
                ]
              : [],
          ),
          ...issueChallans.flatMap((challan) => [
            ...(challan.rendered_object_key !== null
              ? [
                  {
                    kind: 'issue-challan-rendered-pdf',
                    objectKey: challan.rendered_object_key,
                    sha256: challan.rendered_sha256 ?? null,
                  },
                ]
              : []),
            ...(challan.signed_copy_object_key !== null
              ? [
                  {
                    kind: 'issue-challan-signed-copy',
                    objectKey: challan.signed_copy_object_key,
                    sha256: challan.signed_copy_sha256 ?? null,
                  },
                ]
              : []),
          ]),
          ...extensionRequests.flatMap((extension) => [
            ...(extension.rendered_object_key !== null
              ? [
                  {
                    kind: 'extension-rendered-pdf',
                    objectKey: extension.rendered_object_key,
                    sha256: extension.rendered_sha256 ?? null,
                  },
                ]
              : []),
            ...(extension.response_object_key !== null
              ? [
                  {
                    kind: 'extension-response-document',
                    objectKey: extension.response_object_key,
                    sha256: extension.response_sha256 ?? null,
                  },
                ]
              : []),
          ]),
          ...measurementBooks.flatMap((book) =>
            book.rendered_object_key !== null
              ? [
                  {
                    kind: 'measurement-book-rendered-pdf',
                    objectKey: book.rendered_object_key,
                    sha256: book.rendered_sha256 ?? null,
                  },
                ]
              : [],
          ),
          ...creditNotes.flatMap((note) =>
            note.rendered_object_key !== null
              ? [
                  {
                    kind: 'credit-note-rendered-pdf',
                    objectKey: note.rendered_object_key,
                    sha256: note.rendered_sha256 ?? null,
                  },
                ]
              : [],
          ),
          ...taxInvoiceRenders.flatMap((render) => [
            {
              kind: 'tax-invoice-rendered-pdf-version',
              objectKey: render.object_key,
              sha256: render.pdf_sha256,
            },
            ...(render.logo_object_key === null
              ? []
              : [
                  {
                    kind: 'tax-invoice-render-logo',
                    objectKey: render.logo_object_key,
                    sha256: render.logo_sha256,
                  },
                ]),
          ]),
        ];

        return {
          exportedAt: new Date().toISOString(),
          // export-v10: credit notes and their counters (0051) join the
          // record.
          formatVersion: 'export-v10',
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
          issueChallans,
          issueChallanLines,
          workInstruments: instruments,
          extensionRequests,
          mbEntries,
          bills,
          installations,
          installationSerials,
          approvalRequests,
          correctionNotices,
          paymentMatrices,
          pacCertificates,
          pacCertificateItems,
          // Milestone 8 phase 2 (Measurement Book lifecycle). The
          // Measurement Book lifecycle records.
          measurementBooks,
          measurementBookLines,
          mbSources,
          measurementBookMergeProvenance,
          importBatches,
          importRecords,
          // M6/7 retrofit (migration 0028): unified Contacts master.
          contacts,
          workConsignees,
          locationMasters,
          unitMasters,
          gstRates,
          organisationSignatories,
          purchaseOrders,
          purchaseOrderLines,
          budgetaryQuotations,
          budgetaryQuotationLines,
          taxInvoices,
          taxInvoiceRenders,
          creditNotes,
          ewayBills,
          documentNumberSeries,
          statutoryProviderOperations,
          deliveryChallanCounters,
          billCounters,
          extensionRequestCounters,
          issueChallanCounters,
          correctionNoticeCounters,
          measurementBookCounters,
          purchaseOrderCounters,
          budgetaryQuotationCounters,
          taxInvoiceCounters,
          creditNoteCounters,
          objectManifest,
          auditEvents,
        };
      });
    },
  );
}

async function requireOwner(tx: TransactionSql, userId: string): Promise<void> {
  const [membership] = await tx<{ role: string }[]>`
    select role from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  if (membership?.role !== 'owner') {
    throw httpError(
      403,
      'OWNER_REQUIRED',
      'Only an organisation owner may export the organisation.',
    );
  }
}
