import { defineConfig } from 'vitest/config';

// Package-local config: passWithNoTests is deliberately NOT set, so the run
// fails if no test file matches — this package must never go green vacuously
// while its regression corpus exists.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
});
