/**
 * CMS `SignedData` (RFC 5652) reading and signature verification for the
 * blobs carried in a PDF `/Contents` string.
 *
 * The structure is read here; every cryptographic operation is Node's
 * (`node:crypto`): digests, RSA PKCS#1 v1.5, RSASSA-PSS and ECDSA
 * verification, and X.509 parsing all come from the platform. Nothing in
 * this file implements cryptography.
 */

import {
  createHash,
  constants as cryptoConstants,
  createPublicKey,
  verify as cryptoVerify,
  X509Certificate,
} from 'node:crypto';
import {
  Asn1Error,
  UNIVERSAL_OCTET_STRING,
  UNIVERSAL_SEQUENCE,
  UNIVERSAL_SET,
  childAt,
  children,
  isContext,
  isUniversal,
  readIntegerHex,
  readObjectIdentifier,
  readSingleElement,
  readSmallInteger,
  readTime,
  reTag,
  type Asn1Element,
} from './asn1.js';

export const OID_DATA = '1.2.840.113549.1.7.1';
export const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
export const OID_ATTR_CONTENT_TYPE = '1.2.840.113549.1.9.3';
export const OID_ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
export const OID_ATTR_SIGNING_TIME = '1.2.840.113549.1.9.5';
export const OID_ATTR_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
export const OID_ATTR_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';
export const OID_CT_TST_INFO = '1.2.840.113549.1.9.16.1.4';

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_RSASSA_PSS = '1.2.840.113549.1.1.10';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';

/** Digest OIDs this verifier understands, mapped to Node digest names.
 *
 * SHA-1 is present because it is what the Indian Railways corpus uses:
 * every IREPS signature seen so far is `adbe.pkcs7.sha1`. Refusing it
 * would report every real document as unverifiable, which is worse than
 * reporting it as verified-with-a-weak-digest and saying so — `WEAK_DIGESTS`
 * below drives that disclosure all the way to the screen. MD5 is NOT
 * accepted: it is broken for collision AND has no corpus to serve. */
const DIGEST_OIDS = new Map<string, string>([
  ['1.3.14.3.2.26', 'sha1'],
  ['2.16.840.1.101.3.4.2.1', 'sha256'],
  ['2.16.840.1.101.3.4.2.2', 'sha384'],
  ['2.16.840.1.101.3.4.2.3', 'sha512'],
  ['2.16.840.1.101.3.4.2.4', 'sha224'],
]);

/** Digests whose collision resistance is broken. A signature over one of
 * these still proves the signer's key was applied, but it no longer proves
 * the signed bytes are unique — a second document with the same digest is
 * constructible. Reported, never silently accepted as equivalent. */
export const WEAK_DIGESTS: ReadonlySet<string> = new Set(['sha1']);

/** Signature-algorithm OIDs, mapped to the key family and (where the OID
 * fixes it) the digest. The combined `<hash>With<key>` OIDs are common in
 * SignerInfo.signatureAlgorithm even though RFC 5652 prefers the bare key
 * algorithm; both forms are accepted. */
const SIGNATURE_OIDS = new Map<string, { family: 'rsa' | 'rsa-pss' | 'ecdsa' }>([
  [OID_RSA_ENCRYPTION, { family: 'rsa' }],
  ['1.2.840.113549.1.1.5', { family: 'rsa' }],
  ['1.2.840.113549.1.1.11', { family: 'rsa' }],
  ['1.2.840.113549.1.1.12', { family: 'rsa' }],
  ['1.2.840.113549.1.1.13', { family: 'rsa' }],
  ['1.2.840.113549.1.1.14', { family: 'rsa' }],
  [OID_RSASSA_PSS, { family: 'rsa-pss' }],
  [OID_EC_PUBLIC_KEY, { family: 'ecdsa' }],
  ['1.2.840.10045.4.1', { family: 'ecdsa' }],
  ['1.2.840.10045.4.3.1', { family: 'ecdsa' }],
  ['1.2.840.10045.4.3.2', { family: 'ecdsa' }],
  ['1.2.840.10045.4.3.3', { family: 'ecdsa' }],
  ['1.2.840.10045.4.3.4', { family: 'ecdsa' }],
]);

export interface CmsAttribute {
  readonly type: string;
  readonly values: readonly Asn1Element[];
}

