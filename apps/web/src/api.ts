import type {
  AddMemberRequest,
  ApiError,
  CreateOrganisationRequest,
  Membership,
  Organisation,
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
  };
}
