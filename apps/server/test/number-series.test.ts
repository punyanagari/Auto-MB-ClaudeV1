import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOKENS,
  DEFAULT_TEMPLATES,
  NumberTemplateError,
  assertValidTemplate,
  divisionToken,
  renderNumberTemplate,
} from '../src/number-series.js';

/* The numbers these templates mint are legal identifiers on documents
 * that leave the building, so the tests that matter most are the ones
 * proving (a) an organisation that configures nothing keeps the numbers
 * it already had, and (b) a template that cannot be filled in is refused
 * when it is SAVED, not when a finished document has nowhere to put its
 * number. */

describe('divisionToken', () => {
  it('drops one trailing zero, as the owner’s series does', () => {
    // The railnet directory writes 100 and 140; PXXYY000 wants 10 and 14.
    expect(divisionToken('100')).toBe('10');
    expect(divisionToken('140')).toBe('14');
  });

  it('drops exactly one zero, never two', () => {
    expect(divisionToken('1000')).toBe('100');
  });

  it('leaves a code with no trailing zero alone', () => {
    // The rule is "drop the trailing zero" — a code without one has
    // nothing to drop, and eating its last digit would invent a
    // different division.
    expect(divisionToken('14')).toBe('14');
    expect(divisionToken('107')).toBe('107');
  });
});

describe('the defaults reproduce the formats that predate the series table', () => {
  it('numbers a delivery challan the way the route used to', () => {
    expect(
      renderNumberTemplate(DEFAULT_TEMPLATES.delivery_challan, {
        prefix: 'DCW-1',
        sequence: 7,
      }),
    ).toBe('DCW-1/7');
  });

  it('numbers a budgetary quotation the way the route used to', () => {
    expect(
      renderNumberTemplate(DEFAULT_TEMPLATES.budgetary_quotation, { sequence: 3 }),
    ).toBe('BQ-03');
  });

  it('numbers a tax invoice the way the route used to', () => {
    expect(
      renderNumberTemplate(DEFAULT_TEMPLATES.tax_invoice, {
        financialYear: '2026-27',
        sequence: 1,
      }),
    ).toBe('TI/2026-27/001');
  });
});

describe("the owner's own series", () => {
  it('composes PXXYY000 from the division code, the year and the serial', () => {
    // The two live invoices: P1026044 (Mumbai CST, division 100) and
    // P1426048 (Solapur, division 140), same financial year, one serial
    // series shared across both prefixes.
    const template = 'P{DIV}{FY2}{SEQ:3}';
    expect(
      renderNumberTemplate(template, {
        divisionCode: '100',
        financialYear: '2026-27',
        sequence: 44,
      }),
    ).toBe('P1026044');
    expect(
      renderNumberTemplate(template, {
        divisionCode: '140',
        financialYear: '2026-27',
        sequence: 48,
      }),
    ).toBe('P1426048');
  });

  it('refuses to mint a number with a hole in it', () => {
    // A buyer with no division code cannot fill {DIV}. Half a number on
    // a legal document is worse than none, so this is a refusal the
    // route turns into a named 400.
    expect(() =>
      renderNumberTemplate('P{DIV}{FY2}{SEQ:3}', {
        financialYear: '2026-27',
        sequence: 1,
      }),
    ).toThrow(NumberTemplateError);
  });
});

describe('assertValidTemplate', () => {
  const invoice = ALLOWED_TOKENS.tax_invoice;

  it('accepts the owner’s series and the product default', () => {
    expect(() => {
      assertValidTemplate('P{DIV}{FY2}{SEQ:3}', invoice);
    }).not.toThrow();
    expect(() => {
      assertValidTemplate(DEFAULT_TEMPLATES.tax_invoice, invoice);
    }).not.toThrow();
  });

  it('refuses a template that never consumes the counter', () => {
    // Without {SEQ} every document would take the same string and the
    // second one would collide on an index the operator cannot act on.
    expect(() => {
      assertValidTemplate('P{DIV}{FY2}', invoice);
    }).toThrow(/must use \{SEQ\}/);
  });

  it('names a misspelled token instead of minting it', () => {
    expect(() => {
      assertValidTemplate('P{DIVISON}{SEQ:3}', invoice);
    }).toThrow(/\{DIVISON\} is not a number template token/);
  });

  it('refuses a token the document cannot supply', () => {
    // A budgetary quotation belongs to no Work, so {WORK} would be
    // unfillable every time — better refused on the settings screen.
    expect(() => {
      assertValidTemplate('{WORK}-BQ-{SEQ:2}', ALLOWED_TOKENS.budgetary_quotation);
    }).toThrow(/not available on this document/);
  });

  it('refuses malformed braces and absurd widths', () => {
    expect(() => {
      assertValidTemplate('P{DIV{SEQ:3}', invoice);
    }).toThrow(/unclosed or malformed/);
    expect(() => {
      assertValidTemplate('P{SEQ:99}', invoice);
    }).toThrow(/between 1 and 12/);
  });

  it('refuses a blank template', () => {
    expect(() => {
      assertValidTemplate('   ', invoice);
    }).toThrow(/cannot be blank/);
  });
});
