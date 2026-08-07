import { defineConfig } from '@playwright/test';

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
    baseURL: 'http://127.0.0.1:4173',
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
          },
        }
      : {}),
  },
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
