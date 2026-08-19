/**
 * The order a schedule's item numbers are read in.
 *
 * Item numbers are minted as `<scheduleId>/<itemSno>` — `A1/1`, `A1/2`,
 * `A1/10` — and the column holding them is `text`, so both Postgres
 * `ORDER BY item_number` and a bare `localeCompare` sort them one
 * character at a time: A1/1, A1/10, A1/11, A1/2, A1/3. A schedule of
 * more than nine items therefore prints in an order no schedule is
 * written in, and the operator reconciling a printed letter against the
 * screen has to hunt for every row past the ninth.
 *
 * `Intl.Collator` with `numeric: true` compares runs of digits as
 * numbers and everything else as text, which is exactly the reading the
 * letter uses: it gets A1/2 before A1/10 AND A2/1 before A10/1, without
 * this module having to know how many segments an item number has or
 * what separates them. Hand-rolled segment splitting would have to, and
 * would then have to be right about `A-1.2(b)` too.
 *
 * ONE collator instance, constructed once: `Intl.Collator` is expensive
 * to build and a comparator is called O(n log n) times.
 *
 * `'en'` explicitly, never `undefined`: `undefined` resolves the RUNTIME
 * locale, so the same two item numbers could sort one way on a server in
 * one region and another way in a browser in another. An item number is
 * a document identifier, not prose — its order is a property of the
 * document, not of who is reading it. (This is also the locale the sort
 * it replaced passed to `localeCompare`.)
 *
 * Collation is not a total order on its own: `A/1` and `A/01` compare
 * EQUAL under `numeric: true`, and item numbers are operator-editable
 * text, so both can exist on one Work. A comparator that returns 0 for
 * two different strings leaves their relative order to whichever sort
 * implementation ran — and the server's and the browser's are not the
 * same one. The raw-string tiebreak below makes the order total, which
 * is what lets a stored line order and a rendered one agree.
 *
 * It lives in `contracts` because the server and the web both order the
 * same list: the server sorts what it reads out of the database, the LOA
 * review screen sorts rows that have no database row yet, and two copies
 * of this rule is how the review screen comes to show a different order
 * from the Work it creates.
 */
const collator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'variant',
});

/** Comparator for `item_number` / `itemNumber` values. Total: ties under
 * the collator fall back to a plain code-unit comparison. */
export function compareItemNumbers(left: string, right: string): number {
  const collated = collator.compare(left, right);
  if (collated !== 0) return collated;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorts a copy by item number, leaving the caller's array alone. */
export function byItemNumber<T extends { readonly itemNumber: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) =>
    compareItemNumbers(left.itemNumber, right.itemNumber),
  );
}
