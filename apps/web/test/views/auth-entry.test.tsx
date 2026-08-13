// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestFailedError } from '../../src/api.js';
import { OrganisationOnboarding } from '../../src/views/OrganisationOnboarding.js';
import { OrgPicker } from '../../src/views/OrgPicker.js';
import { SignIn } from '../../src/views/SignIn.js';
import { stubApi, ORG_ID, membership } from './helpers.js';

describe('SignIn', () => {
  it('submits credentials and reports success', async () => {
    const api = stubApi();
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledOnce();
    });
    expect(api.signIn).toHaveBeenCalledWith('owner@example.test', 'password-123');
  });

  it('announces failures in an alert region and stays on the form', async () => {
    const api = stubApi({
      signIn: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(401, 'INVALID_CREDENTIALS', 'Wrong password.'),
        ),
    });
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Wrong password.');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('switches to the TOTP step when sign-in answers twoFactorRequired', async () => {
    const api = stubApi({
      signIn: vi.fn().mockResolvedValue({ twoFactorRequired: true }),
    });
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // No session exists yet: the challenge form renders and the app is
    // NOT told the sign-in finished (the dead-loop the discarded response
    // body used to cause).
    await screen.findByRole('heading', { name: 'Two-factor check' });
    expect(onSignedIn).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await waitFor(() => {
      expect(onSignedIn).toHaveBeenCalledOnce();
    });
    expect(api.verifyTotp).toHaveBeenCalledWith('123456');
  });

  it('offers backup-code entry and keeps verification errors inline', async () => {
    const api = stubApi({
      signIn: vi.fn().mockResolvedValue({ twoFactorRequired: true }),
      verifyBackupCode: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(
            429,
            'RATE_LIMITED',
            'Too many attempts; wait a few minutes and try again.',
          ),
        ),
    });
    const onSignedIn = vi.fn();
    render(<SignIn api={api} onSignedIn={onSignedIn} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Two-factor check' });

    fireEvent.click(screen.getByRole('button', { name: 'Use a backup code instead' }));
    fireEvent.change(screen.getByLabelText('Backup code'), {
      target: { value: 'abcde-12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Too many attempts; wait a few minutes and try again.',
    );
    expect(api.verifyBackupCode).toHaveBeenCalledWith('abcde-12345');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('collects a name when switched to account creation', async () => {
    const api = stubApi();
    render(<SignIn api={api} onSignedIn={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'New here? Create an account' }),
    );
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Owner Person' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'owner@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(api.signUp).toHaveBeenCalledWith(
        'owner@example.test',
        'Owner Person',
        'password-123',
      );
    });
  });
});

describe('OrgPicker', () => {
  it('lists organisations and reports the selection', () => {
    const organisation = {
      id: ORG_ID,
      name: 'Sharma Constructions',
      slug: 'sharma',
    };
    const onSelect = vi.fn();
    render(
      <OrgPicker
        organisations={[organisation]}
        memberships={[membership({})]}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(onSelect).toHaveBeenCalledWith(organisation);
  });

  it('does not offer organisations without an active membership', () => {
    render(
      <OrgPicker
        organisations={[{ id: ORG_ID, name: 'Sharma Constructions', slug: 'sharma' }]}
        memberships={[membership({ status: 'disabled' })]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Open workspace' })).toBeNull();
  });
});

describe('OrganisationOnboarding', () => {
  it('surfaces organisation slug collisions', async () => {
    const api = stubApi({
      createOrganisation: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(409, 'SLUG_TAKEN', 'Slug already exists.'),
        ),
    });
    render(<OrganisationOnboarding api={api} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Legal organisation name'), {
      target: { value: 'Sharma Constructions' },
    });
    fireEvent.change(screen.getByLabelText('Workspace identifier'), {
      target: { value: 'sharma' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Slug already exists.');
  });
});
