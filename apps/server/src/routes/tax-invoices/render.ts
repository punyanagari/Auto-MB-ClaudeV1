import { TaxInvoiceDetailResponseSchema } from '@auto-mb/contracts';
import { createHash } from 'node:crypto';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { httpError } from '../../http.js';
import { parseJsonbColumn } from '../../jsonb-column.js';
import type { ObjectStorage } from '../../storage.js';
import {
  renderTaxInvoiceHtml,
  TAX_INVOICE_PDF_TEMPLATE_VERSION,
  type TaxInvoiceIrpRenderEvidence,
} from '../../tax-invoice-html.js';
import { parseTaxInvoiceIssuedSnapshot } from '../../tax-invoice-snapshot.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import { renderPdfViaGotenberg } from '../../pdf-render.js';
import {
  assertInvoiceWorkAccess,
  invoiceRenderSourceHash,
  lockInvoice,
  readDetail,
  requireStatus,
} from './internal.js';

/** The invoice PDF: rendered from the frozen issued snapshot (never from
 * live tables), with the branding logo frozen alongside it, and streamed
 * back only when the retained bytes still match their recorded digest. */
export function registerTaxInvoiceRenderRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/render',
      schema: {
        params: IdParamsSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;

      // Read immutable render inputs in one short transaction. Gotenberg and
      // object storage run without a database lock; a second transaction
      // verifies that the append-only IRP evidence did not change meanwhile.
      const prepared = await tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'submitted');
        const [source] = await tx<
          {
            issued_snapshot: unknown;
            signed_qr: string | null;
          }[]
        >`
            select issued_snapshot, signed_qr
            from tax_invoices where id = ${id}
          `;
        const [organisation] = await tx<
          { logo_object_key: string | null; logo_media_type: string | null }[]
        >`
            select logo_object_key, logo_media_type from organisations
            where id = app_private.current_organisation_id()
          `;
        if (!source) throw new Error('tax invoice render source disappeared');
        const snapshot = parseTaxInvoiceIssuedSnapshot(
          parseJsonbColumn(source.issued_snapshot),
        );
        const evidence: TaxInvoiceIrpRenderEvidence = {
          provider: invoice.irp_provider,
          irn: invoice.irn,
          ackNumber: invoice.ack_number,
          ackDateText: invoice.ack_date_text,
          signedQr: source.signed_qr,
          legacyEvidenceMissing: invoice.irp_legacy_evidence_missing,
        };
        return {
          snapshot,
          evidence,
          logoObjectKey: organisation?.logo_object_key ?? null,
          logoMediaType: organisation?.logo_media_type ?? null,
        };
      });

      let logoDataUri: string | undefined;
      let logoBytes: Buffer | null = null;
      let logoSha256: string | null = null;
      let frozenLogoObjectKey: string | null = null;
      if (prepared.logoObjectKey !== null && prepared.logoMediaType !== null) {
        try {
          logoBytes = await storage.get(prepared.logoObjectKey);
          logoSha256 = createHash('sha256').update(logoBytes).digest('hex');
          const extension = prepared.logoMediaType === 'image/png' ? 'png' : 'jpg';
          frozenLogoObjectKey = `${organisationId}/ti/${id}-logo-${logoSha256.slice(0, 16)}.${extension}`;
          logoDataUri = `data:${prepared.logoMediaType};base64,${logoBytes.toString('base64')}`;
        } catch (error) {
          request.log.error({ err: error }, 'tax invoice render: logo unavailable');
          throw httpError(
            502,
            'RENDER_BRANDING_UNAVAILABLE',
            'The configured logo could not be frozen for this invoice render. The submitted invoice is unaffected.',
          );
        }
      }
      const renderSourceHash = invoiceRenderSourceHash(
        prepared.snapshot,
        prepared.evidence,
        {
          logoSha256,
          logoMediaType: logoSha256 === null ? null : prepared.logoMediaType,
        },
      );

      let html: string;
      try {
        html = await renderTaxInvoiceHtml(
          prepared.snapshot,
          prepared.evidence,
          logoDataUri === undefined ? {} : { logoDataUri },
        );
      } catch (error) {
        request.log.error({ err: error }, 'tax invoice render input failed');
        throw httpError(
          409,
          'TAX_INVOICE_RENDER_INPUT_INVALID',
          'The frozen invoice or signed QR evidence cannot be rendered safely.',
        );
      }

      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        failureMessage:
          'The PDF service is unavailable; the submitted invoice is unaffected — retry later.',
        logError: (error) => {
          request.log.error({ err: error }, 'tax invoice render failed');
        },
      });

      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const objectKey = `${organisationId}/ti/${id}-${sha256.slice(0, 16)}.pdf`;
      try {
        if (frozenLogoObjectKey !== null && logoBytes !== null) {
          await storage.put(frozenLogoObjectKey, logoBytes);
        }
        await storage.put(objectKey, pdf);
      } catch (error) {
        request.log.error({ err: error }, 'tax invoice render storage failed');
        throw httpError(
          502,
          'RENDER_STORAGE_FAILED',
          'The rendered PDF could not be stored. The submitted invoice and previous PDF remain unaffected.',
        );
      }

      return tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'submitted');
        const [source] = await tx<
          { issued_snapshot: unknown; signed_qr: string | null }[]
        >`
          select issued_snapshot, signed_qr from tax_invoices where id = ${id}
        `;
        if (!source) throw new Error('tax invoice render source disappeared');
        const currentSnapshot = parseTaxInvoiceIssuedSnapshot(
          parseJsonbColumn(source.issued_snapshot),
        );
        const currentEvidence: TaxInvoiceIrpRenderEvidence = {
          provider: invoice.irp_provider,
          irn: invoice.irn,
          ackNumber: invoice.ack_number,
          ackDateText: invoice.ack_date_text,
          signedQr: source.signed_qr,
          legacyEvidenceMissing: invoice.irp_legacy_evidence_missing,
        };
        if (
          invoiceRenderSourceHash(currentSnapshot, currentEvidence, {
            logoSha256,
            logoMediaType: logoSha256 === null ? null : prepared.logoMediaType,
          }) !== renderSourceHash
        ) {
          throw httpError(
            409,
            'TAX_INVOICE_RENDER_SOURCE_CHANGED',
            'IRP evidence changed while the invoice was rendering; the previous PDF remains current — render again.',
          );
        }
        const [nextRender] = await tx<{ version: number }[]>`
          select coalesce(max(version), 0)::int + 1 as version
          from tax_invoice_renders where tax_invoice_id = ${id}
        `;
        if (!nextRender) throw new Error('tax invoice render version query failed');
        await tx`
          insert into tax_invoice_renders (
            organisation_id, tax_invoice_id, version, template_version,
            template_contract_legacy, source_sha256,
            object_key_scope_missing, logo_evidence_missing,
            logo_object_key, logo_sha256, logo_media_type,
            object_key, pdf_sha256, created_by_user_id
          )
          values (
            ${organisationId}, ${id}, ${nextRender.version},
            ${TAX_INVOICE_PDF_TEMPLATE_VERSION}, false, ${renderSourceHash},
            false, false,
            ${frozenLogoObjectKey}, ${logoSha256},
            ${logoSha256 === null ? null : prepared.logoMediaType},
            ${objectKey}, ${sha256}, ${user.id}
          )
        `;
        await tx`
          update tax_invoices
          set template_version = ${TAX_INVOICE_PDF_TEMPLATE_VERSION},
              rendered_object_key = ${objectKey}, rendered_sha256 = ${sha256}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.rendered',
          'tax_invoices',
          id,
          {
            sha256,
            renderVersion: nextRender.version,
            sourceSha256: renderSourceHash,
            logoSha256,
            templateVersion: TAX_INVOICE_PDF_TEMPLATE_VERSION,
            irpEvidenceIncluded: currentEvidence.irn !== null,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices/:id/pdf',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const rendered = await tenant(async (tx) => {
        const [invoice] = await tx<
          {
            work_id: string | null;
            rendered_object_key: string | null;
            rendered_sha256: string | null;
            object_key_scope_missing: boolean | null;
          }[]
        >`
          select invoice.work_id, invoice.rendered_object_key,
                 invoice.rendered_sha256, latest.object_key_scope_missing
          from tax_invoices invoice
          left join lateral (
            select render.object_key_scope_missing
            from tax_invoice_renders render
            where render.tax_invoice_id = invoice.id
            order by render.version desc
            limit 1
          ) latest on true
          where invoice.id = ${id}
      `;
        if (!invoice) {
          throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        }
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.rendered_object_key === null || invoice.rendered_sha256 === null) {
          throw httpError(
            404,
            'PDF_NOT_AVAILABLE',
            'This tax invoice has not been rendered yet.',
          );
        }
        if (invoice.object_key_scope_missing !== false) {
          throw httpError(
            409,
            'RENDERED_PDF_SCOPE_UNVERIFIED',
            'This compatibility render has no verified tenant-scoped object key.',
          );
        }
        return { key: invoice.rendered_object_key, sha256: invoice.rendered_sha256 };
      });
      const bytes = await storage.get(rendered.key);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== rendered.sha256) {
        throw httpError(
          409,
          'RENDERED_PDF_INTEGRITY_FAILED',
          'The retained tax-invoice PDF no longer matches its recorded digest.',
        );
      }
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="tax-invoice-${id}.pdf"`,
      );
      return reply.send(bytes);
    },
  );
}
