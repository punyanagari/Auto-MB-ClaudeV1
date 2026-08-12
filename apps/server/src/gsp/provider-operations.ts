import { createHash } from 'node:crypto';
import type { TransactionSql } from '@auto-mb/db';
import { httpError } from '../http.js';
import type {
  StatutoryProvider,
  StatutoryProviderError,
} from './statutory-provider.js';

export type StatutoryOperation =
  | 'register_irp'
  | 'reconcile_irp'
  | 'cancel_irp'
  | 'generate_eway_bill'
  | 'reconcile_eway_bill'
  | 'cancel_eway_bill';

export type StatutoryOperationStatus = 'succeeded' | 'failed' | 'unknown';

export interface ProviderFailure {
  readonly status: 'failed' | 'unknown';
  readonly providerCode: string | null;
  readonly httpStatus: number | null;
  readonly publicCode: string;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
    };
  }
  return {
    status: 'unknown',
    providerCode: null,
    httpStatus: null,
    publicCode: 'STATUTORY_PROVIDER_UNKNOWN',
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
    readonly taxInvoiceId?: string;
    readonly ewayBillId?: string;
  },
): Promise<string> {
  const irpOperation =
    input.operation === 'register_irp' ||
    input.operation === 'reconcile_irp' ||
    input.operation === 'cancel_irp';
  if (
    (irpOperation &&
      (input.taxInvoiceId === undefined || input.ewayBillId !== undefined)) ||
    (!irpOperation &&
      (input.ewayBillId === undefined || input.taxInvoiceId !== undefined))
  ) {
    throw new Error('statutory operation does not match its target');
  }
  try {
    const [row] = await tx<{ id: string }[]>`
      insert into statutory_provider_operations (
        organisation_id, tax_invoice_id, eway_bill_id,
        provider, environment, operation, request_sha256,
        created_by_user_id
      )
      values (
        ${input.organisationId}, ${input.taxInvoiceId ?? null},
        ${input.ewayBillId ?? null}, ${input.provider.name},
        ${input.provider.environment}, ${input.operation},
        ${input.requestSha256}, ${input.userId}
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
  },
): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update statutory_provider_operations
    set status = ${input.status},
        provider_code = ${input.providerCode ?? null},
        http_status = ${input.httpStatus ?? null},
        completed_at = now()
    where id = ${operationId} and status = 'pending'
    returning id
  `;
  if (rows.length !== 1) {
    throw new Error(`provider operation ${operationId} is not pending`);
  }
}

/** Recover after a process died between the prepare and finalize phases.
 * Provider mutations are bounded to 30 seconds; after two minutes the call
 * cannot still be owned by this process. Registration/generation becomes
 * UNKNOWN (therefore lookup-only on the next action), never retryable. */
export async function recoverStaleStatutoryOperation(
  tx: TransactionSql,
  target: { readonly taxInvoiceId: string } | { readonly ewayBillId: string },
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
    returning operation
  `;
  for (const row of rows) {
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
