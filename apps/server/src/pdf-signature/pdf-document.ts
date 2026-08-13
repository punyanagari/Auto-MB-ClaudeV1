/**
 * Locates the signature dictionaries in a PDF and works out exactly which
 * bytes each one signs.
 *
 * This is deliberately a byte-level reader rather than a full PDF object
 * parser. A signature dictionary cannot be compressed into an object
 * stream — its `/Contents` string has to sit at a known file offset so the
 * `/ByteRange` can exclude it — so every signature in every conforming file
 * is present here as literal bytes. A full parser would add a large,
 * attack-exposed surface (xref recovery, stream filters, encryption) for no
 * additional signature that it could find.
 *
 * The risk that comes with scanning is a decoy: any byte sequence in a
 * content stream can spell `/ByteRange`. That is neutralised by the
 * `/Contents`-alignment rule below rather than by trusting the scan — a
 * candidate is only accepted when the gap its ByteRange leaves unsigned is
 * EXACTLY the `/Contents` hexadecimal string of the same dictionary. A
 * decoy cannot satisfy that without being a real signature dictionary, and
 * a real signature dictionary whose ByteRange has been edited to cover
 * different bytes fails it and is reported as malformed rather than
 * silently verified against the wrong content.
 */

import { Asn1Error } from './asn1.js';

/** A signature dictionary that could not be read well enough to verify.
 * Distinct from a failed verification: the product reports "could not
 * check" and "checked, and it failed" as different facts. */
export class PdfSignatureStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfSignatureStructureError';
  }
}

export interface PdfSignatureField {
  /** Position of the `/ByteRange` keyword; document order for reporting. */
  readonly offset: number;
  /** The four ByteRange integers, exactly as written. */
  readonly byteRange: readonly [number, number, number, number];
  /** The bytes the signature covers: `[0, a)` followed by `[c, c+d)`. */
  readonly signedBytes: Buffer;
  /** DER of the CMS blob from `/Contents`, with the placeholder padding
   * removed. */
  readonly contents: Buffer;
  /** Offset one past the last signed byte. */
  readonly signedTo: number;
  /** `/SubFilter`, e.g. `adbe.pkcs7.sha1` or `ETSI.CAdES.detached`. */
  readonly subFilter: string | null;
  /** `/Filter`, e.g. `Adobe.PPKMS`. */
  readonly filter: string | null;
  /** `/Name`: the signer name as CLAIMED by the producing application. Not
   * evidence — the certificate subject is. */
  readonly name: string | null;
  /** `/M`: the claimed signing time, a PDF date string. Not evidence
   * either: it is set by the signing client and is inside the signed bytes
   * but says nothing a clock attested to. */
  readonly claimedSigningTime: string | null;
  readonly reason: string | null;
  readonly location: string | null;
  readonly contactInfo: string | null;
  /** True when the dictionary carries a DocMDP certification reference,
   * with the `/P` permission level when it could be read. */
  readonly certification: { readonly docMdp: boolean; readonly permissions: number | null };
}

export interface PdfSignatureScan {
  readonly fileLength: number;
  readonly fields: readonly PdfSignatureField[];
  /** Signature dictionaries that were found but could not be read. Each
   * one still counts as a signature: a document holding one is never
   * reported as unsigned. */
  readonly malformed: readonly { readonly offset: number; readonly reason: string }[];
  /** Offsets one past each `%%EOF` marker, in order. Used to describe how
   * many incremental updates follow a given signature. */
  readonly revisionEnds: readonly number[];
}

/** How far back from `/ByteRange` the enclosing dictionary is searched for
 * its sibling entries. Real signature dictionaries put `/Contents` before
 * `/ByteRange` and are dominated by the multi-kilobyte hex string; the
 * window covers that string plus generous slack for the other entries. */
const DICTIONARY_LOOKBEHIND = 128 * 1024;
/** And forwards, for the entries written after `/ByteRange`. */
const DICTIONARY_LOOKAHEAD = 8 * 1024;

