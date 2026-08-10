import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CompleteWorkRequestSchema,
  ConfirmWorkRequestSchema,
  DateOnlySchema,
  ProposeAmendmentRequestSchema,
  RecordMbEntryRequestSchema,
  RejectAmendmentRequestSchema,
  SaveExtensionRequestSchema,
  SaveIssueChallanRequestSchema,
  type ConfirmWorkRequest,
} from '../src/index.js';

/* Every bound proved here is one the DATABASE already holds. What the
 * database cannot do is answer a bad value usefully: a CHECK violation or
 * a numeric overflow carries no HTTP status, so the route handed the
 * operator a 500 'The request could not be completed.' with no field
 * named. Refused at the schema, the same value is a 400 and the validator
 * names the field — and, inside an array, its index. The tests that
 * matter most are the ones proving the legitimate values still pass. */

const UUID = '11111111-2222-4333-8444-555555555555';

function confirmRequest(overrides: Partial<ConfirmWorkRequest> = {}): unknown {
  return {
    workCode: 'W-1',
    letterNumber: 'LOA/2026/1',
    letterDate: '2026-01-15',
    title: 'Supply and installation of signalling gear',
    advertisedValue: '100000.00',
    contractValue: '95000.00',
    pricingShape: 'per_schedule',
    schedules: [
      {
        scheduleCode: 'A',
        title: 'Schedule A',
        items: [
          {
            itemNumber: 'A/1',
            description: 'Signalling cable',
            unitCode: 'MTR',
            awardedQuantity: '10.000',
            effectiveRate: '0.8517',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function confirmWithItem(item: Record<string, unknown>): unknown {
  return confirmRequest({
    schedules: [
      {
        scheduleCode: 'A',
        title: 'Schedule A',
        items: [
          {
            itemNumber: 'A/1',
            description: 'Signalling cable',
            unitCode: 'MTR',
            awardedQuantity: '10.000',
            effectiveRate: '100.00',
            ...item,
          },
        ],
      },
    ],
  });
}

describe('LOA confirmation quantities, rates, and values', () => {
  it('accepts a well-formed letter', () => {
    expect(Value.Check(ConfirmWorkRequestSchema, confirmRequest())).toBe(true);
  });

  it('refuses a zero or negative awarded quantity', () => {
    for (const quantity of ['0', '0.000', '0.0', '-5', '-0.001']) {
      expect(
        Value.Check(
          ConfirmWorkRequestSchema,
          confirmWithItem({ awardedQuantity: quantity }),
        ),
        quantity,
      ).toBe(false);
    }
  });

  it('accepts the smallest positive awarded quantity the column can hold', () => {
    for (const quantity of ['0.001', '1', '10.500']) {
      expect(
        Value.Check(
          ConfirmWorkRequestSchema,
          confirmWithItem({ awardedQuantity: quantity }),
        ),
        quantity,
      ).toBe(true);
    }
  });

  // The rate floor is ZERO, not one paisa: PRODUCT.md invariant 6 makes
  // rates non-negative, and free-issue / nil-rate supply lines are real
  // letters. Refusing rate 0 would block a legitimate letter outright.
  it('accepts a nil rate on a free-issue supply line', () => {
    for (const rate of ['0', '0.000000', '0.8517']) {
      expect(
        Value.Check(ConfirmWorkRequestSchema, confirmWithItem({ effectiveRate: rate })),
        rate,
      ).toBe(true);
    }
  });

  it('refuses a negative rate', () => {
    for (const rate of ['-0.000001', '-100.00']) {
      expect(
        Value.Check(ConfirmWorkRequestSchema, confirmWithItem({ effectiveRate: rate })),
        rate,
      ).toBe(false);
    }
  });

  it('refuses a negative advertised or contract value but accepts zero', () => {
    expect(
      Value.Check(
        ConfirmWorkRequestSchema,
        confirmRequest({ advertisedValue: '-1.00' }),
      ),
    ).toBe(false);
    expect(
      Value.Check(
        ConfirmWorkRequestSchema,
        confirmRequest({ contractValue: '-0.001' }),
      ),
    ).toBe(false);
    expect(
      Value.Check(ConfirmWorkRequestSchema, confirmRequest({ contractValue: '0' })),
    ).toBe(true);
  });
});

describe('letter percentage', () => {
  const withPercentage = (letterPercentage: string): unknown =>
    confirmRequest({
      pricingShape: 'letter_percentage',
      letterPercentage,
      letterPercentageDirection: 'below',
    });

  it('accepts every percentage a real letter can print', () => {
    // The corpus prints 0.500, 24.500, 29.000; at par is sent as '0'.
    for (const percentage of ['0', '0.500', '24.500', '29.000', '99.999', '100']) {
      expect(
        Value.Check(ConfirmWorkRequestSchema, withPercentage(percentage)),
        percentage,
      ).toBe(true);
    }
  });

  it('refuses a negative percentage and one above a hundred', () => {
    for (const percentage of ['-5', '-0.001', '100.001', '101', '999', '1000.000']) {
      expect(
        Value.Check(ConfirmWorkRequestSchema, withPercentage(percentage)),
        percentage,
      ).toBe(false);
    }
  });

  // The parser models an at-par letter as declaring NO percentage; the
  // route, not the schema, decides percentage/direction coherence. An
  // at-par direction with a non-zero percentage stays storable on purpose.
  it('leaves the at-par/percentage pairing to the route', () => {
    expect(
      Value.Check(
        ConfirmWorkRequestSchema,
        confirmRequest({
          pricingShape: 'letter_percentage',
          letterPercentage: '10.000',
          letterPercentageDirection: 'at_par',
        }),
      ),
    ).toBe(true);
  });
});

describe('issue challan line quantities', () => {
  const withQuantity = (quantity: string): unknown => ({
    challanDate: '2026-01-15',
    movementType: 'issue',
    issuedToName: 'Site store',
    lines: [{ workItemId: UUID, quantity }],
  });

  it('accepts the largest quantity the numeric(18,3) column can hold', () => {
    for (const quantity of ['1.000', '999999999999999', '999999999999999.999']) {
      expect(
        Value.Check(SaveIssueChallanRequestSchema, withQuantity(quantity)),
        quantity,
      ).toBe(true);
    }
  });

  it('refuses a quantity too wide for the column', () => {
    for (const quantity of ['1000000000000000', '12345678901234567.000']) {
      expect(
        Value.Check(SaveIssueChallanRequestSchema, withQuantity(quantity)),
        quantity,
      ).toBe(false);
    }
  });

  // The FLOOR stays with the route, which answers zero and negative with
  // QUANTITY_INVALID and its own message; the schema must not intercept
  // those and replace a usable message with a pattern complaint.
  it('leaves a zero or negative quantity to the route guard', () => {
    for (const quantity of ['0', '-1.000']) {
      expect(
        Value.Check(SaveIssueChallanRequestSchema, withQuantity(quantity)),
        quantity,
      ).toBe(true);
    }
  });
});

describe('measurement book entries', () => {
  const entry = (measuredQuantity: string): unknown => ({
    workItemId: UUID,
    measuredQuantity,
    measuredOn: '2026-01-15',
  });

  it('accepts a real site measurement', () => {
    for (const quantity of ['0.001', '12.500', '900']) {
      expect(Value.Check(RecordMbEntryRequestSchema, entry(quantity)), quantity).toBe(
        true,
      );
    }
  });

  it('refuses a zero or negative measured quantity', () => {
    for (const quantity of ['0', '0.000', '-1', '-0.001']) {
      expect(Value.Check(RecordMbEntryRequestSchema, entry(quantity)), quantity).toBe(
        false,
      );
    }
  });
});

describe('notes, reasons, and addressees', () => {
  // The database measures these TRIMMED — length(btrim(x)) BETWEEN 3 AND
  // n — so the schema does too. Everything Postgres accepts today still
  // passes; only the whitespace-only values change, from 500 to 400.
  it('refuses a note that is only whitespace', () => {
    for (const note of ['   ', '  ', ' a ', 'ab ', '    ']) {
      expect(
        Value.Check(CompleteWorkRequestSchema, { note }),
        JSON.stringify(note),
      ).toBe(false);
    }
  });

  it('accepts every note the database accepts', () => {
    for (const note of ['Done', 'a b', '  Handed over  ', 'All items installed.']) {
      expect(
        Value.Check(CompleteWorkRequestSchema, { note }),
        JSON.stringify(note),
      ).toBe(true);
    }
  });

  it('holds the same floor on amendment reasons and rejection notes', () => {
    expect(
      Value.Check(ProposeAmendmentRequestSchema, {
        workItemId: UUID,
        reason: '   ',
        changes: { quantity: '5.000' },
      }),
    ).toBe(false);
    expect(
      Value.Check(ProposeAmendmentRequestSchema, {
        workItemId: UUID,
        reason: 'Quantity revised on site',
        changes: { quantity: '5.000' },
      }),
    ).toBe(true);
    expect(Value.Check(RejectAmendmentRequestSchema, { note: '  ' })).toBe(false);
    expect(Value.Check(RejectAmendmentRequestSchema, { note: 'Not sanctioned' })).toBe(
      true,
    );
  });

  // quantity '0' MEANS "omit this item" on the amendment path
  // (work-completion.ts documents it); the LOA confirm floor must not
  // leak across into it.
  it('still accepts the amendment omission quantity of zero', () => {
    expect(
      Value.Check(ProposeAmendmentRequestSchema, {
        workItemId: UUID,
        reason: 'Item not required',
        changes: { quantity: '0' },
      }),
    ).toBe(true);
  });

  it('holds the trimmed floor on the extension reason and addressee', () => {
    const request = (overrides: Record<string, unknown>): unknown => ({
      proposedCompletionDate: '2026-12-31',
      reason: 'Site handover delayed',
      addressee: 'Sr. DSTE',
      ...overrides,
    });
    expect(Value.Check(SaveExtensionRequestSchema, request({}))).toBe(true);
    expect(Value.Check(SaveExtensionRequestSchema, request({ reason: '   ' }))).toBe(
      false,
    );
    expect(Value.Check(SaveExtensionRequestSchema, request({ addressee: '  ' }))).toBe(
      false,
    );
    // The addressee floor is two characters, not three.
    expect(Value.Check(SaveExtensionRequestSchema, request({ addressee: 'AB' }))).toBe(
      true,
    );
  });
});

describe('calendar dates', () => {
  it('accepts real dates, including leap days', () => {
    for (const date of [
      '2026-01-15',
      '2026-12-31',
      '2024-02-29',
      '2000-02-29',
      '2026-04-30',
      '2026-08-31',
    ]) {
      expect(Value.Check(DateOnlySchema, date), date).toBe(true);
    }
  });

  it('refuses dates that are merely YYYY-MM-DD shaped', () => {
    for (const date of [
      '2026-02-31',
      '2026-00-10',
      '2026-13-01',
      '2026-04-31',
      '2026-01-32',
      '2026-01-00',
      '2023-02-29',
      '1900-02-29',
      '0000-01-01',
    ]) {
      expect(Value.Check(DateOnlySchema, date), date).toBe(false);
    }
  });

  // '2026-02-31' compares LATER than '2026-02-28' as a string, so the
  // routes' date comparisons waved it past every gate before Postgres
  // rejected the cast. It must not reach them at all.
  it('refuses an impossible date on the routes that compare dates as strings', () => {
    expect(
      Value.Check(SaveExtensionRequestSchema, {
        proposedCompletionDate: '2026-02-31',
        reason: 'Site handover delayed',
        addressee: 'Sr. DSTE',
      }),
    ).toBe(false);
    expect(
      Value.Check(
        ConfirmWorkRequestSchema,
        confirmRequest({ letterDate: '2026-02-30' }),
      ),
    ).toBe(false);
  });
});
