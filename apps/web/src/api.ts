import type {
  AuditFacetsResponse,
  AuditRegisterQuery,
  AuditRegisterResponse,
  ExportableRegister,
  MisSummaryResponse,
  EntitlementFlagKey,
  EntitlementListResponse,
  EntitlementResponse,
  JobScheduleListResponse,
  JobScheduleResponse,
  OrganisationExportListResponse,
  OrganisationExportResponse,
  ScheduledJobKind,
  SetEntitlementRequest,
  UpdateJobScheduleRequest,
  CloseWarrantyRequest,
  ExtendWarrantyRequest,
  SaveWarrantyTermsRequest,
  StartWarrantyRequest,
  Warranty,
  WarrantyRegisterResponse,
  WarrantyStanding,
  WarrantyTerms,
  WorkWarrantyResponse,
  ApproveMaintenanceRequest,
  CancelMaintenanceLine,
  CreateMaintenanceRequest,
  MaintenanceDetailResponse,
  MaintenanceListResponse,
  ReceiveMaintenanceReturn,
  RecordMaintenanceDispatch,
  AddMemberRequest,
  CancelPayrollRun,
  CreateEmployee,
  EmployeeListResponse,
  EmployeeResponse,
  OpenPayrollRun,
  PayrollRunListResponse,
  PayrollRunResponse,
  SetPayrollLineLop,
  UpdateEmployee,
  CreateShortagePurchaseOrderRequest,
  CreateStockMovementRequest,
  PendingProductionReceiptListResponse,
  RecordProductionReceiptRequest,
  SetReorderLevelRequest,
  StockItemResponse,
  StockMovementListResponse,
  StockMovementResponse,
  StockRegisterResponse,
  StockShortageResponse,
  CancelSigningRequest,
  CreateSigningRequest,
  RegisterSigningAgent,
  RegisterSigningAgentResponse,
  SigningAgentResponse,
  ImportBatchDetail,
  ImportBatchList,
  ImportRowStatus,
  ImportTargetKey,
  SigningQueueResponse,
  CreateNotificationTemplate,
  NotificationChannelListResponse,
  NotificationChannelName,
  NotificationChannelResponse,
  NotificationConsentListResponse,
  NotificationConsentResponse,
  NotificationMessageListResponse,
  NotificationMessageResponse,
  NotificationTemplateListResponse,
  NotificationTemplateResponse,
  RecordNotificationConsent,
  RecordStaffNotificationConsent,
  SaveNotificationChannel,
  SendNotification,
  SetNotificationTemplateStatus,
  StaffNotificationConsentResponse,
  SigningRequestResponse,
  SigningRequestStatus,
  ApiError,
  ApprovalRequest,
  ApprovalStatus,
  AttachVariationOrderResponse,
  CorrectionEligibilityResponse,
  CorrectionNotice,
  CorrectionNoticeDetailResponse,
  ProposeChallanCancelReplaceRequest,
  ProposeWorkSupersedeRequest,
  SupersedeEligibilityResponse,
  WorkSupersession,
  WorkSupersessionResponse,
  ProposeCorrectionNoticeRequest,
  ProposeIssueChallanCancelReplaceRequest,
  CancelVendorInvoice,
  CreatePaymentRequest,
  DecidePaymentRequest,
  PayPaymentRequest,
  PaymentRequest,
  PaymentRequestListResponse,
  RecordAdvanceBills,
  RecordVendorInvoice,
  PreviewVendorTds,
  RecordVendorPayment,
  TdsPreviewResponse,
  VendorInvoice,
  VendorLedgerResponse,
  VendorPayment,
  VoidVendorPayment,
  Bill,
  BillListResponse,
  CancelChallanRequest,
  BomResponse,
  CanonicalItem,
  CanonicalItemListResponse,
  ChallanDetailResponse,
  Challan,
  CompanyDocument,
  CompanyDocumentCategory,
  CompanyDocumentListResponse,
  CancelInspectionCallRequest,
  CreateInspectionCallRequest,
  InspectionCall,
  InspectionCallListResponse,
  SaveInspectionChecklistRequest,
  SaveInspectionClausesRequest,
  WorkInspectionConfig,
  AddTenderChecklistItemRequest,
  ConfirmTenderRequest,
  TenderDetail,
  TenderListResponse,
  CorrespondenceListResponse,
  CorrespondenceTab,
  CorrespondenceThreadOptionsResponse,
  WriteOutwardLetterRequest,
  TenderNotice,
  UpdateTenderStatusRequest,
  ConfirmWorkRequest,
  ContractSourceContext,
  ContractSourceDocumentKind,
  ContractSourceUploadResponse,
  Contact,
  DeliveryChallanRegisterEntry,
  CreateOrganisationRequest,
  DashboardResponse,
  DiscardLoaDocumentResponse,
  ExtensionRequestDetailResponse,
  InstallSerialRequest,
  Instrument,
  IssueChallan,
  IssueChallanDetailResponse,
  IssueChallanRegisterEntry,
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
  RecordReceiptRequest,
  RecordSerialsRequest,
  RespondExtensionRequest,
  BackfillExtensionRequest,
  BackfillExtensionResponse,
  CreateGstRateRequest,
  CreateOrganisationBankAccountRequest,
  EndDateGstRateRequest,
  GstRateMaster,
  OrganisationBankAccount,
  CancelJobCardRequest,
  CreateDispatchRequest,
  CreateJobCardRequest,
  JobCardDetail,
  JobCardListResponse,
  ProductionItem,
  ProductionItemListResponse,
  RecordComponentSerialRequest,
  SaveBomLineRequest,
  SaveCanonicalItemRequest,
  SaveProductionItemRequest,
  UpdateJobCardRequest,
  SaveChallanRequest,
  SaveContactRequest,
  SaveStandaloneChallanRequest,
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
  SearchResponse,
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
  InstallationRegisterResponse,
  RecordInstallationBatchRequest,
  RecordInstallationBatchResponse,
  RecordInstallationRequest,
  PaymentMatrixCategory,
  PaymentMatrixRow,
  PaymentSetupResponse,
  SavePaymentSetupRequest,
  UpsertPaymentMatrixRowRequest,
  WorkItemPaymentCategory,
  WorkItemPaymentCategoryResponse,
  PacCertificate,
  AmcCycleProposalResponse,
  PacCertificateListResponse,
  RecordPacCertificateRequest,
  CreateMeasurementBookRequest,
  MeasurementBookDetailResponse,
  ReceivedRailwayBill,
  ReceivedRailwayBillListResponse,
  BillPayment,
  BillSettlementPosition,
  BillSettlementResponse,
  ReceivablesRegisterResponse,
  RecordBillPaymentRequest,
  AssessLdRequest,
  DecideLdAssessmentRequest,
  LdAssessment,
  RecordRetentionReleaseRequest,
  RetentionRelease,
  SaveWorkRetentionTermsRequest,
  WorkRetentionResponse,
  WorkRetentionTerms,
  MeasurementBookListResponse,
  SetMbMeasuredQuantitiesRequest,
  SetMbSourcesRequest,
  SetScheduleAmcCycleRequest,
  MergeMeasurementBooksRequest,
  PurchaseOrder,
  PurchaseOrderStatus,
  PurchaseOrderDetailResponse,
  PurchaseOrderRegisterResponse,
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
  TaxInvoiceRegisterResponse,
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
import { isOffline } from './lib/offline.js';

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
interface SignInResult {
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

/**
 * Error carrying the server's ApiError envelope for user-facing display.
 * `details` carries structured conflict payloads (e.g. one-draft 409s
 * answer with the existing draft's id — see existingRecordIdOf).
 *
 * ## Why `message` is the fact AND the remedy
 *
 * The envelope carries two sentences: `message` states what was refused,
 * written by the route that refused it, and `remedy` states the action
 * that clears it, written once per error code in the server's remedy
 * catalog. The envelope shipped ahead of its reader — until now every
 * screen rendered the fact and dropped the advice on the floor, which is
 * the dead end the reconciled review counted (about three-quarters of
 * refusals stating a fact with no next step).
 *
 * Joining them into `message` here, rather than adding a second prop to
 * every failure panel and inline alert in the client, is what makes that
 * one change instead of forty: every place that already renders an error
 * message renders the remedy with it, in the order an operator reads —
 * what happened, then what to do. `fact` and `remedy` stay available
 * separately for anything that needs to lay them out itself.
 */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;
  /** The server's own sentence, without the remedy appended. */
  readonly fact: string;
  /** The reviewed next action for this code, when the server sent one.
   * Null is normal: a refusal with no reviewed action carries no field
   * rather than filler. */
  readonly remedy: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    requestId?: string,
    remedy?: string,
  ) {
    const advice = remedy !== undefined && remedy !== '' ? remedy : null;
    super(advice === null ? message : `${message} ${advice}`);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
    this.requestId = requestId ?? null;
    this.fact = message;
    this.remedy = advice;
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
  /** Asks the server to email a single-use password-reset link. Answers
   * the same way for a known and an unknown address, so nothing here
   * reveals whether an account exists; `redirectTo` is where the link
   * lands once the server has checked the token, and must be an origin
   * the server trusts. */
  readonly requestPasswordReset: (email: string, redirectTo: string) => Promise<void>;
  /** Spends a reset token on a new password. The second factor is
   * untouched: the next sign-in still asks for the authenticator code. */
  readonly resetPassword: (token: string, newPassword: string) => Promise<void>;
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
  /** The Delivery Challan module's register: every movement in the
   * organisation the caller may see, of all three kinds. `workId`
   * narrows it to one Work — the module's `?work=` deep link, pushed into
   * the request so the answer is that Work's movements rather than the
   * ones that happened to be on the page. */
  readonly listDeliveryChallans: (
    organisationId: string,
    workId?: string | null,
  ) => Promise<readonly DeliveryChallanRegisterEntry[]>;
  /** The Challans module's issue register: every issue challan in the
   * organisation the caller may see, with the Work each belongs to. */
  readonly listIssueChallanRegister: (
    organisationId: string,
  ) => Promise<readonly IssueChallanRegisterEntry[]>;
  readonly createStandaloneChallan: (
    organisationId: string,
    body: SaveStandaloneChallanRequest,
  ) => Promise<ChallanDetailResponse>;
  readonly updateStandaloneChallan: (
    organisationId: string,
    challanId: string,
    body: SaveStandaloneChallanRequest,
  ) => Promise<ChallanDetailResponse>;
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
  /** Tenant-wide record search across Works and the document registers. */
  readonly search: (organisationId: string, query: string) => Promise<SearchResponse>;
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
  /** The Work's bills AND its billing position. The summary is served
   * beside the list rather than derived from it: measured, billed and
   * unbilled are money, and money is summed in SQL numeric, never in the
   * browser (`AGENTS.md` rule 5). */
  readonly listBills: (
    organisationId: string,
    workId: string,
  ) => Promise<BillListResponse>;
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
  /** The organisation-wide audit register (0095). Gated on the audit
   * authority AND full work scope; a member without either gets a 403
   * that names which wall, and the register view renders the sentence
   * rather than a retry. */
  readonly auditRegister: (
    organisationId: string,
    options?: AuditRegisterQuery,
  ) => Promise<AuditRegisterResponse>;
  /** The filter vocabularies, read from the trail itself rather than
   * hand-maintained on the client — the action list grows every wave. */
  readonly auditFacets: (organisationId: string) => Promise<AuditFacetsResponse>;
  /** The management summary: three aggregates the landing dashboard does
   * not carry. `payrollCost` is null for a caller without the payroll
   * authority; the rest is still served. */
  readonly misSummary: (
    organisationId: string,
    options?: { readonly months?: number },
  ) => Promise<MisSummaryResponse>;
  /** Any major register as an .xlsx workbook. Work-scoped registers
   * narrow to the caller's assignments; organisation-wide ones refuse a
   * caller who cannot see every Work. */
  readonly downloadRegisterWorkbook: (
    organisationId: string,
    register: ExportableRegister,
  ) => Promise<Blob>;
  /** The audit register as a workbook, under the same filters the screen
   * is showing. */
  readonly downloadAuditWorkbook: (
    organisationId: string,
    options?: AuditRegisterQuery,
  ) => Promise<Blob>;
  /** The accountant's Tally import file for one window. Owner-only. */
  readonly downloadTallyExport: (
    organisationId: string,
    window: { readonly from: string; readonly to: string },
  ) => Promise<Blob>;
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
  /** The canonical item catalogue. Unlike the pickers above this answers
   * a count of the schedule lines still matching nothing, which the tab
   * prints as its warning line. */
  readonly listCanonicalItems: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<CanonicalItemListResponse>;
  readonly saveCanonicalItem: (
    organisationId: string,
    id: string | null,
    body: SaveCanonicalItemRequest,
  ) => Promise<CanonicalItem>;
  readonly setCanonicalItemActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<CanonicalItem>;
  /** The organisation's own bank accounts. The stored account number is
   * never returned — every row carries its last four digits only. */
  readonly listOrganisationBankAccounts: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<readonly OrganisationBankAccount[]>;
  readonly createOrganisationBankAccount: (
    organisationId: string,
    body: CreateOrganisationBankAccountRequest,
  ) => Promise<OrganisationBankAccount>;
  readonly setOrganisationBankAccountActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<OrganisationBankAccount>;
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
  readonly listPaymentRequests: (
    organisationId: string,
  ) => Promise<PaymentRequestListResponse>;
  readonly createPaymentRequest: (
    organisationId: string,
    body: CreatePaymentRequest,
  ) => Promise<PaymentRequest>;
  readonly decidePaymentRequest: (
    organisationId: string,
    requestId: string,
    body: DecidePaymentRequest,
  ) => Promise<PaymentRequest>;
  readonly payPaymentRequest: (
    organisationId: string,
    requestId: string,
    body: PayPaymentRequest,
  ) => Promise<PaymentRequest>;
  readonly recordAdvanceBills: (
    organisationId: string,
    requestId: string,
    body: RecordAdvanceBills,
  ) => Promise<PaymentRequest>;
  readonly listVendorInvoices: (
    organisationId: string,
  ) => Promise<VendorLedgerResponse>;
  readonly recordVendorInvoice: (
    organisationId: string,
    body: RecordVendorInvoice,
  ) => Promise<VendorInvoice>;
  /** The vendor's own tax invoice as a PDF (migration 0109). Stored once:
   * a second upload is refused with VENDOR_INVOICE_DOCUMENT_EXISTS, and a
   * purchase order does not close until one of its invoices has this. */
  readonly uploadVendorInvoiceDocument: (
    organisationId: string,
    invoiceId: string,
    file: Blob,
    filename: string,
  ) => Promise<VendorInvoice>;
  readonly downloadVendorInvoiceDocument: (
    organisationId: string,
    invoiceId: string,
  ) => Promise<Blob>;
  readonly previewVendorTds: (
    organisationId: string,
    invoiceId: string,
    body: PreviewVendorTds,
  ) => Promise<TdsPreviewResponse>;
  readonly recordVendorPayment: (
    organisationId: string,
    invoiceId: string,
    body: RecordVendorPayment,
  ) => Promise<VendorPayment>;
  readonly voidVendorPayment: (
    organisationId: string,
    paymentId: string,
    body: VoidVendorPayment,
  ) => Promise<VendorPayment>;
  readonly cancelVendorInvoice: (
    organisationId: string,
    invoiceId: string,
    body: CancelVendorInvoice,
  ) => Promise<VendorInvoice>;
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
  /** Whether this Work may still be withdrawn and its letter read again
   * (migration 0071), and what stands in the way if not. */
  readonly getSupersedeEligibility: (
    organisationId: string,
    workId: string,
  ) => Promise<SupersedeEligibilityResponse>;
  readonly proposeWorkSupersede: (
    organisationId: string,
    workId: string,
    body: ProposeWorkSupersedeRequest,
  ) => Promise<ApprovalRequest>;
  /** The supersession this Work is the successor of; null for a Work that
   * replaced nothing. The withdrawn Work is not otherwise readable. */
  readonly getWorkSupersession: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkSupersession | null>;
  /** Cites the railway variation order that authorises an omission. The
   * server extracts and verifies every fact from the PDF itself; the
   * client sends only the file. */
  readonly attachVariationOrder: (
    organisationId: string,
    approvalId: string,
    file: Blob,
    filename: string,
  ) => Promise<AttachVariationOrderResponse>;
  readonly downloadVariationOrderFile: (
    organisationId: string,
    approvalId: string,
  ) => Promise<Blob>;
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
  /** The installation module's own register: every record in the
   * organisation the caller may see, across all their Works. Paged — the
   * screen sends a `limit` and pages with `nextCursor` — and narrowable to
   * an inclusive `installedOn` window. */
  readonly listInstallations: (
    organisationId: string,
    options?: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly installedFrom?: string;
      readonly installedTo?: string;
    },
  ) => Promise<InstallationRegisterResponse>;
  readonly recordWorkInstallation: (
    organisationId: string,
    workId: string,
    body: RecordInstallationRequest,
  ) => Promise<Installation>;
  /** One site visit: a shared date and location, one record per filled
   * row. All or nothing — half a visit recorded is worse than none. */
  readonly recordWorkInstallations: (
    organisationId: string,
    workId: string,
    body: RecordInstallationBatchRequest,
  ) => Promise<RecordInstallationBatchResponse>;
  readonly cancelWorkInstallation: (
    organisationId: string,
    installationId: string,
    note: string,
  ) => Promise<Installation>;
  /** Defect liability periods (migration 0099).
   *
   * The Work read carries the contract term, the Performance Bank
   * Guarantee cover reading, the installations still waiting for a
   * period, and the periods themselves — paged, like the Work's own
   * installation list. */
  readonly getWorkWarranty: (
    organisationId: string,
    workId: string,
    options?: { readonly cursor?: string; readonly limit?: number },
  ) => Promise<WorkWarrantyResponse>;
  readonly saveWarrantyTerms: (
    organisationId: string,
    workId: string,
    body: SaveWarrantyTermsRequest,
  ) => Promise<WarrantyTerms>;
  readonly startInstallationWarranty: (
    organisationId: string,
    installationId: string,
    body: StartWarrantyRequest,
  ) => Promise<Warranty>;
  readonly extendWarranty: (
    organisationId: string,
    warrantyId: string,
    body: ExtendWarrantyRequest,
  ) => Promise<Warranty>;
  readonly closeWarranty: (
    organisationId: string,
    warrantyId: string,
    body: CloseWarrantyRequest,
  ) => Promise<Warranty>;
  readonly voidWarranty: (
    organisationId: string,
    warrantyId: string,
    note: string,
  ) => Promise<Warranty>;
  /** The tenant-wide register: what comes out of warranty next, across
   * every Work the caller may see. Paged, and narrowable by the derived
   * standing or by an expiry horizon. */
  readonly listWarranties: (
    organisationId: string,
    options?: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly standing?: WarrantyStanding;
      readonly expiresBefore?: string;
    },
  ) => Promise<WarrantyRegisterResponse>;
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
  /** The whole payment configuration of a Work in one transaction — the
   * post-creation setup dialog's single Save. */
  readonly saveWorkPaymentSetup: (
    organisationId: string,
    workId: string,
    body: SavePaymentSetupRequest,
  ) => Promise<PaymentSetupResponse>;
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
  /** What the next acceptance certificate should certify, per AMC item,
   * on every schedule that states a billing cadence. A proposal only —
   * it writes nothing and the certificate route is unchanged. */
  readonly getAmcCycleProposal: (
    organisationId: string,
    workId: string,
  ) => Promise<AmcCycleProposalResponse>;
  /** Sets or clears one schedule's AMC billing cadence. Both fields move
   * together; two nulls remove it. */
  readonly setScheduleAmcCycle: (
    organisationId: string,
    workId: string,
    scheduleId: string,
    body: SetScheduleAmcCycleRequest,
  ) => Promise<void>;
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
  /** Replaces the draft's whole set of downward measured-quantity
   * adjustments; an item absent from the body measures what its claimed
   * sources deliver. */
  readonly setMeasurementBookMeasuredQuantities: (
    organisationId: string,
    measurementBookId: string,
    body: SetMbMeasuredQuantitiesRequest,
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
  /**
   * The railway's own On-Account Bill, recorded against the measurement it
   * settles. Nothing about the bill is sent: its number, date, amount and
   * measurement are read out of the PDF on the server, because a bill
   * somebody typed is a claim and one found in the document is a fact.
   */
  readonly uploadReceivedRailwayBill: (
    organisationId: string,
    measurementBookId: string,
    file: Blob,
    filename: string,
  ) => Promise<ReceivedRailwayBill>;
  readonly listReceivedRailwayBills: (
    organisationId: string,
    workId: string,
  ) => Promise<ReceivedRailwayBill[]>;
  readonly discardReceivedRailwayBill: (
    organisationId: string,
    receivedRailwayBillId: string,
    reason?: string,
  ) => Promise<ReceivedRailwayBill>;
  /** Outstanding with the railway, one position per prepared bill, with
   * the receipts that produced it. The three figures never collapse into
   * one: money the railway KEPT is settled, money that never arrived is
   * outstanding, and only the second is chased. */
  readonly listBillSettlement: (
    organisationId: string,
    workId: string,
  ) => Promise<BillSettlementPosition[]>;
  /** The same positions across every Work the caller may see, with the
   * register's four totals. Its own read rather than a loop over the
   * per-Work one: the totals are the organisation's and have to be summed
   * where the rows are, in SQL. */
  readonly listReceivables: (
    organisationId: string,
  ) => Promise<ReceivablesRegisterResponse>;
  /** A receipt and its deduction breakup, recorded as one act — a payment
   * advice arrives as one document and a half-entered one is a wrong
   * position rather than an incomplete one. */
  readonly recordBillPayment: (
    organisationId: string,
    billId: string,
    body: RecordBillPaymentRequest,
  ) => Promise<BillPayment>;
  /** Withdraws a receipt. The row and its reason stay; the amount becomes
   * outstanding again. */
  readonly voidBillPayment: (
    organisationId: string,
    billPaymentId: string,
    reason: string,
  ) => Promise<BillPayment>;
  /** One Work's retention and liquidated-damages position, its recorded
   * terms, its releases and its assessments — one read, because the
   * screen shows them as one story and four round-trips would let the
   * tiles disagree with the rows beneath them (0098). */
  readonly getWorkRetention: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkRetentionResponse>;
  /** Saves the contract's retention and liquidated-damages terms. A whole
   * record, not a patch: the coherence rules are about the record, and a
   * term omitted is a term the contract does not state. */
  readonly saveWorkRetentionTerms: (
    organisationId: string,
    workId: string,
    body: SaveWorkRetentionTermsRequest,
  ) => Promise<WorkRetentionTerms>;
  /** Clears them. The one delete in the module: a terms row can never be
   * edited down to nothing, so without it a Work whose letter was misread
   * would carry the wrong rates forever. Every assessment already made
   * keeps its own snapshot and is unaffected. */
  readonly clearWorkRetentionTerms: (
    organisationId: string,
    workId: string,
  ) => Promise<void>;
  /** Records retention the railway gave back. Refused beyond what it
   * actually withheld. */
  readonly recordRetentionRelease: (
    organisationId: string,
    workId: string,
    body: RecordRetentionReleaseRequest,
  ) => Promise<RetentionRelease>;
  /** Withdraws a release. The row and its reason stay; the money goes
   * back to being held. */
  readonly voidRetentionRelease: (
    organisationId: string,
    releaseId: string,
    reason: string,
  ) => Promise<RetentionRelease>;
  /** Assesses liquidated damages over a delay window. The rate, period
   * and cap come from the Work's recorded terms and are never sent — an
   * assessment computed at a rate the contract never stated would look
   * exactly like one that was. */
  readonly assessLd: (
    organisationId: string,
    workId: string,
    body: AssessLdRequest,
  ) => Promise<LdAssessment>;
  /** Levies, waives or cancels an assessment. */
  readonly decideLdAssessment: (
    organisationId: string,
    assessmentId: string,
    body: DecideLdAssessmentRequest,
  ) => Promise<LdAssessment>;
  /** Records that the railway settled this measurement. Refused unless a
   * recorded bill's signatures pass the gate. */
  readonly closeMeasurementBook: (
    organisationId: string,
    measurementBookId: string,
  ) => Promise<MeasurementBookDetailResponse>;
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
  /** The organisation-wide register (migration 0109): every order the
   * caller may see, of both series. `work` narrows it to one Work, which
   * is what the register's own deep link sends. */
  readonly listPurchaseOrders: (
    organisationId: string,
    query?: {
      readonly status?: 'open' | PurchaseOrderStatus;
      readonly basis?: 'work' | 'organisation';
      readonly work?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<PurchaseOrderRegisterResponse>;
  /** A draft raised outside any LOA. */
  readonly createPurchaseOrder: (
    organisationId: string,
    body: CreatePurchaseOrderRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
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
  /** The tender pipeline (migration 0083): pre-award, so none of these
   * take a workId either. The NIT upload PROPOSES; `confirmTenderNotice`
   * is the only call that writes an authoritative tender, and it sends
   * the values the reviewer accepted rather than the ones the machine
   * read. */
  readonly uploadTenderNotice: (
    organisationId: string,
    file: Blob,
    filename: string,
  ) => Promise<TenderNotice>;
  readonly downloadTenderNotice: (
    organisationId: string,
    noticeId: string,
  ) => Promise<Blob>;
  readonly confirmTenderNotice: (
    organisationId: string,
    noticeId: string,
    body: ConfirmTenderRequest,
  ) => Promise<TenderDetail>;
  // --- OEM production (migration 0084) --------------------------------------
  readonly listProductionItems: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<ProductionItemListResponse>;
  readonly saveProductionItem: (
    organisationId: string,
    id: string | null,
    body: SaveProductionItemRequest,
  ) => Promise<ProductionItem>;
  readonly setProductionItemActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<ProductionItem>;
  readonly getProductionBom: (
    organisationId: string,
    itemId: string,
  ) => Promise<BomResponse>;
  readonly addProductionBomLine: (
    organisationId: string,
    itemId: string,
    body: SaveBomLineRequest,
  ) => Promise<BomResponse>;
  readonly updateProductionBomLine: (
    organisationId: string,
    lineId: string,
    quantity: string,
  ) => Promise<BomResponse>;
  readonly removeProductionBomLine: (
    organisationId: string,
    lineId: string,
  ) => Promise<BomResponse>;
  readonly listJobCards: (
    organisationId: string,
    /** `URLSearchParams` escapes every value, so an id is never
     * interpolated raw into the path. */
    query?: {
      readonly workId?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<JobCardListResponse>;
  readonly getJobCard: (
    organisationId: string,
    jobCardId: string,
  ) => Promise<JobCardDetail>;
  readonly createJobCard: (
    organisationId: string,
    body: CreateJobCardRequest,
  ) => Promise<JobCardDetail>;
  readonly updateJobCard: (
    organisationId: string,
    jobCardId: string,
    body: UpdateJobCardRequest,
  ) => Promise<JobCardDetail>;
  readonly completeJobCard: (
    organisationId: string,
    jobCardId: string,
  ) => Promise<JobCardDetail>;
  readonly cancelJobCard: (
    organisationId: string,
    jobCardId: string,
    body: CancelJobCardRequest,
  ) => Promise<JobCardDetail>;
  readonly recordProductionSerial: (
    organisationId: string,
    jobCardId: string,
  ) => Promise<JobCardDetail>;
  readonly removeProductionSerial: (
    organisationId: string,
    serialId: string,
  ) => Promise<JobCardDetail>;
  readonly recordComponentSerial: (
    organisationId: string,
    serialId: string,
    body: RecordComponentSerialRequest,
  ) => Promise<JobCardDetail>;
  readonly removeComponentSerial: (
    organisationId: string,
    componentSerialId: string,
  ) => Promise<JobCardDetail>;
  readonly createProductionDispatch: (
    organisationId: string,
    jobCardId: string,
    body: CreateDispatchRequest,
  ) => Promise<JobCardDetail>;
  readonly withdrawProductionDispatch: (
    organisationId: string,
    dispatchId: string,
  ) => Promise<JobCardDetail>;

  readonly listTenders: (organisationId: string) => Promise<TenderListResponse>;
  readonly getTender: (
    organisationId: string,
    tenderId: string,
  ) => Promise<TenderDetail>;
  readonly updateTenderStatus: (
    organisationId: string,
    tenderId: string,
    body: UpdateTenderStatusRequest,
  ) => Promise<TenderDetail>;
  readonly addTenderChecklistItem: (
    organisationId: string,
    tenderId: string,
    body: AddTenderChecklistItemRequest,
  ) => Promise<TenderDetail>;
  readonly attachTenderChecklistDocument: (
    organisationId: string,
    tenderId: string,
    itemId: string,
    companyDocumentId: string | null,
  ) => Promise<TenderDetail>;
  readonly removeTenderChecklistItem: (
    organisationId: string,
    tenderId: string,
    itemId: string,
  ) => Promise<TenderDetail>;
  /** Records the Letter of Acceptance an awarded tender produced. Called
   * by the LOA upload screen when it was reached from a tender, which is
   * what makes the award conversion a deep link into the existing intake
   * rather than a second way to create a Work. */
  readonly linkTenderAwardLetter: (
    organisationId: string,
    tenderId: string,
    loaDocumentId: string,
  ) => Promise<TenderDetail>;
  /** The correspondence register (migration 0086). One list endpoint
   * behind four tabs, because three of them read modules this one only
   * projects — extension requests and inspection call letters keep their
   * own routes and are never written here. `document` answers the
   * rendered outward letter or the stored inward scan, whichever the row
   * is. */
  readonly listCorrespondence: (
    organisationId: string,
    options?: {
      readonly tab?: CorrespondenceTab;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<CorrespondenceListResponse>;
  readonly listCorrespondenceThreadOptions: (
    organisationId: string,
  ) => Promise<CorrespondenceThreadOptionsResponse>;
  readonly writeOutwardLetter: (
    organisationId: string,
    body: WriteOutwardLetterRequest,
  ) => Promise<{ readonly id: string; readonly number: string }>;
  readonly registerInwardLetter: (
    organisationId: string,
    file: Blob,
    details: {
      readonly filename: string;
      readonly receivedOn: string;
      readonly contactId: string;
      readonly subject: string;
      readonly workId?: string;
      readonly senderReference?: string;
      readonly senderLetterDate?: string;
      readonly replyToLetterId?: string;
      readonly responseDueOn?: string;
    },
  ) => Promise<{ readonly id: string; readonly number: string }>;
  readonly cancelCorrespondenceLetter: (
    organisationId: string,
    letterId: string,
    reason: string,
  ) => Promise<void>;
  readonly downloadCorrespondenceLetter: (
    organisationId: string,
    letterId: string,
  ) => Promise<Blob>;
  /** The company document library: organisation-level credentials that
   * belong to no Work, so none of these take a workId. `validFrom` and
   * `expiresOn` are date-only `YYYY-MM-DD` strings and ride the
   * querystring beside the filename, because the request body is the
   * PDF itself. */
  readonly listCompanyDocuments: (
    organisationId: string,
  ) => Promise<CompanyDocumentListResponse>;
  readonly createCompanyDocument: (
    organisationId: string,
    file: Blob,
    details: {
      readonly title: string;
      readonly category: CompanyDocumentCategory;
      readonly filename: string;
      readonly validFrom?: string;
      readonly expiresOn?: string;
    },
  ) => Promise<CompanyDocument>;
  readonly uploadCompanyDocumentVersion: (
    organisationId: string,
    documentId: string,
    file: Blob,
    details: {
      readonly filename: string;
      readonly validFrom?: string;
      readonly expiresOn?: string;
    },
  ) => Promise<CompanyDocument>;
  readonly archiveCompanyDocument: (
    organisationId: string,
    documentId: string,
  ) => Promise<CompanyDocument>;
  readonly downloadCompanyDocumentVersion: (
    organisationId: string,
    versionId: string,
  ) => Promise<Blob>;
  /** The inspection lifecycle (migration 0082). The clause config is
   * per Work; the calls register is cross-Work and work-scope filtered by
   * the server. Every document is a PDF body with its facts on the
   * querystring, the shape every upload here uses. */
  readonly getWorkInspectionConfig: (
    organisationId: string,
    workId: string,
  ) => Promise<WorkInspectionConfig>;
  readonly saveInspectionClauses: (
    organisationId: string,
    workId: string,
    body: SaveInspectionClausesRequest,
  ) => Promise<WorkInspectionConfig>;
  readonly saveInspectionChecklist: (
    organisationId: string,
    workId: string,
    body: SaveInspectionChecklistRequest,
  ) => Promise<WorkInspectionConfig>;
  readonly listInspectionCalls: (
    organisationId: string,
    page?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<InspectionCallListResponse>;
  readonly createInspectionCall: (
    organisationId: string,
    workId: string,
    body: CreateInspectionCallRequest,
  ) => Promise<InspectionCall>;
  readonly receiveInspectionCallLetter: (
    organisationId: string,
    callId: string,
    file: Blob,
    details: {
      readonly filename: string;
      readonly agencyCallNumber: string;
      readonly receivedOn: string;
    },
  ) => Promise<InspectionCall>;
  readonly uploadInspectionEvidence: (
    organisationId: string,
    documentId: string,
    file: Blob,
    details: { readonly filename: string },
  ) => Promise<InspectionCall>;
  readonly uploadInspectionCertificate: (
    organisationId: string,
    callId: string,
    file: Blob,
    details: {
      readonly filename: string;
      readonly certificateNumber: string;
      readonly certificateDate: string;
      readonly validUntil?: string;
    },
  ) => Promise<InspectionCall>;
  readonly closeInspectionCall: (
    organisationId: string,
    callId: string,
  ) => Promise<InspectionCall>;
  readonly cancelInspectionCall: (
    organisationId: string,
    callId: string,
    body: CancelInspectionCallRequest,
  ) => Promise<InspectionCall>;
  readonly downloadInspectionDocument: (
    organisationId: string,
    documentId: string,
  ) => Promise<Blob>;
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
  /** The invoice module's own register: every tax invoice in the
   * organisation the caller may see, work-backed and direct alike. Paged
   * — the screen sends a `limit` and pages with `nextCursor` — and
   * narrowable to an inclusive `invoiceDate` window. */
  readonly listTaxInvoices: (
    organisationId: string,
    options?: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly invoicedFrom?: string;
      readonly invoicedTo?: string;
    },
  ) => Promise<TaxInvoiceRegisterResponse>;
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
  /** The challan path (ADR-0013): a standalone Delivery Challan carrying
   * goods raises its own e-way bill, with no invoice and no IRN behind
   * it. The lifecycle beyond creation is the shared one below — the
   * routes key on the bill, not on the source. */
  readonly listChallanEwayBills: (
    organisationId: string,
    challanId: string,
  ) => Promise<readonly EwayBill[]>;
  readonly createChallanEwayBill: (
    organisationId: string,
    challanId: string,
    body: SaveEwayBillRequest,
  ) => Promise<EwayBillDetailResponse>;
  /** The printable summary: a convenience print of facts the module
   * already holds. The NIC portal document remains the statutory
   * original, and the render says so. */
  readonly renderEwayBill: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<EwayBillDetailResponse>;
  readonly downloadEwayBillPdf: (
    organisationId: string,
    ewayBillId: string,
  ) => Promise<Blob>;
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
  /** The stock ledger (migration 0087). Organisation-level, not per Work:
   * one shelf serves every contract. The register's balances and the
   * shortage list are derived server-side on every read — there is no
   * stored balance to go stale, and nothing here posts one. */
  readonly listStockItems: (
    organisationId: string,
    options?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: 'all' | 'active';
    },
  ) => Promise<StockRegisterResponse>;
  readonly setStockReorderLevel: (
    organisationId: string,
    itemId: string,
    body: SetReorderLevelRequest,
  ) => Promise<StockItemResponse>;

  /** Maintenance: the site material request (migration 0088). Every
   * mutation answers with the WHOLE request, so the screen never patches
   * a fragment of state the server might disagree with — the four line
   * quantities the mock stores are all derived, and a client that
   * recomputed one of them locally would be the drift 0088 refused. */
  readonly listMaintenanceRequests: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<MaintenanceListResponse>;
  readonly getMaintenanceRequest: (
    organisationId: string,
    requestId: string,
  ) => Promise<MaintenanceDetailResponse>;
  readonly createMaintenanceRequest: (
    organisationId: string,
    body: CreateMaintenanceRequest,
  ) => Promise<{ readonly id: string; readonly number: string }>;
  readonly approveMaintenanceRequest: (
    organisationId: string,
    requestId: string,
    body: ApproveMaintenanceRequest,
  ) => Promise<MaintenanceDetailResponse>;
  readonly recordMaintenanceDispatch: (
    organisationId: string,
    requestId: string,
    body: RecordMaintenanceDispatch,
  ) => Promise<MaintenanceDetailResponse>;
  readonly receiveMaintenanceReturn: (
    organisationId: string,
    requestId: string,
    body: ReceiveMaintenanceReturn,
  ) => Promise<MaintenanceDetailResponse>;
  readonly cancelMaintenanceLine: (
    organisationId: string,
    requestId: string,
    lineId: string,
    body: CancelMaintenanceLine,
  ) => Promise<MaintenanceDetailResponse>;
  readonly closeMaintenanceRequest: (
    organisationId: string,
    requestId: string,
  ) => Promise<MaintenanceDetailResponse>;
  readonly listStockMovements: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<StockMovementListResponse>;
  readonly postStockMovement: (
    organisationId: string,
    body: CreateStockMovementRequest,
  ) => Promise<StockMovementResponse>;
  readonly listPendingProductionReceipts: (
    organisationId: string,
  ) => Promise<PendingProductionReceiptListResponse>;
  readonly recordProductionReceipt: (
    organisationId: string,
    body: RecordProductionReceiptRequest,
  ) => Promise<StockMovementResponse>;
  readonly listStockShortages: (
    organisationId: string,
  ) => Promise<StockShortageResponse>;
  readonly createShortagePurchaseOrder: (
    organisationId: string,
    body: CreateShortagePurchaseOrderRequest,
  ) => Promise<PurchaseOrderDetailResponse>;
  /** The signing queue (migration 0091, ADR-0012 lane 2). One list for
   * the whole organisation: the kiosk is one machine, and the person
   * watching it watches one queue. */
  readonly listSigningRequests: (
    organisationId: string,
    options?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: SigningRequestStatus;
    },
  ) => Promise<SigningQueueResponse>;
  readonly createSigningRequest: (
    organisationId: string,
    body: CreateSigningRequest,
  ) => Promise<SigningRequestResponse>;
  readonly cancelSigningRequest: (
    organisationId: string,
    requestId: string,
    body: CancelSigningRequest,
  ) => Promise<SigningRequestResponse>;
  /** The signed PDF of a completed request. Same authority as the
   * unsigned document's own download: work scope and nothing more. */
  readonly downloadSignedPdf: (
    organisationId: string,
    requestId: string,
  ) => Promise<Blob>;
  readonly registerSigningAgent: (
    organisationId: string,
    body: RegisterSigningAgent,
  ) => Promise<RegisterSigningAgentResponse>;
  /** Bringing a register in from a spreadsheet (migration 0094). The
   * listing carries the registers that accept one alongside the batches,
   * because the screen needs them on an organisation's first day. */
  readonly listImportBatches: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<ImportBatchList>;
  readonly readImportBatch: (
    organisationId: string,
    batchId: string,
    options?: {
      readonly limit?: number;
      /** The `rowNumber` of the last row of the previous page. */
      readonly cursor?: number;
      readonly status?: ImportRowStatus;
    },
  ) => Promise<ImportBatchDetail>;
  /** Stages a workbook. Writes nothing to the register — that is
   * `commitImportBatch`, and the separation is the whole feature. */
  readonly uploadImportWorkbook: (
    organisationId: string,
    target: ImportTargetKey,
    file: File,
  ) => Promise<ImportBatchDetail>;
  readonly commitImportBatch: (
    organisationId: string,
    batchId: string,
  ) => Promise<ImportBatchDetail>;
  readonly cancelImportBatch: (
    organisationId: string,
    batchId: string,
    body: { readonly reason: string },
  ) => Promise<ImportBatchDetail>;
  readonly downloadImportTemplate: (
    organisationId: string,
    target: ImportTargetKey,
  ) => Promise<Blob>;
  readonly revokeSigningAgent: (
    organisationId: string,
    agentId: string,
  ) => Promise<SigningAgentResponse>;

  /** Notifications (migration 0092): the channels the organisation
   * speaks through, the templates it may say, who has consented to be
   * spoken to, and the log of what was actually sent.
   *
   * Every one of these needs the `notifications` authority, READS
   * INCLUDED — a consent register is a list of counterparties' personal
   * telephone numbers — so the screen that renders them is behind
   * `canManageNotifications`. Saving a channel additionally needs the
   * owner role, because it decides which number the organisation speaks
   * from. */
  readonly listNotificationChannels: (
    organisationId: string,
  ) => Promise<NotificationChannelListResponse>;
  readonly saveNotificationChannel: (
    organisationId: string,
    channel: NotificationChannelName,
    body: SaveNotificationChannel,
  ) => Promise<NotificationChannelResponse>;
  readonly listNotificationTemplates: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<NotificationTemplateListResponse>;
  readonly createNotificationTemplate: (
    organisationId: string,
    body: CreateNotificationTemplate,
  ) => Promise<NotificationTemplateResponse>;
  readonly setNotificationTemplateStatus: (
    organisationId: string,
    templateId: string,
    body: SetNotificationTemplateStatus,
  ) => Promise<NotificationTemplateResponse>;
  readonly listNotificationConsents: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<NotificationConsentListResponse>;
  readonly recordNotificationConsent: (
    organisationId: string,
    body: RecordNotificationConsent,
  ) => Promise<NotificationConsentResponse>;
  /** The employee half of the consent split (owner ruling of
   * 2026-08-19): one act over the whole staff register, answering with
   * what it did rather than with a row. */
  readonly recordStaffNotificationConsents: (
    organisationId: string,
    body: RecordStaffNotificationConsent,
  ) => Promise<StaffNotificationConsentResponse>;
  readonly listNotifications: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<NotificationMessageListResponse>;
  readonly sendNotification: (
    organisationId: string,
    body: SendNotification,
  ) => Promise<NotificationMessageResponse>;
  /** The platform controls (migration 0096). Owner-only in effect: the
   * two entitlement/schedule surfaces need `role: owner` AND the
   * entitlements authority, and the screen simply does not render for
   * anyone else. The export needs `canExportOrg` and full Work scope. */
  readonly listEntitlements: (
    organisationId: string,
  ) => Promise<EntitlementListResponse>;
  readonly setEntitlement: (
    organisationId: string,
    key: EntitlementFlagKey,
    body: SetEntitlementRequest,
  ) => Promise<EntitlementResponse>;
  readonly listJobSchedules: (
    organisationId: string,
  ) => Promise<JobScheduleListResponse>;
  readonly setJobSchedule: (
    organisationId: string,
    kind: ScheduledJobKind,
    body: UpdateJobScheduleRequest,
  ) => Promise<JobScheduleResponse>;
  readonly listOrganisationExports: (
    organisationId: string,
  ) => Promise<OrganisationExportListResponse>;
  readonly requestOrganisationExport: (
    organisationId: string,
  ) => Promise<OrganisationExportResponse>;
  /** Fetched rather than linked, like every other stored file here: the
   * tenant header travels on every scoped request and an `<a href>`
   * cannot carry one. */
  readonly downloadOrganisationExport: (
    organisationId: string,
    exportId: string,
  ) => Promise<Blob>;

  /** The employee master and the monthly payroll run (migrations 0089
   * and 0090). Organisation-level, not per Work: a salary is paid by the
   * agency and not by a contract.
   *
   * Every one of these needs the `payments` authority, READS INCLUDED —
   * a register of salaries is not something a member without it should
   * be able to fetch — so a screen that renders them is behind
   * `canManagePayments`.
   *
   * Nothing here is computed in the browser. A payslip's figures, the
   * run's totals and the year's projected tax all arrive as decimal
   * strings PostgreSQL produced. */
  readonly listEmployees: (
    organisationId: string,
    options?: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: 'all' | 'current';
      readonly search?: string;
    },
  ) => Promise<EmployeeListResponse>;
  readonly getEmployee: (
    organisationId: string,
    employeeId: string,
  ) => Promise<EmployeeResponse>;
  readonly createEmployee: (
    organisationId: string,
    body: CreateEmployee,
  ) => Promise<EmployeeResponse>;
  readonly updateEmployee: (
    organisationId: string,
    employeeId: string,
    body: UpdateEmployee,
  ) => Promise<EmployeeResponse>;
  readonly listPayrollRuns: (
    organisationId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<PayrollRunListResponse>;
  readonly getPayrollRun: (
    organisationId: string,
    runId: string,
  ) => Promise<PayrollRunResponse>;
  readonly openPayrollRun: (
    organisationId: string,
    body: OpenPayrollRun,
  ) => Promise<PayrollRunResponse>;
  readonly calculatePayrollRun: (
    organisationId: string,
    runId: string,
  ) => Promise<PayrollRunResponse>;
  readonly setPayrollLineLossOfPay: (
    organisationId: string,
    runId: string,
    lineId: string,
    body: SetPayrollLineLop,
  ) => Promise<PayrollRunResponse>;
  readonly finalizePayrollRun: (
    organisationId: string,
    runId: string,
  ) => Promise<PayrollRunResponse>;
  readonly cancelPayrollRun: (
    organisationId: string,
    runId: string,
    body: CancelPayrollRun,
  ) => Promise<PayrollRunResponse>;
}

/** FormData.get can return a File; forms here only carry text inputs, so
 * anything else collapses to the empty string instead of
 * "[object File]". */
export function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/* ------------------------------------------------------------------ *
 * Schema-refusal translation. Fastify answers an invalid request with
 * ajv's own prose — "body/slug must match pattern …" — which is
 * addressed to a developer, not to the clerk reading the form. The
 * translation happens here, at the one place every response passes
 * through, so no view can leak `body/…` again.
 * ------------------------------------------------------------------ */

/** Known fields whose generated names or formats deserve better words
 * than a de-camelled identifier next to a regex. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  slug: 'organisation slug',
  sourceRef: 'source reference',
  itemSno: 'source item number',
  scheduleId: 'source schedule id',
  gstin: 'GSTIN',
  sacCode: 'SAC code',
  hsnCode: 'HSN code',
  pincode: 'PIN code',
  stateCode: 'state code',
  placeOfSupply: 'place of supply',
  numberPrefix: 'number prefix',
  workCode: 'Work code',
  gstRate: 'GST rate',
};

/** What the format actually is, for fields whose pattern refusal would
 * otherwise just say "invalid". */
const FORMAT_HINTS: Readonly<Record<string, string>> = {
  slug: '2–63 lowercase letters, digits and hyphens, starting with a letter or digit',
  gstin: 'exactly 15 digits and capital letters',
  pincode: 'a 6-digit PIN code',
  stateCode: 'a 2-digit GST state code',
  sacCode: 'a 6-digit SAC code',
  hsnCode: 'a 4, 6 or 8-digit HSN code',
  placeOfSupply: 'a 2-digit GST state code',
  numberPrefix: 'a capital letter followed by up to 7 capital letters or digits',
  workCode: 'capital letters, digits, "/", "-" or "_", up to 20 characters',
};

/** 'body/schedules/0/items/2/sourceRef/itemSno' → a person's reading of
 * the same place: "schedules 1 › items 3 › source item number". */
function fieldLabelOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const withoutSource =
    segments[0] === 'body' ||
    segments[0] === 'querystring' ||
    segments[0] === 'params' ||
    segments[0] === 'headers'
      ? segments.slice(1)
      : segments;
  if (withoutSource.length === 0) return 'request';
  const parts: string[] = [];
  for (const segment of withoutSource) {
    if (/^\d+$/.test(segment)) {
      const previous = parts.pop();
      const ordinal = String(Number(segment) + 1);
      parts.push(
        previous === undefined ? `entry ${ordinal}` : `${previous} ${ordinal}`,
      );
      continue;
    }
    parts.push(
      FIELD_LABELS[segment] ??
        segment
          .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replaceAll('_', ' ')
          .toLowerCase(),
    );
  }
  return parts.join(' › ');
}

/** The last path segment that is a name (not an index) — the field the
 * format hints are keyed by. */
function leafFieldOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined && !/^\d+$/.test(segment)) return segment;
  }
  return '';
}

/** One ajv clause → one human sentence fragment. */
function humanizeConstraint(field: string, constraint: string): string {
  const required = /^must have required property '(.+)'$/.exec(constraint);
  if (required !== null && required[1] !== undefined) {
    const missing = FIELD_LABELS[required[1]] ?? fieldLabelOf(required[1]);
    return `is missing ${missing} — fill it in`;
  }
  if (constraint.startsWith('must match pattern')) {
    const hint = FORMAT_HINTS[field];
    return hint === undefined ? 'has an invalid format' : `must be ${hint}`;
  }
  const tooShort = /^must NOT have fewer than (\d+) characters$/.exec(constraint);
  if (tooShort !== null) return `must be at least ${tooShort[1] ?? ''} characters`;
  const tooLong = /^must NOT have more than (\d+) characters$/.exec(constraint);
  if (tooLong !== null) return `must be at most ${tooLong[1] ?? ''} characters`;
  const atLeast = /^must be >= (.+)$/.exec(constraint);
  if (atLeast !== null) return `must be at least ${atLeast[1] ?? ''}`;
  const atMost = /^must be <= (.+)$/.exec(constraint);
  if (atMost !== null) return `must be at most ${atMost[1] ?? ''}`;
  if (constraint === 'must NOT have additional properties') {
    return 'contains a field the server does not accept';
  }
  if (constraint.startsWith('must be equal to one of the allowed values')) {
    return 'is not one of the allowed choices';
  }
  if (constraint.startsWith('must be ')) {
    return `must be ${constraint.slice('must be '.length).split(',')[0] ?? 'valid'}`;
  }
  return 'is invalid';
}

/** Splits fastify's joined message on error boundaries only — patterns
 * themselves may contain ", ", so the lookahead anchors each split to
 * the next `body/…`-style prefix. */
function humanizeValidationMessage(raw: string): string {
  const clauses = raw.split(/, (?=(?:body|querystring|params|headers)(?:\/| ))/);
  const sentences = clauses.map((clause) => {
    // "<source>[/path…] <constraint>" — split at the first space, no
    // backtracking-prone pattern needed.
    const spaceAt = clause.indexOf(' ');
    if (spaceAt <= 0) return null;
    const path = clause.slice(0, spaceAt);
    const constraintText = clause.slice(spaceAt + 1);
    const source = path.split('/', 1)[0];
    if (
      source !== 'body' &&
      source !== 'querystring' &&
      source !== 'params' &&
      source !== 'headers'
    ) {
      return null;
    }
    if (constraintText.length === 0) return null;
    const label = fieldLabelOf(path);
    const constraint = humanizeConstraint(leafFieldOf(path), constraintText);
    const subject = label === 'request' ? 'The form' : `The ${label}`;
    return `${subject} ${constraint}.`;
  });
  const readable = sentences.filter(
    (sentence): sentence is string => sentence !== null,
  );
  if (readable.length === 0) {
    return 'The form has a value the server could not accept. Check the highlighted fields and try again.';
  }
  return readable.join(' ');
}

async function parseError(response: Response): Promise<RequestFailedError> {
  let code = 'REQUEST_ERROR';
  let message = `The server answered ${String(response.status)}.`;
  let details: unknown;
  let requestId: string | undefined;
  let remedy: string | undefined;
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.requestId === 'string') requestId = body.requestId;
    if (typeof body.remedy === 'string') remedy = body.remedy;
    details = body.details;
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  // A schema refusal reaches the operator in words, never as ajv's
  // `body/...` developer prose.
  if (
    code === 'FST_ERR_VALIDATION' ||
    /^(?:body|querystring|params|headers)[/ ]/.test(message)
  ) {
    message = humanizeValidationMessage(message);
  }
  return new RequestFailedError(
    response.status,
    code,
    message,
    details,
    requestId,
    remedy,
  );
}

