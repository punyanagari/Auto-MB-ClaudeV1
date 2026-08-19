import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCorpus, loadLetter, type CorpusManifestEntry } from '../src/index.js';

// docs/reference/loa-parser-contract.md §0: "281 items total ... Treat any
// future extraction that does not total 281 on this corpus as a regression."
const EXPECTED_ITEM_COUNTS: Record<string, number> = {
  'PL273-JHS': 4,
  'PL280-ADI': 12,
  'PL275-BKN': 45,
  'PL276-GTL': 37,
  'PL270-CRB': 129,
  'PL281-BB': 54,
};
const EXPECTED_TOTAL_ITEMS = 281;

// research §1: PL273/PL280/PL275/PL281 are Shape A; of those four, three
// (PL280, PL275, PL281) declare a letter-level percentage and one (PL273,
// %At Par) declares none. PL276/PL270 are Shape B and declare none.
const SHAPE_A_IDS = new Set(['PL273-JHS', 'PL280-ADI', 'PL275-BKN', 'PL281-BB']);
const SHAPE_B_IDS = new Set(['PL276-GTL', 'PL270-CRB']);
const PERCENTAGE_BEARING_IDS = new Set(['PL280-ADI', 'PL275-BKN', 'PL281-BB']);
const AT_PAR_NO_PERCENTAGE_ID = 'PL273-JHS';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(TEST_DIR, '..');
const FIXTURES_DIR = path.join(PACKAGE_DIR, 'fixtures');

function loadManifestDirect(): CorpusManifestEntry[] {
  const raw = readFileSync(path.join(FIXTURES_DIR, 'corpus.json'), 'utf8');
  return JSON.parse(raw) as CorpusManifestEntry[];
}

