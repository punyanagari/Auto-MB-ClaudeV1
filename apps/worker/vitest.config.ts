import { defineConfig } from 'vitest/config';

// passWithNoTests is a deliberate, temporary exception: the worker is a
// process boundary that logs and blocks, with no job logic. Remove the flag
// when the first real async workflow (pg-boss) lands.
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
});