export interface CmsSignerInfo {
  readonly digestAlgorithm: string;
  readonly signatureFamily: 'rsa' | 'rsa-pss' | 'ecdsa';
  /** PSS salt length in bytes when the algorithm is RSASSA-PSS. */
  readonly pssSaltLength: number | null;
  readonly signature: Buffer;
  readonly signedAttributes: readonly CmsAttribute[] | null;
  readonly unsignedAttributes: readonly CmsAttribute[] | null;
  /** The exact bytes RFC 5652 §5.4 says are signed when signedAttrs are
   * present: the signedAttrs re-tagged from `[0] IMPLICIT` to `SET OF`. */
  readonly signedAttributesDer: Buffer | null;
  /** DER of the issuer Name from IssuerAndSerialNumber, hex, for matching
   * the signing certificate by exact encoding rather than by a rendered
   * string. */
  readonly issuerDerHex: string | null;
  readonly serialHex: string | null;
  readonly subjectKeyIdentifier: string | null;
}

export interface CmsSignedData {
  readonly eContentType: string;
  /** Encapsulated content, when the CMS carries it (as `adbe.pkcs7.sha1`
   * does). Null for a detached signature. */
  readonly eContent: Buffer | null;
  readonly certificates: readonly X509Certificate[];
  /** Whether the blob carries revocation material of its own. Reported so
   * "no revocation data was available" is a stated fact rather than an
   * assumption. */
  readonly hasCrls: boolean;
  readonly signers: readonly CmsSignerInfo[];
}

function algorithmOid(element: Asn1Element): {
  readonly oid: string;
  readonly parameters: Asn1Element | null;
} {
  const parts = children(element);
  const oid = readObjectIdentifier(childAt(parts, 0, 'AlgorithmIdentifier'));
  return { oid, parameters: parts[1] ?? null };
}

function readPssSaltLength(parameters: Asn1Element | null): number {
  // RSASSA-PSS-params ::= SEQUENCE { hashAlgorithm [0], maskGenAlgorithm [1],
  //                                  saltLength [2] INTEGER DEFAULT 20, ... }
  if (parameters === null || !isUniversal(parameters, UNIVERSAL_SEQUENCE)) return 20;
  for (const child of children(parameters)) {
    if (isContext(child, 2)) {
      return readSmallInteger(childAt(children(child), 0, 'PSS saltLength'));
    }
  }
  return 20;
}

function readAttributes(element: Asn1Element): readonly CmsAttribute[] {
  return children(element).map((attribute) => {
    const parts = children(attribute);
    const type = readObjectIdentifier(childAt(parts, 0, 'Attribute type'));
    const values = childAt(parts, 1, 'Attribute values');
    return { type, values: children(values) };
  });
}

export function findAttribute(
  attributes: readonly CmsAttribute[] | null,
  type: string,
): CmsAttribute | null {
  if (attributes === null) return null;
  const matches = attributes.filter((attribute) => attribute.type === type);
  // RFC 5652 permits one instance of each attribute type. Two instances of
  // messageDigest is an attacker's way of getting one verifier to check the
  // first and another to display the second, so a duplicate is refused
  // rather than resolved by picking one.
  if (matches.length > 1) {
    throw new Asn1Error(`attribute ${type} appears ${String(matches.length)} times`);
  }
  return matches[0] ?? null;
}

