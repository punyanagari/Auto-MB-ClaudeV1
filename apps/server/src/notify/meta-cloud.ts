/**
 * WhatsApp over the Meta Cloud API (migration 0092).
 *
 * DIRECT TO META BY DEFAULT, and a BSP only if an organisation's channel
 * row says so. Every Business Solution Provider worth using fronts the
 * same Cloud API wire protocol, so the difference between "Meta" and "a
 * BSP" is a base URL and an access token — not a second adapter. The
 * moment a provider is NOT wire-compatible, it needs its own
 * implementation of `WhatsAppTransport`, which is exactly what the seam
 * is for.
 *
 * ## What this class holds and what it never sees
 *
 * It holds the deployment's access token and app secret, from the
 * environment, in memory. It never receives them from a route, never
 * writes them anywhere, and never logs them. It also never decides WHO to
 * message: the recipient reaches it already checked against a consent
 * record, and this class would happily send to anyone it is handed. The
 * rule lives in `send.ts` and in migration 0092's guard, twice, because
 * that is where it belongs.
 */
import type {
  NotificationTransportError as NotificationTransportErrorType,
  TemplatedMessage,
  WhatsAppTarget,
  WhatsAppTransport,
} from './transport.js';
import { NotificationTransportError, verifyMetaSignature } from './transport.js';

type Fetch = typeof fetch;

export interface WhatsAppConfig {
  /** Cloud API access token. A system-user token in production; the
   * 24-hour developer token during onboarding. */
  readonly accessToken: string;
  /** The Meta app secret, used only to verify inbound webhook
   * signatures. Never sent anywhere. */
  readonly appSecret: string;
  /** Echoed back during Meta's webhook subscription handshake. */
  readonly verifyToken: string;
  /** Graph API version, pinned rather than floating: Meta deprecates
   * versions on a schedule, and a silently moving version is a payload
   * shape that changes without a deploy. */
  readonly graphVersion: string;
  readonly timeoutMs: number;
  /** Whether this deployment reaches Meta through a BSP. Recorded on
   * every message row, so history survives a change of route. */
  readonly viaBsp: boolean;
}

const DEFAULT_GRAPH_VERSION = 'v21.0';
const DEFAULT_BASE_URL = 'https://graph.facebook.com';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when WHATSAPP_ENABLED=true`);
  return value;
}

/**
 * The deployment's WhatsApp configuration, or null when it has none.
 *
 * Fail-loud in the same shape as `readWhitebooksConfig`: a half-set block
 * with the flag missing throws rather than silently disabling the
 * channel, because a deployment that believes it is sending and is not is
 * the failure mode a notification product cannot afford.
 */
export function readWhatsAppConfig(env: NodeJS.ProcessEnv): WhatsAppConfig | null {
  const enabled = env.WHATSAPP_ENABLED?.trim().toLowerCase();
  const related = Object.keys(env).some(
    (key) =>
      key.startsWith('WHATSAPP_') &&
      key !== 'WHATSAPP_ENABLED' &&
      (env[key]?.trim() ?? '') !== '',
  );
  if (enabled === 'false') return null;
  if (enabled === undefined || enabled === '') {
    if (related) {
      throw new Error(
        'WHATSAPP_* configuration is present but WHATSAPP_ENABLED is not true',
      );
    }
    return null;
  }
  if (enabled !== 'true') throw new Error('WHATSAPP_ENABLED must be true or false');

  const appSecret = required(env, 'WHATSAPP_APP_SECRET');
  // The app secret is the only thing standing between the public webhook
  // address and a forged delivery receipt, so a short one is refused at
  // boot rather than discovered later. Meta's own secrets are 32 hex
  // characters; this is the same floor AUTH_SECRET holds.
  if (appSecret.length < 32) {
    throw new Error('WHATSAPP_APP_SECRET must be at least 32 characters');
  }
  const graphVersion = env.WHATSAPP_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  if (!/^v\d{1,3}\.\d{1,3}$/.test(graphVersion)) {
    throw new Error('WHATSAPP_GRAPH_VERSION must look like v21.0');
  }
  const timeoutMs = Number(env.WHATSAPP_TIMEOUT_MS ?? '10000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('WHATSAPP_TIMEOUT_MS must be an integer from 1000 to 30000');
  }
  const viaBsp = (env.WHATSAPP_VIA_BSP?.trim().toLowerCase() ?? 'false') === 'true';

  return {
    accessToken: required(env, 'WHATSAPP_ACCESS_TOKEN'),
    appSecret,
    verifyToken: required(env, 'WHATSAPP_VERIFY_TOKEN'),
    graphVersion,
    timeoutMs,
    viaBsp,
  };
}

/** Meta's send response, the only part of it this adapter reads. */
function messageIdOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new NotificationTransportError(
      'malformed_response',
      'The provider answered with something that is not an object.',
    );
  }
  const messages = (payload as { messages?: unknown }).messages;
  const first = Array.isArray(messages) ? (messages[0] as unknown) : undefined;
  const id =
    typeof first === 'object' && first !== null
      ? (first as { id?: unknown }).id
      : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new NotificationTransportError(
      'malformed_response',
      'The provider accepted the message but named no message id, so no delivery receipt could ever be matched to it.',
    );
  }
  return id;
}

/** Meta's error envelope, reduced to a symbolic code and one line. The
 * body is NOT carried through: it echoes the recipient's number back. */
function refusalOf(status: number, payload: unknown): NotificationTransportErrorType {
  const error =
    typeof payload === 'object' && payload !== null
      ? ((payload as { error?: unknown }).error as
          { code?: unknown; message?: unknown; error_data?: unknown } | undefined)
      : undefined;
  const code =
    typeof error?.code === 'number' || typeof error?.code === 'string'
      ? String(error.code)
      : `http_${String(status)}`;
  // Meta's `message` is a short English sentence about the API call
  // ("Template name does not exist in the translation"), not the payload.
  const message =
    typeof error?.message === 'string' ? error.message.slice(0, 500) : null;
  return new NotificationTransportError(code, message, status);
}

export class MetaCloudWhatsAppTransport implements WhatsAppTransport {
  readonly provider: 'meta_cloud' | 'bsp';

  constructor(
    private readonly config: WhatsAppConfig,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.provider = config.viaBsp ? 'bsp' : 'meta_cloud';
  }

  get webhookVerifyToken(): string {
    return this.config.verifyToken;
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
  ): boolean {
    return verifyMetaSignature(this.config.appSecret, rawBody, signatureHeader);
  }

  async send(target: WhatsAppTarget, message: TemplatedMessage): Promise<string> {
    const base = target.apiBaseUrl ?? DEFAULT_BASE_URL;
    const url = `${base.replace(/\/+$/, '')}/${this.config.graphVersion}/${target.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Meta wants the number WITHOUT the leading plus.
      to: message.toAddress.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: message.templateName,
        language: { code: message.language },
        // A template with no parameters must send NO body component at
        // all; an empty parameter array is a 132000 refusal from Meta.
        ...(message.parameters.length === 0
          ? {}
          : {
              components: [
                {
                  type: 'body',
                  parameters: message.parameters.map((text) => ({
                    type: 'text',
                    text,
                  })),
                },
              ],
            }),
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      // Only the errno, never the cause's message: a fetch failure
      // stringifies the URL, and the URL carries the phone number id.
      const code: unknown =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? cause.code
          : undefined;
      throw new NotificationTransportError(
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
          ? code
          : 'unreachable',
        'The provider could not be reached.',
      );
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw refusalOf(response.status, payload);
    return messageIdOf(payload);
  }
}
