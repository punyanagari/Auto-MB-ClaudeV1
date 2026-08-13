import { defineConfig } from 'vitest/config';

/**
 * The suite the weekly mutation run executes (`stryker.config.json`).
 *
 * Stryker re-runs tests once per surviving-or-killed mutant, so the suite it
 * drives has to be fast and self-contained. This config selects only the
 * unit tests that cover the four mutated invariant modules: no PostgreSQL,
 * no Fastify boot, no Gotenberg. The ordinary `vitest run` in this package
 * is unaffected — it has no config file and keeps discovering every test.
 *
 * Keep this list in step with `mutate` in `stryker.config.json`: a mutated
 * file whose tests are not listed here reports a survival that means
 * "nothing ran", not "nothing caught it".
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/mb-compute.test.ts',
      'test/executed-value.test.ts',
      'test/number-series.test.ts',
      'test/origin-guard.test.ts',
    ],
  },
});
