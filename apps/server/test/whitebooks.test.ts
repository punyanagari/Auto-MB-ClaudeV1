import { describe, expect, it, vi } from 'vitest';
import {
  WhitebooksProvider,
  readWhitebooksConfig,
  type WhitebooksConfig,
} from '../src/gsp/whitebooks.js';

const baseConfig: WhitebooksConfig = {
  environment: 'sandbox',
  email: 'statutory@example.test',
  username: 'irp-user',
  password: 'not-a-real-password',
  clientId: 'invoice-client',
  clientSecret: 'invoice-secret',
  ewayClientId: 'eway-client',
  ewayClientSecret: 'eway-secret',
  ipAddress: '203.0.113.10',
  gstin: '27AAAAA0000A1Z5',
  irp: 'NIC1',
  timeoutMs: 1_000,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

describe('Whitebooks configuration', () => {
  it('accepts a separate E-way Bill client pair', () => {
    const config = readWhitebooksConfig({
      WHITEBOOKS_ENABLED: 'true',
      WHITEBOOKS_ENVIRONMENT: 'sandbox',
      WHITEBOOKS_EMAIL: baseConfig.email,
      WHITEBOOKS_USERNAME: baseConfig.username,
      WHITEBOOKS_PASSWORD: baseConfig.password,
      WHITEBOOKS_CLIENT_ID: baseConfig.clientId,
      WHITEBOOKS_CLIENT_SECRET: baseConfig.clientSecret,
      WHITEBOOKS_EWAY_CLIENT_ID: baseConfig.ewayClientId ?? undefined,
      WHITEBOOKS_EWAY_CLIENT_SECRET: baseConfig.ewayClientSecret ?? undefined,
      WHITEBOOKS_IP_ADDRESS: baseConfig.ipAddress,
      WHITEBOOKS_GSTIN: baseConfig.gstin,
    });

    expect(config).toMatchObject({
      ewayClientId: 'eway-client',
      ewayClientSecret: 'eway-secret',
    });
  });

  it('rejects a partial E-way Bill client pair', () => {
    expect(() =>
      readWhitebooksConfig({
        WHITEBOOKS_ENABLED: 'true',
        WHITEBOOKS_ENVIRONMENT: 'sandbox',
        WHITEBOOKS_EMAIL: baseConfig.email,
        WHITEBOOKS_USERNAME: baseConfig.username,
        WHITEBOOKS_PASSWORD: baseConfig.password,
        WHITEBOOKS_CLIENT_ID: baseConfig.clientId,
        WHITEBOOKS_CLIENT_SECRET: baseConfig.clientSecret,
        WHITEBOOKS_EWAY_CLIENT_ID: 'eway-client',
        WHITEBOOKS_IP_ADDRESS: baseConfig.ipAddress,
        WHITEBOOKS_GSTIN: baseConfig.gstin,
      }),
    ).toThrow(
      'WHITEBOOKS_EWAY_CLIENT_ID and WHITEBOOKS_EWAY_CLIENT_SECRET must be set together',
    );
  });
});

describe('Whitebooks IRP transport', () => {
  const identity = {
    gstin: baseConfig.gstin,
    documentNumber: 'INV/2026/001',
    documentDate: '2026-08-12',
  } as const;
  const payloadJson = JSON.stringify({
    Version: '1.1',
    SellerDtls: { Gstin: baseConfig.gstin },
    DocDtls: { Typ: 'INV', No: identity.documentNumber, Dt: '12/08/2026' },
  });

  it('authenticates, sends exact registration bytes, and preserves a large acknowledgement number', async () => {
    const ackNumber = '9007199254740993123';
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = inputUrl(input);
      if (url.pathname === '/einvoice/authenticate') {
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('email')).toBe(baseConfig.email);
        const headers = new Headers(init?.headers);
        expect(headers.get('client_id')).toBe(baseConfig.clientId);
        expect(headers.get('client_secret')).toBe(baseConfig.clientSecret);
        expect(headers.get('username')).toBe(baseConfig.username);
        expect(headers.get('password')).toBe(baseConfig.password);
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: { AuthToken: 'irp-auth-token', UserName: baseConfig.username },
          }),
        );
      }
      expect(url.pathname).toBe('/einvoice/type/GENERATE/version/V1_03');
      expect(url.searchParams.get('email')).toBe(baseConfig.email);
      expect(url.searchParams.get('irp')).toBe('NIC1');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(payloadJson);
      const headers = new Headers(init?.headers);
      expect(headers.get('auth-token')).toBe('irp-auth-token');
      expect(headers.get('username')).toBe(baseConfig.username);
      return Promise.resolve(
        new Response(
          `{"status_cd":"1","data":{"Irn":"${'A'.repeat(64)}","AckNo":${ackNumber},"AckDt":"12/08/2026 14:30:00","SignedQRCode":"signed-qr","SignedInvoice":"signed-invoice"}}`,
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    await expect(provider.registerInvoice(identity, payloadJson)).resolves.toEqual({
      irn: 'a'.repeat(64),
      ackNumber,
      ackDateText: '12/08/2026 14:30:00',
      ackDate: '2026-08-12T09:00:00.000Z',
      signedQr: 'signed-qr',
      signedInvoice: 'signed-invoice',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats only an HTTP 404 document lookup as conclusively absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = inputUrl(input);
      if (url.pathname === '/einvoice/authenticate') {
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: { AuthToken: 'irp-auth-token', UserName: baseConfig.username },
          }),
        );
      }
      expect(url.pathname).toBe('/einvoice/type/GETIRNBYDOCDETAILS/version/V1_03');
      expect(url.searchParams.get('param1')).toBe('INV');
      const headers = new Headers(init?.headers);
      expect(headers.get('docnum')).toBe(identity.documentNumber);
      expect(headers.get('docdate')).toBe('12/08/2026');
      return Promise.resolve(jsonResponse({ status_cd: '0' }, 404));
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);
    await expect(provider.findInvoiceByDocument(identity)).resolves.toBeNull();
  });

  it('cancels an IRN with the exact reason and returns the provider wall clock', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = inputUrl(input);
      if (url.pathname === '/einvoice/authenticate') {
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: { AuthToken: 'irp-auth-token', UserName: baseConfig.username },
          }),
        );
      }
      expect(url.pathname).toBe('/einvoice/type/CANCEL/version/V1_03');
      expect(init?.body).toBe(
        JSON.stringify({
          Irn: 'a'.repeat(64),
          CnlRsn: '2',
          CnlRem: 'Duplicate invoice',
        }),
      );
      return Promise.resolve(
        jsonResponse({
          status_cd: '1',
          data: { CancelDate: '12/08/2026 15:00:00' },
        }),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);
    await expect(
      provider.cancelInvoice({
        gstin: baseConfig.gstin,
        irn: 'a'.repeat(64),
        reasonCode: '2',
        remark: 'Duplicate invoice',
      }),
    ).resolves.toEqual({
      cancelledAtText: '12/08/2026 15:00:00',
      cancelledAt: '2026-08-12T09:30:00.000Z',
    });
  });

  it('maps an auth outage to failed so a mutation can be retried safely', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ status_cd: '0', error_cd: 'AUTH-503' }, 503)),
    );
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        code: 'WHITEBOOKS_AUTH_FAILED',
        outcome: 'failed',
        providerCode: 'AUTH-503',
        httpStatus: 503,
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        inputUrl(input).pathname.includes('/GENERATE/'),
      ),
    ).toBe(false);
  });
});

