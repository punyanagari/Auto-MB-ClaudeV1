import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { createTransport } from 'nodemailer';
import type pg from 'pg';

export interface CreateAuthOptions {
  readonly pool: pg.Pool;
  readonly secret: string;
  readonly baseUrl: string;
  readonly trustedOrigins?: readonly string[];
}

const PLACEHOLDER_SECRET = 'replace-with-at-least-32-random-characters';

export function assertProductionSecret(secret: string | undefined): string {
  // Treat anything that is not an explicit development or test run as
  // production for this gate. A bare `pnpm start` leaves NODE_ENV unset,
  // and that path must never silently fall back to the placeholder secret
  // (which would let anyone forge session cookies). This mirrors the docs
  // UI, which already fail-closes when NODE_ENV is unset.
  const isNonProduction =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (
    !isNonProduction &&
    (secret === undefined || secret.length < 32 || secret === PLACEHOLDER_SECRET)
  ) {
    throw new Error(
      'AUTH_SECRET must be set to at least 32 non-placeholder characters outside development and test',
    );
  }
  return secret ?? PLACEHOLDER_SECRET;
}

/* --- Password recovery mail ------------------------------------------- */

export const SMTP_URL_ENV = 'SMTP_URL';
export const MAIL_FROM_ENV = 'MAIL_FROM';

/** How long a reset link stays usable. An hour is Better Auth's own
 * default; it is written here so the number in the email and the number
 * the server enforces cannot drift apart. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Where password-recovery mail leaves this deployment.
 *
 * Better Auth ships no mail transport of its own: `sendResetPassword` is
 * the application's job, and until it exists the whole recovery path is
 * refused by the library with `RESET_PASSWORD_DISABLED`. SMTP is the
 * transport chosen here because the product is deployed as a self-hosted
 * compose stack beside whatever relay the agency already runs, and SMTP
 * is the one interface every such relay offers.
 */
export interface MailSettings {
  /** A `smtp://` or `smtps://` URL, credentials included when the relay
   * requires them (nodemailer parses the whole connection from it). */
  readonly smtpUrl: string;
  /** The `From:` header. Must be an address the relay will accept. */
  readonly from: string;
}

/** The mail settings the environment carries, or null when the deployment
 * has not configured a transport at all. Both values are required: a
 * relay with no sender address is refused by most MTAs, and discovering
 * that at the moment a locked-out clerk needs it is the failure this pack
 * exists to remove. */
export function readMailSettings(
  env: NodeJS.ProcessEnv = process.env,
): MailSettings | null {
  const smtpUrl = env[SMTP_URL_ENV]?.trim() ?? '';
  const from = env[MAIL_FROM_ENV]?.trim() ?? '';
  if (smtpUrl === '' || from === '') return null;
  return { smtpUrl, from };
}

/**
 * Boot gate, with the same posture as `assertProductionSecret`: anything
 * that is not an explicit development or test run counts as production,
 * because a bare `pnpm start` leaves NODE_ENV unset.
 *
 * It refuses to start rather than deferring the failure to the first
 * reset attempt, and it must: Better Auth answers
 * `/request-password-reset` with its neutral "if this email exists"
 * message whether or not the send succeeded, so an unconfigured transport
 * is invisible from the outside. A deployment that cannot mail is a
 * deployment where a forgotten password is permanent — mandatory
 * two-factor authentication removes every other way back in.
 */
export function assertProductionMailSettings(
  settings: MailSettings | null,
  nodeEnv: string | undefined,
): MailSettings | null {
  const isNonProduction = nodeEnv === 'development' || nodeEnv === 'test';
  if (!isNonProduction && settings === null) {
    throw new Error(
      `${SMTP_URL_ENV} and ${MAIL_FROM_ENV} must both be set outside development and ` +
        'test: without a mail transport no clerk can recover a forgotten password, ' +
        'and mandatory two-factor authentication makes that lockout permanent.',
    );
  }
  return settings;
}

/** The recovery email. Plain text on purpose — it has one link in it, it
 * has to survive every mail client an office uses, and an HTML part would
 * only add a second place for the link to be wrong. */
