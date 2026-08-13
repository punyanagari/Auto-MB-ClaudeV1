import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  IrnDerivationError,
  SignedQrClaimError,
  assertIrnDerivesFrom,
  assertSignedQrAgrees,
  deriveIrn,
  readSignedQrClaims,
} from '../src/gsp/irn.js';

/**
 * Audit finding 2 residue: local verification of IRP evidence.
 *
 * These are the arithmetic proofs. The adapter-level refusals are in
 * whitebooks.test.ts and the route-level refusal on the manual
 * compatibility door is in tax-invoices.integration.test.ts.
 */

const identity = {
  gstin: '27AAAAA0000A1Z5',
  documentNumber: 'INV/2026/001',
  documentDate: '2026-08-12',
} as const;

function jws(data: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode({ data: JSON.stringify(data) })}.sig`;
}

describe('IRN derivation', () => {
  it('is the NIC concatenation, hashed — independently reproduced here', () => {
    // Reproduced from the specification rather than from the module, so
    // this fails if the concatenation order or the financial-year form
    // ever changes: SHA-256 of supplier GSTIN + document type + document
    // number + financial year, no separators, lowercase hex.
    const expected = createHash('sha256')
      .update('27AAAAA0000A1Z5INVINV/2026/0012026-27', 'utf8')
      .digest('hex');
    expect(deriveIrn(identity)).toBe(expected);
    expect(deriveIrn(identity)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('puts a credit note in a different place from an invoice of the same number', () => {
    // DocTyp is a hash input, so CRN and INV cannot collide. This is why
    // the credit-note register can reuse the invoice transport safely.
    expect(deriveIrn({ ...identity, documentType: 'CRN' })).not.toBe(
      deriveIrn(identity),
    );
  });

  it('follows the April boundary, so the same number in two years differs', () => {
    // 31 March is the previous financial year; 1 April opens the next. A
    // gap-free per-FY series legitimately reuses a number across that
    // boundary, and the IRN must still be distinct.
    const march = deriveIrn({ ...identity, documentDate: '2027-03-31' });
    const april = deriveIrn({ ...identity, documentDate: '2027-04-01' });
    expect(march).not.toBe(april);
    expect(march).toBe(deriveIrn({ ...identity, documentDate: '2026-08-12' }));
  });

  it('accepts the derived IRN in either case, and refuses any other', () => {
    const irn = deriveIrn(identity);
    expect(() => {
      assertIrnDerivesFrom(irn, identity);
    }).not.toThrow();
    expect(() => {
      assertIrnDerivesFrom(irn.toUpperCase(), identity);
    }).not.toThrow();

    expect(() => {
      assertIrnDerivesFrom('ab12'.repeat(16), identity);
    }).toThrow(IrnDerivationError);
    // A one-character difference is still a different document's IRN.
    const nudged = `${irn.slice(0, 63)}${irn.endsWith('0') ? '1' : '0'}`;
    expect(() => {
      assertIrnDerivesFrom(nudged, identity);
    }).toThrow(IrnDerivationError);
  });

  it('names the malformed case separately from the mismatch case', () => {
    // An operator who typed 63 characters needs a different sentence from
    // one who pasted another invoice's IRN.
    expect(() => {
      assertIrnDerivesFrom('not-hex', identity);
    }).toThrow(
      expect.objectContaining({ code: 'IRP_IRN_MALFORMED' }) as unknown as Error,
    );
    expect(() => {
      assertIrnDerivesFrom('ab12'.repeat(16), identity);
    }).toThrow(
      expect.objectContaining({
        code: 'IRP_IRN_DERIVATION_MISMATCH',
      }) as unknown as Error,
    );
  });

  it('never publishes the expected IRN in the refusal', () => {
    // Handing back the correct hash would tell a forger exactly what to
    // send next time.
    const error = (() => {
      try {
        assertIrnDerivesFrom('ab12'.repeat(16), identity);
        return null;
      } catch (thrown) {
        return thrown as IrnDerivationError;
      }
    })();
    expect(error).not.toBeNull();
    expect(error?.message).not.toContain(deriveIrn(identity));
    expect(error?.offeredIrn).toBe('ab12'.repeat(16));
  });
});

describe('signed QR claims', () => {
  const irn = deriveIrn(identity);

  it('reads the document facts out of the nested JSON string payload', () => {
    const claims = readSignedQrClaims(
      jws({
        SellerGstin: identity.gstin,
        DocNo: identity.documentNumber,
        DocTyp: 'INV',
        DocDt: '12/08/2026',
        Irn: irn.toUpperCase(),
        TotInvVal: '1180.00',
      }),
    );
    expect(claims).toMatchObject({
      irn,
      sellerGstin: identity.gstin,
      documentNumber: identity.documentNumber,
      documentType: 'INV',
      documentDateText: '12/08/2026',
    });
  });

  it('returns null rather than throwing for anything that is not a JWS with an IRN', () => {
    expect(readSignedQrClaims('not-a-jws')).toBeNull();
    expect(readSignedQrClaims('a.b.c')).toBeNull();
    expect(readSignedQrClaims(jws({ DocNo: 'INV/2026/001' }))).toBeNull();
  });

  it('agrees when the QR states the same document, and refuses when it does not', () => {
    const good = jws({
      SellerGstin: identity.gstin,
      DocNo: identity.documentNumber,
      DocTyp: 'INV',
      DocDt: '12/08/2026',
      Irn: irn,
    });
    expect(() => {
      assertSignedQrAgrees(good, irn, identity);
    }).not.toThrow();

    for (const [field, value] of [
      ['SellerGstin', '29BBBBB0000B1Z5'],
      ['DocNo', 'INV/2026/999'],
      ['DocTyp', 'CRN'],
      ['DocDt', '13/08/2026'],
    ] as const) {
      expect(() => {
        assertSignedQrAgrees(
          jws({
            SellerGstin: identity.gstin,
            DocNo: identity.documentNumber,
            DocTyp: 'INV',
            DocDt: '12/08/2026',
            Irn: irn,
            [field]: value,
          }),
          irn,
          identity,
        );
      }, field).toThrow(
        expect.objectContaining({
          code: 'IRP_SIGNED_QR_IDENTITY_MISMATCH',
        }) as unknown as Error,
      );
    }
  });

  it('tolerates an older payload that omits a field, but not one that contradicts it', () => {
    // NIC has added members to this payload over time. An absent field is
    // an older shape, not a contradiction — refusing it would reject valid
    // government evidence.
    expect(() => {
      assertSignedQrAgrees(jws({ Irn: irn }), irn, identity);
    }).not.toThrow();
  });

  it('refuses an unreadable QR outright', () => {
    expect(() => {
      assertSignedQrAgrees('printed-qr-photo', irn, identity);
    }).toThrow(
      expect.objectContaining({
        code: 'IRP_SIGNED_QR_UNREADABLE',
      }) as unknown as SignedQrClaimError,
    );
  });
});
