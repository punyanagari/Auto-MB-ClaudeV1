import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Milestone 1 UI is the first real workflow, so the earlier
// passWithNoTests exception is gone: this package must never go green
// without executing its suites. Component tests opt into jsdom with a
// per-file @vitest-environment pragma; api tests run in node.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
  },
});
