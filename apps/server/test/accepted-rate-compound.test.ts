import { describe, expect, it } from 'vitest';
import { acceptedRateFrom, acceptedRateFromBid } from '../src/accepted-rate.js';

/**
 * The compound accepted-rate shape (owner ruling Q5, 2026-08-19):
 * accepted = the negotiated per-item bid rate x (1 - the rebate on the
 * total value).
 *
 * PROVED BY RECONCILIATION, not by restating the formula. PL-257 (South
 * Western, Bangalore division, `packages/loa-parser/fixtures/PL257-SBC.txt`)
 * is the corpus's only letter that prints both a per-item negotiated bid
 * rate and a non-zero rebate, and it prints its own totals underneath
 * them — a schedule total at the bid rates and a Net Bid Value after the
 * rebate. Reconstructing both from the thirteen rows is what says the
 * rebate multiplies the BID rate rather than the advertised one; the
 * ruling and this arithmetic have to agree or one of them is wrong.
 *
 * THE THIRTEEN ROWS ARE HAND-READ FROM THE LETTER, deliberately, and on
 * the precedent `tax-invoice-money-basis.test.ts` sets when it reads
 * eight rate pairs off PL-270's BILL-1. PL-257's item table does NOT
 * decompose: the negotiated Bid Rate column is the second money column
 * it prints, the anchor tail cannot be split with it there, and the
 * parser answers by keeping every raw line and raising `layout_junk` on
 * all thirteen rows rather than reading one rate as the other
 * (`packages/loa-parser/test/amc-corpus.test.ts` pins exactly that). So
 * the extraction cannot supply these numbers yet, and a test that waited
 * for it would leave the money rule unproved. What makes the hand-read
 * figures trustworthy is that they are OVER-DETERMINED: thirteen
 * quantities and rates have to reproduce two totals the letter printed
 * independently of them, and a mis-transcribed digit fails.
 */

/** PL-257 Schedule A: [item, quantity, advertised rate, negotiated bid rate]. */
const SBC_ROWS: readonly (readonly [string, bigint, string, string])[] = [
  ['1', 8n, '2271.50', '2000.00'],
  ['2', 32n, '2271.50', '1750.00'],
  ['3', 8n, '4301.10', '4301.10'],
  ['4', 8n, '1606.28', '1350.00'],
  ['5', 768n, '880.87', '880.87'],
  ['6', 32n, '10776.65', '10000.00'],
  ['7', 16n, '4820.60', '4820.60'],
  ['8', 8n, '12584.41', '12584.41'],
  ['9', 40n, '3638.83', '3638.83'],
  ['10', 8n, '2102.76', '1500.00'],
  ['11', 72n, '1606.27', '1500.00'],
  ['12', 48n, '1606.28', '1500.00'],
  ['13', 40n, '644.28', '600.00'],
];

/** The letter's own printed figures. */
const REBATE_PERCENT = '1.00';
const ADVERTISED_VALUE = '1718184.24';
const SCHEDULE_TOTAL_AT_BID_RATES = '1653075.04';
const NET_BID_VALUE = '1636544.29';

/** Sums quantity x rate over the rows in exact micro-rupee BigInt, then
 * renders rupees with two decimals — no float touches a total. */
function totalAt(rateOf: (row: (typeof SBC_ROWS)[number]) => string): string {
  let micro = 0n;
  for (const row of SBC_ROWS) {
    const [, quantity] = row;
    const rate = rateOf(row);
    const [whole = '0', fraction = ''] = rate.split('.');
    micro += quantity * BigInt(whole + fraction.padEnd(6, '0'));
  }
  // Round half up to paise from micro-rupees.
  const paise = (micro * 2n + 10_000n) / 20_000n;
  return `${(paise / 100n).toString()}.${(paise % 100n).toString().padStart(2, '0')}`;
}

describe('the compound accepted rate (owner ruling Q5, PL-257/SBC)', () => {
  it('reproduces the schedule total from the printed advertised rates', () => {
    // The control: the advertised column is what the letter advertised,
    // and it is NOT the schedule total. If this stopped matching, the
    // transcription below would be the suspect, not the rule.
    expect(totalAt((row) => row[2])).toBe(ADVERTISED_VALUE);
  });

  it("reproduces the schedule's printed total from the negotiated bid rates", () => {
    expect(totalAt((row) => row[3])).toBe(SCHEDULE_TOTAL_AT_BID_RATES);
  });

  it("reproduces the letter's Net Bid Value from the per-item ACCEPTED rates", () => {
    // Every item priced at bid x (1 - 1%), summed. Within a paisa of the
    // printed figure, which is the letter's own rounding of
    // 1653075.04 x 0.99 = 1636544.2896.
    const total = totalAt((row) => acceptedRateFromBid(row[3], REBATE_PERCENT));
    const asPaise = (value: string): bigint => {
      const [whole = '0', fraction = ''] = value.split('.');
      return BigInt(whole + fraction.padEnd(2, '0'));
    };
    const difference = asPaise(total) - asPaise(NET_BID_VALUE);
    expect(difference >= -1n && difference <= 1n, `${total} vs ${NET_BID_VALUE}`).toBe(
      true,
    );
  });

  it('does NOT reproduce it from the advertised rates — which is what makes the base the bid rate', () => {
    // The negative half of the proof. If the rebate multiplied the
    // advertised rate, this would be the Net Bid Value; it is more than
    // ₹64,000 out.
    expect(totalAt((row) => acceptedRateFromBid(row[2], REBATE_PERCENT))).not.toBe(
      NET_BID_VALUE,
    );
  });

  it('is the letter-percentage arithmetic applied to the bid rate, exactly', () => {
    for (const [, , , bidRate] of SBC_ROWS) {
      expect(acceptedRateFromBid(bidRate, REBATE_PERCENT)).toBe(
        acceptedRateFrom(bidRate, { percentage: REBATE_PERCENT, direction: 'below' }),
      );
    }
  });

  it('leaves a bid rate unchanged when the letter states no rebate', () => {
    expect(acceptedRateFromBid('1750.00', '0')).toBe('1750.000000');
    expect(acceptedRateFromBid('880.87', '0')).toBe('880.870000');
  });

  it('carries the rate column’s six decimals rather than rounding to rupees', () => {
    // 880.87 x 0.99 = 872.0613 exactly, and that is the rate 768 units
    // are priced at. Rounding it to two decimals would move the line by
    // more than two rupees.
    expect(acceptedRateFromBid('880.87', REBATE_PERCENT)).toBe('872.061300');
  });

  it('refuses a malformed bid rate rather than guessing at it', () => {
    expect(() => acceptedRateFromBid('1,750.00', REBATE_PERCENT)).toThrow();
    expect(() => acceptedRateFromBid('', REBATE_PERCENT)).toThrow();
  });
});
