/**
 * Appends a signature-bearing incremental update to a PDF.
 *
 * Same posture as `../pdf-signature/pdf-document.ts`, which reads: a
 * byte-level writer rather than a full PDF object model. That file argues
 * the case for reading ("a full parser would add a large, attack-exposed
 * surface for no additional signature that it could find") and it holds
 * at least as strongly for writing, where the input is a document THIS
 * SERVER rendered a moment ago through Gotenberg. We are not signing
 * arbitrary uploads; we are counter-signing our own output.
 *
 * The update appends, never rewrites. The original revision stays byte for
 * byte where it was, which is what makes the signature meaningful: a
 * reader can reconstruct the unsigned document from the signed one and see
 * that nothing before the signature moved.
 *
 * FOUR OBJECTS GO IN, and each is needed for the signature to be a
 * signature rather than a blob:
 *
 *   1. the `/Type /Sig` dictionary, with the `/Contents` reservation and
 *      the `/ByteRange` that excludes exactly it;
 *   2. an invisible widget annotation — the signature FIELD;
 *   3. the document catalog, re-emitted with `/AcroForm` naming that
 *      field and `/SigFlags 3`;
 *   4. the first page, re-emitted with the widget in its `/Annots`.
 *
 * Objects 3 and 4 are the difference between a signature Adobe Reader
 * lists in its Signatures panel and one nothing but our own verifier can
 * find. `scanPdfSignatures` locates signature dictionaries by scanning for
 * `/ByteRange`, so it would report a signature that no other reader in the
 * world displays. Shipping that would be the "manufactures confidence"
 * failure `pdf-signature.ts` opens by refusing.
 *
 * WHAT IT REFUSES, LOUDLY. Every structural assumption below is checked
 * and raises `PdfRevisionError` when it does not hold, because the
 * alternative — writing an update against a guess — produces a file that
 * looks signed and opens broken. Refused: cross-reference streams and
 * compressed object streams (see the ceiling note on
 * `readTrailerDictionary`), encrypted documents, a catalog that already
 * carries an `/AcroForm`, and a page tree this cannot walk.
 */

import { createHash } from 'node:crypto';

export class PdfRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRevisionError';
  }
}

/**
 * Bytes reserved for the hexadecimal `/Contents` string.
 *
 * ADR-0009's reservation, carried forward by ADR-0012. It is fixed rather
 * than fitted so the blob can be spliced in without moving a byte after
 * the `/ByteRange` has been computed — the verifier's ByteRange/Contents
 * alignment rule depends on exactly that. 16384 hex characters hold 8192
 * octets of CMS: an RSA 2048 signature is 256 of them and a three
 * certificate CCA chain is around 4000, so the headroom is roughly double
 * and a signature that does not fit is refused rather than truncated.
 */
export const CONTENTS_HEX_RESERVATION = 16_384;

/** The literal the `/ByteRange` is written as before its real values are
 * known. Every rendered range must be padded back to this exact width, or
 * the offsets computed against it move. */
const BYTE_RANGE_PLACEHOLDER = '[0 %%%%%%%%%% %%%%%%%%%% %%%%%%%%%%]';

export interface PreparedRevision {
  /** The complete PDF with a zero-filled `/Contents`. Deterministic: the
   * same base bytes and the same options always produce these bytes. */
  readonly draft: Buffer;
  /** Offset of the `<` that opens the `/Contents` hex string. */
  readonly contentsStart: number;
  /** The bytes the signature covers — the two `/ByteRange` spans, joined.
   * This is what the CMS `messageDigest` attribute is computed over. */
  readonly signedContent: Buffer;
}

export interface PrepareRevisionOptions {
  /** `/Name`: who the producing application says signed it. Not evidence
   * — the certificate subject is — and the verifier reports it as a
   * claim. */
  readonly signerName: string;
  readonly reason: string;
  readonly location: string;
  /** `/M`, the claimed signing time, as a PDF date string. Passed in
   * rather than read from the clock so that preparing the same request
   * twice produces the same bytes; see `signing.ts` for why that
   * determinism is the integrity binding and not a convenience. */
  readonly claimedSigningTime: string;
}

