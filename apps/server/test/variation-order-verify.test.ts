import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VARIATION_ORDER_CLAIM_CODES,
  describeFailedClaims,
  findRowForItem,
  parsePrintedAmount,
  readVariationRows,
  verifyVariationOrder,
  type OmissionUnderVerification,
  type VariationOrderClaimCode,
} from '../src/variation-order-verify.js';

/**
 * The variation-order corpus, in the shape `packages/loa-parser`'s LOA
 * corpus already established: real orders, extracted with Poppler's
 * `pdftotext -layout` exactly as the server extracts them, committed as
 * TEXT with a hashed manifest — never the source PDFs. Real vendor names
 * and figures are retained verbatim, as `corpus.json` does
 * ("verbatim-names-retained"), because the recognition rules are
 * calibrated against what the railway actually prints.
 *
 * Adding a new order is: drop its `.txt` beside the others and add a
 * manifest entry — the corpus-wide cases below then cover it. Nothing in
 * the recogniser needs restructuring for that, which is the point of
 * keeping it fixture-driven.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDirectory = path.join(here, 'fixtures', 'variation-orders');

interface ManifestEntry {
  readonly id: string;
  readonly railway: string;
  readonly unit: string;
  readonly variation_number: string;
  readonly loa_number: string;
  readonly loa_date: string;
  readonly loa_amount_printed: string;
  readonly agreement_number: string;
  readonly omitted_items: number;
  readonly fixture_file: string;
  readonly sha256: string;
}

const manifest = JSON.parse(
  readFileSync(path.join(fixturesDirectory, 'manifest.json'), 'utf8'),
) as ManifestEntry[];

function fixtureText(entry: ManifestEntry): string {
  return readFileSync(path.join(fixturesDirectory, entry.fixture_file), 'utf8');
}

function entry(id: string): ManifestEntry {
  const found = manifest.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no corpus entry ${id}`);
  return found;
}

/** A Work whose stored facts match the order under test, so a claim that
 * fails is the recogniser's doing and not the fixture's. */
function omissionFor(
  order: ManifestEntry,
  overrides: Partial<OmissionUnderVerification> = {},
): OmissionUnderVerification {
  return {
    workLetterNumber: order.loa_number,
    workLetterDate: order.loa_date,
    itemNumber: 'G/21',
    unitCode: 'Numbers',
    awardedQuantity: '10.000',
    contractValue: null,
    ...overrides,
  };
}

function claim(
  verdict: ReturnType<typeof verifyVariationOrder>,
  code: VariationOrderClaimCode,
) {
  const found = verdict.claims.find((candidate) => candidate.code === code);
  if (found === undefined) throw new Error(`verdict is missing claim ${code}`);
  return found;
}

