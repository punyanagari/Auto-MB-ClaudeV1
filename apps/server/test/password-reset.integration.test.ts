/**
 * Password recovery, end to end, over a real SMTP conversation.
 *
 * Before this pack the product had no recovery path at all: Better Auth
 * refuses `/request-password-reset` with `RESET_PASSWORD_DISABLED` until
 * the application supplies a `sendResetPassword` callback, and none
 * existed. Because two-factor authentication is mandatory for anyone
 * holding document authority, a forgotten password was an unrecoverable
 * lockout — the single worst clerk-facing failure in either 2026-08-13
 * review.
 *
 * The mail is delivered to a throwaway SMTP server rather than to a stub
 * of our own sending code, because the failure worth guarding against is
 * a deployment that accepts the request and delivers nothing.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '@auto-mb/db';
import { createDatabasePool, runMigrations } from '@auto-mb/db';
import { buildApp } from '../src/app.js';
import {
  decodeMessageText,
  startSmtpSink,
  type SmtpSink,
} from './helpers/smtp-sink.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://auto_mb_owner:local-owner-change-me@127.0.0.1:5432/auto_mb';
const appUrl =
  process.env.DATABASE_URL ??
  'postgres://auto_mb_app:local-app-change-me@127.0.0.1:5432/auto_mb';
const appPassword = process.env.AUTO_MB_APP_DB_PASSWORD ?? 'local-app-change-me';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(
  here,
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const runId = randomBytes(5).toString('hex');
const clerkEmail = `clerk-${runId}@integration.test`;
const originalPassword = `original-password-${runId}`;
const newPassword = `chosen-again-${runId}`;
const mailFrom = `Auto-MB <no-reply-${runId}@integration.test>`;
const baseUrl = 'http://127.0.0.1:3000';

let admin: Sql;
let app: FastifyInstance;
let sink: SmtpSink;

/** The reset link Better Auth put in the message. */
function resetLinkOf(message: string): string {
  const link = /https?:\/\/\S*\/reset-password\/\S+/.exec(message)?.[0];
  if (link === undefined) throw new Error(`No reset link in message:\n${message}`);
  return link;
}

function tokenOf(link: string): string {
  const token = /\/reset-password\/([^?\s]+)/.exec(link)?.[1];
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a presence test on a regex capture in a test helper; the heuristic fires on the identifier's name alone
  if (token === undefined) throw new Error(`No token in link: ${link}`);
  return token;
}

/** Mutations carry the application Origin, because the deployment's own
 * guard refuses them otherwise. */
const fromApp = { origin: baseUrl };

async function requestReset(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/request-password-reset',
    headers: fromApp,
    payload: { email, redirectTo: baseUrl },
  });
}

async function signIn(password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: fromApp,
    payload: { email: clerkEmail, password },
  });
}

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 1,
    applicationName: 'auto-mb-password-reset-admin',
  });
  try {
    await admin`select 1 as ready`;
  } catch (error) {
    throw new Error(
      'PostgreSQL is not reachable for the password-reset integration tests. ' +
        `Start it with \`docker compose up -d postgres\`. Underlying error: ${String(error)}`,
    );
  }

  const escapedPassword = appPassword.replaceAll("'", "''");
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auto_mb_app') THEN
        CREATE ROLE auto_mb_app LOGIN PASSWORD '${escapedPassword}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $$;
  `);
  await runMigrations(admin, migrationsDirectory);

  sink = await startSmtpSink();
  // The transport is read from the environment inside createAuth, which is
  // where a deployment configures it — so this is the same wiring an
  // operator uses, not a test-only injection point.
  process.env.SMTP_URL = sink.url;
  process.env.MAIL_FROM = mailFrom;

  app = await buildApp({
    databaseUrl: appUrl,
    authSecret: `integration-secret-${'0'.repeat(32)}`,
    baseUrl,
    trustedOrigins: [baseUrl],
  });

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: fromApp,
    payload: { email: clerkEmail, password: originalPassword, name: 'Clerk User' },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
});

afterAll(async () => {
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  if (admin) {
    await admin`
      delete from identity_audit_events
      where user_id in (
        select "id" from auth_users where "email" like ${`%-${runId}@integration.test`}
      )
    `;
    await admin`delete from auth_users where "email" like ${`%-${runId}@integration.test`}`;
  }
  await app?.close();
  await sink?.close();
  await admin?.end();
});

describe('password recovery', () => {
  let link: string;

  it('accepts a reset request and delivers a link over SMTP', async () => {
    const response = await requestReset(clerkEmail);
    // Pre-fix this is 400 RESET_PASSWORD_DISABLED: no sendResetPassword
    // callback existed, so the whole recovery path was refused.
    expect(response.statusCode, response.body).toBe(200);

    await sink.waitForMessages(1);
    const message = sink.messages[0];
    if (message === undefined) throw new Error('no message captured');
    expect(message.recipients).toEqual([clerkEmail]);
    expect(message.from).toContain(`no-reply-${runId}@integration.test`);
    expect(message.data).toContain('Subject: Reset your Auto-MB password');

    const text = decodeMessageText(message.data);
    link = resetLinkOf(text);
    // The token is a bearer credential for the account: it belongs in the
    // email and nowhere else. The HTTP answer must not carry it, and it
    // must say the same thing for every address (see below).
    expect(response.body).not.toContain(tokenOf(link));
    expect(text).not.toContain(originalPassword);
  });

  it('turns the emailed link into a redirect that carries the token to the app', async () => {
    const url = new URL(link);
    const response = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
    });
    expect(response.statusCode).toBe(302);
    const location = response.headers.location;
    expect(String(location)).toContain(`token=${tokenOf(link)}`);
  });

  it('says the same thing about an address with no account, and mails nothing', async () => {
    const before = sink.messages.length;
    const response = await requestReset(`nobody-${runId}@integration.test`);
    expect(response.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sink.messages.length).toBe(before);
  });

  it('spends the token on the new password and refuses the old one afterwards', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: fromApp,
      payload: { token: tokenOf(link), newPassword },
    });
    expect(reset.statusCode, reset.body).toBe(200);

    const withNew = await signIn(newPassword);
    expect(withNew.statusCode, withNew.body).toBe(200);

    const withOld = await signIn(originalPassword);
    expect(withOld.statusCode).toBe(401);
  });

  it('refuses a token that has already been used', async () => {
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: fromApp,
      payload: { token: tokenOf(link), newPassword: `again-${runId}` },
    });
    expect(replay.statusCode).toBe(400);
    // And the password that was set is still the one that works.
    const withNew = await signIn(newPassword);
    expect(withNew.statusCode).toBe(200);
  });

  it('refuses a token that was never issued', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: fromApp,
      payload: { token: 'not-a-token', newPassword: `never-${runId}` },
    });
    expect(response.statusCode).toBe(400);
  });
});