/* --- byte-level PDF reading ------------------------------------------ */

/** PDF syntax is byte-oriented and its strings are not UTF-8, so the whole
 * file is read as latin1: one character per byte, round-trips exactly. */
function text(pdf: Buffer): string {
  return pdf.toString('latin1');
}

/**
 * The last trailer dictionary's content.
 *
 * ponytail: classic cross-reference tables only. A PDF whose last section
 * is a cross-reference STREAM has no `trailer` keyword at all, and this
 * refuses it rather than guessing. That is not a gap in coverage for what
 * this product signs — Chromium's PDF backend, which is what Gotenberg
 * renders through, emits classic tables — and the refusal is a named
 * error an operator can act on. The upgrade path, if a future renderer
 * changes: decode the `/Type /XRef` stream's `/W` field widths (a
 * FlateDecode plus a fixed-width row reader, both already available from
 * `node:zlib`) and emit the new section in the same form.
 */
function readTrailerDictionary(pdf: Buffer): string {
  const body = text(pdf);
  const index = body.lastIndexOf('trailer');
  if (index === -1) {
    throw new PdfRevisionError(
      'this PDF carries no classic trailer dictionary, which means its cross-reference section is a stream; the signer does not write that form',
    );
  }
  const open = body.indexOf('<<', index);
  if (open === -1) throw new PdfRevisionError('the trailer dictionary is unreadable');
  return body.slice(open, matchingDictionaryEnd(body, open));
}

/**
 * The offset one past the `>>` that closes the dictionary opening at
 * `open`.
 *
 * Nesting is counted, and the two syntactic forms that can spell `>>`
 * without meaning it are skipped: literal strings `(…)`, where `\` escapes
 * the next byte and inner parentheses balance, and hex strings `<…>`.
 */
function matchingDictionaryEnd(body: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < body.length) {
    const pair = body.slice(index, index + 2);
    if (pair === '<<') {
      depth += 1;
      index += 2;
      continue;
    }
    if (pair === '>>') {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    const character = body[index];
    if (character === '(') {
      let nesting = 1;
      index += 1;
      while (index < body.length && nesting > 0) {
        const inner = body[index];
        if (inner === '\\') index += 1;
        else if (inner === '(') nesting += 1;
        else if (inner === ')') nesting -= 1;
        index += 1;
      }
      continue;
    }
    if (character === '<') {
      const close = body.indexOf('>', index);
      index = close === -1 ? body.length : close + 1;
      continue;
    }
    index += 1;
  }
  throw new PdfRevisionError('an unterminated dictionary reached the end of the file');
}

/** An indirect reference `/Key N 0 R` out of a dictionary's text. */
function referenceEntry(dictionary: string, key: string): number | null {
  /* eslint-disable security/detect-non-literal-regexp -- `key` is always one of this module's own '/Root', '/Pages' literals; no document byte reaches the PATTERN, only the subject string */
  const match = new RegExp(`${key}\\s+(\\d+)\\s+(\\d+)\\s+R\\b`).exec(dictionary);
  /* eslint-enable security/detect-non-literal-regexp */
  const number = match?.[1];
  return number === undefined ? null : Number(number);
}

interface LocatedObject {
  /** Offset of the `N 0 obj` header. */
  readonly start: number;
  /** Offset one past `endobj`. */
  readonly end: number;
  /** The object's dictionary, `<<` to `>>` inclusive. */
  readonly dictionary: string;
}

/**
 * Finds indirect object `number`'s most recent definition by scanning for
 * its `N G obj` header.
 *
 * Scanning rather than following the cross-reference table, for the reason
 * the sibling reader gives: the table is one more attack-exposed structure
 * to parse for information the bytes already carry literally. The LAST
 * match wins, because an incremental update overrides earlier revisions of
 * the same object and a file is written in revision order.
 *
 * An object that is not found is one that lives inside a compressed object
 * stream, and that is refused by the caller — the same ceiling as
 * `readTrailerDictionary`.
 */
