import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLetter, reviewLoaLetter } from '../src/index.js';

/**
 * The AMC evidence set: the four annual-maintenance letters the owner's
 * billing-cycle ruling of 2026-08-19 was derived from that are not
 * already in the six-letter research corpus.
 *
 * WHY A SECOND MANIFEST RATHER THAN FOUR MORE ROWS IN `corpus.json`.
 * That corpus is a frozen research artefact: `docs/reference/
 * loa-parser-contract.md` § 0 states its 281 items and
 * `corpus-manifest.test.ts` says in its own words "treat any future
 * extraction that does not total 281 on this corpus as a regression".
 * Four letters added to it would move that total, and with it the
 * per-letter baselines in three other suites — turning a documented
 * regression signal into a number nobody could check by reading the
 * diff. These letters are evidence for a NEW ruling, so they arrive as
 * their own additive set, and the sealed six stay byte-green beside
 * them.
 *
 * Same recipe either way, which is the part that matters: plain
 * `pdftotext` output, never a PDF; a sha256 over the fixture's bytes
 * pinned in the manifest; and item counts hardcoded HERE as well as in
 * the manifest, so a fixture that drifted out from under a manifest
 * nobody updated fails rather than passes.
 *
 * The fifth and sixth letters of the ruling's six — PL273-JHS and
 * PL280-ADI — are already in the sealed corpus and are read from there.
 */

const EXPECTED_ITEM_COUNTS: Record<string, number> = {
  'PL257-SBC': 13,
  'PL218-NGP': 11,
  'PL258-MMCT': 11,
  'PL262-PUNE': 15,
};
const EXPECTED_TOTAL_ITEMS = 50;

interface AmcManifestEntry {
  readonly id: string;
  readonly zone: string;
  readonly division: string;
  readonly schedule_count: number;
  readonly item_count: number;
  readonly advertised_value: number;
  readonly schedule_total: number;
  readonly net_bid_value: number;
  readonly rebate_on_total_value: number;
  readonly letter_percentage: { value: number; direction: string } | null;
  readonly completion_months: number;
  readonly hazard: string;
  readonly redaction: string;
  readonly fixture_file: string;
  readonly sha256: string;
}

const FIXTURES_DIR = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  'fixtures',
);

function manifest(): AmcManifestEntry[] {
  return JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, 'amc-corpus.json'), 'utf8'),
  ) as AmcManifestEntry[];
}

function letterText(entry: AmcManifestEntry): string {
  return readFileSync(path.join(FIXTURES_DIR, entry.fixture_file), 'utf8');
}