function readSignerInfo(element: Asn1Element): CmsSignerInfo {
  const parts = children(element);
  let index = 0;
  const version = readSmallInteger(childAt(parts, index, 'SignerInfo version'));
  index += 1;
  const sid = childAt(parts, index, 'SignerIdentifier');
  index += 1;

  let issuerDerHex: string | null = null;
  let serialHex: string | null = null;
  let subjectKeyIdentifier: string | null = null;
  if (isUniversal(sid, UNIVERSAL_SEQUENCE)) {
    const issuerAndSerial = children(sid);
    issuerDerHex = childAt(issuerAndSerial, 0, 'issuer').bytes.toString('hex');
    serialHex = readIntegerHex(childAt(issuerAndSerial, 1, 'serialNumber'));
  } else if (isContext(sid, 0)) {
    subjectKeyIdentifier = sid.content.toString('hex');
  } else {
    throw new Asn1Error(`unrecognised SignerIdentifier (version ${String(version)})`);
  }

  const digestOid = algorithmOid(childAt(parts, index, 'digestAlgorithm')).oid;
  index += 1;
  const digestAlgorithm = DIGEST_OIDS.get(digestOid);
  if (digestAlgorithm === undefined) {
    throw new Asn1Error(`unsupported digest algorithm ${digestOid}`);
  }

  let signedAttributes: readonly CmsAttribute[] | null = null;
  let signedAttributesDer: Buffer | null = null;
  const maybeSignedAttrs = childAt(parts, index, 'SignerInfo body');
  if (isContext(maybeSignedAttrs, 0)) {
    signedAttributes = readAttributes(maybeSignedAttrs);
    signedAttributesDer = reTag(maybeSignedAttrs, 0x20 | UNIVERSAL_SET);
    index += 1;
  }

  const signatureAlgorithm = algorithmOid(childAt(parts, index, 'signatureAlgorithm'));
  index += 1;
  const family = SIGNATURE_OIDS.get(signatureAlgorithm.oid);
  if (family === undefined) {
    throw new Asn1Error(`unsupported signature algorithm ${signatureAlgorithm.oid}`);
  }

  const signature = childAt(parts, index, 'signature');
  index += 1;
  if (!isUniversal(signature, UNIVERSAL_OCTET_STRING)) {
    throw new Asn1Error('SignerInfo signature is not an OCTET STRING');
  }

  let unsignedAttributes: readonly CmsAttribute[] | null = null;
  const maybeUnsigned = parts[index];
  if (maybeUnsigned !== undefined && isContext(maybeUnsigned, 1)) {
    unsignedAttributes = readAttributes(maybeUnsigned);
  }

  return {
    digestAlgorithm,
    signatureFamily: family.family,
    pssSaltLength:
      family.family === 'rsa-pss' ? readPssSaltLength(signatureAlgorithm.parameters) : null,
    signature: Buffer.from(signature.content),
    signedAttributes,
    unsignedAttributes,
    signedAttributesDer,
    issuerDerHex,
    serialHex,
    subjectKeyIdentifier,
  };
}

/** Parses a CMS `ContentInfo` carrying `SignedData`. */
export function parseSignedData(der: Buffer): CmsSignedData {
  const contentInfo = children(readSingleElement(der));
  const contentType = readObjectIdentifier(childAt(contentInfo, 0, 'ContentInfo type'));
  if (contentType !== OID_SIGNED_DATA) {
    throw new Asn1Error(`CMS content type ${contentType} is not SignedData`);
  }
  const explicitContent = childAt(contentInfo, 1, 'ContentInfo content');
  if (!isContext(explicitContent, 0)) {
    throw new Asn1Error('ContentInfo content is not [0] EXPLICIT');
  }
  const signedData = children(childAt(children(explicitContent), 0, 'SignedData'));

  let index = 0;
  readSmallInteger(childAt(signedData, index, 'SignedData version'));
  index += 1;
  index += 1; // digestAlgorithms; the per-signer algorithm is authoritative.

  const encap = children(childAt(signedData, index, 'EncapsulatedContentInfo'));
  index += 1;
  const eContentType = readObjectIdentifier(childAt(encap, 0, 'eContentType'));
  let eContent: Buffer | null = null;
  const eContentHolder = encap[1];
  if (eContentHolder !== undefined) {
    if (!isContext(eContentHolder, 0)) {
      throw new Asn1Error('eContent is not [0] EXPLICIT');
    }
    const octets = childAt(children(eContentHolder), 0, 'eContent');
    if (!isUniversal(octets, UNIVERSAL_OCTET_STRING)) {
      throw new Asn1Error('eContent is not an OCTET STRING');
    }
    eContent = Buffer.from(octets.content);
  }

  const certificates: X509Certificate[] = [];
  let hasCrls = false;
  for (; index < signedData.length; index += 1) {
    const element = childAt(signedData, index, 'SignedData body');
    if (isContext(element, 0)) {
      for (const candidate of children(element)) {
        // Only plain certificates; the other CertificateChoices alternatives
        // (attribute certificates, "other" formats) are not path material.
        if (!isUniversal(candidate, UNIVERSAL_SEQUENCE)) continue;
        try {
          certificates.push(new X509Certificate(candidate.bytes));
        } catch {
          // A malformed entry in the certificate bag is not fatal: the
          // signing certificate may still be present and verifiable. It
          // simply cannot join a path.
        }
      }
      continue;
    }
    if (isContext(element, 1)) {
      hasCrls = children(element).length > 0;
      continue;
    }
    if (isUniversal(element, UNIVERSAL_SET)) {
      const signers = children(element).map((signer) => readSignerInfo(signer));
      if (signers.length === 0) throw new Asn1Error('SignedData carries no SignerInfo');
      return { eContentType, eContent, certificates, hasCrls, signers };
    }
  }
  throw new Asn1Error('SignedData carries no signerInfos');
}

