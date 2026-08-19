// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, MeResponse } from '../../src/api.js';
import { App } from '../../src/App.js';
import { OfflineBanner } from '../../src/ui/offline-banner.js';
import { bindOfflineCache, withOfflineReads } from '../../src/lib/offline.js';
import { ORG_ID, membership } from './helpers.js';

/*
 * What the operator SEES when the connection goes (`docs/UX.md` § 23).
 *
 * Three surfaces, and only three: the cold-start card, the workspace
 * banner, and the staleness sentence the banner grows once a screen has
 * been answered from the cache.
 */

function setOnline(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

/** Fires the event the browser fires, which is what `useOnline`
 * subscribes to; `navigator.onLine` alone changes no React state. */
function goOffline(): void {
  setOnline(false);
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}

function goOnline(): void {
  setOnline(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  bindOfflineCache(null);
  sessionStorage.clear();
  window.history.replaceState(null, '', window.location.pathname);
});

const ME: MeResponse = {
  user: { id: 'user-a', email: 'owner@example.test' },
  // The shared fixture, so a new permission added to the contract does
  // not have to be remembered here — this suite is about connectivity and
  // has no opinion about any of them.
  memberships: [membership({ twoFactorEnabled: true })],
  twoFactorEnabled: true,
  mfaRequired: false,
  mfaEnforced: false,
};

describe('the cold start with no connection', () => {
  it('says the device is offline rather than blaming the workspace', async () => {
    setOnline(false);
    const api = {
      me: vi.fn<() => Promise<MeResponse | null>>().mockRejectedValue(new Error('x')),
      listOrganisations: vi.fn(),
    } as unknown as ApiClient;

    render(<App api={api} />);

    await screen.findByRole('heading', { name: 'You are offline' });
    // The other reading of the same failure must NOT be on screen: an
    // outage and a dead connection want opposite next steps.
    expect(
      screen.queryByRole('heading', { name: 'Workspace temporarily unavailable' }),
    ).toBeNull();
  });

  it('checks the session again by itself when the connection returns', async () => {
    setOnline(false);
    const me = vi
      .fn<() => Promise<MeResponse | null>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(null);
    const api = { me, listOrganisations: vi.fn() } as unknown as ApiClient;

    render(<App api={api} />);
    await screen.findByRole('heading', { name: 'You are offline' });

    goOnline();

    await screen.findByRole('heading', { name: 'Sign in' });
  });
});

describe('the workspace banner', () => {
  it('renders nothing at all while there is a connection', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container.textContent).toBe('');
  });

  it('says what cannot be done, and stays until the connection returns', () => {
    setOnline(true);
    render(<OfflineBanner />);

    goOffline();
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('This device is offline');
    expect(banner.textContent).toContain('Nothing can be created, changed or issued');

    goOnline();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names when the copy on screen was read, once one has been served', async () => {
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_ID });
    setOnline(true);
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValue(new Error('network'));
    const api = withOfflineReads({
      listWorks,
    } as unknown as ApiClient);

    render(<OfflineBanner />);
    await api.listWorks(ORG_ID);

    goOffline();
    expect(screen.getByRole('status').textContent).toContain(
      'Records already open stay readable',
    );

    await act(async () => {
      await api.listWorks(ORG_ID);
    });

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('Records on this screen were read at');
    // The instant is monospaced and tabular, like every other figure in
    // the product (`docs/DESIGN.md`).
    const stamp = banner.querySelector('.font-mono');
    expect(stamp?.className).toContain('tabular-nums');
    expect(stamp?.textContent).toMatch(/\d{2} \w{3} \d{4}, \d{2}:\d{2}/);
  });

  it('forgets the staleness sentence when the connection returns', async () => {
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_ID });
    setOnline(true);
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValue(new Error('network'));
    const api = withOfflineReads({ listWorks } as unknown as ApiClient);

    render(<OfflineBanner />);
    await api.listWorks(ORG_ID);
    goOffline();
    await act(async () => {
      await api.listWorks(ORG_ID);
    });
    expect(screen.getByRole('status').textContent).toContain('were read at');

    goOnline();
    goOffline();

    expect(screen.getByRole('status').textContent).toContain(
      'Records already open stay readable',
    );
  });
});

describe('the write refusal on a screen', () => {
  it('leaves the offline refusal on screen as an inline alert', async () => {
    setOnline(true);
    const api = {
      me: vi.fn<() => Promise<MeResponse | null>>().mockResolvedValue(ME),
      listOrganisations: vi
        .fn()
        .mockResolvedValue([{ id: ORG_ID, name: 'Sharma Constructions', slug: 's' }]),
      signOut: vi.fn().mockResolvedValue(undefined),
      listApprovals: vi.fn().mockResolvedValue([]),
      dashboard: vi.fn().mockRejectedValue(new Error('not this test')),
      listWorks: vi.fn().mockResolvedValue([]),
      listLoaDocuments: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;

    render(<App api={api} />);
    /* The rail, not the Dashboard heading: that heading is on screen
       while the Dashboard is still loading, so awaiting it would race
       (`test/views/loading-anchor-census.test.ts`). The rail is the
       workspace shell itself, which is what this test is about. */
    await screen.findByRole('navigation', { name: 'Modules' });

    goOffline();

    // The shell's own persistent explanation, above whatever screen is
    // open. The per-action refusal is asserted at the client in
    // `test/offline.test.ts`, where it is decided.
    // `getAllBy`, because a screen mid-load carries its own announced
    // skeletons; the assertion is that the shell's explanation is one of
    // the things being said.
    expect(
      screen
        .getAllByRole('status')
        .some((node) => (node.textContent ?? '').includes('This device is offline')),
    ).toBe(true);
  });
});
