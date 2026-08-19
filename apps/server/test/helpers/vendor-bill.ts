import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from '@auto-mb/db';

/**
 * The evidence a purchase order needs before it will close (owner ruling
 * 2026-08-19, migration 0109): one live vendor tax invoice pointing at
 * the order and carrying its uploaded document.
 *
 * Written with ADMIN SQL rather than through the routes, which is the
 * posture every other cross-cutting fixture in these suites takes. The
 * routes that record and upload it are proved end to end in
 * `purchase-orders.integration.test.ts` and
 * `payments.integration.test.ts`; the suites that call this one are about
 * something else entirely — a correction, a shortage conversion, a Work's
 * lifecycle — and the bill is a precondition they need rather than a
 * subject they test.
 *
 * The object key carries the tenant prefix the column's own CHECK
 * demands, and no bytes are stored: nothing in these suites fetches the
 * document back, and a fixture that wrote a real object would need a
 * storage directory each of them would then have to own.
 *
 * VENDOR AND WORK ARE READ OFF THE ORDER, not chosen. The close guard
 * requires the invoice to be billed by the order's own vendor and
 * attributed to the order's own Work, and a fixture that seeded a
 * dishonest row would be a fixture that has to be relaxed the moment the
 * rule is enforced — which is exactly how this one was found violating
 * the Work rule three suites wide.
 */
export async function billPurchaseOrder(
  admin: Sql,
  purchaseOrderId: string,
  userId: string,
): Promise<string> {
  const objectKey = randomUUID();
  const [row] = await admin<{ id: string }[]>`
    insert into vendor_invoices (
      organisation_id, vendor_contact_id, invoice_number, invoice_date,
      credit_days, amount, work_id, purchase_order_id, object_key,
      original_filename, document_sha256, document_media_type,
      document_size_bytes, document_uploaded_at,
      document_uploaded_by_user_id, recorded_by_user_id
    )
    select po.organisation_id, po.vendor_contact_id,
           ${`VI-${objectKey.slice(0, 8)}`}, po.po_date, 30,
           greatest(coalesce(po.total_amount, 0), 1)::money_amount,
           po.work_id, po.id,
           po.organisation_id::text || '/vendorinvoice/' || ${objectKey} || '.pdf',
           'vendor-invoice.pdf',
           ${createHash('sha256').update(objectKey).digest('hex')},
           'application/pdf', 1024, now(), ${userId}, ${userId}
    from purchase_orders po where po.id = ${purchaseOrderId}
    returning id
  `;
  if (row === undefined) {
    throw new Error(`no purchase order ${purchaseOrderId} to bill against`);
  }
  return row.id;
}