/** A cap on how many signature dictionaries one file may present. Real
 * multi-approval railway documents carry a handful; the cap stops a
 * pathological file from turning verification into a denial of service. */
const MAX_SIGNATURES = 64;

const BYTE_RANGE_KEYWORD = '/ByteRange';

/**
 * A PDF name value written immediately after `key`, e.g. `/SubFilter` ->
 * `adbe.pkcs7.sha1`. `#xx` escapes are decoded because a producer may
 * write them and the raw form would then not compare equal to the literal
 * the caller expects.
 */
function readNameEntry(window: string, key: string): string | null {
  const pattern = new RegExp(`${key}\\s*/([^\\s/<>\\[\\]()]+)`);
  const match = pattern.exec(window);
  const raw = match?.[1];
  if (raw === undefined) return null;
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_all, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * A PDF literal string written immediately after `key`, e.g.
 * `/Reason(Variation Signing By SSE)`. Handles the backslash escapes and
 * balanced inner parentheses that the syntax allows; returns null when the
 * entry is absent or unterminated.
 *
 * The result is display metadata from inside the signed bytes. It is
 * reported, never trusted: `/Name` and `/M` are whatever the signing
 * application chose to write.
 */
function readStringEntry(window: string, key: string): string | null {
  const keyIndex = window.indexOf(key);
  if (keyIndex === -1) return null;
  let cursor = keyIndex + key.length;
  while (cursor < window.length && /\s/.test(window.charAt(cursor))) cursor += 1;
  if (window.charAt(cursor) !== '(') return null;
  cursor += 1;
  let depth = 1;
  let output = '';
  while (cursor < window.length) {
    const character = window.charAt(cursor);
    if (character === '\\') {
      const next = window.charAt(cursor + 1);
      const simple: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
      };
      output += simple[next] ?? next;
      cursor += 2;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return output;
    }
    output += character;
    cursor += 1;
  }
  return null;
}

/**
 * Cuts the reserved padding off a `/Contents` blob by reading the DER
 * length of the outer structure, NOT by stripping trailing zero bytes.
 *
 * A signing application reserves a fixed-size `/Contents` string so the
 * real blob can be dropped in without moving any byte offsets, and pads the
 * remainder with `00`. Stripping trailing `00` bytes gets the common case
 * right and silently corrupts the blob whenever the DER legitimately ends
 * in a zero octet — a signature value ending in `0x00` is ordinary. Reading
 * the outer TLV length is exact.
 */
function derPrefix(raw: Buffer): Buffer {
  if (raw.length < 2) return raw;
  const first = raw[1];
  if (first === undefined) return raw;
  let headerLength: number;
  let contentLength: number;
  if (first < 0x80) {
    headerLength = 2;
    contentLength = first;
  } else {
    const octets = first & 0x7f;
    // Indefinite length (0x80) and absurd length forms are left for the
    // ASN.1 reader to refuse with its own message.
    if (octets === 0 || octets > 4 || raw.length < 2 + octets) return raw;
    headerLength = 2 + octets;
    contentLength = 0;
    for (let index = 0; index < octets; index += 1) {
      const octet = raw[2 + index];
      if (octet === undefined) return raw;
      contentLength = contentLength * 256 + octet;
    }
  }
  const total = headerLength + contentLength;
  return total > 0 && total <= raw.length ? raw.subarray(0, total) : raw;
}

interface ContentsString {
  /** Offset of the opening `<`. */
  readonly start: number;
  /** Offset one past the closing `>`. */
  readonly end: number;
  readonly der: Buffer;
}

/**
 * The `/Contents` hexadecimal string nearest before `byteRangeOffset`
 * inside the same dictionary, located by its exact byte offsets so the
 * ByteRange gap can be checked against it.
 */