describe('loa corpus manifest (DC-22)', () => {
  it('declares exactly the six expected letters', () => {
    const manifest = loadManifestDirect();
    const ids = manifest.map((entry) => entry.id).sort();
    expect(ids).toEqual(Object.keys(EXPECTED_ITEM_COUNTS).sort());
  });

  it('manifest declares item counts 4 + 12 + 45 + 37 + 129 + 54, per letter', () => {
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      const expected = EXPECTED_ITEM_COUNTS[entry.id];
      expect(expected, `unexpected letter id "${entry.id}"`).toBeDefined();
      expect(
        entry.item_count,
        `${entry.id}: item_count should be ${String(expected)}`,
      ).toBe(expected);
    }
  });

  it('item counts sum to exactly 281 across the corpus', () => {
    const manifest = loadManifestDirect();
    const sum = manifest.reduce((acc, entry) => acc + entry.item_count, 0);
    expect(sum).toBe(EXPECTED_TOTAL_ITEMS);
  });

  it('the anchor-token count in each fixture matches the manifest item_count', () => {
    // research §2: "Every item row contains exactly one of `At Par` /
    // `Below Par` / `Above Par`. Counting that token gives exactly
    // 12/37/4/45/129/54 = 281. It is the only reliable per-item anchor."
    // Counting the anchor independently of the manifest catches a fixture
    // that drifted out from under a manifest nobody updated.
    const anchorRe = /\b(?:At Par|Below Par|Above Par)\b/g;
    for (const letter of loadCorpus()) {
      const matches = letter.text.match(anchorRe) ?? [];
      expect(
        matches.length,
        `${letter.manifest.id}: anchor-token count in fixture text vs manifest item_count`,
      ).toBe(letter.manifest.item_count);
    }
  });

  it('every letter declares a pricing_shape of A or B', () => {
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      expect(
        entry.pricing_shape === 'A' || entry.pricing_shape === 'B',
        `${entry.id}: pricing_shape must be "A" or "B", got ${JSON.stringify(entry.pricing_shape)}`,
      ).toBe(true);
    }
  });

  it('manifest declares the four Shape-A and two Shape-B letters as expected', () => {
    const manifest = loadManifestDirect();
    const shapeA = manifest
      .filter((entry) => entry.pricing_shape === 'A')
      .map((entry) => entry.id)
      .sort();
    const shapeB = manifest
      .filter((entry) => entry.pricing_shape === 'B')
      .map((entry) => entry.id)
      .sort();
    expect(shapeA).toEqual([...SHAPE_A_IDS].sort());
    expect(shapeB).toEqual([...SHAPE_B_IDS].sort());
  });

  it('the three percentage-bearing Shape-A letters declare letter_percentage; the at-par Shape-A letter and both Shape-B letters do not', () => {
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      if (PERCENTAGE_BEARING_IDS.has(entry.id)) {
        expect(
          entry.letter_percentage,
          `${entry.id}: expected a declared letter_percentage`,
        ).not.toBeNull();
        expect(
          typeof entry.letter_percentage?.value,
          `${entry.id}: percentage value`,
        ).toBe('number');
        expect(
          entry.letter_percentage?.direction === 'Below' ||
            entry.letter_percentage?.direction === 'Above',
          `${entry.id}: percentage direction must be "Below" or "Above"`,
        ).toBe(true);
      } else if (entry.id === AT_PAR_NO_PERCENTAGE_ID) {
        expect(
          entry.letter_percentage,
          `${entry.id}: at-par letter must declare no letter_percentage`,
        ).toBeNull();
      } else if (SHAPE_B_IDS.has(entry.id)) {
        expect(
          entry.letter_percentage,
          `${entry.id}: Shape-B letter must declare no letter_percentage`,
        ).toBeNull();
      }
    }
    const shapeAWithPercentage = manifest.filter(
      (entry) => entry.pricing_shape === 'A' && entry.letter_percentage !== null,
    );
    expect(shapeAWithPercentage.length).toBe(3);
    const shapeAWithoutPercentage = manifest.filter(
      (entry) => entry.pricing_shape === 'A' && entry.letter_percentage === null,
    );
    expect(shapeAWithoutPercentage.length).toBe(1);
  });

  it("PL281's net_bid_value exceeds advertised_value (the only %Above letter)", () => {
    const pl281 = loadLetter('PL281-BB');
    expect(pl281.manifest.net_bid_value).toBeGreaterThan(
      pl281.manifest.advertised_value,
    );
    expect(pl281.manifest.letter_percentage).toEqual({
      value: 24.5,
      direction: 'Above',
    });
  });

  it("declares the same redaction mode consistently ('verbatim-names-retained', per the CEO decision)", () => {
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      expect(entry.redaction, `${entry.id}: redaction mode`).toBe(
        'verbatim-names-retained',
      );
    }
  });

  it('every fixture text file exists, is non-empty, and is valid UTF-8', () => {
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      const filePath = path.join(FIXTURES_DIR, entry.fixture_file);
      expect(
        existsSync(filePath),
        `${entry.id}: fixture file ${entry.fixture_file} does not exist`,
      ).toBe(true);
      expect(
        statSync(filePath).isFile(),
        `${entry.id}: fixture path ${entry.fixture_file} is not a file`,
      ).toBe(true);

      const buf = readFileSync(filePath);
      expect(buf.length, `${entry.id}: fixture file is empty`).toBeGreaterThan(0);

      // { fatal: true } makes TextDecoder THROW on any invalid UTF-8 byte
      // sequence instead of silently replacing it with U+FFFD — decode()
      // returning at all (not throwing) is itself the proof of valid UTF-8.
      // The replacement-character check below is a belt-and-braces second
      // assertion, not the primary proof: it would only fire if a future
      // change relaxed `fatal` to its default (false, which DOES substitute
      // U+FFFD instead of throwing) without this comment being updated too.
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      expect(text.includes('�'), `${entry.id}: fixture file is not valid UTF-8`).toBe(
        false,
      );
    }
  });

  it("every fixture file's SHA-256 matches its manifest-declared sha256 (verbatimness guard)", () => {
    // Guards against valid-UTF-8 tampering that PRESERVES the anchor-token
    // count (an edited money figure, an altered description line, stripped
    // print furniture) — the anchor-token test above cannot see that class
    // of drift because it only counts "At Par"/"Below Par"/"Above Par"
    // occurrences, which such an edit need not touch. Computed purely from
    // the fixture's raw bytes (no I/O outside fixtures/), so this is the
    // load-bearing check that the committed text is still byte-identical to
    // what the manifest was authored against — DC-23's furniture-stripping
    // work reads the fixture through this same guard.
    const manifest = loadManifestDirect();
    for (const entry of manifest) {
      const filePath = path.join(FIXTURES_DIR, entry.fixture_file);
      const raw = readFileSync(filePath);
      const digest = createHash('sha256').update(raw).digest('hex');
      expect(digest, `${entry.id}: sha256 of ${entry.fixture_file}`).toBe(entry.sha256);
    }
  });

  it('advertised_value, net_bid_value, schedule_count, zone, and division match research §0 exactly, per letter', () => {
    // docs/reference/loa-parser-contract.md §0's corpus table, in full — not
    // just the two value columns. schedule_count, zone, and division are
    // ticket-named manifest fields (legacy ticket DC-22: "one entry per letter:
    // id, zone, division, schedule count, item count, advertised value, net
    // bid value...") with downstream teeth: schedule_count is Shape-B
    // correctness (research §1's Schedule Totals sum check) and DC-33's
    // item-to-schedule bounding, and zone/division identify the letter. A
    // reviewer mutation that changed PL276-GTL schedule_count 4->3 and
    // PL270-CRB zone/division to fabricated values previously left this
    // suite green (17/17) because nothing asserted these three fields
    // against research §0 — this case closes that hole.
    const expected: Record<
      string,
      {
        advertised: number;
        net: number;
        schedules: number;
        zone: string;
        division: string;
      }
    > = {
      'PL273-JHS': {
        advertised: 3046426.56,
        net: 3046426.56,
        schedules: 1,
        zone: 'North Central',
        division: 'Jhansi S&T',
      },
      'PL280-ADI': {
        advertised: 4165603.32,
        net: 4144775.3,
        schedules: 1,
        zone: 'Western',
        division: 'Ahmedabad S&T',
      },
      'PL275-BKN': {
        advertised: 7994861.18,
        net: 5676351.44,
        schedules: 2,
        zone: 'North Western',
        division: 'Bikaner S&T',
      },
      'PL276-GTL': {
        advertised: 63632540.0,
        net: 46727651.87,
        schedules: 4,
        zone: 'South Central',
        division: 'Guntakal S&T',
      },
      'PL270-CRB': {
        advertised: 195574112.38,
        net: 169228497.35,
        schedules: 5,
        zone: 'Central',
        division: 'Mumbai CST S&T',
      },
      'PL281-BB': {
        advertised: 118502769.36,
        net: 147535947.85,
        schedules: 3,
        zone: 'Western',
        division: 'Mumbai Central S&T',
      },
    };
    for (const letter of loadCorpus()) {
      const exp = expected[letter.manifest.id];
      expect(exp, `unexpected letter id "${letter.manifest.id}"`).toBeDefined();
      if (exp === undefined) {
        continue;
      }
      expect(
        letter.manifest.advertised_value,
        `${letter.manifest.id}: advertised_value`,
      ).toBe(exp.advertised);
      expect(
        letter.manifest.net_bid_value,
        `${letter.manifest.id}: net_bid_value`,
      ).toBe(exp.net);
      expect(
        letter.manifest.schedule_count,
        `${letter.manifest.id}: schedule_count`,
      ).toBe(exp.schedules);
      expect(letter.manifest.zone, `${letter.manifest.id}: zone`).toBe(exp.zone);
      expect(letter.manifest.division, `${letter.manifest.id}: division`).toBe(
        exp.division,
      );
    }
  });

  it('loadLetter throws for an unknown id', () => {
    expect(() => loadLetter('PL999-NOPE')).toThrow();
  });

  it('fixtures/ contains no binary PDFs, text files only', () => {
    const entries = readdirSync(FIXTURES_DIR);
    for (const name of entries) {
      // Two manifests live here: the six-letter research corpus and the
      // additive AMC evidence set (`test/amc-corpus.test.ts`). Everything
      // else in this directory is pdftotext output.
      if (name === 'corpus.json' || name === 'amc-corpus.json') {
        continue;
      }
      expect(
        name.endsWith('.txt'),
        `${name}: fixtures/ must hold .txt or corpus.json only`,
      ).toBe(true);
    }
  });
});

describe('loa package purity (DC-22)', () => {
  it('package.json declares no dependency on any other workspace package', () => {
    const pkgPath = path.join(PACKAGE_DIR, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    // Merged across every section so an empty manifest cannot pass
    // vacuously and a dependency under any section name is caught.
    const all = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    };
    const workspaceDeps = Object.keys(all).filter((name) =>
      name.startsWith('@auto-mb/'),
    );
    expect(workspaceDeps).toEqual([]);
  });

  it('the entry module (src/index.ts) imports nothing from any @auto-mb/* package', () => {
    const entryPath = path.join(PACKAGE_DIR, 'src', 'index.ts');
    const source = readFileSync(entryPath, 'utf8');
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
      expect(spec.startsWith('@auto-mb/')).toBe(false);
    }
  });

  it('loadCorpus() resolves fixtures relative to the package, not process.cwd()', () => {
    // Proven by actually moving the cwd somewhere the fixtures are not.
    const original = process.cwd();
    try {
      process.chdir(os.tmpdir());
      expect(loadCorpus().length).toBe(6);
    } finally {
      process.chdir(original);
    }
  });
});
