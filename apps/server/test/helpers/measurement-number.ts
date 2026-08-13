import type { MeasurementNumberParts } from '../../src/railway-bill-parse.js';

/**
 * The `L2` -> `FL2` normalisation, as a comparison between two RAILWAY
 * documents.
 *
 * A Measurement Book prints `.../OAM/L2/01` and the bill raised from it
 * prints `.../OAM/FL2/01`. Folding the ledger token away is what makes
 * those two strings comparable, and comparing them is what the settlement
 * corpus's manifest asserts about its own nine documents.
 *
 * It lives here rather than in `src/` because the product holds only ONE
 * side of that comparison. A received bill is linked to a Measurement Book
 * by measurement SEQUENCE — the bill's `.../L2|FL2/NN` taken apart, against
 * the book's own `sequence_number` — so production never puts two railway
 * measurement numbers side by side and never needs this. Keeping it in
 * `src/` would have been a production export with no production caller,
 * which is the speculative-framework shape `AGENTS.md` rule 1 refuses and
 * the sort of thing pack P1 spent a day deleting.
 *
 * If the MB-copy upload that migration 0060 anticipates ever lands, the
 * product WILL hold both sides, and this moves back with a caller.
 */
export function canonicalMeasurementNumber(parts: MeasurementNumberParts): string {
  // Both spellings normalise to one, rather than `L2` being rewritten into
  // `FL2`: the direction does not matter, and "drop the finalisation
  // marker" stays true if a third spelling ever appears.
  const ledger = parts.ledger.startsWith('F') ? parts.ledger.slice(1) : parts.ledger;
  return `${parts.contractNumber}/${parts.stationCode}/${parts.cmbSuffix}/OAM/${ledger}/${String(parts.sequence)}`;
}

/** True when a book and a bill name the same measurement. */
export function sameMeasurement(
  a: MeasurementNumberParts,
  b: MeasurementNumberParts,
): boolean {
  return canonicalMeasurementNumber(a) === canonicalMeasurementNumber(b);
}
