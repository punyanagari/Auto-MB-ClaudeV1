export type StatutoryEnvironment = 'sandbox' | 'production';
export type ProviderOutcome = 'failed' | 'unknown';

export class StatutoryProviderError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: ProviderOutcome,
    readonly providerCode: string | null = null,
    readonly httpStatus: number | null = null,
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
}

export interface EwayBillProviderEvidence {
  readonly ewbNumber: string;
  readonly ewbDateText: string;
  readonly ewbDate: string;
  readonly validUntilText: string;
  readonly validUntil: string;
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
  }): Promise<{ readonly cancelledAtText: string; readonly cancelledAt: string }>;
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
  }): Promise<{ readonly cancelledAtText: string; readonly cancelledAt: string }>;
}