describe('Whitebooks E-way Bill transport', () => {
  it('authenticates with the separate EWB credentials before cancellation and caches auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const url = inputUrl(input);
      if (url.pathname.endsWith('/authenticate')) {
        expect(init?.method).toBe('GET');
        expect(url.searchParams.get('email')).toBe(baseConfig.email);
        expect(url.searchParams.get('username')).toBe(baseConfig.username);
        expect(url.searchParams.get('password')).toBe(baseConfig.password);
        expect(url.searchParams.get('irp')).toBe('NIC1');
        expect(new Headers(init?.headers).get('client_id')).toBe('eway-client');
        expect(new Headers(init?.headers).get('client_secret')).toBe('eway-secret');
        return Promise.resolve(jsonResponse({ status_cd: '1', data: { Status: '1' } }));
      }

      expect(url.pathname).toBe('/ewaybillapi/v1.03/ewayapi/canewb');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('client_id')).toBe('eway-client');
      expect(new Headers(init?.headers).get('client_secret')).toBe('eway-secret');
      expect(init?.body).toBe(
        '{"ewbNo":123456789012,"cancelRsnCode":2,"cancelRmrk":"Order cancelled"}',
      );
      return Promise.resolve(
        jsonResponse({
          status_cd: '1',
          data: { cancelDate: '11/08/2026 12:30:00' },
        }),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl, () => 1_000_000);

    await provider.cancelEwayBill({
      gstin: baseConfig.gstin,
      ewbNumber: '123456789012',
      reasonCode: '2',
      remark: 'Order cancelled',
    });
    await provider.cancelEwayBill({
      gstin: baseConfig.gstin,
      ewbNumber: '123456789012',
      reasonCode: '2',
      remark: 'Order cancelled',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(
      fetchImpl.mock.calls.filter(([input]) =>
        inputUrl(input).pathname.endsWith('/ewaybillapi/v1.03/authenticate'),
      ),
    ).toHaveLength(1);
  });

  it('fails closed when separate EWB credentials are absent', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new WhitebooksProvider(
      { ...baseConfig, ewayClientId: null, ewayClientSecret: null },
      fetchImpl,
    );

    await expect(
      provider.cancelEwayBill({
        gstin: baseConfig.gstin,
        ewbNumber: '123456789012',
        reasonCode: '2',
        remark: 'Order cancelled',
      }),
    ).rejects.toMatchObject({
      code: 'WHITEBOOKS_EWAY_CANCELLATION_NOT_CONFIGURED',
      outcome: 'failed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses provider lookup evidence for a non-active EWB', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = inputUrl(input);
      if (url.pathname === '/einvoice/authenticate') {
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: { AuthToken: 'token', UserName: baseConfig.username },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          status_cd: '1',
          data: {
            Status: 'CANCELLED',
            EwbNo: 123456789012,
            EwbDt: '11/08/2026 12:30:00',
            EwbValidTill: '12/08/2026 23:59:59',
          },
        }),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    await expect(
      provider.findEwayBillByIrn({
        gstin: baseConfig.gstin,
        irn: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'WHITEBOOKS_EWB_NOT_ACTIVE',
      outcome: 'unknown',
      providerCode: 'CANCELLED',
    });
  });

  it('maps side-effect-free EWB authentication failures to a safe retryable auth failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ status_cd: '0', error_cd: 'AUTH-401' }, 401)),
    );
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    await expect(
      provider.cancelEwayBill({
        gstin: baseConfig.gstin,
        ewbNumber: '123456789012',
        reasonCode: '2',
        remark: 'Order cancelled',
      }),
    ).rejects.toMatchObject({
      code: 'WHITEBOOKS_EWAY_AUTH_FAILED',
      outcome: 'failed',
      providerCode: 'AUTH-401',
      httpStatus: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires explicit active status in EWB evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = inputUrl(input);
      if (url.pathname === '/einvoice/authenticate') {
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: { AuthToken: 'token', UserName: baseConfig.username },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          status_cd: '1',
          data: {
            EwbNo: 123456789012,
            EwbDt: '11/08/2026 12:30:00',
            EwbValidTill: '12/08/2026 23:59:59',
          },
        }),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    await expect(
      provider.findEwayBillByIrn({
        gstin: baseConfig.gstin,
        irn: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({
      code: 'WHITEBOOKS_EWB_STATUS_MISSING',
      outcome: 'unknown',
    });
  });
});
