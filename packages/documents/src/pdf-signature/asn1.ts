/**
 * Minimal DER reader for the CMS SignedData blobs carried in PDF signature
 * dictionaries.
 *
 * Why this is hand-written rather than a dependency (docs/DEPENDENCIES.md:
 * "adopted only when they replace meaningful commodity work and have a
 * narrow boundary"): every cryptographic operation this feature needs —
 * certificate parsing, issuer-link verification, RSA/PSS/ECDSA signature
 * verification, digests — is already in Node's standard library
 * (`node:crypto`). The only thing the platform does not expose is a reader
 * for the CMS container, and that reader is a few hundred lines of tag,
 * length, and value handling. Adding an ASN.1 or PKCS#7 package would put
 * a third-party parser directly on the path of a security verdict while
 * replacing no meaningful work, which is precisely the trade this
 * repository declines elsewhere (the clamd INSTREAM client in
 * `malware-scan.ts` is the same call).
 *
 * Scope and posture:
 *
 * - DER only. Definite lengths, minimal length encodings. BER's
 *   indefinite-length form is REFUSED rather than tolerated: a PDF
 *   signature blob is required to be DER, and quietly accepting a
 *   different encoding is how a verifier ends up disagreeing with the
 *   signer about which bytes were signed. The refusal surfaces as an
 *   "unverifiable" verdict, never as "invalid" — the two are different
 *   facts and the product reports them differently.
 * - Every read is bounds-checked against its parent's content, so a
 *   truncated or hostile blob raises `Asn1Error` instead of reading past
 *   the end or looping.
 * - Nesting depth is capped, so a blob of nested constructed tags cannot
 *   exhaust the stack.
 * - Nothing here decides anything. It returns structure; the CMS layer
 *   decides, and `node:crypto` does the mathematics.
 */

/** A malformed, truncated, or non-DER encoding. Never a verdict of
 * "invalid signature" — the caller reports it as unverifiable. */
export class Asn1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Asn1Error';
  }
}

export const TAG_CLASS_UNIVERSAL = 0;
export const TAG_CLASS_CONTEXT = 2;

export const UNIVERSAL_INTEGER = 0x02;
export const UNIVERSAL_OCTET_STRING = 0x04;
export const UNIVERSAL_OBJECT_IDENTIFIER = 0x06;
export const UNIVERSAL_SEQUENCE = 0x10;
export const UNIVERSAL_SET = 0x11;
export const UNIVERSAL_UTC_TIME = 0x17;
export const UNIVERSAL_GENERALIZED_TIME = 0x18;
export const UNIVERSAL_BMP_STRING = 0x1e;

/** How deep a constructed encoding may nest before the reader refuses. A
 * real CMS SignedData with certificates and signed attributes sits around
 * a dozen levels; 40 leaves generous headroom while bounding recursion. */
const MAX_DEPTH = 40;

export interface Asn1Element {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  readonly tagClass: number;
  readonly constructed: boolean;
  readonly tagNumber: number;
  /** The element's complete encoding: identifier, length, and content.
   * Retained because CMS signature verification is defined over exact
   * encoded bytes, not over re-serialised values. */
  readonly bytes: Buffer;
  /** The element's content octets only. */
  readonly content: Buffer;
}

interface LengthRead {
  readonly length: number;
  readonly headerLength: number;
}

/** Reads an identifier octet plus its length, at `offset` within `buffer`. */
function readHeader(buffer: Buffer, offset: number): LengthRead & Asn1Header {
  const identifier = buffer[offset];
  if (identifier === undefined) {
    throw new Asn1Error(`truncated identifier octet at ${String(offset)}`);
  }
  const tagClass = (identifier & 0xc0) >> 6;
  const constructed = (identifier & 0x20) !== 0;
  const tagNumber = identifier & 0x1f;
  let cursor = offset + 1;
  if (tagNumber === 0x1f) {
    // High-tag-number form. Nothing CMS or X.509 uses needs it; refusing
    // keeps the reader small and the refusal is honest.
    throw new Asn1Error(`high-tag-number form is not supported at ${String(offset)}`);
  }

  const firstLengthOctet = buffer[cursor];
  if (firstLengthOctet === undefined) {
    throw new Asn1Error(`truncated length at ${String(cursor)}`);
  }
  cursor += 1;

  if (firstLengthOctet === 0x80) {
    throw new Asn1Error(
      `indefinite-length (BER) encoding at ${String(offset)}; DER is required`,
    );
  }

  let length: number;
  if (firstLengthOctet < 0x80) {
    length = firstLengthOctet;
  } else {
    const octets = firstLengthOctet & 0x7f;
    if (octets > 4) {
      throw new Asn1Error(`length of ${String(octets)} octets is out of range`);
    }
    length = 0;
    for (let index = 0; index < octets; index += 1) {
      const octet = buffer[cursor + index];
      if (octet === undefined) {
        throw new Asn1Error(`truncated long-form length at ${String(cursor)}`);
      }
      length = length * 256 + octet;
    }
    cursor += octets;
    if (length > 0x7fffffff) {
      throw new Asn1Error(`length ${String(length)} is out of range`);
    }
  }

  return {
    tagClass,
    constructed,
    tagNumber,
    length,
    headerLength: cursor - offset,
  };
}

