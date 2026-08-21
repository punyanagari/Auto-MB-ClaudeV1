import { useSyncExternalStore } from 'react';
// TYPE-ONLY, and it has to stay that way: `src/api.ts` imports
// `isOffline` from this file for the write refusal, so a value import
// here would close the cycle. TypeScript erases a `import type`, so
// today the module graph has one edge and no loop; make it a runtime
// import and the two modules initialise into each other — whichever
// evaluates second reads the other's bindings before they exist, and the
// shell crashes on a temporal-dead-zone error at first paint, in the one
// code path that has no working screen to report it on.
import type { ApiClient } from '../api.js';

/*
 * What Auto-MB does when the connection goes.
 *
 * The shape of this is settled in `docs/UX.md` § 23 and it is
 * deliberately narrow. Three things happen and nothing else does:
 *
 *   1. the application still opens, because the service worker holds the
 *      shell (`src/service-worker.ts`);
 *   2. a register that was already read stays readable, from the copy
 *      kept here, under a banner that says when the copy was taken;
 *   3. every write is refused before it leaves the browser (`src/api.ts`),
 *      with the refusal each screen already renders for a server refusal.
 *
 * There is no mutation queue and no replay. This product's outward
 * documents are numbered from gap-free per-Work counters, guarded by
 * lifecycle locks and approvals, and issued as immutable snapshots; a
 * challan queued on a phone at a yard and replayed an hour later would
 * be asking the server for a number in an order nobody chose, against a
 * Work whose state has moved. Refusing is the honest answer, and it is
 * the one the operator can act on.
 */

/**
 * Whether the browser is CERTAIN there is no network.
 *
 * `navigator.onLine === false` is the only half of that property worth
 * reading: false means no interface is up, so nothing can succeed, while
 * true means a cable is plugged in and says nothing about whether the
 * server is reachable. Every decision here is therefore keyed on the
 * false half, and a request that fails while the browser believes itself
 * online is treated as an ordinary outage, which is what it is.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function subscribeToConnectivity(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Re-renders on every connectivity change. The server snapshot is
 * `true`: nothing is pre-rendered here, and a component that assumed an
 * offline start would flash its offline copy on every load. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnectivity,
    () => !isOffline(),
    () => true,
  );
}

/* ---------------------------------------------------------------- cache */

interface CacheEntry {
  /** When the live read that produced this actually answered. */
  readonly cachedAt: string;
  readonly value: unknown;
}

/**
 * Who the cache belongs to, as one opaque string.
 *
 * The cache is bound to a user AND an organisation, and it holds nothing
 * at all while it is unbound. That is the whole tenancy story here: a
 * read is written under a key that names the account and the tenant it
 * was read for, it can only be served back under the identical key, and
 * changing either key throws the previous contents away rather than
 * carrying them across. A site machine shared between a store clerk and
 * a site engineer cannot show one the other's registers, and switching
 * organisations cannot show the wrong tenant's.
 *
 * It lives in memory and nowhere else. `localStorage` and Cache Storage
 * both survive sign-out and both are readable by the next person at the
 * keyboard; a Map dies with the tab. The cost is that a reload while
 * offline starts empty, which is the honest position anyway — see
 * `docs/UX.md` § 23 on why a cold start does not restore a workspace.
 */
let binding: string | null = null;

const cache = new Map<string, CacheEntry>();

/**
 * How many reads are kept.
 *
 * Small on purpose: this holds the registers an operator walked through
 * before the signal went, not a copy of the tenant. The map is ordered by
 * last write, so the oldest entry is the one that goes.
 */
const CACHE_LIMIT = 40;

/**
 * Binds the cache to one signed-in account in one organisation, or
 * clears it entirely when passed null.
 *
 * Called from `App.tsx` on every phase change. Passing the same binding
 * twice is a no-op, which is what lets that call sit in an effect keyed
 * on a phase object that is replaced on every state change.
 */
export function bindOfflineCache(
  next: { readonly userId: string; readonly organisationId: string } | null,
): void {
  const key = next === null ? null : `${next.userId}\0${next.organisationId}`;
  if (key === binding) return;
  binding = key;
  cache.clear();
  clearCachedReadNotice();
}