function locateObject(pdf: Buffer, number: number): LocatedObject | null {
  const body = text(pdf);
  /* eslint-disable security/detect-non-literal-regexp -- `number` is a parsed integer from this file's own reference reader, interpolated as digits */
  const header = new RegExp(`(?:^|[^0-9])(${String(number)}\\s+\\d+\\s+obj\\b)`, 'g');
  /* eslint-enable security/detect-non-literal-regexp */
  let start = -1;
  let bodyStart = -1;
  for (let match = header.exec(body); match !== null; match = header.exec(body)) {
    const group = match[1];
    if (group === undefined) continue;
    start = match.index + match[0].length - group.length;
    bodyStart = match.index + match[0].length;
  }
  if (start === -1) return null;
  const open = body.indexOf('<<', bodyStart);
  const endObject = body.indexOf('endobj', bodyStart);
  if (open === -1 || endObject === -1 || open > endObject) return null;
  return {
    start,
    end: endObject + 'endobj'.length,
    dictionary: body.slice(open, matchingDictionaryEnd(body, open)),
  };
}

/** The highest indirect object number the file defines. */
function highestObjectNumber(pdf: Buffer): number {
  const numbers = [...text(pdf).matchAll(/(?:^|[^0-9])(\d+)\s+\d+\s+obj\b/g)].map(
    (match) => Number(match[1]),
  );
  return Math.max(0, ...numbers);
}

/** Walks `/Pages` down to the first `/Type /Page` leaf and returns its
 * object number. Depth-bounded: a page tree that points at itself is a
 * malformed document, not a reason to loop. */
function firstPageObject(pdf: Buffer, pagesNumber: number): number {
  let current = pagesNumber;
  for (let depth = 0; depth < 8; depth += 1) {
    const node = locateObject(pdf, current);
    if (node === null) {
      throw new PdfRevisionError(
        'the page tree points at an object this signer cannot read, which means it is inside a compressed object stream',
      );
    }
    if (/\/Type\s*\/Page\b(?!s)/.test(node.dictionary)) return current;
    const kids = /\/Kids\s*\[\s*(\d+)\s+\d+\s+R/.exec(node.dictionary);
    const first = kids?.[1];
    if (first === undefined) {
      throw new PdfRevisionError('the page tree has no readable first page');
    }
    current = Number(first);
  }
  throw new PdfRevisionError('the page tree nests deeper than this signer will walk');
}

/* --- writing --------------------------------------------------------- */

/**
 * A PDF text string, in whichever of the two encodings the value needs.
 *
 * PDF 32000-1 § 7.9.2.2 gives text strings two forms: PDFDocEncoded bytes
 * in a literal `(…)`, which reaches Latin-1 and no further, and UTF-16BE
 * behind a `FEFF` byte-order mark. The whole revision is written as
 * latin1, so the literal is the natural form — and a signer's name in
 * Devanagari written through it becomes mojibake in Adobe's signature
 * panel, on a document whose entire purpose is to say who signed it.
 *
 * So: a literal while the value fits Latin-1, and a UTF-16BE hex string
 * the moment it does not. Restricting the schema's character set instead
 * was the alternative and is not defensible in an Indian works-contract
 * product — "your company's name cannot appear in its own signature" is
 * not a rule anybody would accept.
 */
function textString(value: string): string {
  if (/^[ -ÿ]*$/.test(value)) {
    return `(${value.replace(/[\\()]/g, (character) => `\\${character}`)})`;
  }
  // The mark is written as its two bytes rather than as a U+FEFF in a
  // template literal: an invisible character in source is the kind of
  // thing an editor or a codemod quietly eats, and this is the byte pair
  // the spec actually names.
  const utf16be = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(value, 'utf16le').swap16(),
  ]);
  return `<${utf16be.toString('hex').toUpperCase()}>`;
}

