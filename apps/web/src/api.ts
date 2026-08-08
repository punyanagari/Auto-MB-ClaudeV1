import type {
  AddMemberRequest,
  ApiError,
  Bill,
  CancelChallanRequest,
  ChallanDetailResponse,
  Challan,
  ConfirmWorkRequest,
  ConsigneeMaster,
  CreateOrganisationRequest,
  DashboardResponse,
  InstallSerialRequest,
  Instrument,
  LoaDocument,
  LoaDocumentDetail,
  LocationMaster,
  MbEntry,
  MemberAssignmentsResponse,
  Membership,
  Organisation,
  OrganisationProfile,
  Receipt,
  RecordMbEntryRequest,
  RecordReceiptRequest,
  RecordSerialsRequest,
  SaveChallanRequest,
  SaveConsigneeMasterRequest,
  SaveInstrumentRequest,
  SaveLocationMasterRequest,
  SaveSignatoryRequest,
  SaveUnitMasterRequest,
  Serial,
  TimelineResponse,
  Signatory,
  UnitMaster,
  UpdateBillStatusRequest,
  UpdateInstrumentRequest,
  UpdateMemberRequest,
  UpdateOrganisationProfileRequest,
  Work,
  WorkBalanceResponse,
  WorkDetailResponse,
} from '@auto-mb/contracts';

export interface MeResponse {
  readonly user: { readonly id: string; readonly email: string };
  readonly memberships: readonly Membership[];
}

/** Error carrying the server's ApiError envelope for user-facing display. */
export class RequestFailedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
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
  try {
    const body = (await response.json()) as Partial<ApiError>;
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Non-JSON error body: keep the status-based message.
  }
  return new RequestFailedError(response.status, code, message);
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
  };
}
