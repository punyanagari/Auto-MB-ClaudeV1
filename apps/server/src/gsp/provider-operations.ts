import { createHash } from 'node:crypto';
import type { TransactionSql } from '@auto-mb/db';
import { httpError } from '../http.js';
import { recordStatutoryProviderOutcome } from '../metrics.js';
import type { ErrorCode } from '@auto-mb/contracts';
import type {
  StatutoryProvider,
  StatutoryProviderError,
} from './statutory-provider.js';

type StatutoryOperation =
  | 'register_irp'
  | 'reconcile_irp'
  | 'cancel_irp'
  | 'generate_eway_bill'
  | 'reconcile_eway_bill'
  | 'cancel_eway_bill'
  | 'register_crn'
  | 'reconcile_crn'
  | 'cancel_crn';

type StatutoryOperationStatus = 'succeeded' | 'failed' | 'unknown';

interface ProviderFailure {
  readonly status: 'failed' | 'unknown';
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly publicCode: ErrorCode;
  /** Raw provider response body when one was received (migration 0053);
   * null for network-level failures that produced no body. */
  readonly rawResponse: string | null;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Ledger bodies are bounded at 256 KiB (migration 0053). An over-bound
 * body is kept as a truncated prefix with an explicit marker — never
 * silently cut, never dropped. Truncation walks back from the byte bound
 * so a multi-byte character is never split. */
const LEDGER_BODY_MAX_BYTES = 262144;

function boundedLedgerBody(body: string | null | undefined): {
  readonly body: string | null;
  readonly truncated: boolean;
} {
  if (body === null || body === undefined) return { body: null, truncated: false };
  if (Buffer.byteLength(body, 'utf8') <= LEDGER_BODY_MAX_BYTES) {
    return { body, truncated: false };
  }
  // Characters never take fewer bytes than one, so slicing to the byte
  // bound in characters is always long enough; then walk back to fit.
  let candidate = body.slice(0, LEDGER_BODY_MAX_BYTES);
  while (Buffer.byteLength(candidate, 'utf8') > LEDGER_BODY_MAX_BYTES) {
    candidate = candidate.slice(0, -1024);
  }
  return { body: candidate, truncated: true };
}

export function providerFailure(error: unknown): ProviderFailure {
  if (
    error instanceof Error &&
    error.name === 'StatutoryProviderError' &&
    'outcome' in error
  ) {
    const providerError = error as StatutoryProviderError;
    return {
      status: providerError.outcome,
      providerCode: providerError.providerCode,
      httpStatus: providerError.httpStatus,
      publicCode: providerError.code,
      rawResponse: providerError.rawResponse,
    };
  }
  return {
    status: 'unknown',
    providerCode: null,
    httpStatus: null,
    publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
    rawResponse: null,
  };
}

export async function startStatutoryOperation(
  tx: TransactionSql,
  input: {
    readonly organisationId: string;
    readonly userId: string;
    readonly provider: StatutoryProvider;
    readonly operation: StatutoryOperation;
    readonly requestSha256: string;
    /** The exact bytes requestSha256 hashes (migration 0053); stored on
     * the ledger row as immutable identity, bounded at 256 KiB. */
    readonly requestBody: string;
    readonly taxInvoiceId?: string;
    readonly ewayBillId?: string;
    readonly creditNoteId?: string;
  },
): Promise<string> {
  const target =
    input.operation === 'register_irp' ||
    input.operation === 'reconcile_irp' ||
    input.operation === 'cancel_irp'
      ? 'tax_invoice'
      : input.operation === 'register_crn' ||
          input.operation === 'reconcile_crn' ||
          input.operation === 'cancel_crn'
        ? 'credit_note'
        : 'eway_bill';
  const provided = [
    input.taxInvoiceId === undefined ? null : 'tax_invoice',
    input.ewayBillId === undefined ? null : 'eway_bill',
    input.creditNoteId === undefined ? null : 'credit_note',
  ].filter((value) => value !== null);
  if (provided.length !== 1 || provided[0] !== target) {
    throw new Error('statutory operation does not match its target');
  }
  const request = boundedLedgerBody(input.requestBody);
  try {
    const [row] = await tx<{ id: string }[]>`
      insert into statutory_provider_operations (
        organisation_id, tax_invoice_id, eway_bill_id, credit_note_id,
        provider, provider_portal, environment, operation, request_sha256,
        request_body, request_body_truncated,
        created_by_user_id
      )
      values (
        ${input.organisationId}, ${input.taxInvoiceId ?? null},
        ${input.ewayBillId ?? null}, ${input.creditNoteId ?? null},
        ${input.provider.name}, ${input.provider.portal},
        ${input.provider.environment}, ${input.operation},
        ${input.requestSha256},
        ${request.body}, ${request.truncated},
        ${input.userId}
      )
      returning id
    `;
    if (!row) throw new Error('provider operation insert returned no row');
    return row.id;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '23505') {
      throw httpError(
        409,
        'STATUTORY_OPERATION_IN_PROGRESS',
        'A statutory-provider operation is already in progress for this document.',
      );
    }
    throw error;
  }
}

