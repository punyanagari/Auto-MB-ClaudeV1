import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  NUMBERED_DOCUMENT_TYPES,
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
  it('accepts the owner’s series and the product default', () => {
    expect(() => {
      assertValidTemplate('P{DIV}{FY2}{SEQ:3}', 'tax_invoice');
    }).not.toThrow();
    expect(() => {
      assertValidTemplate(DEFAULT_TEMPLATES.tax_invoice, 'tax_invoice');
    }).not.toThrow();
  });

  it('accepts every product default for its own document type', () => {
    // The defaults are the compatibility contract: an organisation that
    // configures nothing keeps its numbers, so the validator must never
    // refuse what the product itself would apply.
    for (const documentType of NUMBERED_DOCUMENT_TYPES) {
      expect(() => {
        assertValidTemplate(DEFAULT_TEMPLATES[documentType], documentType);
      }).not.toThrow();
    }
  });

  it('refuses a template that never consumes the counter', () => {
    // Without {SEQ} every document would take the same string and the
    // second one would collide on an index the operator cannot act on.
    expect(() => {
      assertValidTemplate('P{DIV}{FY2}', 'tax_invoice');
    }).toThrow(/must use \{SEQ\}/);
  });

  it('names a misspelled token instead of minting it', () => {
    expect(() => {
      assertValidTemplate('P{DIVISON}{SEQ:3}', 'tax_invoice');
    }).toThrow(/\{DIVISON\} is not a number template token/);
  });

  it('refuses a token the document cannot supply', () => {
    // A budgetary quotation belongs to no Work, so {WORK} would be
    // unfillable every time — better refused on the settings screen.
    expect(() => {
      assertValidTemplate('{WORK}-BQ-{SEQ:2}', 'budgetary_quotation');
    }).toThrow(/not available on this document/);
  });

  it('refuses malformed braces and absurd widths', () => {
    expect(() => {
      assertValidTemplate('P{DIV{SEQ:3}', 'tax_invoice');
    }).toThrow(/unclosed or malformed/);
    expect(() => {
      assertValidTemplate('P{SEQ:99}', 'tax_invoice');
    }).toThrow(/between 1 and 12/);
  });

  it('refuses a blank template', () => {
    expect(() => {
      assertValidTemplate('   ', 'tax_invoice');
    }).toThrow(/cannot be blank/);
  });
});

describe('counter scope (finding 8) — a template must be as wide as the uniqueness key', () => {
  /* Challan counters run per Work and the invoice counter per financial
   * year, while every number is unique across the organisation. A
   * scope-free template mints the same number again from the second
   * Work or second financial year onward, and because the counter rolls
   * back with the failed issue, every retry requests the same number —
   * the series wedges at issue time. These templates must die on the
   * settings screen. */

  it('refuses a challan template with no per-Work mark', () => {
    expect(() => {
      assertValidTemplate('{SEQ}', 'delivery_challan');
    }).toThrow(/\{WORK\} or \{PREFIX\}/);
    expect(() => {
      assertValidTemplate('DC/{YYYY}/{SEQ:3}', 'issue_challan');
    }).toThrow(/\{WORK\} or \{PREFIX\}/);
  });

  it('accepts a challan template scoped by {WORK} or {PREFIX}', () => {
    expect(() => {
      assertValidTemplate('{WORK}/DC/{SEQ}', 'delivery_challan');
    }).not.toThrow();
    expect(() => {
      assertValidTemplate('{PREFIX}/{YYYY}/{SEQ:2}', 'issue_challan');
    }).not.toThrow();
  });

  it('refuses an invoice template with no financial year', () => {
    expect(() => {
      assertValidTemplate('TI/{SEQ}', 'tax_invoice');
    }).toThrow(/\{FY\} or \{FY2\}/);
  });

  it('refuses the calendar year as an invoice scope', () => {
    // FY 2026-27 dated January 2027 and FY 2027-28 dated May 2027 both
    // render {YYYY} as 2027 — with a restarted counter, they collide.
    expect(() => {
      assertValidTemplate('TI/{YYYY}/{SEQ:3}', 'tax_invoice');
    }).toThrow(/\{FY\} or \{FY2\}/);
  });

  it('refuses a standalone challan template with no financial year or prefix', () => {
    // Migration 0056 gave the standalone challan a counter that restarts
    // each financial year, while challan_number stays unique across the
    // organisation. 0047's CHECK ends in ELSE true, so a new document
    // type that is not given an explicit arm is exempted from the scope
    // rule entirely — finding 8 straight back through the door it was
    // closed at. Both the validator and the CHECK carry the arm.
    expect(() => {
      assertValidTemplate('DC/{SEQ:3}', 'standalone_challan');
    }).toThrow(/\{FY\} or \{FY2\} or \{PREFIX\}/);
    expect(() => {
      assertValidTemplate('DC/{YYYY}/{SEQ:3}', 'standalone_challan');
    }).toThrow(/\{FY\} or \{FY2\} or \{PREFIX\}/);
  });

  it('accepts a standalone challan template scoped by {FY} or {PREFIX}', () => {
    expect(() => {
      assertValidTemplate(DEFAULT_TEMPLATES.standalone_challan, 'standalone_challan');
    }).not.toThrow();
    expect(() => {
      assertValidTemplate('{PREFIX}/{SEQ:3}', 'standalone_challan');
    }).not.toThrow();
  });

  it('offers no {WORK} on a standalone challan', () => {
    // It belongs to no Work, so the token could never be filled; refusing
    // it here beats an issue-time refusal on a finished document.
    expect(() => {
      assertValidTemplate('{WORK}/DC/{FY}/{SEQ}', 'standalone_challan');
    }).toThrow(/not available on this document/);
  });

  it('renders the standalone default against a financial year', () => {
    expect(
      renderNumberTemplate(DEFAULT_TEMPLATES.standalone_challan, {
        prefix: 'DC',
        financialYear: '2026-27',
        sequence: 4,
      }),
    ).toBe('DC/2026-27/004');
  });

  it('needs no scope mark on a budgetary quotation', () => {
    // The BQ counter runs per organisation — exactly as wide as the
    // uniqueness key — so a bare serial is already collision-free.
    expect(() => {
      assertValidTemplate('BQ-{SEQ:2}', 'budgetary_quotation');
    }).not.toThrow();
  });
});
