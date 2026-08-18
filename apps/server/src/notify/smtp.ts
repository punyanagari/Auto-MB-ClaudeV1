/**
 * Notification email over SMTP (migration 0092).
 *
 * SMTP, NOT AN SES SDK, and that is a decision rather than an omission.
 * Amazon SES offers an SMTP endpoint that speaks the same protocol as
 * every relay an executing agency already runs, so an SES deployment sets
 * `SMTP_URL` to that endpoint and nothing else changes. Taking the AWS
 * SDK instead would add a cloud dependency, a credential shape and a
 * region to a product that deploys as a self-hosted compose stack beside
 * whatever mail the office already has.
 *
 * IT IS THE SAME RELAY THE PASSWORD-RECOVERY PATH USES
 * (`apps/server/src/auth.ts`), read from the same `SMTP_URL`. One relay
 * per deployment; the SENDER is per organisation, and comes from that
 * organisation's own channel row rather than from `MAIL_FROM` — a
 * contractor's counterparty should see the contractor's address, not the
 * platform's.
 */
import { createTransport, type Transporter } from 'nodemailer';
import { fallbackMessageId } from './send.js';
import type { EmailTarget, EmailTransport, TemplatedMessage } from './transport.js';
import { NotificationTransportError, renderTemplateBody } from './transport.js';

/**
 * How long a relay gets, at each of the three stages nodemailer can hang
 * at. Bounded at all because of the shape of the send path rather than
 * out of politeness: the delivery-log row is committed `queued` before
 * this call and completed after it, so a relay that accepts a TCP
 * connection and then says nothing holds that row open for as long as the
 * socket lives. Node's own default is no timeout whatsoever.
 */
const RELAY_TIMEOUT_MS = 10_000;

/** The relay this deployment sends notification mail through, or null
 * when it has none. `SMTP_URL` is the whole connection, credentials
 * included, exactly as nodemailer parses it for password recovery. */
export function readNotificationMailUrl(env: NodeJS.ProcessEnv): string | null {
  const url = env.SMTP_URL?.trim() ?? '';
  return url === '' ? null : url;
}

export class SmtpEmailTransport implements EmailTransport {
  readonly provider = 'smtp' as const;

  private readonly transporter: Transporter;

  constructor(smtpUrl: string, transporter?: Transporter) {
    this.transporter =
      transporter ??
      createTransport(smtpUrl, {
        connectionTimeout: RELAY_TIMEOUT_MS,
        greetingTimeout: RELAY_TIMEOUT_MS,
        socketTimeout: RELAY_TIMEOUT_MS,
      });
  }

  async send(target: EmailTarget, message: TemplatedMessage): Promise<string> {
    // Plain text, for the reason the recovery mail gives: it has to
    // survive every mail client an office uses, and an HTML part is a
    // second place for the same sentence to be wrong.
    const text = renderTemplateBody(message.bodyText, message.parameters);
    try {
      // Nodemailer's send result is typed `any` by its own declarations,
      // so it is narrowed here rather than trusted: this value is stored
      // and exported, and a non-string arriving in it would be a column
      // holding whatever the transport happened to hand back.
      const result: unknown = await this.transporter.sendMail({
        from: target.fromAddress,
        ...(target.replyToAddress === null ? {} : { replyTo: target.replyToAddress }),
        to: message.toAddress,
        subject: message.subject ?? message.templateName,
        text,
      });
      // The relay's own Message-ID. Recorded so the delivery log names
      // the message the way the mail server's logs do, which is the only
      // way the two can be reconciled during a delivery dispute.
      const messageId =
        typeof result === 'object' && result !== null && 'messageId' in result
          ? result.messageId
          : undefined;
      return typeof messageId === 'string' && messageId !== ''
        ? messageId
        : fallbackMessageId();
    } catch (cause) {
      // The errno and nothing else. A nodemailer transport error carries
      // the recipient address and the whole SMTP conversation, neither of
      // which belongs on a stored row or in a log line (AGENTS.md 11).
      const code: unknown =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? cause.code
          : undefined;
      // A 4xx SMTP reply, a timeout and a refused connection are all
      // temporary; a 5xx reply is the relay saying never. `responseCode`
      // is nodemailer's own copy of the SMTP status.
      const responseCode: unknown =
        typeof cause === 'object' && cause !== null && 'responseCode' in cause
          ? cause.responseCode
          : undefined;
      const permanent = typeof responseCode === 'number' && responseCode >= 500;
      throw new NotificationTransportError(
        typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
          ? code
          : 'mail_transport_failed',
        'The mail relay refused the message.',
        typeof responseCode === 'number' ? responseCode : null,
        !permanent,
      );
    }
  }
}
