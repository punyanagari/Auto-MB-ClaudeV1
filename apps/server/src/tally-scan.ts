/**
 * The machinery every TallyPrime export reader here shares.
 *
 * ## Why a line scanner and not an XML parser
 *
 * The real exports are UTF-16LE with a byte-order mark, no XML
 * declaration, and character references like `&#4;` in operator-typed
 * fields. `&#4;` is illegal in XML 1.0, so expat — and therefore every
 * DOM and SAX parser in the ecosystem — refuses the whole file on the
 * first one. The documents are also 95 % Tally engine flags: a ledger
 * master carries about 150 boolean tags and a sales voucher about the
 * same, one per line, of which a reader here uses a dozen.
 *
 * So the files are read the way `docs/reference/TALLY-MAPPING-CENSUS.md`
 * surveyed them: one tag per line, a line at a time, straight off the
 * bytes. Nothing here builds a tree, and the peak memory is the upload
 * buffer plus whatever the caller has collected so far — not a DOM of a
 * 133 MB document.
 *
 * ## Why it is a module and not two copies
 *
 * `tally-masters.ts` (wave T1) and `tally-vouchers.ts` (wave T2) read two
 * different documents out of the same format, and the hard parts are the
 * FORMAT: the byte-order mark, the even-offset newline search, the
 * illegal character references, the line-shape expressions, and the
 * ceilings that stop a hostile file. Every one of those was found the
 * hard way once. A second copy of them is a second place for the next
 * export to be read slightly differently, so they live here and the two
 * readers keep only their own document's meaning.
 *
 * ## Bounded, because the input is a file
 *
 * A reader whose loop is driven by the shape of untrusted bytes needs a
 * ceiling on every axis the bytes control. The two ceilings that belong
 * to the FORMAT are here; the ones that belong to a document — how many
 * ledgers, how many vouchers — belong to the reader that counts them.
 */

/* --- ceilings -------------------------------------------------------------- */

/**
 * The longest single line a reader will assemble, in UTF-16 code units.
 * Tally writes one tag per line and the longest real line across both the
 * 133 MB masters export and the 3.18 GB transactions export is 1,034
 * characters; 64 Ki is nearly two orders of magnitude of headroom and
 * still refuses a file with no newlines in it at all, which is the shape
 * that would otherwise be concatenated into one string the size of the
 * upload.
 */
export const MAX_LINE_LENGTH = 64 * 1024;

/**
 * How many named refusals travel back from one read. A file that produces
 * more than this is not a file with some bad rows in it; the preview says
 * so and names the first two hundred, which is more than an operator
 * reads.
 */
export const MAX_REFUSALS = 200;

/* --- refusals -------------------------------------------------------------- */

/**
 * A refusal about a whole file: it is not the Tally export it claims to
 * be, it stops in the middle, or it exceeds a ceiling. Nothing is
 * imported.
 */
export class TallyImportError extends Error {
  constructor(
    message: string,
    /** Which named refusal the route answers with. Truncation is its own
     * code because its remedy is different from every other unreadable
     * file: the export did not finish being written, so the operator
     * re-runs it rather than inspecting it. */
    readonly code:
      'TALLY_EXPORT_UNREADABLE' | 'TALLY_EXPORT_TRUNCATED' = 'TALLY_EXPORT_UNREADABLE',
  ) {
    super(message);
    this.name = 'TallyImportError';
  }
}

/* --- decoding -------------------------------------------------------------- */

/**
 * The five named entities XML defines, and numeric references.
 *
 * A reference to a CONTROL CHARACTER is dropped rather than decoded, and
 * that is the whole reason this function is written out. The exports
 * carry `&#4;` in operator-typed fields — illegal in XML 1.0, which is
 * why no parser will open the file — and decoding it would put a U+0004
 * into a text column every `!~ '[[:cntrl:]]'` CHECK in this schema
 * refuses. Dropping it reproduces what the operator meant and what Tally
 * itself displays.
 */
export function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6}));/g,
    (
      whole,
      named: string | undefined,
      decimal: string | undefined,
      hex: string | undefined,
    ) => {
      if (named !== undefined) {
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named] ?? whole;
      }
      const code =
        decimal === undefined ? Number.parseInt(hex ?? '0', 16) : Number(decimal);
      // Unpaired surrogates and out-of-range code points would produce a
      // lone U+FFFD or throw; both are dropped for the same reason as the
      // control characters.
      if (!Number.isInteger(code) || code <= 0 || code > 0x10_ff_ff) return '';
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return '';
      if (code >= 0xd8_00 && code <= 0xdf_ff) return '';
      return String.fromCodePoint(code);
    },
  );
}

/** Entity-decoded, control characters removed, ends trimmed. Every value a
 * reader keeps goes through it, so no column can receive a control
 * character the database would refuse as a 500. */
export function clean(value: string): string {
  return decodeEntities(value)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
}

/* --- the line scanner ------------------------------------------------------ */

/**
 * Yields the file's lines without ever materialising it as one string.
 *
 * The exports are UTF-16LE with a BOM. Lines are found by searching for
 * the newline's OWN BYTES and each line is decoded on its own, so the
 * peak cost is one line rather than the whole document as text — which is
 * the difference between this and `bytes.toString()` followed by `split`.
 *
 * A match is only accepted at an EVEN offset. `0A 00` can occur straddling
 * two characters — a U+0A?? followed by a U+??00 — and reading that as a
 * line break would split a line in the middle of a character. It does not
 * happen in these exports; it costs one modulo to make impossible.
 */