export function resetPasswordMessage(url: string): {
  readonly subject: string;
  readonly text: string;
} {
  const minutes = String(Math.round(RESET_TOKEN_TTL_SECONDS / 60));
  return {
    subject: 'Reset your Auto-MB password',
    text: [
      'Someone asked to reset the Auto-MB password for this address.',
      '',
      'Open this link to choose a new password:',
      url,
      '',
      `The link can be used once and stops working after ${minutes} minutes.`,
      'If you did not ask for this, ignore this message. Nothing has changed.',
      '',
      'Your authenticator app is unaffected: signing in still asks for a',
      'two-factor code after the new password.',
      '',
      'Auto-MB',
    ].join('\n'),
  };
}

/** A short symbolic reason for a failed send, and nothing else. Transport
 * errors carry the recipient address and the SMTP conversation, neither of
 * which belongs in a log line (AGENTS.md: logs never carry bodies or
 * personal data), so only an error code such as ECONNREFUSED or EAUTH is
 * passed on. */
function transportFailureCode(cause: unknown): string {
  const code: unknown =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? cause.code
      : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)
    ? code
    : 'no transport error code';
}

export type SendMail = (message: {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}) => Promise<void>;

function smtpSender(settings: MailSettings): SendMail {
  const transport = createTransport(settings.smtpUrl, { from: settings.from });
  return async (message) => {
    await transport.sendMail({
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  };
}

/**
 * Better Auth owns the auth_* tables; migration 0004 carries the exact
 * shape `@better-auth/cli generate` emits for this configuration (model
 * names overridden to auth_*; column names stay Better Auth's camelCase).
 * Regenerating the schema after config changes: temporarily export an
 * `auth` instance from this module and run
 * `pnpm dlx @better-auth/cli generate --config src/auth.ts`.
 */
/** The narrow surface the application uses. The full plugin-augmented
 * betterAuth type cannot be named portably (its inference references
 * better-auth's internal zod instance by .pnpm path, TS2742); every other
 * endpoint is reached through `handler`, not typed API calls. */
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: { headers: Headers }): Promise<{
      /** The auth_sessions row; `token` is the raw value the row stores
       * (the cookie carries `${token}.${signature}`). */
      session: { token: string };
      user: { id: string; email: string; name: string };
    } | null>;
  };
}

export function createAuth(options: CreateAuthOptions): Auth {
  // Read from the environment rather than from the caller: the transport
  // is a property of the deployment, not of the application graph, and
  // this keeps the boot gate on the same footing as the AUTH_SECRET and
  // MFA gates that already run at start-up.
  const mailSettings = assertProductionMailSettings(
    readMailSettings(),
    process.env.NODE_ENV,
  );
  const sendMail = mailSettings === null ? null : smtpSender(mailSettings);
  return betterAuth({
    baseURL: options.baseUrl,
    secret: options.secret,
    basePath: '/api/auth',
    trustedOrigins: [...(options.trustedOrigins ?? [])],
    database: options.pool,
    emailAndPassword: {
      enabled: true,
      // Recovery, and the two rules around it. Without this callback
      // Better Auth refuses /request-password-reset outright, which is
      // what shipped until now: with mandatory TOTP a forgotten password
      // had no remedy at all.
      //
      // In production Better Auth's own limiter already throttles
      // /request-password-reset to three attempts per minute per client
      // address (its default special rule), so this is not an open mail
      // relay for whoever knows a colleague's address.
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      // A reset is what someone does when they suspect they have lost
      // control of the account, so every existing session goes with it.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (sendMail === null) {
          throw new Error(
            `Password recovery is not configured: set ${SMTP_URL_ENV} and ` +
              `${MAIL_FROM_ENV}.`,
          );
        }
        const message = resetPasswordMessage(url);
        try {
          await sendMail({
            to: user.email,
            subject: message.subject,
            text: message.text,
          });
        } catch (cause) {
          // Better Auth logs whatever is thrown here and still answers
          // the caller with its neutral "if this email exists" message,
          // so this string is an OPERATOR signal. It carries no token, no
          // reset URL and no address.
          throw new Error(
            `Password reset email could not be sent (${transportFailureCode(cause)}).`,
          );
        }
      },
    },
    user: { modelName: 'auth_users' },
    session: { modelName: 'auth_sessions' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_verifications' },
    plugins: [
      twoFactor({
        schema: {
          twoFactor: { modelName: 'auth_two_factors' },
        },
      }),
    ],
  });
}
