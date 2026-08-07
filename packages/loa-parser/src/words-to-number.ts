/**
 * @auto-mb/loa-parser — Indian-numbering currency words -> number (DC-23;
 * legacy ticket DC-23: "Contract value in figures vs words are both captured;
 * a mismatch raises needsReview rather than the parser picking one").
 *
 * Detecting a mismatch requires actually comparing the two representations,
 * not merely capturing both — so this module parses the corpus's
 * `Rupees <integer-words> Rupees And <decimal-words> Paise Only` template
 * (verified against all six fixtures' contract-value and
 * performance-guarantee amounts) using the Indian lakh/crore grouping
 * (10^2, 10^3, 10^5, 10^7 — NOT the short-scale 10^3/10^6/10^9 grouping).
 *
 * IREPS's own spelling of "Forty" is "Fourty" throughout the corpus
 * (verified: every occurrence of the tens-word for 40 in all six fixtures
 * reads "Fourty"). Both spellings are accepted defensively.
 */

const ONES: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40, // IREPS's own (nonstandard) spelling — see module doc.
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

// Indian numbering: lakh = 10^5, crore = 10^7 — distinct from the short-scale
// million/billion grouping. "Hundred" is handled separately below because it
// multiplies the CURRENT accumulator in place ("Four Hundred" = 400 while the
// accumulator keeps growing), whereas thousand/lakh/crore FLUSH the
// accumulator into the running total (research corpus vocabulary, §3).
const SECTION_MULTIPLIERS: Readonly<Record<string, number>> = {
  thousand: 1000,
  lakh: 100000,
  lac: 100000,
  crore: 10000000,
};

/**
 * Parses an Indian-numbering words phrase (e.g. "Sixteen Crore Ninety-Two
 * Lakh Twenty-Eight Thousand Four Hundred And Ninety-Seven") into an
 * integer. Returns null on any unrecognised token — never a partial/guessed
 * number — so callers can route an unparseable phrase to `needsReview`
 * instead of silently trusting a wrong value.
 */
export function indianWordsToNumber(words: string): number | null {
  const tokens = words
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t.length > 0 && t !== 'and');

  if (tokens.length === 0) {
    return null;
  }

  let result = 0;
  let current = 0;

  for (const token of tokens) {
    if (token in ONES) {
      current += ONES[token] as number;
    } else if (token in TENS) {
      current += TENS[token] as number;
    } else if (token === 'hundred') {
      current = (current === 0 ? 1 : current) * 100;
    } else if (token in SECTION_MULTIPLIERS) {
      const multiplier = SECTION_MULTIPLIERS[token] as number;
      result += (current === 0 ? 1 : current) * multiplier;
      current = 0;
    } else {
      // Unknown token: this phrase is outside the parser's known vocabulary.
      // Never guess — report unparseable.
      return null;
    }
  }

  return result + current;
}

/**
 * Parses the corpus's currency-words template —
 * `Rupees <integer words> Rupees And <decimal words> Paise Only` — into a
 * rupees-and-paise number. `phrase` is the text between (but not including)
 * the outer parentheses, e.g. `"Rupees Thirty Lakh ... Twenty-Six Rupees And
 * Fifty-Six Paise Only"`. Returns null if the template doesn't match or
 * either half fails to parse — the mismatch/uncertainty case, not a partial
 * value.
 */
export function parseRupeesWords(phrase: string): number | null {
  const m = /^Rupees\s+(.+?)\s+Rupees\s+And\s+(.+?)\s+Paise\s+Only\.?$/i.exec(
    phrase.trim(),
  );
  if (m === null) {
    return null;
  }
  const [, integerWords, decimalWords] = m;
  const integerValue = indianWordsToNumber(integerWords ?? '');
  const decimalValue = indianWordsToNumber(decimalWords ?? '');
  if (integerValue === null || decimalValue === null || decimalValue > 99) {
    return null;
  }
  // Accumulate in integer paise to avoid binary-float rounding error, then
  // convert back to rupees.
  return (integerValue * 100 + decimalValue) / 100;
}