describe('the variation-order corpus', () => {
  it('carries the fixtures the manifest declares, unmodified', () => {
    expect(manifest.length).toBeGreaterThanOrEqual(3);
    for (const order of manifest) {
      const text = fixtureText(order);
      const digest = createHash('sha256').update(text, 'utf8').digest('hex');
      expect(digest, `${order.id} has been modified`).toBe(order.sha256);
    }
  });

  it('reads the Agreement Details block of every order', () => {
    for (const order of manifest) {
      const verdict = verifyVariationOrder(fixtureText(order), omissionFor(order));
      expect(verdict.document.loaNumber, order.id).toBe(order.loa_number);
      expect(verdict.document.loaDate, order.id).toBe(order.loa_date);
      expect(verdict.document.loaAmountText, order.id).toBe(order.loa_amount_printed);
      expect(verdict.document.agreementNumber, order.id).toBe(order.agreement_number);
      expect(verdict.document.variationNumber, order.id).toBe(order.variation_number);
      expect(verdict.document.railwayName, order.id).toBe(order.railway);
      expect(verdict.document.unitName, order.id).toBe(order.unit);
    }
  });

  it('recognises every order as a Variation Statement, on three railways', () => {
    for (const order of manifest) {
      const verdict = verifyVariationOrder(fixtureText(order), omissionFor(order));
      expect(claim(verdict, 'variation_statement').verified, order.id).toBe(true);
      expect(claim(verdict, 'text_layer').verified, order.id).toBe(true);
    }
    expect(new Set(manifest.map((order) => order.railway)).size).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('counts the omitted items the manifest declares', () => {
    for (const order of manifest) {
      const section = fixtureText(order).split('Variation Details:').at(-1) ?? '';
      const omitted = readVariationRows(section).filter(
        (row) => parsePrintedAmount(row.proposedQuantity) === 0,
      );
      expect(omitted.length, order.id).toBe(order.omitted_items);
    }
  });
});

describe('reading the Variation Details table', () => {
  const order = entry('VO-CR-BSL-V3');

  it('reads a whole row into its printed columns', () => {
    const section = fixtureText(order).split('Variation Details:').at(-1) ?? '';
    const rows = readVariationRows(section);
    const { row } = findRowForItem(rows, 'G/21');
    expect(row).toEqual({
      scheduleType: 'NS',
      schedule: 'G',
      itemNumber: '21',
      itemType: 'Individual',
      unit: 'Numbers',
      originalQuantity: '10.0',
      baseRate: '6598.56',
      lastVariationQuantity: '10.0',
      agreementRate: '6598.0',
      originalAmount: '65980.0',
      proposedQuantity: '0.0',
      proposedAmount: '0.0',
      proposedAmountWithSpecialConditions: '0.0',
      percentageVariation: '-100.0',
    });
  });

  it('keeps schedules apart: G/21 and D/21 are different items', () => {
    const section = fixtureText(order).split('Variation Details:').at(-1) ?? '';
    const rows = readVariationRows(section);
    expect(findRowForItem(rows, 'G/21').row?.schedule).toBe('G');
    expect(findRowForItem(rows, 'D/21').row?.schedule).toBe('D');
  });

  it('refuses an ambiguous bare item number rather than guessing', () => {
    const section = fixtureText(order).split('Variation Details:').at(-1) ?? '';
    const rows = readVariationRows(section);
    // '21' with no schedule appears in several schedules of this order.
    const result = findRowForItem(rows, '21');
    expect(result.ambiguous).toBe(true);
    expect(result.row).toBeNull();
  });

  it('skips Description and Remarks prose, and rows whose cells wrapped', () => {
    const section =
      fixtureText(entry('VO-NFR-LMG-V1')).split('Variation Details:').at(-1) ?? '';
    const rows = readVariationRows(section);
    expect(rows.every((row) => row.itemType === 'Individual')).toBe(true);
    // Item 38's amount column wraps across three printed lines, so the row
    // is not readable and is deliberately absent rather than mis-read.
    expect(findRowForItem(rows, 'A/38').row).toBeNull();
    // Its readable neighbours are present.
    expect(findRowForItem(rows, 'A/37').row?.proposedQuantity).toBe('4.0');
  });

  it('reads amounts in every printed form, including scientific notation', () => {
    expect(parsePrintedAmount('5.311708E+7')).toBe(53_117_080);
    expect(parsePrintedAmount('41,301,860')).toBe(41_301_860);
    expect(parsePrintedAmount('0.0')).toBe(0);
    expect(parsePrintedAmount('-100.0')).toBe(-100);
    expect(parsePrintedAmount('Numbers')).toBeNull();
    expect(parsePrintedAmount(null)).toBeNull();
  });
});

describe('verifying an omission against a real order', () => {
  const order = entry('VO-CR-BSL-V3');

  it('verifies an item the order genuinely omits', () => {
    const verdict = verifyVariationOrder(fixtureText(order), omissionFor(order));
    expect(verdict.failedClaims).toEqual([]);
    expect(verdict.verified).toBe(true);
    expect(claim(verdict, 'item_omitted').found).toBe('0.0');
    expect(claim(verdict, 'variation_number').found).toBe('3');
    expect(claim(verdict, 'item_listed').found).toBe('G/21');
  });

  it('reaches the same verdict whether the extractor emitted CRLF or LF', () => {
    const text = fixtureText(order);
    const crlf = text.replaceAll('\n', '\r\n');
    expect(verifyVariationOrder(crlf, omissionFor(order)).verified).toBe(true);
    expect(verifyVariationOrder(text, omissionFor(order)).verified).toBe(true);
  });

  it('refuses an item the order keeps: the proposed quantity is not zero', () => {
    // Schedule G item 1 survives this variation with a positive quantity.
    const verdict = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, {
        itemNumber: 'G/1',
        unitCode: 'Numbers',
        awardedQuantity: '2.0',
      }),
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.failedClaims).toContain('item_omitted');
    expect(claim(verdict, 'item_listed').verified).toBe(true);
    expect(describeFailedClaims(verdict)).toContain('not zero');
  });

  it('refuses an item the order never names', () => {
    const verdict = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { itemNumber: 'Z/999' }),
    );
    expect(verdict.failedClaims).toContain('item_listed');
    expect(verdict.failedClaims).toContain('item_omitted');
    expect(claim(verdict, 'item_omitted').detail).toContain('was not found');
  });

  it('refuses an order raised against a different contract', () => {
    const verdict = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { workLetterNumber: '00341490077841' }),
    );
    expect(verdict.failedClaims).toContain('loa_number');
    expect(claim(verdict, 'loa_number').found).toBe('00341490031451');
  });

  it('refuses an order whose LOA date disagrees with the Work', () => {
    const verdict = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { workLetterDate: '2021-01-30' }),
    );
    expect(verdict.failedClaims).toContain('loa_date');
  });

  it('refuses an order that describes a different unit or quantity', () => {
    const wrongUnit = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { unitCode: 'Metre' }),
    );
    expect(wrongUnit.failedClaims).toContain('item_unit');
    const wrongQuantity = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { awardedQuantity: '11.000' }),
    );
    expect(wrongQuantity.failedClaims).toContain('item_original_quantity');
  });

  it('accepts a quantity written with a different number of decimals', () => {
    for (const quantity of ['10', '10.0', '10.000']) {
      const verdict = verifyVariationOrder(
        fixtureText(order),
        omissionFor(order, { awardedQuantity: quantity }),
      );
      expect(claim(verdict, 'item_original_quantity').verified, quantity).toBe(true);
    }
  });

  it('treats the LOA amount as advisory, never as a gate', () => {
    const agreeing = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { contractValue: '41301860.00' }),
    );
    expect(claim(agreeing, 'loa_amount').verified).toBe(true);
    expect(claim(agreeing, 'loa_amount').required).toBe(false);

    const disagreeing = verifyVariationOrder(
      fixtureText(order),
      omissionFor(order, { contractValue: '39853884.12' }),
    );
    expect(claim(disagreeing, 'loa_amount').verified).toBe(false);
    // Advisory: the approval is still verified, and the approver sees it.
    expect(disagreeing.verified).toBe(true);
    expect(disagreeing.failedClaims).not.toContain('loa_amount');
  });

  it('absorbs the precision IREPS scientific notation throws away', () => {
    const scientific = entry('VO-NFR-LMG-V1');
    const verdict = verifyVariationOrder(
      fixtureText(scientific),
      omissionFor(scientific, { contractValue: '53117080.42' }),
    );
    expect(claim(verdict, 'loa_amount').verified).toBe(true);
  });
});

