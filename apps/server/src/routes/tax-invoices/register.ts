import {
  TaxInvoiceRegisterQuerySchema,
  TaxInvoiceRegisterResponseSchema,
  type TaxInvoice,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { hasFullWorkScope } from '../../authz.js';
import { keysetPage, sqlLimit, workScopedCursorRowId } from '../../pagination.js';
import { errorResponses } from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import { irpReportingOverdueSql } from './internal.js';

/**
 * The organisation-wide tax-invoice register.
 *
 * Invoices have always been reachable one Work at a time, which answers
 * "what has this contract billed" and cannot answer what the office
 * actually asks: what have we billed, to whom, and what is still
 * unregistered at the IRP. A DIRECT invoice — raised against a private
 * customer, with no Work behind it — could not be reached at all: the
 * server has drafted, numbered, rendered and registered them since
 * migration 0039, and no screen listed one.
 *
 * Reading only. Drafting a Work's invoice stays on the Work, because it
 * bills a finalized Measurement Book of that Work; drafting a DIRECT one
 * happens here, because there is no Work for it to happen on.
 *
 * The one filter is a date window over the invoice date, for the reason
 * `docs/UX.md` gives every global register: it carries the filter its
 * question needs and no more. Cancelled and superseded invoices stay
 * listed — a numbered document that was cancelled is exactly the kind of
 * fact a register must keep reporting.
 */
export function registerTaxInvoiceRegisterRoute(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices',
      schema: {
        querystring: TaxInvoiceRegisterQuerySchema,
        response: { 200: TaxInvoiceRegisterResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const query = request.query;
      return tenant(async (tx) => {
        // Work-scope, decided in SQL so the rows an 'assigned'-scoped
        // member may not see never leave the database. A list has no
        // per-row `assertInvoiceWorkAccess` to fall back on: this
        // predicate is the only boundary.
        //
        // A DIRECT invoice has no work_id, so `wa.work_id = ti.work_id`
        // is NULL for every candidate assignment, the EXISTS is false,
        // and the disjunct collapses to `full`. An 'assigned'-scoped
        // member therefore sees their assigned Works' invoices and
        // NOTHING direct — which is not an accident of three-valued
        // logic but the settled posture for a document that belongs to
        // no Work: the Delivery Challan register decides a standalone
        // challan exactly this way, and `assertStandaloneChallanAccess`
        // says the same thing on the write path. Work-scope binds
        // through a Work; a document with none is organisation-level
        // reach or nothing.
        const full = await hasFullWorkScope(tx, user.id);
        // Newest invoice date first, so the keyset runs BACKWARD on
        // (invoice_date, created_at, id) — the same ordering, and the
        // same trailing descending id, as the Delivery Challan and
        // installation registers. The cursor is proven against the
        // work-scope predicate as well as the tenant: see
        // `workScopedCursorRowId` for the oracle an organisation-wide
        // cursor check leaves behind.
        const cursor = await workScopedCursorRowId(tx, 'tax_invoices', query.cursor, {
          userId: user.id,
          full,
        });
        const invoicedFrom = query.invoicedFrom ?? null;
        const invoicedTo = query.invoicedTo ?? null;
        const rows = await tx<
          {
            id: string;
            work_id: string | null;
            work_code: string | null;
            work_title: string | null;
            invoice_number: string | null;
            invoice_date: string;
            status: TaxInvoice['status'];
            buyer_name: string;
            taxable_value: string | null;
            gst_amount: string | null;
            irn: string | null;
            irp_provider: TaxInvoice['irpProvider'];
            irp_provider_state: TaxInvoice['irpProviderState'];
            irp_reporting_deadline: string | null;
            irp_reporting_overdue: boolean;
          }[]
        >`
          select ti.id, ti.work_id, w.work_code, w.title as work_title,
                 ti.invoice_number, ti.invoice_date::text as invoice_date,
                 ti.status,
                 -- The buyer as the DOCUMENT states it: the frozen submit-time
                 -- snapshot wins, so the register line matches the printed and
                 -- filed invoice even after the contact master is edited. A
                 -- draft has no snapshot yet and falls back to the live
                 -- contact (the same order search.ts and challans.ts use).
                 coalesce(ti.buyer_snapshot->>'designation', c.designation, '')
                   as buyer_name,
                 ti.taxable_value::text as taxable_value,
                 -- The three heads summed in SQL numeric, never in
                 -- JavaScript (engineering rule 5). NULL while the
                 -- invoice is a draft, because none of them exist yet.
                 (ti.cgst_amount + ti.sgst_amount + ti.igst_amount)
                   ::numeric(18,2)::text as gst_amount,
                 ti.irn, ti.irp_provider, ti.irp_provider_state,
                 ti.irp_reporting_deadline::text as irp_reporting_deadline,
                 -- The frozen reporting window (migration 0049): the SAME
                 -- fragment TI_COLUMNS derives, spliced in as trusted static
                 -- SQL, so the register and the document cannot disagree
                 -- about an overdue one and cannot drift as copies could.
                 ${tx.unsafe(irpReportingOverdueSql('ti'))}
                   as irp_reporting_overdue
          from tax_invoices ti
          -- LEFT joins throughout: a direct invoice names no Work, and an
          -- inner join would hide from the register the very rows it was
          -- built to surface.
          left join works w on w.id = ti.work_id
          left join contacts c on c.id = ti.buyer_contact_id
          where (ti.work_id is null or w.deleted_at is null)
            and (${full} or exists (
              select 1 from work_assignments wa
              where wa.work_id = ti.work_id and wa.user_id = ${user.id}
            ))
            -- The date window, both bounds inclusive and either omittable.
            and (${invoicedFrom}::date is null
              or ti.invoice_date >= ${invoicedFrom}::date)
            and (${invoicedTo}::date is null
              or ti.invoice_date <= ${invoicedTo}::date)
            and (${cursor === null} or
              (ti.invoice_date, ti.created_at, ti.id) < (
                select c2.invoice_date, c2.created_at, c2.id from tax_invoices c2
                where c2.id = ${cursor}))
          order by ti.invoice_date desc, ti.created_at desc, ti.id desc
          limit ${sqlLimit(query.limit)}
        `;
        const paged = keysetPage(rows, query.limit, (row) => row.id);
        return {
          nextCursor: paged.nextCursor,
          invoices: paged.rows.map((row) => ({
            id: row.id,
            workId: row.work_id,
            workCode: row.work_code,
            workTitle: row.work_title,
            invoiceNumber: row.invoice_number,
            invoiceDate: row.invoice_date,
            status: row.status,
            buyerName: row.buyer_name,
            taxableValue: row.taxable_value,
            gstAmount: row.gst_amount,
            irn: row.irn,
            irpProvider: row.irp_provider,
            irpProviderState: row.irp_provider_state,
            irpReportingDeadline: row.irp_reporting_deadline,
            irpReportingOverdue: row.irp_reporting_overdue,
          })),
        };
      });
    },
  );
}
