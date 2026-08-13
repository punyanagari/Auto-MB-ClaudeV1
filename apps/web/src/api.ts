import type {
  AddMemberRequest,
  ApiError,
  ApprovalRequest,
  ApprovalStatus,
  CorrectionEligibilityResponse,
  CorrectionNotice,
  CorrectionNoticeDetailResponse,
  ProposeChallanCancelReplaceRequest,
  ProposeCorrectionNoticeRequest,
  ProposeIssueChallanCancelReplaceRequest,
  Bill,
  CancelChallanRequest,
  ChallanDetailResponse,
  Challan,
  ConfirmWorkRequest,
  ContractSourceContext,
  ContractSourceDocumentKind,
  ContractSourceUploadResponse,
  Contact,
  CreateOrganisationRequest,
  DashboardResponse,
  DiscardLoaDocumentResponse,
  ExtensionRequestDetailResponse,
  InstallSerialRequest,
  Instrument,
  IssueChallan,
  IssueChallanDetailResponse,
  CancelIssueChallanRequest,
  SaveIssueChallanRequest,
  LoaDocument,
  LoaDocumentDetail,
  LocationMaster,
  MbEntry,
  MemberAssignmentsResponse,
  Membership,
  Organisation,
  ProposeAddItemRequest,
  ProposeAmendmentRequest,
  ProposeRemoveItemRequest,
  OrganisationProfile,
  Receipt,
  RecordMbEntryRequest,
  RecordReceiptRequest,
  RecordSerialsRequest,
  RespondExtensionRequest,
  BackfillExtensionRequest,
  BackfillExtensionResponse,
  CreateGstRateRequest,
  EndDateGstRateRequest,
  GstRateMaster,
  SaveChallanRequest,
  SaveContactRequest,
  SaveExtensionRequest,
  SaveInstrumentRequest,
  SaveLocationMasterRequest,
  SaveSignatoryRequest,
  SaveUnitMasterRequest,
  Serial,
  TimelineResponse,
  Signatory,
  UnitMaster,
  SetCompletionDateRequest,
  SerialSearchResponse,
  UpdateBillStatusRequest,
  UpdateInstrumentRequest,
  UpdateMemberRequest,
  UpdateOrganisationProfileRequest,
  Work,
  WorkBalanceResponse,
  WorkCompletionResponse,
  CompleteWorkRequest,
  ReopenWorkRequest,
  WorkCompletionReadiness,
  WorkStatusResponse,
  WorkDetailResponse,
  WorkSettingsResponse,
  WorkItemSerialsResponse,
  Installation,
  InstallationListResponse,
  RecordInstallationRequest,
  PaymentMatrixCategory,
  PaymentMatrixRow,
  UpsertPaymentMatrixRowRequest,
  WorkItemPaymentCategory,
  WorkItemPaymentCategoryResponse,
  PacCertificate,
  PacCertificateListResponse,
  RecordPacCertificateRequest,
  CreateMeasurementBookRequest,
  MeasurementBookDetailResponse,
  MeasurementBookListResponse,
  SetMbSourcesRequest,
  MergeMeasurementBooksRequest,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderDetailResponse,
  CreatePurchaseOrderRequest,
  SavePurchaseOrderLinesRequest,
  CancelPurchaseOrderRequest,
  BudgetaryQuotation,
  BudgetaryQuotationDetailResponse,
  CreateBudgetaryQuotationRequest,
  SaveBudgetaryQuotationLinesRequest,
  SetBudgetaryQuotationOutcomeRequest,
  TaxInvoice,
  TaxInvoiceDetailResponse,
  CreateDirectTaxInvoiceRequest,
  CreateTaxInvoiceRequest,
  CreditNote,
  CreditNoteDetailResponse,
  CreateCreditNoteRequest,
  UpdateCreditNoteRequest,
  CancelCreditNoteRequest,
  UpdateRecipientItcRequest,
  NumberSeries,
  NumberedDocumentType,
  SaveNumberSeriesRequest,
  UpdateTaxInvoiceRequest,
  CancelTaxInvoiceRequest,
  RecordIrpResponseRequest,
  EwayBill,
  EwayBillDetailResponse,
  SaveEwayBillRequest,
  RecordEwayNicResponseRequest,
  CancelEwayBillRequest,
  CancelStatutoryDocumentRequest,
  RecordManualStatutoryCancellationRequest,
} from '@auto-mb/contracts';

export interface MeResponse {
  readonly user: { readonly id: string; readonly email: string };
  readonly memberships: readonly Membership[];
  /** Finding 36: whether this account has completed TOTP enrolment. */
  readonly twoFactorEnabled: boolean;
  /** True when the account holds authority (owner role or a document
   * authority in any organisation) and therefore falls under the MFA
   * policy. Computed even while enforcement is dark. */
  readonly mfaRequired: boolean;
  /** True when the server refuses tenant requests to required, unenrolled
   * accounts — the client renders the enrolment wall only then. */
  readonly mfaEnforced: boolean;
}

/** What sign-in produced: a session, or a pending two-factor challenge
 * that verifyTotp / verifyBackupCode must complete. */
export interface SignInResult {
  readonly twoFactorRequired: boolean;
}

/** The one-time enrolment material from enableTwoFactor. The secret only
 * ever exists inside the returned otpauth URI; backup codes are shown once
 * and never retrievable again through this client. */
export interface TwoFactorEnrolmentStart {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

/** PATCH /api/work-items/:id/tax-facts body. The route owns these shapes
 * (they are not in @auto-mb/contracts). PATCH semantics: an omitted
 * field keeps its value, an explicit null clears it. `isService` takes
 * no null — its column is NOT NULL DEFAULT false. */
export interface SetWorkItemTaxFactsRequest {
  readonly hsnCode?: string | null;
  /** Total GST rate as a decimal string (e.g. '18', '0.25'). */
  readonly gstRate?: string | null;
  readonly isService?: boolean;
}

/** The item's tax facts read back after the PATCH. */
export interface WorkItemTaxFactsResponse {
  readonly id: string;
  readonly itemNumber: string;
  readonly hsnCode: string | null;
  readonly gstRate: string | null;
  readonly isService: boolean;
}

/** Error carrying the server's ApiError envelope for user-facing display.
 * `details` carries structured conflict payloads (e.g. one-draft 409s
 * answer with the existing draft's id — see existingRecordIdOf). */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
    this.requestId = requestId ?? null;
  }
}

/** Every one-open-draft 409 (DRAFT_EXISTS, EXTENSION_DRAFT_EXISTS, and
 * future one-draft rules) answers with the existing draft's id as
 * `details.existingRecordId`; returns it when present so views can open
 * the existing draft instead of dead-ending on the message. */
export function existingRecordIdOf(error: unknown): string | null {
  if (!(error instanceof RequestFailedError) || error.status !== 409) return null;
  const details = error.details as { existingRecordId?: unknown } | null;
  return typeof details?.existingRecordId === 'string'
    ? details.existingRecordId
    : null;
}