function readContentsString(
  latin: string,
  windowStart: number,
  byteRangeOffset: number,
): ContentsString | null {
  const pattern = /\/Contents\s*</g;
  let found: ContentsString | null = null;
  pattern.lastIndex = windowStart;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(latin)) !== null) {
    if (match.index >= byteRangeOffset) break;
    const start = match.index + match[0].length - 1;
    const close = latin.indexOf('>', start);
    if (close === -1) break;
    const hex = latin.slice(start + 1, close);
    if (!/^[0-9A-Fa-f\s]*$/.test(hex)) continue;
    found = {
      start,
      end: close + 1,
      der: derPrefix(Buffer.from(hex.replace(/\s/g, ''), 'hex')),
    };
  }
  return found;
}

function readByteRange(
  latin: string,
  offset: number,
): readonly [number, number, number, number] {
  const close = latin.indexOf(']', offset);
  if (close === -1) {
    throw new PdfSignatureStructureError('/ByteRange has no closing bracket');
  }
  const open = latin.indexOf('[', offset);
  if (open === -1 || open > close) {
    throw new PdfSignatureStructureError('/ByteRange has no opening bracket');
  }
  const parts = latin
    .slice(open + 1, close)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length !== 4) {
    throw new PdfSignatureStructureError(
      `/ByteRange has ${String(parts.length)} values; exactly 4 are required`,
    );
  }
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new PdfSignatureStructureError(
        `/ByteRange value ${JSON.stringify(part)} is not a non-negative integer`,
      );
    }
    return Number(part);
  });
  const [a, b, c, d] = numbers as [number, number, number, number];
  return [a, b, c, d];
}

function readCertification(window: string): {
  readonly docMdp: boolean;
  readonly permissions: number | null;
} {
  if (!window.includes('/DocMDP')) return { docMdp: false, permissions: null };
  const match = /\/TransformParams\s*<<[^>]*?\/P\s+(\d)/.exec(window);
  const permissions = match?.[1] === undefined ? null : Number(match[1]);
  return { docMdp: true, permissions };
}

/**
 * Every signature dictionary in `pdf`, with the exact bytes each covers.
 *
 * A candidate is accepted only when its ByteRange leaves unsigned exactly
 * the `/Contents` string of the same dictionary. That single rule does
 * three jobs: it rejects decoy `/ByteRange` text in page content, it
 * guarantees the CMS blob being verified is the one the ByteRange was
 * written for, and it refuses a file whose ByteRange has been widened or
 * narrowed to hide bytes from the digest.
 */