export async function finishStatutoryOperation(
  tx: TransactionSql,
  operationId: string,
  input: {
    readonly status: StatutoryOperationStatus;
    readonly providerCode?: string | null;
    readonly httpStatus?: number | null;
    /** Raw provider response body (migration 0053), landed exactly once
     * with the completion; bounded at 256 KiB with a truncation marker. */
    readonly responseBody?: string | null;
  },
): Promise<void> {
  const response = boundedLedgerBody(input.responseBody);
  const rows = await tx<{ operation: StatutoryOperation }[]>`
    update statutory_provider_operations
    set status = ${input.status},
        provider_code = ${input.providerCode ?? null},
        http_status = ${input.httpStatus ?? null},
        response_body = ${response.body},
        response_body_truncated = ${response.truncated},
        completed_at = now()
    where id = ${operationId} and status = 'pending'
    returning operation
  `;
  if (rows.length !== 1) {
    throw new Error(`provider operation ${operationId} is not pending`);
  }
  // Finding 37: statutory-provider call outcomes, labelled by the ledger's
  // own operation name and terminal status — both closed sets, no provider
  // code or document id ever becomes a label value. Counted off the ledger
  // write itself, so every provider call that reaches a terminal state is
  // measured exactly once and the metric cannot drift from the record.
  if (rows[0] !== undefined) {
    recordStatutoryProviderOutcome(rows[0].operation, input.status);
  }
}

/** Recover after a process died between the prepare and finalize phases.
 * Provider mutations are bounded to 30 seconds; after two minutes the call
 * cannot still be owned by this process. Registration/generation becomes
 * UNKNOWN (therefore lookup-only on the next action), never retryable. */
export async function recoverStaleStatutoryOperation(
  tx: TransactionSql,
  target:
    | { readonly taxInvoiceId: string }
    | { readonly ewayBillId: string }
    | { readonly creditNoteId: string },
): Promise<readonly StatutoryOperation[]> {
  const rows = await tx<{ operation: StatutoryOperation }[]>`
    update statutory_provider_operations
    set status = 'unknown', provider_code = 'OPERATION_LEASE_EXPIRED',
        completed_at = now()
    where status = 'pending'
      and started_at < now() - interval '2 minutes'
      and tax_invoice_id is not distinct from ${
        'taxInvoiceId' in target ? target.taxInvoiceId : null
      }
      and eway_bill_id is not distinct from ${
        'ewayBillId' in target ? target.ewayBillId : null
      }
      and credit_note_id is not distinct from ${
        'creditNoteId' in target ? target.creditNoteId : null
      }
    returning operation
  `;
  for (const row of rows) {
    // A lease-expired recovery is a real terminal outcome of a provider
    // call — unknown — and must show up in the same counter as the calls
    // that finished in-process; otherwise the metric quietly under-reports
    // exactly the cases operators most need to see.
    recordStatutoryProviderOutcome(row.operation, 'unknown');
    if (row.operation === 'register_irp' || row.operation === 'reconcile_irp') {
      if (!('taxInvoiceId' in target)) throw new Error('IRP operation target mismatch');
      await tx`
        update tax_invoices set irp_provider_state = 'registration_unknown'
        where id = ${target.taxInvoiceId} and irp_provider_state = 'registering'
      `;
    } else if (row.operation === 'cancel_irp') {
      if (!('taxInvoiceId' in target)) throw new Error('IRP operation target mismatch');
      await tx`
        update tax_invoices set irp_provider_state = 'cancellation_unknown'
        where id = ${target.taxInvoiceId} and irp_provider_state = 'cancelling'
      `;
    } else if (row.operation === 'register_crn' || row.operation === 'reconcile_crn') {
      if (!('creditNoteId' in target)) throw new Error('CRN operation target mismatch');
      await tx`
        update credit_notes set irp_provider_state = 'registration_unknown'
        where id = ${target.creditNoteId} and irp_provider_state = 'registering'
      `;
    } else if (row.operation === 'cancel_crn') {
      if (!('creditNoteId' in target)) throw new Error('CRN operation target mismatch');
      await tx`
        update credit_notes set irp_provider_state = 'cancellation_unknown'
        where id = ${target.creditNoteId} and irp_provider_state = 'cancelling'
      `;
    } else if (
      row.operation === 'generate_eway_bill' ||
      row.operation === 'reconcile_eway_bill'
    ) {
      if (!('ewayBillId' in target)) throw new Error('EWB operation target mismatch');
      await tx`
        update eway_bills set provider_state = 'generation_unknown'
        where id = ${target.ewayBillId} and provider_state = 'generating'
      `;
    } else {
      if (!('ewayBillId' in target)) throw new Error('EWB operation target mismatch');
      await tx`
        update eway_bills set provider_state = 'cancellation_unknown'
        where id = ${target.ewayBillId} and provider_state = 'cancelling'
      `;
    }
  }
  return rows.map((row) => row.operation);
}