/**
 * Builds the unsigned revision: the four objects, the cross-reference
 * subsections that address them, and the trailer.
 *
 * The result is a complete, valid PDF whose signature is a hole. Nothing
 * after this point moves a byte — `embedSignature` writes only inside the
 * reservation.
 */
export function prepareSignedRevision(
  base: Buffer,
  options: PrepareRevisionOptions,
): PreparedRevision {
  const trailer = readTrailerDictionary(base);
  if (/\/Encrypt\b/.test(trailer)) {
    throw new PdfRevisionError(
      'this PDF is encrypted; the signer does not hold its decryption key and an update appended to it would be unreadable',
    );
  }
  const rootNumber = referenceEntry(trailer, '/Root');
  if (rootNumber === null) {
    throw new PdfRevisionError('the trailer names no document catalog');
  }
  const catalog = locateObject(base, rootNumber);
  if (catalog === null) {
    throw new PdfRevisionError(
      'the document catalog is not present as a plain indirect object, which means it is inside a compressed object stream',
    );
  }
  if (/\/AcroForm\b/.test(catalog.dictionary)) {
    throw new PdfRevisionError(
      'this PDF already carries an interactive form; merging a signature field into an existing AcroForm is not something this signer does',
    );
  }
  const pagesNumber = referenceEntry(catalog.dictionary, '/Pages');
  if (pagesNumber === null) {
    throw new PdfRevisionError('the document catalog names no page tree');
  }
  const pageNumber = firstPageObject(base, pagesNumber);
  const page = locateObject(base, pageNumber);
  if (page === null) throw new PdfRevisionError('the first page is unreadable');
  if (/\/Annots\b/.test(page.dictionary)) {
    throw new PdfRevisionError(
      'the first page already carries annotations; this signer writes the only Annots array on the page it signs',
    );
  }

  const startXref = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(text(base).slice(-2048));
  const previous = startXref?.[1];
  if (previous === undefined) {
    throw new PdfRevisionError('this PDF has no readable startxref offset');
  }

  const signatureNumber = highestObjectNumber(base) + 1;
  const widgetNumber = signatureNumber + 1;

  // A separator newline, so the revision never runs into the base file's
  // last byte whatever that byte was.
  const parts: string[] = ['\n'];
  const offsets = new Map<number, number>();
  let cursor = base.length + 1;

  const push = (number: number, encoded: string): void => {
    offsets.set(number, cursor);
    parts.push(encoded);
    cursor += encoded.length;
  };

  // 1. The signature dictionary. Written by hand rather than through a
  //    helper because the offset of its `/Contents` `<` is arithmetic on
  //    this exact string.
  const signatureHead =
    `${String(signatureNumber)} 0 obj\n` +
    '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached' +
    ` /Name ${textString(options.signerName)}` +
    ` /Reason ${textString(options.reason)}` +
    ` /Location ${textString(options.location)}` +
    ` /M ${textString(options.claimedSigningTime)}` +
    ' /Contents <';
  const contentsStart = cursor + signatureHead.length - 1;
  push(
    signatureNumber,
    signatureHead +
      '0'.repeat(CONTENTS_HEX_RESERVATION) +
      `> /ByteRange ${BYTE_RANGE_PLACEHOLDER} >>\nendobj\n`,
  );
  const contentsEnd = contentsStart + CONTENTS_HEX_RESERVATION + 2;

  // 2. The field. One object serving as both field and widget, which is
  //    what PDF 32000-1 § 12.7.3.1 permits for a field with a single
  //    appearance. `/Rect [0 0 0 0]` and `/F 132` (Hidden|NoView cleared,
  //    Print|Locked set) make it an INVISIBLE signature: the document
  //    looks exactly as it was rendered, and the signature lives in the
  //    Signatures panel where a verifier looks for it.
  push(
    widgetNumber,
    `${String(widgetNumber)} 0 obj\n` +
      '<< /Type /Annot /Subtype /Widget /FT /Sig' +
      ` /T ${textString('AutoMB Signature 1')}` +
      ` /V ${String(signatureNumber)} 0 R` +
      ` /P ${String(pageNumber)} 0 R` +
      ' /Rect [0 0 0 0] /F 132 >>\nendobj\n',
  );

  // 3. The catalog, re-emitted with the form. Everything it already said
  //    is preserved verbatim; only the one entry is added.
  push(
    rootNumber,
    `${String(rootNumber)} 0 obj\n` +
      catalog.dictionary.slice(0, -2).trimEnd() +
      ` /AcroForm << /Fields [${String(widgetNumber)} 0 R] /SigFlags 3 >> >>\n` +
      'endobj\n',
  );

  // 4. The page, re-emitted with the widget in its annotations.
  push(
    pageNumber,
    `${String(pageNumber)} 0 obj\n` +
      page.dictionary.slice(0, -2).trimEnd() +
      ` /Annots [${String(widgetNumber)} 0 R] >>\n` +
      'endobj\n',
  );

  // The cross-reference section. One subsection per run of consecutive
  // object numbers, which is what the format requires and what keeps a
  // reader from having to guess.
  const changed = [...offsets.keys()].sort((left, right) => left - right);
  const xrefOffset = cursor;
  let xref = 'xref\n';
  for (let index = 0; index < changed.length;) {
    let run = 1;
    while (
      index + run < changed.length &&
      (changed[index + run] ?? 0) === (changed[index] ?? 0) + run
    ) {
      run += 1;
    }
    xref += `${String(changed[index])} ${String(run)}\n`;
    for (let step = 0; step < run; step += 1) {
      const number = changed[index + step];
      const offset = number === undefined ? 0 : (offsets.get(number) ?? 0);
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    index += run;
  }
  parts.push(xref);
  parts.push(
    `trailer\n<< /Size ${String(widgetNumber + 1)} /Root ${String(rootNumber)} 0 R` +
      ` /Prev ${previous} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`,
  );

  let revision = parts.join('');
  const total = base.length + revision.length;
  const rendered = `[0 ${String(contentsStart)} ${String(contentsEnd)} ${String(total - contentsEnd)}]`;
  if (rendered.length > BYTE_RANGE_PLACEHOLDER.length) {
    throw new PdfRevisionError(
      'this document is too large for the ByteRange placeholder',
    );
  }
  // Padded back to the placeholder's exact width, inside the brackets, so
  // every offset computed above still points where it pointed.
  revision = revision.replace(
    BYTE_RANGE_PLACEHOLDER,
    `${rendered.slice(0, -1)}${' '.repeat(BYTE_RANGE_PLACEHOLDER.length - rendered.length)}]`,
  );

  const draft = Buffer.concat([base, Buffer.from(revision, 'latin1')]);
  return {
    draft,
    contentsStart,
    signedContent: Buffer.concat([
      draft.subarray(0, contentsStart),
      draft.subarray(contentsEnd, total),
    ]),
  };
}

/**
 * Writes the CMS blob into the reservation and returns the finished
 * document.
 *
 * The draft is copied rather than mutated: a caller holding the prepared
 * revision must be able to prepare once and embed twice — which is exactly
 * what the retry of a failed signature does — and an in-place write would
 * leave the second attempt splicing into the first attempt's bytes.
 */
export function embedSignature(prepared: PreparedRevision, cms: Buffer): Buffer {
  const hex = cms.toString('hex');
  if (hex.length > CONTENTS_HEX_RESERVATION) {
    throw new PdfRevisionError(
      'the CMS signature does not fit the /Contents reservation; the certificate chain is larger than this signer reserves for',
    );
  }
  const signed = Buffer.from(prepared.draft);
  signed.write(
    hex.padEnd(CONTENTS_HEX_RESERVATION, '0'),
    prepared.contentsStart + 1,
    'latin1',
  );
  return signed;
}

/** The SHA-256 of a document, lowercase hex — the identity every signing
 * request is bound to. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
