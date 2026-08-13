/**
 * The boot gate and the message, without a database.
 *
 * Mirrors `mfa-boot-assertion.test.ts`: an unset NODE_ENV counts as
 * production, because a bare `pnpm start` leaves it unset and a
 * deployment that cannot send mail is a deployment where a forgotten
 * password is permanent.
 */
import { describe, expect, it } from 'vitest';
import {
  MAIL_FROM_ENV,
  RESET_TOKEN_TTL_SECONDS,
  SMTP_URL_ENV,
  assertProductionMailSettings,
  readMailSettings,
  resetPasswordMessage,
} from '../src/auth.js';

describe('readMailSettings', () => {
  it('reads a configured transport', () => {
    expect(
      readMailSettings({
        [SMTP_URL_ENV]: 'smtp://relay.internal:25',
        [MAIL_FROM_ENV]: 'Auto-MB <no-reply@contractor.example>',
      }),
    ).toEqual({
      smtpUrl: 'smtp://relay.internal:25',
      from: 'Auto-MB <no-reply@contractor.example>',
    });
  });

  it('treats a half-configured transport as no transport', () => {
    // A relay with no sender address is refused by most MTAs, so the
    // half-set case must fail the boot gate rather than sail through it
    // and break at the first reset attempt.
    expect(readMailSettings({ [SMTP_URL_ENV]: 'smtp://relay.internal:25' })).toBeNull();
    expect(
      readMailSettings({ [MAIL_FROM_ENV]: 'no-reply@contractor.example' }),
    ).toBeNull();
    expect(
      readMailSettings({ [SMTP_URL_ENV]: '  ', [MAIL_FROM_ENV]: '  ' }),
    ).toBeNull();
    expect(readMailSettings({})).toBeNull();
  });
});

describe('assertProductionMailSettings', () => {
  const configured = { smtpUrl: 'smtp://relay.internal:25', from: 'no-reply@x.test' };

  it('refuses to start an unconfigured production process', () => {
    expect(() => assertProductionMailSettings(null, 'production')).toThrow(
      /SMTP_URL and MAIL_FROM must both be set/,
    );
  });

  it('treats an unset NODE_ENV as production', () => {
    expect(() => assertProductionMailSettings(null, undefined)).toThrow(
      /SMTP_URL and MAIL_FROM must both be set/,
    );
  });

  it('leaves development and test able to run without a relay', () => {
    expect(assertProductionMailSettings(null, 'development')).toBeNull();
    expect(assertProductionMailSettings(null, 'test')).toBeNull();
  });

  it('passes a configured transport through unchanged', () => {
    expect(assertProductionMailSettings(configured, 'production')).toBe(configured);
  });
});

describe('resetPasswordMessage', () => {
  const url = 'https://auto-mb.example/api/auth/reset-password/abc123?callbackURL=x';

  it('carries the link and states the lifetime the server enforces', () => {
    const message = resetPasswordMessage(url);
    expect(message.subject).toBe('Reset your Auto-MB password');
    expect(message.text).toContain(url);
    expect(message.text).toContain(`${String(RESET_TOKEN_TTL_SECONDS / 60)} minutes`);
  });

  it('tells the reader what to do with an unrequested one, and that MFA is untouched', () => {
    const message = resetPasswordMessage(url);
    expect(message.text).toContain('If you did not ask for this');
    expect(message.text).toContain('two-factor code');
  });
});
