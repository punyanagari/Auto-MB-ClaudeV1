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
      requestId: 'req-1',
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

  it('reads the sign-in body and reports a completed session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        user: { id: 'user-a', email: 'owner@example.test' },
        token: 'session-token',
      }),
    );
    const api = createApiClient(fetchImpl);

    await expect(api.signIn('owner@example.test', 'password-123')).resolves.toEqual({
      twoFactorRequired: false,
    });
  });

  it('reads the sign-in body and reports a pending two-factor challenge', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { twoFactorRedirect: true, twoFactorMethods: ['totp'] }),
      );
    const api = createApiClient(fetchImpl);

    await expect(api.signIn('owner@example.test', 'password-123')).resolves.toEqual({
      twoFactorRequired: true,
    });
  });

  it('verifies a TOTP code against the two-factor endpoint', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { token: 't', user: { id: 'user-a' } }));
    const api = createApiClient(fetchImpl);

    await api.verifyTotp('123456');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/two-factor/verify-totp');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: '123456' });
  });

  it('starts enrolment and returns the one-time TOTP URI and backup codes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        totpURI: 'otpauth://totp/Auto-MB:owner@example.test?secret=ABC234',
        backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'],
      }),
    );
    const api = createApiClient(fetchImpl);

    const start = await api.enableTwoFactor('password-123');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/two-factor/enable');
    expect(JSON.parse(init.body as string)).toEqual({ password: 'password-123' });
    expect(start.backupCodes).toHaveLength(2);
    expect(start.totpURI).toContain('secret=');
  });

  it('surfaces the MFA_REQUIRED_BY_POLICY refusal from disable as a typed error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        code: 'MFA_REQUIRED_BY_POLICY',
        message: 'Two-factor authentication is required for this account.',
        requestId: 'req-3',
      }),
    );
    const api = createApiClient(fetchImpl);

    await expect(api.disableTwoFactor('password-123')).rejects.toMatchObject({
      status: 403,
      code: 'MFA_REQUIRED_BY_POLICY',
    });
  });

  it('regenerates backup codes and returns only the fresh set', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { status: true, backupCodes: ['eeeee-fffff'] }),
      );
    const api = createApiClient(fetchImpl);

    await expect(api.regenerateBackupCodes('password-123')).resolves.toEqual([
      'eeeee-fffff',
    ]);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/two-factor/generate-backup-codes');
  });

  it('uploads a LOA as a raw PDF body with the tenant header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        id: '22222222-2222-4222-8222-222222222222',
        extractionStatus: 'review',
      }),
    );
    const api = createApiClient(fetchImpl);
    const file = new Blob(['%PDF-1.4'], { type: 'application/pdf' });

    await api.uploadLoa('11111111-1111-4111-8111-111111111111', file, 'loa letter.pdf');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/loa-documents?filename=loa%20letter.pdf');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-organisation-id': '11111111-1111-4111-8111-111111111111',
    });
  });

  it('confirms a reviewed document against its confirm endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        work: { id: '33333333-3333-4333-8333-333333333333' },
        schedules: [],
      }),
    );
    const api = createApiClient(fetchImpl);

    await api.confirmLoa(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      {
        workCode: 'PL270-CRB',
        letterNumber: 'L-1',
        letterDate: '2025-01-01',
        title: 'Test work',
        advertisedValue: '100.00',
        contractValue: '90.00',
        pricingShape: 'per_schedule',
        schedules: [
          {
            scheduleCode: 'A',
            title: 'Schedule A',
            items: [
              {
                itemNumber: 'A/1',
                description: 'An item',
                unitCode: 'Nos',
                awardedQuantity: '1',
                effectiveRate: '90.00',
              },
            ],
          },
        ],
      },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/loa-documents/22222222-2222-4222-8222-222222222222/confirm');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-organisation-id': '11111111-1111-4111-8111-111111111111',
    });
  });
});

describe('schema-refusal translation', () => {
  async function messageOf(body: unknown): Promise<string> {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, body));
    const api = createApiClient(fetchImpl);
    try {
      await api.listMembers('11111111-1111-4111-8111-111111111111');
    } catch (error) {
      if (error instanceof RequestFailedError) return error.message;
      throw error;
    }
    throw new Error('expected the request to fail');
  }

  it('translates the organisation slug pattern refusal into words', async () => {
    const message = await messageOf({
      code: 'FST_ERR_VALIDATION',
      message: 'body/slug must match pattern "^[a-z0-9][a-z0-9-]{1,62}$"',
    });
    expect(message).not.toContain('body/');
    expect(message).not.toContain('pattern');
    expect(message).toBe(
      'The organisation slug must be 2–63 lowercase letters, digits and hyphens, starting with a letter or digit.',
    );
  });

  it('names the LOA confirm row instead of its instancePath', async () => {
    const message = await messageOf({
      code: 'FST_ERR_VALIDATION',
      message:
        'body/schedules/0/items/2/sourceRef/itemSno must NOT have fewer than 1 characters',
    });
    expect(message).not.toContain('body/');
    expect(message).toBe(
      'The schedules 1 › items 3 › source reference › source item number must be at least 1 characters.',
    );
  });

  it('translates missing-property refusals', async () => {
    const message = await messageOf({
      code: 'FST_ERR_VALIDATION',
      message: "body must have required property 'sourceRef'",
    });
    expect(message).toBe('The form is missing source reference — fill it in.');
  });

  it('splits joined clauses on error boundaries, not on commas in patterns', async () => {
    const message = await messageOf({
      code: 'FST_ERR_VALIDATION',
      message:
        'body/slug must match pattern "^[a-z0-9][a-z0-9-]{1,62}$", ' +
        'body/name must NOT have fewer than 2 characters',
    });
    expect(message).not.toContain('body/');
    expect(message).toContain('organisation slug');
    expect(message).toContain('The name must be at least 2 characters.');
  });

  it('falls back to a generic human sentence for unrecognised shapes', async () => {
    const message = await messageOf({
      code: 'FST_ERR_VALIDATION',
      message: 'something completely different',
    });
    expect(message).not.toContain('body/');
    expect(message).toContain('Check the highlighted fields');
  });

  it('leaves ordinary server messages alone', async () => {
    const message = await messageOf({
      code: 'BUYER_PROFILE_INCOMPLETE',
      message: 'The buyer contact is missing address — complete it and retry.',
    });
    expect(message).toContain('buyer contact');
  });
});
