/**
 * The offline application shell.
 *
 * This file is not part of the application bundle. `vite.config.ts` reads
 * it at build time, strips the types, substitutes the build's own asset
 * list into `AUTO_MB_BUILD` below, and emits the result at the root of
 * the build output under the fixed name the browser fetches it by, so
 * its scope is the whole origin. `src/main.tsx` registers it, and only
 * in a production build.
 *
 * What it is for, and what it deliberately is not:
 *
 * 1. WITHOUT it, opening Auto-MB with no connection produces the
 *    browser's own error page. The operator cannot tell a dead network
 *    from a dead product. With it, the application itself opens and says
 *    what it can and cannot do (`docs/UX.md` § 23).
 *
 * 2. It caches the SHELL — the document and the hashed build assets —
 *    and nothing else. `/api/**` is passed straight through, untouched
 *    and uncached, every time. That is not an optimisation left undone:
 *    a Cache Storage bucket is keyed by ORIGIN, so anything put there
 *    survives sign-out and is readable by whoever signs in next on a
 *    shared site machine. Tenant records are held in memory by
 *    `src/lib/offline.ts` instead, keyed per user and per organisation,
 *    and they die with the tab.
 *
 * 3. The document is fetched NETWORK-FIRST, falling back to the copy
 *    taken at install. `index.html` is the one file in the build whose
 *    name carries no content hash, so it is the one file a cache-first
 *    rule could pin for ever — and pinning it pins the asset names
 *    inside it, which is how a service worker serves a bundle from six
 *    deploys ago until somebody clears their browser. Hashed assets go
 *    cache-first because their names ARE their content.
 *
 * 4. It never calls `skipWaiting()`. A worker that activates while a tab
 *    is open swaps the asset cache underneath a running application, and
 *    the next lazily-loaded view is then fetched by an old document from
 *    a new cache. The replacement worker waits until the pages using the
 *    old one have gone, and only then deletes the caches of every
 *    previous build.
 */

/* Everything is inside one function so that no name here reaches the
 * global scope, and so that the worker-only types below can be declared
 * locally. TypeScript's WebWorker library cannot be added to this
 * package's `lib` — it collides with `DOM`, which the rest of `src`
 * needs — so the three shapes this file touches are written out
 * instead. */
(() => {
  interface WorkerLifecycleEvent {
    waitUntil: (work: Promise<unknown>) => void;
  }

  interface WorkerFetchEvent {
    readonly request: Request;
    respondWith: (response: Promise<Response>) => void;
  }

  interface WorkerScope {
    addEventListener: {
      (
        type: 'install' | 'activate',
        listener: (event: WorkerLifecycleEvent) => void,
      ): void;
      (type: 'fetch', listener: (event: WorkerFetchEvent) => void): void;
    };
    readonly clients: { claim: () => Promise<void> };
  }

  const worker = globalThis as unknown as WorkerScope;

  /**
   * The build this worker belongs to: a revision derived from the asset
   * names, and the shell files to hold before it will claim to work
   * offline at all.
   *
   * The quoted token is replaced by `vite.config.ts` with a JSON string
   * literal. That build step fails loudly when the token is missing, so
   * an un-substituted worker is never emitted.
   */
  const AUTO_MB_BUILD = JSON.parse('__AUTO_MB_BUILD__') as {
    readonly revision: string;
    readonly precache: readonly string[];
  };

  /** One cache per build. The prefix is what `activate` sweeps, so a
   * cache from any previous revision is deleted rather than the browser
   * accumulating a copy of every bundle it has ever seen. */
  const CACHE_PREFIX = 'auto-mb-shell-';
  const CACHE_NAME = `${CACHE_PREFIX}${AUTO_MB_BUILD.revision}`;

  /** The document, under one name whatever address was navigated to. The
   * server answers every client-side route with this file
   * (`deploy/Caddyfile`), so caching it per-URL would store the same
   * bytes once per screen the operator has ever opened. */
  const SHELL_URL = '/index.html';

  worker.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.addAll([...AUTO_MB_BUILD.precache])),
    );
  });

  worker.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        for (const name of await caches.keys()) {
          if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) {
            await caches.delete(name);
          }
        }
        // Claimed only once the sweep is done, so the first page this
        // worker controls cannot be served a half-deleted cache.
        await worker.clients.claim();
      })(),
    );
  });

  /**
   * Whether this is one of the build's own immutable files.
   *
   * Vite emits every chunk, stylesheet and font under `/assets/` with a
   * content hash in the name, which is what makes cache-first safe for
   * them and only them. Anything else — the API, a streamed PDF, another
   * origin — is left to the network.
   */
  function isBuildAsset(url: URL): boolean {
    return url.origin === location.origin && url.pathname.startsWith('/assets/');
  }

  /**
   * The document: the network's answer while there is one, and the copy
   * taken at install when there is not.
   *
   * The copy is NEVER refreshed from a later fetch, and that is the
   * point. `index.html` names the asset files, and this worker installed
   * exactly one set of them. Re-caching a document fetched after a deploy
   * would leave the cache holding a NEW page that names assets this
   * worker never installed, and the first offline visit after that deploy
   * would open a blank screen — the failure the whole file exists to
   * prevent, arrived from the other direction. Installed together, served
   * together: the pair is only ever replaced by a whole new worker.
   *
   * The cost is one narrow case: an `index.html` edited with no asset
   * change at all produces no new revision, so the offline copy stays a
   * version behind until the next build that changes a file. Anyone
   * ONLINE has the current document either way, because this is
   * network-first.
   */
  async function documentResponse(request: Request): Promise<Response> {
    try {
      return await fetch(request);
    } catch (unreachable) {
      /* The GLOBAL `caches.match`, across every bucket, and it must stay
       * that way: narrowing it to CACHE_NAME breaks the handoff window.
       * A new worker installs its cache and then WAITS (see 4 above) —
       * during that wait the pages still being served are the old
       * build's, and after the sweep in `activate` the only shell left is
       * the new one. Either way the copy that answers may live under a
       * revision other than the one this closure names. The cross-cache
       * lookup is what makes both ends of that window serve a document
       * instead of the browser's error page. */
      const cached = await caches.match(SHELL_URL);
      if (cached !== undefined) return cached;
      throw unreachable;
    }
  }

  async function assetResponse(request: Request): Promise<Response> {
    /* Global again, for the same handoff reason as above, and it costs
     * nothing here: asset names carry a content hash, so a hit found in
     * an older build's cache is byte-identical to what this one would
     * have stored. Writes below still go to CACHE_NAME, which is what
     * lets `activate` sweep a whole build at once. */
    const cached = await caches.match(request);
    if (cached !== undefined) return cached;
    const response = await fetch(request);
    /* `basic` is a same-origin response the worker may actually read. An
     * opaque or errored one is passed on but never stored: storing it
     * would pin a failure under a name whose content can never change. */
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  }

  worker.addEventListener('fetch', (event) => {
    const { request } = event;
    // A write is never replayed from here. `respondWith` is not called
    // for anything but a GET, so the browser sends it exactly as the
    // application asked and the application handles the failure — see
    // the offline refusal in `src/api.ts`.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== location.origin) return;
    // The API carries tenant records, session cookies and streamed
    // documents. None of it is ever written to an origin-scoped cache.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
    if (url.pathname.startsWith('/documentation')) return;

    if (request.mode === 'navigate') {
      event.respondWith(documentResponse(request));
      return;
    }
    if (isBuildAsset(url)) event.respondWith(assetResponse(request));
  });
})();
