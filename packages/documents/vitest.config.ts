import { defineConfig } from 'vitest/config';

// Package-local config. `passWithNoTests` stays unset, as everywhere else
// in this repository, so the package cannot go green without running the
// suites that moved here with the modules.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
});
