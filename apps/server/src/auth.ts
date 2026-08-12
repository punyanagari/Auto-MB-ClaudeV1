import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
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
  return betterAuth({
    baseURL: options.baseUrl,
    secret: options.secret,
    basePath: '/api/auth',
    trustedOrigins: [...(options.trustedOrigins ?? [])],
    database: options.pool,
    emailAndPassword: {
      enabled: true,
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
