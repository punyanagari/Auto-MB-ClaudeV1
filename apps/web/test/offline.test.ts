// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, RequestFailedError } from '../src/api.js';
import {
  bindOfflineCache,
  clearCachedReadNotice,
  isOffline,
  withOfflineReads,
} from '../src/lib/offline.js';

/*
 * The offline contract, asserted where it is decided rather than where it
 * is displayed (`docs/UX.md` § 23).
 *
 * Three properties, and they are the three a reviewer should be able to
 * check by reading this file:
 *
 *   1. a write is refused before anything leaves the browser;
 *   2. a cached read is served ONLY when the browser says there is no
 *      network, and only back to the account and organisation it was
 *      read for;
 *   3. the cache is empty the moment either of those changes.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

/** jsdom's `navigator.onLine` is a getter on the prototype; this is the
 * only way to make the browser claim there is no network. */
function setOnline(online: boolean): void {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  bindOfflineCache(null);
  clearCachedReadNotice();
});

describe('offline detection', () => {
  it('reads only the certain half of navigator.onLine', () => {
    setOnline(true);
    expect(isOffline()).toBe(false);
    setOnline(false);
    expect(isOffline()).toBe(true);
  });
});

describe('writes while offline', () => {
  it('refuses a write before it reaches the network', async () => {
    setOnline(false);
    const fetchImpl = vi.fn();
    const api = createApiClient(fetchImpl);

    await expect(
      api.setWorkSettings(ORG_A, '33333333-3333-4333-8333-333333333333', true),
    ).rejects.toBeInstanceOf(RequestFailedError);
    // Nothing was sent. That is the whole promise: a refusal the operator
    // can trust means the record on the server is untouched.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('states the fact and the remedy in one sentence', async () => {
    setOnline(false);
    const api = createApiClient(vi.fn());

    const refusal = await api
      .setWorkSettings(ORG_A, '33333333-3333-4333-8333-333333333333', true)
      .then(
        () => null,
        (cause: unknown) => cause as RequestFailedError,
      );

    expect(refusal?.code).toBe('OFFLINE');
    expect(refusal?.fact).toContain('nothing was changed');
    expect(refusal?.remedy).toContain('Reconnect');
    // `errorMessage()` renders `message`, which is what every inline
    // action error on every screen already prints.
    expect(refusal?.message).toContain('Reconnect');
  });

  it('still attempts a read, so the cache can answer in its place', async () => {
    setOnline(false);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ works: [] }));
    const api = createApiClient(fetchImpl);

    await api.listWorks(ORG_A);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets every write through while the browser has a connection', async () => {
    setOnline(true);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ allowExcess: true }));
    const api = createApiClient(fetchImpl);

    await api.setWorkSettings(ORG_A, '33333333-3333-4333-8333-333333333333', true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('the offline read cache', () => {
  function clientReading(listWorks: () => Promise<unknown>) {
    return withOfflineReads({
      listWorks,
    } as unknown as Parameters<typeof withOfflineReads>[0]);
  }

  it('serves the last copy when the read fails and the browser is offline', async () => {
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    const works = [{ id: 'w1' }];
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce(works)
      .mockRejectedValueOnce(new Error('network'));
    const api = clientReading(listWorks);

    setOnline(true);
    expect(await api.listWorks(ORG_A)).toEqual(works);

    setOnline(false);
    expect(await api.listWorks(ORG_A)).toEqual(works);
  });

  it('lets the failure through while the browser believes it is online', async () => {
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValueOnce(new Error('server on fire'));
    const api = clientReading(listWorks);

    setOnline(true);
    await api.listWorks(ORG_A);
    // A 500 or a 403 is not an offline read. Answering it from the cache
    // would show records the caller may no longer be allowed to see, on a
    // screen that looks live.
    await expect(api.listWorks(ORG_A)).rejects.toThrow('server on fire');
  });

  it('holds nothing at all while it is unbound', async () => {
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValueOnce(new Error('network'));
    const api = clientReading(listWorks);

    setOnline(true);
    await api.listWorks(ORG_A);

    setOnline(false);
    await expect(api.listWorks(ORG_A)).rejects.toThrow('network');
  });

  it('never serves one organisation a copy read for another', async () => {
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValueOnce(new Error('network'));
    const api = clientReading(listWorks);

    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    setOnline(true);
    await api.listWorks(ORG_A);

    bindOfflineCache({ userId: 'user-a', organisationId: ORG_B });
    setOnline(false);
    await expect(api.listWorks(ORG_B)).rejects.toThrow('network');
  });

  it('never serves one account a copy read for another', async () => {
    const listWorks = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'w1' }])
      .mockRejectedValueOnce(new Error('network'));
    const api = clientReading(listWorks);

    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    setOnline(true);
    await api.listWorks(ORG_A);

    // Signing out and back in as somebody else on the same site machine.
    bindOfflineCache(null);
    bindOfflineCache({ userId: 'user-b', organisationId: ORG_A });
    setOnline(false);
    await expect(api.listWorks(ORG_A)).rejects.toThrow('network');
  });

  it('discards a read that answers after the organisation has changed', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const listWorks = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      )
      .mockRejectedValueOnce(new Error('network'));
    const api = clientReading(listWorks);

    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    setOnline(true);
    const inFlight = api.listWorks(ORG_A);
    // The operator switches organisation while the read is still out.
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_B });
    settle([{ id: 'w1' }]);
    await inFlight;

    setOnline(false);
    await expect(api.listWorks(ORG_B)).rejects.toThrow('network');
  });

  it('forgets the oldest reads rather than growing without a bound', async () => {
    bindOfflineCache({ userId: 'user-a', organisationId: ORG_A });
    setOnline(true);
    // One key per Work id; the limit is 40, so the first of 41 is gone.
    const listDeliveryChallans = vi
      .fn()
      .mockImplementation((_org: string, workId: string) =>
        Promise.resolve([{ id: workId }]),
      );
    const api = withOfflineReads({
      listDeliveryChallans,
    } as unknown as Parameters<typeof withOfflineReads>[0]);
    for (let index = 0; index < 41; index++) {
      await api.listDeliveryChallans(ORG_A, `work-${String(index)}`);
    }

    listDeliveryChallans.mockRejectedValue(new Error('network'));
    setOnline(false);
    await expect(api.listDeliveryChallans(ORG_A, 'work-0')).rejects.toThrow('network');
    expect(await api.listDeliveryChallans(ORG_A, 'work-40')).toEqual([
      { id: 'work-40' },
    ]);
  });
});