export function* readLines(bytes: Buffer): Generator<{ text: string; offset: number }> {
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const encoding: BufferEncoding = utf16 ? 'utf16le' : 'utf8';
  const newline = Buffer.from('\n', encoding);
  const step = utf16 ? 2 : 1;
  let start = utf16 ? 2 : 0;
  while (start < bytes.length) {
    let index = bytes.indexOf(newline, start);
    while (utf16 && index !== -1 && (index - 2) % 2 !== 0) {
      index = bytes.indexOf(newline, index + 1);
    }
    const end = index === -1 ? bytes.length : index;
    if (end - start > MAX_LINE_LENGTH * step) {
      throw new TallyImportError(
        'That file has a line longer than this reader will assemble, so it is not the one-tag-per-line export Tally writes. Export it from TallyPrime again without reformatting the file.',
      );
    }
    // The BYTE offset travels with the line, so a truncation refusal can
    // say where the file stops. An operator comparing a half-written
    // export against the one they meant to send needs a position, not a
    // line number in a document they cannot open.
    yield { text: bytes.toString(encoding, start, end), offset: start };
    if (index === -1) return;
    start = index + newline.length;
  }
}

/* --- one line, structurally ------------------------------------------------ */

/** `<TAG …>value</TAG>` closed on its own line. Tally writes every value
 * this way. The tag name is bounded so a hostile line cannot make the
 * expression walk far, and the value is captured lazily to the LAST
 * closing tag on the line rather than the first, which is what a value
 * containing an escaped `<` needs. */
// Linear on every input, and the two bounds are why: the tag name is
// capped at 64 characters, and `[^>]*` cannot cross the `>` that must
// follow it — so the attribute run has exactly ONE possible extent rather
// than a range the engine can explore. Only `[\s\S]*` backtracks, once,
// looking for the closing tag. `zoho-invoices.ts` waives the same rule for
// the same reason.
// eslint-disable-next-line security/detect-unsafe-regex
export const COMPLETE_TAG = /^<([A-Z0-9._:]{1,64})(?:\s[^>]*)?>([\s\S]*)<\/\1>$/i;
/** `<TAG …>` with nothing after it: an element that opens here. */
// eslint-disable-next-line security/detect-unsafe-regex
export const OPEN_TAG = /^<([A-Z0-9._:]{1,64})(?:\s[^>]*)?>$/i;
/** `</TAG>` */
export const CLOSE_TAG = /^<\/([A-Z0-9._:]{1,64})>$/i;
/** `<TAG …>some text` that does NOT close on this line — a value running
 * across lines, which is the only thing in these exports that can contain
 * something tag-shaped without it being a tag. Tried last, after the
 * complete, open and close shapes have all been ruled out. */
// Linear for the reason the two shapes above give: the tag name is capped
// at 64 and `[^>]*` cannot cross the `>` that must follow it, so the
// attribute run has exactly one possible extent.
// eslint-disable-next-line security/detect-unsafe-regex
export const VALUE_OPENS_HERE = /^<([A-Z0-9._:]{1,64})(?:\s[^>]*)?>\S/i;
/** The `NAME` attribute, which is where Tally puts a master's own name. */
export const NAME_ATTRIBUTE = /\sNAME="([^"]*)"/i;

/* --- values ---------------------------------------------------------------- */

/**
 * An exact rupee figure, or null.
 *
 * A figure read out of a Tally export is EVIDENCE — a ledger's opening
 * balance, a voucher line's amount — so a malformed one nulls the value
 * rather than refusing a record that is otherwise perfectly readable, and
 * the caller decides what a missing figure means. Nothing here goes
 * through `Number`: the string is padded as TEXT so an eighteen-digit
 * figure is exact, for the reason `money.ts` counts in BigInt.
 */
export function exactRupees(value: string): string | null {
  const text = value.replace(/\s+/g, '');
  if (text.length === 0) return null;
  // Every quantifier is bounded and no two of them can consume the same
  // character, so this is linear — `money.ts` waives the rule for the same
  // lexeme.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return null;
  return `${match[1] ?? ''}${match[2] ?? ''}.${(match[3] ?? '').padEnd(2, '0')}`;
}

/**
 * Which direct fields are worth keeping verbatim.
 *
 * `Yes`/`No` are dropped, and that single rule removes about 150 of the
 * ~165 tags on a real ledger master and a comparable share of a voucher:
 * they are Tally engine flags — `ISBNFCODESUPPORTED`,
 * `INTERESTINCLDAYOFADDITION` — that say nothing about the record. What is
 * left is the dozen fields that carry meaning.
 *
 * This is 0115's `raw_row` discipline, trimmed to the shape of a different
 * file. 0115 keeps every cell because a Zoho export's 193 columns are all
 * somebody's data; keeping every tag here would store megabytes of the
 * word "No" to preserve nothing.
 */
export function keepSourceField(tag: string, value: string): boolean {
  if (value.length === 0 || value.length > 2000) return false;
  if (value === 'Yes' || value === 'No') return false;
  return !tag.endsWith('.LIST');
}