export interface ApiClient {
  readonly me: () => Promise<MeResponse | null>;
  readonly signUp: (email: string, name: string, password: string) => Promise<void>;
  readonly signIn: (email: string, password: string) => Promise<SignInResult>;
  readonly signOut: () => Promise<void>;
  /** Completes a pending two-factor sign-in challenge with an
   * authenticator code. */
  readonly verifyTotp: (code: string, trustDevice?: boolean) => Promise<void>;
  /** Completes a pending two-factor sign-in challenge with a one-time
   * backup code, consuming it. */
  readonly verifyBackupCode: (code: string) => Promise<void>;
  /** Starts TOTP enrolment (password re-confirmation required); the
   * returned URI must then be verified with verifyTotp to finish. */
  readonly enableTwoFactor: (password: string) => Promise<TwoFactorEnrolmentStart>;
  /** Refused with 403 MFA_REQUIRED_BY_POLICY for accounts the policy
   * covers, regardless of what the client shows. */
  readonly disableTwoFactor: (password: string) => Promise<void>;
  /** Replaces every backup code; the previous set stops working. */
  readonly regenerateBackupCodes: (password: string) => Promise<readonly string[]>;
  readonly listOrganisations: () => Promise<readonly Organisation[]>;
  readonly createOrganisation: (
    body: CreateOrganisationRequest,
  ) => Promise<Organisation>;
  readonly listMembers: (organisationId: string) => Promise<readonly Membership[]>;
  readonly addMember: (
    organisationId: string,
    body: AddMemberRequest,
  ) => Promise<readonly Membership[]>;
  readonly updateMember: (
    organisationId: string,
    userId: string,
    body: UpdateMemberRequest,
  ) => Promise<readonly Membership[]>;
  readonly memberAssignments: (
    organisationId: string,
    userId: string,
  ) => Promise<MemberAssignmentsResponse>;
  readonly setMemberAssignments: (
    organisationId: string,
    userId: string,
    workIds: readonly string[],
  ) => Promise<MemberAssignmentsResponse>;
  readonly listLoaDocuments: (
    organisationId: string,
    options?: { readonly includeDiscarded?: boolean },
  ) => Promise<readonly LoaDocument[]>;
  /** Withdraws an intake package that never became a Work, with its
   * supporting contract documents. Refused with 409 DOCUMENT_CONFIRMED
   * once a Work exists from the letter. */
  readonly discardLoaDocument: (
    organisationId: string,
    documentId: string,
    reason?: string,
  ) => Promise<DiscardLoaDocumentResponse>;
  /** Removes one supporting tender document from an unconfirmed intake
   * package, answering with the package's remaining evidence. */
  readonly discardContractSourceDocument: (
    organisationId: string,
    documentId: string,
    reason?: string,
  ) => Promise<ContractSourceContext>;
  readonly getLoaDocument: (
    organisationId: string,
    documentId: string,
  ) => Promise<LoaDocumentDetail>;
  readonly uploadLoa: (
    organisationId: string,
    file: Blob,
    filename: string,
  ) => Promise<LoaDocumentDetail>;
  readonly uploadContractSource: (
    organisationId: string,
    loaDocumentId: string,
    kind: ContractSourceDocumentKind,
    file: Blob,
    filename: string,
  ) => Promise<ContractSourceUploadResponse>;
  readonly getLoaContractSourceContext: (
    organisationId: string,
    loaDocumentId: string,
  ) => Promise<ContractSourceContext>;
  readonly getWorkContractSourceContext: (
    organisationId: string,
    workId: string,
  ) => Promise<ContractSourceContext>;
  readonly downloadContractSourceFile: (
    organisationId: string,
    documentId: string,
  ) => Promise<Blob>;
  readonly confirmLoa: (
    organisationId: string,
    documentId: string,
    body: ConfirmWorkRequest,
  ) => Promise<WorkDetailResponse>;
  readonly listWorks: (organisationId: string) => Promise<readonly Work[]>;
  readonly getWork: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkDetailResponse>;
  readonly workBalance: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkBalanceResponse>;
  readonly listChallans: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly Challan[]>;
  readonly getChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<ChallanDetailResponse>;
  readonly createChallan: (
    organisationId: string,
    workId: string,
    body: SaveChallanRequest,
  ) => Promise<ChallanDetailResponse>;
  readonly updateChallan: (
    organisationId: string,
    challanId: string,
    body: SaveChallanRequest,
  ) => Promise<ChallanDetailResponse>;
  readonly deleteChallan: (organisationId: string, challanId: string) => Promise<void>;
  readonly issueChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<ChallanDetailResponse>;
  readonly cancelChallan: (
    organisationId: string,
    challanId: string,
    body: CancelChallanRequest,
  ) => Promise<ChallanDetailResponse>;
  readonly renderChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<ChallanDetailResponse>;
  readonly uploadSignedCopy: (
    organisationId: string,
    challanId: string,
    file: Blob,
  ) => Promise<ChallanDetailResponse>;
  readonly downloadChallanPdf: (
    organisationId: string,
    challanId: string,
    kind: 'rendered' | 'signed',
  ) => Promise<Blob>;
  readonly listIssueChallans: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly IssueChallan[]>;
  readonly getIssueChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<IssueChallanDetailResponse>;
  readonly createIssueChallan: (
    organisationId: string,
    workId: string,
    body: SaveIssueChallanRequest,
  ) => Promise<IssueChallanDetailResponse>;
  readonly updateIssueChallan: (
    organisationId: string,
    challanId: string,
    body: SaveIssueChallanRequest,
  ) => Promise<IssueChallanDetailResponse>;
  readonly deleteIssueChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<void>;
  readonly issueIssueChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<IssueChallanDetailResponse>;
  readonly cancelIssueChallan: (
    organisationId: string,
    challanId: string,
    body: CancelIssueChallanRequest,
  ) => Promise<IssueChallanDetailResponse>;
  readonly renderIssueChallan: (
    organisationId: string,
    challanId: string,
  ) => Promise<IssueChallanDetailResponse>;
  readonly uploadIssueChallanSignedCopy: (
    organisationId: string,
    challanId: string,
    file: Blob,
  ) => Promise<IssueChallanDetailResponse>;
  readonly downloadIssueChallanPdf: (
    organisationId: string,
    challanId: string,
    kind: 'rendered' | 'signed',
  ) => Promise<Blob>;
  readonly dashboard: (organisationId: string) => Promise<DashboardResponse>;
  readonly organisationProfile: (
    organisationId: string,
  ) => Promise<OrganisationProfile>;
  readonly updateOrganisationProfile: (
    organisationId: string,
    body: UpdateOrganisationProfileRequest,
  ) => Promise<OrganisationProfile>;
  readonly uploadLogo: (
    organisationId: string,
    file: Blob,
    mediaType: 'image/png' | 'image/jpeg',
  ) => Promise<OrganisationProfile>;
  readonly removeLogo: (organisationId: string) => Promise<void>;
  readonly logoBlob: (organisationId: string) => Promise<Blob | null>;
  readonly getReceipt: (
    organisationId: string,
    challanId: string,
  ) => Promise<Receipt | null>;
  readonly recordReceipt: (
    organisationId: string,
    challanId: string,
    body: RecordReceiptRequest,
  ) => Promise<Receipt>;
  readonly recordSerials: (
    organisationId: string,
    challanId: string,
    body: RecordSerialsRequest,
  ) => Promise<readonly Serial[]>;
  readonly recordInstallation: (
    organisationId: string,
    serialId: string,
    body: InstallSerialRequest,
  ) => Promise<readonly Serial[]>;
  readonly listWorkSerials: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly Serial[]>;
  readonly deleteSerial: (organisationId: string, serialId: string) => Promise<void>;
  readonly searchSerials: (
    organisationId: string,
    query: string,
  ) => Promise<SerialSearchResponse>;
  readonly updateWorkItemSerials: (
    organisationId: string,
    workItemId: string,
    requiresSerials: boolean,
  ) => Promise<WorkItemSerialsResponse>;
  readonly listInstruments: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly Instrument[]>;
  readonly createInstrument: (
    organisationId: string,
    workId: string,
    body: SaveInstrumentRequest,
  ) => Promise<Instrument>;
  readonly updateInstrument: (
    organisationId: string,
    instrumentId: string,
    body: UpdateInstrumentRequest,
  ) => Promise<Instrument>;
  readonly listMbEntries: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly MbEntry[]>;
  readonly recordMbEntry: (
    organisationId: string,
    workId: string,
    body: RecordMbEntryRequest,
  ) => Promise<MbEntry>;
  readonly listBills: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly Bill[]>;
  readonly setBillStatus: (
    organisationId: string,
    billId: string,
    body: UpdateBillStatusRequest,
  ) => Promise<Bill>;
  readonly workTimeline: (
    organisationId: string,
    workId: string,
    options?: {
      readonly cursor?: string;
      readonly entityTypes?: readonly string[];
      readonly limit?: number;
    },
  ) => Promise<TimelineResponse>;
  readonly entityTimeline: (
    organisationId: string,
    entityType: string,
    entityId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<TimelineResponse>;
  /** Master data (pickers only): `save` with a null id creates, with an id
   * updates; `setActive` retires (false) or reactivates (true). */
  readonly listContacts: (
    organisationId: string,
    options?: { includeRetired?: boolean; role?: 'consignee' },
  ) => Promise<readonly Contact[]>;
  readonly saveContact: (
    organisationId: string,
    id: string | null,
    body: SaveContactRequest,
  ) => Promise<Contact>;
  readonly setContactActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<Contact>;
  readonly listWorkConsignees: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly Contact[]>;
  readonly linkWorkConsignee: (
    organisationId: string,
    workId: string,
    contactId: string,
  ) => Promise<Contact>;
  readonly unlinkWorkConsignee: (
    organisationId: string,
    workId: string,
    contactId: string,
  ) => Promise<void>;
  readonly listLocationMasters: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<readonly LocationMaster[]>;
  readonly saveLocationMaster: (
    organisationId: string,
    id: string | null,
    body: SaveLocationMasterRequest,
  ) => Promise<LocationMaster>;
  readonly setLocationMasterActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<LocationMaster>;
  readonly listUnitMasters: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<readonly UnitMaster[]>;
  readonly saveUnitMaster: (
    organisationId: string,
    id: string | null,
    body: SaveUnitMasterRequest,
  ) => Promise<UnitMaster>;
  readonly setUnitMasterActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<UnitMaster>;
  readonly listGstRates: (organisationId: string) => Promise<readonly GstRateMaster[]>;
  readonly createGstRate: (
    organisationId: string,
    body: CreateGstRateRequest,
  ) => Promise<GstRateMaster>;
  readonly endDateGstRate: (
    organisationId: string,
    id: string,
    body: EndDateGstRateRequest,
  ) => Promise<GstRateMaster>;
  readonly listSignatories: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<readonly Signatory[]>;
  readonly saveSignatory: (
    organisationId: string,
    id: string | null,
    body: SaveSignatoryRequest,
  ) => Promise<Signatory>;
  readonly setSignatoryActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<Signatory>;
  readonly getWorkCompletion: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkCompletionResponse>;
  readonly setCompletionDate: (
    organisationId: string,
    workId: string,
    body: SetCompletionDateRequest,
  ) => Promise<WorkCompletionResponse>;
  readonly createExtensionRequest: (
    organisationId: string,
    workId: string,
    body: SaveExtensionRequest,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly updateExtensionRequest: (
    organisationId: string,
    extensionId: string,
    body: SaveExtensionRequest,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly deleteExtensionRequest: (
    organisationId: string,
    extensionId: string,
  ) => Promise<void>;
  readonly finaliseExtensionRequest: (
    organisationId: string,
    extensionId: string,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly renderExtensionRequest: (
    organisationId: string,
    extensionId: string,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly uploadExtensionResponse: (
    organisationId: string,
    extensionId: string,
    file: Blob,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly respondExtensionRequest: (
    organisationId: string,
    extensionId: string,
    body: RespondExtensionRequest,
  ) => Promise<ExtensionRequestDetailResponse>;
  readonly downloadExtensionPdf: (
    organisationId: string,
    extensionId: string,
    kind: 'rendered' | 'response',
  ) => Promise<Blob>;
  /** Streams the DRAFT-watermarked preview of a draft letter (§5.5);
   * nothing is stored server-side. */
  readonly downloadExtensionDraftPreview: (
    organisationId: string,
    extensionId: string,
  ) => Promise<Blob>;
  /** Back-fills a paper letter as a finalised record occupying the next
   * sequence slot; the response carries non-blocking warnings. */
  readonly backfillExtensionRequest: (
    organisationId: string,
    workId: string,
    body: BackfillExtensionRequest,
  ) => Promise<BackfillExtensionResponse>;
  readonly listApprovals: (
    organisationId: string,
    status?: ApprovalStatus,
  ) => Promise<readonly ApprovalRequest[]>;
  readonly listWorkAmendments: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly ApprovalRequest[]>;
  readonly proposeAmendment: (
    organisationId: string,
    workId: string,
    body: ProposeAmendmentRequest,
  ) => Promise<ApprovalRequest>;
  readonly proposeAddItem: (
    organisationId: string,
    workId: string,
    body: ProposeAddItemRequest,
  ) => Promise<ApprovalRequest>;
  readonly proposeItemRemoval: (
    organisationId: string,
    workId: string,
    body: ProposeRemoveItemRequest,
  ) => Promise<ApprovalRequest>;
  readonly approveAmendment: (
    organisationId: string,
    approvalId: string,
    note?: string,
  ) => Promise<ApprovalRequest>;
  readonly rejectAmendment: (
    organisationId: string,
    approvalId: string,
    note: string,
  ) => Promise<ApprovalRequest>;
  readonly withdrawAmendment: (
    organisationId: string,
    approvalId: string,
  ) => Promise<ApprovalRequest>;
  readonly setWorkSettings: (
    organisationId: string,
    workId: string,
    allowExcessDelivery: boolean,
  ) => Promise<WorkSettingsResponse>;
  /** Quantity-level installation records (Milestone 7). */
  readonly listWorkInstallations: (
    organisationId: string,
    workId: string,
  ) => Promise<InstallationListResponse>;
  readonly recordWorkInstallation: (
    organisationId: string,
    workId: string,
    body: RecordInstallationRequest,
  ) => Promise<Installation>;
  readonly cancelWorkInstallation: (
    organisationId: string,
    installationId: string,
    note: string,
  ) => Promise<Installation>;
  /** Correction flow for issued documents (Milestone 7). */
  readonly challanCorrectionEligibility: (
    organisationId: string,
    challanId: string,
  ) => Promise<CorrectionEligibilityResponse>;
  readonly proposeChallanCancelReplace: (
    organisationId: string,
    challanId: string,
    body: ProposeChallanCancelReplaceRequest,
  ) => Promise<ApprovalRequest>;
  readonly proposeIssueChallanCancelReplace: (
    organisationId: string,
    challanId: string,
    body: ProposeIssueChallanCancelReplaceRequest,
  ) => Promise<ApprovalRequest>;
  readonly proposeChallanCorrectionNotice: (
    organisationId: string,
    challanId: string,
    body: ProposeCorrectionNoticeRequest,
  ) => Promise<ApprovalRequest>;
  readonly listWorkCorrectionNotices: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly CorrectionNotice[]>;
  readonly listChallanCorrectionNotices: (
    organisationId: string,
    challanId: string,
  ) => Promise<readonly CorrectionNotice[]>;
  readonly getCorrectionNotice: (
    organisationId: string,
    noticeId: string,
  ) => Promise<CorrectionNoticeDetailResponse>;
  readonly renderCorrectionNotice: (
    organisationId: string,
    noticeId: string,
  ) => Promise<CorrectionNoticeDetailResponse>;
  readonly cancelCorrectionNotice: (
    organisationId: string,
    noticeId: string,
    note: string,
  ) => Promise<CorrectionNoticeDetailResponse>;
  readonly downloadCorrectionNoticePdf: (
    organisationId: string,
    noticeId: string,
  ) => Promise<Blob>;
  /** Per-Work payment matrix and item categories (Milestone 8). */
  readonly getPaymentMatrix: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly PaymentMatrixRow[]>;
  readonly upsertPaymentMatrixRow: (
    organisationId: string,
    workId: string,
    category: PaymentMatrixCategory,
    body: UpsertPaymentMatrixRowRequest,
  ) => Promise<PaymentMatrixRow>;
  readonly deletePaymentMatrixRow: (
    organisationId: string,
    workId: string,
    category: PaymentMatrixCategory,
  ) => Promise<void>;
  readonly setWorkItemPaymentCategory: (
    organisationId: string,
    workItemId: string,
    paymentCategory: WorkItemPaymentCategory | null,
  ) => Promise<WorkItemPaymentCategoryResponse>;
  /** PAC certificates (Milestone 8 phase 1). */
  readonly listWorkPacCertificates: (
    organisationId: string,
    workId: string,
  ) => Promise<PacCertificateListResponse>;
  readonly recordWorkPacCertificate: (
    organisationId: string,
    workId: string,
    body: RecordPacCertificateRequest,
  ) => Promise<PacCertificate>;
  readonly cancelPacCertificate: (
    organisationId: string,
    certificateId: string,
    note: string,
  ) => Promise<PacCertificate>;
  readonly uploadPacCertificateDocument: (
    organisationId: string,
    certificateId: string,
    file: Blob,
  ) => Promise<PacCertificate>;
  readonly downloadPacCertificateDocument: (
    organisationId: string,
    certificateId: string,
  ) => Promise<Blob>;
  /** Stage-wise Measurement Books (Milestone 8 phase 2). Bill
   * preparation moved here: a bill is prepared FROM a finalized MB
   * (the Milestone 5 unbilled-measurements sweep endpoint is gone). */
  readonly listWorkMeasurementBooks: (
    organisationId: string,
    workId: string,
  ) => Promise<MeasurementBookListResponse>;
  readonly createWorkMeasurementBook: (
    organisationId: string,
    workId: string,
    body: CreateMeasurementBookRequest,
  ) => Promise<MeasurementBookDetailResponse>;
  /** 0034 record-MB workflow: merge absorbs record drafts into ONE new
   * on-account draft claiming the union of their sources; unmerge is
   * the only way to take that draft apart again (answers 204, restoring
   * each record MB to draft with the sources the merge took). */
  readonly mergeWorkMeasurementBooks: (
    organisationId: string,
    workId: string,
    body: MergeMeasurementBooksRequest,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly unmergeMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<void>;
  readonly getMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly setMeasurementBookSources: (
    organisationId: string,
    measurementBookId: string,
    body: SetMbSourcesRequest,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly finalizeMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly cancelMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
    note: string,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly deleteMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<void>;
  readonly prepareBillFromMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<Bill>;
  /** Phase 3: the MB document. Finalized MBs render to a persisted PDF;
   * drafts stream a watermarked live preview that is never stored. */
  readonly renderMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<MeasurementBookDetailResponse>;
  readonly downloadMeasurementBookPdf: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<Blob>;
  readonly downloadMeasurementBookDraftPreview: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<Blob>;
  /** R8 completion: refuses with WORK_NOT_CLEAN (details.blockers) or
   * WORK_NOT_FULLY_EXECUTED (details.unfinishedItems) — both are the
   * operator's worklist, rendered by the Work detail panel. */
  readonly completeWork: (
    organisationId: string,
    workId: string,
    body: CompleteWorkRequest,
  ) => Promise<WorkStatusResponse>;
  readonly reopenWork: (
    organisationId: string,
    workId: string,
    body: ReopenWorkRequest,
  ) => Promise<WorkStatusResponse>;
  readonly workCompletionReadiness: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkCompletionReadiness>;
  /** Procurement (migration 0033). A purchase order buys IN against a
   * Work: draft -> issued (numbered, total frozen) -> closed once fully
   * received, or cancelled with a note. `status: 'open'` filters to
   * issued orders with at least one line still owed material; a literal
   * status filters literally; no filter lists everything. Line money is
   * computed server-side — the client never sends amounts. */
  readonly listWorkPurchaseOrders: (
    organisationId: string,
    workId: string,
    status?: 'open' | PurchaseOrderStatus,
  ) => Promise<readonly PurchaseOrder[]>;
  readonly createWorkPurchaseOrder: (
    organisationId: string,
    workId: string,
    body: CreatePurchaseOrderRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
  readonly getPurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
  ) => Promise<PurchaseOrderDetailResponse>;
  readonly updatePurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
    body: CreatePurchaseOrderRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
  /** REPLACES the draft's lines wholesale; `lineNumber` follows array
   * order. */
  readonly savePurchaseOrderLines: (
    organisationId: string,
    purchaseOrderId: string,
    body: SavePurchaseOrderLinesRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
  readonly issuePurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
  ) => Promise<PurchaseOrderDetailResponse>;
  readonly cancelPurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
    body: CancelPurchaseOrderRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
  /** Refuses with PO_NOT_FULLY_RECEIVED (details.outstandingLines) while
   * any line is still owed material. */
  readonly closePurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
  ) => Promise<PurchaseOrderDetailResponse>;
  readonly deletePurchaseOrder: (
    organisationId: string,
    purchaseOrderId: string,
  ) => Promise<void>;
  /** A budgetary quotation is a priced offer OUTWARD and carries no
   * Work: draft -> issued (numbered) -> expired/converted/withdrawn via
   * the one outcome transition. */
  readonly listBudgetaryQuotations: (
    organisationId: string,
  ) => Promise<readonly BudgetaryQuotation[]>;
  readonly createBudgetaryQuotation: (
    organisationId: string,
    body: CreateBudgetaryQuotationRequest,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  readonly getBudgetaryQuotation: (
    organisationId: string,
    quotationId: string,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  readonly updateBudgetaryQuotation: (
    organisationId: string,
    quotationId: string,
    body: CreateBudgetaryQuotationRequest,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  /** REPLACES the draft's lines wholesale; `lineNumber` follows array
   * order. */
  readonly saveBudgetaryQuotationLines: (
    organisationId: string,
    quotationId: string,
    body: SaveBudgetaryQuotationLinesRequest,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  readonly issueBudgetaryQuotation: (
    organisationId: string,
    quotationId: string,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  readonly setBudgetaryQuotationOutcome: (
    organisationId: string,
    quotationId: string,
    body: SetBudgetaryQuotationOutcomeRequest,
  ) => Promise<BudgetaryQuotationDetailResponse>;
  readonly deleteBudgetaryQuotation: (
    organisationId: string,
    quotationId: string,
  ) => Promise<void>;
  /** GST tax documents (migration 0035). The tax invoice bills ONE
   * finalized on-account/final Measurement Book cumulatively: draft ->
   * submitted (numbered per financial year, buyer snapshotted, amounts
   * frozen from the MB total — submitting closes the MB) -> cancelled
   * (which releases the MB for a corrected invoice). */
  readonly listWorkTaxInvoices: (
    organisationId: string,
    workId: string,
  ) => Promise<readonly TaxInvoice[]>;
  readonly createWorkTaxInvoice: (
    organisationId: string,
    workId: string,
    body: CreateTaxInvoiceRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly getTaxInvoice: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly updateTaxInvoice: (
    organisationId: string,
    invoiceId: string,
    body: UpdateTaxInvoiceRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly submitTaxInvoice: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly renderTaxInvoice: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly downloadTaxInvoicePdf: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<Blob>;
  readonly cancelTaxInvoice: (
    organisationId: string,
    invoiceId: string,
    body: CancelTaxInvoiceRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly deleteTaxInvoice: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<void>;
  /** The GSP-ready e-invoice JSON for a submitted invoice. The payload
   * shape is the IRP's, not this product's contract, so it is `unknown`:
   * views hand it on (download/copy), never read into it. */
  readonly taxInvoiceIrpPayload: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<string>;
  readonly registerTaxInvoiceIrp: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly recoverTaxInvoiceProviderOperation: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly cancelTaxInvoiceIrp: (
    organisationId: string,
    invoiceId: string,
    body: CancelStatutoryDocumentRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly recordTaxInvoiceIrpCancellation: (
    organisationId: string,
    invoiceId: string,
    body: RecordManualStatutoryCancellationRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  /** Records what the GSP brought back from the IRP (IRN, ack, signed
   * QR) — once, on a submitted invoice, verbatim. */
  readonly recordTaxInvoiceIrpResponse: (
    organisationId: string,
    invoiceId: string,
    body: RecordIrpResponseRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  /** The Section 34 credit note (migration 0051): full value against one
   * submitted invoice; issuing it supersedes the invoice and releases
   * its Measurement Book. Its own IRN document (DocTyp CRN). */
  readonly listCreditNotes: (organisationId: string) => Promise<readonly CreditNote[]>;
  readonly listInvoiceCreditNotes: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<readonly CreditNote[]>;
  readonly createCreditNote: (
    organisationId: string,
    invoiceId: string,
    body: CreateCreditNoteRequest,
  ) => Promise<CreditNoteDetailResponse>;
  readonly getCreditNote: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<CreditNoteDetailResponse>;
  readonly updateCreditNote: (
    organisationId: string,
    creditNoteId: string,
    body: UpdateCreditNoteRequest,
  ) => Promise<CreditNoteDetailResponse>;
  readonly deleteCreditNote: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<void>;
  readonly issueCreditNote: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<CreditNoteDetailResponse>;
  readonly cancelCreditNote: (
    organisationId: string,
    creditNoteId: string,
    body: CancelCreditNoteRequest,
  ) => Promise<CreditNoteDetailResponse>;
  readonly updateCreditNoteRecipientItc: (
    organisationId: string,
    creditNoteId: string,
    body: UpdateRecipientItcRequest,
  ) => Promise<CreditNoteDetailResponse>;
  readonly registerCreditNoteIrp: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<CreditNoteDetailResponse>;
  readonly recoverCreditNoteProviderOperation: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<CreditNoteDetailResponse>;
  readonly cancelCreditNoteIrp: (
    organisationId: string,
    creditNoteId: string,
    body: CancelStatutoryDocumentRequest,
  ) => Promise<CreditNoteDetailResponse>;
  readonly creditNoteIrpPayload: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<string>;
  readonly renderCreditNote: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<CreditNoteDetailResponse>;
  readonly downloadCreditNotePdf: (
    organisationId: string,
    creditNoteId: string,
  ) => Promise<Blob>;
  /** The e-way bill moves a submitted invoice: drafted here, carried to
   * NIC by the GSP, and the 12-digit EWB number and validity window come
   * BACK from NIC. Draft -> generated -> cancelled. */
  readonly listInvoiceEwayBills: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<readonly EwayBill[]>;
  readonly createInvoiceEwayBill: (
    organisationId: string,
    invoiceId: string,
    body: SaveEwayBillRequest,
  ) => Promise<EwayBillDetailResponse>;
  readonly getEwayBill: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<EwayBillDetailResponse>;
  readonly updateEwayBill: (
    organisationId: string,
    ewayBillId: string,
    body: SaveEwayBillRequest,
  ) => Promise<EwayBillDetailResponse>;
  /** The NIC-ready EWB JSON; `unknown` for the same reason as the IRP
   * payload — NIC's shape, handed on rather than read into. */
  readonly ewayBillNicPayload: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<string>;
  readonly generateEwayBill: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<EwayBillDetailResponse>;
  readonly cancelEwayBillAtProvider: (
    organisationId: string,
    ewayBillId: string,
    body: CancelStatutoryDocumentRequest,
  ) => Promise<EwayBillDetailResponse>;
  readonly recoverEwayBillProviderOperation: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<EwayBillDetailResponse>;
  readonly recordEwayBillCancellation: (
    organisationId: string,
    ewayBillId: string,
    body: RecordManualStatutoryCancellationRequest,
  ) => Promise<EwayBillDetailResponse>;
  /** Records what NIC handed back through the GSP: the EWB number and
   * its validity window. */
  readonly recordEwayBillNicResponse: (
    organisationId: string,
    ewayBillId: string,
    body: RecordEwayNicResponseRequest,
  ) => Promise<EwayBillDetailResponse>;
  readonly cancelEwayBill: (
    organisationId: string,
    ewayBillId: string,
    body: CancelEwayBillRequest,
  ) => Promise<EwayBillDetailResponse>;
  readonly deleteEwayBill: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<void>;
  /** Per-item GST facts (HSN/SAC code, total GST rate, service flag) —
   * PATCH semantics: an omitted field keeps its value, an explicit null
   * clears it. Correctable at any time; issued documents snapshot what
   * they charged, so no history is rewritten. */
  /** The organisation's own number formats (migration 0039). Four
   * documents are configurable; a type the organisation has not
   * configured reports the product default with isDefault true. */
  readonly listNumberSeries: (
    organisationId: string,
  ) => Promise<readonly NumberSeries[]>;
  readonly setNumberSeries: (
    organisationId: string,
    documentType: NumberedDocumentType,
    body: SaveNumberSeriesRequest,
  ) => Promise<NumberSeries>;
  /** Restores the product default. Numbers already issued keep the
   * strings they were issued with; only future ones change. */
  readonly clearNumberSeries: (
    organisationId: string,
    documentType: NumberedDocumentType,
  ) => Promise<NumberSeries>;
  /** A DIRECT tax invoice: raised against a private customer, so it
   * names no Work and no Measurement Book and states its own taxable
   * value. */
  readonly createDirectTaxInvoice: (
    organisationId: string,
    body: CreateDirectTaxInvoiceRequest,
  ) => Promise<TaxInvoiceDetailResponse>;
  readonly setWorkItemTaxFacts: (
    organisationId: string,
    workItemId: string,
    body: SetWorkItemTaxFactsRequest,
  ) => Promise<WorkItemTaxFactsResponse>;
}

/** FormData.get can return a File; forms here only carry text inputs, so
 * anything else collapses to the empty string instead of
 * "[object File]". */
export function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function parseError(response: Response): Promise<RequestFailedError> {
  let code = 'REQUEST_ERROR';
  let message = `The server answered ${String(response.status)}.`;
  let details: unknown;
  let requestId: string | undefined;
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.requestId === 'string') requestId = body.requestId;
    details = body.details;
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return new RequestFailedError(response.status, code, message, details, requestId);
}

/**
 * All requests are same-origin with the session cookie; tenant-scoped calls
 * carry the selected organisation in the x-organisation-id header, which
 * the server re-validates against the database membership floor.
 */
export function createApiClient(fetchImpl: FetchLike = fetch): ApiClient {
  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      organisationId?: string;
    } = {},
  ): Promise<T> {
    const response = await fetchImpl(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.organisationId !== undefined
          ? { 'x-organisation-id': options.organisationId }
          : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) throw await parseError(response);
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  async function requestText(
    path: string,
    options: { organisationId?: string } = {},
  ): Promise<string> {
    const response = await fetchImpl(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers:
        options.organisationId === undefined
          ? {}
          : { 'x-organisation-id': options.organisationId },
    });
    if (!response.ok) throw await parseError(response);
    return response.text();
  }

  return {
    async me() {
      try {
        return await request<MeResponse>('/api/me');
      } catch (error) {
        if (error instanceof RequestFailedError && error.status === 401) {
          return null;
        }
        throw error;
      }
    },
    async signUp(email, name, password) {
      await request('/api/auth/sign-up/email', {
        method: 'POST',
        body: { email, name, password },
      });
    },
    async signIn(email, password) {
      // The response body decides what happened: a two-factor account
      // answers 200 with { twoFactorRedirect: true } and NO session —
      // discarding the body here would loop the operator back to the
      // password form forever.
      const outcome = await request<{ twoFactorRedirect?: boolean } | undefined>(
        '/api/auth/sign-in/email',
        { method: 'POST', body: { email, password } },
      );
      return { twoFactorRequired: outcome?.twoFactorRedirect === true };
    },
    async signOut() {
      await request('/api/auth/sign-out', { method: 'POST', body: {} });
    },
    async verifyTotp(code, trustDevice) {
      await request('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        body: { code, ...(trustDevice !== undefined ? { trustDevice } : {}) },
      });
    },
    async verifyBackupCode(code) {
      await request('/api/auth/two-factor/verify-backup-code', {
        method: 'POST',
        body: { code },
      });
    },
    async enableTwoFactor(password) {
      return request<TwoFactorEnrolmentStart>('/api/auth/two-factor/enable', {
        method: 'POST',
        body: { password },
      });
    },
    async disableTwoFactor(password) {
      await request('/api/auth/two-factor/disable', {
        method: 'POST',
        body: { password },
      });
    },
    async regenerateBackupCodes(password) {
      const payload = await request<{ backupCodes: readonly string[] }>(
        '/api/auth/two-factor/generate-backup-codes',
        { method: 'POST', body: { password } },
      );
      return payload.backupCodes;
    },
    async listOrganisations() {
      const payload = await request<{ organisations: Organisation[] }>(
        '/api/organisations',
      );
      return payload.organisations;
    },
    async createOrganisation(body) {
      return request<Organisation>('/api/organisations', {
        method: 'POST',
        body,
      });
    },
    async listMembers(organisationId) {
      const payload = await request<{ members: Membership[] }>(
        '/api/organisations/current/members',
        { organisationId },
      );
      return payload.members;
    },
    async addMember(organisationId, body) {
      const payload = await request<{ members: Membership[] }>(
        '/api/organisations/current/members',
        { method: 'POST', body, organisationId },
      );
      return payload.members;
    },
    async updateMember(organisationId, userId, body) {
      const payload = await request<{ members: Membership[] }>(
        `/api/organisations/current/members/${userId}`,
        { method: 'PATCH', body, organisationId },
      );
      return payload.members;
    },
    async memberAssignments(organisationId, userId) {
      return request<MemberAssignmentsResponse>(
        `/api/organisations/current/members/${userId}/assignments`,
        { organisationId },
      );
    },
    async setMemberAssignments(organisationId, userId, workIds) {
      return request<MemberAssignmentsResponse>(
        `/api/organisations/current/members/${userId}/assignments`,
        { method: 'PUT', body: { workIds }, organisationId },
      );
    },
    async listLoaDocuments(organisationId, options) {
      const payload = await request<{ documents: LoaDocument[] }>(
        options?.includeDiscarded === true
          ? '/api/loa-documents?includeDiscarded=true'
          : '/api/loa-documents',
        { organisationId },
      );
      return payload.documents;
    },
    async discardLoaDocument(organisationId, documentId, reason) {
      return request<DiscardLoaDocumentResponse>(
        `/api/loa-documents/${documentId}/discard`,
        {
          method: 'POST',
          body: reason === undefined ? {} : { reason },
          organisationId,
        },
      );
    },
    async discardContractSourceDocument(organisationId, documentId, reason) {
      return request<ContractSourceContext>(
        `/api/contract-source-documents/${documentId}/discard`,
        {
          method: 'POST',
          body: reason === undefined ? {} : { reason },
          organisationId,
        },
      );
    },
    async getLoaDocument(organisationId, documentId) {
      return request<LoaDocumentDetail>(`/api/loa-documents/${documentId}`, {
        organisationId,
      });
    },
    async uploadLoa(organisationId, file, filename) {
      // Raw binary body — the JSON `request` helper does not apply here.
      const response = await fetchImpl(
        `/api/loa-documents?filename=${encodeURIComponent(filename)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/pdf',
            'x-organisation-id': organisationId,
          },
          body: file,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as LoaDocumentDetail;
    },
    async uploadContractSource(organisationId, loaDocumentId, kind, file, filename) {
      const query = new URLSearchParams({ kind, filename });
      const response = await fetchImpl(
        `/api/loa-documents/${loaDocumentId}/contract-sources?${query.toString()}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/pdf',
            'x-organisation-id': organisationId,
          },
          body: file,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as ContractSourceUploadResponse;
    },
    async getLoaContractSourceContext(organisationId, loaDocumentId) {
      return request<ContractSourceContext>(
        `/api/loa-documents/${loaDocumentId}/contract-source-context`,
        { organisationId },
      );
    },
    async getWorkContractSourceContext(organisationId, workId) {
      return request<ContractSourceContext>(
        `/api/works/${workId}/contract-source-context`,
        { organisationId },
      );
    },
    async downloadContractSourceFile(organisationId, documentId) {
      const response = await fetchImpl(
        `/api/contract-source-documents/${documentId}/file`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async confirmLoa(organisationId, documentId, body) {
      return request<WorkDetailResponse>(`/api/loa-documents/${documentId}/confirm`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listWorks(organisationId) {
      const payload = await request<{ works: Work[] }>('/api/works', {
        organisationId,
      });
      return payload.works;
    },
    async getWork(organisationId, workId) {
      return request<WorkDetailResponse>(`/api/works/${workId}`, {
        organisationId,
      });
    },
    async workBalance(organisationId, workId) {
      return request<WorkBalanceResponse>(`/api/works/${workId}/balance`, {
        organisationId,
      });
    },
    async listChallans(organisationId, workId) {
      const payload = await request<{ challans: Challan[] }>(
        `/api/works/${workId}/challans`,
        { organisationId },
      );
      return payload.challans;
    },
    async getChallan(organisationId, challanId) {
      return request<ChallanDetailResponse>(`/api/challans/${challanId}`, {
        organisationId,
      });
    },
    async createChallan(organisationId, workId, body) {
      return request<ChallanDetailResponse>(`/api/works/${workId}/challans`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async updateChallan(organisationId, challanId, body) {
      return request<ChallanDetailResponse>(`/api/challans/${challanId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async deleteChallan(organisationId, challanId) {
      await request(`/api/challans/${challanId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async issueChallan(organisationId, challanId) {
      return request<ChallanDetailResponse>(`/api/challans/${challanId}/issue`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelChallan(organisationId, challanId, body) {
      return request<ChallanDetailResponse>(`/api/challans/${challanId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async renderChallan(organisationId, challanId) {
      return request<ChallanDetailResponse>(`/api/challans/${challanId}/render`, {
        method: 'POST',
        organisationId,
      });
    },
    async uploadSignedCopy(organisationId, challanId, file) {
      const response = await fetchImpl(`/api/challans/${challanId}/signed-copy`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/pdf',
          'x-organisation-id': organisationId,
        },
        body: file,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as ChallanDetailResponse;
    },
    async downloadChallanPdf(organisationId, challanId, kind) {
      // The tenant header travels on every scoped request, so PDFs are
      // fetched (not linked) and handed to the browser as object URLs.
      const response = await fetchImpl(`/api/challans/${challanId}/pdf?kind=${kind}`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async listIssueChallans(organisationId, workId) {
      const payload = await request<{ issueChallans: IssueChallan[] }>(
        `/api/works/${workId}/issue-challans`,
        { organisationId },
      );
      return payload.issueChallans;
    },
    async getIssueChallan(organisationId, challanId) {
      return request<IssueChallanDetailResponse>(`/api/issue-challans/${challanId}`, {
        organisationId,
      });
    },
    async createIssueChallan(organisationId, workId, body) {
      return request<IssueChallanDetailResponse>(
        `/api/works/${workId}/issue-challans`,
        { method: 'POST', body, organisationId },
      );
    },
    async updateIssueChallan(organisationId, challanId, body) {
      return request<IssueChallanDetailResponse>(`/api/issue-challans/${challanId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async deleteIssueChallan(organisationId, challanId) {
      await request(`/api/issue-challans/${challanId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async issueIssueChallan(organisationId, challanId) {
      return request<IssueChallanDetailResponse>(
        `/api/issue-challans/${challanId}/issue`,
        { method: 'POST', organisationId },
      );
    },
    async cancelIssueChallan(organisationId, challanId, body) {
      return request<IssueChallanDetailResponse>(
        `/api/issue-challans/${challanId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async renderIssueChallan(organisationId, challanId) {
      return request<IssueChallanDetailResponse>(
        `/api/issue-challans/${challanId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async uploadIssueChallanSignedCopy(organisationId, challanId, file) {
      const response = await fetchImpl(`/api/issue-challans/${challanId}/signed-copy`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/pdf',
          'x-organisation-id': organisationId,
        },
        body: file,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as IssueChallanDetailResponse;
    },
    async downloadIssueChallanPdf(organisationId, challanId, kind) {
      // The tenant header travels on every scoped request, so PDFs are
      // fetched (not linked) and handed to the browser as object URLs.
      const response = await fetchImpl(
        `/api/issue-challans/${challanId}/pdf?kind=${kind}`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async dashboard(organisationId) {
      return request<DashboardResponse>('/api/dashboard', { organisationId });
    },
    async organisationProfile(organisationId) {
      return request<OrganisationProfile>('/api/organisation/profile', {
        organisationId,
      });
    },
    async updateOrganisationProfile(organisationId, body) {
      return request<OrganisationProfile>('/api/organisation/profile', {
        method: 'PATCH',
        body,
        organisationId,
      });
    },
    async uploadLogo(organisationId, file, mediaType) {
      const response = await fetchImpl('/api/organisation/logo', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': mediaType,
          'x-organisation-id': organisationId,
        },
        body: file,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as OrganisationProfile;
    },
    async removeLogo(organisationId) {
      await request('/api/organisation/logo', {
        method: 'DELETE',
        organisationId,
      });
    },
    async logoBlob(organisationId) {
      const response = await fetchImpl('/api/organisation/logo', {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async getReceipt(organisationId, challanId) {
      try {
        return await request<Receipt>(`/api/challans/${challanId}/receipt`, {
          organisationId,
        });
      } catch (error) {
        // "No receipt yet" is an ordinary state, not a failure.
        if (
          error instanceof RequestFailedError &&
          error.status === 404 &&
          error.code === 'RECEIPT_NOT_FOUND'
        ) {
          return null;
        }
        throw error;
      }
    },
    async recordReceipt(organisationId, challanId, body) {
      return request<Receipt>(`/api/challans/${challanId}/receipt`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async recordSerials(organisationId, challanId, body) {
      const payload = await request<{ serials: Serial[] }>(
        `/api/challans/${challanId}/serials`,
        { method: 'POST', body, organisationId },
      );
      return payload.serials;
    },
    async recordInstallation(organisationId, serialId, body) {
      const payload = await request<{ serials: Serial[] }>(
        `/api/serials/${serialId}/installation`,
        { method: 'PUT', body, organisationId },
      );
      return payload.serials;
    },
    async listWorkSerials(organisationId, workId) {
      const payload = await request<{ serials: Serial[] }>(
        `/api/works/${workId}/serials`,
        { organisationId },
      );
      return payload.serials;
    },
    async deleteSerial(organisationId, serialId) {
      await request(`/api/serials/${serialId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async searchSerials(organisationId, query) {
      return request<SerialSearchResponse>(
        `/api/serials/search?q=${encodeURIComponent(query)}`,
        { organisationId },
      );
    },
    async updateWorkItemSerials(organisationId, workItemId, requiresSerials) {
      return request<WorkItemSerialsResponse>(
        `/api/work-items/${workItemId}/requires-serials`,
        { method: 'PATCH', body: { requiresSerials }, organisationId },
      );
    },
    async listInstruments(organisationId, workId) {
      const payload = await request<{ instruments: Instrument[] }>(
        `/api/works/${workId}/instruments`,
        { organisationId },
      );
      return payload.instruments;
    },
    async createInstrument(organisationId, workId, body) {
      return request<Instrument>(`/api/works/${workId}/instruments`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async updateInstrument(organisationId, instrumentId, body) {
      return request<Instrument>(`/api/instruments/${instrumentId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listMbEntries(organisationId, workId) {
      const payload = await request<{ entries: MbEntry[] }>(
        `/api/works/${workId}/mb-entries`,
        { organisationId },
      );
      return payload.entries;
    },
    async recordMbEntry(organisationId, workId, body) {
      return request<MbEntry>(`/api/works/${workId}/mb-entries`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listBills(organisationId, workId) {
      const payload = await request<{ bills: Bill[] }>(`/api/works/${workId}/bills`, {
        organisationId,
      });
      return payload.bills;
    },
    async setBillStatus(organisationId, billId, body) {
      return request<Bill>(`/api/bills/${billId}/status`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async workTimeline(organisationId, workId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) {
        parameters.set('limit', String(options.limit));
      }
      if (options.entityTypes !== undefined && options.entityTypes.length > 0) {
        parameters.set('entityTypes', options.entityTypes.join(','));
      }
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<TimelineResponse>(`/api/works/${workId}/timeline${suffix}`, {
        organisationId,
      });
    },
    async entityTimeline(organisationId, entityType, entityId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) {
        parameters.set('limit', String(options.limit));
      }
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<TimelineResponse>(
        `/api/audit/entity/${entityType}/${entityId}${suffix}`,
        { organisationId },
      );
    },
    async listContacts(organisationId, options = {}) {
      const query = new URLSearchParams();
      if (options.includeRetired === true) query.set('includeRetired', 'true');
      if (options.role !== undefined) query.set('role', options.role);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const payload = await request<{ contacts: Contact[] }>(
        `/api/masters/contacts${suffix}`,
        { organisationId },
      );
      return payload.contacts;
    },
    async saveContact(organisationId, id, body) {
      return request<Contact>(
        id === null ? '/api/masters/contacts' : `/api/masters/contacts/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setContactActive(organisationId, id, active) {
      return request<Contact>(
        `/api/masters/contacts/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
    },
    async listWorkConsignees(organisationId, workId) {
      const payload = await request<{ consignees: Contact[] }>(
        `/api/works/${workId}/consignees`,
        { organisationId },
      );
      return payload.consignees;
    },
    async linkWorkConsignee(organisationId, workId, contactId) {
      return request<Contact>(`/api/works/${workId}/consignees`, {
        method: 'POST',
        body: { contactId },
        organisationId,
      });
    },
    async unlinkWorkConsignee(organisationId, workId, contactId) {
      await request(`/api/works/${workId}/consignees/${contactId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listLocationMasters(organisationId, includeRetired = false) {
      const payload = await request<{ locations: LocationMaster[] }>(
        `/api/masters/locations${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
      return payload.locations;
    },
    async saveLocationMaster(organisationId, id, body) {
      return request<LocationMaster>(
        id === null ? '/api/masters/locations' : `/api/masters/locations/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setLocationMasterActive(organisationId, id, active) {
      return request<LocationMaster>(
        `/api/masters/locations/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
    },
    async listUnitMasters(organisationId, includeRetired = false) {
      const payload = await request<{ units: UnitMaster[] }>(
        `/api/masters/units${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
      return payload.units;
    },
    async saveUnitMaster(organisationId, id, body) {
      return request<UnitMaster>(
        id === null ? '/api/masters/units' : `/api/masters/units/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setUnitMasterActive(organisationId, id, active) {
      return request<UnitMaster>(
        `/api/masters/units/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
    },
    async listGstRates(organisationId) {
      const payload = await request<{ gstRates: GstRateMaster[] }>(
        '/api/masters/gst-rates',
        { organisationId },
      );
      return payload.gstRates;
    },
    async createGstRate(organisationId, body) {
      return request<GstRateMaster>('/api/masters/gst-rates', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async endDateGstRate(organisationId, id, body) {
      return request<GstRateMaster>(`/api/masters/gst-rates/${id}/end-date`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listSignatories(organisationId, includeRetired = false) {
      const payload = await request<{ signatories: Signatory[] }>(
        `/api/masters/signatories${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
      return payload.signatories;
    },
    async saveSignatory(organisationId, id, body) {
      return request<Signatory>(
        id === null ? '/api/masters/signatories' : `/api/masters/signatories/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setSignatoryActive(organisationId, id, active) {
      return request<Signatory>(
        `/api/masters/signatories/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
    },
    async getWorkCompletion(organisationId, workId) {
      return request<WorkCompletionResponse>(`/api/works/${workId}/completion`, {
        organisationId,
      });
    },
    async setCompletionDate(organisationId, workId, body) {
      return request<WorkCompletionResponse>(`/api/works/${workId}/completion-dates`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listApprovals(organisationId, status) {
      const query = status !== undefined ? `?status=${status}` : '';
      const payload = await request<{ approvals: ApprovalRequest[] }>(
        `/api/approvals${query}`,
        { organisationId },
      );
      return payload.approvals;
    },
    async listWorkAmendments(organisationId, workId) {
      const payload = await request<{ approvals: ApprovalRequest[] }>(
        `/api/works/${workId}/amendments`,
        { organisationId },
      );
      return payload.approvals;
    },
    async proposeAmendment(organisationId, workId, body) {
      return request<ApprovalRequest>(`/api/works/${workId}/amendments`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async createExtensionRequest(organisationId, workId, body) {
      return request<ExtensionRequestDetailResponse>(
        `/api/works/${workId}/extension-requests`,
        { method: 'POST', body, organisationId },
      );
    },
    async updateExtensionRequest(organisationId, extensionId, body) {
      return request<ExtensionRequestDetailResponse>(
        `/api/extension-requests/${extensionId}`,
        { method: 'PUT', body, organisationId },
      );
    },
    async deleteExtensionRequest(organisationId, extensionId) {
      await request(`/api/extension-requests/${extensionId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async finaliseExtensionRequest(organisationId, extensionId) {
      return request<ExtensionRequestDetailResponse>(
        `/api/extension-requests/${extensionId}/finalise`,
        { method: 'POST', organisationId },
      );
    },
    async renderExtensionRequest(organisationId, extensionId) {
      return request<ExtensionRequestDetailResponse>(
        `/api/extension-requests/${extensionId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async uploadExtensionResponse(organisationId, extensionId, file) {
      const response = await fetchImpl(
        `/api/extension-requests/${extensionId}/response-document`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/pdf',
            'x-organisation-id': organisationId,
          },
          body: file,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as ExtensionRequestDetailResponse;
    },
    async respondExtensionRequest(organisationId, extensionId, body) {
      return request<ExtensionRequestDetailResponse>(
        `/api/extension-requests/${extensionId}/respond`,
        { method: 'POST', body, organisationId },
      );
    },
    async downloadExtensionPdf(organisationId, extensionId, kind) {
      const response = await fetchImpl(
        `/api/extension-requests/${extensionId}/pdf?kind=${kind}`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async downloadExtensionDraftPreview(organisationId, extensionId) {
      const response = await fetchImpl(
        `/api/extension-requests/${extensionId}/draft-preview`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async backfillExtensionRequest(organisationId, workId, body) {
      return request<BackfillExtensionResponse>(
        `/api/works/${workId}/extension-requests/backfill`,
        { method: 'POST', body, organisationId },
      );
    },
    async proposeAddItem(organisationId, workId, body) {
      return request<ApprovalRequest>(`/api/works/${workId}/amendments/items`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async proposeItemRemoval(organisationId, workId, body) {
      return request<ApprovalRequest>(`/api/works/${workId}/amendments/removals`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async approveAmendment(organisationId, approvalId, note) {
      return request<ApprovalRequest>(`/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        body: note !== undefined ? { note } : {},
        organisationId,
      });
    },
    async rejectAmendment(organisationId, approvalId, note) {
      return request<ApprovalRequest>(`/api/approvals/${approvalId}/reject`, {
        method: 'POST',
        body: { note },
        organisationId,
      });
    },
    async withdrawAmendment(organisationId, approvalId) {
      return request<ApprovalRequest>(`/api/approvals/${approvalId}/withdraw`, {
        method: 'POST',
        organisationId,
      });
    },
    async setWorkSettings(organisationId, workId, allowExcessDelivery) {
      return request<WorkSettingsResponse>(`/api/works/${workId}`, {
        method: 'PATCH',
        body: { allowExcessDelivery },
        organisationId,
      });
    },
    async listWorkInstallations(organisationId, workId) {
      return request<InstallationListResponse>(`/api/works/${workId}/installations`, {
        organisationId,
      });
    },
    async recordWorkInstallation(organisationId, workId, body) {
      return request<Installation>(`/api/works/${workId}/installations`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async challanCorrectionEligibility(organisationId, challanId) {
      return request<CorrectionEligibilityResponse>(
        `/api/challans/${challanId}/correction-eligibility`,
        { organisationId },
      );
    },
    async proposeChallanCancelReplace(organisationId, challanId, body) {
      return request<ApprovalRequest>(
        `/api/challans/${challanId}/corrections/cancel-replace`,
        { method: 'POST', body, organisationId },
      );
    },
    async proposeIssueChallanCancelReplace(organisationId, challanId, body) {
      return request<ApprovalRequest>(
        `/api/issue-challans/${challanId}/corrections/cancel-replace`,
        { method: 'POST', body, organisationId },
      );
    },
    async proposeChallanCorrectionNotice(organisationId, challanId, body) {
      return request<ApprovalRequest>(`/api/challans/${challanId}/corrections/notice`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async cancelWorkInstallation(organisationId, installationId, note) {
      return request<Installation>(`/api/installations/${installationId}/cancel`, {
        method: 'POST',
        body: { note },
        organisationId,
      });
    },
    async listWorkCorrectionNotices(organisationId, workId) {
      const payload = await request<{ notices: CorrectionNotice[] }>(
        `/api/works/${workId}/correction-notices`,
        { organisationId },
      );
      return payload.notices;
    },
    async listChallanCorrectionNotices(organisationId, challanId) {
      const payload = await request<{ notices: CorrectionNotice[] }>(
        `/api/challans/${challanId}/correction-notices`,
        { organisationId },
      );
      return payload.notices;
    },
    async getCorrectionNotice(organisationId, noticeId) {
      return request<CorrectionNoticeDetailResponse>(
        `/api/correction-notices/${noticeId}`,
        { organisationId },
      );
    },
    async renderCorrectionNotice(organisationId, noticeId) {
      return request<CorrectionNoticeDetailResponse>(
        `/api/correction-notices/${noticeId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async cancelCorrectionNotice(organisationId, noticeId, note) {
      return request<CorrectionNoticeDetailResponse>(
        `/api/correction-notices/${noticeId}/cancel`,
        { method: 'POST', body: { note }, organisationId },
      );
    },
    async downloadCorrectionNoticePdf(organisationId, noticeId) {
      const response = await fetchImpl(`/api/correction-notices/${noticeId}/pdf`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async getPaymentMatrix(organisationId, workId) {
      const payload = await request<{ rows: PaymentMatrixRow[] }>(
        `/api/works/${workId}/payment-matrix`,
        { organisationId },
      );
      return payload.rows;
    },
    async upsertPaymentMatrixRow(organisationId, workId, category, body) {
      return request<PaymentMatrixRow>(
        `/api/works/${workId}/payment-matrix/${category}`,
        { method: 'PUT', body, organisationId },
      );
    },
    async deletePaymentMatrixRow(organisationId, workId, category) {
      await request<void>(`/api/works/${workId}/payment-matrix/${category}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async setWorkItemPaymentCategory(organisationId, workItemId, paymentCategory) {
      return request<WorkItemPaymentCategoryResponse>(
        `/api/work-items/${workItemId}/payment-category`,
        { method: 'PATCH', body: { paymentCategory }, organisationId },
      );
    },
    async listWorkPacCertificates(organisationId, workId) {
      return request<PacCertificateListResponse>(
        `/api/works/${workId}/pac-certificates`,
        { organisationId },
      );
    },
    async recordWorkPacCertificate(organisationId, workId, body) {
      return request<PacCertificate>(`/api/works/${workId}/pac-certificates`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async cancelPacCertificate(organisationId, certificateId, note) {
      return request<PacCertificate>(`/api/pac-certificates/${certificateId}/cancel`, {
        method: 'POST',
        body: { note },
        organisationId,
      });
    },
    async uploadPacCertificateDocument(organisationId, certificateId, file) {
      const response = await fetchImpl(
        `/api/pac-certificates/${certificateId}/document`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/pdf',
            'x-organisation-id': organisationId,
          },
          body: file,
        },
      );
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as PacCertificate;
    },
    async downloadPacCertificateDocument(organisationId, certificateId) {
      const response = await fetchImpl(
        `/api/pac-certificates/${certificateId}/document`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async listWorkMeasurementBooks(organisationId, workId) {
      return request<MeasurementBookListResponse>(
        `/api/works/${workId}/measurement-books`,
        { organisationId },
      );
    },
    async createWorkMeasurementBook(organisationId, workId, body) {
      return request<MeasurementBookDetailResponse>(
        `/api/works/${workId}/measurement-books`,
        { method: 'POST', body, organisationId },
      );
    },
    async mergeWorkMeasurementBooks(organisationId, workId, body) {
      return request<MeasurementBookDetailResponse>(
        `/api/works/${workId}/measurement-books/merge`,
        { method: 'POST', body, organisationId },
      );
    },
    async unmergeMeasurementBook(organisationId, measurementBookId) {
      await request(`/api/measurement-books/${measurementBookId}/unmerge`, {
        method: 'POST',
        organisationId,
      });
    },
    async getMeasurementBook(organisationId, measurementBookId) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}`,
        { organisationId },
      );
    },
    async setMeasurementBookSources(organisationId, measurementBookId, body) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/sources`,
        { method: 'PUT', body, organisationId },
      );
    },
    async finalizeMeasurementBook(organisationId, measurementBookId) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/finalize`,
        { method: 'POST', organisationId },
      );
    },
    async cancelMeasurementBook(organisationId, measurementBookId, note) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/cancel`,
        { method: 'POST', body: { note }, organisationId },
      );
    },
    async deleteMeasurementBook(organisationId, measurementBookId) {
      await request<void>(`/api/measurement-books/${measurementBookId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async prepareBillFromMeasurementBook(organisationId, measurementBookId) {
      return request<Bill>(`/api/measurement-books/${measurementBookId}/bill`, {
        method: 'POST',
        organisationId,
      });
    },
    async renderMeasurementBook(organisationId, measurementBookId) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async downloadMeasurementBookPdf(organisationId, measurementBookId) {
      const response = await fetchImpl(
        `/api/measurement-books/${measurementBookId}/pdf`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async downloadMeasurementBookDraftPreview(organisationId, measurementBookId) {
      const response = await fetchImpl(
        `/api/measurement-books/${measurementBookId}/pdf?preview=1`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async completeWork(organisationId, workId, body) {
      return request<WorkStatusResponse>(`/api/works/${workId}/complete`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async workCompletionReadiness(organisationId, workId) {
      return request<WorkCompletionReadiness>(
        `/api/works/${workId}/completion-readiness`,
        { organisationId },
      );
    },
    async reopenWork(organisationId, workId, body) {
      return request<WorkStatusResponse>(`/api/works/${workId}/reopen`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listWorkPurchaseOrders(organisationId, workId, status) {
      const query = status !== undefined ? `?status=${status}` : '';
      const payload = await request<{ purchaseOrders: PurchaseOrder[] }>(
        `/api/works/${workId}/purchase-orders${query}`,
        { organisationId },
      );
      return payload.purchaseOrders;
    },
    async createWorkPurchaseOrder(organisationId, workId, body) {
      return request<PurchaseOrderDetailResponse>(
        `/api/works/${workId}/purchase-orders`,
        { method: 'POST', body, organisationId },
      );
    },
    async getPurchaseOrder(organisationId, purchaseOrderId) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}`,
        { organisationId },
      );
    },
    async updatePurchaseOrder(organisationId, purchaseOrderId, body) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}`,
        { method: 'PUT', body, organisationId },
      );
    },
    async savePurchaseOrderLines(organisationId, purchaseOrderId, body) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}/lines`,
        { method: 'PUT', body, organisationId },
      );
    },
    async issuePurchaseOrder(organisationId, purchaseOrderId) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}/issue`,
        { method: 'POST', organisationId },
      );
    },
    async cancelPurchaseOrder(organisationId, purchaseOrderId, body) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async closePurchaseOrder(organisationId, purchaseOrderId) {
      return request<PurchaseOrderDetailResponse>(
        `/api/purchase-orders/${purchaseOrderId}/close`,
        { method: 'POST', organisationId },
      );
    },
    async deletePurchaseOrder(organisationId, purchaseOrderId) {
      await request(`/api/purchase-orders/${purchaseOrderId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listBudgetaryQuotations(organisationId) {
      const payload = await request<{ budgetaryQuotations: BudgetaryQuotation[] }>(
        '/api/budgetary-quotations',
        { organisationId },
      );
      return payload.budgetaryQuotations;
    },
    async createBudgetaryQuotation(organisationId, body) {
      return request<BudgetaryQuotationDetailResponse>('/api/budgetary-quotations', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async getBudgetaryQuotation(organisationId, quotationId) {
      return request<BudgetaryQuotationDetailResponse>(
        `/api/budgetary-quotations/${quotationId}`,
        { organisationId },
      );
    },
    async updateBudgetaryQuotation(organisationId, quotationId, body) {
      return request<BudgetaryQuotationDetailResponse>(
        `/api/budgetary-quotations/${quotationId}`,
        { method: 'PUT', body, organisationId },
      );
    },
    async saveBudgetaryQuotationLines(organisationId, quotationId, body) {
      return request<BudgetaryQuotationDetailResponse>(
        `/api/budgetary-quotations/${quotationId}/lines`,
        { method: 'PUT', body, organisationId },
      );
    },
    async issueBudgetaryQuotation(organisationId, quotationId) {
      return request<BudgetaryQuotationDetailResponse>(
        `/api/budgetary-quotations/${quotationId}/issue`,
        { method: 'POST', organisationId },
      );
    },
    async setBudgetaryQuotationOutcome(organisationId, quotationId, body) {
      return request<BudgetaryQuotationDetailResponse>(
        `/api/budgetary-quotations/${quotationId}/outcome`,
        { method: 'POST', body, organisationId },
      );
    },
    async deleteBudgetaryQuotation(organisationId, quotationId) {
      await request(`/api/budgetary-quotations/${quotationId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listWorkTaxInvoices(organisationId, workId) {
      const payload = await request<{ invoices: TaxInvoice[] }>(
        `/api/works/${workId}/tax-invoices`,
        { organisationId },
      );
      return payload.invoices;
    },
    async createWorkTaxInvoice(organisationId, workId, body) {
      return request<TaxInvoiceDetailResponse>(`/api/works/${workId}/tax-invoices`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async getTaxInvoice(organisationId, invoiceId) {
      return request<TaxInvoiceDetailResponse>(`/api/tax-invoices/${invoiceId}`, {
        organisationId,
      });
    },
    async updateTaxInvoice(organisationId, invoiceId, body) {
      return request<TaxInvoiceDetailResponse>(`/api/tax-invoices/${invoiceId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async submitTaxInvoice(organisationId, invoiceId) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/submit`,
        { method: 'POST', organisationId },
      );
    },
    async renderTaxInvoice(organisationId, invoiceId) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async downloadTaxInvoicePdf(organisationId, invoiceId) {
      const response = await fetchImpl(`/api/tax-invoices/${invoiceId}/pdf`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async cancelTaxInvoice(organisationId, invoiceId, body) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async deleteTaxInvoice(organisationId, invoiceId) {
      await request(`/api/tax-invoices/${invoiceId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async taxInvoiceIrpPayload(organisationId, invoiceId) {
      return requestText(`/api/tax-invoices/${invoiceId}/irp-payload`, {
        organisationId,
      });
    },
    async registerTaxInvoiceIrp(organisationId, invoiceId) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/register-irp`,
        { method: 'POST', organisationId },
      );
    },
    async recoverTaxInvoiceProviderOperation(organisationId, invoiceId) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/recover-provider-operation`,
        { method: 'POST', organisationId },
      );
    },
    async cancelTaxInvoiceIrp(organisationId, invoiceId, body) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/cancel-irp`,
        { method: 'POST', body, organisationId },
      );
    },
    async recordTaxInvoiceIrpCancellation(organisationId, invoiceId, body) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/irp-cancel-response`,
        { method: 'POST', body, organisationId },
      );
    },
    async recordTaxInvoiceIrpResponse(organisationId, invoiceId, body) {
      return request<TaxInvoiceDetailResponse>(
        `/api/tax-invoices/${invoiceId}/irp-response`,
        { method: 'POST', body, organisationId },
      );
    },
    async listCreditNotes(organisationId) {
      const payload = await request<{ creditNotes: CreditNote[] }>(
        '/api/credit-notes',
        { organisationId },
      );
      return payload.creditNotes;
    },
    async listInvoiceCreditNotes(organisationId, invoiceId) {
      const payload = await request<{ creditNotes: CreditNote[] }>(
        `/api/tax-invoices/${invoiceId}/credit-notes`,
        { organisationId },
      );
      return payload.creditNotes;
    },
    async createCreditNote(organisationId, invoiceId, body) {
      return request<CreditNoteDetailResponse>(
        `/api/tax-invoices/${invoiceId}/credit-notes`,
        { method: 'POST', body, organisationId },
      );
    },
    async getCreditNote(organisationId, creditNoteId) {
      return request<CreditNoteDetailResponse>(`/api/credit-notes/${creditNoteId}`, {
        organisationId,
      });
    },
    async updateCreditNote(organisationId, creditNoteId, body) {
      return request<CreditNoteDetailResponse>(`/api/credit-notes/${creditNoteId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async deleteCreditNote(organisationId, creditNoteId) {
      await request(`/api/credit-notes/${creditNoteId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async issueCreditNote(organisationId, creditNoteId) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/issue`,
        { method: 'POST', organisationId },
      );
    },
    async cancelCreditNote(organisationId, creditNoteId, body) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async updateCreditNoteRecipientItc(organisationId, creditNoteId, body) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/recipient-itc`,
        { method: 'PUT', body, organisationId },
      );
    },
    async registerCreditNoteIrp(organisationId, creditNoteId) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/register-irp`,
        { method: 'POST', organisationId },
      );
    },
    async recoverCreditNoteProviderOperation(organisationId, creditNoteId) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/recover-provider-operation`,
        { method: 'POST', organisationId },
      );
    },
    async cancelCreditNoteIrp(organisationId, creditNoteId, body) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/cancel-irp`,
        { method: 'POST', body, organisationId },
      );
    },
    async creditNoteIrpPayload(organisationId, creditNoteId) {
      return requestText(`/api/credit-notes/${creditNoteId}/irp-payload`, {
        organisationId,
      });
    },
    async renderCreditNote(organisationId, creditNoteId) {
      return request<CreditNoteDetailResponse>(
        `/api/credit-notes/${creditNoteId}/render`,
        { method: 'POST', organisationId },
      );
    },
    async downloadCreditNotePdf(organisationId, creditNoteId) {
      const response = await fetchImpl(`/api/credit-notes/${creditNoteId}/pdf`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async listInvoiceEwayBills(organisationId, invoiceId) {
      const payload = await request<{ ewayBills: EwayBill[] }>(
        `/api/tax-invoices/${invoiceId}/eway-bills`,
        { organisationId },
      );
      return payload.ewayBills;
    },
    async createInvoiceEwayBill(organisationId, invoiceId, body) {
      return request<EwayBillDetailResponse>(
        `/api/tax-invoices/${invoiceId}/eway-bills`,
        { method: 'POST', body, organisationId },
      );
    },
    async getEwayBill(organisationId, ewayBillId) {
      return request<EwayBillDetailResponse>(`/api/eway-bills/${ewayBillId}`, {
        organisationId,
      });
    },
    async updateEwayBill(organisationId, ewayBillId, body) {
      return request<EwayBillDetailResponse>(`/api/eway-bills/${ewayBillId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async ewayBillNicPayload(organisationId, ewayBillId) {
      return requestText(`/api/eway-bills/${ewayBillId}/nic-payload`, {
        organisationId,
      });
    },
    async generateEwayBill(organisationId, ewayBillId) {
      return request<EwayBillDetailResponse>(`/api/eway-bills/${ewayBillId}/generate`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelEwayBillAtProvider(organisationId, ewayBillId, body) {
      return request<EwayBillDetailResponse>(
        `/api/eway-bills/${ewayBillId}/cancel-provider`,
        { method: 'POST', body, organisationId },
      );
    },
    async recoverEwayBillProviderOperation(organisationId, ewayBillId) {
      return request<EwayBillDetailResponse>(
        `/api/eway-bills/${ewayBillId}/recover-provider-operation`,
        { method: 'POST', organisationId },
      );
    },
    async recordEwayBillCancellation(organisationId, ewayBillId, body) {
      return request<EwayBillDetailResponse>(
        `/api/eway-bills/${ewayBillId}/manual-cancel-response`,
        { method: 'POST', body, organisationId },
      );
    },
    async recordEwayBillNicResponse(organisationId, ewayBillId, body) {
      return request<EwayBillDetailResponse>(
        `/api/eway-bills/${ewayBillId}/nic-response`,
        { method: 'POST', body, organisationId },
      );
    },
    async cancelEwayBill(organisationId, ewayBillId, body) {
      return request<EwayBillDetailResponse>(`/api/eway-bills/${ewayBillId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async deleteEwayBill(organisationId, ewayBillId) {
      await request(`/api/eway-bills/${ewayBillId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listNumberSeries(organisationId) {
      const payload = await request<{ series: NumberSeries[] }>(
        '/api/organisation/number-series',
        { organisationId },
      );
      return payload.series;
    },
    async setNumberSeries(organisationId, documentType, body) {
      return request<NumberSeries>(`/api/organisation/number-series/${documentType}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async clearNumberSeries(organisationId, documentType) {
      return request<NumberSeries>(`/api/organisation/number-series/${documentType}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async createDirectTaxInvoice(organisationId, body) {
      return request<TaxInvoiceDetailResponse>('/api/tax-invoices', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async setWorkItemTaxFacts(organisationId, workItemId, body) {
      return request<WorkItemTaxFactsResponse>(
        `/api/work-items/${workItemId}/tax-facts`,
        { method: 'PATCH', body, organisationId },
      );
    },
  };
}
