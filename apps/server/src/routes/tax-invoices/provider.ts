import {
  CancelStatutoryDocumentRequestSchema,
  RecordIrpResponseRequestSchema,
  RecordManualStatutoryCancellationRequestSchema,
  TaxInvoiceDetailResponseSchema,
  type TaxInvoiceStatus,
} from '@auto-mb/contracts';
import type { Sql } from '@auto-mb/db';
import type { Auth } from '../../auth.js';
import { requireAuthority } from '../../authz.js';
import { stringifyStatutoryJson } from '../../gsp/statutory-json.js';
import {
  finishStatutoryOperation,
  providerFailure,
  recoverStaleStatutoryOperation,
  sha256Hex,
  startStatutoryOperation,
} from '../../gsp/provider-operations.js';
import type {
  IrpDocumentIdentity,
  IrpRegistrationEvidence,
  StatutoryProvider,
} from '../../gsp/statutory-provider.js';
import { httpError } from '../../http.js';
import { parseJsonbColumn } from '../../jsonb-column.js';
import {
  buildFrozenIrpPayload,
  EInvoiceB2cUnsupportedError,
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
} from '../../tax-invoice-snapshot.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  assertInvoiceWorkAccess,
  assertIrpCancelWindowOpen,
  assertReportingWindowOpen,
  IRP_CANCEL_WINDOW_REMEDY,
  lockInvoice,
  readDetail,
  requireEinvoiceDeclared,
  requireStatus,
} from './internal.js';

/** The IRP transport: Whitebooks registration and cancellation, the
 * stale-operation recovery door, the manual compatibility evidence
 * paths, and the frozen payload the invoice would report. */
export function registerTaxInvoiceProviderRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  provider?: StatutoryProvider,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/recover-provider-operation',
      schema: {
        params: IdParamsSchema,
        response: { 202: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.irp_provider_state === 'registering') {
          await requireAuthority(tx, user.id, 'issue');
        } else if (invoice.irp_provider_state === 'cancelling') {
          await requireAuthority(tx, user.id, 'cancel');
        } else {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            'Only an in-progress IRP provider operation can be checked for stale recovery.',
          );
        }
        const recovered = await recoverStaleStatutoryOperation(tx, {
          taxInvoiceId: id,
        });
        if (recovered.length === 0) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'The provider operation is still within its two-minute lease.',
          );
        }
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.provider_operation_recovered',
          'tax_invoices',
          id,
          { operations: recovered },
        );
        return readDetail(tx, id);
      });
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/register-irp',
      schema: {
        params: IdParamsSchema,
        response: {
          200: TaxInvoiceDetailResponseSchema,
          202: TaxInvoiceDetailResponseSchema,
          ...errorResponses,
        },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;

      const prepared = await tenant(async (tx) => {
        await recoverStaleStatutoryOperation(tx, { taxInvoiceId: id });
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured. Use the explicitly unverified manual compatibility flow or configure deployment secrets.',
          );
        }
        requireStatus(invoice, 'submitted');
        if (invoice.irp_provider_state === 'registered' || invoice.irn !== null) {
          throw httpError(
            409,
            'IRP_ALREADY_RECORDED',
            `This invoice already carries IRN ${invoice.irn ?? '(registered)'}; registration is not repeated.`,
          );
        }
        if (
          invoice.irp_provider_state === 'registering' ||
          invoice.irp_provider_state === 'cancelling'
        ) {
          throw httpError(
            409,
            'STATUTORY_OPERATION_IN_PROGRESS',
            'A statutory-provider operation is already in progress for this invoice.',
          );
        }
        if (
          invoice.irp_provider_state === 'cancelled' ||
          invoice.irp_provider_state === 'cancellation_unknown'
        ) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            `IRP registration cannot start from ${invoice.irp_provider_state}.`,
          );
        }
        const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices where id = ${id}
          `;
        if (!snapshotRow) throw new Error(`tax invoice ${id} disappeared while locked`);
        let snapshot: ReturnType<typeof parseTaxInvoiceIssuedSnapshot>;
        let payloadJson: string;
        try {
          const issued = parseJsonbColumn(snapshotRow.issued_snapshot);
          snapshot = parseTaxInvoiceIssuedSnapshot(issued);
          payloadJson = stringifyStatutoryJson(buildFrozenIrpPayload(issued));
        } catch (error) {
          if (error instanceof EInvoiceB2cUnsupportedError) {
            throw httpError(409, error.code, error.message);
          }
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(
              409,
              error.code,
              'The frozen issued invoice is incomplete for IRP submission; live master data was not substituted.',
            );
          }
          throw error;
        }
        if (snapshot.buyer.gstin === null) {
          throw httpError(
            409,
            'E_INVOICE_B2C_UNSUPPORTED',
            'This adapter registers only B2B invoices with a frozen buyer GSTIN.',
          );
        }
        const identity: IrpDocumentIdentity = {
          gstin: snapshot.supplier.gstin,
          documentNumber: snapshot.invoiceNumber,
          documentDate: snapshot.invoiceDate,
        };
        const reconcileOnly = invoice.irp_provider_state === 'registration_unknown';
        const requestBody = reconcileOnly
          ? stringifyStatutoryJson(identity)
          : payloadJson;
        // The applicability and window gates (finding 20), before any
        // provider operation is opened: undeclared and not-applicable
        // organisations never reach the transport at all, and a fresh
        // registration past the frozen deadline is refused — but a
        // reconcile-by-lookup of an unknown earlier attempt still
        // runs, because learning what already happened is not a new
        // report.
        const today = await requireEinvoiceDeclared(tx);
        if (!reconcileOnly) assertReportingWindowOpen(invoice, today);
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: reconcileOnly ? 'reconcile_irp' : 'register_irp',
          requestSha256: sha256Hex(requestBody),
          requestBody,
          taxInvoiceId: id,
        });
        await tx`
            update tax_invoices
            set irp_provider = 'whitebooks', irp_provider_state = 'registering'
            where id = ${id}
          `;
        return { operationId, identity, payloadJson, reconcileOnly, provider };
      });

      let evidence: IrpRegistrationEvidence | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      if (prepared.reconcileOnly) {
        try {
          evidence = await prepared.provider.findInvoiceByDocument(prepared.identity);
          if (evidence === null) {
            failure = {
              status: 'unknown',
              providerCode: null,
              httpStatus: null,
              publicCode: 'WHITEBOOKS_IRP_NOT_FOUND',
              rawResponse: null,
            };
          }
        } catch (error) {
          const foundFailure = providerFailure(error);
          failure = { ...foundFailure, status: 'unknown' };
        }
      } else {
        try {
          evidence = await prepared.provider.registerInvoice(
            prepared.identity,
            prepared.payloadJson,
          );
        } catch (error) {
          const registrationFailure = providerFailure(error);
          if (registrationFailure.status === 'unknown') {
            try {
              evidence = await prepared.provider.findInvoiceByDocument(
                prepared.identity,
              );
              if (evidence === null) failure = registrationFailure;
            } catch (lookupError) {
              const lookupFailure = providerFailure(lookupError);
              failure = {
                ...lookupFailure,
                status: 'unknown',
                publicCode: registrationFailure.publicCode,
              };
            }
          } else {
            failure = registrationFailure;
          }
        }
      }

      const detail = await tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.irp_provider_state !== 'registering') {
          throw new Error(`tax invoice ${id} left the registering state`);
        }
        if (evidence !== null) {
          await tx`
              update tax_invoices
              set irn = ${evidence.irn}, ack_number = ${evidence.ackNumber},
                  ack_date = ${evidence.ackDate},
                  ack_date_text = ${evidence.ackDateText},
                  signed_qr = ${evidence.signedQr},
                  signed_invoice = ${evidence.signedInvoice},
                  irp_provider = 'whitebooks', irp_provider_state = 'registered'
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
            responseBody: evidence.rawResponse,
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'tax_invoice.irp_registered',
            'tax_invoices',
            id,
            {
              invoiceNumber: invoice.invoice_number,
              irn: evidence.irn,
              ackNumber: evidence.ackNumber,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
            rawResponse: null,
          };
          await tx`
              update tax_invoices
              set irp_provider = 'whitebooks',
                  irp_provider_state = ${
                    result.status === 'failed'
                      ? 'registration_failed'
                      : 'registration_unknown'
                  }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
            responseBody: result.rawResponse,
          });
          await audit(
            tx,
            organisationId,
            user.id,
            'tax_invoice.irp_registration_unresolved',
            'tax_invoices',
            id,
            {
              invoiceNumber: invoice.invoice_number,
              outcome: result.status,
              providerCode: result.providerCode,
              provider: prepared.provider.name,
              operationId: prepared.operationId,
            },
          );
        }
        return readDetail(tx, id);
      });

      if (evidence !== null) return reply.status(200).send(detail);
      const result = failure ?? {
        status: 'unknown' as const,
        publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
      };
      if (result.status === 'failed') {
        throw httpError(
          502,
          result.publicCode,
          'Whitebooks rejected the IRP registration. The invoice remains issued locally and unregistered at the IRP.',
        );
      }
      return reply.status(202).send(detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/cancel-irp',
      schema: {
        params: IdParamsSchema,
        body: CancelStatutoryDocumentRequestSchema,
        response: {
          200: TaxInvoiceDetailResponseSchema,
          202: TaxInvoiceDetailResponseSchema,
          ...errorResponses,
        },
      },
      authority: 'cancel',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      const prepared = await tenant(async (tx) => {
        const recoveredOperations = await recoverStaleStatutoryOperation(tx, {
          taxInvoiceId: id,
        });
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'submitted');
        if (
          invoice.irp_provider_state === 'cancellation_unknown' &&
          recoveredOperations.includes('cancel_irp')
        ) {
          return {
            recovered: true as const,
            detail: await readDetail(tx, id),
          };
        }
        if (provider === undefined) {
          throw httpError(
            409,
            'STATUTORY_PROVIDER_NOT_CONFIGURED',
            'Whitebooks transport is not configured.',
          );
        }
        if (
          invoice.irn === null ||
          invoice.irp_provider !== 'whitebooks' ||
          invoice.irp_provider_state !== 'registered'
        ) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            invoice.irp_provider_state === 'cancellation_unknown'
              ? 'The earlier cancellation result is unknown. It cannot be sent again blindly; reconcile it with Whitebooks/NIC support.'
              : 'Only a Whitebooks-registered IRN can be cancelled through this action.',
          );
        }
        // Window honesty BEFORE a provider operation is opened: past
        // NIC's 24 hours the cancellation cannot lawfully succeed, and
        // the refusal names the credit-note remedy.
        assertIrpCancelWindowOpen(invoice);
        const [liveEwayBill] = await tx<{ id: string; ewb_number: string | null }[]>`
            select id, ewb_number from eway_bills
            where tax_invoice_id = ${id} and status <> 'cancelled'
            limit 1
          `;
        if (liveEwayBill) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `Cancel e-way bill ${liveEwayBill.ewb_number ?? liveEwayBill.id} before cancelling its IRN.`,
          );
        }
        const [snapshotRow] = await tx<{ issued_snapshot: unknown }[]>`
            select issued_snapshot from tax_invoices where id = ${id}
          `;
        if (!snapshotRow) throw new Error(`tax invoice ${id} disappeared`);
        const gstin = parseTaxInvoiceIssuedSnapshot(
          parseJsonbColumn(snapshotRow.issued_snapshot),
        ).supplier.gstin;
        const requestJson = stringifyStatutoryJson({
          Irn: invoice.irn,
          CnlRsn: body.reasonCode,
          CnlRem: remark,
        });
        const operationId = await startStatutoryOperation(tx, {
          organisationId,
          userId: user.id,
          provider,
          operation: 'cancel_irp',
          requestSha256: sha256Hex(requestJson),
          requestBody: requestJson,
          taxInvoiceId: id,
        });
        await tx`
            update tax_invoices set irp_provider_state = 'cancelling'
            where id = ${id}
          `;
        return {
          recovered: false as const,
          operationId,
          irn: invoice.irn,
          gstin,
          provider,
        };
      });

      if (prepared.recovered) {
        return reply.status(202).send(prepared.detail);
      }

      let cancelled: {
        readonly cancelledAtText: string;
        readonly cancelledAt: string;
        readonly rawResponse: string;
      } | null = null;
      let failure: ReturnType<typeof providerFailure> | null = null;
      try {
        cancelled = await prepared.provider.cancelInvoice({
          gstin: prepared.gstin,
          irn: prepared.irn,
          reasonCode: body.reasonCode,
          remark,
        });
      } catch (error) {
        failure = providerFailure(error);
      }

      const outcome = await tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.irp_provider_state !== 'cancelling') {
          throw new Error(`tax invoice ${id} left the cancelling state`);
        }
        // For mapping a provider window-expired refusal below: the row
        // is mid-cancel here, so the derived open flag is unusable —
        // judge by the frozen closing instant itself.
        const windowClosed =
          invoice.irp_cancel_window_closes_at === null ||
          invoice.irp_cancel_window_closes_at.getTime() <= Date.now();
        if (cancelled !== null) {
          await tx`
              update tax_invoices
              set irp_provider_state = 'cancelled',
                  irp_cancelled_at = ${cancelled.cancelledAt},
                  irp_cancelled_at_text = ${cancelled.cancelledAtText},
                  irp_cancel_reason_code = ${body.reasonCode},
                  irp_cancel_remark = ${remark}
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: 'succeeded',
            responseBody: cancelled.rawResponse,
          });
        } else {
          const result = failure ?? {
            status: 'unknown' as const,
            providerCode: null,
            httpStatus: null,
            rawResponse: null,
          };
          await tx`
              update tax_invoices
              set irp_provider_state = ${
                result.status === 'failed' ? 'registered' : 'cancellation_unknown'
              }
              where id = ${id}
            `;
          await finishStatutoryOperation(tx, prepared.operationId, {
            status: result.status,
            providerCode: result.providerCode,
            httpStatus: result.httpStatus,
            responseBody: result.rawResponse,
          });
        }
        await audit(
          tx,
          organisationId,
          user.id,
          cancelled === null
            ? 'tax_invoice.irp_cancellation_unresolved'
            : 'tax_invoice.irp_cancelled',
          'tax_invoices',
          id,
          {
            irn: prepared.irn,
            outcome: cancelled === null ? (failure?.status ?? 'unknown') : 'succeeded',
            provider: prepared.provider.name,
            operationId: prepared.operationId,
          },
        );
        return { detail: await readDetail(tx, id), windowClosed };
      });
      if (cancelled !== null) return reply.status(200).send(outcome.detail);
      if (failure?.status === 'failed') {
        // The pre-check refuses before the window closes by OUR clock;
        // a definitive provider refusal after which the window has (by
        // now) closed is the provider's own window-expired failure —
        // name the lawful remedy instead of a bare 502.
        if (outcome.windowClosed) {
          throw httpError(
            409,
            'IRP_CANCEL_WINDOW_CLOSED',
            `Whitebooks/NIC refused the IRN cancellation and the 24-hour window has closed. The IRN remains registered. ${IRP_CANCEL_WINDOW_REMEDY}`,
          );
        }
        throw httpError(
          502,
          failure.publicCode,
          'Whitebooks rejected the IRP cancellation. The IRN remains registered.',
        );
      }
      return reply.status(202).send(outcome.detail);
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/irp-response',
      schema: {
        params: IdParamsSchema,
        body: RecordIrpResponseRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      return tenant(async (tx) => {
        // Compatibility import only. Manually typed evidence is labelled
        // unverified and requires the same authority as provider registration.
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (provider !== undefined) {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_DISABLED',
            'Manual IRP evidence entry is disabled while Whitebooks transport is configured.',
          );
        }
        requireStatus(invoice, 'submitted');
        // The IRP answers once per document: a second recording would
        // overwrite the registered IRN with something else.
        if (invoice.irn !== null) {
          throw httpError(
            409,
            'IRP_ALREADY_RECORDED',
            `This invoice already carries IRN ${invoice.irn}; the IRP response is recorded once.`,
          );
        }
        if (
          invoice.irp_provider !== null ||
          invoice.irp_provider_state !== 'not_requested'
        ) {
          throw httpError(
            409,
            'MANUAL_PROVIDER_EVIDENCE_CONFLICT',
            'Manual IRP evidence cannot replace or complete an existing provider attempt.',
          );
        }
        // The same applicability and window gates as the provider route
        // (finding 20): the manual compatibility door is still the IRP
        // transport, and must not become the way around the declaration.
        // This path only ever records a FRESH registration (the state
        // conflict above pins not_requested), so the window gate is
        // unconditional here.
        const today = await requireEinvoiceDeclared(tx);
        assertReportingWindowOpen(invoice, today);
        // The distinct manually-recorded state (migration 0053): behaves
        // as registered for local rules but is excluded from every
        // provider-verified claim and renders as unverified.
        await tx`
          update tax_invoices
          set irn = ${body.irn}, ack_number = ${body.ackNumber.trim()},
              ack_date = ${body.ackDate}, ack_date_text = ${body.ackDateText.trim()},
              signed_qr = ${body.signedQr},
              signed_invoice = ${body.signedInvoice ?? null},
              irp_provider = 'manual', irp_provider_state = 'registered_unverified'
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.irp_recorded',
          'tax_invoices',
          id,
          {
            invoiceNumber: invoice.invoice_number,
            irn: body.irn,
            ackNumber: body.ackNumber.trim(),
            ackDate: body.ackDate,
            evidence: 'manual_unverified',
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/irp-cancel-response',
      schema: {
        params: IdParamsSchema,
        body: RecordManualStatutoryCancellationRequestSchema,
        response: { 200: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      authority: 'cancel',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const body = request.body;
      const remark = body.remark.trim();
      return tenant(async (tx) => {
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.status !== 'submitted' && invoice.status !== 'cancelled') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            'Only an issued tax invoice can receive external IRP cancellation evidence.',
          );
        }
        const manualActive =
          invoice.irp_provider === 'manual' &&
          (invoice.irp_provider_state === 'registered_unverified' ||
            invoice.irp_provider_state === 'cancellation_unknown');
        const whitebooksUnknown =
          invoice.irp_provider === 'whitebooks' &&
          invoice.irp_provider_state === 'cancellation_unknown';
        if (invoice.irn === null || (!manualActive && !whitebooksUnknown)) {
          throw httpError(
            409,
            'IRP_STATE_CONFLICT',
            'External cancellation evidence is accepted only for manual IRP records or an unresolved Whitebooks cancellation.',
          );
        }
        const [liveEwayBill] = await tx<{ id: string; ewb_number: string | null }[]>`
          select id, ewb_number from eway_bills
          where tax_invoice_id = ${id} and status <> 'cancelled'
          limit 1
        `;
        if (liveEwayBill) {
          throw httpError(
            409,
            'EWAY_BILL_LIVE',
            `Cancel e-way bill ${liveEwayBill.ewb_number ?? liveEwayBill.id} before recording IRP cancellation.`,
          );
        }
        await tx`
          update tax_invoices
          set irp_provider_state = 'cancelled',
              irp_cancelled_at = ${body.cancelledAt},
              irp_cancelled_at_text = ${body.cancelledAtText.trim()},
              irp_cancel_reason_code = ${body.reasonCode},
              irp_cancel_remark = ${remark}
          where id = ${id}
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.irp_cancellation_recorded',
          'tax_invoices',
          id,
          {
            irn: invoice.irn,
            cancelledAt: body.cancelledAt,
            evidence: 'manual_unverified',
            reconciledProviderUnknown: whitebooksUnknown,
          },
        );
        return readDetail(tx, id);
      });
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tax-invoices/:id/irp-payload',
      schema: { params: IdParamsSchema },
    },
    async ({ request, reply, user, tenant }) => {
      const { id } = request.params;
      const payload = await tenant(async (tx) => {
        const [invoice] = await tx<
          {
            work_id: string | null;
            status: TaxInvoiceStatus;
            issued_snapshot: unknown;
          }[]
        >`
          select work_id, status, issued_snapshot
          from tax_invoices where id = ${id}
        `;
        if (!invoice) {
          throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');
        }
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        if (invoice.status !== 'submitted') {
          throw httpError(
            409,
            'TAX_INVOICE_STATUS_CONFLICT',
            `The IRP payload exists for a submitted invoice (current status: ${invoice.status}) — a draft has no number and a cancelled invoice registers nothing.`,
          );
        }
        try {
          return buildFrozenIrpPayload(parseJsonbColumn(invoice.issued_snapshot));
        } catch (error) {
          if (error instanceof EInvoiceB2cUnsupportedError) {
            throw httpError(409, error.code, error.message);
          }
          if (error instanceof TaxInvoiceSnapshotError) {
            throw httpError(
              409,
              error.code,
              'The frozen issued invoice is incomplete for IRP submission; it was not replaced with live master data.',
            );
          }
          throw error;
        }
      });
      void reply.type('application/json; charset=utf-8');
      return reply.send(stringifyStatutoryJson(payload));
    },
  );
}
