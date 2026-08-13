import {
  CreateDirectTaxInvoiceRequestSchema,
  CreateTaxInvoiceRequestSchema,
  TaxInvoiceDetailResponseSchema,
  TaxInvoiceListResponseSchema,
  UpdateTaxInvoiceRequestSchema,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql } from '@auto-mb/db';
import { auditDiff } from '../../audit-diff.js';
import type { Auth } from '../../auth.js';
import { assertWorkAccess, requireWriterRole } from '../../authz.js';
import { nameDraftConflict } from '../../draft-conflict.js';
import { assertGstRateNotified } from '../../gst-rates.js';
import { httpError } from '../../http.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  assertBookUninvoiced,
  assertInvoiceDate,
  assertInvoiceDateNotFuture,
  assertInvoiceWorkAccess,
  auditLineSummary,
  documentFields,
  headerLineFields,
  lockInvoice,
  lockInvoiceableBook,
  readDetail,
  replaceInvoiceLines,
  requireBuyer,
  requireStatus,
  statedTaxableValueOfLines,
  TI_COLUMNS,
  TI_FROM,
  toInvoice,
} from './internal.js';
import type { InvoiceRow } from './internal.js';

/** Everything a tax invoice is before it becomes a legal document:
 * listing, creating (MB-backed and direct), reading, editing, and
 * deleting a draft. Nothing here assigns a number or freezes money. */
export function registerTaxInvoiceDraftingRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/works/:id/tax-invoices',
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceListResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id: workId } = request.params;
      const rows = await tenant(async (tx) => {
        await assertWorkAccess(tx, user.id, workId);
        const [work] = await tx<{ id: string }[]>`
            select id from works where id = ${workId} and deleted_at is null
          `;
        if (!work) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        return (await tx.unsafe(
          `select ${TI_COLUMNS} ${TI_FROM}
             where ti.work_id = $1
             order by ti.created_at desc, ti.id`,
          [workId],
        )) as unknown as InvoiceRow[];
      });
      return { invoices: rows.map(toInvoice) };
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/works/:id/tax-invoices',
      schema: {
        params: IdParamsSchema,
        body: CreateTaxInvoiceRequestSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id: workId } = request.params;
      const body = request.body;
      const header = headerLineFields(body);
      const document = documentFields(body);

      const detail = await tenant(async (tx) => {
        await requireWriterRole(tx, user.id);
        await assertInvoiceDateNotFuture(tx, body.invoiceDate);
        // The rate must be one the Government had notified on the
        // invoice date (gst_rates master, finding 19) — checked here so
        // a 1.8-instead-of-18 typo is a named 400, and re-checked at
        // submit because the date can change until then. An ITEMISED
        // invoice has no header rate; its per-line rates are checked by
        // replaceInvoiceLines below, line by line.
        if (header.gstRate !== null) {
          await assertGstRateNotified(tx, header.gstRate, body.invoiceDate);
        }
        await assertWorkAccess(tx, user.id, workId);
        const book = await lockInvoiceableBook(tx, workId, body.measurementBookId);
        assertInvoiceDate(body.invoiceDate, book);
        await requireBuyer(tx, body.buyerContactId);
        await assertBookUninvoiced(tx, book.id);

        const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, work_id, measurement_book_id, invoice_date,
              line_shape, sac_code, service_description, gst_rate,
              place_of_supply,
              reverse_charge_applicable, buyer_contact_id,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${workId}, ${body.measurementBookId},
              ${body.invoiceDate}, ${header.lineShape}, ${header.sacCode},
              ${header.serviceDescription},
              ${header.gstRate}, ${body.placeOfSupply},
              ${body.reverseChargeApplicable ?? null}, ${body.buyerContactId},
              ${document.customerPoReference}, ${document.unitLabel},
              ${document.notes}, ${document.shipToContactId},
              ${document.numberPrefix}, ${user.id}
            )
            returning id
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            // A concurrent create won the one-live-per-MB index race;
            // the transaction is aborted, so the route-level catch
            // names the winner from a fresh read.
            throw httpError(
              409,
              'TAX_INVOICE_EXISTS',
              'This Measurement Book already has a live tax invoice; cancel or delete it before raising another.',
            );
          }
          throw error;
        });
        if (!created) throw new Error('tax invoice insert returned no row');
        if (body.lineShape === 'itemised') {
          await replaceInvoiceLines(
            tx,
            organisationId,
            created.id,
            body.invoiceDate,
            body.lines,
          );
        }

        // `buyerContactId` in the details is the draft's buyer store —
        // see the module note. Always written, never diffed away.
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.created',
          'tax_invoices',
          created.id,
          {
            workId,
            measurementBookId: body.measurementBookId,
            mbNumber: book?.mb_number ?? null,
            buyerContactId: body.buyerContactId,
            invoiceDate: body.invoiceDate,
            lineShape: header.lineShape,
            sacCode: header.sacCode,
            gstRate: header.gstRate,
            lines: body.lineShape === 'itemised' ? auditLineSummary(body.lines) : null,
            placeOfSupply: body.placeOfSupply,
            reverseChargeApplicable: body.reverseChargeApplicable ?? null,
          },
        );
        return readDetail(tx, created.id);
      }).catch(async (error: unknown) => {
        throw await nameDraftConflict(error, 'TAX_INVOICE_EXISTS', () =>
          tenant(async (tx) => {
            const [row] = await tx<{ id: string }[]>`
              select id from tax_invoices
              where measurement_book_id = ${body.measurementBookId}
                and status not in ('cancelled', 'superseded')
            `;
            return row?.id ?? null;
          }),
        );
      });
      return reply.status(201).send(detail);
    },
  );

  // A DIRECT invoice: no Work, no Measurement Book, a stated taxable
  // value. Everything downstream — submit, the number, the GST split,
  // the IRP payload, the e-way bill — is the same code path, because the
  // only thing that differs is where the taxable value came from.
  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices',
      schema: {
        body: CreateDirectTaxInvoiceRequestSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const body = request.body;
      const header = headerLineFields(body);
      const document = documentFields(body);

      const detail = await tenant(async (tx) => {
        await assertInvoiceDateNotFuture(tx, body.invoiceDate);
        if (header.gstRate !== null) {
          await assertGstRateNotified(tx, header.gstRate, body.invoiceDate);
        }
        await requireBuyer(tx, body.buyerContactId);
        // A direct invoice has no Measurement Book, so the 0039 CHECK
        // makes it STATE its taxable value. An itemised one does not
        // state it twice: the lines already say what the supply is worth,
        // so the figure is summed from them in SQL numeric before the
        // header row exists.
        const taxableValue =
          body.lineShape === 'itemised'
            ? await statedTaxableValueOfLines(tx, body.lines)
            : body.taxableValue;
        const [created] = await tx<{ id: string }[]>`
            insert into tax_invoices (
              organisation_id, invoice_date, line_shape, sac_code,
              service_description,
              gst_rate, place_of_supply, stated_taxable_value,
              reverse_charge_applicable, buyer_contact_id,
              customer_po_reference, unit_label, notes, ship_to_contact_id,
              number_prefix, created_by_user_id
            )
            values (
              ${organisationId}, ${body.invoiceDate}, ${header.lineShape},
              ${header.sacCode},
              ${header.serviceDescription}, ${header.gstRate},
              ${body.placeOfSupply},
              ${taxableValue}, ${body.reverseChargeApplicable ?? null},
              ${body.buyerContactId},
              ${document.customerPoReference}, ${document.unitLabel},
              ${document.notes}, ${document.shipToContactId},
              ${document.numberPrefix}, ${user.id}
            )
            returning id
          `;
        if (!created) throw new Error('direct tax invoice insert returned no row');
        if (body.lineShape === 'itemised') {
          await replaceInvoiceLines(
            tx,
            organisationId,
            created.id,
            body.invoiceDate,
            body.lines,
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.created',
          'tax_invoices',
          created.id,
          {
            direct: true,
            lineShape: header.lineShape,
            taxableValue,
            lines: body.lineShape === 'itemised' ? auditLineSummary(body.lines) : null,
            reverseChargeApplicable: body.reverseChargeApplicable ?? null,
            buyerContactId: body.buyerContactId,
          },
        );
        return readDetail(tx, created.id);
      });
      return reply.code(201).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices/:id',
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }) => {
      const { id } = request.params;
      return tenant(async (tx) => {
        const [ref] = await tx<{ work_id: string | null }[]>`
          select work_id from tax_invoices where id = ${id}
        `;
        if (!ref) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        await assertInvoiceWorkAccess(tx, user.id, ref.work_id);
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'PUT',
      url: '/api/tax-invoices/:id',
      schema: {
        params: IdParamsSchema,
        body: UpdateTaxInvoiceRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const header = headerLineFields(body);
      const document = documentFields(body);
      return tenant(async (tx) => {
        await assertInvoiceDateNotFuture(tx, body.invoiceDate);
        if (header.gstRate !== null) {
          await assertGstRateNotified(tx, header.gstRate, body.invoiceDate);
        }
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'draft');
        // Billing cannot precede measurement — but only where there IS
        // measurement. A direct invoice has no Measurement Book to floor
        // its date against.
        if (invoice.work_id !== null && invoice.measurement_book_id !== null) {
          const book = await lockInvoiceableBook(
            tx,
            invoice.work_id,
            invoice.measurement_book_id,
          );
          assertInvoiceDate(body.invoiceDate, book);
        }
        await requireBuyer(tx, body.buyerContactId);
        // The lines are replaced BEFORE the header moves, so the 0057
        // deferred shape check never sees a cumulative header owning
        // lines (or the reverse) as the transaction's RESULT, and the
        // per-line rate guard judges every new line against the date the
        // update is setting.
        if (body.lineShape === 'itemised') {
          await replaceInvoiceLines(
            tx,
            organisationId,
            id,
            body.invoiceDate,
            body.lines,
          );
        } else if (invoice.line_shape === 'itemised') {
          await tx`delete from tax_invoice_lines where tax_invoice_id = ${id}`;
        }
        // A DIRECT invoice must keep stating a taxable value (0039); an
        // itemised one restates it from its new lines, in SQL numeric.
        const statedTaxableValue =
          invoice.measurement_book_id !== null
            ? null
            : body.lineShape === 'itemised'
              ? await statedTaxableValueOfLines(tx, body.lines)
              : invoice.stated_taxable_value;
        await tx`
          update tax_invoices
          set invoice_date = ${body.invoiceDate},
              line_shape = ${header.lineShape},
              sac_code = ${header.sacCode},
              service_description = ${header.serviceDescription},
              gst_rate = ${header.gstRate},
              stated_taxable_value = ${statedTaxableValue},
              place_of_supply = ${body.placeOfSupply},
              reverse_charge_applicable = ${body.reverseChargeApplicable ?? null},
              buyer_contact_id = ${body.buyerContactId},
              customer_po_reference = ${document.customerPoReference},
              unit_label = ${document.unitLabel}, notes = ${document.notes},
              ship_to_contact_id = ${document.shipToContactId},
              number_prefix = ${document.numberPrefix}
          where id = ${id}
        `;
        // The after-side re-reads the stored row so numbers compare in
        // their normalised numeric text ('18' arrives, '18.00' is what
        // the row — and therefore the trail — says).
        const [stored] = await tx<
          {
            invoice_date: string;
            line_shape: string;
            sac_code: string | null;
            service_description: string | null;
            gst_rate: string | null;
            place_of_supply: string;
          }[]
        >`
          select invoice_date::text as invoice_date, line_shape, sac_code,
                 service_description, gst_rate::text as gst_rate,
                 place_of_supply
          from tax_invoices where id = ${id}
        `;
        if (!stored) throw new Error('tax invoice vanished mid-update');
        const changes = auditDiff(
          {
            invoiceDate: invoice.invoice_date,
            lineShape: invoice.line_shape,
            sacCode: invoice.sac_code,
            serviceDescription: invoice.service_description,
            gstRate: invoice.gst_rate,
            placeOfSupply: invoice.place_of_supply,
            buyerContactId: invoice.buyer_contact_id,
          },
          {
            invoiceDate: stored.invoice_date,
            lineShape: stored.line_shape,
            sacCode: stored.sac_code,
            serviceDescription: stored.service_description,
            gstRate: stored.gst_rate,
            placeOfSupply: stored.place_of_supply,
            buyerContactId: body.buyerContactId,
          },
        );
        // buyerContactId rides top-level on EVERY update event — it is
        // the draft's buyer store, not a diff (see the module note).
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.updated',
          'tax_invoices',
          id,
          {
            before: changes.before,
            after: changes.after,
            buyerContactId: body.buyerContactId,
            lines: body.lineShape === 'itemised' ? auditLineSummary(body.lines) : null,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'DELETE',
      url: '/api/tax-invoices/:id',
      schema: {
        params: IdParamsSchema,
        response: { 204: Type.Null(), ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      await tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        // Rule 8: a draft is not yet a document, so it deletes — which
        // also releases the MB it would have billed (the one-live index
        // and the 0035 MB-cancel guard both stop seeing it).
        requireStatus(invoice, 'draft');
        // The lines are the draft's own; they go with it. The 0057
        // mutation guard permits this precisely because the parent is
        // still a draft, and the deferred shape check sees no invoice
        // left to judge.
        await tx`delete from tax_invoice_lines where tax_invoice_id = ${id}`;
        await tx`delete from tax_invoices where id = ${id}`;
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.deleted',
          'tax_invoices',
          id,
          {
            workId: invoice.work_id,
            measurementBookId: invoice.measurement_book_id,
          },
        );
      });
      return reply.status(204).send(null);
    },
  );
}
