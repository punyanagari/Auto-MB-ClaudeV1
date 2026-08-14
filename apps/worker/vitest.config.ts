import { defineConfig } from 'vitest/config';

// `passWithNoTests` was a deliberate, temporary exception while the worker
// was a process boundary that logged and blocked, with no job logic. Pack
// P18 landed that logic, so the exception is spent and the flag is gone:
// this package now fails, like every other, if it has nothing to run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.{js,ts}'],
  },
});
