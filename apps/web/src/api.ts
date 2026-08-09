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
  ConsigneeMaster,
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
  OrganisationProfile,
  Receipt,
  RecordMbEntryRequest,
  RecordReceiptRequest,
  RecordSerialsRequest,
  RespondExtensionRequest,
  SaveChallanRequest,
  SaveConsigneeMasterRequest,
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
} from '@auto-mb/contracts';

export interface MeResponse {
  readonly user: { readonly id: string; readonly email: string };
  readonly memberships: readonly Membership[];
}

/** Error carrying the server's ApiError envelope for user-facing display.
 * `details` carries structured conflict payloads (e.g. one-draft 409s
 * answer with the existing draft's id — see existingRecordIdOf). */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details ?? null;
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
  readonly prepareBill: (organisationId: string, workId: string) => Promise<Bill>;
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
  readonly listConsigneeMasters: (
    organisationId: string,
    includeRetired?: boolean,
  ) => Promise<readonly ConsigneeMaster[]>;
  readonly saveConsigneeMaster: (
    organisationId: string,
    id: string | null,
    body: SaveConsigneeMasterRequest,
  ) => Promise<ConsigneeMaster>;
  readonly setConsigneeMasterActive: (
    organisationId: string,
    id: string,
    active: boolean,
  ) => Promise<ConsigneeMaster>;
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
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    details = body.details;
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return new RequestFailedError(response.status, code, message, details);
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
      await request('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email, password },
      });
    },
    async signOut() {
      await request('/api/auth/sign-out', { method: 'POST', body: {} });
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
    async listLoaDocuments(organisationId) {
      const payload = await request<{ documents: LoaDocument[] }>(
        '/api/loa-documents',
        { organisationId },
      );
      return payload.documents;
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
    async prepareBill(organisationId, workId) {
      return request<Bill>(`/api/works/${workId}/bills`, {
        method: 'POST',
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
    async listConsigneeMasters(organisationId, includeRetired = false) {
      const payload = await request<{ consignees: ConsigneeMaster[] }>(
        `/api/masters/consignees${includeRetired ? '?includeRetired=true' : ''}`,
        { organisationId },
      );
      return payload.consignees;
    },
    async saveConsigneeMaster(organisationId, id, body) {
      return request<ConsigneeMaster>(
        id === null ? '/api/masters/consignees' : `/api/masters/consignees/${id}`,
        { method: id === null ? 'POST' : 'PUT', body, organisationId },
      );
    },
    async setConsigneeMasterActive(organisationId, id, active) {
      return request<ConsigneeMaster>(
        `/api/masters/consignees/${id}/${active ? 'reactivate' : 'retire'}`,
        { method: 'POST', organisationId },
      );
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
    async proposeAddItem(organisationId, workId, body) {
      return request<ApprovalRequest>(`/api/works/${workId}/amendments/items`, {
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
  };
}