describe('failing closed', () => {
  it('refuses a PDF with no text layer, and says why', () => {
    // Two of the five real samples are photographs of paper — a phone scan
    // and a print-to-PDF of an image — and Poppler yields nothing at all
    // for them. This is that case.
    const verdict = verifyVariationOrder('', omissionFor(entry('VO-CR-BSL-V3')));
    expect(verdict.verified).toBe(false);
    expect(verdict.failedClaims[0]).toBe('text_layer');
    expect(claim(verdict, 'text_layer').detail).toContain('no usable text layer');
    // Every claim is still accounted for; none is silently dropped.
    expect(verdict.claims.map((entry_) => entry_.code).sort()).toEqual(
      [...VARIATION_ORDER_CLAIM_CODES].sort(),
    );
  });

  it('refuses a readable PDF that is not a variation order', () => {
    const notAnOrder = `Letter of Acceptance\n${'Tender documents and general conditions of contract. '.repeat(40)}`;
    const verdict = verifyVariationOrder(
      notAnOrder,
      omissionFor(entry('VO-CR-BSL-V3')),
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.failedClaims).toContain('variation_statement');
    expect(claim(verdict, 'text_layer').verified).toBe(true);
  });

  it('never reports a required claim as verified without evidence', () => {
    const verdict = verifyVariationOrder('', omissionFor(entry('VO-CR-BSL-V3')));
    for (const entry_ of verdict.claims) {
      if (entry_.required) expect(entry_.verified, entry_.code).toBe(false);
    }
  });
});
