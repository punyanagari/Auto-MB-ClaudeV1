import {
  CancelTaxInvoiceRequestSchema,
  TaxInvoiceDetailResponseSchema,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { httpError } from '../../http.js';
import { cancellationNote } from '../challans.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  assertInvoiceWorkAccess,
  IRP_CANCEL_WINDOW_REMEDY,
  lockInvoice,
  readDetail,
  requireStatus,
} from './internal.js';

/** Cancelling an issued invoice: refused while IRP evidence or an e-way
 * bill is live, and it releases the Measurement Book it billed. The
 * number is kept forever (rule 8). */
export function registerTaxInvoiceCancelRoute(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/cancel',
      schema: {
        params: IdParamsSchema,
        body: CancelTaxInvoiceRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const note = cancellationNote(body.note);
      return tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.status === 'draft') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            'Draft tax invoices are deleted, not cancelled.',
          );
        }
        requireStatus(invoice, 'submitted');
        if (
          invoice.irp_provider_state !== 'not_requested' &&
          invoice.irp_provider_state !== 'cancelled'
        ) {
          throw httpError(
            409,
            'IRP_CANCELLATION_REQUIRED',
            invoice.irp_provider_state === 'registered' &&
              !invoice.irp_cancel_window_open
              ? `This invoice is registered at the IRP and NIC's 24-hour cancellation window has closed, so the IRN can no longer be cancelled. ${IRP_CANCEL_WINDOW_REMEDY}`
              : invoice.irp_provider_state === 'registered_unverified'
                ? `This invoice carries manually recorded (unverified) IRP registration evidence. Record the externally confirmed IRP cancellation if the IRN was cancelled on the portal within its window; otherwise: ${IRP_CANCEL_WINDOW_REMEDY}`
                : 'Resolve any pending/unknown registration and cancel confirmed IRP evidence before cancelling the local invoice.',
          );
        }
        // An e-way bill moves THIS invoice; cancelling the invoice under
        // a live movement document would leave the e-way bill moving a
        // cancelled supply. The e-way bill goes first.
        const [liveEwb] = await tx<{ id: string; ewb_number: string | null }[]>`
          select id, ewb_number from eway_bills
          where tax_invoice_id = ${id} and status <> 'cancelled'
        `;
        if (liveEwb) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `E-way bill ${liveEwb.ewb_number ?? liveEwb.id} still moves this invoice; cancel it first.`,
          );
        }
        await tx`
          update tax_invoices
          set status = 'cancelled', cancelled_by_user_id = ${user.id},
              cancelled_at = now(), cancellation_note = ${note}
          where id = ${id}
        `;
        // Cancelling releases the MB: the one-live index and the 0035
        // MB-cancel guard both ignore cancelled invoices, so a corrected
        // invoice can be raised and the MB can again be cancelled.
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.cancelled',
          'tax_invoices',
          id,
          {
            invoiceNumber: invoice.invoice_number,
            measurementBookId: invoice.measurement_book_id,
            note,
          },
        );
        return readDetail(tx, id);
      });
    },
  );
}
