import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';

// The API origin follows the same environment variables the server reads
// (main.ts: API_HOST/API_PORT), so a non-default port cannot silently break
// the dev proxy.
const apiTarget = `http://${process.env.API_HOST ?? '127.0.0.1'}:${process.env.API_PORT ?? '3000'}`;

/** The token `src/service-worker.ts` carries where its build manifest
 * goes. Matched with either quote because esbuild normalises string
 * literals as it strips the types. */
const BUILD_TOKEN = /(['"])__AUTO_MB_BUILD__\1/;

/**
 * Emits the offline shell's worker script, at the root of the build
 * output, with this build's own file list baked into it.
 *
 * The worker is written as ordinary TypeScript under `src` so that it is
 * type-checked, linted and reviewed like the rest of the client, but it
 * is NOT part of the application bundle — a service worker has to sit at
 * the site root to claim the whole origin as its scope, and it must not
 * be hashed, because the browser fetches it by a fixed name. So it is
 * read here, stripped of its types, and emitted as one plain file.
 *
 * The precache list is the document plus the INITIAL payload: the entry
 * chunk, everything it statically imports, and the stylesheets. That is
 * exactly the set `scripts/check-bundle-size.mjs` measures, and exactly
 * what has to be present for the application to paint. The lazily-loaded
 * view chunks and the fonts are deliberately left out of the install and
 * cached as they are used — precaching them would mean downloading the
 * whole product on first visit to buy an offline screen the operator may
 * never open.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'auto-mb-service-worker',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const precache = new Set<string>(['/index.html']);
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          precache.add(`/${file.fileName}`);
        }
      }

      /* The entry chunk and its static import graph. Read off the bundle
       * rather than off the built `index.html`, because at this point the
       * HTML has not been written yet — and because a name the bundle
       * does not contain would fail `cache.addAll` at install time, which
       * silently leaves the worker uninstalled and the promise of an
       * offline shell unkept. */
      const walked = new Set<string>();
      const walk = (fileName: string): void => {
        if (walked.has(fileName)) return;
        walked.add(fileName);
        const chunk = bundle[fileName];
        if (chunk === undefined || chunk.type !== 'chunk') return;
        precache.add(`/${chunk.fileName}`);
        for (const imported of chunk.imports) walk(imported);
      };
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry) walk(file.fileName);
      }

      const manifest = {
        /* The revision IS the file list. Two builds whose assets are
         * byte-identical share a cache; a build that changed anything at
         * all gets a new one, and `activate` deletes the old. */
        revision: createHash('sha256')
          .update([...precache].sort().join('\n'))
          .digest('hex')
          .slice(0, 16),
        precache: [...precache].sort(),
      };

      const source = await readFile(
        fileURLToPath(new URL('./src/service-worker.ts', import.meta.url)),
        'utf8',
      );
      const { code } = await transformWithEsbuild(source, 'service-worker.ts', {
        loader: 'ts',
        target: 'es2022',
      });
      if (!BUILD_TOKEN.test(code)) {
        throw new Error(
          'the service worker no longer carries its __AUTO_MB_BUILD__ token, so it ' +
            'would ship with no file list and never work offline.',
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: code.replace(BUILD_TOKEN, JSON.stringify(JSON.stringify(manifest))),
      });
    },
  };
}

export default defineConfig(({ command }) => {
  /* `vite build` produces the bundle that ships — the one Dockerfile.web
   * copies into the Caddy image — so it is built for production whatever
   * the shell says. Vite derives that from an ambient NODE_ENV when one
   * is set, and the repository's own test runs set NODE_ENV=test; a
   * `pnpm build` from such a shell silently resolved React's DEVELOPMENT
   * runtime into the bundle (520 kB entry against 315 kB, with the dev
   * warning paths and their cost). Nothing in CI or the image sets
   * NODE_ENV, so what deploys today is correct; this closes the gap
   * between that and what a developer or a future workflow can build. */
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
    server: {
      port: Number(process.env.WEB_PORT ?? '5173'),
      proxy: {
        '/api': apiTarget,
        '/documentation': apiTarget,
      },
    },
  };
});
