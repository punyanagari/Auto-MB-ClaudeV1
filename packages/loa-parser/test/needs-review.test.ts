import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_UNIT_NAMES,
  classifyPricingShape,
  detectBannedItemsBlock,
  detectBannedItemsBranch,
  detectCorrigendumItemUnitCorrections,
  detectCorrigendumKeyword,
  detectItemCodeNamespaceMismatch,
  detectLayoutJunk,
  detectPaymentTermsProse,
  detectQtyDecomposition,
  detectUnexpectedAbovePar,
  detectUnexpectedItemBreakup,
  detectUnexpectedRebate,
  detectUnresolvedUnits,
  loadCorpus,
  loadLetter,
  parseItemNumberList,
  parseItems,
  resolveCanonicalUnitCode,
  reviewLoaLetter,
  type ParsedItem,
  type ReviewFlag,
} from '../src/index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(TEST_DIR, '..');
const SRC_DIR = path.join(PACKAGE_DIR, 'src');

/**
 * tickets/DC-26.md — the `needsReview` trigger set: six proven traps, plus
 * the "Additional required behaviour" defensive branches (Item Breakup /
 * Rebate / Above Par / Banned-items). Input contract:
 * research/DC-32-loa-parser-contract.md §4 (traps) and §5 (unexercised
 * branches). verify: `pnpm --filter @auto-mb/loa-parser --fail-if-no-match test
 * needs-review` (a filename-substring filter on `vitest run`, matching only
 * this file — every DC-26 assertion lives here so that verify line
 * exercises all of them).
 *
 * Per the ticket's own charter, every trigger the real corpus proves is
 * tested against `loadCorpus()`/`loadLetter()` output, never a synthetic
 * sample where the corpus contains the case. Triggers the corpus does NOT
 * exercise (item-code namespace mismatch; the numeric-column half of layout
 * junk; the Item Breakup / Rebate / Above Par defensive branches) are
 * proved by a targeted, in-memory, single-token mutation of a REAL fixture's
 * text — the fixture FILE itself is never touched (corpus-manifest.test.ts's
 * sha256 guard would go red on that) — mirroring the precedent
 * item-anchor.test.ts and pricing-shape.test.ts already established for
 * this package's own unexercised branches.
 */

const ALL_CORPUS_IDS = [
  'PL273-JHS',
  'PL280-ADI',
  'PL275-BKN',
  'PL276-GTL',
  'PL270-CRB',
  'PL281-BB',
];

function flagsOfCode(
  flags: readonly ReviewFlag[],
  code: ReviewFlag['code'],
): ReviewFlag[] {
  return flags.filter((f) => f.code === code);
}

// ---------------------------------------------------------------------------
// criterion 1 — prose corrigenda that contradict the table
// ---------------------------------------------------------------------------

describe('criterion 1: prose corrigenda that contradict the table', () => {
  describe('letter-level keyword trigger (NOTE:/clarification/corrigendum/"to be read as"/oversight)', () => {
    it('PL280, PL273 and PL275 each raise exactly one letter-level prose_corrigendum flag -- and no other letter does', () => {
      // Measured directly against the real fixtures (case-insensitive):
      // PL280 carries "NOTE:"/"oversight"/"clarification" (the genuine
      // unit-correction corrigendum); PL273 carries "Note:-" (stamp-duty
      // guidance, unrelated to any item); PL275 carries "Note:" INSIDE the
      // item-table region (an installation-responsibility note, also
      // unrelated to any item). PL276/PL270/PL281 contain none of the five
      // keywords anywhere in the letter.
      const triggering = new Set(['PL280-ADI', 'PL273-JHS', 'PL275-BKN']);
      for (const id of ALL_CORPUS_IDS) {
        const { text } = loadLetter(id);
        const flags = detectCorrigendumKeyword(text, id);
        if (triggering.has(id)) {
          expect(
            flags,
            `${id}: expected exactly one prose_corrigendum flag`,
          ).toHaveLength(1);
          expect(flags[0]?.scope).toBe('letter');
          expect(flags[0]?.code).toBe('prose_corrigendum');
        } else {
          expect(flags, `${id}: expected no prose_corrigendum flag`).toHaveLength(0);
        }
      }
    });

    it("PL275's trigger sits INSIDE the item-table region, past the marker -- a header-only scan would miss it", () => {
      const { text } = loadLetter('PL275-BKN');
      const markerIdx = text.indexOf('Awarded Quantities And Rates');
      const noteIdx = text.search(/Note\s*:/i);
      expect(markerIdx).toBeGreaterThan(-1);
      expect(noteIdx).toBeGreaterThan(markerIdx);
      // detectCorrigendumKeyword still finds it (whole-letter scan).
      expect(detectCorrigendumKeyword(text, 'PL275-BKN')).toHaveLength(1);
    });
  });

  describe("PL280's item-naming corrigendum: EXACTLY 7 items (1-6 and 12 in Schedule AB)", () => {
    it('flags item numbers 1,2,3,4,5,6,12 -- no more, no fewer -- each carrying printed_unit "year" / proposed_unit "quarter"', () => {
      const { text } = loadLetter('PL280-ADI');
      const items = parseItems(text);
      const flags = detectCorrigendumItemUnitCorrections(text, items);

      expect(flags).toHaveLength(7);
      const flaggedSnos = flags
        .map((f) => Number.parseInt(f.targetId.split('#')[1] ?? '', 10))
        .sort((a, b) => a - b);
      expect(flaggedSnos).toEqual([1, 2, 3, 4, 5, 6, 12]);

      for (const flag of flags) {
        expect(flag.code).toBe('prose_unit_correction');
        expect(flag.scope).toBe('item');
        expect(flag.targetId.startsWith('AB#')).toBe(true);
        expect(flag.detail).toEqual({
          printed_unit: 'year',
          proposed_unit: 'quarter',
          source: 'prose',
        });
        // The parser records the proposal but NEVER applies it: every
        // named item's own already-parsed qtyUnit is untouched.
        const item = items.find((it) => `AB#${it.itemSno}` === flag.targetId);
        expect(item).toBeDefined();
        expect(item?.qtyUnit).toBe('Numbers');
      }
    });

    it('items 7-11 (named neither individually nor by the "1 to 6" range) are NOT flagged', () => {
      const { text } = loadLetter('PL280-ADI');
      const items = parseItems(text);
      const flags = detectCorrigendumItemUnitCorrections(text, items);
      // PL280's printed serials are zero-padded ("01".."12") -- targetId is
      // "AB#01", never "AB#1", so this compares PARSED ints (matching the
      // exact-set assertion above), never the zero-padded string directly,
      // or `has('AB#7')` would vacuously always be true (no flag's targetId
      // could ever equal that string, zero-padded or not).
      const flaggedSnoNumbers = new Set(
        flags.map((f) => Number.parseInt(f.targetId.split('#')[1] ?? '', 10)),
      );
      expect(flaggedSnoNumbers).toEqual(new Set([1, 2, 3, 4, 5, 6, 12]));
      for (const sno of [7, 8, 9, 10, 11]) {
        expect(flaggedSnoNumbers.has(sno)).toBe(false);
      }
    });

    it('no other letter in the corpus carries this item-naming corrigendum', () => {
      for (const id of ALL_CORPUS_IDS) {
        if (id === 'PL280-ADI') {
          continue;
        }
        const { text } = loadLetter(id);
        const items = parseItems(text);
        expect(
          detectCorrigendumItemUnitCorrections(text, items),
          `${id}: expected no item-naming corrigendum flags`,
        ).toHaveLength(0);
      }
    });
  });

  describe('parseItemNumberList', () => {
    it('parses "1 to 6 and 12" as [1,2,3,4,5,6,12]', () => {
      expect(parseItemNumberList('1 to 6 and 12')).toEqual([1, 2, 3, 4, 5, 6, 12]);
    });

    it('parses a comma-separated list and de-duplicates', () => {
      expect(parseItemNumberList('2, 6, 8, 2')).toEqual([2, 6, 8]);
    });
  });
});

