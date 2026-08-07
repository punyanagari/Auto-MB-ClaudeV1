// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Membership } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../src/api.js';
import { Members } from '../src/views/Members.js';
import { OrgPicker } from '../src/views/OrgPicker.js';
import { SignIn } from '../src/views/SignIn.js';

afterEach(cleanup);

function stubApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    listOrganisations: vi.fn().mockResolvedValue([]),
    createOrganisation: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    addMember: vi.fn(),
    ...overrides,
  };
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function membership(overrides: Partial<Membership>): Membership {
  return {
    organisationId: ORG_ID,
    userId: 'user-a',
    role: 'owner',
    workScope: 'all',
    canIssueDocuments: true,
    canCancelDocuments: true,
    status: 'active',
    ...overrides,
  };
}

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
  it('lists organisations and reports the selection', async () => {
    const api = stubApi({
      listOrganisations: vi
        .fn()
        .mockResolvedValue([
          { id: ORG_ID, name: 'Sharma Constructions', slug: 'sharma' },
        ]),
    });
    const onSelect = vi.fn();
    render(<OrgPicker api={api} onSelect={onSelect} onCreated={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole('button', { name: /Sharma Constructions/ }),
    );
    expect(onSelect).toHaveBeenCalledWith({
      id: ORG_ID,
      name: 'Sharma Constructions',
      slug: 'sharma',
    });
  });

  it('creates an organisation and surfaces slug collisions', async () => {
    const api = stubApi({
      createOrganisation: vi
        .fn()
        .mockRejectedValue(
          new RequestFailedError(409, 'SLUG_TAKEN', 'Slug already exists.'),
        ),
    });
    render(<OrgPicker api={api} onSelect={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Organisation name'), {
      target: { value: 'Sharma Constructions' },
    });
    fireEvent.change(screen.getByLabelText('Short identifier'), {
      target: { value: 'sharma' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organisation' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Slug already exists.');
  });
});

describe('Members', () => {
  it('shows the member table and the add form to owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer', canIssueDocuments: false }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByLabelText('Account email')).toBeTruthy();
  });

  it('hides member management from non-owners', async () => {
    const api = stubApi({
      listMembers: vi
        .fn()
        .mockResolvedValue([
          membership({ userId: 'user-a', role: 'owner' }),
          membership({ userId: 'user-b', role: 'viewer' }),
        ]),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-b" />);

    await screen.findByRole('table');
    expect(screen.queryByLabelText('Account email')).toBeNull();
  });

  it('adds a member and announces the outcome', async () => {
    const grown = [
      membership({ userId: 'user-a', role: 'owner' }),
      membership({ userId: 'user-c', role: 'viewer' }),
    ];
    const api = stubApi({
      listMembers: vi.fn().mockResolvedValue([membership({ userId: 'user-a' })]),
      addMember: vi.fn().mockResolvedValue(grown),
    });
    render(<Members api={api} organisationId={ORG_ID} currentUserId="user-a" />);

    fireEvent.change(await screen.findByLabelText('Account email'), {
      target: { value: 'viewer@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('viewer@example.test');
    });
    expect(api.addMember).toHaveBeenCalledWith(ORG_ID, {
      email: 'viewer@example.test',
      role: 'viewer',
    });
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});
