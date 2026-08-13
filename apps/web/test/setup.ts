import { configure } from '@testing-library/dom';

/**
 * Vitest setup for the web package.
 *
 * Testing Library's `findBy*` helpers give up after one second by
 * default. That was long enough while every view was imported statically
 * and mounted synchronously; the views are now code-split
 * (`views/OperationsWorkspace.tsx`), so the first render of a screen in a
 * test waits for a dynamic import that Vite transforms on demand — and
 * under the load of the whole workspace's suites running at once, that
 * has taken longer than a second.
 *
 * Raising the ceiling costs nothing when the wait is short: these helpers
 * poll and return the moment the element appears. No test in this package
 * asserts absence by waiting for a `findBy*` to reject.
 */
configure({ asyncUtilTimeout: 10_000 });
