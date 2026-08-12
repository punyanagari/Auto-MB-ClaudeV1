import { formatNicDate } from './irp-payload.js';
import {
  exactJsonInteger,
  stringifyStatutoryJson,
} from './statutory-json.js';
import {
  StatutoryProviderError,
  type EwayBillProviderEvidence,
  type IrpDocumentIdentity,
  type IrpRegistrationEvidence,
  type StatutoryEnvironment,
  type StatutoryProvider,
} from './statutory-provider.js';

const BASE_URLS: Record<StatutoryEnvironment, string> = {
  sandbox: 'https://apisandbox.whitebooks.in',
  production: 'https://api.whitebooks.in',
};
const MAX_RESPONSE_BYTES = 1_500_000;
const AUTH_EXPIRY_SKEW_MS = 5 * 60_000;

export interface WhitebooksConfig {
  readonly environment: StatutoryEnvironment;
  readonly email: string;
  readonly username: string;
  readonly password: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Separate E-way Bill API client credentials. Optional unless EWB cancellation is used. */
  readonly ewayClientId: string | null;
  readonly ewayClientSecret: string | null;
  readonly ipAddress: string;
  /** Exact GSTIN authorised by this credential set. */
  readonly gstin: string;
  readonly irp: 'NIC1' | 'NIC2';
  readonly timeoutMs: number;
}

interface AuthEvidence {
  readonly token: string;
  readonly username: string;
  readonly expiresAt: number;
}

interface EwayAuthEvidence {
  readonly expiresAt: number;
}