// ---------------------------------------------------------------------------
// criterion 2 — quantity decomposed in prose, not columns
// ---------------------------------------------------------------------------

describe('criterion 2: quantity decomposed in prose, not columns', () => {
  it('EXACTLY 4 of the 281 items carry a prose_qty_decomposition flag -- all four in PL273', () => {
    const allFlags = loadCorpus().flatMap(({ manifest, text }) =>
      detectQtyDecomposition(parseItems(text)).map((f) => ({
        letterId: manifest.id,
        ...f,
      })),
    );
    expect(allFlags).toHaveLength(4);
    expect(allFlags.every((f) => f.letterId === 'PL273-JHS')).toBe(true);
  });

  it("each of PL273's 4 items reconciles multiplier * base_qty against the printed Qty column, and base_qty is the DELIVERABLE (not the printed 48/96)", () => {
    const { text } = loadLetter('PL273-JHS');
    const items = parseItems(text);
    const flags = detectQtyDecomposition(items);
    expect(flags).toHaveLength(4);

    const expected: Record<
      string,
      { multiplier: number; base_qty: number; base_unit: string }
    > = {
      '1': { multiplier: 24, base_qty: 2, base_unit: 'set' },
      '2': { multiplier: 24, base_qty: 2, base_unit: 'nos' },
      '3': { multiplier: 24, base_qty: 4, base_unit: 'nos' },
      '4': { multiplier: 24, base_qty: 2, base_unit: 'nos' },
    };

    for (const flag of flags) {
      const sno = flag.targetId.split('#')[1] ?? '';
      const exp = expected[sno];
      expect(exp, `unexpected item sno ${sno} in flags`).toBeDefined();
      expect(flag.code).toBe('prose_qty_decomposition');
      expect(flag.scope).toBe('item');
      expect(flag.detail).toEqual({ ...exp, source: 'prose' });

      const item = items.find((it) => it.itemSno === sno) as ParsedItem;
      // The printed Qty column equals multiplier * base_qty exactly --
      // proving "last match, not first" recovered THIS item's own
      // decomposition rather than a neighbour's leaked one (module doc,
      // detectQtyDecomposition).
      expect(Number.parseInt(item.qty, 10)).toBe(
        (exp as { multiplier: number; base_qty: number }).multiplier *
          (exp as { multiplier: number; base_qty: number }).base_qty,
      );
    }
  });

  it('taking the FIRST match instead of the LAST would shift every item\'s decomposition onto its PRECEDING item\'s -- proving "last" is load-bearing, not an arbitrary tiebreak', () => {
    const { text } = loadLetter('PL273-JHS');
    const items = parseItems(text);
    const RE =
      /\(Qty\s*=\s*(\d+)\s+([A-Za-z]+)\s*x\s*(\d+)\s+([A-Za-z]+)\s*=\s*(\d+)\s+([A-Za-z]+)\)/gi;
    const firstMatchTuples = items.map((it) => {
      const m = [...it.description.matchAll(RE)][0];
      return m === undefined ? null : `${m[1]}-${m[2]}`;
    });
    const lastMatchTuples = items.map((it) => {
      const all = [...it.description.matchAll(RE)];
      const m = all[all.length - 1];
      return m === undefined ? null : `${m[1]}-${m[2]}`;
    });
    // Each item's OWN genuine tuple (LAST match): item 1 "2-set", item 2
    // "2-nos", item 3 "4-nos", item 4 "2-nos".
    expect(lastMatchTuples).toEqual(['2-set', '2-nos', '4-nos', '2-nos']);
    // Taking the FIRST match instead shifts every item onto its PRECEDING
    // item's tuple: item 1 has no predecessor (its only match IS its own),
    // but items 2/3/4 all show item 1/2/3's tuple respectively -- an
    // off-by-one misattribution, not a random-looking failure, which is
    // exactly what makes it easy to miss without this proof.
    expect(firstMatchTuples).toEqual(['2-set', '2-set', '2-nos', '4-nos']);
    expect(firstMatchTuples).not.toEqual(lastMatchTuples);
  });
});