interface Asn1Header {
  readonly tagClass: number;
  readonly constructed: boolean;
  readonly tagNumber: number;
}

/**
 * Reads exactly one element beginning at `offset`. Returns the element and
 * the offset immediately after it.
 */
export function readElement(
  buffer: Buffer,
  offset = 0,
): { readonly element: Asn1Element; readonly end: number } {
  const header = readHeader(buffer, offset);
  const contentStart = offset + header.headerLength;
  const end = contentStart + header.length;
  if (end > buffer.length) {
    throw new Asn1Error(
      `element at ${String(offset)} claims ${String(header.length)} content octets but only ${String(buffer.length - contentStart)} remain`,
    );
  }
  return {
    element: {
      tagClass: header.tagClass,
      constructed: header.constructed,
      tagNumber: header.tagNumber,
      bytes: buffer.subarray(offset, end),
      content: buffer.subarray(contentStart, end),
    },
    end,
  };
}

/** The single top-level element of `buffer`, refusing trailing bytes. */
export function readSingleElement(buffer: Buffer): Asn1Element {
  const { element, end } = readElement(buffer, 0);
  if (end !== buffer.length) {
    throw new Asn1Error(
      `${String(buffer.length - end)} trailing octet(s) after the top-level element`,
    );
  }
  return element;
}

/** The direct children of a constructed element, in encoding order. */
export function children(element: Asn1Element, depth = 0): readonly Asn1Element[] {
  if (depth > MAX_DEPTH) {
    throw new Asn1Error(`nesting deeper than ${String(MAX_DEPTH)} levels`);
  }
  if (!element.constructed) {
    throw new Asn1Error('cannot read children of a primitive element');
  }
  const output: Asn1Element[] = [];
  let offset = 0;
  while (offset < element.content.length) {
    const read = readElement(element.content, offset);
    output.push(read.element);
    offset = read.end;
  }
  return output;
}

export function isUniversal(element: Asn1Element, tagNumber: number): boolean {
  return element.tagClass === TAG_CLASS_UNIVERSAL && element.tagNumber === tagNumber;
}

export function isContext(element: Asn1Element, tagNumber: number): boolean {
  return element.tagClass === TAG_CLASS_CONTEXT && element.tagNumber === tagNumber;
}

export function expectUniversal(element: Asn1Element, tagNumber: number): Asn1Element {
  if (!isUniversal(element, tagNumber)) {
    throw new Asn1Error(
      `expected universal tag ${String(tagNumber)}, found class ${String(element.tagClass)} tag ${String(element.tagNumber)}`,
    );
  }
  return element;
}

/** The child at `index`, or an error naming what was being read. */
export function childAt(
  items: readonly Asn1Element[],
  index: number,
  what: string,
): Asn1Element {
  const found = items[index];
  if (found === undefined) {
    throw new Asn1Error(`${what}: missing element at index ${String(index)}`);
  }
  return found;
}

/** Decodes an OBJECT IDENTIFIER to dotted-decimal form. */
export function readObjectIdentifier(element: Asn1Element): string {
  expectUniversal(element, UNIVERSAL_OBJECT_IDENTIFIER);
  const content = element.content;
  if (content.length === 0) throw new Asn1Error('empty OBJECT IDENTIFIER');
  const parts: number[] = [];
  let value = 0;
  let started = false;
  for (const octet of content) {
    if (!started && octet === 0x80) {
      throw new Asn1Error('non-minimal OBJECT IDENTIFIER subidentifier');
    }
    started = true;
    if (value > (Number.MAX_SAFE_INTEGER - (octet & 0x7f)) / 128) {
      throw new Asn1Error('OBJECT IDENTIFIER subidentifier out of range');
    }
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      if (parts.length === 0) {
        const first = Math.min(2, Math.floor(value / 40));
        parts.push(first, value - first * 40);
      } else {
        parts.push(value);
      }
      value = 0;
      started = false;
    }
  }
  if (started) throw new Asn1Error('truncated OBJECT IDENTIFIER');
  return parts.map((part) => String(part)).join('.');
}

