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
 * legacy ticket DC-26 â€” the `needsReview` trigger set: six proven traps, plus
 * the "Additional required behaviour" defensive branches (Item Breakup /
 * Rebate / Above Par / Banned-items). Input contract:
 * docs/reference/loa-parser-contract.md Â§4 (traps) and Â§5 (unexercised
 * branches). verify: `pnpm --filter @auto-mb/loa-parser --fail-if-no-match test
 * needs-review` (a filename-substring filter on `vitest run`, matching only
 * this file â€” every DC-26 assertion lives here so that verify line
 * exercises all of them).
 *
 * Per the ticket's own charter, every trigger the real corpus proves is
 * tested against `loadCorpus()`/`loadLetter()` output, never a synthetic
 * sample where the corpus contains the case. Triggers the corpus does NOT
 * exercise (item-code namespace mismatch; the numeric-column half of layout
 * junk; the Item Breakup / Rebate / Above Par defensive branches) are
 * proved by a targeted, in-memory, single-token mutation of a REAL fixture's
 * text â€” the fixture FILE itself is never touched (corpus-manifest.test.ts's
 * sha256 guard would go red on that) â€” mirroring the precedent
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
// criterion 1 â€” prose corrigenda that contradict the table
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
// criterion 2 â€” quantity decomposed in prose, not columns
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
// criterion 3 â€” payment terms embedded in description prose
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
// criterion 4 â€” dirty unit vocabulary
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
   ãÎy¶‰žËkºwµç@€€•áÁ•Ð¡É•ÍÕ±Ð¹É•‰…Ñ•=¹Q½Ñ…±Y…±Õ”¤¹Ñ½	” Ô¤ì((€€€€€½¹ÍÐ™±…Ì€ô‘•Ñ•ÑU¹•áÁ•Ñ•‘I•‰…Ñ”¡É•ÍÕ±Ð°€A0ÈÜÌµ)!Lœ¤ì(€€€€€•áÁ•Ð¡™±…Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€€€•áÁ•Ð¡™±…ÍlÁtü¹½‘”¤¹Ñ½	” Õ¹•áÁ•Ñ•‘}É•‰…Ñ”œ¤ì(€€€€€•áÁ•Ð¡™±…ÍlÁtü¹Í½Á”¤¹Ñ½	” ±•ÑÑ•Èœ¤ì(€€€ô¤ì(€ô¤ì((€‘•ÍÉ¥‰” ¥Ñ•´µÉ½Ü€‰‰½Ù”A…Èˆè¹•Ù•È½‰Í•ÉÙ•€ ÈàÄ¼ÈàÄÉ•…€‰ÐA…Èˆ¤œ°€ ¤€ôøì(€€€¥Ð é•É¼¥Ñ•µÌ¥¸Ñ¡”É•…°½ÉÁÕÌ…ÉÉäÑ¡¥ÌÑ½­•¸€´´¹¼™±…Ì…¹åÝ¡•É”œ°€ ¤€ôøì(€€€€€½¹ÍÐ…±±±…Ì€ô±½…‘½ÉÁÕÌ ¤¹™±…Ñ5…À ¡ìÑ•áÐô¤€ôø(€€€€€€€‘•Ñ•ÑU¹•áÁ•Ñ•‘‰½Ù•A…È¡Á…ÉÍ•%Ñ•µÌ¡Ñ•áÐ¤¤°(€€€€€€¤ì(€€€€€•áÁ•Ð¡…±±±…Ì¤¹Ñ½!…Ù•1•¹Ñ  À¤ì(€€€ô¤ì((€€€¥Ð µÕÑ…Ñ¥¹œ„É•…°…¹¡½È±¥¹•pÌ€‰ÐA…ÈˆÑ¼€‰‰½Ù”A…Èˆ€¡¥¸µµ•µ½Éä½¹±ä¤É…¥Í•ÌÑ¡”™±…œ™½ÈÑ¡…Ð¥Ñ•´œ°€ ¤€ôøì(€€€€€½¹ÍÐ½É¥¥¹…°€ô±½…‘1•ÑÑ•È A0ÈÜÌµ)!Lœ¤¹Ñ•áÐì(€€€€€½¹ÍÐ±¥¹•Ì€ô½É¥¥¹…°¹ÍÁ±¥Ð q¸œ¤ì(€€€€€½¹ÍÐÑ…É•Ñ%‘à€ô±¥¹•Ì¹™¥¹‘%¹‘•à (€€€€€€€€¡°¤€ôø°¹¥¹±Õ‘•Ì œàÄØ¸ÀÈœ¤€˜˜°¹¥¹±Õ‘•Ì ÐA…Èœ¤°(€€€€€€¤ì(€€€€€•áÁ•Ð¡Ñ…É•Ñ%‘à¤¹Ñ½	•É•…Ñ•ÉQ¡…¹=ÉÅÕ…° À¤ì(€€€€€½¹ÍÐ½É¥¥¹…±1¥¹”€ô±¥¹•ÍmÑ…É•Ñ%‘át…ÌÍÑÉ¥¹œì(€€€€€½¹ÍÐµÕÑ…Ñ•‘1¥¹”€ô½É¥¥¹…±1¥¹”¹É•Á±…” ÐA…Èœ°€‰½Ù”A…Èœ¤ì(€€€€€•áÁ•Ð¡µÕÑ…Ñ•‘1¥¹”¤¹¹½Ð¹Ñ½	”¡½É¥¥¹…±1¥¹”¤ì(€€€€€½¹ÍÐµÕÑ…Ñ•€ôl(€€€€€€€€¸¸¹±¥¹•Ì¹Í±¥” À°Ñ…É•Ñ%‘à¤°(€€€€€€€µÕÑ…Ñ•‘1¥¹”°(€€€€€€€€¸¸¹±¥¹•Ì¹Í±¥”¡Ñ…É•Ñ%‘à€¬€Ä¤°(€€€€€t¹©½¥¸ q¸œ¤ì((€€€€€½¹ÍÐ¥Ñ•µÌ€ôÁ…ÉÍ•%Ñ•µÌ¡µÕÑ…Ñ•¤ì(€€€€€•áÁ•Ð¡¥Ñ•µÌ¤¹Ñ½!…Ù•1•¹Ñ  Ð¤ì€¼¼ÍÑ¥±°€Ð…¹¡½ÉÌ€´´Ñ½­•¸ÍÝ…À°¹½Ð„¹•Ü½‘É½ÁÁ•…¹¡½È(€€€€€½¹ÍÐ™±…Ì€ô‘•Ñ•ÑU¹•áÁ•Ñ•‘‰½Ù•A…È¡¥Ñ•µÌ¤ì(€€€€€•áÁ•Ð¡™±…Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€€€•áÁ•Ð¡™±…ÍlÁtü¹½‘”¤¹Ñ½	” Õ¹•áÁ•Ñ•‘}…‰½Ù•}Á…Èœ¤ì(€€€€€•áÁ•Ð¡™±…ÍlÁtü¹Í½Á”¤¹Ñ½	” ¥Ñ•´œ¤ì(€€€€€•áÁ•Ð¡™±…ÍlÁtü¹Ñ…É•Ñ%¤¹Ñ½	” ŒÄœ¤ì(€€€ô¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼€‰‘‘¥Ñ¥½¹…°É•ÅÕ¥É•‰•¡…Ù¥½ÕÈˆƒŠP	…¹¹•µ¥Ñ•µÌ‰±½¬°‰½Ñ ÍÁ•±±¥¹Ì(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” 	…¹¹•µ¥Ñ•µÌ‰±½¬è‰½Ñ ÍÁ•±±¥¹ÌÉ•½¹¥Í•……¥¹ÍÐÑ¡”É•…°½ÉÁÕÌ€¡É•Í•…É ƒ
œÔ°¹¼±½¹•ÈÕ¹•á•É¥Í•¤œ°€ ¤€ôøì(€¥Ð A0ÈàÁpÌ€‰	…¹¹•€èˆÍÁ•±±¥¹œ¥ÌÉ•½¹¥Í•‰ÕÐ¥ÑÌ½¹Ñ•¹Ð¥Ì9%0€´´¹½Ð™±…•œ°€ ¤€ôøì(€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È A0ÈàÀµ$œ¤ì(€€€½¹ÍÐ‘•Ñ•Ñ¥½¸€ô‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	±½¬¡Ñ•áÐ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹ÍÁ•±±¥¹œ¤¹Ñ½	” ½±½¸œ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹Á½ÁÕ±…Ñ•¤¹Ñ½	”¡™…±Í”¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹É…Ý	±½¬¤¹Ñ½½¹Ñ…¥¸ 9%0œ¤ì((€€€½¹ÍÐ™±…Ì€ô‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	É…¹ ¡Ñ•áÐ°€A0ÈàÀµ$œ¤ì(€€€•áÁ•Ð¡™±…Ì¤¹Ñ½!…Ù•1•¹Ñ  À¤ì(€ô¤ì((€¥Ð A0ÈàÅpÌ€‰	…¹¹•¥Ñ•´èˆÍÁ•±±¥¹œ¥ÌÉ•½¹¥Í•°Á½ÁÕ±…Ñ•°…¹™±…•°ÁÉ•Í•ÉÙ¥¹œÑ¡”±•ÑÑ•ÉpÌ½Ý¸€‰‰…¹••ˆÑåÁ¼Ù•É‰…Ñ¥´œ°€ ¤€ôøì(€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È A0ÈàÄµ	œ¤ì(€€€½¹ÍÐ‘•Ñ•Ñ¥½¸€ô‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	±½¬¡Ñ•áÐ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸¤¹¹½Ð¹Ñ½	•9Õ±° ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹ÍÁ•±±¥¹œ¤¹Ñ½	” ¥Ñ•´œ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹Á½ÁÕ±…Ñ•¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹É…Ý	±½¬¤¹Ñ½½¹Ñ…¥¸ ‰…¹••œ¤ì(€€€•áÁ•Ð¡‘•Ñ•Ñ¥½¸ü¹É…Ý	±½¬¤¹Ñ½½¹Ñ…¥¸ ¥Ñ•´¹¼€È°Ø°à°ÄØ°ÄÜ°Äàœ¤ì((€€€½¹ÍÐ™±…Ì€ô‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	É…¹ ¡Ñ•áÐ°€A0ÈàÄµ	œ¤ì(€€€•áÁ•Ð¡™±…Ì¤¹Ñ½!…Ù•1•¹Ñ  Ä¤ì(€€€•áÁ•Ð¡™±…ÍlÁtü¹½‘”¤¹Ñ½	” ‰…¹¹•‘}¥Ñ•µÍ}‰±½¬œ¤ì(€€€•áÁ•Ð¡™±…ÍlÁtü¹Í½Á”¤¹Ñ½	” ±•ÑÑ•Èœ¤ì(€€€•áÁ•Ð¡™±…ÍlÁtü¹É…Ý	±½¬¤¹Ñ½½¹Ñ…¥¸ ‰…¹••œ¤ì(€ô¤ì((€¥Ð ¹¼½Ñ¡•È±•ÑÑ•È¥¸Ñ¡”½ÉÁÕÌ…ÉÉ¥•Ì•¥Ñ¡•ÈÍÁ•±±¥¹œœ°€ ¤€ôøì(€€€™½È€¡½¹ÍÐ¥½˜11}=IAUM}%L¤ì(€€€€€¥˜€¡¥€ôôô€A0ÈàÀµ$œñð¥€ôôô€A0ÈàÄµ	œ¤ì(€€€€€€€½¹Ñ¥¹Õ”ì(€€€€€ô(€€€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È¡¥¤ì(€€€€€•áÁ•Ð (€€€€€€€‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	±½¬¡Ñ•áÐ¤°(€€€€€€€€‘í¥‘ôè•áÁ•Ñ•¹¼	…¹¹•µ‰±½¬‘•Ñ•Ñ¥½¹€°(€€€€€€¤¹Ñ½	•9Õ±° ¤ì(€€€ô(€ô¤ì((€€¼¼9•…Ñ¥Ù”µÁÉ½½˜Í…™™½±‘¥¹œ™½È‰½Ñ ÍÁ•±±¥¹œ…ÉµÌ€¡´ÈØ½€¡Œ¤¤è(€€¼¼‘¥Í…‰±¥¹œ%Q!H½˜¹••‘ÌµÉ•Ù¥•Ü¹ÑÌÌÑÝ¼É••á•Ì(€€¼¼€¡	99}%Q5}1	1}I€¼	99}=1=9}1	1}I¤ÑÕÉ¹Ì•á…Ñ±ä½¹”½˜Ñ¡”(€€¼¼ÑÝ¼Ñ•ÍÑÌ…‰½Ù”É•€¡A0ÈàÄÌÁ½ÁÕ±…Ñ•µ…¹µ™±…•…ÍÍ•ÉÑ¥½¸°½È(€€¼¼A0ÈàÀÌÉ•½¹¥Í•µ‰ÕÐµ9%0…ÍÍ•ÉÑ¥½¸¤€´´Ù•É¥™¥•‰ä¡…¹‘ÕÉ¥¹œ(€€¼¼¥µÁ±•µ•¹Ñ…Ñ¥½¸€¡Í•”Ñ¡”Ñ¥­•ÐÉ•Á½ÉÐ¤°É•Ù•ÉÑ•‰•™½É”½µµ¥Ðì¹½Ð(€€¼¼É”µ•¹½‘•…Ì„Á•Éµ…¹•¹ÐµÕÑ…Ñ¥½¸Ñ•ÍÐ¡•É”‰•…ÕÍ”Ñ¡…ÐÝ½Õ±É•ÅÕ¥É”(€€¼¼Ñ¡¥ÌÑ•ÍÐ™¥±”Ñ¼¥µÁ½ÉÐ…¹µ½¹­•åÁ…Ñ ¹••‘ÌµÉ•Ù¥•Ü¹ÑÌÌÁÉ¥Ù…Ñ”(€€¼¼É••á•Ì°Ý¡¥ Ñ¡”µ½‘Õ±”‘•±¥‰•É…Ñ•±ä‘½•Ì¹½Ð•áÁ½ÉÐ¸(€¥Ð ‰Ñ¡”ÑÝ¼ÍÁ•±±¥¹œÉ••á•Ì…É”µÕÑÕ…±±ä•á±ÕÍ¥Ù”è¹•¥Ñ¡•Èµ…Ñ¡•ÌÑ¡”½Ñ¡•ÈÌ±…‰•°Ñ•áÐ€¡Ù•É¥™¥•‰½Ñ ‘¥É•Ñ¥½¹Ì°¹½Ð…ÍÍÕµ•¤ˆ°€ ¤€ôøì(€€€½¹ÍÐ‰…¹¹•‘%Ñ•µ1…‰•°€ô€½	…¹¹•‘qÌ­¥Ñ•µqÌ¨è½¤ì(€€€½¹ÍÐ‰…¹¹•‘½±½¹1…‰•°€ô€½	…¹¹•‘qÌ¨è½¤ì(€€€€¼¼qÌ¨½¹±ä•Ù•È½¹ÍÕµ•Ì]!%QMA€´´¥Ð…¸¹•Ù•ÈÍ­¥À½Ù•ÈÑ¡”(€€€€¼¼±¥Ñ•É…°Ý½É€‰¥Ñ•´ˆ°Í¼Ñ¡”½±½¸µ…É´É••àÉ•ÅÕ¥É•Ì€ˆèˆÑ¼™½±±½Ü(€€€€¼¼€‰	…¹¹•ˆÝ¥Ñ ¹½Ñ¡¥¹œ‰ÕÐÝ¡¥Ñ•ÍÁ…”‰•ÑÝ••¸°Ý¡¥ €‰	…¹¹•¥Ñ•´èˆ(€€€€¼¼‘½•Ì¹½ÐÍ…Ñ¥Í™ä•¥Ñ¡•È¸(€€€•áÁ•Ð¡‰…¹¹•‘%Ñ•µ1…‰•°¹Ñ•ÍÐ 	…¹¹•€èI…Ñ•Ì½˜Ñ¡”™½±±½Ý¥¹œ¥Ñ•µÌœ¤¤¹Ñ½	”¡™…±Í”¤ì(€€€•áÁ•Ð¡‰…¹¹•‘½±½¹1…‰•°¹Ñ•ÍÐ 	…¹¹•¥Ñ•´èI…Ñ•Ì½˜¥Ñ•´¹¼€È°Ø°àœ¤¤¹Ñ½	”¡™…±Í”¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼¹••‘ÍI•Ù¥•ÜÉ½±°µÕÀ(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ¹••‘ÍI•Ù¥•ÜÉ½±°µÕÀèÑ½Ñ…°°½Õ¹ÑÌ‰ä½‘”°…¹äµ±•ÑÑ•Èµ±•Ù•°œ°€ ¤€ôøì(€¥Ð A0ÈàÀè€àÑ½Ñ…°™±…Ì€ Ä±•ÑÑ•Èµ±•Ù•°½ÉÉ¥•¹‘Õ´€¬€Ü¥Ñ•´µ±•Ù•°Õ¹¥Ð½ÉÉ•Ñ¥½¹Ì¤°…¹å1•ÑÑ•É1•Ù•°ÑÉÕ”œ°€ ¤€ôøì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡±½…‘1•ÑÑ•È A0ÈàÀµ$œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	”¡Á…å±½…¹™±…Ì¹±•¹Ñ ¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	” à¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹‰å½‘”¤¹Ñ½ÅÕ…°¡ì(€€€€€ÁÉ½Í•}½ÉÉ¥•¹‘Õ´è€Ä°(€€€€€ÁÉ½Í•}Õ¹¥Ñ}½ÉÉ•Ñ¥½¸è€Ü°(€€€ô¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹…¹å1•ÑÑ•É1•Ù•°¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì((€¥Ð ‰A0ÈÜÀèé•É¼™±…Ì°…¹å1•ÑÑ•É1•Ù•°™…±Í”€´´Ñ¡”½ÉÁÕÌÌ½¹”•¹Ñ¥É•±ä±•…¸±•ÑÑ•ÈÕ¹‘•ÈÑ¡¥ÌÑÉ¥•ÈÍ•Ðˆ°€ ¤€ôøì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡±½…‘1•ÑÑ•È A0ÈÜÀµIœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	” À¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹‰å½‘”¤¹Ñ½ÅÕ…°¡íô¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹…¹å1•ÑÑ•É1•Ù•°¤¹Ñ½	”¡™…±Í”¤ì(€ô¤ì((€¥Ð A0ÈÜØè•á…Ñ±ä€Ä™±…œ€¡Ñ¡”I-4Õ¹É•Í½±Ù•µÕ¹¥Ð¥Ñ•´¤°…¹å1•ÑÑ•É1•Ù•°™…±Í”€¡…¸¥Ñ•´µ±•Ù•°µ½¹±ä™±…œ¤œ°€ ¤€ôøì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡±½…‘1•ÑÑ•È A0ÈÜØµQ0œ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	” Ä¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹‰å½‘”¤¹Ñ½ÅÕ…°¡ìÕ¹É•Í½±Ù•‘}Õ¹¥Ðè€Äô¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹…¹å1•ÑÑ•É1•Ù•°¤¹Ñ½	”¡™…±Í”¤ì(€ô¤ì((€¥Ð ‰å½‘”…±Ý…åÌÍÕµÌÑ¼Ñ½Ñ…°°…¹Ñ½Ñ…°…±Ý…åÌ•ÅÕ…±Ì™±…Ì¹±•¹Ñ °…É½ÍÌÑ¡”Ý¡½±”½ÉÁÕÌœ°€ ¤€ôøì(€€€™½È€¡½¹ÍÐìÑ•áÐô½˜±½…‘½ÉÁÕÌ ¤¤ì(€€€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡Ñ•áÐ¤ì(€€€€€½¹ÍÐÍÕµ=™½‘•Ì€ô=‰©•Ð¹Ù…±Õ•Ì¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹‰å½‘”¤¹É•‘Õ” (€€€€€€€€¡„°ˆ¤€ôø„€¬ˆ°(€€€€€€€€À°(€€€€€€¤ì(€€€€€•áÁ•Ð¡ÍÕµ=™½‘•Ì¤¹Ñ½	”¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤ì(€€€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	”¡Á…å±½…¹™±…Ì¹±•¹Ñ ¤ì(€€€ô(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼™±…Ì…É”…‘‘¥Ñ¥Ù”è¹•Ù•ÈÉ•Á±…”Á…ÉÍ•‘…Ñ„°¹•Ù•È‘É½À„™¥•±(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ™±…Ì…É”…‘‘¥Ñ¥Ù”€´´Á…ÉÍ•‘…Ñ„¥Ì¹•Ù•ÈÉ•Á±…•½È‘É½ÁÁ•œ°€ ¤€ôøì(€¥Ð É•Ù¥•Ý1½…1•ÑÑ•È¹•Ù•È‘É½ÁÌ…¸¥Ñ•´è¥Ñ•´½Õ¹Ðµ…Ñ¡•ÌÁ…ÉÍ•%Ñ•µÌ ¤•á…Ñ±ä°Á•È±•ÑÑ•Èœ°€ ¤€ôøì(€€€™½È€¡½¹ÍÐìµ…¹¥™•ÍÐ°Ñ•áÐô½˜±½…‘½ÉÁÕÌ ¤¤ì(€€€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡Ñ•áÐ¤ì(€€€€€•áÁ•Ð¡Á…å±½…¹¥Ñ•µÌ¹±•¹Ñ °€‘íµ…¹¥™•ÍÐ¹¥‘ôè¥Ñ•´½Õ¹Ñ€¤¹Ñ½	” (€€€€€€€µ…¹¥™•ÍÐ¹¥Ñ•µ}½Õ¹Ð°(€€€€€€¤ì(€€€ô(€ô¤ì((€¥Ð •Ù•Éä™±…œ…ÉÉ¥•Ì…±°™½ÕÈÉ•ÅÕ¥É•™¥•±‘Ì°Á±ÕÌ„Ý•±°µ™½Éµ•Í½Á”½½‘”œ°€ ¤€ôøì(€€€½¹ÍÐÙ…±¥‘M½Á•Ì€ô¹•ÜM•Ð¡l±•ÑÑ•Èœ°€Í¡•‘Õ±”œ°€¥Ñ•´t¤ì(€€€½¹ÍÐÙ…±¥‘½‘•Ì€ô¹•ÜM•Ð¡l(€€€€€€ÁÉ½Í•}½ÉÉ¥•¹‘Õ´œ°(€€€€€€ÁÉ½Í•}Õ¹¥Ñ}½ÉÉ•Ñ¥½¸œ°(€€€€€€ÁÉ½Í•}ÅÑå}‘•½µÁ½Í¥Ñ¥½¸œ°(€€€€€€ÁÉ½Í•}Á…åµ•¹Ñ}Ñ•ÉµÌœ°(€€€€€€Õ¹É•Í½±Ù•‘}Õ¹¥Ðœ°(€€€€€€¥Ñ•µ}½‘•}¹…µ•ÍÁ…•}µ¥Íµ…Ñ œ°(€€€€€€±…å½ÕÑ}©Õ¹¬œ°(€€€€€€Õ¹•áÁ•Ñ•‘}¥Ñ•µ}‰É•…­ÕÀœ°(€€€€€€Õ¹•áÁ•Ñ•‘}É•‰…Ñ”œ°(€€€€€€Õ¹•áÁ•Ñ•‘}…‰½Ù•}Á…Èœ°(€€€€€€‰…¹¹•‘}¥Ñ•µÍ}‰±½¬œ°(€€€t¤ì(€€€™½È€¡½¹ÍÐìÑ•áÐô½˜±½…‘½ÉÁÕÌ ¤¤ì(€€€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡Ñ•áÐ¤ì(€€€€€™½È€¡½¹ÍÐ™±…œ½˜Á…å±½…¹™±…Ì¤ì(€€€€€€€•áÁ•Ð¡ÑåÁ•½˜™±…œ¹½‘”¤¹Ñ½	” ÍÑÉ¥¹œœ¤ì(€€€€€€€•áÁ•Ð¡Ù…±¥‘½‘•Ì¹¡…Ì¡™±…œ¹½‘”¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€€€€€•áÁ•Ð¡Ù…±¥‘M½Á•Ì¹¡…Ì¡™±…œ¹Í½Á”¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€€€€€•áÁ•Ð¡ÑåÁ•½˜™±…œ¹Ñ…É•Ñ%¤¹Ñ½	” ÍÑÉ¥¹œœ¤ì(€€€€€€€•áÁ•Ð¡ÑåÁ•½˜™±…œ¹É…Ý	±½¬¤¹Ñ½	” ÍÑÉ¥¹œœ¤ì(€€€€€€€•áÁ•Ð¡ÑåÁ•½˜™±…œ¹µ•ÍÍ…”¤¹Ñ½	” ÍÑÉ¥¹œœ¤ì(€€€€€€€•áÁ•Ð¡™±…œ¹µ•ÍÍ…”¹±•¹Ñ ¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ À¤ì(€€€€€ô(€€€ô(€ô¤ì((€¥Ð ‰A0ÈàÀÌ½ÉÉ¥•¹‘Õ´µ™±…•¥Ñ•µÌÍÑ¥±°…ÉÉäÑ¡•¥ÈÉ•…°ÁÉ¥¹Ñ•Õ¹¥ÑI…Ñ”½‰¥‘µ½Õ¹Ð½É•½¹¥±¥…Ñ¥½¸€´´Ñ¡”™±…œ…‘‘Ì‘•Ñ…¥°°¥Ð¹•Ù•È½Ù•ÉÝÉ¥Ñ•Ì„™¥•±ˆ°€ ¤€ôøì(€€€½¹ÍÐìÑ•áÐô€ô±½…‘1•ÑÑ•È A0ÈàÀµ$œ¤ì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡Ñ•áÐ¤ì(€€€½¹ÍÐ¥Ñ•´Ä€ôÁ…å±½…¹¥Ñ•µÌ¹™¥¹ (€€€€€€¡¥Ð¤€ôø¥Ð¹Í¡•‘Õ±”ü¹¥€ôôô€œ€˜˜¥Ð¹¥Ñ•µM¹¼€ôôô€œÀÄœ°(€€€€¤ì(€€€•áÁ•Ð¡¥Ñ•´Ä¤¹Ñ½	••™¥¹• ¤ì(€€€•áÁ•Ð¡¥Ñ•´Äü¹‰¥‘µ½Õ¹Ð¤¹Ñ½	” œÄÌäÜÐØÌ¸ÌØœ¤ì(€€€•áÁ•Ð¡¥Ñ•´Äü¹É•½¹¥±¥…Ñ¥½¸¹½¬¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð (€€€€€Á…å±½…¹™±…Ì¹Í½µ” (€€€€€€€€¡˜¤€ôø˜¹½‘”€ôôô€ÁÉ½Í•}Õ¹¥Ñ}½ÉÉ•Ñ¥½¸œ€˜˜˜¹Ñ…É•Ñ%€ôôô€ŒÀÄœ°(€€€€€€¤°(€€€€¤¹Ñ½	”¡ÑÉÕ”¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼¹•Ù•È…ÕÑ¼µ½µµ¥Ð(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ¹•Ù•È…ÕÑ¼µ½µµ¥Ð€¡AI=UPµMAƒ
œÔ¸ÄÍÑ•À€È¤œ°€ ¤€ôøì(€¥Ð É•Ù¥•Ý1½…1•ÑÑ•ÈÉ•ÑÕÉ¹Ì„É•Ù¥•ÜÁ…å±½…€´´¡•…‘•È°¥Ñ•µÌ°ÁÉ¥¥¹M¡…Á”°™±…Ì°¹••‘ÍI•Ù¥•Üœ°€ ¤€ôøì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡±½…‘1•ÑÑ•È A0ÈÜÀµIœ¤¹Ñ•áÐ¤ì(€€€•áÁ•Ð¡=‰©•Ð¹­•åÌ¡Á…å±½…¤¹Í½ÉÐ ¤¤¹Ñ½ÅÕ…° (€€€€€l™±…Ìœ°€¡•…‘•Èœ°€¥Ñ•µÌœ°€¹••‘ÍI•Ù¥•Üœ°€ÁÉ¥¥¹M¡…Á”t¹Í½ÉÐ ¤°(€€€€¤ì(€€€•áÁ•Ð¡ÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…¹¥Ñ•µÌ¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡ÉÉ…ä¹¥ÍÉÉ…ä¡Á…å±½…¹™±…Ì¤¤¹Ñ½	”¡ÑÉÕ”¤ì(€€€•áÁ•Ð¡ÑåÁ•½˜Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°¤¹Ñ½	” ¹Õµ‰•Èœ¤ì(€€€•áÁ•Ð¡ÑåÁ•½˜Á…å±½…¹¡•…‘•È¤¹Ñ½	” ½‰©•Ðœ¤ì(€€€•áÁ•Ð¡ÑåÁ•½˜Á…å±½…¹ÁÉ¥¥¹M¡…Á”¤¹Ñ½	” ½‰©•Ðœ¤ì(€ô¤ì((€¥Ð ‰Ñ¡”Á…­…”ÌÁÕ‰±¥ŒA$€¡ÍÉŒ½¥¹‘•à¹ÑÌ¤•áÁ½ÉÑÌ¹¼™Õ¹Ñ¥½¸Ñ¡…ÐÝÉ¥Ñ•Ì„Ý½É¬°„Í¡•‘Õ±”°½È„Ý½É­}¥Ñ•´ˆ°€ ¤€ôøì(€€€½¹ÍÐ•¹ÑÉåA…Ñ €ôÁ…Ñ ¹©½¥¸¡MI}%H°€¥¹‘•à¹ÑÌœ¤ì(€€€½¹ÍÐÍ½ÕÉ”€ôÉ•…‘¥±•Må¹Œ¡•¹ÑÉåA…Ñ °€ÕÑ˜àœ¤ì(€€€€¼¼Ù•Éä•áÁ½ÉÑ•™Õ¹Ñ¥½¸½½¹ÍÐ95Ñ¡¥ÌÁ…­…”ÌÁÕ‰±¥ŒÍÕÉ™…”(€€€€¼¼‘•±…É•Ì€¡•áÁ½ÉÐì¹…µ”°€¸¸¸ô™É½´€œ¸¸¸œ°•áÁ½ÉÐ™Õ¹Ñ¥½¸¹…µ”°…¹(€€€€¼¼•áÁ½ÉÐ½¹ÍÐ¹…µ”€ô¤¸(€€€½¹ÍÐ•áÁ½ÉÑ•‘9…µ•ÌèÍÑÉ¥¹mt€ômtì(€€€½¹ÍÐ¹…µ•‘áÁ½ÉÑ	±½­I”€ô€½•áÁ½ÉÑqÌ©qì¡myõt¨¥qõqÌ©™É½´½œì(€€€±•Ð‰±½­5…Ñ èI•áÁá•ÉÉ…äð¹Õ±°ì(€€€Ý¡¥±”€ ¡‰±½­5…Ñ €ô¹…µ•‘áÁ½ÉÑ	±½­I”¹•á•Œ¡Í½ÕÉ”¤¤€„ôô¹Õ±°¤ì(€€€€€½¹ÍÐ¹…µ•Ì€ô€¡‰±½­5…Ñ¡lÅt€üü€œœ¤(€€€€€€€€¹ÍÁ±¥Ð œ°œ¤(€€€€€€€€¹µ…À (€€€€€€€€€€¡¸¤€ôø(€€€€€€€€€€€¸(€€€€€€€€€€€€€€¹É•Á±…” ½yÑåÁ•qÌ¬¼°€œœ¤(€€€€€€€€€€€€€€¹ÑÉ¥´ ¤(€€€€€€€€€€€€€€¹ÍÁ±¥Ð ½qÌ­…ÍqÌ¬¼¥lÁt°(€€€€€€€€¤(€€€€€€€€¹™¥±Ñ•È ¡¸¤è¸¥ÌÍÑÉ¥¹œ€ôø¸€„ôôÕ¹‘•™¥¹•€˜˜¸¹±•¹Ñ €ø€À¤ì(€€€€€•áÁ½ÉÑ•‘9…µ•Ì¹ÁÕÍ  ¸¸¹¹…µ•Ì¤ì(€€€ô(€€€½¹ÍÐ‘¥É•ÑáÁ½ÉÑI”€ô€½•áÁ½ÉÑqÌ¬ üé™Õ¹Ñ¥½¹ñ½¹ÍÐ¥qÌ¬¡mµi„µèÀ´å}t¬¤½œì(€€€±•Ð‘¥É•Ñ5…Ñ èI•áÁá•ÉÉ…äð¹Õ±°ì(€€€Ý¡¥±”€ ¡‘¥É•Ñ5…Ñ €ô‘¥É•ÑáÁ½ÉÑI”¹•á•Œ¡Í½ÕÉ”¤¤€„ôô¹Õ±°¤ì(€€€€€½¹ÍÐ¹…µ”€ô‘¥É•Ñ5…Ñ¡lÅtì(€€€€€¥˜€¡¹…µ”€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€•áÁ½ÉÑ•‘9…µ•Ì¹ÁÕÍ ¡¹…µ”¤ì(€€€€€ô(€€€ô(€€€•áÁ•Ð¡•áÁ½ÉÑ•‘9…µ•Ì¹±•¹Ñ ¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ À¤ì((€€€€¼¼€‰Ý½É¬µÝÉ¥Ñ¥¹œˆ¹…µ”èµ•¹Ñ¥½¹Ì€‰Ý½É¬ˆ€¡½È€‰Í¡•‘Õ±”ˆ¼‰¥Ñ•´ˆ¥¸Ñ¡”(€€€€¼¼Á•ÉÍ¥ÍÑ•¹”Í•¹Í”¤…±½¹Í¥‘”„ÝÉ¥Ñ”Ù•Éˆ¸9½¹”½˜Ñ¡¥ÌÁ…­…”Ì(€€€€¼¼•áÁ½ÉÑÌµ…äµ…Ñ €´´¥Ð¥Ì„ÁÕÉ”°É•…µ½¹±ä•áÑÉ…Ñ¥½¸±¥‰É…Éä(€€€€¼¼€¡µ½‘Õ±”‘½Œ°ÍÉŒ½¥¹‘•à¹ÑÌ¤¸(€€€½¹ÍÐÝÉ¥Ñ•Y•É‰I”€ô€¼¡ÝÉ¥Ñ•ñÉ•…Ñ•ñÁ•ÉÍ¥ÍÑñÍ…Ù•ñ½µµ¥Ññ¥¹Í•ÉÑñÕÁ‘…Ñ•ñ‘•±•Ñ”¤½¤ì(€€€½¹ÍÐÝ½É­9½Õ¹I”€ô€¼¡Ý½É­ñ¡…±±…¸¤½¤ì(€€€½¹ÍÐ½™™•¹‘•ÉÌ€ô•áÁ½ÉÑ•‘9…µ•Ì¹™¥±Ñ•È (€€€€€€¡¹…µ”¤€ôøÝÉ¥Ñ•Y•É‰I”¹Ñ•ÍÐ¡¹…µ”¤€˜˜Ý½É­9½Õ¹I”¹Ñ•ÍÐ¡¹…µ”¤°(€€€€¤ì(€€€•áÁ•Ð¡½™™•¹‘•ÉÌ¤¹Ñ½ÅÕ…°¡mt¤ì(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼ÁÕÉ¥ÑäèÑ¡¥Ìµ½‘Õ±”ÍÑ…åÌ™É•”½˜•Ù•Éä…ÕÑ¼µµˆ¼¨Ý½É­ÍÁ…”Á…­…”(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” ¹••‘ÌµÉ•Ù¥•Ü¹ÑÌÁÕÉ¥Ñäœ°€ ¤€ôøì(€¥Ð ¥µÁ½ÉÑÌ¹½Ñ¡¥¹œ™É½´…¹ä…ÕÑ¼µµˆ¼¨Á…­…”€´´Í½ÕÉ”µÍ…¸ÁÉ½½˜€¡¸ÈÁ…ÑÑ•É¸ì½ÉÁÕÌµµ…¹¥™•ÍÐ¹Ñ•ÍÐ¹ÑÌ€¼ÁÉ¥¥¹œµÍ¡…Á”¹Ñ•ÍÐ¹ÑÌÁÉ••‘•¹Ð¤œ°€ ¤€ôøì(€€€½¹ÍÐÍ½ÕÉ•A…Ñ €ôÁ…Ñ ¹©½¥¸¡MI}%H°€¹••‘ÌµÉ•Ù¥•Ü¹ÑÌœ¤ì(€€€½¹ÍÐÍ½ÕÉ”€ôÉ•…‘¥±•Må¹Œ¡Í½ÕÉ•A…Ñ °€ÕÑ˜àœ¤ì(€€€½¹ÍÐ¥µÁ½ÉÑI”€ô(€€€€€€¼ üé¥µÁ½ÉÑñ•áÁ½ÉÐ¤ üéqÌ­ÑåÁ”¤ü üémqÍqÝíô°©t­™É½´¤ýqÌ©lˆt¡mxˆt¬¥lˆuñÉ•ÅÕ¥É•qÌ©p¡qÌ©lˆt¡mxˆt¬¥lˆuqÌ©p¥ñ¥µÁ½ÉÑqÌ©p¡qÌ©lˆt¡mxˆt¬¥lˆuqÌ©p¤½œì(€€€½¹ÍÐÍÁ•ÌèÍÑÉ¥¹mt€ômtì(€€€±•Ðµ…Ñ èI•áÁá•ÉÉ…äð¹Õ±°ì(€€€Ý¡¥±”€ ¡µ…Ñ €ô¥µÁ½ÉÑI”¹•á•Œ¡Í½ÕÉ”¤¤€„ôô¹Õ±°¤ì(€€€€€½¹ÍÐÍÁ•Œ€ôµ…Ñ¡lÅt€üüµ…Ñ¡lÉt€üüµ…Ñ¡lÍtì(€€€€€¥˜€¡ÍÁ•Œ€„ôôÕ¹‘•™¥¹•¤ì(€€€€€€€ÍÁ•Ì¹ÁÕÍ ¡ÍÁ•Œ¤ì(€€€€€ô(€€€ô(€€€•áÁ•Ð¡ÍÁ•Ì¹±•¹Ñ ¤¹Ñ½	•É•…Ñ•ÉQ¡…¸ À¤ì(€€€™½È€¡½¹ÍÐÍÁ•Œ½˜ÍÁ•Ì¤ì(€€€€€•áÁ•Ð¡ÍÁ•Œ¹ÍÑ…ÉÑÍ]¥Ñ  …ÕÑ¼µµˆ½‘ˆœ¤¤¹Ñ½	”¡™…±Í”¤ì(€€€€€•áÁ•Ð¡ÍÁ•Œ¹ÍÑ…ÉÑÍ]¥Ñ  …ÕÑ¼µµˆ½…Á¤œ¤¤¹Ñ½	”¡™…±Í”¤ì(€€€ô(€ô¤ì)ô¤ì((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼Ý¡½±”µ½ÉÁÕÌÍµ½­”èÉ•Ù¥•Ý1½…1•ÑÑ•È¹•Ù•ÈÑ¡É½ÝÌ°…¹Ñ¡”Í¥à±•ÑÑ•ÉÌœ(¼¼Ñ½Ñ…±Ìµ…Ñ Ñ¡”•µÁ¥É¥…±±äµµ•…ÍÕÉ•‰…Í•±¥¹”•á…Ñ±ä(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()‘•ÍÉ¥‰” É•Ù¥•Ý1½…1•ÑÑ•È½Ù•ÈÑ¡”Ý¡½±”½ÉÁÕÌœ°€ ¤€ôøì(€¥Ð ­••ÁÌA0ÈàÄ…Ð¥ÑÌ½¹”•¹Õ¥¹”É•Ù¥•Ü™±…œÝ¡•¸Á‘™Ñ½Ñ•áÐ•µ¥ÑÌI1œ°€ ¤€ôøì(€€€½¹ÍÐÉ±˜€ô±½…‘1•ÑÑ•È A0ÈàÄµ	œ¤¹Ñ•áÐ¹É•Á±…” ½q¸½œ°€qÉq¸œ¤ì(€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡É±˜¤ì((€€€•áÁ•Ð¡Á…å±½…¹¥Ñ•µÌ¤¹Ñ½!…Ù•1•¹Ñ  ÔÐ¤ì(€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¤¹Ñ½5…Ñ¡=‰©•Ð¡ì(€€€€€Ñ½Ñ…°è€Ä°(€€€€€‰å½‘”èì‰…¹¹•‘}¥Ñ•µÍ}‰±½¬è€Äô°(€€€ô¤ì(€ô¤ì((€¥Ð ‰¹•Ù•ÈÑ¡É½ÝÌ°…¹•Ù•Éä±•ÑÑ•ÈÌ™±…œ½Õ¹Ð½‰å½‘”µ…Ñ¡•ÌÑ¡”µ•…ÍÕÉ•‰…Í•±¥¹”•á…Ñ±äˆ°€ ¤€ôøì(€€€½¹ÍÐ•áÁ•Ñ•èI•½ÉñÍÑÉ¥¹œ°ìÑ½Ñ…°è¹Õµ‰•Èì‰å½‘”èI•½ÉñÍÑÉ¥¹œ°¹Õµ‰•Èøôø€ô(€€€€€ì(€€€€€€€€A0ÈÜÌµ)!Lœèì(€€€€€€€€€Ñ½Ñ…°è€Ô°(€€€€€€€€€‰å½‘”èìÁÉ½Í•}½ÉÉ¥•¹‘Õ´è€Ä°ÁÉ½Í•}ÅÑå}‘•½µÁ½Í¥Ñ¥½¸è€Ðô°(€€€€€€€ô°(€€€€€€€€A0ÈàÀµ$œèì(€€€€€€€€€Ñ½Ñ…°è€à°(€€€€€€€€€‰å½‘”èìÁÉ½Í•}½ÉÉ¥•¹‘Õ´è€Ä°ÁÉ½Í•}Õ¹¥Ñ}½ÉÉ•Ñ¥½¸è€Üô°(€€€€€€€ô°(€€€€€€€€A0ÈÜÔµ	-8œèì(€€€€€€€€€Ñ½Ñ…°è€ÐÐ°(€€€€€€€€€‰å½‘”èì(€€€€€€€€€€€ÁÉ½Í•}½ÉÉ¥•¹‘Õ´è€Ä°(€€€€€€€€€€€ÁÉ½Í•}Á…åµ•¹Ñ}Ñ•ÉµÌè€ÐÈ°(€€€€€€€€€€€±…å½ÕÑ}©Õ¹¬è€Ä°(€€€€€€€€€ô°(€€€€€€€ô°(€€€€€€€€A0ÈÜØµQ0œèìÑ½Ñ…°è€Ä°‰å½‘”èìÕ¹É•Í½±Ù•‘}Õ¹¥Ðè€Äôô°(€€€€€€€€A0ÈÜÀµIœèìÑ½Ñ…°è€À°‰å½‘”èíôô°(€€€€€€€€A0ÈàÄµ	œèìÑ½Ñ…°è€Ä°‰å½‘”èì‰…¹¹•‘}¥Ñ•µÍ}‰±½¬è€Äôô°(€€€€€ôì((€€€™½È€¡½¹ÍÐìµ…¹¥™•ÍÐ°Ñ•áÐô½˜±½…‘½ÉÁÕÌ ¤¤ì(€€€€€½¹ÍÐ•áÀ€ô•áÁ•Ñ•‘mµ…¹¥™•ÍÐ¹¥‘tì(€€€€€•áÁ•Ð¡•áÀ°Õ¹•áÁ•Ñ•±•ÑÑ•È¥€‘íµ…¹¥™•ÍÐ¹¥‘õ€¤¹Ñ½	••™¥¹• ¤ì(€€€€€½¹ÍÐÁ…å±½…€ôÉ•Ù¥•Ý1½…1•ÑÑ•È¡Ñ•áÐ¤ì(€€€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹Ñ½Ñ…°°€‘íµ…¹¥™•ÍÐ¹¥‘ôèÑ½Ñ…±€¤¹Ñ½	”¡•áÀü¹Ñ½Ñ…°¤ì(€€€€€•áÁ•Ð¡Á…å±½…¹¹••‘ÍI•Ù¥•Ü¹‰å½‘”°€‘íµ…¹¥™•ÍÐ¹¥‘ôè‰å½‘•€¤¹Ñ½ÅÕ…°¡•áÀü¹‰å½‘”¤ì(€€€ô(€ô¤ì)ô¤ì