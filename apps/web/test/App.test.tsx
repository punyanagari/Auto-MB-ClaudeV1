// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, MeResponse } from '../src/api.js';
import { App } from '../src/App.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('App session loading', () => {
  it('handles failures from retrying the whole session load', async () => {
    const me: MeResponse = {
      user: { id: 'user-a', email: 'owner@example.test' },
      memberships: [
        {
          organisationId: '11111111-1111-4111-8111-111111111111',
          userId: 'user-a',
          role: 'owner',
          workScope: 'all',
          canIssueDocuments: true,
          canCancelDocuments: true,
          canApproveAmendments: false,
          status: 'active',
        },
      ],
    };
    const api = {
      me: vi
        .fn<() => Promise<MeResponse | null>>()
        .mockRejectedValueOnce(new Error('Session unavailable.'))
        .mockResolvedValueOnce(me),
      listOrganisations: vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error('Organisation unavailable.')),
    } as unknown as ApiClient;

    render(<App api={api} />);

    await screen.findByRole('heading', {
      name: 'Workspace temporarily unavailable',
    });
    expect(screen.getByText('Session unavailable.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Organisation unavailable.')).toBeTruthy();
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(api.listOrganisations).toHaveBeenCalledTimes(1);
  });

  it('ignores an older session result after a newer refresh signs out', async () => {
    const organisationId = '11111111-1111-4111-8111-111111111111';
    const me: MeResponse = {
      user: { id: 'user-a', email: 'owner@example.test' },
      memberships: [
        {
          organisationId,
          userId: 'user-a',
          role: 'owner',
          workScope: 'all',
          canIssueDocuments: true,
          canCancelDocuments: true,
          canApproveAmendments: false,
          status: 'active',
        },
      ],
    };
    const oldOrganisations =
      deferred<readonly { id: string; name: string; slug: string }[]>();
    const api = {
      me: vi
        .fn<() => Promise<MeResponse | null>>()
        .mockRejectedValueOnce(new Error('Session unavailable.'))
        .mockResolvedValueOnce(me)
        .mockResolvedValueOnce(null),
      listOrganisations: vi.fn(() => oldOrganisations.promise),
    } as unknown as ApiClient;

    render(<App api={api} />);
    await screen.findByRole('heading', {
      name: 'Workspace temporarily unavailable',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.listOrganisations).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Sign in' });

    await act(async () => {
      oldOrganisations.resolve([
        { id: organisationId, name: 'Sharma Constructions', slug: 'sharma' },
      ]);
      await oldOrganisations.promise;
    });

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(sessionStorage.getItem('auto-mb.organisation-id')).toBeNull();
  });

  it('ignores an older session error after a newer refresh succeeds', async () => {
    const oldSession = deferred<MeResponse | null>();
    const api = {
      me: vi
        .fn<() => Promise<MeResponse | null>>()
        .mockRejectedValueOnce(new Error('Initial failure.'))
        .mockImplementationOnce(() => oldSession.promise)
        .mockResolvedValueOnce(null),
    } as unknown as ApiClient;

    render(<App api={api} />);
    await screen.findByText('Initial failure.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Sign in' });

    await act(async () => {
      oldSession.reject(new Error('Late stale failure.'));
      await oldSession.promise.catch(() => undefined);
    });

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Late stale failure.')).toBeNull();
  });
});