/** The exact DER of a certificate's issuer Name and its serial, so a
 * SignerIdentifier can be matched by encoding rather than by a rendered
 * string (where escaping and attribute ordering differ between producers). */
export function certificateIdentity(certificate: X509Certificate): {
  readonly issuerDerHex: string;
  readonly serialHex: string;
  readonly subjectDerHex: string;
} {
  const tbs = children(childAt(children(readSingleElement(certificate.raw)), 0, 'tbs'));
  // TBSCertificate ::= SEQUENCE { [0] version DEFAULT v1, serialNumber,
  //                               signature, issuer, validity, subject, ... }
  let index = 0;
  if (isContext(childAt(tbs, 0, 'TBSCertificate'), 0)) index += 1;
  const serialHex = readIntegerHex(childAt(tbs, index, 'serialNumber'));
  index += 2; // skip signature AlgorithmIdentifier
  const issuerDerHex = childAt(tbs, index, 'issuer').bytes.toString('hex');
  index += 2; // skip validity
  const subjectDerHex = childAt(tbs, index, 'subject').bytes.toString('hex');
  return { issuerDerHex, serialHex, subjectDerHex };
}

/** The certificate a SignerInfo names, out of the CMS certificate bag. */
export function findSigningCertificate(
  signedData: CmsSignedData,
  signer: CmsSignerInfo,
): X509Certificate | null {
  if (signer.subjectKeyIdentifier !== null) {
    for (const certificate of signedData.certificates) {
      if (subjectKeyIdentifierOf(certificate) === signer.subjectKeyIdentifier) {
        return certificate;
      }
    }
    return null;
  }
  for (const certificate of signedData.certificates) {
    const identity = certificateIdentity(certificate);
    if (
      identity.issuerDerHex === signer.issuerDerHex &&
      identity.serialHex === signer.serialHex
    ) {
      return certificate;
    }
  }
  return null;
}

const OID_SUBJECT_KEY_IDENTIFIER = '2.5.29.14';

/** The SubjectKeyIdentifier extension value, hex, or null when absent. */
export function subjectKeyIdentifierOf(certificate: X509Certificate): string | null {
  const tbs = children(childAt(children(readSingleElement(certificate.raw)), 0, 'tbs'));
  for (const element of tbs) {
    if (!isContext(element, 3)) continue;
    for (const extension of children(childAt(children(element), 0, 'extensions'))) {
      const parts = children(extension);
      if (readObjectIdentifier(childAt(parts, 0, 'extnID')) !== OID_SUBJECT_KEY_IDENTIFIER) {
        continue;
      }
      const value = parts[parts.length - 1];
      if (value === undefined || !isUniversal(value, UNIVERSAL_OCTET_STRING)) return null;
      const inner = readSingleElement(Buffer.from(value.content));
      return inner.content.toString('hex');
    }
  }
  return null;
}

export type ContentIntegrity =
  | { readonly kind: 'intact' }
  | { readonly kind: 'digest_mismatch'; readonly detail: string };

/**
 * Checks that the CMS is bound to `content` — the bytes the PDF ByteRange
 * selected.
 *
 * Two shapes exist in the wild and they bind differently:
 *
 * - `adbe.pkcs7.detached` / `ETSI.CAdES.detached`: the CMS carries no
 *   content; the messageDigest signed attribute must equal the digest of
 *   the ByteRange bytes.
 * - `adbe.pkcs7.sha1` (what every IREPS document seen so far uses): the CMS
 *   ENCAPSULATES the SHA-1 digest of the ByteRange bytes, and messageDigest
 *   then covers that encapsulated octet string. Both links must hold —
 *   checking only the second would verify a signature over an octet string
 *   that has nothing to do with this document.
 */
