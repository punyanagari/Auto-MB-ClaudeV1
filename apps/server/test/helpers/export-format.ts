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
// Renumbered from v37 to v39 at the merge with #164, together with
// `EXPORT_FORMAT_VERSION` in `apps/server/src/routes/export.ts`, which
// carries the reasoning. The two auto-merge silently against each other,
// so they move by hand or not at all.
export const EXPECTED_EXPORT_VERSION = 'export-v39';
