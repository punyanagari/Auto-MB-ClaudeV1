// @vitest-environment jsdom
/**
 * Password recovery, from the sign-in screen.
 *
 * The guard for the P5 finding: before this pack there was no way to
 * recover a forgotten password anywhere in the product, and because
 * two-factor authentication is mandatory for anyone holding document
 * authority, that made a forgotten password a permanent lockout. Every
 * assertion here fails on the pre-fix tree — the entry point, the neutral
 * confirmation, and the reset form the emailed link opens.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestFailedError } from '../../src/api.js';
import { SignIn } from '../../src/views/SignIn.js';
import { stubApi } from './helpers.js';

afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
});

describe('SignIn password recovery', () => {
  it('asks the server for a reset link and answers without naming the account', async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue(undefined);
    const api = stubApi({ requestPasswordReset });
    render(<SignIn api={api} onSignedIn={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'clerk@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email the reset link' }));

    await waitFor(() => {
      expect(requestPasswordReset).toHaveBeenCalledWith(
        'clerk@example.test',
        // The link has to land back on this app, and the server refuses a
        // redirect target it does not trust.
        `${window.location.origin}${window.location.pathname}`,
      );
    });

    // Deliberately conditional: a screen that said "no such account" on an
    // unauthenticated page would be an account-existence oracle.
    const confirmation = await screen.findByRole('status');
    expect(confirmation.textContent).toContain('If clerk@example.test has an account');
  });

  it('reports a refused request and stays on the recovery form', async () => {
    const api = stubApi({
      requestPasswordReset: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            429,
            'RATE_LIMITED',
            'Too many attempts. Wait a minute.',
          ),
        ),
    });
    render(<SignIn api={api} onSignedIn={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }));
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'clerk@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Email the reset link' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Too many attempts. Wait a minute.');
    expect(screen.getByRole('button', { name: 'Email the reset link' })).toBeTruthy();
  });

  it('opens the new-password form from the emailed link and takes the token out of the address bar', async () => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?token=reset-token-1`,
    );
    const resetPassword = vi.fn().mockResolvedValue(undefined);
    render(<SignIn api={stubApi({ resetPassword })} onSignedIn={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Choose a new password' });
    // The token is a bearer secret for the account; it must not stay in
    // the address bar, the history entry, or a screenshot of the tab.
    expect(window.location.search).toBe('');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a-new-password' },
    });
    fireEvent.change(screen.getByLabelText('Repeat the password'), {
      target: { value: 'a-new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set the password' }));

    await waitFor(() => {
      expect(resetPassword).toHaveBeenCalledWith('reset-token-1', 'a-new-password');
    });
    // Back to sign in, because the reset creates no session and the second
    // factor is still ahead of the operator.
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.getByRole('status').textContent).toContain('Password changed');
  });

  it('refuses a mistyped confirmation without spending the token', async () => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?token=reset-token-2`,
    );
    const resetPassword = vi.fn();
    render(<SignIn api={stubApi({ resetPassword })} onSignedIn={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Choose a new password' });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a-new-password' },
    });
    fireEvent.change(screen.getByLabelText('Repeat the password'), {
      target: { value: 'a-new-passwrd' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set the password' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'The two passwords do not match.',
    );
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('explains a spent or expired link instead of showing a form that cannot work', async () => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?error=INVALID_TOKEN`,
    );
    render(<SignIn api={stubApi()} onSignedIn={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Sign in' });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'That reset link has expired or was already used',
    );
    expect(window.location.search).toBe('');
    // The remedy is one click away rather than a second lost hour.
    expect(screen.getByRole('button', { name: 'Forgot your password?' })).toBeTruthy();
  });
});
