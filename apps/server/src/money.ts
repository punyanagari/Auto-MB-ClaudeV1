/**
 * Rupee decimal text to integer paise, and back, exactly.
 *
 * WHY BIGINT. Authoritative money in this schema is `numeric(18,2)` — the
 * `money_amount` domain, migration 0065 — and PostgreSQL hands it over as
 * TEXT precisely so it never round-trips a JavaScript float. Eighteen
 * digits overflow `Number.MAX_SAFE_INTEGER` outright, and well inside that
 * range 0.1 + 0.2 is already not 0.3, so every sum, difference and
 * comparison of money runs on integer paise in BigInt. There is no
 * `Number()` in this file, deliberately.
 *
 * THE STRING FORMAT is the one the database writes and the wire reads: an
 * optional leading '-', a run of digits, and at most two fraction digits.
 * `paiseText` always emits exactly two of them ('12' in, '12.00' out),
 * which is the shape every consumer of these figures already expects.
 *
 * DELIBERATELY REJECTED — no rounding, no coercion, no silent truncation:
 *   - sub-paisa scale ('1.005'). A third fraction digit means the figure
 *     did not come from a money column, and rounding it here would invent
 *     an authoritative amount rather than report a broken one.
 *   - exponent notation ('1e5'), a leading '+', an empty or blank string,
 *     and anything else that is not a plain decimal lexeme.
 * Surrounding whitespace is trimmed, and NEGATIVES ARE ACCEPTED:
 * `money_amount` carries no sign CHECK on purpose (0065), and the
 * difference of two amounts is legitimately negative.
 *
 * WHAT THIS DOES NOT REPLACE. Three other sites in this server parse the
 * same lexemes and keep their own parser on purpose; folding them in here
 * would change behaviour, so do not.
 *   - `tax-invoice-snapshot.ts`'s `scaledPaise` throws a typed
 *     `TaxInvoiceSnapshotError` naming the JSON path, and three routes map
 *     that class onto a 409 with the `TAX_INVOICE_SNAPSHOT_INVALID` code.
 *     A plain Error from here would turn those refusals into 500s.
 *   - `gsp/eway-payload.ts`'s `toPaise` ACCEPTS trailing-zero over-scale
 *     ('100.000' is 10000 paise) because the snapshot grammar it reads
 *     from permits any number of fraction digits, and it names genuine
 *     sub-paisa precision in a message of its own. It is laxer than this
 *     one by design.
 *   - `executed-value.ts`'s `parsePaise` labels its message with the
 *     figure's role, and its formatter is parameterised by scale because
 *     the same arithmetic also emits four-place percentages.
 * What all four DO share is the formatter below, which is byte-identical
 * in every one of them. That is the whole of the overlap.
 */

/** Exact rupee decimal text to integer paise. Throws on anything that is
 * not a two-decimal money lexeme; see the header for what that excludes. */
export function toPaise(text: string): bigint {
  // Fully anchored, one digit run then a fraction bounded to two digits.
  // Each repetition consumes a digit no other branch can also consume, so
  // this is linear on every input.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) {
    throw new Error(`not an exact money figure: ${JSON.stringify(text)}`);
  }
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -(whole * 100n + fraction) : whole * 100n + fraction;
}

/** Integer paise back to rupee decimal text, always with two fraction
 * digits. The inverse of `toPaise` on everything `toPaise` accepts. */
export function paiseText(paise: bigint): string {
  const sign = paise < 0n ? '-' : '';
  const absolute = paise < 0n ? -paise : paise;
  return `${sign}${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
