import { describe, expect, it, vi } from 'vitest';
import { createApiClient, RequestFailedError } from '../src/api.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  it('sends tenant-scoped requests with the organisation header and cookie credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { members: [] }));
    const api = createApiClient(fetchImpl);

    await api.listMembers('11111111-1111-4111-8111-111111111111');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/organisations/current/members');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({
      'x-organisation-id': '11111111-1111-4111-8111-111111111111',
    });
  });

  it('does not attach an organisation header to identity-level requests', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { organisations: [] }));
    const api = createApiClient(fetchImpl);

    await api.listOrganisations();

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain(
      'x-organisation-id',
    );
  });

  it('surfaces the server error envelope as a typed error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        code: 'NOT_A_MEMBER',
        message: 'The authenticated user holds no active membership.',
        requestId: 'req-1',
      }),
    );
    const api = createApiClient(fetchImpl);

    await expect(
      api.listMembers('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({
      status: 403,
      code: 'NOT_A_MEMBER',
    });
  });

  it('treats 401 from /api/me as signed-out, not as a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, {
        code: 'UNAUTHENTICATED',
        message: 'Sign in.',
        requestId: 'req-2',
      }),
    );
    const api = createApiClient(fetchImpl);

    await expect(api.me()).resolves.toBeNull();
  });

  it('keeps non-401 failures from /api/me as errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('oops', { status: 500 }));
    const api = createApiClient(fetchImpl);

    await expect(api.me()).rejects.toBeInstanceOf(RequestFailedError);
  });
});