// ---------------------------------------------------------------------------
// criterion 3 — payment terms embedded in description prose
// ---------------------------------------------------------------------------

describe('criterion 3: payment terms embedded in description prose', () => {
  it('every PL275 item whose OWN description prose states "Payment Terms:" is flagged -- self-consistently re-measured, never hand-copied', () => {
    const { text } = loadLetter('PL275-BKN');
    const items = parseItems(text);
    const flags = detectPaymentTermsProse(items);

    const independentlyMeasured = items.filter((it) =>
      /Payment\s*Terms\s*:/i.test(it.description),
    );
    expect(flags).toHaveLength(independentlyMeasured.length);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.length).toBeLessThanOrEqual(items.length);

    const flaggedTargetIds = new Set(flags.map((f) => f.targetId));
    for (const item of independentlyMeasured) {
      expect(
        flaggedTargetIds.has(`${item.schedule?.id ?? 'UNBOUND'}#${item.itemSno}`),
      ).toBe(true);
    }
    for (const flag of flags) {
      expect(flag.code).toBe('prose_payment_terms');
      expect(flag.scope).toBe('item');
      expect(flag.rawBlock).toMatch(/Payment\s*Terms\s*:/i);
    }
  });

  it("item 1's description carries the ticket's exact quoted example verbatim", () => {
    const { text } = loadLetter('PL275-BKN');
    const items = parseItems(text);
    const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');
    expect(item1).toBeDefined();
    expect(item1?.description).toContain(
      'Inspection: RDSO Inspection Charges:Borne by Railways Payment Terms: 100%',
    );
    const flags = detectPaymentTermsProse(items);
    expect(flags.some((f) => f.targetId === 'A#1')).toBe(true);
  });

  it('no other letter in the corpus has any item carrying this flag', () => {
    for (const id of ALL_CORPUS_IDS) {
      if (id === 'PL275-BKN') {
        continue;
      }
      const { text } = loadLetter(id);
      expect(
        detectPaymentTermsProse(parseItems(text)),
        `${id}: expected no prose_payment_terms flags`,
      ).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// criterion 4 — dirty unit vocabulary
// ---------------------------------------------------------------------------

describe('criterion 4: dirty unit vocabulary', () => {
  it('the recognition set holds exactly the 12 DC-45 canonical display spellings, in the same count DC-45 seeds', () => {
    expect(CANONICAL_UNIT_NAMES).toHaveLength(12);
    expect([...CANONICAL_UNIT_NAMES].sort()).toEqual(
      [
        'Numbers',
        'Metre',
        'RMT',
        'Year',
        'Month',
        'Pair',
        'Kilometre',
        'Set',
        'Lumpsum',
        'Lot',
        'Job',
        'Route Kilometre',
      ].sort(),
    );
  });

  it('EXACTLY 1 of the 281 items fails to resolve -- PL276-GTL schedule B1 item 13, the wrapped RKM item', () => {
    const allFlags = loadCorpus().flatMap(({ manifest, text }) =>
      detectUnresolvedUnits(parseItems(text)).map((f) => ({
        letterId: manifest.id,
        ...f,
      })),
    );
    expect(allFlags).toHaveLength(1);
    expect(allFlags[0]?.letterId).toBe('PL276-GTL');
    expect(allFlags[0]?.targetId).toBe('B1#13');
    expect(allFlags[0]?.code).toBe('unresolved_unit');
    expect(allFlags[0]?.detail).toEqual({
      printedUnit: 'Route Kilo Meter (RKM)',
    });
  });

  it('all 280 OTHER items resolve to a non-null canonical code', () => {
    const totals = { resolved: 0, unresolved: 0 };
    for (const { text } of loadCorpus()) {
      for (const item of parseItems(text)) {
        if (resolveCanonicalUnitCode(item.qtyUnit) === null) {
          totals.unresolved += 1;
        } else {
          totals.resolved += 1;
        }
      }
    }
    expect(totals.resolved).toBe(280);
    expect(totals.unresolved).toBe(1);
  });

  it('a null printed unit resolves to null, never a guess', () => {
    expect(resolveCanonicalUnitCode(null)).toBeNull();
  });

  describe('the parser contains no unit-synonym table -- normalisation lives in the units master (DC-45), not here', () => {
    it('description-prose / wrap-harvest aliases (Mtr, Nos, Km, the wrapped RKM spelling) all resolve to null -- never privately normalised', () => {
      expect(resolveCanonicalUnitCode('Mtr')).toBeNull();
      expect(resolveCanonicalUnitCode('Nos')).toBeNull();
      expect(resolveCanonicalUnitCode('Km')).toBeNull();
      expect(resolveCanonicalUnitCode('Route Kilo Meter (RKM)')).toBeNull();
      // Case sensitivity is not silently coerced either -- an exact match
      // only, never a case-insensitive "helpful" comparison that would
      // itself be a step toward alias-guessing.
      expect(resolveCanonicalUnitCode('numbers')).toBeNull();
      expect(resolveCanonicalUnitCode('METRE')).toBeNull();
    });

    it('source-scan: needs-review.ts, comments stripped, contains no alias spelling as a quoted string literal', () => {
      const sourcePath = path.join(SRC_DIR, 'needs-review.ts');
      const source = readFileSync(sourcePath, 'utf8');
      // Strip block comments then line comments -- leaves only executable
      // code (plus string/template literal content), so this scan proves
      // the ALIAS SPELLINGS never appear as CODE, only ever as prose in the
      // comments explaining why they are deliberately absent.
      const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
      const withoutComments = withoutBlockComments.replace(/\/\/.*$/gm, '');
      expect(withoutComments.length).toBeGreaterThan(0);
      for (const alias of ["'Mtr'", '"Mtr"', "'Nos'", '"Nos"', "'Km'", '"Km"']) {
        expect(withoutComments.includes(alias)).toBe(false);
      }
    });

    it('source-scan: needs-review.ts imports nothing from @auto-mb/db (the units master lives there, resolution stays there)', () => {
      const sourcePath = path.join(SRC_DIR, 'needs-review.ts');
      const source = readFileSync(sourcePath, 'utf8');
      const importRe =
        /(?:import|export)(?:\s+type)?(?:[\s\w{},*]+from)?\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;
      const specs: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(source)) !== null) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec !== undefined) {
          specs.push(spec);
        }
      }
      expect(specs.length).toBeGreaterThan(0);
      for (const spec of specs) {
        expect(spec.startsWith('@auto-mb/db')).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// criterion 5 — item-code namespace mismatch
// ---------------------------------------------------------------------------

describe('criterion 5: item-code namespace mismatch', () => {
  it('zero items in the real six-letter corpus trigger this flag -- every genuine 8-digit code sits under the one real SOR directory', () => {
    const allFlags = loadCorpus().flatMap(({ text }) =>
      detectItemCodeNamespaceMismatch(parseItems(text)),
    );
    expect(allFlags).toHaveLength(0);
  });

  // Amendment (manager ratification, tickets/DC-26.md criterion 5,
  // 2026-08-05): "a corpus regression asserting zero criterion-5 flags
  // across all six letters -- the test that fails at 260 if the literal
  // reading is ever reintroduced." An EXPLICIT per-letter assertion, not
  // just the flattened aggregate above (which would also catch a
  // regression, but names no letter on failure) -- if the rejected literal
  // reading ("any code under a Not Applicable directory") is ever
  // reintroduced, this fails per-letter with the offending letter's id in
  // the message, and the total across the six matches the measured 260/281
  // figure the ticket's amendment cites (never re-asserted as a magic
  // number here -- computed independently below from `parseItems` output,
  // the same measurement method the amendment's own 92.5% figure used).
  it("EXPLICIT per-letter zero-flags regression for 'item_code_namespace_mismatch' -- fails at 260/281 if the rejected literal reading is ever reintroduced", () => {
    for (const { manifest, text } of loadCorpus()) {
      const flags = detectItemCodeNamespaceMismatch(parseItems(text));
      const namespaceMismatchFlags = flags.filter(
        (f) => f.code === 'item_code_namespace_mismatch',
      );
      expect(
        namespaceMismatchFlags,
        `${manifest.id}: expected zero item_code_namespace_mismatch flags`,
      ).toHaveLength(0);
    }

    // The rejected literal reading, independently re-measured here (never
    // imported from source): "any code under a Not Applicable directory"
    // -- proves the 260/281 figure the amendment cites is real, not
    // asserted on faith, and that THIS specific narrower trigger avoids it.
    const literalReadingCount = loadCorpus().flatMap(({ text }) =>
      parseItems(text).filter((it) => (it.schedule?.directory ?? null) === null),
    ).length;
    expect(literalReadingCount).toBe(260);
  });

  // This IS the amendment's required "synthetic fixture (8-digit code under
  // a null directory -> flag)" case (tickets/DC-26.md criterion 5, manager
  // ratification 2026-08-05): "synthetic" here means "constructed to
  // exercise a case the real corpus does not naturally contain," achieved
  // via a single targeted, in-memory token mutation of REAL fixture text --
  // the exact same real-fixture mutation item-anchor.test.ts's own "item
  // codes are unique only within a directory" regression case uses (PL275
  // schedule B item 22's "NS1" code, rewritten to the SOR-shaped
  // "13010300"), reconstructed independently here rather than imported (no
  // test-to-test coupling across ticket suites). Never a WHOLLY FABRICATED
  // fixture, and the fixture FILE itself is never touched -- this package's
  // established convention (item-anchor.test.ts, pricing-shape.test.ts)
  // over inventing text from scratch.
  it("mutating a real non-SOR item code to an 8-digit SOR shape raises the flag (the amendment's required synthetic case)", () => {
    const original = loadLetter('PL275-BKN').text;
    const lines = original.split('\n');
    const targetIdx = lines.findIndex(
      (l) => l.includes('NS1') && l.includes('At Par') && /^\s*22\s/.test(l),
    );
    expect(
      targetIdx,
      "test setup bug: could not find PL275 item 22's anchor line",
    ).toBeGreaterThanOrEqual(0);
    const originalLine = lines[targetIdx] as string;
    const mutatedLine = originalLine.replace(/\bNS1\b/, '13010300');
    expect(mutatedLine).not.toBe(originalLine);
    const mutated = [
      ...lines.slice(0, targetIdx),
      mutatedLine,
      ...lines.slice(targetIdx + 1),
    ].join('\n');

    const items = parseItems(mutated);
    const mismatchItem = items.find(
      (it) => it.schedule?.id === 'B' && it.itemSno === '22',
    );
    expect(mismatchItem).toBeDefined();
    expect(mismatchItem?.itemCode).toBe('13010300');
    expect(mismatchItem?.schedule?.directory).toBeNull();

    const flags = detectItemCodeNamespaceMismatch(items);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('item_code_namespace_mismatch');
    expect(flags[0]?.scope).toBe('item');
    expect(flags[0]?.targetId).toBe('B#22');

    // The GENUINE schedule-A item carrying this exact code under the real
    // SOR directory is never flagged -- the mismatch is directory-specific,
    // not code-specific.
    const genuineSorItem = items.find(
      (it) => it.schedule?.id === 'A' && it.itemCode === '13010300',
    );
    expect(genuineSorItem?.schedule?.directory).toBe('SOR SNT NWR-Ver-2020');
    expect(flags.some((f) => f.targetId === 'A#1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// criterion 6 — layout junk / unparseable token
// ---------------------------------------------------------------------------

describe('criterion 6: layout junk / unparseable token', () => {
  describe('description half -- exercised by the real corpus', () => {
    it('PL275 Schedule A item 1 carries a stray "©" glyph mid-sentence, retained verbatim and flagged', () => {
      const { text } = loadLetter('PL275-BKN');
      const items = parseItems(text);
      const item1 = items.find((it) => it.schedule?.id === 'A' && it.itemSno === '1');
      expect(item1).toBeDefined();
      expect(item1?.description).toContain('©');
      // Never cleaned: the glyph survives byte-for-byte in the description
      // this module reads, exactly as items.ts's own module doc requires.

      const flags = detectLayoutJunk(items);
      const junkFlags = flagsOfCode(flags, 'layout_junk');
      expect(junkFlags.some((f) => f.targetId === 'A#1')).toBe(true);
    });

    it('EXACTLY 1 item, corpus-wide, carries this glyph -- not the legitimate "¾" fraction (PL275) or "•" bulleted lists (PL276), both verified real content', () => {
      const withGlyph = loadCorpus().flatMap(({ manifest, text }) =>
        parseItems(text)
          .filter((it) => /[©]/.test(it.description))
          .map((it) => ({ letterId: manifest.id, sno: it.itemSno })),
      );
      expect(withGlyph).toHaveLength(1);
      expect(withGlyph[0]).toEqual({ letterId: 'PL275-BKN', sno: '1' });

      // The legitimate unicode this corpus carries is verified PRESENT and
      // never mistaken for junk.
      const { text: pl275 } = loadLetter('PL275-BKN');
      expect(pl275).toContain('¾');
      const { text: pl276 } = loadLetter('PL276-GTL');
      expect(pl276).toContain('•');
    });
  });

  describe('numeric-column half -- unexercised by the real corpus, proved by mutation', () => {
    it('zero items in the real corpus hit the malformed-anchor-line fallback', () => {
      const allMalformed = loadCorpus().flatMap(({ text }) =>
        parseItems(text).filter((it) => it.itemCode === ''),
      );
      expect(allMalformed).toHaveLength(0);
    });

    it("corrupting a real anchor line's unit_rate decimal format breaks the tail parse -- items.ts falls back to malformedItem, and this module flags it", () => {
      const original = loadLetter('PL273-JHS').text;
      const lines = original.split('\n');
      // Item 1's real anchor line: "...816.02 At Par 39168.96" -- corrupt
      // the money-figure format (strip the required two-decimal-place
      // group) so ANCHOR_TAIL_RE can no longer match.
      const targetIdx = lines.findIndex(
        (l) => l.includes('816.02') && l.includes('At Par'),
      );
      expect(
        targetIdx,
        "test setup bug: could not find PL273 item 1's anchor line",
      ).toBeGreaterThanOrEqual(0);
      const originalLine = lines[targetIdx] as string;
      const mutatedLine = originalLine.replace('816.02', '816');
      expect(mutatedLine).not.toBe(originalLine);
      const mutated = [
        ...lines.slice(0, targetIdx),
        mutatedLine,
        ...lines.slice(targetIdx + 1),
      ].join('\n');

      const items = parseItems(mutated);
      // Still counted as an anchor (PAR_TOKEN_RE still matches "At Par") --
      // never silently dropped.
      expect(items).toHaveLength(4);
      const malformed = items.find((it) => it.itemCode === '');
      expect(malformed).toBeDefined();
      expect(malformed?.needsReview).toBe(true);
      expect(malformed?.raw.anchorLine).toBe(mutatedLine);

      const flags = detectLayoutJunk(items);
      const anchorLineFlag = flagsOfCode(flags, 'layout_junk').find(
        (f) => f.rawBlock === mutatedLine,
      );
      expect(anchorLineFlag).toBeDefined();
      expect(anchorLineFlag?.scope).toBe('item');
    });
  });
});

// ---------------------------------------------------------------------------
// "Additional required behaviour" — unexercised defensive template branches
// ---------------------------------------------------------------------------

describe('unexercised template branches, implemented defensively (research §5)', () => {
  describe('Item Breakup: "No break up item added" in 6/6', () => {
    it('every real letter reads the universal content -- no flag on any of the six', () => {
      for (const id of ALL_CORPUS_IDS) {
        const { text } = loadLetter(id);
        expect(
          detectUnexpectedItemBreakup(text, id),
          `${id}: expected no unexpected_item_breakup flag`,
        ).toHaveLength(0);
      }
    });

    it('substituting different content in a real fixture (in-memory only) raises the flag', () => {
      const original = loadLetter('PL280-ADI').text;
      const mutated = original.replace(
        'No break up item added',
        'Item 3 has a separate breakup schedule attached',
      );
      expect(mutated).not.toBe(original);
      const flags = detectUnexpectedItemBreakup(mutated, 'PL280-ADI');
      expect(flags).toHaveLength(1);
      expect(flags[0]?.code).toBe('unexpected_item_breakup');
      expect(flags[0]?.scope).toBe('letter');
      expect(flags[0]?.rawBlock).toContain('separate breakup schedule');
    });
  });

  describe('Rebate on Total Value (%): 0.00 in 6/6', () => {
    it('every real letter reads 0.00 -- no flag on any of the six', () => {
      for (const id of ALL_CORPUS_IDS) {
        const { text } = loadLetter(id);
        const result = classifyPricingShape(text);
        expect(
          detectUnexpectedRebate(result, id),
          `${id}: expected no unexpected_rebate flag`,
        ).toHaveLength(0);
      }
    });

    it("a non-zero rebate spliced into a real fixture (in-memory only, same technique as pricing-shape.test.ts's own decoy case) raises the flag", () => {
      const original = loadLetter('PL273-JHS').text;
      const decoyText = original.replace(
        /(Rebate on Total Value[\s\S]*?)0\.00([\s\S]*?Net Bid Value)/,
        '$15.00$2',
      );
      expect(decoyText).not.toBe(original);
      const result = classifyPricingShape(decoyText);
      expect(result.rebateOnTotalValue).toBe(5);

      const flags = detectUnexpectedRebate(result, 'PL273-JHS');
      expect(flags).toHaveLength(1);
      expect(flags[0]?.code).toBe('unexpected_rebate');
      expect(flags[0]?.scope).toBe('letter');
    });
  });

  describe('item-row "Above Par": never observed (281/281 read "At Par")', () => {
    it('zero items in the real corpus carry this token -- no flags anywhere', () => {
      const allFlags = loadCorpus().flatMap(({ text }) =>
        detectUnexpectedAbovePar(parseItems(text)),
      );
      expect(allFlags).toHaveLength(0);
    });

    it('mutating a real anchor line\'s "At Par" to "Above Par" (in-memory only) raises the flag for that item', () => {
      const original = loadLetter('PL273-JHS').text;
      const lines = original.split('\n');
      const targetIdx = lines.findIndex(
        (l) => l.includes('816.02') && l.includes('At Par'),
      );
      expect(targetIdx).toBeGreaterThanOrEqual(0);
      const originalLine = lines[targetIdx] as string;
      const mutatedLine = originalLine.replace('At Par', 'Above Par');
      expect(mutatedLine).not.toBe(originalLine);
      const mutated = [
        ...lines.slice(0, targetIdx),
        mutatedLine,
        ...lines.slice(targetIdx + 1),
      ].join('\n');

      const items = parseItems(mutated);
      expect(items).toHaveLength(4); // still 4 anchors -- token swap, not a new/dropped anchor
      const flags = detectUnexpectedAbovePar(items);
      expect(flags).toHaveLength(1);
      expect(flags[0]?.code).toBe('unexpected_above_par');
      expect(flags[0]?.scope).toBe('item');
      expect(flags[0]?.targetId).toBe('A#1');
    });
  });
});

// ---------------------------------------------------------------------------
// "Additional required behaviour" — Banned-items block, both spellings
// ---------------------------------------------------------------------------

describe('Banned-items block: both spellings recognised against the real corpus (research §5, no longer unexercised)', () => {
  it('PL280\'s "Banned :" spelling is recognised but its content is NIL -- not flagged', () => {
    const { text } = loadLetter('PL280-ADI');
    const detection = detectBannedItemsBlock(text);
    expect(detection).not.toBeNull();
    expect(detection?.spelling).toBe('colon');
    expect(detection?.populated).toBe(false);
    expect(detection?.rawBlock).toContain('NIL');

    const flags = detectBannedItemsBranch(text, 'PL280-ADI');
    expect(flags).toHaveLength(0);
  });

  it('PL281\'s "Banned item:" spelling is recognised, populated, and flagged, preserving the letter\'s own "baneed" typo verbatim', () => {
    const { text } = loadLetter('PL281-BB');
    const detection = detectBannedItemsBlock(text);
    expect(detection).not.toBeNull();
    expect(detection?.spelling).toBe('item');
    expect(detection?.populated).toBe(true);
    expect(detection?.rawBlock).toContain('baneed');
    expect(detection?.rawBlock).toContain('item no 2,6,8,16,17,18');

    const flags = detectBannedItemsBranch(text, 'PL281-BB');
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('banned_items_block');
    expect(flags[0]?.scope).toBe('letter');
    expect(flags[0]?.rawBlock).toContain('baneed');
  });

  it('no other letter in the corpus carries either spelling', () => {
    for (const id of ALL_CORPUS_IDS) {
      if (id === 'PL280-ADI' || id === 'PL281-BB') {
        continue;
      }
      const { text } = loadLetter(id);
      expect(
        detectBannedItemsBlock(text),
        `${id}: expected no Banned-block detection`,
      ).toBeNull();
    }
  });

  // Negative-proof scaffolding for both spelling arms (DC-26 DoD (c)):
  // disabling EITHER of needs-review.ts's two regexes
  // (BANNED_ITEM_LABEL_RE / BANNED_COLON_LABEL_RE) turns exactly one of the
  // two tests above red (PL281's populated-and-flagged assertion, or
  // PL280's recognised-but-NIL assertion) -- verified by hand during
  // implementation (see the ticket report), reverted before commit; not
  // re-encoded as a permanent mutation test here because that would require
  // this test file to import and monkeypatch needs-review.ts's private
  // regexes, which the module deliberately does not export.
  it("the two spelling regexes are mutually exclusive: neither matches the other's label text (verified both directions, not assumed)", () => {
    const bannedItemLabel = /Banned\s+item\s*:/i;
    const bannedColonLabel = /Banned\s*:/i;
    // \s* only ever consumes WHITESPACE -- it can never skip over the
    // literal word "item", so the colon-arm regex requires ":" to follow
    // "Banned" with nothing but whitespace between, which "Banned item:"
    // does not satisfy either.
    expect(bannedItemLabel.test('Banned : Rates of the following items')).toBe(false);
    expect(bannedColonLabel.test('Banned item: Rates of item no 2,6,8')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// needsReview roll-up
// ---------------------------------------------------------------------------

describe('needsReview roll-up: total, counts by code, any-letter-level', () => {
  it('PL280: 8 total flags (1 letter-level corrigendum + 7 item-level unit corrections), anyLetterLevel true', () => {
    const payload = reviewLoaLetter(loadLetter('PL280-ADI').text);
    expect(payload.needsReview.total).toBe(payload.flags.length);
    expect(payload.needsReview.total).toBe(8);
    expect(payload.needsReview.byCode).toEqual({
      prose_corrigendum: 1,
      prose_unit_correction: 7,
    });
    expect(payload.needsReview.anyLetterLevel).toBe(true);
  });

  it("PL270: zero flags, anyLetterLevel false -- the corpus's one entirely clean letter under this trigger set", () => {
    const payload = reviewLoaLetter(loadLetter('PL270-CRB').text);
    expect(payload.needsReview.total).toBe(0);
    expect(payload.needsReview.byCode).toEqual({});
    expect(payload.needsReview.anyLetterLevel).toBe(false);
  });

  it('PL276: exactly 1 flag (the RKM unresolved-unit item), anyLetterLevel false (an item-level-only flag)', () => {
    const payload = reviewLoaLetter(loadLetter('PL276-GTL').text);
    expect(payload.needsReview.total).toBe(1);
    expect(payload.needsReview.byCode).toEqual({ unresolved_unit: 1 });
    expect(payload.needsReview.anyLetterLevel).toBe(false);
  });

  it('byCode always sums to total, and total always equals flags.length, across the whole corpus', () => {
    for (const { text } of loadCorpus()) {
      const payload = reviewLoaLetter(text);
      const sumOfCodes = Object.values(payload.needsReview.byCode).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sumOfCodes).toBe(payload.needsReview.total);
      expect(payload.needsReview.total).toBe(payload.flags.length);
    }
  });
});

// ---------------------------------------------------------------------------
// flags are additive: never replace parsed data, never drop a field
// ---------------------------------------------------------------------------

describe('flags are additive -- parsed data is never replaced or dropped', () => {
  it('reviewLoaLetter never drops an item: item count matches parseItems() exactly, per letter', () => {
    for (const { manifest, text } of loadCorpus()) {
      const payload = reviewLoaLetter(text);
      expect(payload.items.length, `${manifest.id}: item count`).toBe(
        manifest.item_count,
      );
    }
  });

  it('every flag carries all four required fields, plus a well-formed scope/code', () => {
    const validScopes = new Set(['letter', 'schedule', 'item']);
    const validCodes = new Set([
      'prose_corrigendum',
      'prose_unit_correction',
      'prose_qty_decomposition',
      'prose_payment_terms',
      'unresolved_unit',
      'item_code_namespace_mismatch',
      'layout_junk',
      'unexpected_item_breakup',
      'unexpected_rebate',
      'unexpected_above_par',
      'banned_items_block',
    ]);
    for (const { text } of loadCorpus()) {
      const payload = reviewLoaLetter(text);
      for (const flag of payload.flags) {
        expect(typeof flag.code).toBe('string');
        expect(validCodes.has(flag.code)).toBe(true);
        expect(validScopes.has(flag.scope)).toBe(true);
        expect(typeof flag.targetId).toBe('string');
        expect(typeof flag.rawBlock).toBe('string');
        expect(typeof flag.message).toBe('string');
        expect(flag.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("PL280's corrigendum-flagged items still carry their real printed unitRate/bidAmount/reconciliation -- the flag adds detail, it never overwrites a field", () => {
    const { text } = loadLetter('PL280-ADI');
    const payload = reviewLoaLetter(text);
    const item1 = payload.items.find(
      (it) => it.schedule?.id === 'AB' && it.itemSno === '01',
    );
    expect(item1).toBeDefined();
    expect(item1?.bidAmount).toBe('1397463.36');
    expect(item1?.reconciliation.ok).toBe(true);
    expect(
      payload.flags.some(
        (f) => f.code === 'prose_unit_correction' && f.targetId === 'AB#01',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// never auto-commit
// ---------------------------------------------------------------------------

describe('never auto-commit (PRODUCT-SPEC §5.1 step 2)', () => {
  it('reviewLoaLetter returns a review payload -- header, items, pricingShape, flags, needsReview', () => {
    const payload = reviewLoaLetter(loadLetter('PL270-CRB').text);
    expect(Object.keys(payload).sort()).toEqual(
      ['flags', 'header', 'items', 'needsReview', 'pricingShape'].sort(),
    );
    expect(Array.isArray(payload.items)).toBe(true);
    expect(Array.isArray(payload.flags)).toBe(true);
    expect(typeof payload.needsReview.total).toBe('number');
    expect(typeof payload.header).toBe('object');
    expect(typeof payload.pricingShape).toBe('object');
  });

  it("the package's public API (src/index.ts) exports no function that writes a work, a schedule, or a work_item", () => {
    const entryPath = path.join(SRC_DIR, 'index.ts');
    const source = readFileSync(entryPath, 'utf8');
    // Every exported function/const NAME this package's public surface
    // declares (export { name, ... } from '...', export function name, and
    // export const name =).
    const exportedNames: string[] = [];
    const namedExportBlockRe = /export\s*\{([^}]*)\}\s*from/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = namedExportBlockRe.exec(source)) !== null) {
      const names = (blockMatch[1] ?? '')
        .split(',')
        .map(
          (n) =>
            n
              .replace(/^type\s+/, '')
              .trim()
              .split(/\s+as\s+/)[0],
        )
        .filter((n): n is string => n !== undefined && n.length > 0);
      exportedNames.push(...names);
    }
    const directExportRe = /export\s+(?:function|const)\s+([A-Za-z0-9_]+)/g;
    let directMatch: RegExpExecArray | null;
    while ((directMatch = directExportRe.exec(source)) !== null) {
      const name = directMatch[1];
      if (name !== undefined) {
        exportedNames.push(name);
      }
    }
    expect(exportedNames.length).toBeGreaterThan(0);

    // A "work-writing" name: mentions "work" (or "schedule"/"item" in the
    // persistence sense) alongside a write verb. None of this package's
    // exports may match -- it is a pure, read-only extraction library
    // (module doc, packages/loa/src/index.ts).
    const writeVerbRe = /(write|create|persist|save|commit|insert|update|delete)/i;
    const workNounRe = /(work|challan)/i;
    const offenders = exportedNames.filter(
      (name) => writeVerbRe.test(name) && workNounRe.test(name),
    );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// purity: this module stays free of @auto-mb/db and @auto-mb/api
// ---------------------------------------------------------------------------

describe('needs-review.ts purity', () => {
  it('imports nothing from @auto-mb/db or @auto-mb/api -- source-scan proof (n2 pattern; corpus-manifest.test.ts / pricing-shape.test.ts precedent)', () => {
    const sourcePath = path.join(SRC_DIR, 'needs-review.ts');
    const source = readFileSync(sourcePath, 'utf8');
    const importRe =
      /(?:import|export)(?:\s+type)?(?:[\s\w{},*]+from)?\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    const specs: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec !== undefined) {
        specs.push(spec);
      }
    }
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.startsWith('@auto-mb/db')).toBe(false);
      expect(spec.startsWith('@auto-mb/api')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// whole-corpus smoke: reviewLoaLetter never throws, and the six letters'
// totals match the empirically-measured baseline exactly
// ---------------------------------------------------------------------------

describe('reviewLoaLetter over the whole corpus', () => {
  it("never throws, and every letter's flag count/byCode matches the measured baseline exactly", () => {
    const expected: Record<string, { total: number; byCode: Record<string, number> }> =
      {
        'PL273-JHS': {
          total: 5,
          byCode: { prose_corrigendum: 1, prose_qty_decomposition: 4 },
        },
        'PL280-ADI': {
          total: 8,
          byCode: { prose_corrigendum: 1, prose_unit_correction: 7 },
        },
        'PL275-BKN': {
          total: 44,
          byCode: {
            prose_corrigendum: 1,
            prose_payment_terms: 42,
            layout_junk: 1,
          },
        },
        'PL276-GTL': { total: 1, byCode: { unresolved_unit: 1 } },
        'PL270-CRB': { total: 0, byCode: {} },
        'PL281-BB': { total: 1, byCode: { banned_items_block: 1 } },
      };

    for (const { manifest, text } of loadCorpus()) {
      const exp = expected[manifest.id];
      expect(exp, `unexpected letter id ${manifest.id}`).toBeDefined();
      const payload = reviewLoaLetter(text);
      expect(payload.needsReview.total, `${manifest.id}: total`).toBe(exp?.total);
      expect(payload.needsReview.byCode, `${manifest.id}: byCode`).toEqual(exp?.byCode);
    }
  });
});
