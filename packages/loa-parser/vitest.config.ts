import { defineConfig } from 'vitest/config';

// Package-local config so `pnpm --filter @auto-mb/<pkg> test` runs THIS
// package's tests instead of resolving the repo-root vitest.config.ts, whose
// `include: packages/**` (relative to the package cwd) matches nothing and
// whose root-level passWithNoTests turns that into a vacuous green exit —
// the false-green class tickets/DC-1.md criterion 4 exists to prevent.
// passWithNoTests is deliberately NOT set here: with a local config the
// default (fail when no test file matches) is the discriminating behavior
// every later ticket's verify line depends on.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
});
