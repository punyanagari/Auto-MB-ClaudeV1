import { describe, expect, it } from 'vitest';
import {
  loadCorpus,
  loadLetter,
  parseItems,
  formatMinorUnits,
  parseDecimalToMinorUnits,
  type ParsedItem,
} from '../src/index.js';

/**
 * tickets/DC-25.md — item-row parsing: par-token anchoring, wrapped
 * descriptions, schedule binding. Input contract:
 * research/DC-32-loa-parser-contract.md §2 (item-row geometry), §4.5
 * (item-code namespaces), §4.6 (verbatim descriptions), §6 (schedule
 * identity). verify: `pnpm --filter @auto-mb/loa-parser --fail-if-no-match test
 * item-anchor` (a filename-substring filter on `vitest run`, matching only
 * this file — every DC-25 assertion lives here so that verify line actually
 * exercises all of them).
 */

// research §0 / tickets/DC-25.md: "Counting anchors per letter yields
// 4/12/45/37/129/54 and 281 in total across the corpus. Any total other
// than 281 fails the suite."
const EXPECTED_ITEM_COUNTS: Record<string, number> = {
  'PL273-JHS': 4,
  'PL280-ADI': 12,
  'PL275-BKN': 45,
  'PL276-GTL': 37,
  'PL270-CRB': 129,
  'PL281-BB': 54,
};
const EXPECTED_TOTAL_ITEMS = 281;

/** paisa-exact bigint conversion, mirroring decimal.ts's own contract —
 * used here only to build test EXPECTATIONS from research §0's literals,
 * independent of any production code path (so a bug shared between
 * production and test helper can't cancel out). */
function toPaise(decimal: string): bigint {
  const minor = parseDecimalToMinorUnits(decimal, 2);
  if (minor === null) {
    throw new Error(`test setup bug: "${decimal}" is not a valid decimal`);
  }
  return minor;
}

function sumBidAmountPaise(items: readonly ParsedItem[]): bigint {
  return items.reduce((acc, item) => acc + toPaise(item.bidAmount), 0n);
}

