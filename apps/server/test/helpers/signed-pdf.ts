/**
 * Test-only construction of digitally signed PDFs.
 *
 * The real corpus this feature was built against is customer
 * correspondence — Indian Railways variation orders carrying the names,
 * offices and certificates of named railway officers — so it cannot be
 * committed, and the certificates inside it expire, which would make any
 * fixture derived from them start failing on a date rather than on a
 * change. CI therefore proves the verifier against documents it builds
 * itself: a three-level PKI in the shape of the CCA hierarchy (root ->
 * licensed CA -> signer), and PDFs signed with it in both of the
 * SubFilter shapes the corpus actually uses.
 *
 * Everything here is a DER ENCODER and a PDF WRITER. It implements no
 * cryptography: keys, signatures and digests are `node:crypto`.
 *
 * Deliberately independent of the verifier's own reader — nothing in this
 * file imports from `src/pdf-signature/`. A test whose fixture is built by
 * the code under test proves only that the code agrees with itself.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

/* --- DER encoding ---------------------------------------------------- */

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const octets: number[] = [];
  let remaining = size;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | octets.length, ...octets]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const der = {
  sequence: (...items: Buffer[]) => tlv(0x30, Buffer.concat(items)),
  set: (...items: Buffer[]) => tlv(0x31, Buffer.concat(items)),
  context: (tag: number, ...items: Buffer[]) => tlv(0xa0 | tag, Buffer.concat(items)),
  /** Context tag with the constructed bit cleared, for IMPLICIT primitives. */
  contextPrimitive: (tag: number, content: Buffer) => tlv(0x80 | tag, content),
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
  octetString: (content: Buffer) => tlv(0x04, content),
  bitString: (content: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), content])),
  null: () => tlv(0x05, Buffer.alloc(0)),
  boolean: (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  utf8String: (text: string) => tlv(0x0c, Buffer.from(text, 'utf8')),
  printableString: (text: string) => tlv(0x13, Buffer.from(text, 'ascii')),
  utcTime(at: Date): Buffer {
    const pad = (value: number) => String(value).padStart(2, '0');
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
};

const OID = {
  commonName: '2.5.4.3',
  organisation: '2.5.4.10',
  country: '2.5.4.6',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha1: '1.3.14.3.2.26',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
} as const;

function algorithm(oid: string): Buffer {
  return der.sequence(der.objectIdentifier(oid), der.null());
}

function distinguishedName(common: string, organisation: string): Buffer {
  return der.sequence(
    der.set(der.sequence(der.objectIdentifier(OID.country), der.printableString('IN'))),
    der.set(
      der.sequence(
        der.objectIdentifier(OID.organisation),
        der.utf8String(organisation),
      ),
    ),
    der.set(der.sequence(der.objectIdentifier(OID.commonName), der.utf8String(common))),
  );
}

/* --- Certificates ---------------------------------------------------- */

export interface TestCertificate {
  readonly der: Buffer;
  readonly pem: string;
  readonly name: Buffer;
  readonly serial: number;
  readonly privateKey: KeyObject;
}

export interface IssueCertificateOptions {
  readonly commonName: string;
  readonly organisation: string;
  readonly serial: number;
  readonly isCertificateAuthority: boolean;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** Omit to produce a self-signed certificate (a root). */
  readonly issuer?: TestCertificate;
}

function toPem(certificate: Buffer): string {
  // Wrapped by slicing rather than by a replace with a trailing newline:
  // when the base64 length is an exact multiple of 64 the latter leaves a
  // blank line before the END marker, which OpenSSL rejects. That is a
  // one-in-64 fixture failure and exactly the kind of intermittent
  // nonsense a test helper must not introduce.
  const base64 = certificate.toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 64) {
    lines.push(base64.slice(index, index + 64));
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function issueCertificate(options: IssueCertificateOptions): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const subject = distinguishedName(options.commonName, options.organisation);
  const issuerName = options.issuer?.name ?? subject;
  const signingKey = options.issuer?.privateKey ?? privateKey;

  const extensions: Buffer[] = [
    der.sequence(
      der.objectIdentifier(OID.basicConstraints),
      der.boolean(true),
      der.octetString(
        options.isCertificateAuthority
          ? der.sequence(der.boolean(true))
          : der.sequence(),
      ),
    ),
  ];
  if (options.isCertificateAuthority) {
    // keyCertSign. OpenSSL's issued-by check consults keyUsage when it is
    // present, so a CA that omits it would not be accepted as an issuer.
    extensions.push(
      der.sequence(
        der.objectIdentifier(OID.keyUsage),
        der.boolean(true),
        der.octetString(tlv(0x03, Buffer.from([0x01, 0x06]))),
      ),
    );
  }

  const tbs = der.sequence(
    der.context(0, der.integer(2)),
    der.integer(options.serial),
    algorithm(OID.sha256WithRsa),
    issuerName,
    der.sequence(der.utcTime(options.notBefore), der.utcTime(options.notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    der.context(3, der.sequence(...extensions)),
  );
  const signature = cryptoSign('sha256', tbs, signingKey);
  const certificate = der.sequence(
    tbs,
    algorithm(OID.sha256WithRsa),
    der.bitString(signature),
  );
  return {
    der: certificate,
    pem: toPem(certificate),
    name: subject,
    serial: options.serial,
    privateKey,
  };
}

export interface TestPki {
  readonly root: TestCertificate;
  readonly intermediate: TestCertificate;
  readonly signer: TestCertificate;
}

/**
 * A three-level hierarchy in the shape the real corpus uses: a country
 * root (`CCA India` stands in), a licensed CA under it, and a signer
 * certificate issued to a named railway officer.
 */
export function createTestPki(
  options: {
    readonly signerCommonName?: string;
    readonly signerOrganisation?: string;
    readonly notBefore?: Date;
    readonly notAfter?: Date;
    readonly rootCommonName?: string;
    /** The licensed CA between the root and the signer. Real bills are
     * signed under several of them — XtraTrust, Capricorn and SafeScrypt
     * all appear on one bill in the settlement corpus — so a test that
     * needs distinct signers needs distinct issuers to name them by. */
    readonly caCommonName?: string;
    /**
     * Base for the three serial numbers this hierarchy issues (base,
     * base+1, base+2).
     *
     * A certificate's identity is its ISSUER plus its SERIAL (RFC 5280),
     * and consumers compare on exactly that. Two hierarchies built with
     * the default base therefore mint signer certificates that are
     * indistinguishable to such a consumer even though the key material
     * differs — which silently defeats any test of a distinct-signer
     * rule. Pass a different base per hierarchy when that matters.
     */
    readonly serialBase?: number;
  } = {},
): TestPki {
  const notBefore = options.notBefore ?? new Date('2024-01-01T00:00:00Z');
  const notAfter = options.notAfter ?? new Date('2034-01-01T00:00:00Z');
  const serialBase = options.serialBase ?? 1;
  const root = issueCertificate({
    commonName: options.rootCommonName ?? 'Test Root of India',
    organisation: 'Test PKI',
    serial: serialBase,
    isCertificateAuthority: true,
    notBefore,
    notAfter,
  });
  const intermediate = issueCertificate({
    commonName: options.caCommonName ?? 'Test Licensed CA 2024',
    organisation: 'Test Certifying Authority',
    serial: serialBase + 1,
    isCertificateAuthority: true,
    notBefore,
    notAfter,
    issuer: root,
  });
  const signer = issueCertificate({
    commonName: options.signerCommonName ?? 'TEST SIGNER',
    organisation: options.signerOrganisation ?? 'TEST RAILWAY',
    serial: serialBase + 2,
    isCertificateAuthority: false,
    notBefore,
    notAfter,
    issuer: intermediate,
  });
  return { root, intermediate, signer };
}

/* --- CMS SignedData -------------------------------------------------- */

export type SignatureShape = 'adbe.pkcs7.detached' | 'adbe.pkcs7.sha1';

/**
 * Builds the CMS blob a PDF `/Contents` string carries.
 *
 * `adbe.pkcs7.detached` produces signed attributes over the SHA-256 of the
 * ByteRange bytes; `adbe.pkcs7.sha1` reproduces the deprecated form every
 * IREPS document in the corpus uses — the SHA-1 of the ByteRange bytes is
 * ENCAPSULATED, there are no signed attributes at all, and the signature
 * covers that encapsulated digest rather than the document.
 */
function buildSignedData(
  pki: TestPki,
  signedContent: Buffer,
  shape: SignatureShape,
  overrides: { readonly corruptSignature?: boolean } = {},
): Buffer {
  const certificates = der.context(
    0,
    pki.signer.der,
    pki.intermediate.der,
    pki.root.der,
  );
  // IssuerAndSerialNumber names the ISSUER of the signing certificate —
  // the licensed CA — together with the signer's serial. Naming the
  // signer's own subject here is a classic slip that leaves the verifier
  // unable to find the certificate at all.
  const signerIdentifier = der.sequence(
    pki.intermediate.name,
    der.integer(pki.signer.serial),
  );

  let digestAlgorithmOid: string;
  let encapsulated: Buffer;
  let toSign: Buffer;
  let signedAttributes: Buffer | null = null;

  if (shape === 'adbe.pkcs7.sha1') {
    digestAlgorithmOid = OID.sha1;
    const digest = createHash('sha1').update(signedContent).digest();
    encapsulated = der.sequence(
      der.objectIdentifier(OID.data),
      der.context(0, der.octetString(digest)),
    );
    toSign = digest;
  } else {
    digestAlgorithmOid = OID.sha256;
    encapsulated = der.sequence(der.objectIdentifier(OID.data));
    const attributes = [
      der.sequence(
        der.objectIdentifier(OID.contentType),
        der.set(der.objectIdentifier(OID.data)),
      ),
      der.sequence(
        der.objectIdentifier(OID.messageDigest),
        der.set(der.octetString(createHash('sha256').update(signedContent).digest())),
      ),
    ];
    // Signed as a SET OF, carried in the SignerInfo as [0] IMPLICIT.
    toSign = der.set(...attributes);
    signedAttributes = der.context(0, ...attributes);
  }

  const hash = shape === 'adbe.pkcs7.sha1' ? 'sha1' : 'sha256';
  const signature = cryptoSign(hash, toSign, pki.signer.privateKey);
  if (overrides.corruptSignature === true) {
    // Flip a bit in the middle: still a well-formed OCTET STRING of the
    // right length, so only the mathematics can reject it.
    const index = Math.floor(signature.length / 2);
    signature[index] = (signature[index] ?? 0) ^ 0x01;
  }

  const signerInfo = der.sequence(
    der.integer(1),
    signerIdentifier,
    algorithm(digestAlgorithmOid),
    ...(signedAttributes === null ? [] : [signedAttributes]),
    algorithm(OID.rsaEncryption),
    der.octetString(signature),
  );

  return der.sequence(
    der.objectIdentifier(OID.signedData),
    der.context(
      0,
      der.sequence(
        der.integer(1),
        der.set(algorithm(digestAlgorithmOid)),
        encapsulated,
        certificates,
        der.set(signerInfo),
      ),
    ),
  );
}

/* --- PDF assembly ---------------------------------------------------- */

/** Bytes reserved for the hexadecimal `/Contents` string. Real signing
 * tools reserve a fixed block so the blob can be spliced in without moving
 * any offset; this reproduces that exactly, because the verifier's
 * ByteRange/Contents alignment rule depends on it. */
const CONTENTS_HEX_RESERVATION = 16_384;

export interface SignPdfOptions {
  /** Defaults to a freshly generated hierarchy. Pass one to sign several
   * revisions with the same signer, or to sign with a PKI whose root the
   * verifier has not been given. */
  readonly pki?: TestPki;
  readonly shape?: SignatureShape;
  readonly signerName?: string;
  readonly reason?: string;
  readonly location?: string;
  readonly signingTime?: string;
  readonly corruptSignature?: boolean;
}

/** A minimal but structurally real single-page PDF with no signature. */
export function unsignedPdf(text = 'Variation statement'): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${String(text.length + 45)} >>\nstream\nBT /F1 12 Tf 72 760 Td (${text}) Tj ET\nendstream`,
  ];
  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/**
 * Appends a signed incremental update to `base`, exactly as a signing tool
 * does: the revision is written with a zero-filled `/Contents`
 * reservation, the ByteRange is computed against the real offsets, the
 * digest is taken over the two spans, and the blob is spliced into the
 * reservation without moving a byte.
 */
export function appendSignature(base: Buffer, options: SignPdfOptions = {}): Buffer {
  const pki = options.pki ?? createTestPki();
  const shape = options.shape ?? 'adbe.pkcs7.detached';
  const start = base.length;
  const existing = [...base.toString('latin1').matchAll(/(\d+) 0 obj/g)].map((match) =>
    Number(match[1]),
  );
  const nextId = Math.max(0, ...existing) + 1;

  const dictionary =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${shape}` +
    ` /Name (${options.signerName ?? 'TEST SIGNER'})` +
    ` /Reason (${options.reason ?? 'Variation Signing By Test'})` +
    ` /Location (${options.location ?? 'Test Division'})` +
    ` /M (${options.signingTime ?? "D:20250101120000+05'30'"})` +
    ' /Contents <';
  const afterContents = '> /ByteRange [0 %%%%%%%%%% %%%%%%%%%% %%%%%%%%%%] >>';

  const header = `\n${String(nextId)} 0 obj\n${dictionary}`;
  const contentsStart = start + header.length - 1; // offset of '<'
  const contentsEnd = contentsStart + CONTENTS_HEX_RESERVATION + 2; // past '>'

  let revision =
    header + '0'.repeat(CONTENTS_HEX_RESERVATION) + afterContents + '\nendobj\n';
  const xrefOffset = start + revision.length;
  revision +=
    `xref\n0 1\n0000000000 65535 f \n${String(nextId)} 1\n` +
    `${String(start + 1).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size ${String(nextId + 1)} /Root 1 0 R /Prev 0 >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  const total = start + revision.length;
  const byteRange = [0, contentsStart, contentsEnd, total - contentsEnd] as const;
  const rendered = `[0 ${String(byteRange[1])} ${String(byteRange[2])} ${String(byteRange[3])}]`;
  const placeholder = '[0 %%%%%%%%%% %%%%%%%%%% %%%%%%%%%%]';
  // The rendered range must occupy exactly the placeholder's width, or
  // every offset computed above moves.
  const padded =
    rendered.slice(0, -1) + ' '.repeat(placeholder.length - rendered.length) + ']';
  revision = revision.replace(placeholder, padded);

  const draft = Buffer.concat([base, Buffer.from(revision, 'latin1')]);
  const signedContent = Buffer.concat([
    draft.subarray(0, byteRange[1]),
    draft.subarray(byteRange[2], byteRange[2] + byteRange[3]),
  ]);
  const cms = buildSignedData(pki, signedContent, shape, {
    ...(options.corruptSignature === true ? { corruptSignature: true } : {}),
  });
  const hex = cms.toString('hex').padEnd(CONTENTS_HEX_RESERVATION, '0');
  if (hex.length !== CONTENTS_HEX_RESERVATION) {
    throw new Error('the CMS blob does not fit the /Contents reservation');
  }
  draft.write(hex, contentsStart + 1, 'latin1');
  return draft;
}
