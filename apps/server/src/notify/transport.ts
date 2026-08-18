/**
 * The notification transport seam (migration 0092).
 *
 * The pattern is `gsp/statutory-provider.ts`, deliberately and for the
 * same reason. That module is types only — an interface, an error class,
 * no implementation and no registry — and the concrete adapter is handed
 * to `buildApp` by `main.ts` after reading the environment. Tests pass a
 * double instead. Credentials live inside the injected adapter and are
 * never accepted by an HTTP route, never persisted, and never in a tenant
 * table.
 *
 * Here that seam is load-bearing rather than merely tidy: the WhatsApp
 * Business account this product will send through was still in Meta's
 * onboarding when the pack landed. Everything below the transport — the
 * schema, the consent rule, the template lifecycle, the delivery log and
 * the screens — is provable today against a double, and the day the WABA
 * is approved the only new thing in the deployment is an environment
 * block.
 *
 * ## Two interfaces, not one
 *
 * A single interface covering both channels would have to take an
 * untyped target: WhatsApp addresses a phone number id at a Graph
 * endpoint, email addresses a relay with a sender header, and the two
 * have no field in common worth abstracting. What IS shared is the thing
 * callers care about — `TemplatedMessage`, which is a template, a
 * language and the ordered values that fill it — and `send`, which
 * answers with the provider's own message id or throws.
 *
 * Only the WhatsApp side verifies webhooks, because only Meta sends any.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type NotificationProvider = 'meta_cloud' | 'bsp' | 'smtp';

/**
 * A provider refused, or could not be reached.
 *
 * `providerCode` is a SHORT SYMBOLIC value and nothing else — Meta's
 * numeric error code, or an errno such as ECONNREFUSED. The raw response
 * body is deliberately absent from this class, unlike the statutory
 * provider's evidence ledger, because a WhatsApp error payload echoes the
 * recipient's telephone number back and this value is stored on the
 * delivery log and exported (AGENTS.md rule 11).
 */
export class NotificationTransportError extends Error {
  constructor(
    readonly providerCode: string,
    /** One short line an operator can act on. Never a raw payload. */
    readonly detail: string | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(providerCode);
    this.name = 'NotificationTransportError';
  }
}

/** Where one organisation's WhatsApp messages leave from. Identity, not
 * credentials: the access token is the adapter's, not this row's. */
export interface WhatsAppTarget {
  readonly phoneNumberId: string;
  /** Null means Meta Cloud API direct, which is the default. */
  readonly apiBaseUrl: string | null;
}

/** Where one organisation's mail leaves from. The relay itself is the
 * deployment's (SMTP_URL); only the sender is per organisation. */
export interface EmailTarget {
  readonly fromAddress: string;
  readonly replyToAddress: string | null;
}

/**
 * One message, already resolved to a recipient and a body.
 *
 * Both channels get both `parameters` and `bodyText`. WhatsApp sends the
 * template name and the ordered parameters and lets Meta render from the
 * text IT approved; email has no such registry, so the adapter renders
 * `bodyText` itself. Handing both to both adapters is what keeps the
 * caller from having to know which one it is talking to.
 */
export interface TemplatedMessage {
  readonly toAddress: string;
  readonly templateName: string;
  readonly language: string;
  readonly parameters: readonly string[];
  readonly bodyText: string;
  /** Email only; a WhatsApp template has no subject line. */
  readonly subject: string | null;
}

export interface WhatsAppTransport {
  readonly provider: 'meta_cloud' | 'bsp';
  /** Answers with the provider's own message id (Meta calls it a
   * `wamid`), which is what every later delivery receipt names. */
  send(target: WhatsAppTarget, message: TemplatedMessage): Promise<string>;
  /**
   * Whether this webhook body really came from Meta.
   *
   * Fail-closed by construction: it takes the RAW request body, because
   * the signature is over the exact bytes and a re-serialised object is
   * not those bytes, and it answers false for a missing header, a
   * malformed one or a wrong digest alike. There is no "unverified but
   * probably fine" branch.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  /** The value Meta echoes during the webhook subscription handshake. */
  readonly webhookVerifyToken: string;
}

export interface EmailTransport {
  readonly provider: 'smtp';
  send(target: EmailTarget, message: TemplatedMessage): Promise<string>;
}

/** What the deployment can actually send through. Either half may be
 * absent, and the routes say so by name rather than failing at the
 * provider call. */
export interface NotificationTransports {
  readonly whatsapp?: WhatsAppTransport;
  readonly email?: EmailTransport;
}

/**
 * Fills a template body's ordered `{{1}}`..`{{n}}` placeholders.
 *
 * Meta's own placeholder syntax, used for the email rendering too so that
 * one template body serves both channels and an operator does not
 * maintain two texts that can disagree. A placeholder with no value is
 * left standing rather than blanked: an email reading `{{2}}` is a
 * visible bug, and one reading nothing at all is a sentence that lost a
 * word without saying so.
 */
export function renderTemplateBody(
  bodyText: string,
  parameters: readonly string[],
): string {
  return bodyText.replace(/\{\{(\d{1,2})\}\}/g, (placeholder, index: string) => {
    const value = parameters[Number(index) - 1];
    return value ?? placeholder;
  });
}

/**
 * Meta's `X-Hub-Signature-256`, checked in constant time.
 *
 * Shared rather than inlined in the adapter because the webhook route
 * must be provably fail-closed and that proof is a unit test over this
 * function, not an integration test that has to stand up a transport.
 */
export function verifyMetaSignature(
  appSecret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  // Both are 64 lowercase hex characters by the test above, so the
  // lengths always match and timingSafeEqual cannot throw.
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}
