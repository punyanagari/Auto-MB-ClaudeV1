import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API origin follows the same environment variables the server reads
// (main.ts: API_HOST/API_PORT), so a non-default port cannot silently break
// the dev proxy.
const apiTarget = `http://${process.env.API_HOST ?? '127.0.0.1'}:${process.env.API_PORT ?? '3000'}`;

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
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(process.env.WEB_PORT ?? '5173'),
      proxy: {
        '/api': apiTarget,
        '/documentation': apiTarget,
      },
    },
  };
});
