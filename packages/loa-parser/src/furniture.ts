/**
 * @auto-mb/loa-parser — print-furniture stripping (DC-23; legacy ticket DC-23;
 * docs/reference/loa-parser-contract.md §3 "Print-furniture noise").
 *
 * Every fixture is a browser "print to PDF" of the IREPS
 * `publishLOAWorksLetter.do` page, which repeats a browser page HEADER
 * (`<d/m/yy>, <h:mm> <AM|PM> ireps.gov.in/...`) and a page FOOTER
 * (`https://www.ireps.gov.in/... <n>/<m>`) once per printed page. Both must
 * be stripped BEFORE any structural parsing runs, or they land inside
 * description/header text blocks (research §3).
 *
 * The fixtures preserve this noise verbatim BY DESIGN (DC-22's sha256 guard,
 * test/corpus-manifest.test.ts, goes red on any byte edit) — so
 * stripping happens at parse time, on the in-memory string, and the fixture
 * files themselves are never touched.
 *
 * Both forms carry a pdftotext -layout artifact worth calling out explicitly:
 * a literal space is inserted mid-word inside "works" ("w orks") and inside
 * "www" ("w w w"). That is not a typo in this file — it is how the fixture
 * bytes actually read (verified byte-for-byte against every fixture).
 *
 * Page-2+ headers carry a leading form-feed byte (`\f`, the pdftotext page
 * break), NOT plain space/tab indentation: `\f2/9/26, 1:47 PM  ireps.gov.in/
 * ...` (e.g. PL273-JHS.txt lines 66/124/184). A leading-whitespace class of
 * only `[ \t]` misses every one of these — reviewer-caught (DC-23 review
 * round 1): 42 of 96 furniture lines corpus-wide survived stripping because
 * of this gap, 1-2 inside the header region on every one of the six
 * fixtures. `\f` is included in the class below for exactly that reason. The
 * BARE page-break `\f` line that sometimes stands alone (no furniture text
 * on it) is deliberately left untouched — it carries no leaked content, so
 * stripping it is unnecessary and not attempted here.
 */

// Page header: "2/9/26, 1:47 PM       ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=...&letterI…"
// PL270-CRB's variant carries no query string at all: "...publishLOAWorksLetter.do" with nothing after it.
// Page-2+ occurrences are prefixed with a form-feed byte instead of spaces/
// tabs (module doc above) — `\f` is included in the leading-whitespace class.
const HEADER_FURNITURE_RE =
  /^[ \t\f]*\d{1,2}\/\d{1,2}\/\d{2,4},\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s+ireps\.gov\.in\/epsn\/w\s?orks\/tds\/publishLOAWorksLetter\.do.*$/;

// Page footer: "https://w w w .ireps.gov.in/epsn/w orks/tds/publishLOAWorksLetter.do?Action=...&letterId=1…   1/4"
// PL270-CRB's variant again carries no query string, just the bare URL and a page counter.
const FOOTER_FURNITURE_RE =
  /^[ \t\f]*https:\/\/w\s?w\s?w\s?\.ireps\.gov\.in\/epsn\/w\s?orks\/tds\/publishLOAWorksLetter\.do.*$/;

/** True iff the given single line is either observed print-furniture form. */
export function isPrintFurnitureLine(line: string): boolean {
  return HEADER_FURNITURE_RE.test(line) || FOOTER_FURNITURE_RE.test(line);
}

/**
 * Strips every print-furniture line (both observed forms) from the raw
 * `pdftotext -layout` extraction, line-by-line, preserving every other line
 * (including blank lines, so paragraph structure downstream is unaffected).
 * Runs before any structural parsing, per the ticket's ordering requirement.
 */
export function stripPrintFurniture(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isPrintFurnitureLine(line))
    .join('\n');
}