/**
 * All requests are same-origin with the session cookie; tenant-scoped calls
 * carry the selected organisation in the x-organisation-id header, which
 * the server re-validates against the database membership floor.
 */
/** Upload metadata as a querystring. Optional values are omitted rather
 * than sent empty: the schemas take a real value or nothing, and
 * `?expiresOn=` is neither. Shared by the company document library and the
 * inspection uploads, which encode their metadata the same way. */
function uploadQuery(details: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  return query.toString();
}

/** The keyset pagination pair as a querystring suffix, or the empty
 * string. Omitting both is what asks for the whole register, which is the
 * compatibility rule `packages/contracts/src/pagination.ts` encodes. */
function pageQuery(options?: {
  readonly limit?: number;
  readonly cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  if (options?.cursor !== undefined) query.set('cursor', options.cursor);
  return query.size === 0 ? '' : `?${query.toString()}`;
}

export function createApiClient(send: FetchLike = fetch): ApiClient {
  /**
   * Every request this client makes, with one rule in front of it: a
   * write is refused while the browser is offline, before any of it
   * leaves the machine.
   *
   * It is the one choke point, so the whole policy is nine lines and no
   * screen has to remember it. The refusal is a `RequestFailedError`
   * exactly like a server refusal, which means every action handler in
   * the product — `useAction`, and the hand-written ones beside it —
   * renders it through the persistent inline error it already had, with
   * the fact and the remedy in the order an operator reads them.
   *
   * Nothing is queued for replay. `lib/offline.ts` records why: this
   * product's outward documents take gap-free numbers from per-Work
   * counters under lifecycle locks, and a challan replayed an hour later
   * would be claiming a number in an order nobody chose.
   *
   * GETs are NOT refused. A read that fails changes nothing, and letting
   * it fail is what lets the offline read cache answer in its place.
   */
  const fetchImpl: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && isOffline()) {
      throw new RequestFailedError(
        0,
        'OFFLINE',
        'This device is offline, so nothing was sent and nothing was changed.',
        undefined,
        undefined,
        'Reconnect and try again; the record is exactly as it was.',
      );
    }
    return send(input, init);
  };

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

  /**
   * The one PDF upload in this client: a raw PDF body with every fact
   * already in the path's querystring, under the tenant header.
   *
   * Every upload route in the product takes exactly this shape, and the
   * client had grown a copy of it per module — same headers, same
   * `parseError`, same cast, three times over — each of which is a place
   * the `credentials` or the content type can be forgotten. The response
   * type is the caller's, because that is the only thing that actually
   * differs between them.
   *
   * ponytail: the remaining callers still go through the two named
   * wrappers below rather than being rewritten here; that is a mechanical
   * follow-up over `routes/company-documents` and `routes/inspections`
   * with no behaviour in it, and it is not this pack's diff to make.
   */
  async function uploadPdf<T>(
    path: string,
    organisationId: string,
    file: Blob,
  ): Promise<T> {
    const response = await fetchImpl(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/pdf',
        'x-organisation-id': organisationId,
      },
      body: file,
    });
    if (!response.ok) throw await parseError(response);
    return (await response.json()) as T;
  }

  /** The one stored-document download: a GET under the tenant header
   * answering bytes rather than JSON. */
  async function downloadBlob(path: string, organisationId: string): Promise<Blob> {
    const response = await fetchImpl(path, {
      credentials: 'same-origin',
      headers: { 'x-organisation-id': organisationId },
    });
    if (!response.ok) throw await parseError(response);
    return response.blob();
  }

  /** The audit register's filters, as a query string. ONE builder, two
   * callers: the paged read and the workbook. A workbook produced under
   * different filters from the screen that offered it would be a file the
   * operator has to re-check by hand. */
  function auditQuery(options: AuditRegisterQuery): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return query.size > 0 ? `?${query.toString()}` : '';
  }

  /** Both company-document uploads post the same thing and answer the same
   * refreshed credential. */
  function uploadCompanyDocumentPdf(
    path: string,
    organisationId: string,
    file: Blob,
  ): Promise<CompanyDocument> {
    return uploadPdf<CompanyDocument>(path, organisationId, file);
  }

  /** The same send for every inspection upload — the inward call letter,
   * a checklist paper, the certificate — because they differ only in the
   * facts already encoded in the path, and every one of them answers the
   * refreshed call. */
  function uploadInspectionPdf(
    path: string,
    organisationId: string,
    file: Blob,
  ): Promise<InspectionCall> {
    return uploadPdf<InspectionCall>(path, organisationId, file);
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
    async requestPasswordReset(email, redirectTo) {
      await request('/api/auth/request-password-reset', {
        method: 'POST',
        body: { email, redirectTo },
      });
    },
    async resetPassword(token, newPassword) {
      await request('/api/auth/reset-password', {
        method: 'POST',
        body: { token, newPassword },
      });
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
    async listDeliveryChallans(organisationId, workId = null) {
      const payload = await request<{ challans: DeliveryChallanRegisterEntry[] }>(
        workId === null
          ? '/api/delivery-challans'
          : `/api/delivery-challans?work=${encodeURIComponent(workId)}`,
        { organisationId },
      );
      return payload.challans;
    },
    async listIssueChallanRegister(organisationId) {
      const payload = await request<{ issueChallans: IssueChallanRegisterEntry[] }>(
        '/api/issue-challans',
        { organisationId },
      );
      return payload.issueChallans;
    },
    async createStandaloneChallan(organisationId, body) {
      return request<ChallanDetailResponse>('/api/delivery-challans', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async updateStandaloneChallan(organisationId, challanId, body) {
      return request<ChallanDetailResponse>(`/api/delivery-challans/${challanId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
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
    async search(organisationId, query) {
      return request<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`, {
        organisationId,
      });
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
    async listBills(organisationId, workId) {
      return request<BillListResponse>(`/api/works/${workId}/bills`, {
        organisationId,
      });
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
    async auditRegister(organisationId, options = {}) {
      return request<AuditRegisterResponse>(`/api/audit-events${auditQuery(options)}`, {
        organisationId,
      });
    },
    async auditFacets(organisationId) {
      return request<AuditFacetsResponse>('/api/audit-events/facets', {
        organisationId,
      });
    },
    async misSummary(organisationId, options = {}) {
      const query = new URLSearchParams();
      if (options.months !== undefined) query.set('months', String(options.months));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request<MisSummaryResponse>(`/api/mis/summary${suffix}`, {
        organisationId,
      });
    },
    async downloadRegisterWorkbook(organisationId, register) {
      return downloadBlob(`/api/registers/${register}/workbook.xlsx`, organisationId);
    },
    async downloadAuditWorkbook(organisationId, options = {}) {
      return downloadBlob(
        `/api/audit-events.xlsx${auditQuery(options)}`,
        organisationId,
      );
    },
    async downloadTallyExport(organisationId, window) {
      const query = new URLSearchParams({ from: window.from, to: window.to });
      return downloadBlob(`/api/exports/tally.xml?${query.toString()}`, organisationId);
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
    async listCanonicalItems(organisationId, includeRetired = false) {
      return request<CanonicalItemListResponse>(
        `/api/masters/canonical-items${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
    },
    async saveCanonicalItem(organisationId, id, body) {
      return request<CanonicalItem>(
        id === null
          ? '/api/masters/canonical-items'
          : `/api/masters/canonical-items/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setCanonicalItemActive(organisationId, id, active) {
      return request<CanonicalItem>(
        `/api/masters/canonical-items/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
    },
    async listOrganisationBankAccounts(organisationId, includeRetired = false) {
      const payload = await request<{ accounts: OrganisationBankAccount[] }>(
        `/api/organisation/bank-accounts${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
      return payload.accounts;
    },
    async createOrganisationBankAccount(organisationId, body) {
      return request<OrganisationBankAccount>('/api/organisation/bank-accounts', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async setOrganisationBankAccountActive(organisationId, id, active) {
      return request<OrganisationBankAccount>(
        `/api/organisation/bank-accounts/${id}/${active ? 'reactivate' : 'retire'}`,
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
    async listPaymentRequests(organisationId) {
      return request<PaymentRequestListResponse>('/api/payment-requests', {
        organisationId,
      });
    },
    async createPaymentRequest(organisationId, body) {
      return request<PaymentRequest>('/api/payment-requests', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async decidePaymentRequest(organisationId, requestId, body) {
      return request<PaymentRequest>(`/api/payment-requests/${requestId}/decision`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async payPaymentRequest(organisationId, requestId, body) {
      return request<PaymentRequest>(`/api/payment-requests/${requestId}/payment`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async recordAdvanceBills(organisationId, requestId, body) {
      return request<PaymentRequest>(`/api/payment-requests/${requestId}/bills`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listVendorInvoices(organisationId) {
      return request<VendorLedgerResponse>('/api/vendor-invoices', {
        organisationId,
      });
    },
    async recordVendorInvoice(organisationId, body) {
      return request<VendorInvoice>('/api/vendor-invoices', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async uploadVendorInvoiceDocument(organisationId, invoiceId, file, filename) {
      const response = await fetchImpl(
        `/api/vendor-invoices/${invoiceId}/document?filename=${encodeURIComponent(filename)}`,
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
      return (await response.json()) as VendorInvoice;
    },
    async downloadVendorInvoiceDocument(organisationId, invoiceId) {
      const response = await fetchImpl(`/api/vendor-invoices/${invoiceId}/document`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async previewVendorTds(organisationId, invoiceId, body) {
      // POST for a read: the amount is a rupee figure about a named
      // vendor, and a query string is the one place logs and history
      // both keep it.
      return request<TdsPreviewResponse>(
        `/api/vendor-invoices/${invoiceId}/tds-preview`,
        { method: 'POST', body, organisationId },
      );
    },
    async recordVendorPayment(organisationId, invoiceId, body) {
      return request<VendorPayment>(`/api/vendor-invoices/${invoiceId}/payments`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async voidVendorPayment(organisationId, paymentId, body) {
      return request<VendorPayment>(`/api/vendor-payments/${paymentId}/void`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async cancelVendorInvoice(organisationId, invoiceId, body) {
      return request<VendorInvoice>(`/api/vendor-invoices/${invoiceId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
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
    async getSupersedeEligibility(organisationId, workId) {
      return request<SupersedeEligibilityResponse>(
        `/api/works/${workId}/supersede-eligibility`,
        { organisationId },
      );
    },
    async getWorkSupersession(organisationId, workId) {
      const payload = await request<WorkSupersessionResponse>(
        `/api/works/${workId}/supersession`,
        { organisationId },
      );
      return payload.supersession;
    },
    async proposeWorkSupersede(organisationId, workId, body) {
      return request<ApprovalRequest>(`/api/works/${workId}/supersede-requests`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async attachVariationOrder(organisationId, approvalId, file, filename) {
      const query = new URLSearchParams({ filename });
      const response = await fetchImpl(
        `/api/approvals/${approvalId}/variation-order?${query.toString()}`,
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
      return (await response.json()) as AttachVariationOrderResponse;
    },
    async downloadVariationOrderFile(organisationId, approvalId) {
      const response = await fetchImpl(
        `/api/approvals/${approvalId}/variation-order/file`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
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
    async listInstallations(organisationId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) parameters.set('limit', String(options.limit));
      if (options.installedFrom !== undefined) {
        parameters.set('installedFrom', options.installedFrom);
      }
      if (options.installedTo !== undefined) {
        parameters.set('installedTo', options.installedTo);
      }
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<InstallationRegisterResponse>(`/api/installations${suffix}`, {
        organisationId,
      });
    },
    async getWorkWarranty(organisationId, workId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) parameters.set('limit', String(options.limit));
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<WorkWarrantyResponse>(`/api/works/${workId}/warranty${suffix}`, {
        organisationId,
      });
    },
    async saveWarrantyTerms(organisationId, workId, body) {
      return request<WarrantyTerms>(`/api/works/${workId}/warranty-terms`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async startInstallationWarranty(organisationId, installationId, body) {
      return request<Warranty>(`/api/installations/${installationId}/warranty`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async extendWarranty(organisationId, warrantyId, body) {
      return request<Warranty>(`/api/warranties/${warrantyId}/extend`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async closeWarranty(organisationId, warrantyId, body) {
      return request<Warranty>(`/api/warranties/${warrantyId}/close`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async voidWarranty(organisationId, warrantyId, note) {
      return request<Warranty>(`/api/warranties/${warrantyId}/void`, {
        method: 'POST',
        body: { note },
        organisationId,
      });
    },
    async listWarranties(organisationId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) parameters.set('limit', String(options.limit));
      if (options.standing !== undefined) parameters.set('standing', options.standing);
      if (options.expiresBefore !== undefined) {
        parameters.set('expiresBefore', options.expiresBefore);
      }
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<WarrantyRegisterResponse>(`/api/warranties${suffix}`, {
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
    async recordWorkInstallations(organisationId, workId, body) {
      return request<RecordInstallationBatchResponse>(
        `/api/works/${workId}/installations/batch`,
        { method: 'POST', body, organisationId },
      );
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
    async saveWorkPaymentSetup(organisationId, workId, body) {
      return request<PaymentSetupResponse>(`/api/works/${workId}/payment-setup`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listWorkPacCertificates(organisationId, workId) {
      return request<PacCertificateListResponse>(
        `/api/works/${workId}/pac-certificates`,
        { organisationId },
      );
    },
    async getAmcCycleProposal(organisationId, workId) {
      return request<AmcCycleProposalResponse>(
        `/api/works/${workId}/amc-cycle-proposal`,
        { organisationId },
      );
    },
    async setScheduleAmcCycle(organisationId, workId, scheduleId, body) {
      await request<void>(`/api/works/${workId}/schedules/${scheduleId}/amc-cycle`, {
        method: 'PUT',
        body,
        organisationId,
      });
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
    async setMeasurementBookMeasuredQuantities(
      organisationId,
      measurementBookId,
      body,
    ) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/measured-quantities`,
        { method: 'PUT', body, organisationId },
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
    async uploadReceivedRailwayBill(organisationId, measurementBookId, file, filename) {
      const query = new URLSearchParams({ filename });
      const response = await fetchImpl(
        `/api/measurement-books/${measurementBookId}/received-railway-bill?${query.toString()}`,
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
      return (await response.json()) as ReceivedRailwayBill;
    },
    async listReceivedRailwayBills(organisationId, workId) {
      const { bills } = await request<ReceivedRailwayBillListResponse>(
        `/api/works/${workId}/received-railway-bills`,
        { organisationId },
      );
      return bills;
    },
    async discardReceivedRailwayBill(organisationId, receivedRailwayBillId, reason) {
      return request<ReceivedRailwayBill>(
        `/api/received-railway-bills/${receivedRailwayBillId}/discard`,
        {
          method: 'POST',
          body: reason === undefined ? {} : { reason },
          organisationId,
        },
      );
    },
    async listBillSettlement(organisationId, workId) {
      const { positions } = await request<BillSettlementResponse>(
        `/api/works/${workId}/bill-settlement`,
        { organisationId },
      );
      return positions;
    },
    async listReceivables(organisationId) {
      return request<ReceivablesRegisterResponse>('/api/bill-settlement', {
        organisationId,
      });
    },
    async recordBillPayment(organisationId, billId, body) {
      return request<BillPayment>(`/api/bills/${billId}/payments`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async voidBillPayment(organisationId, billPaymentId, reason) {
      return request<BillPayment>(`/api/bill-payments/${billPaymentId}/void`, {
        method: 'POST',
        body: { reason },
        organisationId,
      });
    },
    async getWorkRetention(organisationId, workId) {
      return request<WorkRetentionResponse>(`/api/works/${workId}/retention`, {
        organisationId,
      });
    },
    async saveWorkRetentionTerms(organisationId, workId, body) {
      return request<WorkRetentionTerms>(`/api/works/${workId}/retention-terms`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async clearWorkRetentionTerms(organisationId, workId) {
      await request<void>(`/api/works/${workId}/retention-terms`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async recordRetentionRelease(organisationId, workId, body) {
      return request<RetentionRelease>(`/api/works/${workId}/retention-releases`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async voidRetentionRelease(organisationId, releaseId, reason) {
      return request<RetentionRelease>(`/api/retention-releases/${releaseId}/void`, {
        method: 'POST',
        body: { reason },
        organisationId,
      });
    },
    async assessLd(organisationId, workId, body) {
      return request<LdAssessment>(`/api/works/${workId}/ld-assessments`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async decideLdAssessment(organisationId, assessmentId, body) {
      return request<LdAssessment>(`/api/ld-assessments/${assessmentId}/decision`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async closeMeasurementBook(organisationId, measurementBookId) {
      return request<MeasurementBookDetailResponse>(
        `/api/measurement-books/${measurementBookId}/close`,
        { method: 'POST', organisationId },
      );
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
    async listPurchaseOrders(organisationId, query = {}) {
      const params = new URLSearchParams();
      if (query.status !== undefined) params.set('status', query.status);
      if (query.basis !== undefined) params.set('basis', query.basis);
      if (query.work !== undefined) params.set('work', query.work);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return request<PurchaseOrderRegisterResponse>(`/api/purchase-orders${suffix}`, {
        organisationId,
      });
    },
    async createPurchaseOrder(organisationId, body) {
      return request<PurchaseOrderDetailResponse>('/api/purchase-orders', {
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
    async uploadTenderNotice(organisationId, file, filename) {
      const response = await fetchImpl(
        `/api/tender-notices?filename=${encodeURIComponent(filename)}`,
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
      return (await response.json()) as TenderNotice;
    },
    async downloadTenderNotice(organisationId, noticeId) {
      const response = await fetchImpl(`/api/tender-notices/${noticeId}/file`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async confirmTenderNotice(organisationId, noticeId, body) {
      return request<TenderDetail>(`/api/tender-notices/${noticeId}/confirm`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async listCorrespondence(organisationId, options) {
      const query = uploadQuery({
        tab: options?.tab,
        limit: options?.limit === undefined ? undefined : String(options.limit),
        cursor: options?.cursor,
      });
      return request<CorrespondenceListResponse>(
        query === '' ? '/api/correspondence' : `/api/correspondence?${query}`,
        { organisationId },
      );
    },
    async listCorrespondenceThreadOptions(organisationId) {
      return request<CorrespondenceThreadOptionsResponse>(
        '/api/correspondence/thread-options',
        { organisationId },
      );
    },
    async writeOutwardLetter(organisationId, body) {
      return request<{ id: string; number: string }>('/api/correspondence/outward', {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async listProductionItems(organisationId, includeRetired = false) {
      return request<ProductionItemListResponse>(
        `/api/production/items?includeRetired=${String(includeRetired)}`,
        { organisationId },
      );
    },
    async saveProductionItem(organisationId, id, body) {
      return request<ProductionItem>(
        id === null ? '/api/production/items' : `/api/production/items/${id}`,
        { method: id === null ? 'POST' : 'PUT', organisationId, body },
      );
    },
    async setProductionItemActive(organisationId, id, active) {
      return request<ProductionItem>(`/api/production/items/${id}/active`, {
        method: 'PATCH',
        organisationId,
        body: { active },
      });
    },
    async getProductionBom(organisationId, itemId) {
      return request<BomResponse>(`/api/production/items/${itemId}/bom`, {
        organisationId,
      });
    },
    async addProductionBomLine(organisationId, itemId, body) {
      return request<BomResponse>(`/api/production/items/${itemId}/bom`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async registerInwardLetter(organisationId, file, details) {
      return uploadPdf<{ id: string; number: string }>(
        `/api/correspondence/inward?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async cancelCorrespondenceLetter(organisationId, letterId, reason) {
      await request(`/api/correspondence/${letterId}/cancel`, {
        method: 'POST',
        organisationId,
        body: { reason },
      });
    },
    async downloadCorrespondenceLetter(organisationId, letterId) {
      return downloadBlob(`/api/correspondence/${letterId}/document`, organisationId);
    },
    async updateProductionBomLine(organisationId, lineId, quantity) {
      return request<BomResponse>(`/api/production/bom-lines/${lineId}`, {
        method: 'PUT',
        organisationId,
        body: { quantity },
      });
    },
    async removeProductionBomLine(organisationId, lineId) {
      return request<BomResponse>(`/api/production/bom-lines/${lineId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listJobCards(organisationId, query = {}) {
      const search = new URLSearchParams();
      if (query.workId !== undefined) search.set('workId', query.workId);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      if (query.cursor !== undefined) search.set('cursor', query.cursor);
      const suffix = search.size === 0 ? '' : `?${search.toString()}`;
      return request<JobCardListResponse>(`/api/production/job-cards${suffix}`, {
        organisationId,
      });
    },
    async getJobCard(organisationId, jobCardId) {
      return request<JobCardDetail>(`/api/production/job-cards/${jobCardId}`, {
        organisationId,
      });
    },
    async createJobCard(organisationId, body) {
      return request<JobCardDetail>('/api/production/job-cards', {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async updateJobCard(organisationId, jobCardId, body) {
      return request<JobCardDetail>(`/api/production/job-cards/${jobCardId}`, {
        method: 'PUT',
        organisationId,
        body,
      });
    },
    async completeJobCard(organisationId, jobCardId) {
      return request<JobCardDetail>(`/api/production/job-cards/${jobCardId}/complete`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelJobCard(organisationId, jobCardId, body) {
      return request<JobCardDetail>(`/api/production/job-cards/${jobCardId}/cancel`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async recordProductionSerial(organisationId, jobCardId) {
      return request<JobCardDetail>(`/api/production/job-cards/${jobCardId}/serials`, {
        method: 'POST',
        organisationId,
      });
    },
    async removeProductionSerial(organisationId, serialId) {
      return request<JobCardDetail>(`/api/production/serials/${serialId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async recordComponentSerial(organisationId, serialId, body) {
      return request<JobCardDetail>(`/api/production/serials/${serialId}/components`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async removeComponentSerial(organisationId, componentSerialId) {
      return request<JobCardDetail>(
        `/api/production/component-serials/${componentSerialId}`,
        { method: 'DELETE', organisationId },
      );
    },
    async createProductionDispatch(organisationId, jobCardId, body) {
      return request<JobCardDetail>(
        `/api/production/job-cards/${jobCardId}/dispatches`,
        { method: 'POST', organisationId, body },
      );
    },
    async withdrawProductionDispatch(organisationId, dispatchId) {
      return request<JobCardDetail>(`/api/production/dispatches/${dispatchId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async listTenders(organisationId) {
      return request<TenderListResponse>('/api/tenders', { organisationId });
    },
    async getTender(organisationId, tenderId) {
      return request<TenderDetail>(`/api/tenders/${tenderId}`, { organisationId });
    },
    async updateTenderStatus(organisationId, tenderId, body) {
      return request<TenderDetail>(`/api/tenders/${tenderId}/status`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async addTenderChecklistItem(organisationId, tenderId, body) {
      return request<TenderDetail>(`/api/tenders/${tenderId}/checklist`, {
        method: 'POST',
        organisationId,
        body,
      });
    },
    async attachTenderChecklistDocument(
      organisationId,
      tenderId,
      itemId,
      companyDocumentId,
    ) {
      return request<TenderDetail>(
        `/api/tenders/${tenderId}/checklist/${itemId}/document`,
        { method: 'POST', organisationId, body: { companyDocumentId } },
      );
    },
    async removeTenderChecklistItem(organisationId, tenderId, itemId) {
      return request<TenderDetail>(`/api/tenders/${tenderId}/checklist/${itemId}`, {
        method: 'DELETE',
        organisationId,
      });
    },
    async linkTenderAwardLetter(organisationId, tenderId, loaDocumentId) {
      return request<TenderDetail>(`/api/tenders/${tenderId}/award-letter`, {
        method: 'POST',
        organisationId,
        body: { loaDocumentId },
      });
    },
    async listCompanyDocuments(organisationId) {
      return request<CompanyDocumentListResponse>('/api/company-documents', {
        organisationId,
      });
    },
    async createCompanyDocument(organisationId, file, details) {
      return uploadCompanyDocumentPdf(
        `/api/company-documents?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async uploadCompanyDocumentVersion(organisationId, documentId, file, details) {
      return uploadCompanyDocumentPdf(
        `/api/company-documents/${documentId}/versions?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async archiveCompanyDocument(organisationId, documentId) {
      return request<CompanyDocument>(`/api/company-documents/${documentId}/archive`, {
        method: 'POST',
        organisationId,
      });
    },
    async downloadCompanyDocumentVersion(organisationId, versionId) {
      const response = await fetchImpl(
        `/api/company-document-versions/${versionId}/file`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async getWorkInspectionConfig(organisationId, workId) {
      return request<WorkInspectionConfig>(`/api/works/${workId}/inspection-config`, {
        organisationId,
      });
    },
    async saveInspectionClauses(organisationId, workId, body) {
      return request<WorkInspectionConfig>(`/api/works/${workId}/inspection-clauses`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async saveInspectionChecklist(organisationId, workId, body) {
      return request<WorkInspectionConfig>(
        `/api/works/${workId}/inspection-checklist`,
        { method: 'PUT', body, organisationId },
      );
    },
    async listInspectionCalls(organisationId, page = {}) {
      const query = uploadQuery({
        limit: page.limit === undefined ? undefined : String(page.limit),
        cursor: page.cursor,
      });
      return request<InspectionCallListResponse>(
        query === '' ? '/api/inspection-calls' : `/api/inspection-calls?${query}`,
        { organisationId },
      );
    },
    async createInspectionCall(organisationId, workId, body) {
      return request<InspectionCall>(`/api/works/${workId}/inspection-calls`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async receiveInspectionCallLetter(organisationId, callId, file, details) {
      return uploadInspectionPdf(
        `/api/inspection-calls/${callId}/call-letter?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async uploadInspectionEvidence(organisationId, documentId, file, details) {
      return uploadInspectionPdf(
        `/api/inspection-call-documents/${documentId}/file?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async uploadInspectionCertificate(organisationId, callId, file, details) {
      return uploadInspectionPdf(
        `/api/inspection-calls/${callId}/certificate?${uploadQuery(details)}`,
        organisationId,
        file,
      );
    },
    async closeInspectionCall(organisationId, callId) {
      return request<InspectionCall>(`/api/inspection-calls/${callId}/close`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelInspectionCall(organisationId, callId, body) {
      return request<InspectionCall>(`/api/inspection-calls/${callId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async downloadInspectionDocument(organisationId, documentId) {
      const response = await fetchImpl(
        `/api/inspection-call-documents/${documentId}/file`,
        {
          credentials: 'same-origin',
          headers: { 'x-organisation-id': organisationId },
        },
      );
      if (!response.ok) throw await parseError(response);
      return response.blob();
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
    async listTaxInvoices(organisationId, options = {}) {
      const parameters = new URLSearchParams();
      if (options.cursor !== undefined) parameters.set('cursor', options.cursor);
      if (options.limit !== undefined) parameters.set('limit', String(options.limit));
      if (options.invoicedFrom !== undefined) {
        parameters.set('invoicedFrom', options.invoicedFrom);
      }
      if (options.invoicedTo !== undefined) {
        parameters.set('invoicedTo', options.invoicedTo);
      }
      const suffix = parameters.size > 0 ? `?${parameters.toString()}` : '';
      return request<TaxInvoiceRegisterResponse>(`/api/tax-invoices${suffix}`, {
        organisationId,
      });
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
    async listChallanEwayBills(organisationId, challanId) {
      const payload = await request<{ ewayBills: EwayBill[] }>(
        `/api/challans/${challanId}/eway-bills`,
        { organisationId },
      );
      return payload.ewayBills;
    },
    async createChallanEwayBill(organisationId, challanId, body) {
      return request<EwayBillDetailResponse>(`/api/challans/${challanId}/eway-bills`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async renderEwayBill(organisationId, ewayBillId) {
      return request<EwayBillDetailResponse>(`/api/eway-bills/${ewayBillId}/render`, {
        method: 'POST',
        organisationId,
      });
    },
    async downloadEwayBillPdf(organisationId, ewayBillId) {
      // The tenant header travels on every scoped request, so PDFs are
      // fetched (not linked) and handed to the browser as object URLs.
      const response = await fetchImpl(`/api/eway-bills/${ewayBillId}/pdf`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
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
    async listStockItems(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      if (options?.status !== undefined) query.set('status', options.status);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<StockRegisterResponse>(`/api/stock/items${suffix}`, {
        organisationId,
      });
    },
    async setStockReorderLevel(organisationId, itemId, body) {
      return request<StockItemResponse>(`/api/stock/items/${itemId}/reorder-level`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listMaintenanceRequests(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<MaintenanceListResponse>(`/api/maintenance${suffix}`, {
        organisationId,
      });
    },
    async getMaintenanceRequest(organisationId, requestId) {
      return request<MaintenanceDetailResponse>(`/api/maintenance/${requestId}`, {
        organisationId,
      });
    },
    async createMaintenanceRequest(organisationId, body) {
      return request<{ id: string; number: string }>('/api/maintenance', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async approveMaintenanceRequest(organisationId, requestId, body) {
      return request<MaintenanceDetailResponse>(
        `/api/maintenance/${requestId}/approve`,
        { method: 'POST', body, organisationId },
      );
    },
    async recordMaintenanceDispatch(organisationId, requestId, body) {
      return request<MaintenanceDetailResponse>(
        `/api/maintenance/${requestId}/dispatches`,
        { method: 'POST', body, organisationId },
      );
    },
    async receiveMaintenanceReturn(organisationId, requestId, body) {
      return request<MaintenanceDetailResponse>(
        `/api/maintenance/${requestId}/returns`,
        { method: 'POST', body, organisationId },
      );
    },
    async cancelMaintenanceLine(organisationId, requestId, lineId, body) {
      return request<MaintenanceDetailResponse>(
        `/api/maintenance/${requestId}/lines/${lineId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async closeMaintenanceRequest(organisationId, requestId) {
      return request<MaintenanceDetailResponse>(`/api/maintenance/${requestId}/close`, {
        method: 'POST',
        organisationId,
      });
    },
    async listStockMovements(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<StockMovementListResponse>(`/api/stock/movements${suffix}`, {
        organisationId,
      });
    },
    async postStockMovement(organisationId, body) {
      return request<StockMovementResponse>('/api/stock/movements', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listPendingProductionReceipts(organisationId) {
      return request<PendingProductionReceiptListResponse>(
        '/api/stock/production-receipts',
        { organisationId },
      );
    },
    async recordProductionReceipt(organisationId, body) {
      return request<StockMovementResponse>('/api/stock/production-receipts', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async listStockShortages(organisationId) {
      return request<StockShortageResponse>('/api/stock/shortages', {
        organisationId,
      });
    },
    async createShortagePurchaseOrder(organisationId, body) {
      return request<PurchaseOrderDetailResponse>(
        '/api/stock/shortages/purchase-order',
        { method: 'POST', body, organisationId },
      );
    },
    async listSigningRequests(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      if (options?.status !== undefined) query.set('status', options.status);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<SigningQueueResponse>(`/api/signing-requests${suffix}`, {
        organisationId,
      });
    },
    async createSigningRequest(organisationId, body) {
      return request<SigningRequestResponse>('/api/signing-requests', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async cancelSigningRequest(organisationId, requestId, body) {
      return request<SigningRequestResponse>(
        `/api/signing-requests/${requestId}/cancel`,
        { method: 'POST', body, organisationId },
      );
    },
    async listImportBatches(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<ImportBatchList>(`/api/imports${suffix}`, { organisationId });
    },
    async readImportBatch(organisationId, batchId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', String(options.cursor));
      if (options?.status !== undefined) query.set('status', options.status);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<ImportBatchDetail>(`/api/imports/${batchId}${suffix}`, {
        organisationId,
      });
    },
    async uploadImportWorkbook(organisationId, target, file) {
      // The raw Blob, exactly as `uploadPdf` sends a PDF — there is no
      // FormData anywhere in this client. The file's own name rides the
      // querystring because it is what the operator calls the import.
      const query = uploadQuery({ target, filename: file.name });
      const response = await fetchImpl(`/api/imports?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'x-organisation-id': organisationId,
        },
        body: file,
      });
      if (!response.ok) throw await parseError(response);
      return (await response.json()) as ImportBatchDetail;
    },
    async commitImportBatch(organisationId, batchId) {
      return request<ImportBatchDetail>(`/api/imports/${batchId}/import`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelImportBatch(organisationId, batchId, body) {
      return request<ImportBatchDetail>(`/api/imports/${batchId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async downloadImportTemplate(organisationId, target) {
      return downloadBlob(`/api/imports/templates/${target}`, organisationId);
    },
    async downloadSignedPdf(organisationId, requestId) {
      // Fetched rather than linked, like every other PDF here: the
      // tenant header travels on every scoped request and an <a href>
      // cannot carry one.
      const response = await fetchImpl(`/api/signing-requests/${requestId}/pdf`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },
    async registerSigningAgent(organisationId, body) {
      return request<RegisterSigningAgentResponse>('/api/signing-agents', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async revokeSigningAgent(organisationId, agentId) {
      return request<SigningAgentResponse>(`/api/signing-agents/${agentId}/revoke`, {
        method: 'POST',
        organisationId,
      });
    },

    async listNotificationChannels(organisationId) {
      return request<NotificationChannelListResponse>('/api/notification-channels', {
        organisationId,
      });
    },
    async saveNotificationChannel(organisationId, channel, body) {
      return request<NotificationChannelResponse>(
        `/api/notification-channels/${channel}`,
        { method: 'PUT', body, organisationId },
      );
    },
    async listNotificationTemplates(organisationId, options) {
      return request<NotificationTemplateListResponse>(
        `/api/notification-templates${pageQuery(options)}`,
        { organisationId },
      );
    },
    async createNotificationTemplate(organisationId, body) {
      return request<NotificationTemplateResponse>('/api/notification-templates', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async setNotificationTemplateStatus(organisationId, templateId, body) {
      return request<NotificationTemplateResponse>(
        `/api/notification-templates/${templateId}/status`,
        { method: 'POST', body, organisationId },
      );
    },
    async listNotificationConsents(organisationId, options) {
      return request<NotificationConsentListResponse>(
        `/api/notification-consents${pageQuery(options)}`,
        { organisationId },
      );
    },
    async recordNotificationConsent(organisationId, body) {
      return request<NotificationConsentResponse>('/api/notification-consents', {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async recordStaffNotificationConsents(organisationId, body) {
      return request<StaffNotificationConsentResponse>(
        '/api/notification-consents/staff',
        { method: 'POST', body, organisationId },
      );
    },
    async listNotifications(organisationId, options) {
      return request<NotificationMessageListResponse>(
        `/api/notifications${pageQuery(options)}`,
        { organisationId },
      );
    },
    async sendNotification(organisationId, body) {
      return request<NotificationMessageResponse>('/api/notifications', {
        method: 'POST',
        body,
        organisationId,
      });
    },

    async listEntitlements(organisationId) {
      return request<EntitlementListResponse>('/api/platform/entitlements', {
        organisationId,
      });
    },
    async setEntitlement(organisationId, key, body) {
      return request<EntitlementResponse>(`/api/platform/entitlements/${key}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listJobSchedules(organisationId) {
      return request<JobScheduleListResponse>('/api/platform/job-schedules', {
        organisationId,
      });
    },
    async setJobSchedule(organisationId, kind, body) {
      return request<JobScheduleResponse>(`/api/platform/job-schedules/${kind}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listOrganisationExports(organisationId) {
      return request<OrganisationExportListResponse>('/api/platform/exports', {
        organisationId,
      });
    },
    async requestOrganisationExport(organisationId) {
      return request<OrganisationExportResponse>('/api/platform/exports', {
        method: 'POST',
        organisationId,
      });
    },
    async downloadOrganisationExport(organisationId, exportId) {
      const response = await fetchImpl(`/api/platform/exports/${exportId}/download`, {
        credentials: 'same-origin',
        headers: { 'x-organisation-id': organisationId },
      });
      if (!response.ok) throw await parseError(response);
      return response.blob();
    },

    async listEmployees(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      if (options?.status !== undefined) query.set('status', options.status);
      if (options?.search !== undefined && options.search !== '') {
        query.set('search', options.search);
      }
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<EmployeeListResponse>(`/api/employees${suffix}`, {
        organisationId,
      });
    },
    async getEmployee(organisationId, employeeId) {
      return request<EmployeeResponse>(`/api/employees/${employeeId}`, {
        organisationId,
      });
    },
    async createEmployee(organisationId, body) {
      return request<EmployeeResponse>('/api/employees', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async updateEmployee(organisationId, employeeId, body) {
      return request<EmployeeResponse>(`/api/employees/${employeeId}`, {
        method: 'PUT',
        body,
        organisationId,
      });
    },
    async listPayrollRuns(organisationId, options) {
      const query = new URLSearchParams();
      if (options?.limit !== undefined) query.set('limit', String(options.limit));
      if (options?.cursor !== undefined) query.set('cursor', options.cursor);
      const suffix = query.size === 0 ? '' : `?${query.toString()}`;
      return request<PayrollRunListResponse>(`/api/payroll-runs${suffix}`, {
        organisationId,
      });
    },
    async getPayrollRun(organisationId, runId) {
      return request<PayrollRunResponse>(`/api/payroll-runs/${runId}`, {
        organisationId,
      });
    },
    async openPayrollRun(organisationId, body) {
      return request<PayrollRunResponse>('/api/payroll-runs', {
        method: 'POST',
        body,
        organisationId,
      });
    },
    async calculatePayrollRun(organisationId, runId) {
      return request<PayrollRunResponse>(`/api/payroll-runs/${runId}/calculate`, {
        method: 'POST',
        organisationId,
      });
    },
    async setPayrollLineLossOfPay(organisationId, runId, lineId, body) {
      return request<PayrollRunResponse>(
        `/api/payroll-runs/${runId}/lines/${lineId}/loss-of-pay`,
        { method: 'PUT', body, organisationId },
      );
    },
    async finalizePayrollRun(organisationId, runId) {
      return request<PayrollRunResponse>(`/api/payroll-runs/${runId}/finalize`, {
        method: 'POST',
        organisationId,
      });
    },
    async cancelPayrollRun(organisationId, runId, body) {
      return request<PayrollRunResponse>(`/api/payroll-runs/${runId}/cancel`, {
        method: 'POST',
        body,
        organisationId,
      });
    },
  };
}