/** Decodes a non-negative INTEGER that is expected to fit a JS safe integer. */
export function readSmallInteger(element: Asn1Element): number {
  expectUniversal(element, UNIVERSAL_INTEGER);
  const content = element.content;
  if (content.length === 0) throw new Asn1Error('empty INTEGER');
  if (content.length > 6) throw new Asn1Error('INTEGER is larger than expected');
  const first = content[0];
  if (first === undefined) throw new Asn1Error('empty INTEGER');
  if ((first & 0x80) !== 0)
    throw new Asn1Error('negative INTEGER is not expected here');
  let value = 0;
  for (const octet of content) value = value * 256 + octet;
  return value;
}

/** An INTEGER as an unpadded uppercase hex string (certificate serials). */
export function readIntegerHex(element: Asn1Element): string {
  expectUniversal(element, UNIVERSAL_INTEGER);
  const hex = element.content.toString('hex').replace(/^(00)+/, '');
  return (hex === '' ? '00' : hex).toUpperCase();
}

/**
 * Decodes the DirectoryString / IA5String forms that appear in X.500 names
 * and CMS attributes. BMPString is UTF-16BE; everything else this
 * encounters is a byte-per-character form that UTF-8 decoding handles
 * (PrintableString is a strict ASCII subset).
 */
export function readText(element: Asn1Element): string {
  if (isUniversal(element, UNIVERSAL_BMP_STRING)) {
    return element.content.swap16().toString('utf16le');
  }
  return element.content.toString('utf8');
}

/**
 * Decodes UTCTime / GeneralizedTime to an exact instant.
 *
 * UTCTime's two-digit year uses the RFC 5280 sliding window (>= 50 is
 * 19xx). Only the zone-qualified forms are accepted: a local-time form
 * without a zone has no defined instant, and guessing one would silently
 * shift a signing time by hours.
 */
export function readTime(element: Asn1Element): Date {
  const text = element.content.toString('ascii');
  const utc = isUniversal(element, UNIVERSAL_UTC_TIME);
  const generalized = isUniversal(element, UNIVERSAL_GENERALIZED_TIME);
  if (!utc && !generalized) {
    throw new Asn1Error(`expected a time type, found tag ${String(element.tagNumber)}`);
  }
  // Both patterns are anchored at BOTH ends and built entirely from
  // fixed-width \d{n} groups; the only quantifiers are a single optional
  // seconds group and an optional fraction, neither nested inside another.
  // Matching is linear in the input length, and the input is at most a few
  // dozen ASCII characters from a certificate's own time field.
  /* eslint-disable security/detect-unsafe-regex -- fixed-width, doubly anchored, no nested quantifier */
  const pattern = utc
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})$/
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})$/;
  /* eslint-enable security/detect-unsafe-regex */
  const match = pattern.exec(text);
  if (match === null)
    throw new Asn1Error(`unparseable time value ${JSON.stringify(text)}`);
  const [
    ,
    rawYear = '',
    month = '',
    day = '',
    hour = '',
    minute = '',
    second,
    zone = 'Z',
  ] = match;
  const year = utc
    ? Number(rawYear) + (Number(rawYear) >= 50 ? 1900 : 2000)
    : Number(rawYear);
  let millis = Date.UTC(
    year,
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second === undefined ? 0 : Number(second),
  );
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(3, 5));
    millis -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  if (!Number.isFinite(millis)) {
    throw new Asn1Error(`unrepresentable time value ${JSON.stringify(text)}`);
  }
  return new Date(millis);
}

/**
 * Re-encodes an element under a different identifier octet, preserving the
 * original length and content octets.
 *
 * CMS signature verification needs exactly this: `signedAttrs` is encoded
 * in the SignerInfo as `[0] IMPLICIT`, but RFC 5652 §5.4 requires the
 * signature to be computed over its DER encoding as a `SET OF`. Rebuilding
 * the length octets is unnecessary — an implicit tag change never alters
 * them — so the substitution is a one-byte rewrite of a copied buffer.
 */
export function reTag(element: Asn1Element, identifierOctet: number): Buffer {
  const copy = Buffer.from(element.bytes);
  copy[0] = identifierOctet;
  return copy;
}
