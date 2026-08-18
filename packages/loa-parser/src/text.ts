/**
 * @auto-mb/loa-parser — generic text-shaping helpers shared by the header
 * extractors (DC-23). None of these are field-specific; they exist because
 * `pdftotext -layout` wraps prose across print-layout line breaks and the
 * field extractors in header.ts need a couple of different ways to
 * re-flow it depending on what the wrap boundary means:
 *
 *  - `flatten` collapses ALL whitespace (including newlines) to single
 *    spaces. Safe for prose whose meaning doesn't depend on the exact
 *    inter-word spacing (which is every field except the letter number —
 *    see letter-number.ts, which has its own dedicated joiner because that
 *    field's exact string is pinned by the ticket).
 *  - `paragraphs` splits on blank-line boundaries and flattens each
 *    paragraph independently, preserving the document's own paragraph
 *    structure — needed wherever a label's value must not bleed into the
 *    next unrelated paragraph (e.g. Consignee, Officer-in-charge).
 *  - `hyphenJoin` re-joins wrap-broken fragments the way the corpus's
 *    company-name line wraps do (research §3's letter-number trap is the
 *    same phenomenon applied to a division name): if a fragment's trimmed
 *    text ends in a hyphen, the next fragment is appended directly (the
 *    hyphen was mid-word, not a coincidental line-final dash); otherwise a
 *    single space is inserted.
 */

/** Collapses every run of whitespace (including newlines) to a single
 * space, and trims the ends. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Splits `text` into blank-line-delimited paragraphs, each internally
 * flattened to a single flowing line (its own internal line-wraps joined
 * with a single space). Empty paragraphs are dropped.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((block) => flatten(block))
    .filter((block) => block.length > 0);
}

/**
 * Joins pre-trimmed, non-empty fragments left-to-right using the corpus's
 * wrap convention: a fragment ending in `-` is a mid-word break (no space
 * inserted before the next fragment); anything else is a word/space break
 * (a single space is inserted). Verified against the letter-number field on
 * all six fixtures (research §3) and the same wrap pattern in the
 * office-address / contractor-name blocks.
 */
export function hyphenJoin(fragments: readonly string[]): string {
  return fragments.reduce((acc, fragment) => {
    if (acc.length === 0) {
      return fragment;
    }
    return acc.endsWith('-') ? acc + fragment : `${acc} ${fragment}`;
  }, '');
}
