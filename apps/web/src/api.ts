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
}

/** PATCH /api/work-items/:id/tax-facts body. The route owns these shapes
 * (they are not in @auto-mb/contracts). PATCH semantics: an omitted
 * field keeps its value, an explicit null clears it. `isService` takes
 * no null â€” its column is NOT NULL DEFAULT false. */
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
 * answer with the existing draft's id â€” see existingRecordIdOf). */
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
  readonly signIn: (email: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
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
  ) => Promise<readonly LoaDocument[]>;
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
  readonly listSignatories: (
    organisationId: string,
    includeRetired?×Î5ÖÚ$z{-®éÜj×væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’÷v÷&·2òG·v÷&´–GÒöÖV7W&VÖVçBÖ&öö·6À¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2ÖW&vUv÷&´ÖV7W&VÖVçD&öö·2†÷&væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’÷v÷&·2òG·v÷&´–GÒöÖV7W&VÖVçBÖ&öö·2öÖW&vVÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2VæÖW&vTÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢v—B&WVW7B†ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒ÷VæÖW&vVÂ°¢ÖWF†öC¢uõ5BrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2vWDÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÖÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26WDÖV7W&VÖVçD&ööµ6÷W&6W2†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–BÂ&öG’’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒ÷6÷W&6W6À¢²ÖWF†öC¢uUBrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2f–æÆ—¦TÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒöf–æÆ—¦VÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26æ6VÄÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–BÂæ÷FR’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒö6æ6VÆÀ¢²ÖWF†öC¢uõ5BrÂ&öG“¢²æ÷FRÒÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2FVÆWFTÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢v—B&WVW7CÇfö–Câ†ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2&W&T&–ÆÄg&öÔÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢&WGW&â&WVW7CÄ&–ÆÃâ†ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒö&–ÆÆÂ°¢ÖWF†öC¢uõ5BrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2&VæFW$ÖV7W&VÖVçD&öö²†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢&WGW&â&WVW7CÄÖV7W&VÖVçD&öö´FWF–Å&W7öç6Sâ€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒ÷&VæFW&À¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2F÷væÆöDÖV7W&VÖVçD&ööµFb†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢6öç7B&W7öç6RÒv—BfWF6„–×Â€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒ÷FfÀ¢°¢7&VFVçF–Ç3¢w6ÖRÖ÷&–v–ârÀ¢†VFW'3¢²w‚Ö÷&væ—6F–öâÖ–Bs¢÷&væ—6F–öä–BÒÀ¢ÒÀ¢“°¢–b‚&W7öç6Ræö²’F‡&÷rv—B'6TW'&÷"‡&W7öç6R“°¢&WGW&â&W7öç6Ræ&Æö"‚“°¢ÒÀ¢7–æ2F÷væÆöDÖV7W&VÖVçD&öö´G&gE&Wf–Wr†÷&væ—6F–öä–BÂÖV7W&VÖVçD&öö´–B’°¢6öç7B&W7öç6RÒv—BfWF6„–×Â€¢ö’öÖV7W&VÖVçBÖ&öö·2òG¶ÖV7W&VÖVçD&öö´–GÒ÷Fc÷&Wf–WsÓÀ¢°¢7&VFVçF–Ç3¢w6ÖRÖ÷&–v–ârÀ¢†VFW'3¢²w‚Ö÷&væ—6F–öâÖ–Bs¢÷&væ—6F–öä–BÒÀ¢ÒÀ¢“°¢–b‚&W7öç6Ræö²’F‡&÷rv—B'6TW'&÷"‡&W7öç6R“°¢&WGW&â&W7öç6Ræ&Æö"‚“°¢ÒÀ¢7–æ26ö×ÆWFUv÷&²†÷&væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÅv÷&µ7FGW5&W7öç6Sâ†ö’÷v÷&·2òG·v÷&´–GÒö6ö×ÆWFVÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2v÷&´6ö×ÆWF–öå&VF–æW72†÷&væ—6F–öä–BÂv÷&´–B’°¢&WGW&â&WVW7CÅv÷&´6ö×ÆWF–öå&VF–æW73â€¢ö’÷v÷&·2òG·v÷&´–GÒö6ö×ÆWF–öâ×&VF–æW76À¢²÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V÷Våv÷&²†÷&væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÅv÷&µ7FGW5&W7öç6Sâ†ö’÷v÷&·2òG·v÷&´–GÒ÷&V÷VæÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2Æ—7Ev÷&µW&6†6T÷&FW'2†÷&væ—6F–öä–BÂv÷&´–BÂ7FGW2’°¢6öç7BVW'’Ò7FGW2ÓÒVæFVf–æVBò÷7FGW3ÒG·7FGW7Ö¢rs°¢6öç7B–ÆöBÒv—B&WVW7CÇ²W&6†6T÷&FW'3¢W&6†6T÷&FW%µÒÓâ€¢ö’÷v÷&·2òG·v÷&´–GÒ÷W&6†6RÖ÷&FW'2G·VW'—ÖÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢&WGW&â–ÆöBçW&6†6T÷&FW'3°¢ÒÀ¢7–æ27&VFUv÷&µW&6†6T÷&FW"†÷&væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷v÷&·2òG·v÷&´–GÒ÷W&6†6RÖ÷&FW'6À¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2vWEW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–B’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÖÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2WFFUW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–BÂ&öG’’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÖÀ¢²ÖWF†öC¢uUBrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26fUW&6†6T÷&FW$Æ–æW2†÷&væ—6F–öä–BÂW&6†6T÷&FW$–BÂ&öG’’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÒöÆ–æW6À¢²ÖWF†öC¢uUBrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2—77VUW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–B’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÒö—77VVÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26æ6VÅW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–BÂ&öG’’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÒö6æ6VÆÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26Æ÷6UW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–B’°¢&WGW&â&WVW7CÅW&6†6T÷&FW$FWF–Å&W7öç6Sâ€¢ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÒö6Æ÷6VÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2FVÆWFUW&6†6T÷&FW"†÷&væ—6F–öä–BÂW&6†6T÷&FW$–B’°¢v—B&WVW7B†ö’÷W&6†6RÖ÷&FW'2òG·W&6†6T÷&FW$–GÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2Æ—7D'VFvWF'•V÷FF–öç2†÷&væ—6F–öä–B’°¢6öç7B–ÆöBÒv—B&WVW7CÇ²'VFvWF'•V÷FF–öç3¢'VFvWF'•V÷FF–öåµÒÓâ€¢rö’ö'VFvWF'’×V÷FF–öç2rÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢&WGW&â–ÆöBæ'VFvWF'•V÷FF–öç3°¢ÒÀ¢7–æ27&VFT'VFvWF'•V÷FF–öâ†÷&væ—6F–öä–BÂ&öG’’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ‚rö’ö'VFvWF'’×V÷FF–öç2rÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2vWD'VFvWF'•V÷FF–öâ†÷&væ—6F–öä–BÂV÷FF–öä–B’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ€¢ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÖÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2WFFT'VFvWF'•V÷FF–öâ†÷&væ—6F–öä–BÂV÷FF–öä–BÂ&öG’’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ€¢ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÖÀ¢²ÖWF†öC¢uUBrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26fT'VFvWF'•V÷FF–öäÆ–æW2†÷&væ—6F–öä–BÂV÷FF–öä–BÂ&öG’’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ€¢ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÒöÆ–æW6À¢²ÖWF†öC¢uUBrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2—77VT'VFvWF'•V÷FF–öâ†÷&væ—6F–öä–BÂV÷FF–öä–B’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ€¢ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÒö—77VVÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26WD'VFvWF'•V÷FF–öä÷WF6öÖR†÷&væ—6F–öä–BÂV÷FF–öä–BÂ&öG’’°¢&WGW&â&WVW7CÄ'VFvWF'•V÷FF–öäFWF–Å&W7öç6Sâ€¢ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÒö÷WF6öÖVÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2FVÆWFT'VFvWF'•V÷FF–öâ†÷&væ—6F–öä–BÂV÷FF–öä–B’°¢v—B&WVW7B†ö’ö'VFvWF'’×V÷FF–öç2òG·V÷FF–öä–GÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2Æ—7Ev÷&µF„–çfö–6W2†÷&væ—6F–öä–BÂv÷&´–B’°¢6öç7B–ÆöBÒv—B&WVW7CÇ²–çfö–6W3¢F„–çfö–6UµÒÓâ€¢ö’÷v÷&·2òG·v÷&´–GÒ÷F‚Ö–çfö–6W6À¢²÷&væ—6F–öä–BÒÀ¢“°¢&WGW&â–ÆöBæ–çfö–6W3°¢ÒÀ¢7–æ27&VFUv÷&µF„–çfö–6R†÷&væ—6F–öä–BÂv÷&´–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ†ö’÷v÷&·2òG·v÷&´–GÒ÷F‚Ö–çfö–6W6Â°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2vWEF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ†ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÖÂ°¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2WFFUF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ†ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÖÂ°¢ÖWF†öC¢uUBrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ27V&Ö—EF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒ÷7V&Ö—FÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&VæFW%F„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒ÷&VæFW&À¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2F÷væÆöEF„–çfö–6UFb†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢6öç7B&W7öç6RÒv—BfWF6„–×Â†ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒ÷FfÂ°¢7&VFVçF–Ç3¢w6ÖRÖ÷&–v–ârÀ¢†VFW'3¢²w‚Ö÷&væ—6F–öâÖ–Bs¢÷&væ—6F–öä–BÒÀ¢Ò“°¢–b‚&W7öç6Ræö²’F‡&÷rv—B'6TW'&÷"‡&W7öç6R“°¢&WGW&â&W7öç6Ræ&Æö"‚“°¢ÒÀ¢7–æ26æ6VÅF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒö6æ6VÆÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2FVÆWFUF„–çfö–6R†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢v—B&WVW7B†ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2F„–çfö–6T—'–ÆöB†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7EFW‡B†ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒö—'×–ÆöFÂ°¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2&Vv—7FW%F„–çfö–6T—'†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒ÷&Vv—7FW"Ö—'À¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷fW%F„–çfö–6U&÷f–FW$÷W&F–öâ†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒ÷&V6÷fW"×&÷f–FW"Ö÷W&F–öæÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26æ6VÅF„–çfö–6T—'†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒö6æ6VÂÖ—'À¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷&EF„–çfö–6T—'6æ6VÆÆF–öâ†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒö—'Ö6æ6VÂ×&W7öç6VÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷&EF„–çfö–6T—'&W7öç6R†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒö—'×&W7öç6VÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2Æ—7D–çfö–6TWv”&–ÆÇ2†÷&væ—6F–öä–BÂ–çfö–6T–B’°¢6öç7B–ÆöBÒv—B&WVW7CÇ²Wv”&–ÆÇ3¢Wv”&–ÆÅµÒÓâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒöWv’Ö&–ÆÇ6À¢²÷&væ—6F–öä–BÒÀ¢“°¢&WGW&â–ÆöBæWv”&–ÆÇ3°¢ÒÀ¢7–æ27&VFT–çfö–6TWv”&–ÆÂ†÷&væ—6F–öä–BÂ–çfö–6T–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’÷F‚Ö–çfö–6W2òG¶–çfö–6T–GÒöWv’Ö&–ÆÇ6À¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2vWDWv”&–ÆÂ†÷&væ—6F–öä–BÂWv”&–ÆÄ–B’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ†ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÖÂ°¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2WFFTWv”&–ÆÂ†÷&væ—6F–öä–BÂWv”&–ÆÄ–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ†ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÖÂ°¢ÖWF†öC¢uUBrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2Wv”&–ÆÄæ–5–ÆöB†÷&væ—6F–öä–BÂWv”&–ÆÄ–B’°¢&WGW&â&WVW7EFW‡B†ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒöæ–2×–ÆöFÂ°¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2vVæW&FTWv”&–ÆÂ†÷&væ—6F–öä–BÂWv”&–ÆÄ–B’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒövVæW&FVÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26æ6VÄWv”&–ÆÄE&÷f–FW"†÷&væ—6F–öä–BÂWv”&–ÆÄ–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒö6æ6VÂ×&÷f–FW&À¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷fW$Wv”&–ÆÅ&÷f–FW$÷W&F–öâ†÷&væ—6F–öä–BÂWv”&–ÆÄ–B’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒ÷&V6÷fW"×&÷f–FW"Ö÷W&F–öæÀ¢²ÖWF†öC¢uõ5BrÂ÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷&DWv”&–ÆÄ6æ6VÆÆF–öâ†÷&væ—6F–öä–BÂWv”&–ÆÄ–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒöÖçVÂÖ6æ6VÂ×&W7öç6VÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ2&V6÷&DWv”&–ÆÄæ–5&W7öç6R†÷&væ—6F–öä–BÂWv”&–ÆÄ–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ€¢ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒöæ–2×&W7öç6VÀ¢²ÖWF†öC¢uõ5BrÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢7–æ26æ6VÄWv”&–ÆÂ†÷&væ—6F–öä–BÂWv”&–ÆÄ–BÂ&öG’’°¢&WGW&â&WVW7CÄWv”&–ÆÄFWF–Å&W7öç6Sâ†ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÒö6æ6VÆÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2FVÆWFTWv”&–ÆÂ†÷&væ—6F–öä–BÂWv”&–ÆÄ–B’°¢v—B&WVW7B†ö’öWv’Ö&–ÆÇ2òG¶Wv”&–ÆÄ–GÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ2Æ—7DçVÖ&W%6W&–W2†÷&væ—6F–öä–B’°¢6öç7B–ÆöBÒv—B&WVW7CÇ²6W&–W3¢çVÖ&W%6W&–W5µÒÓâ€¢rö’ö÷&væ—6F–öâöçVÖ&W"×6W&–W2rÀ¢²÷&væ—6F–öä–BÒÀ¢“°¢&WGW&â–ÆöBç6W&–W3°¢ÒÀ¢7–æ26WDçVÖ&W%6W&–W2†÷&væ—6F–öä–BÂFö7VÖVçEG—RÂ&öG’’°¢&WGW&â&WVW7CÄçVÖ&W%6W&–W3â†ö’ö÷&væ—6F–öâöçVÖ&W"×6W&–W2òG¶Fö7VÖVçEG—WÖÂ°¢ÖWF†öC¢uUBrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ26ÆV$çVÖ&W%6W&–W2†÷&væ—6F–öä–BÂFö7VÖVçEG—R’°¢&WGW&â&WVW7CÄçVÖ&W%6W&–W3â†ö’ö÷&væ—6F–öâöçVÖ&W"×6W&–W2òG¶Fö7VÖVçEG—WÖÂ°¢ÖWF†öC¢tDTÄUDRrÀ¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ27&VFTF—&V7EF„–çfö–6R†÷&væ—6F–öä–BÂ&öG’’°¢&WGW&â&WVW7CÅF„–çfö–6TFWF–Å&W7öç6Sâ‚rö’÷F‚Ö–çfö–6W2rÂ°¢ÖWF†öC¢uõ5BrÀ¢&öG’À¢÷&væ—6F–öä–BÀ¢Ò“°¢ÒÀ¢7–æ26WEv÷&´—FVÕF„f7G2†÷&væ—6F–öä–BÂv÷&´—FVÔ–BÂ&öG’’°¢&WGW&â&WVW7CÅv÷&´—FVÕF„f7G5&W7öç6Sâ€¢ö’÷v÷&²Ö—FV×2òG·v÷&´—FVÔ–GÒ÷F‚Öf7G6À¢²ÖWF†öC¢uD4‚rÂ&öG’Â÷&væ—6F–öä–BÒÀ¢“°¢ÒÀ¢Ó°§Ð 