type Fetch = typeof fetch;
type JsonObject = Record<string, unknown>;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when WHITEBOOKS_ENABLED=true`);
  return value;
}

export function readWhitebooksConfig(
  env: NodeJS.ProcessEnv,
): WhitebooksConfig | null {
  const enabled = env.WHITEBOOKS_ENABLED?.trim().toLowerCase();
  const related = Object.keys(env).some(
    (key) =>
      key.startsWith('WHITEBOOKS_') &&
      key !== 'WHITEBOOKS_ENABLED' &&
      (env[key]?.trim() ?? '') !== '',
  );
  if (enabled === 'false') return null;
  if (enabled === undefined || enabled === '') {
    if (related) {
      throw new Error(
        'WHITEBOOKS_* configuration is present but WHITEBOOKS_ENABLED is not true',
      );
    }
    return null;
  }
  if (enabled !== 'true') throw new Error('WHITEBOOKS_ENABLED must be true or false');
  const environment = required(env, 'WHITEBOOKS_ENVIRONMENT');
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('WHITEBOOKS_ENVIRONMENT must be sandbox or production');
  }
  const irp = env.WHITEBOOKS_IRP?.trim() || 'NIC1';
  if (irp !== 'NIC1' && irp !== 'NIC2') {
    throw new Error('WHITEBOOKS_IRP must be NIC1 or NIC2');
  }
  const timeoutMs = Number(env.WHITEBOOKS_TIMEOUT_MS ?? '10000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('WHITEBOOKS_TIMEOUT_MS must be an integer from 1000 to 30000');
  }
  const gstin = required(env, 'WHITEBOOKS_GSTIN').toUpperCase();
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(gstin)) {
    throw new Error('WHITEBOOKS_GSTIN must be a valid 15-character GSTIN');
  }
  const ewayClientId = env.WHITEBOOKS_EWAY_CLIENT_ID?.trim() || null;
  const ewayClientSecret = env.WHITEBOOKS_EWAY_CLIENT_SECRET?.trim() || null;
  if ((ewayClientId === null) !== (ewayClientSecret === null)) {
    throw new Error(
      'WHITEBOOKS_EWAY_CLIENT_ID and WHITEBOOKS_EWAY_CLIENT_SECRET must be set together',
    );
  }
  return {
    environment,
    email: required(env, 'WHITEBOOKS_EMAIL'),
    username: required(env, 'WHITEBOOKS_USERNAME'),
    password: required(env, 'WHITEBOOKS_PASSWORD'),
    clientId: required(env, 'WHITEBOOKS_CLIENT_ID'),
    clientSecret: required(env, 'WHITEBOOKS_CLIENT_SECRET'),
    ewayClientId,
    ewayClientSecret,
    ipAddress: required(env, 'WHITEBOOKS_IP_ADDRESS'),
    gstin,
    irp,
    timeoutMs,
  };
}

async function boundedResponseText(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let total = 0;
  let output = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw new StatutoryProviderError(
        'WHITEBOOKS_RESPONSE_TOO_LARGE',
        'unknown',
        null,
        response.status,
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function decodeJson(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return current;
    try {
      current = JSON.parse(trimmed) as unknown;
    } catch {
      return current;
    }
  }
  return current;
}

function valueByKey(value: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 5) return undefined;
  const decoded = decodeJson(value);
  const row = object(decoded);
  if (row) {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    for (const [key, entry] of Object.entries(row)) {
      if (wanted.has(key.toLowerCase())) return entry;
    }
    for (const entry of Object.values(row)) {
      const nested = valueByKey(entry, names, depth + 1);
      if (nested !== undefined) return nested;
    }
  } else if (Array.isArray(decoded)) {
    for (const entry of decoded) {
      const nested = valueByKey(entry, names, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function textValue(value: unknown, names: readonly string[]): string | null {
  const found = valueByKey(value, names);
  if (typeof found === 'string' && found.trim() !== '') return found.trim();
  if (typeof found === 'number' && Number.isSafeInteger(found)) return String(found);
  return null;
}

function exactNumericField(
  rawTexts: readonly string[],
  parsed: unknown,
  names: readonly string[],
): string | null {
  const atBoundary = (raw: string, offset: number): boolean => {
    let cursor = offset;
    while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
    return raw[cursor] === ',' || raw[cursor] === '}';
  };

  const afterKey = (
    raw: string,
    offset: number,
    escapedQuotes: boolean,
  ): string | null => {
    let cursor = offset;
    while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] !== ':') return null;
    cursor += 1;
    while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;

    const quote = escapedQuotes ? '\\"' : '"';
    const quoted = raw.startsWith(quote, cursor);
    if (quoted) cursor += quote.length;
    const start = cursor;
    for (;;) {
      const character = raw[cursor];
      if (character === undefined || character < '0' || character > '9') break;
      cursor += 1;
    }
    if (cursor === start) return null;
    const digits = raw.slice(start, cursor);
    if (quoted) {
      if (!raw.startsWith(quote, cursor)) return null;
      cursor += quote.length;
    }
    return atBoundary(raw, cursor) ? digits : null;
  };

  for (const raw of rawTexts) {
    for (const name of names) {
      for (const [key, escapedQuotes] of [
        [`"${name}"`, false],
        [`\\"${name}\\"`, true],
      ] as const) {
        let offset = raw.indexOf(key);
        while (offset !== -1) {
          const digits = afterKey(raw, offset + key.length, escapedQuotes);
          if (digits !== null) return digits;
          offset = raw.indexOf(key, offset + key.length);
        }
      }
    }
  }
  return textValue(parsed, names);
}

function statusSucceeded(value: unknown): boolean {
  const status = textValue(value, ['status_cd', 'statusCd', 'status']);
  return status !== null && ['1', 'success', 'succeeded'].includes(status.toLowerCase());
}

function providerCode(value: unknown): string | null {
  const code =
    textValue(value, ['error_cd', 'errorCode', 'error_code', 'code']) ??
    textValue(value, ['status_cd']);
  return code === null ? null : code.slice(0, 120);
}

function validatedInstant(
  rawParts: readonly string[],
  offsetMinutes: number,
  field: string,
): string {
  const parts = rawParts.map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) {
    throw new StatutoryProviderError(
      `WHITEBOOKS_${field.toUpperCase()}_INVALID`,
      'unknown',
    );
  }
  const [year, month, day, hour, minute, second] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const localUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(localUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    throw new StatutoryProviderError(
      `WHITEBOOKS_${field.toUpperCase()}_INVALID`,
      'unknown',
    );
  }
  return new Date(localUtc - offsetMinutes * 60_000).toISOString();
}

function indiaInstant(raw: string, field: string): string {
  const offsetIso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})([zZ]|([+-])(\d{2}):(\d{2}))$/.exec(
      raw,
    );
  if (offsetIso) {
    const offset =
      offsetIso[7]?.toLowerCase() === 'z'
        ? 0
        : (offsetIso[8] === '-' ? -1 : 1) *
          (Number(offsetIso[9]) * 60 + Number(offsetIso[10]));
    if (Math.abs(offset) > 14 * 60) {
      throw new StatutoryProviderError(
        `WHITEBOOKS_${field.toUpperCase()}_INVALID`,
        'unknown',
      );
    }
    return validatedInstant(offsetIso.slice(1, 7), offset, field);
  }
  const ymd =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  const dmy =
    /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  const parts = ymd
    ? [ymd[1], ymd[2], ymd[3], ymd[4], ymd[5], ymd[6]]
    : dmy
      ? [dmy[3], dmy[2], dmy[1], dmy[4], dmy[5], dmy[6]]
      : null;
  if (!parts?.every((part) => part !== undefined)) {
    throw new StatutoryProviderError(
      `WHITEBOOKS_${field.toUpperCase()}_INVALID`,
      'unknown',
    );
  }
  return validatedInstant(parts, 330, field);
}

function boundedText(value: string | null, code: string, max: number): string {
  if (value === null || value.length > max) {
    throw new StatutoryProviderError(code, 'unknown');
  }
  return value;
}

function normaliseIrp(rawTexts: readonly string[], value: unknown): IrpRegistrationEvidence {
  const irn = boundedText(textValue(value, ['Irn', 'irn']), 'WHITEBOOKS_IRN_MISSING', 64);
  if (!/^[0-9a-f]{64}$/i.test(irn)) {
    throw new StatutoryProviderError('WHITEBOOKS_IRN_INVALID', 'unknown');
  }
  const ackNumber = boundedText(
    exactNumericField(rawTexts, value, ['AckNo', 'ackNumber']),
    'WHITEBOOKS_ACK_NUMBER_MISSING',
    100,
  );
  const ackDateText = boundedText(
    textValue(value, ['AckDt', 'ackDate']),
    'WHITEBOOKS_ACK_DATE_MISSING',
    100,
  );
  return {
    irn: irn.toLowerCase(),
    ackNumber,
    ackDateText,
    ackDate: indiaInstant(ackDateText, 'ack_date'),
    signedQr: boundedText(
      textValue(value, ['SignedQRCode', 'SignedQrCode', 'signedQr']),
      'WHITEBOOKS_SIGNED_QR_MISSING',
      65536,
    ),
    signedInvoice: boundedText(
      textValue(value, ['SignedInvoice', 'signedInvoice']),
      'WHITEBOOKS_SIGNED_INVOICE_MISSING',
      1048576,
    ),
  };
}

function normaliseEway(
  rawTexts: readonly string[],
  value: unknown,
): EwayBillProviderEvidence {
  const providerStatus = textValue(value, ['Status']);
  if (providerStatus === null) {
    throw new StatutoryProviderError(
      'WHITEBOOKS_EWB_STATUS_MISSING',
      'unknown',
    );
  }
  if (providerStatus.toUpperCase() !== 'ACT') {
    throw new StatutoryProviderError(
      'WHITEBOOKS_EWB_NOT_ACTIVE',
      'unknown',
      providerStatus.slice(0, 120),
    );
  }
  const ewbNumber = boundedText(
    exactNumericField(rawTexts, value, ['EwbNo', 'ewayBillNo', 'ewbNumber']),
    'WHITEBOOKS_EWB_NUMBER_MISSING',
    12,
  );
  if (!/^[0-9]{12}$/.test(ewbNumber)) {
    throw new StatutoryProviderError('WHITEBOOKS_EWB_NUMBER_INVALID', 'unknown');
  }
  const ewbDateText = boundedText(
    textValue(value, ['EwbDt', 'ewayBillDate', 'ewbDate']),
    'WHITEBOOKS_EWB_DATE_MISSING',
    100,
  );
  const validUntilText = boundedText(
    textValue(value, ['EwbValidTill', 'validUpto', 'validUntil']),
    'WHITEBOOKS_EWB_VALIDITY_MISSING',
    100,
  );
  return {
    ewbNumber,
    ewbDateText,
    ewbDate: indiaInstant(ewbDateText, 'ewb_date'),
    validUntilText,
    validUntil: indiaInstant(validUntilText, 'ewb_validity'),
  };
}

export class WhitebooksProvider implements StatutoryProvider {
  readonly name = 'whitebooks' as const;
  readonly environment: StatutoryEnvironment;
  readonly #baseUrl: string;
  readonly #auth = new Map<string, AuthEvidence>();
  readonly #authPending = new Map<string, Promise<AuthEvidence>>();
  readonly #ewayAuth = new Map<string, EwayAuthEvidence>();
  readonly #ewayAuthPending = new Map<string, Promise<EwayAuthEvidence>>();

  constructor(
    private readonly config: WhitebooksConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.environment = config.environment;
    this.#baseUrl = BASE_URLS[config.environment];
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    options: {
      readonly query?: Readonly<Record<string, string>>;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly mutation: boolean;
      readonly notFoundIsNull?: boolean;
    },
  ): Promise<{ readonly parsed: unknown; readonly rawTexts: readonly string[] } | null> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    let raw: string;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
        redirect: 'error',
      });
      raw = await boundedResponseText(response, controller);
    } catch (error) {
      if (error instanceof StatutoryProviderError) throw error;
      throw new StatutoryProviderError('WHITEBOOKS_NETWORK_UNKNOWN', 'unknown');
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new StatutoryProviderError(
        'WHITEBOOKS_RESPONSE_INVALID',
        'unknown',
        null,
        response.status,
      );
    }
    const data = decodeJson(valueByKey(parsed, ['data'])) ?? parsed;
    const dataRaw = typeof valueByKey(parsed, ['data']) === 'string'
      ? (valueByKey(parsed, ['data']) as string)
      : '';
    const rawTexts = dataRaw === '' ? [raw] : [raw, dataRaw];
    // A generic status_cd=0 is also used for authentication and validation
    // failures. Only an actual HTTP 404 is safe to call "not found"; every
    // other negative lookup is inconclusive and must never unlock a repeat
    // GENERATE mutation.
    if (options.notFoundIsNull && response.status === 404) return null;
    if (!response.ok || !statusSucceeded(parsed)) {
      const uncertain = response.status === 429 || response.status >= 500;
      throw new StatutoryProviderError(
        options.mutation && uncertain
          ? 'WHITEBOOKS_MUTATION_UNKNOWN'
          : 'WHITEBOOKS_REJECTED',
        uncertain ? 'unknown' : 'failed',
        providerCode(parsed),
        response.status,
      );
    }
    return { parsed: data, rawTexts };
  }

  #commonHeaders(gstin: string): Record<string, string> {
    if (gstin !== this.config.gstin) {
      throw new StatutoryProviderError(
        'WHITEBOOKS_GSTIN_NOT_AUTHORISED',
        'failed',
      );
    }
    return {
      ip_address: this.config.ipAddress,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      gstin,
    };
  }

  #ewayCommonHeaders(gstin: string): Record<string, string> {
    if (gstin !== this.config.gstin) {
      throw new StatutoryProviderError(
        'WHITEBOOKS_GSTIN_NOT_AUTHORISED',
        'failed',
      );
    }
    if (
      this.config.ewayClientId === null ||
      this.config.ewayClientSecret === null
    ) {
      throw new StatutoryProviderError(
        'WHITEBOOKS_EWAY_CANCELLATION_NOT_CONFIGURED',
        'failed',
      );
    }
    return {
      ip_address: this.config.ipAddress,
      client_id: this.config.ewayClientId,
      client_secret: this.config.ewayClientSecret,
      gstin,
    };
  }

  async #authenticate(gstin: string): Promise<AuthEvidence> {
    const cached = this.#auth.get(gstin);
    if (cached && cached.expiresAt - AUTH_EXPIRY_SKEW_MS > this.now()) return cached;
    const pending = this.#authPending.get(gstin);
    if (pending) return pending;
    // Validate the configured GSTIN before translating remote auth errors.
    // Authentication is side-effect-free: a timeout here proves the later
    // statutory mutation was never sent, so callers may safely retry.
    const headers = {
      ...this.#commonHeaders(gstin),
      username: this.config.username,
      password: this.config.password,
    };
    const request = (async () => {
      try {
        const result = await this.#request('GET', '/einvoice/authenticate', {
          query: { email: this.config.email },
          headers,
          mutation: false,
        });
        if (!result) {
          throw new StatutoryProviderError('WHITEBOOKS_AUTH_FAILED', 'failed');
        }
        const token = boundedText(
          textValue(result.parsed, ['AuthToken', 'auth-token', 'token']),
          'WHITEBOOKS_AUTH_TOKEN_MISSING',
          8192,
        );
        const username =
          textValue(result.parsed, ['UserName', 'username']) ?? this.config.username;
        const ttl = this.environment === 'sandbox' ? 60 * 60_000 : 6 * 60 * 60_000;
        const evidence = { token, username, expiresAt: this.now() + ttl };
        this.#auth.set(gstin, evidence);
        return evidence;
      } catch (error) {
        if (error instanceof StatutoryProviderError) {
          throw new StatutoryProviderError(
            'WHITEBOOKS_AUTH_FAILED',
            'failed',
            error.providerCode,
            error.httpStatus,
          );
        }
        throw error;
      }
    })();
    this.#authPending.set(gstin, request);
    try {
      return await request;
    } finally {
      this.#authPending.delete(gstin);
    }
  }

  async #authenticateEway(gstin: string): Promise<EwayAuthEvidence> {
    const cached = this.#ewayAuth.get(gstin);
    if (cached && cached.expiresAt - AUTH_EXPIRY_SKEW_MS > this.now()) return cached;
    const pending = this.#ewayAuthPending.get(gstin);
    if (pending) return pending;
    // Validate local credentials/GSTIN before translating remote auth
    // failures. These two configuration errors must remain distinguishable.
    const headers = this.#ewayCommonHeaders(gstin);
    const request = (async () => {
      try {
        const result = await this.#request(
          'GET',
          '/ewaybillapi/v1.03/authenticate',
          {
            query: {
              email: this.config.email,
              username: this.config.username,
              password: this.config.password,
              irp: this.config.irp,
            },
            headers,
            mutation: false,
          },
        );
        if (!result) {
          throw new StatutoryProviderError(
            'WHITEBOOKS_EWAY_AUTH_FAILED',
            'failed',
          );
        }
      } catch (error) {
        if (error instanceof StatutoryProviderError) {
          throw new StatutoryProviderError(
            'WHITEBOOKS_EWAY_AUTH_FAILED',
            'failed',
            error.providerCode,
            error.httpStatus,
          );
        }
        throw error;
      }
      const evidence = { expiresAt: this.now() + 60 * 60_000 };
      this.#ewayAuth.set(gstin, evidence);
      return evidence;
    })();
    this.#ewayAuthPending.set(gstin, request);
    try {
      return await request;
    } finally {
      this.#ewayAuthPending.delete(gstin);
    }
  }

  async #irpHeaders(gstin: string): Promise<Record<string, string>> {
    const auth = await this.#authenticate(gstin);
    return {
      ...this.#commonHeaders(gstin),
      username: auth.username,
      'auth-token': auth.token,
    };
  }

  async registerInvoice(
    identity: IrpDocumentIdentity,
    payloadJson: string,
  ): Promise<IrpRegistrationEvidence> {
    this.#assertIrpPayloadIdentity(identity, payloadJson);
    const result = await this.#request(
      'POST',
      '/einvoice/type/GENERATE/version/V1_03',
      {
        query: { email: this.config.email, irp: this.config.irp },
        headers: await this.#irpHeaders(identity.gstin),
        body: payloadJson,
        mutation: true,
      },
    );
    if (!result) throw new StatutoryProviderError('WHITEBOOKS_IRP_EMPTY', 'unknown');
    return normaliseIrp(result.rawTexts, result.parsed);
  }

  async findInvoiceByDocument(
    identity: IrpDocumentIdentity,
  ): Promise<IrpRegistrationEvidence | null> {
    const result = await this.#request(
      'GET',
      '/einvoice/type/GETIRNBYDOCDETAILS/version/V1_03',
      {
        query: { param1: 'INV', email: this.config.email, irp: this.config.irp },
        headers: {
          ...(await this.#irpHeaders(identity.gstin)),
          docnum: identity.documentNumber,
          docdate: formatNicDate(identity.documentDate),
        },
        mutation: false,
        notFoundIsNull: true,
      },
    );
    return result === null ? null : normaliseIrp(result.rawTexts, result.parsed);
  }

  async cancelInvoice(input: {
    readonly gstin: string;
    readonly irn: string;
    readonly reasonCode: string;
    readonly remark: string;
  }): Promise<{ readonly cancelledAtText: string; readonly cancelledAt: string }> {
    const result = await this.#request('POST', '/einvoice/type/CANCEL/version/V1_03', {
      query: { email: this.config.email, irp: this.config.irp },
      headers: await this.#irpHeaders(input.gstin),
      body: JSON.stringify({
        Irn: input.irn,
        CnlRsn: input.reasonCode,
        CnlRem: input.remark,
      }),
      mutation: true,
    });
    if (!result) throw new StatutoryProviderError('WHITEBOOKS_CANCEL_EMPTY', 'unknown');
    const cancelledAtText = boundedText(
      textValue(result.parsed, ['CancelDate', 'cancelDate', 'CnlDt']),
      'WHITEBOOKS_CANCEL_DATE_MISSING',
      100,
    );
    return {
      cancelledAtText,
      cancelledAt: indiaInstant(cancelledAtText, 'cancel_date'),
    };
  }

  async generateEwayBillByIrn(input: {
    readonly gstin: string;
    readonly irn: string;
    readonly payloadJson: string;
  }): Promise<EwayBillProviderEvidence> {
    this.#assertEwayPayloadIdentity(input.irn, input.payloadJson);
    const result = await this.#request(
      'POST',
      '/einvoice/type/GENERATE_EWAYBILL/version/V1_03',
      {
        query: { email: this.config.email, irp: this.config.irp },
        headers: await this.#irpHeaders(input.gstin),
        body: input.payloadJson,
        mutation: true,
      },
    );
    if (!result) throw new StatutoryProviderError('WHITEBOOKS_EWB_EMPTY', 'unknown');
    return normaliseEway(result.rawTexts, result.parsed);
  }

  async findEwayBillByIrn(input: {
    readonly gstin: string;
    readonly irn: string;
  }): Promise<EwayBillProviderEvidence | null> {
    const result = await this.#request(
      'GET',
      '/einvoice/type/GETEWAYBILLIRN/version/V1_03',
      {
        query: {
          param1: input.irn,
          email: this.config.email,
          irp: this.config.irp,
        },
        headers: await this.#irpHeaders(input.gstin),
        mutation: false,
        notFoundIsNull: true,
      },
    );
    return result === null ? null : normaliseEway(result.rawTexts, result.parsed);
  }

  async cancelEwayBill(input: {
    readonly gstin: string;
    readonly ewbNumber: string;
    readonly reasonCode: string;
    readonly remark: string;
  }): Promise<{ readonly cancelledAtText: string; readonly cancelledAt: string }> {
    await this.#authenticateEway(input.gstin);
    const result = await this.#request(
      'POST',
      '/ewaybillapi/v1.03/ewayapi/canewb',
      {
        query: { email: this.config.email, irp: this.config.irp },
        headers: this.#ewayCommonHeaders(input.gstin),
        body: stringifyStatutoryJson({
          ewbNo: exactJsonInteger(input.ewbNumber),
          cancelRsnCode: exactJsonInteger(input.reasonCode),
          cancelRmrk: input.remark,
        }),
        mutation: true,
      },
    );
    if (!result) throw new StatutoryProviderError('WHITEBOOKS_EWB_CANCEL_EMPTY', 'unknown');
    const cancelledAtText = boundedText(
      textValue(result.parsed, ['cancelDate', 'CancelDate']),
      'WHITEBOOKS_EWB_CANCEL_DATE_MISSING',
      100,
    );
    return {
      cancelledAtText,
      cancelledAt: indiaInstant(cancelledAtText, 'cancel_date'),
    };
  }

  #assertIrpPayloadIdentity(
    identity: IrpDocumentIdentity,
    payloadJson: string,
  ): void {
    let payload: JsonObject | null = null;
    try {
      payload = object(JSON.parse(payloadJson) as unknown);
    } catch {
      // handled below as a stable internal/provider-boundary refusal
    }
    const seller = object(payload?.SellerDtls);
    const document = object(payload?.DocDtls);
    if (
      seller?.Gstin !== identity.gstin ||
      document?.No !== identity.documentNumber ||
      document?.Dt !== formatNicDate(identity.documentDate)
    ) {
      throw new StatutoryProviderError(
        'WHITEBOOKS_IRP_PAYLOAD_IDENTITY_MISMATCH',
        'failed',
      );
    }
  }

  #assertEwayPayloadIdentity(irn: string, payloadJson: string): void {
    let payload: JsonObject | null = null;
    try {
      payload = object(JSON.parse(payloadJson) as unknown);
    } catch {
      // handled below
    }
    if (payload?.Irn !== irn) {
      throw new StatutoryProviderError(
        'WHITEBOOKS_EWB_PAYLOAD_IDENTITY_MISMATCH',
        'failed',
      );
    }
  }
}
