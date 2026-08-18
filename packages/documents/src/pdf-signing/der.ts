/**
 * Minimal DER encoder.
 *
 * The counterpart of `../pdf-signature/asn1.ts`, which reads. Both exist
 * for the same reason and decline the same dependency: every cryptographic
 * operation this product needs is in `node:crypto`, and the only thing the
 * platform does not expose is the CMS container. Reading it was a few
 * hundred lines; writing it is fewer, because a writer only ever emits the
 * shapes it chose.
 *
 * DER, not BER: definite lengths, minimal length octets, `SET OF` members
 * emitted in the order the caller gives them. Nothing here decides
 * anything — `cms-build.ts` decides what to encode and `node:crypto` does
 * the mathematics.
 *
 * This module was previously `apps/server/test/helpers/signed-pdf.ts`'s
 * private encoder. It moved here when the product gained a real signer, so
 * that the fixture builder and the signer emit identical encodings rather
 * than two encoders drifting apart. The independence that test helper's
 * header insists on is preserved and is the one that matters: the verifier
 * has its own reader (`../pdf-signature/asn1.ts`) and imports nothing from
 * here, so a fixture is still never checked by the code that built it.
 */

/** DER length octets: short form below 128, long form above. */
function lengthOctets(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const octets: number[] = [];
  let remaining = size;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | octets.length, ...octets]);
}

/** One tag-length-value triple. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthOctets(content.length), content]);
}

export const der = {
  sequence: (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items)),
  context: (tag: number, ...items: Buffer[]): Buffer =>
    tlv(0xa0 | tag, Buffer.concat(items)),
  /** Context tag with the constructed bit cleared, for IMPLICIT primitives. */
  contextPrimitive: (tag: number, content: Buffer): Buffer => tlv(0x80 | tag, content),
  integer(value: number | Buffer): Buffer {
    if (Buffer.isBuffer(value)) {
      const first = value[0] ?? 0;
      return tlv(
        0x02,
        (first & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value,
      );
    }
    if (value === 0) return tlv(0x02, Buffer.from([0]));
    const octets: number[] = [];
    let remaining = value;
    while (remaining > 0) {
      octets.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    if (((octets[0] ?? 0) & 0x80) !== 0) octets.unshift(0);
    return tlv(0x02, Buffer.from(octets));
  },
  octetString: (content: Buffer): Buffer => tlv(0x04, content),
  bitString: (content: Buffer): Buffer =>
    tlv(0x03, Buffer.concat([Buffer.from([0]), content])),
  null: (): Buffer => tlv(0x05, Buffer.alloc(0)),
  boolean: (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  utf8String: (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8')),
  printableString: (text: string): Buffer => tlv(0x13, Buffer.from(text, 'ascii')),
  utcTime(at: Date): Buffer {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const text =
      pad(at.getUTCFullYear() % 100) +
      pad(at.getUTCMonth() + 1) +
      pad(at.getUTCDate()) +
      pad(at.getUTCHours()) +
      pad(at.getUTCMinutes()) +
      pad(at.getUTCSeconds()) +
      'Z';
    return tlv(0x17, Buffer.from(text, 'ascii'));
  },
  objectIdentifier(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const [first = 0, second = 0, ...rest] = parts;
    const octets: number[] = [first * 40 + second];
    for (const part of rest) {
      const chunks: number[] = [part & 0x7f];
      let remaining = Math.floor(part / 128);
      while (remaining > 0) {
        chunks.unshift((remaining & 0x7f) | 0x80);
        remaining = Math.floor(remaining / 128);
      }
      octets.push(...chunks);
    }
    return tlv(0x06, Buffer.from(octets));
  },
} as const;

/** An AlgorithmIdentifier with the explicit NULL parameters RSA and the
 * SHA-2 family are written with in practice. */
export function algorithmIdentifier(oid: string): Buffer {
  return der.sequence(der.objectIdentifier(oid), der.null());
}