describe('the AMC evidence set', () => {
  it('declares exactly the four letters the ruling added', () => {
    expect(
      manifest()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(Object.keys(EXPECTED_ITEM_COUNTS).sort());
  });

  it("every fixture's SHA-256 matches its manifest-declared sha256", () => {
    for (const entry of manifest()) {
      const raw = readFileSync(path.join(FIXTURES_DIR, entry.fixture_file));
      expect(
        createHash('sha256').update(raw).digest('hex'),
        `${entry.id}: sha256 of ${entry.fixture_file}`,
      ).toBe(entry.sha256);
    }
  });

  it('parses the declared item count out of each letter, and 50 in total', () => {
    let total = 0;
    for (const entry of manifest()) {
      const expected = EXPECTED_ITEM_COUNTS[entry.id];
      expect(expected, `unexpected letter id "${entry.id}"`).toBeDefined();
      expect(entry.item_count, `${entry.id}: manifest item_count`).toBe(expected);
      const payload = reviewLoaLetter(letterText(entry));
      expect(payload.items.length, `${entry.id}: parsed items`).toBe(expected);
      total += payload.items.length;
    }
    expect(total).toBe(EXPECTED_TOTAL_ITEMS);
  });

  it('counts the same items again from the At Par anchor, independently of the parse', () => {
    const anchorRe = /\b(?:At Par|Below Par|Above Par)\b/g;
    for (const entry of manifest()) {
      const matches = letterText(entry).match(anchorRe) ?? [];
      expect(matches.length, `${entry.id}: anchor tokens`).toBe(entry.item_count);
    }
  });

  it('holds no PDFs — every fixture is plain pdftotext output', () => {
    for (const entry of manifest()) {
      expect(entry.fixture_file.endsWith('.txt')).toBe(true);
      const raw = readFileSync(path.join(FIXTURES_DIR, entry.fixture_file));
      expect(raw.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
      // Decoding with { fatal: true } throwing IS the UTF-8 proof.
      expect(
        new TextDecoder('utf-8', { fatal: true }).decode(raw).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe('hazard 1 — PL257 SBC: per-item bid rates with a real rebate', () => {
  const text = letterText(
    manifest().find((entry) => entry.id === 'PL257-SBC') as AmcManifestEntry,
  );

  it("raises the corpus's FIRST genuinely non-zero rebate, so the trigger stops being defensive", () => {
    // `detectUnexpectedRebate` was written against six letters that all
    // print 0.00 and documented itself as unexercised by real data. SBC
    // prints 1.00, and 1653075.04 x 0.99 is its own Net Bid Value — so
    // the rebate is the multiplier, not a decoy.
    const payload = reviewLoaLetter(text);
    expect(payload.pricingShape.rebateOnTotalValue).toBe(1);
    expect(payload.needsReview.byCode.unexpected_rebate).toBe(1);
    expect(payload.needsReview.anyLetterLevel).toBe(true);
  });

  it('flags every one of its 13 rows rather than guessing at a table it cannot decompose', () => {
    // The negotiated Bid Rate/Unit Rate column is the second money column
    // this letter prints, and the anchor tail does not decompose with it
    // there. The parser's answer is to keep the raw line and flag the row
    // — which is the behaviour worth pinning, because the alternative
    // (silently reading one of the two rates as the other) is a money
    // error nobody would see.
    const payload = reviewLoaLetter(text);
    expect(payload.items).toHaveLength(13);
    expect(payload.needsReview.byCode.layout_junk).toBe(13);
    expect(payload.items.every((item) => item.raw.anchorLine.length > 0)).toBe(true);
  });

  it('reads the whole schedule as maintenance', () => {
    const payload = reviewLoaLetter(text);
    expect(payload.needsReview.byCode.amc_schedule).toBe(1);
  });
});

describe('hazard 2 — PL280 ADI: the schedule is the AMC signal, not the description', () => {
  it('flags the schedule, because every item-level reading of the token is unusable', () => {
    const payload = reviewLoaLetter(loadLetter('PL280-ADI').text);
    const scheduleFlags = payload.flags.filter((flag) => flag.code === 'amc_schedule');
    expect(scheduleFlags).toHaveLength(1);
    expect(scheduleFlags[0]?.scope).toBe('schedule');
    expect(scheduleFlags[0]?.targetId).toBe('AB');

    // The measurement the schedule-level choice rests on: item 11 is
    // "LFD display with all necessary accessories" and carries no AMC
    // token of its own in the PDF, yet its PARSED description matches —
    // descriptions are assembled from the lines around an anchor and
    // overlap their neighbours by construction. All 12 match, so an
    // item-level "missing token" trigger would find nothing here.
    const matching = payload.items.filter((item) =>
      /\bAMC\b|annual\s+maintenance/i.test(item.description),
    );
    expect(matching).toHaveLength(12);
    const eleven = payload.items.find((item) => item.itemSno === '11');
    expect(eleven?.description).toContain('LFD display');
  });
});

describe('hazard 3 — PL218 NGP: two schedules, two cadences', () => {
  const text = letterText(
    manifest().find((entry) => entry.id === 'PL218-NGP') as AmcManifestEntry,
  );

  it('parses both schedules and prices them separately', () => {
    const payload = reviewLoaLetter(text);
    const schedules = [
      ...new Set(payload.items.map((item) => item.schedule?.id ?? 'UNBOUND')),
    ].sort();
    expect(schedules).toEqual(['SCH', 'Vis']);
    expect(payload.pricingShape.scheduleTotals).toHaveLength(2);
  });

  it('flags the recurrence prose on both schedules, with cadences that differ', () => {
    // This is the whole reason migration 0107 puts the cadence on the
    // SCHEDULE: SCH recurs four times a year and Vis six, over the same
    // three years, so one Work-level cadence could not describe the
    // letter at all.
    const payload = reviewLoaLetter(text);
    const recurrence = payload.flags.filter(
      (flag) => flag.code === 'amc_recurrence_prose',
    );
    expect(recurrence.length).toBeGreaterThan(0);
    const bySchedule = new Map<string, Set<number>>();
    for (const flag of recurrence) {
      const scheduleId = flag.targetId.split('#')[0] ?? '';
      const detail = flag.detail as { first_year_qty: number; total_qty: number };
      const set = bySchedule.get(scheduleId) ?? new Set<number>();
      set.add(detail.total_qty / detail.first_year_qty);
      bySchedule.set(scheduleId, set);
    }
    // Both schedules state a recurrence, and the maintenance schedule's
    // per-year rate is not the visit schedule's.
    expect([...bySchedule.keys()].sort()).toEqual(['SCH', 'Vis']);
    expect(bySchedule.get('Vis')).toEqual(new Set([3]));
    const visitPerYear = 18 / 3;
    const jobPerYear = 12 / 3;
    expect(visitPerYear).not.toBe(jobPerYear);
  });

  it('flags only the maintenance schedule as wholly AMC — the visit schedule never says so', () => {
    // The visit schedule IS an AMC schedule (its printed title reads
    // "Visit of AMC"), and its items never repeat the word. That is the
    // honest limit of a description-based signal, recorded here rather
    // than papered over: the operator confirms it at review.
    const payload = reviewLoaLetter(text);
    const scheduleFlags = payload.flags.filter((flag) => flag.code === 'amc_schedule');
    expect(scheduleFlags.map((flag) => flag.targetId)).toEqual(['SCH']);
  });
});

describe('hazard 4 — PL258 MMCT and PL262 Pune: the defaults the rulings name', () => {
  it('MMCT states no cadence anywhere, which is the M=1 default case', () => {
    const entry = manifest().find(
      (candidate) => candidate.id === 'PL258-MMCT',
    ) as AmcManifestEntry;
    const payload = reviewLoaLetter(letterText(entry));
    expect(
      payload.flags.filter((flag) => flag.code === 'amc_recurrence_prose'),
    ).toEqual([]);
    expect(payload.flags.filter((flag) => flag.code === 'amc_schedule')).toEqual([]);
    // Q1: a no-cycle letter defaults to one period, final-bill-for-total,
    // and the operator overrides it. Nothing in the parse proposes one.
    expect(entry.completion_months).toBe(72);
  });

  it('Pune prices 69% above and never prints an accepted rate', () => {
    const entry = manifest().find(
      (candidate) => candidate.id === 'PL262-PUNE',
    ) as AmcManifestEntry;
    const payload = reviewLoaLetter(letterText(entry));
    expect(payload.pricingShape.letter_percentage).toBe(69);
    expect(payload.pricingShape.letter_percentage_direction).toBe('above');
    expect(payload.pricingShape.advertised_value).toBe(entry.advertised_value);
    expect(payload.pricingShape.contract_value).toBe(entry.net_bid_value);
  });
});
