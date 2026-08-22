import { expect } from 'vitest';

/**
 * The export format version every test pins, in ONE place.
 *
 * Four suites assert `formatVersion` — the challan, integrity,
 * measurement-book and PDF-signature-evidence integration tests — because
 * each of them already builds a full organisation and reads the package,
 * and each has a distinct reason to care that the format it is reading is
 * the format it was written against.
 *
 * They used to hold four copies of the string, which made a version bump
 * a four-file edit and, in a wave with concurrent packs, four serial merge
 * conflicts on lines whose correct value nobody can check by reading the
 * diff. One constant makes it a one-line edit and a merge that either
 * takes yours or takes theirs, visibly.
 *
 * It is deliberately NOT imported from `routes/export.ts`. A test that
 * asserts a constant against itself asserts nothing; this is the value the
 * suite EXPECTS, and bumping the server's own constant without bumping
 * this one is exactly the mistake the assertions exist to catch.
 */
// WAVE T3 — v41, claimed on top of T2's v40 (merged).
//
// A branch that has not yet been allocated a number writes the SENTINEL
// below in this file AND in `apps/server/src/routes/export.ts`, rather than
// claiming one. Two branches claiming the same number auto-merge silently
// — that is what happened to v37 two waves ago — whereas two branches
// holding the sentinel cannot collide at all, and
// `scripts/check-export-sentinel.mjs` fails if the sentinel survives onto
// main without the coordinator assigning a concrete version.
export const EXPECTED_EXPORT_VERSION = 'export-v41';

/**
 * The placeholder a feature branch holds instead of claiming a version.
 * Kept in step with `scripts/check-export-sentinel.mjs`, which is the check
 * that stops it reaching main.
 *
 * Annotated `string` on purpose: without it TypeScript narrows both
 * constants to their own literal types and rejects the comparison below as
 * impossible — which it is on any given branch, and is exactly the state
 * that has to be testable.
 */
export const EXPORT_VERSION_SENTINEL: string = 'export-vNEXT';

/**
 * Asserts the exported package carries the pinned format version — unless
 * the version has not been assigned yet, in which case there is nothing to
 * pin and the assertion is skipped.
 *
 * Either side holding the sentinel means "unassigned": the route because a
 * branch set it there, this file because the same branch set it here. The
 * check that the skip is temporary is not in the suite, it is
 * `pnpm export:check` — a suite cannot know whether a merge has happened.
 */
export function expectPinnedExportVersion(actual: unknown): void {
  if (
    actual === EXPORT_VERSION_SENTINEL ||
    EXPECTED_EXPORT_VERSION === EXPORT_VERSION_SENTINEL
  ) {
    return;
  }
  expect(actual).toBe(EXPECTED_EXPORT_VERSION);
}
