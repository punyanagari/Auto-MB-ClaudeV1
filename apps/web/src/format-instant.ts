/**
 * One formatter, in its own module, for one bundling reason.
 *
 * `formatTimestamp` used to sit in `src/format.ts` with the rest of the
 * display helpers, and it still reads as part of that module: `format.ts`
 * re-exports it and every existing caller imports it from there.
 *
 * The offline banner (`src/ui/offline-banner.tsx`) is the first caller
 * that lives in the application SHELL rather than in a code-split view,
 * and the shell reaching into `format.ts` costs 36 kB gzip on the initial
 * payload. Not because of these ten lines: the bundler groups modules by
 * which entry points reach them, and `format.ts` currently shares that
 * grouping with `@auto-mb/contracts` and the TypeBox runtime behind it,
 * so pulling the one drags the other. Splitting the single function the
 * shell needs into a leaf module of its own leaves that grouping alone.
 *
 * Nothing else moved, and nothing else should move here speculatively —
 * the next display helper the shell needs is the reason to move the next
 * one.
 */

const viewerInstantFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Instant with wall-clock time in the viewer's zone — used where a
 * deadline is a moment, not a day (NIC's 24-hour IRN cancellation
 * window), and where a cached copy has to say when it was taken.
 * Anything unparseable passes through. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return viewerInstantFormat.format(parsed);
}