function remember(key: string, value: unknown): void {
  // Delete first so a re-read moves the entry to the end of the map and
  // the eviction below takes the least recently written.
  cache.delete(key);
  cache.set(key, { cachedAt: new Date().toISOString(), value });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/* ------------------------------------------------------- staleness notice */

/** The oldest copy served since the connection went. Null when nothing
 * on screen came from the cache. */
let servedAt: string | null = null;
const noticeListeners = new Set<() => void>();

function announceNotice(): void {
  for (const listener of noticeListeners) listener();
}

function noteCachedRead(cachedAt: string): void {
  // The OLDEST, because the banner's sentence is a promise about
  // everything on screen: a reader told "saved at 14:32" must not be
  // looking at a column read at 09:10.
  if (servedAt !== null && servedAt <= cachedAt) return;
  servedAt = cachedAt;
  announceNotice();
}

/** Forgets the staleness notice. Called when the connection returns, at
 * which point every screen reads live again and the sentence would be a
 * lie the moment it was still on screen. */
export function clearCachedReadNotice(): void {
  if (servedAt === null) return;
  servedAt = null;
  announceNotice();
}

function subscribeToNotice(onChange: () => void): () => void {
  noticeListeners.add(onChange);
  return () => {
    noticeListeners.delete(onChange);
  };
}

/** When the oldest cached copy on screen was read, as an ISO instant. */
export function useCachedReadAt(): string | null {
  return useSyncExternalStore(
    subscribeToNotice,
    () => servedAt,
    () => null,
  );
}

/* ------------------------------------------------------------- the wrapper */

type Read<A extends readonly unknown[], R> = (...args: A) => Promise<R>;

/**
 * One register read, with a copy kept and served back when the live read
 * fails AND the browser says there is no network.
 *
 * Both halves of that condition matter. Serving the copy on any failure
 * would answer a 403 with records the caller may no longer see, and
 * would answer a 500 with a register that looks live; the operator would
 * have no way to tell a stale screen from a current one, which is worse
 * than the honest failure state every register already renders.
 *
 * The binding is captured on the way in and checked again on the way
 * out. A read started before an organisation switch and answered after
 * it must not be written into the new tenant's cache, and a copy taken
 * before the switch must not be served after it.
 */
function cachedRead<A extends readonly unknown[], R>(
  name: string,
  read: Read<A, R>,
): Read<A, R> {
  return async (...args: A): Promise<R> => {
    const owner = binding;
    const key = owner === null ? null : `${owner}\0${name}\0${JSON.stringify(args)}`;
    try {
      const value = await read(...args);
      if (key !== null && owner === binding) remember(key, value);
      return value;
    } catch (cause) {
      if (key === null || owner !== binding || !isOffline()) throw cause;
      const entry = cache.get(key);
      if (entry === undefined) throw cause;
      noteCachedRead(entry.cachedAt);
      return entry.value as R;
    }
  };
}

/**
 * The reads that survive the connection going, and only these.
 *
 * Each one is a whole screen's worth of data on its own, which is the
 * bar: a register that renders four of its nine panels and errors on the
 * rest is a screen nobody can trust. The Dashboard, the Works register,
 * the Delivery Challan register and the Installations register each read
 * one list and draw it (`listLoaDocuments` is the second half of the
 * Works register's single load). Everything else — the Work workspace,
 * the editors, Masters, Search — reads several endpoints or writes, and
 * is left to fail honestly.
 *
 * Wrapping the client rather than the views is what keeps this one
 * decision in one file: no register changes, no view learns a second way
 * to load, and the list above is the entire policy.
 *
 * TWO PROPERTIES OF THE CACHE KEY, both currently harmless and neither
 * to be relied on. `cachedRead` keys on `JSON.stringify(args)`.
 *
 * It collapses `undefined` and `null` IN PLACE: `[org, undefined]` and
 * `[org, null]` both serialise to `[<org>,null]`, and an options property
 * set to `undefined` serialises identically to one omitted. It does NOT
 * collapse arity — `[org]` is `[<org>]`, a different string from
 * `[<org>,null]` — so a trailing argument left off keys separately from
 * the same argument passed explicitly. Here that only ever splits one
 * request across two entries (`listDeliveryChallans` defaults `workId` to
 * null and both spellings mean the whole register), which costs a little
 * storage and never serves the wrong answer.
 *
 * The in-place collapse becomes live the moment a filtered register joins
 * this list and `null` starts meaning something `undefined` does not — at
 * which point the key needs a discriminator, not a second cache.
 *
 * `listInstallations` now takes a `sort`, and that is safe under both
 * rules: the parameter is inside the options object and is OMITTED rather
 * than set to `undefined` when the register is read in its default order,
 * so an ascending read keys separately from a descending one and neither
 * can be served the other's rows.
 *
 * WHAT IS NOT OFFERED OFFLINE, stated rather than pretended: changing the
 * sort on a register that PAGES is a new read, so offline it can only be
 * answered from a cached entry for that exact sort. The first time an
 * operator reverses the installations register with no connection, the
 * screen shows its load failure and its retry — the rows are not re-drawn
 * from the previous order, because a table showing descending rows under
 * an ascending heading is a worse answer than an honest failure. The tax
 * invoice register is not cached here at all (it reads several endpoints)
 * and behaves the same way for the same reason.
 */
export function withOfflineReads(api: ApiClient): ApiClient {
  return {
    ...api,
    dashboard: cachedRead('dashboard', api.dashboard),
    listWorks: cachedRead('listWorks', api.listWorks),
    listLoaDocuments: cachedRead('listLoaDocuments', api.listLoaDocuments),
    listDeliveryChallans: cachedRead('listDeliveryChallans', api.listDeliveryChallans),
    listInstallations: cachedRead('listInstallations', api.listInstallations),
  };
}