export function scanPdfSignatures(pdf: Buffer): PdfSignatureScan {
  const latin = pdf.toString('latin1');
  const fields: PdfSignatureField[] = [];
  const malformed: { offset: number; reason: string }[] = [];

  const revisionEnds: number[] = [];
  for (
    let index = latin.indexOf('%%EOF');
    index !== -1;
    index = latin.indexOf('%%EOF', index + 5)
  ) {
    revisionEnds.push(index + 5);
  }

  let searchFrom = 0;
  for (;;) {
    const offset = latin.indexOf(BYTE_RANGE_KEYWORD, searchFrom);
    if (offset === -1) break;
    searchFrom = offset + BYTE_RANGE_KEYWORD.length;
    if (fields.length + malformed.length >= MAX_SIGNATURES) {
      malformed.push({
        offset,
        reason: `more than ${String(MAX_SIGNATURES)} signature dictionaries; the rest were not read`,
      });
      break;
    }

    // Bound the search to the indirect object that CONTAINS this
    // /ByteRange, rather than to a byte distance around it. In a
    // countersigned document the previous revision's signature dictionary
    // sits a few kilobytes back, and a window that reached into it would
    // read the PREVIOUS signer's /Reason and /M and print them against
    // this signature — an attribution error, and exactly the kind of
    // quietly-wrong output this feature exists to avoid.
    const objectHeader = /(?:^|[\s>])\d+ \d+ obj\b/g;
    let objectStart = Math.max(0, offset - DICTIONARY_LOOKBEHIND);
    objectHeader.lastIndex = objectStart;
    for (let match = objectHeader.exec(latin); match !== null; ) {
      if (match.index >= offset) break;
      objectStart = match.index;
      match = objectHeader.exec(latin);
    }
    const endObject = latin.indexOf('endobj', offset);
    const windowStart = objectStart;
    const windowEnd =
      endObject === -1
        ? Math.min(latin.length, offset + DICTIONARY_LOOKAHEAD)
        : Math.min(endObject, offset + DICTIONARY_LOOKAHEAD);

    try {
      const byteRange = readByteRange(latin, offset);
      const contents = readContentsString(latin, windowStart, offset);
      if (contents === null) {
        throw new PdfSignatureStructureError(
          'no /Contents hexadecimal string precedes this /ByteRange',
        );
      }
      const [a, b, c, d] = byteRange;
      if (a !== 0) {
        throw new PdfSignatureStructureError(
          `/ByteRange starts at ${String(a)}; a signature that does not cover the file header signs an incomplete document`,
        );
      }
      if (b !== contents.start || c !== contents.end) {
        throw new PdfSignatureStructureError(
          `/ByteRange leaves [${String(b)}, ${String(c)}) unsigned but the /Contents string occupies [${String(contents.start)}, ${String(contents.end)}); the range does not describe this signature`,
        );
      }
      const signedTo = c + d;
      if (signedTo > pdf.length) {
        throw new PdfSignatureStructureError(
          `/ByteRange claims bytes up to ${String(signedTo)} but the file is ${String(pdf.length)} bytes`,
        );
      }
      if (contents.der.length === 0) {
        throw new PdfSignatureStructureError('/Contents is empty');
      }

      // The dictionary's other entries, with the multi-kilobyte /Contents
      // hex string cut out of the middle.
      //
      // Both orders occur: IREPS writes /SubFilter, /Reason and /M AFTER
      // /ByteRange, while other producers write them before /Contents.
      // Reading only one side would silently drop the signer's stated
      // reason and claimed time for half the corpus, so both sides are
      // searched — and the hex blob is removed first, so a byte sequence
      // inside a signature value can never be read as a dictionary entry.
      const dictionaryWindow =
        latin.slice(windowStart, contents.start) +
        ' ' +
        latin.slice(contents.end, windowEnd);
      fields.push({
        offset,
        byteRange,
        signedBytes: Buffer.concat([pdf.subarray(0, b), pdf.subarray(c, signedTo)]),
        contents: contents.der,
        signedTo,
        subFilter: readNameEntry(dictionaryWindow, '/SubFilter'),
        filter: readNameEntry(dictionaryWindow, '/Filter'),
        name: readStringEntry(dictionaryWindow, '/Name'),
        claimedSigningTime: readStringEntry(dictionaryWindow, '/M'),
        reason: readStringEntry(dictionaryWindow, '/Reason'),
        location: readStringEntry(dictionaryWindow, '/Location'),
        contactInfo: readStringEntry(dictionaryWindow, '/ContactInfo'),
        certification: readCertification(dictionaryWindow),
      });
    } catch (error) {
      if (
        error instanceof PdfSignatureStructureError ||
        error instanceof Asn1Error ||
        error instanceof RangeError
      ) {
        malformed.push({ offset, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return { fileLength: pdf.length, fields, malformed, revisionEnds };
}

/** A PDF date string (`D:YYYYMMDDHHmmSSOHH'mm'`) as an exact instant, or
 * null when it is absent or does not carry enough to place one. */
export function parsePdfDate(value: string | null): Date | null {
  if (value === null) return null;
  const match =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(
      value.trim(),
    );
  if (match === null) return null;
  const [
    ,
    year = '',
    month = '01',
    day = '01',
    hour = '00',
    minute = '00',
    second = '00',
    zulu,
    sign,
    offsetHours = '00',
    offsetMinutes = '00',
  ] = match;
  let millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (zulu === undefined && sign !== undefined) {
    const direction = sign === '-' ? -1 : 1;
    millis -= direction * (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;
  }
  return Number.isFinite(millis) ? new Date(millis) : null;
}
