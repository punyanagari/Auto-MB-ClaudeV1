import { describe, expect, it, vi } from 'vitest';
import { deriveIrn } from '../src/gsp/irn.js';
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

  /**
   * The IRN the NIC portal actually issues for this identity. Since audit
   * finding 2 the adapter derives it locally and refuses anything else, so
   * a fixture can no longer be an arbitrary 64-character string.
   */
  const derivedIrn = deriveIrn(identity);

  /**
   * A signed QR in the real shape: JWS compact serialization whose payload
   * carries a `data` member that is itself a JSON string of the document
   * facts. The signature segment is a placeholder — the adapter checks the
   * QR's CLAIMS against the document, deliberately not its signature (no
   * NIC certificate is provisioned; see gsp/irn.ts).
   */
  function signedQr(
    overrides: Partial<
      Record<'Irn' | 'SellerGstin' | 'DocNo' | 'DocTyp' | 'DocDt', string>
    > = {},
  ): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
      'utf8',
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        data: JSON.stringify({
          SellerGstin: baseConfig.gstin,
          DocNo: identity.documentNumber,
          DocTyp: 'INV',
          DocDt: '12/08/2026',
          Irn: derivedIrn,
          ...overrides,
        }),
      }),
      'utf8',
    ).toString('base64url');
    return `${header}.${payload}.c2lnbmF0dXJlLXBsYWNlaG9sZGVy`;
  }

  it('authenticates, sends exact registration bytes, and preserves a large acknowledgement number', async () => {
    const ackNumber = '9007199254740993123';
    const qr = signedQr();
    const body = `{"status_cd":"1","data":{"Irn":"${derivedIrn.toUpperCase()}","AckNo":${ackNumber},"AckDt":"12/08/2026 14:30:00","SignedQRCode":"${qr}","SignedInvoice":"signed-invoice"}}`;
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
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    const provider = new WhitebooksProvider(baseConfig, fetchImpl);

    await expect(provider.registerInvoice(identity, payloadJson)).resolves.toEqual({
      irn: derivedIrn,
      ackNumber,
      ackDateText: '12/08/2026 14:30:00',
      ackDate: '2026-08-12T09:00:00.000Z',
      signedQr: qr,
      signedInvoice: 'signed-invoice',
      // The full response body verbatim, for the 0053 evidence ledger.
      rawResponse: body,
      // Which portal answered (audit finding 2), recorded on every
      // operation ledger row so a later dispute knows whose records to ask
      // for.
      portal: 'NIC1 via apisandbox.whitebooks.in',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  /**
   * Audit finding 2 residue: the evidence is now CHECKED, not merely
   * retained. The IRN is the SHA-256 of the supplier GSTIN, document type,
   * number and financial year, so an IRN for a different document does not
   * reproduce — and the adapter refuses it rather than writing it onto a
   * legal record as the government's identifier.
   */
  describe('local verification of registration evidence', () => {
    function respondWith(irn: string, qr: string): typeof fetch {
      return vi.fn<typeof fetch>((input) => {
        if (inputUrl(input).pathname === '/einvoice/authenticate') {
          return Promise.resolve(
            jsonResponse({
              status_cd: '1',
              data: { AuthToken: 'irp-auth-token', UserName: baseConfig.username },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            status_cd: '1',
            data: {
              Irn: irn,
              AckNo: '112010099001',
              AckDt: '12/08/2026 14:30:00',
              SignedQRCode: qr,
              SignedInvoice: 'signed-invoice',
            },
          }),
        );
      });
    }

    it('refuses a registration IRN that does not derive from the document, as unknown', async () => {
      const foreign = 'ab12'.repeat(16);
      expect(foreign).not.toBe(derivedIrn);
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(foreign, signedQr({ Irn: foreign })),
      );

      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        code: 'WHITEBOOKS_IRP_IRN_DERIVATION_MISMATCH',
        // GENERATE already mutated. We will not adopt the answer, but we
        // cannot claim the document was NOT registered — 'unknown' leaves
        // the invoice reconcilable rather than falsely failed.
        outcome: 'unknown',
      });
    });

    it('refuses the same mismatch from a LOOKUP as failed, because nothing was mutated', async () => {
      const foreign = 'cd34'.repeat(16);
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(foreign, signedQr({ Irn: foreign })),
      );

      await expect(provider.findInvoiceByDocument(identity)).rejects.toMatchObject({
        code: 'WHITEBOOKS_IRP_IRN_DERIVATION_MISMATCH',
        outcome: 'failed',
      });
    });

    it('refuses a signed QR naming a different IRN from the response', async () => {
      // Internal incoherence: the top-level IRN derives correctly, but the
      // portal's own signed statement is about something else. Neither
      // half can be trusted, so the response is not evidence.
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(derivedIrn, signedQr({ Irn: 'ef56'.repeat(16) })),
      );

      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        code: 'WHITEBOOKS_IRP_SIGNED_QR_IRN_MISMATCH',
      });
    });

    it('refuses a signed QR naming a different document', async () => {
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(derivedIrn, signedQr({ DocNo: 'INV/2026/999' })),
      );

      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        code: 'WHITEBOOKS_IRP_SIGNED_QR_IDENTITY_MISMATCH',
      });
    });

    it('refuses a signed QR that is not a readable JWS', async () => {
      // The IRP always returns one. Accepting an unreadable value would
      // reopen exactly the hole this closes: evidence nobody can check.
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(derivedIrn, 'not-a-jws'),
      );

      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        code: 'WHITEBOOKS_IRP_SIGNED_QR_UNREADABLE',
      });
    });

    it('carries the refused body with the refusal, for the evidence ledger', async () => {
      const foreign = 'ab12'.repeat(16);
      const provider = new WhitebooksProvider(
        baseConfig,
        respondWith(foreign, signedQr({ Irn: foreign })),
      );

      // Evidence we refuse is exactly the evidence an operator needs whole.
      await expect(
        provider.registerInvoice(identity, payloadJson),
      ).rejects.toMatchObject({
        rawResponse: expect.stringContaining(foreign) as unknown as string,
      });
    });
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
      rawResponse: JSON.stringify({
        status_cd: '1',
        data: { CancelDate: '12/08/2026 15:00:00' },
      }),
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