export function checkContentBinding(
  signedData: CmsSignedData,
  signer: CmsSignerInfo,
  content: Buffer,
  subFilter: string | null,
): ContentIntegrity {
  let digested: Buffer;
  if (signedData.eContent === null) {
    digested = content;
  } else {
    // The encapsulated form: prove the encapsulated octets really are the
    // digest of this document's bytes before believing anything signed over
    // them.
    const encapsulatedDigest =
      subFilter === 'adbe.pkcs7.sha1'
        ? createHash('sha1').update(content).digest()
        : createHash(signer.digestAlgorithm).update(content).digest();
    if (!encapsulatedDigest.equals(signedData.eContent)) {
      return {
        kind: 'digest_mismatch',
        detail:
          'the digest encapsulated in the signature does not match the bytes the signature claims to cover',
      };
    }
    digested = signedData.eContent;
  }

  if (signer.signedAttributes === null) return { kind: 'intact' };

  const attribute = findAttribute(signer.signedAttributes, OID_ATTR_MESSAGE_DIGEST);
  if (attribute === null) {
    return {
      kind: 'digest_mismatch',
      detail: 'the signature carries signed attributes but no messageDigest attribute',
    };
  }
  const value = attribute.values[0];
  if (value === undefined || !isUniversal(value, UNIVERSAL_OCTET_STRING)) {
    return {
      kind: 'digest_mismatch',
      detail: 'the messageDigest attribute is not an OCTET STRING',
    };
  }
  const expected = createHash(signer.digestAlgorithm).update(digested).digest();
  if (!expected.equals(value.content)) {
    return {
      kind: 'digest_mismatch',
      detail: 'the messageDigest attribute does not match the signed content',
    };
  }

  const contentTypeAttribute = findAttribute(
    signer.signedAttributes,
    OID_ATTR_CONTENT_TYPE,
  );
  if (contentTypeAttribute !== null) {
    const declared = contentTypeAttribute.values[0];
    if (declared !== undefined) {
      const declaredOid = readObjectIdentifier(declared);
      if (declaredOid !== signedData.eContentType) {
        return {
          kind: 'digest_mismatch',
          detail: `the signed contentType attribute (${declaredOid}) does not match the encapsulated content type (${signedData.eContentType})`,
        };
      }
    }
  }
  return { kind: 'intact' };
}

/**
 * Verifies the signer's signature with the certificate's public key, over
 * the exact bytes RFC 5652 defines: the re-tagged signedAttrs when they are
 * present, the content itself when they are not.
 */
export function verifySignerSignature(
  signer: CmsSignerInfo,
  certificate: X509Certificate,
  content: Buffer,
): boolean {
  const signed = signer.signedAttributesDer ?? content;
  const key = createPublicKey(certificate.publicKey);
  if (signer.signatureFamily === 'rsa-pss') {
    return cryptoVerify(
      signer.digestAlgorithm,
      signed,
      {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: signer.pssSaltLength ?? 20,
      },
      signer.signature,
    );
  }
  if (signer.signatureFamily === 'ecdsa') {
    return cryptoVerify(
      signer.digestAlgorithm,
      signed,
      { key, dsaEncoding: 'der' },
      signer.signature,
    );
  }
  return cryptoVerify(signer.digestAlgorithm, signed, key, signer.signature);
}

/** The `signingTime` signed attribute, when present. Signed, so it cannot
 * be altered after the fact — but it is still a claim by the signer's own
 * clock, not an attestation by a third party. */
export function readSigningTimeAttribute(signer: CmsSignerInfo): Date | null {
  const attribute = findAttribute(signer.signedAttributes, OID_ATTR_SIGNING_TIME);
  const value = attribute?.values[0];
  if (value === undefined) return null;
  try {
    return readTime(value);
  } catch {
    return null;
  }
}

export interface TstInfo {
  readonly genTime: Date;
  readonly digestAlgorithm: string;
  readonly messageImprint: Buffer;
  readonly serialHex: string;
  readonly policy: string;
}

/** Parses the `TSTInfo` an RFC 3161 timestamp token encapsulates. */
export function parseTstInfo(der: Buffer): TstInfo {
  const parts = children(readSingleElement(der));
  readSmallInteger(childAt(parts, 0, 'TSTInfo version'));
  const policy = readObjectIdentifier(childAt(parts, 1, 'TSTInfo policy'));
  const imprint = children(childAt(parts, 2, 'messageImprint'));
  const digestOid = algorithmOid(childAt(imprint, 0, 'messageImprint algorithm')).oid;
  const digestAlgorithm = DIGEST_OIDS.get(digestOid);
  if (digestAlgorithm === undefined) {
    throw new Asn1Error(`unsupported timestamp digest algorithm ${digestOid}`);
  }
  const imprintValue = childAt(imprint, 1, 'messageImprint value');
  if (!isUniversal(imprintValue, UNIVERSAL_OCTET_STRING)) {
    throw new Asn1Error('messageImprint value is not an OCTET STRING');
  }
  const serialHex = readIntegerHex(childAt(parts, 3, 'TSTInfo serialNumber'));
  const genTime = readTime(childAt(parts, 4, 'TSTInfo genTime'));
  return {
    genTime,
    digestAlgorithm,
    messageImprint: Buffer.from(imprintValue.content),
    serialHex,
    policy,
  };
}
