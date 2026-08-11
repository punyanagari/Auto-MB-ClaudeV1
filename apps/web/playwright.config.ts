import { defineConfig } from '@playwright/test';

const requestedPort = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error('PLAYWRIGHT_PORT must be an integer between 1 and 65535.');
}
const baseURL = `http://127.0.0.1:${requestedPort}`;
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true';

// Browser accessibility/security smoke (docs/SECURITY.md: activates with
// the first accepted browser workflow). Runs against the real production
// bundle via vite preview with the API mocked at the network layer, so it
// needs no database. PLAYWRIGHT_CHROMIUM_PATH points at a system Chromium
// when the pinned browser download is unavailable (e.g. sandboxed dev
// environments); CI installs the matching browser instead.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL,
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
          },
        }
      : {}),
  },
  // The bundle is built by a separate `pnpm build` step (CI does this
  // explicitly) so the webServer only serves; its output is piped so a
  // startup failure is visible instead of a silent timeout. The host is
  // pinned to 127.0.0.1 because "localhost" can resolve to ::1 on CI
  // runners, leaving the IPv4 readiness probe waiting forever.
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${requestedPort} --strictPort`,
    url: baseURL,
    reuseExistingServer,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
