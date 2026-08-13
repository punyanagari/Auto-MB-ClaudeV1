import type { ErrorCode } from '@auto-mb/contracts';

export type StatutoryEnvironment = 'sandbox' | 'production';
export type ProviderOutcome = 'failed' | 'unknown';

export class StatutoryProviderError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly outcome: ProviderOutcome,
    readonly providerCode: string | null = null,
    readonly httpStatus: number | null = null,
    /** Raw provider response body when one was received (migration 0053
     * evidence ledger); null when the failure produced no body. Never set
     * on authentication failures — auth responses carry tokens and must
     * not reach the ledger. */
    readonly rawResponse: string | null = null,
  ) {
    super(code);
    this.name = 'StatutoryProviderError';
  }
}

export interface IrpDocumentIdentity {
  readonly gstin: string;
  readonly documentNumber: string;
  /** Date-only YYYY-MM-DD. */
  readonly documentDate: string;
  /** INV-01 document type for lookup and payload identity: 'INV'
   * (default) or 'CRN' for a Section 34 credit note. */
  readonly documentType?: 'INV' | 'CRN';
}

export interface IrpRegistrationEvidence {
  readonly irn: string;
  readonly ackNumber: string;
  readonly ackDateText: string;
  readonly ackDate: string;
  readonly signedQr: string;
  readonly signedInvoice: string;
  /** The raw provider response body the evidence above was normalised
   * from, verbatim (migration 0053 evidence ledger). */
  readonly rawResponse: string;
  /** Which portal answered — the same value as the answering provider's
   * `portal` (audit finding 2). Carried on the evidence as well as the
   * provider so a reader of one registration knows who registered it
   * without having to know which provider instance was live at the time. */
  readonly portal: string;
}

export interface EwayBillProviderEvidence {
  readonly ewbNumber: string;
  readonly ewbDateText: string;
  readonly ewbDate: string;
  readonly validUntilText: string;
  readonly validUntil: string;
  /** The raw provider response body the evidence above was normalised
   * from, verbatim (migration 0053 evidence ledger). */
  readonly rawResponse: string;
}

export interface ProviderCancellationEvidence {
  readonly cancelledAtText: string;
  readonly cancelledAt: string;
  /** The raw provider response body, verbatim (migration 0053). */
  readonly rawResponse: string;
}

export interface GenerateEwayBillByIrnRequest {
  readonly gstin: string;
  readonly irn: string;
  /** Already serialized exact JSON bytes. */
  readonly payloadJson: string;
}

export interface StatutoryProvider {
  readonly name: 'whitebooks';
  readonly environment: StatutoryEnvironment;
  /**
   * Which portal this instance talks to, as evidence — the NIC IRP it
   * routes to and the provider host it routes through, e.g.
   * `NIC1 via api.whitebooks.in` (audit finding 2).
   *
   * `name` says which GSP the deployment bought; this says which
   * government portal actually answered, and they are not the same fact.
   * A GSP can move an organisation between IRPs, and a later dispute over
   * one registration needs to know which portal's records to ask for.
   * Persisted on every operation ledger row, so the answer survives a
   * configuration change.
   */
  readonly portal: string;
  registerInvoice(
    identity: IrpDocumentIdentity,
    payloadJson: string,
  ): Promise<IrpRegistrationEvidence>;
  findInvoiceByDocument(
    identity: IrpDocumentIdentity,
  ): Promise<IrpRegistrationEvidence | null>;
  cancelInvoice(input: {
    readonly gstin: string;
    readonly irn: string;
    readonly reasonCode: string;
    readonly remark: string;
  }): Promise<ProviderCancellationEvidence>;
  generateEwayBillByIrn(
    input: GenerateEwayBillByIrnRequest,
  ): Promise<EwayBillProviderEvidence>;
  findEwayBillByIrn(input: {
    readonly gstin: string;
    readonly irn: string;
  }): Promise<EwayBillProviderEvidence | null>;
  cancelEwayBill(input: {
    readonly gstin: string;
    readonly ewbNumber: string;
    readonly reasonCode: string;
    readonly remark: string;
  }): Promise<ProviderCancellationEvidence>;
}
