import { describe, expect, it } from 'vitest';
import { auditDiff } from '../src/audit-diff.js';

describe('auditDiff', () => {
  it('records only the fields that actually changed, old value and new', () => {
    const changes = auditDiff(
      { status: 'draft', notes: 'unchanged', amount: '100.00' },
      { status: 'issued', notes: 'unchanged', amount: '100.00' },
    );
    expect(changes).toEqual({
      before: { status: 'draft' },
      after: { status: 'issued' },
    });
  });

  // The reason the comparison is structural rather than reference or
  // serialised: jsonb columns hand back their keys in the database's order,
  // not the order the request built them in. A reordered round-trip is the
  // same value and must not show up in the trail as an edit.
  it('is key-order-insensitive, so a jsonb round-trip is not a change', () => {
    const changes = auditDiff(
      { consignee: { name: 'Depot', gstin: '27AAAAA0000A1Z5', state: '27' } },
      { consignee: { state: '27', name: 'Depot', gstin: '27AAAAA0000A1Z5' } },
    );
    expect(changes).toEqual({ before: {}, after: {} });
  });

  it('compares nested arrays element by element', () => {
    const before = { lines: [{ quantity: '1.000' }, { quantity: '2.000' }] };
    expect(auditDiff(before, structuredClone(before))).toEqual({
      before: {},
      after: {},
    });
    expect(
      auditDiff(before, { lines: [{ quantity: '1.000' }, { quantity: '3.000' }] }),
    ).toEqual({
      before: { lines: [{ quantity: '1.000' }, { quantity: '2.000' }] },
      after: { lines: [{ quantity: '1.000' }, { quantity: '3.000' }] },
    });
  });

  // Callers pass a `{}` before-side when the row is being created, and the
  // trail should read "was nothing, is now this" rather than omitting the
  // field or leaking `undefined` into jsonb.
  it('normalises an absent or undefined old value to null', () => {
    expect(auditDiff({}, { paymentCategory: 'supply' })).toEqual({
      before: { paymentCategory: null },
      after: { paymentCategory: 'supply' },
    });
    expect(auditDiff({ notes: undefined }, { notes: null })).toEqual({
      before: {},
      after: {},
    });
  });

  it('ignores fields the caller did not put on the after side', () => {
    expect(auditDiff({ secretlyChanged: 'a' }, { status: 'draft' })).toEqual({
      before: { status: null },
      after: { status: 'draft' },
    });
  });
});