describe('item-row parsing (DC-25)', () => {
  describe('anchors on the par token — 281-item regression bar', () => {
    it('parses without throwing for every letter in the corpus', () => {
      for (const { text } of loadCorpus()) {
        expect(() => parseItems(text)).not.toThrow();
      }
    });

    it.each(Object.entries(EXPECTED_ITEM_COUNTS))(
      '%s: item count is %i',
      (id, expected) => {
        const { text } = loadLetter(id);
        expect(parseItems(text)).toHaveLength(expected);
      },
    );

    it('sums to exactly 281 across the whole corpus', () => {
      const total = loadCorpus().reduce(
        (acc, { text }) => acc + parseItems(text).length,
        0,
      );
      expect(total).toBe(EXPECTED_TOTAL_ITEMS);
    });

    it('every item carries exactly one of the three par tokens, matching its raw anchor line', () => {
      for (const { text } of loadCorpus()) {
        for (const item of parseItems(text)) {
          expect(['At Par', 'Below Par', 'Above Par']).toContain(item.parToken);
          expect(item.raw.anchorLine).toContain(item.parToken);
        }
      }
    });
  });

  describe('never anchors on the leading serial number (PL275 Schedule A, real fixture)', () => {
    // research §2 / tickets/DC-25.md: PL275-BKN.txt:155 — inside item 1's
    // wrapped description, wrap-broken so its own continuation line begins
    // "10 sq. mm multi strand single core PVC insulated" (a fragment of
    // "...(iv) Supply of 10 sq. mm..."). A serial-number-anchored parser
    // would see a leading "10" here and could invent a phantom item; this
    // is the real corpus block the ticket names as the regression case.
    const { text } = loadLetter('PL275-BKN');
    const items = parseItems(text);

    it('total item count for PL275-BKN is 45 — no phantom item was created', () => {
      expect(items).toHaveLength(45);
    });

    it("the digit-leading continuation line is absorbed into item 1's description, not split into a new item", () => {
      const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');
      expect(item1).toBeDefined();
      expect(item1?.description).toContain(
        '10 sq. mm multi strand single core PVC insulated',
      );
    });

    it('item 10 is still the real item 10 (sno "10" is a legitimate item elsewhere, not confused with the phantom trap)', () => {
      const item10 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '10');
      expect(item10).toBeDefined();
      expect(item10?.itemCode).toBe('15014800');
      expect(item10?.bidAmount).toBe('831.60');
    });
  });

  describe('anchor-line parse direction: right-to-left for the numeric tail, left-to-right for item_sno', () => {
    it('PL275 Schedule A item 1 decomposes exactly as printed', () => {
      const items = parseItems(loadLetter('PL275-BKN').text);
      const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');
      expect(item1).toBeDefined();
      expect(item1).toMatchObject({
        itemSno: '1',
        itemCode: '13010300',
        qty: '8',
        qtyUnit: 'Lot',
        qtyUnitWrapped: false,
        unitRate: '17530.73',
        parToken: 'At Par',
        bidAmount: '140245.84',
      });
    });

    it('PL270 item "01" keeps its printed leading zero (item_sno parsed left-to-right, verbatim)', () => {
      const items = parseItems(loadLetter('PL270-CRB').text);
      const first = items.find((it) => it.itemSno === '01');
      expect(first).toBeDefined();
    });
  });

  describe('description collected from lines both above AND below the anchor', () => {
    // tickets/DC-25.md: "PL275 Schedule A item 1, whose description spans
    // ~24 lines with the data line 14th. The test asserts both the first
    // line above and the last line below the anchor are present."
    const items = parseItems(loadLetter('PL275-BKN').text);
    const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');

    it('item 1 exists', () => {
      expect(item1).toBeDefined();
    });

    it('the first line ABOVE the anchor is present in the recovered description', () => {
      // PL275-BKN.txt:136, the very first line of the description block,
      // 12 lines above the anchor at :148.
      expect(item1?.description).toContain(
        'Supply of basic material to construct unit',
      );
    });

    it('the last line BELOW the anchor is present in the recovered description', () => {
      // PL275-BKN.txt:160, the last line of the description block, right
      // before item 2's anchor at :161.
      expect(item1?.description).toContain('after Supply.');
    });

    it('the on-anchor-line description fragment is also present (a naive "description precedes the numbers" parser loses this)', () => {
      expect(item1?.description).toContain(
        '(ii) Supply of 35 sq. mm multi strand single core PVC',
      );
    });

    it('the description spans on the order of 24 lines (12 above + the anchor fragment + 11 below)', () => {
      const wordCount = item1?.description.split(/\s+/).length ?? 0;
      expect(wordCount).toBeGreaterThan(150);
    });
  });

  describe("adjacent items' descriptions intentionally overlap -- the inter-anchor region is shared, never dropped (items.ts module doc, ParsedItem.description)", () => {
    it("PL273 item 2's description contains item 1's OWN decomposition parenthetical, not just item 2's own -- the shared inter-anchor region is now load-bearing for needs-review.ts's qty-decomposition trigger, which must read the LAST matching occurrence, never the first", () => {
      const items = parseItems(loadLetter('PL273-JHS').text);
      const item1 = items.find((it) => it.itemSno === '1');
      const item2 = items.find((it) => it.itemSno === '2');
      expect(item1).toBeDefined();
      expect(item2).toBeDefined();

      // item 1's OWN decomposition clause (PL273-JHS.txt:199-201).
      expect(item1?.description).toContain('(Qty = 2 set x 24 month = 48 month)');
      // item 2's description contains BOTH item 1's clause (leaked in via
      // item 2's aboveLines, which cover the identical physical-line range
      // as item 1's belowLines) AND item 2's own (in its belowLines,
      // PL273-JHS.txt:208-210) -- by construction of `parseItems`'
      // aboveStart/belowEnd, which derive from the SAME
      // prevAnchorIdx/nextAnchorIdx pair for both neighbours.
      expect(item2?.description).toContain('(Qty = 2 set x 24 month = 48 month)');
      expect(item2?.description).toContain('(Qty = 2 nos x 24 month = 48 month)');
    });
  });

  describe('descriptions are preserved verbatim — never cleaned (research §4.6)', () => {
    it('the stray "©" (research\'s "M-BM-)" byte pair, U+00A9) mid-sentence in PL275 survives byte-for-byte', () => {
      const items = parseItems(loadLetter('PL275-BKN').text);
      const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');
      // PL275-BKN.txt:144 reads "...= 3 nos. © \nCopper strip of..." — the
      // raw fixture bytes are 0xC2 0xA9 (UTF-8 for U+00A9 COPYRIGHT SIGN),
      // which `pdftotext -layout` printed mid-sentence as stray layout
      // junk. Node's utf8 decoding turns those two bytes into exactly one
      // JS character, "©", which must appear in the assembled description
      // unaltered — not stripped, not replaced, not "cleaned" to ASCII.
      expect(item1?.description).toContain('3 nos. © Copper strip');
      expect(item1?.description).toContain('©');
    });
  });

  describe('schedule binding: nearest preceding header, verbatim id, directory', () => {
    it('PL275 items bind to the correct schedule with the correct directory (SOR vs "Not Applicable")', () => {
      const items = parseItems(loadLetter('PL275-BKN').text);
      const scheduleAItem = items.find((it) => it.itemSno === '1');
      const scheduleBItem = items.find((it) => it.itemSno === '22');
      expect(scheduleAItem?.schedule).toEqual({
        id: 'A',
        directory: 'SOR SNT NWR-Ver-2020',
      });
      expect(scheduleBItem?.schedule).toEqual({ id: 'B', directory: null });
    });

    it("PL276's Supply/Labour × SOR/Non-SOR 2×2 carries all four verbatim ids (A1/A2/B1/B2) — schedule identity is not an ordinal", () => {
      const items = parseItems(loadLetter('PL276-GTL').text);
      const ids = new Set(items.map((it) => it.schedule?.id));
      expect(ids).toEqual(new Set(['A1', 'A2', 'B1', 'B2']));
      // All four of PL276's schedules print "Not Applicable" — none names a
      // real SOR reference document (research §4.5).
      for (const item of items) {
        expect(item.schedule?.directory).toBeNull();
      }
    });

    it('every item in every letter binds to a non-null schedule (no item is left unbound)', () => {
      for (const { text } of loadCorpus()) {
        for (const item of parseItems(text)) {
          expect(item.schedule).not.toBeNull();
          expect(item.schedule?.id.length ?? 0).toBeGreaterThan(0);
        }
      }
    });

    it('a wrapped schedule-name header still resolves its id and directory correctly (PL270 Schedule A, name AND directory both wrap)', () => {
      // PL270-CRB.txt:167-169: "Schedule A-Passenger amenities and other
      // telecom assets at CSMT,                         %" / a numeric
      // totals line / "Dadar and Thane stations (Item Directory - Not
      // Applicable)                                Below" — both the
      // schedule NAME and the directory clause wrap, with an interleaved
      // numeric line in between (the same wrap-trap phenomenon
      // letter-number.ts solves for the letter number).
      const items = parseItems(loadLetter('PL270-CRB').text);
      const first = items.find((it) => it.itemSno === '01');
      expect(first?.schedule).toEqual({ id: 'A', directory: null });
    });

    it('the "Banned : ... Schedule AB-" prose decoy in PL280\'s header does not get mistaken for a schedule header', () => {
      // research §4: PL280-ADI.txt carries a "Banned : Rates of the
      // following items are banned for future reference Schedule AB-"
      // sentence in its NOTE paragraph, BEFORE the "Awarded Quantities And
      // Rates" marker — the exact "Schedule AB-" text a naive whole-letter
      // scan would treat as a second (bogus) schedule header.
      const items = parseItems(loadLetter('PL280-ADI').text);
      const ids = new Set(items.map((it) => it.schedule?.id));
      expect(ids).toEqual(new Set(['AB']));
      expect(items).toHaveLength(12);
    });
  });

  describe('item codes are unique only within a directory', () => {
    // research §4.5 / tickets/DC-25.md: "Item codes are unique only within
    // a directory (SOR 8-digit 13010300 vs non-SOR S01)." The six-letter
    // corpus never happens to print the SAME code under two DIFFERENT
    // directories (verified: no natural collision exists), so this test
    // engineers one deterministically by mutating a single token on a
    // single, uniquely-identified real anchor line — never a wholly
    // fabricated fixture (mirrors header-normalise.test.ts's
    // `deleteLetterNumberBlock` precedent: derive negative/edge cases from
    // real fixture text via a targeted, auditable in-memory edit).
    it('two items sharing a printed code under different directories are kept distinct, never merged', () => {
      const original = loadLetter('PL275-BKN').text;
      const lines = original.split('\n');
      const targetIdx = lines.findIndex(
        (l) => l.includes('NS1') && l.includes('At Par') && /^\s*22\s/.test(l),
      );
      expect(
        targetIdx,
        "test setup bug: could not find PL275 schedule B item 22's anchor line",
      ).toBeGreaterThanOrEqual(0);
      const originalLine = lines[targetIdx] as string;
      const mutatedLine = originalLine.replace(/\bNS1\b/, '13010300');
      expect(
        mutatedLine,
        'test setup bug: mutation did not change the target line',
      ).not.toBe(originalLine);
      const mutated = [
        ...lines.slice(0, targetIdx),
        mutatedLine,
        ...lines.slice(targetIdx + 1),
      ].join('\n');

      const items = parseItems(mutated);
      expect(items).toHaveLength(45); // mutating a token, not adding/removing an anchor

      const withCode = items.filter((it) => it.itemCode === '13010300');
      expect(withCode).toHaveLength(2);

      const scheduleADup = withCode.find((it) => it.schedule?.id === 'A');
      const scheduleBDup = withCode.find((it) => it.schedule?.id === 'B');
      expect(scheduleADup).toBeDefined();
      expect(scheduleBDup).toBeDefined();
      // Distinct directories, distinct underlying items — never merged or
      // flagged as duplicates of each other.
      expect(scheduleADup?.schedule?.directory).toBe('SOR SNT NWR-Ver-2020');
      expect(scheduleBDup?.schedule?.directory).toBeNull();
      expect(scheduleADup?.itemSno).toBe('1');
      expect(scheduleBDup?.itemSno).toBe('22');
      expect(scheduleADup?.bidAmount).not.toBe(scheduleBDup?.bidAmount);
    });
  });

  describe('the wrapped-unit trap: empty qty_unit column on the anchor line (PL276 RKM item)', () => {
    it('harvests "Route Kilo Meter (RKM)" from the four adjacent unit-column lines, not left null', () => {
      // research §4.4 / PL276-GTL.txt:497-501: item 13 of Schedule B1's
      // anchor line prints an EMPTY unit column (the token immediately
      // before unit_rate is itself numeric, "10" — that's qty, not a
      // unit) — the unit wraps across "Route" / "Kilo" / "Meter" / "(RKM)"
      // on the two lines above and two lines below the anchor instead.
      const items = parseItems(loadLetter('PL276-GTL').text);
      const rkmItem = items.find(
        (it) => it.schedule?.id === 'B1' && it.itemSno === '13',
      );
      expect(rkmItem).toBeDefined();
      expect(rkmItem?.qty).toBe('10');
      expect(rkmItem?.qtyUnit).toBe('Route Kilo Meter (RKM)');
      expect(rkmItem?.qtyUnitWrapped).toBe(true);
      expect(rkmItem?.unitRate).toBe('98750.00');
      expect(rkmItem?.bidAmount).toBe('987500.00');
      // The wrapped-unit item is not, on its own, an uncertain reconciled
      // amount — 10 × 98750.00 = 987500.00 exactly — so it should not be
      // flagged needsReview purely for having a wrapped (rather than
      // directly-printed) unit.
      expect(rkmItem?.reconciliation.ok).toBe(true);
      expect(rkmItem?.needsReview).toBe(false);
    });

    it('every OTHER item in the corpus reads its unit directly off the anchor line (qtyUnitWrapped is true for exactly one item, corpus-wide)', () => {
      const wrappedItems = loadCorpus().flatMap(({ text }) =>
        parseItems(text).filter((it) => it.qtyUnitWrapped),
      );
      expect(wrappedItems).toHaveLength(1);
    });
  });

  describe('qty × unit_rate ≈ bid_amount, exact-decimal, per PRODUCT-SPEC §5.1.3', () => {
    it('every one of the 281 real item rows reconciles exactly (zero paisa tolerance needed on real data)', () => {
      let checked = 0;
      for (const { text } of loadCorpus()) {
        for (const item of parseItems(text)) {
          expect(
            item.reconciliation.ok,
            `${item.itemSno} (${item.itemCode}): qty=${item.qty} rate=${item.unitRate} bid=${item.bidAmount} diff=${item.reconciliation.diff ?? 'null'}`,
          ).toBe(true);
          checked += 1;
        }
      }
      expect(checked).toBe(EXPECTED_TOTAL_ITEMS);
    });

    it('exact-decimal arithmetic never uses a float comparison — parseDecimalToMinorUnits/formatMinorUnits round-trip exactly', () => {
      // 17530.73 has no exact IEEE-754 binary-double representation — this
      // is precisely the value class a float comparison would need a fudge
      // factor for; the bigint-paisa path has none.
      expect(parseDecimalToMinorUnits('17530.73', 2)).toBe(1753073n);
      expect(formatMinorUnits(1753073n, 2)).toBe('17530.73');
      expect(parseDecimalToMinorUnits('8', 0)).toBe(8n);
      expect(parseDecimalToMinorUnits('1,200.50', 2)).toBe(120050n);
      expect(parseDecimalToMinorUnits('not-a-number', 2)).toBeNull();
      // 8 × 17530.73 in paisa, exactly — no `Math.abs(a - b) < epsilon`
      // anywhere on this path.
      expect(8n * 1753073n).toBe(14024584n);
      expect(formatMinorUnits(14024584n, 2)).toBe('140245.84');
    });

    describe('mismatch handling — synthetic (never observed on the real corpus: all 281 rows reconcile exactly)', () => {
      // Built as a minimal but complete item-table text block rather than
      // reusing loadCorpus()'s fixtures, per the reconciliation ticket
      // criterion's "explicit tolerance and arithmetic recovery" clause,
      // which the real corpus never exercises (mirrors DC-24's "Above Par
      // ... implemented defensively and marked untested" precedent).
      function syntheticLetter(bidAmount: string): string {
        return [
          'Awarded Quantities And Rates',
          '        Schedule A-Test (Item Directory - Not Applicable)',
          '',
          '              Some description text about the widget',
          ` 1            more description                    T01     5 Numbers     100.00 At Par      ${bidAmount}`,
          '              trailing description text',
        ].join('\n');
      }

      it('a decimal-shift-x10 mismatch (bid printed too small by a factor of 10) is flagged, never silently corrected', () => {
        // qty=5 × rate=100.00 = 500.00, printed bid = 50.00.
        const items = parseItems(syntheticLetter('50.00'));
        expect(items).toHaveLength(1);
        const item = items[0] as ParsedItem;
        expect(item.qty).toBe('5');
        expect(item.unitRate).toBe('100.00');
        expect(item.bidAmount).toBe('50.00'); // unmodified — no silent correction
        expect(item.reconciliation.ok).toBe(false);
        expect(item.reconciliation.expectedAmount).toBe('500.00');
        expect(item.reconciliation.recoveryHint).toBe('decimal-shift-x10');
        expect(item.needsReview).toBe(true);
        // The raw block is retained regardless of the failure.
        expect(item.raw.anchorLine).toContain('50.00');
      });

      it('a decimal-shift-div10 mismatch (bid printed too large by a factor of 10) is flagged, never silently corrected', () => {
        // qty=5 × rate=100.00 = 500.00, printed bid = 5000.00.
        const items = parseItems(syntheticLetter('5000.00'));
        const item = items[0] as ParsedItem;
        expect(item.bidAmount).toBe('5000.00');
        expect(item.reconciliation.ok).toBe(false);
        expect(item.reconciliation.recoveryHint).toBe('decimal-shift-div10');
        expect(item.needsReview).toBe(true);
      });

      it('a mismatch that matches neither recovery signature is flagged with no hint (never a guessed hint either)', () => {
        // qty=5 × rate=100.00 = 500.00, printed bid = 499.99 — a genuine
        // small discrepancy, not a decimal-shift pattern.
        const items = parseItems(syntheticLetter('499.99'));
        const item = items[0] as ParsedItem;
        expect(item.reconciliation.ok).toBe(false);
        expect(item.reconciliation.recoveryHint).toBeNull();
        expect(item.reconciliation.diff).toBe('0.01');
        expect(item.needsReview).toBe(true);
      });

      it('a reconciling amount is not flagged', () => {
        const items = parseItems(syntheticLetter('500.00'));
        const item = items[0] as ParsedItem;
        expect(item.reconciliation.ok).toBe(true);
        expect(item.reconciliation.recoveryHint).toBeNull();
        expect(item.needsReview).toBe(false);
      });
    });
  });

  describe("cross-check with DC-24's pricing shapes (research §0 literals — no db dependency, no dependency on DC-24 itself)", () => {
    // research §0's corpus table, quoted directly — the three Shape-A
    // letters at %At Par/%Below where the totals block's `Total Value`
    // advertised figure equals the SUM of the printed item Bid Amounts
    // exactly (research §1: "In Shape A the per-item Bid Amount values
    // printed in the table are at ADVERTISED rates").
    it('PL273 (0.00 %At Par): Σ bid_amount === advertised_value exactly', () => {
      const items = parseItems(loadLetter('PL273-JHS').text);
      expect(sumBidAmountPaise(items)).toBe(toPaise('3046426.56'));
    });

    it('PL280 (0.50 %Below): Σ bid_amount === advertised_value exactly', () => {
      const items = parseItems(loadLetter('PL280-ADI').text);
      expect(sumBidAmountPaise(items)).toBe(toPaise('4165603.32'));
    });

    it('PL275 (29.00 %Below): Σ bid_amount === advertised_value exactly', () => {
      const items = parseItems(loadLetter('PL275-BKN').text);
      expect(sumBidAmountPaise(items)).toBe(toPaise('7994861.18'));
    });

    it('PL281 (24.50 %Above — the only %Above letter in the corpus): Σ bid_amount === advertised_value exactly', () => {
      // research §7 Q3 / §1: item rows are printed at ADVERTISED rates under
      // %Above just as under %Below/%At Par (PL281's 54 item rows sum
      // exactly to the advertised figure, not the — larger — net/contract
      // figure). Closes this letter's absence from the cross-anchor set.
      const items = parseItems(loadLetter('PL281-BB').text);
      expect(sumBidAmountPaise(items)).toBe(toPaise('118502769.36'));
    });

    it('PL275: Σ bid_amount does NOT equal contract_value — the 29% "sum the item rows" bug can never be reintroduced unnoticed', () => {
      const items = parseItems(loadLetter('PL275-BKN').text);
      const sum = sumBidAmountPaise(items);
      const contractValue = toPaise('5676351.44');
      expect(sum).not.toBe(contractValue);
      // The gap research §1 calls out explicitly: 29% of the advertised
      // value, to the paisa.
      const advertised = toPaise('7994861.18');
      expect(sum).toBe(advertised);
      const gap = advertised - contractValue;
      expect(gap).toBe(toPaise('2318509.74'));
    });
  });
});
