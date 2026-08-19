import { describe, expect, it } from 'vitest';
import type { PaymentMatrixRow } from '@auto-mb/contracts';
import {
  autoZeroStages,
  draftFrom,
  draftProblem,
  draftTouched,
  percentHundredths,
  sameRowPercentages,
  submittedDraft,
  type RowDraft,
} from '../src/lib/payment-matrix.js';

/**
 * The payment matrix as a form, shared by the Schedules screen and the
 * post-creation setup dialog.
 *
 * The rules pinned here are the ones the two screens would otherwise
 * disagree about, and the ones that used to disagree with the SERVER:
 * what counts as a typed-in row, what text is a percentage, and when a
 * loaded row has actually moved.
 */

function draft(values: Partial<RowDraft> = {}): RowDraft {
  return {
    pctSupply: '',
    pctInstallation: '',
    pctPac: '',
    pctFinalBill: '',
    ...values,
  };
}

function savedRow(values: Partial<PaymentMatrixRow> = {}): PaymentMatrixRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    category: 'SUPPLY',
    pctSupply: '80.00',
    pctInstallation: '0.00',
    pctPac: '10.00',
    pctFinalBill: '10.00',
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
    ...values,
  };
}

describe('percentHundredths', () => {
  it('reads the plain percentages a schedule is written in', () => {
    expect(percentHundredths('0')).toBe(0n);
    expect(percentHundredths('80')).toBe(8000n);
    expect(percentHundredths('80.00')).toBe(8000n);
    expect(percentHundredths('7.5')).toBe(750n);
    expect(percentHundredths('100')).toBe(10000n);
  });

  it('refuses exactly what the wire refuses', () => {
    // DecimalStringSchema (packages/contracts/src/primitives.ts) is
    // `^-?(?:0|[1-9]\d*)(?:\.\d{1,3})?$`. Accepting these three here
    // would have let the operator past an inline check into a Fastify
    // schema 400 that names a field instead of saying what to type.
    expect(percentHundredths('05')).toBeNull();
    expect(percentHundredths(' 50')).toBeNull();
    expect(percentHundredths('50 ')).toBeNull();
    expect(percentHundredths('0100')).toBeNull();
    // And the narrower-than-schema rules a percentage carries of its own.
    expect(percentHundredths('-5')).toBeNull();
    expect(percentHundredths('100.01')).toBeNull();
    expect(percentHundredths('10.005')).toBeNull();
    expect(percentHundredths('.5')).toBeNull();
    expect(percentHundredths('')).toBeNull();
  });
});

describe('draftTouched', () => {
  it('calls a blank row untouched, so an unconfigured category is silent', () => {
    expect(draftTouched(draft())).toBe(false);
  });

  it('calls a whitespace-only row touched, so it says why Save is held', () => {
    // A space is a keystroke, and the row it made is unsaveable. Trimming
    // here used to hide the inline message and leave Save disabled for no
    // visible reason.
    const spaced = draft({ pctSupply: ' ' });
    expect(draftTouched(spaced)).toBe(true);
    expect(draftProblem(submittedDraft('SUPPLY', spaced))).toContain(
      'Supply % must be a number',
    );
  });
});

describe('sameRowPercentages', () => {
  it('reads a reloaded row as unchanged however it was typed', () => {
    // numeric(5,2) hands `80` back as `80.00`; comparing text would call
    // every loaded row changed and write an audit event saying nothing.
    expect(sameRowPercentages(draftFrom(savedRow()), savedRow())).toBe(true);
    expect(
      sameRowPercentages(
        draft({
          pctSupply: '80',
          pctInstallation: '0',
          pctPac: '10',
          pctFinalBill: '10',
        }),
        savedRow(),
      ),
    ).toBe(true);
  });

  it('sees a real edit, and treats a row with nothing saved as new', () => {
    expect(
      sameRowPercentages(draftFrom(savedRow({ pctSupply: '70.00' })), savedRow()),
    ).toBe(false);
    expect(sameRowPercentages(draftFrom(savedRow()), undefined)).toBe(false);
  });
});

describe('autoZeroStages', () => {
  it('fills the untouched stages once the typed ones reach 100', () => {
    expect(autoZeroStages('SUPPLY', draft({ pctSupply: '100' }))).toEqual(
      draft({
        pctSupply: '100',
        pctInstallation: '0',
        pctPac: '0',
        pctFinalBill: '0',
      }),
    );
    expect(
      draftProblem(autoZeroStages('SUPPLY', draft({ pctSupply: '100' }))),
    ).toBeNull();
    expect(
      autoZeroStages('SUPPLY', draft({ pctSupply: '92.5', pctFinalBill: '7.5' })),
    ).toEqual(
      draft({
        pctSupply: '92.5',
        pctInstallation: '0',
        pctPac: '0',
        pctFinalBill: '7.5',
      }),
    );
  });

  it('counts an AMC row’s locked stages as the zeros they are sent as', () => {
    // submittedDraft forces supply and installation to 0 (migration
    // 0068), so a 95/5 AMC row is already balanced and nothing is filled.
    expect(autoZeroStages('AMC', draft({ pctPac: '95', pctFinalBill: '5' }))).toEqual(
      draft({ pctPac: '95', pctFinalBill: '5' }),
    );
    // Only the genuinely blank stage is filled. The two locked ones are
    // left as they are: the row renders them as 0 and submits them as 0
    // whatever the draft holds, so writing into them would be the form
    // storing a value the operator never typed and cannot edit.
    expect(autoZeroStages('AMC', draft({ pctPac: '100' }))).toEqual(
      draft({ pctPac: '100', pctFinalBill: '0' }),
    );
    expect(
      draftProblem(submittedDraft('AMC', autoZeroStages('AMC', draft({ pctPac: '100' })))),
    ).toBeNull();
  });

  it('leaves a row alone until it balances, and never fights an edit', () => {
    // Short of 100, over 100, mid-typing garbage, text the wire refuses,
    // and a row already full: in every one the draft comes back as typed.
    for (const partial of [
      draft({ pctSupply: '60' }),
      draft({ pctSupply: '60', pctInstallation: '50' }),
      draft({ pctSupply: '1.' }),
      draft({ pctSupply: ' 100' }),
      draft({
        pctSupply: '80',
        pctInstallation: '0',
        pctPac: '10',
        pctFinalBill: '10',
      }),
    ]) {
      expect(autoZeroStages('SUPPLY', partial)).toEqual(partial);
    }
  });
});
