import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @auto-mb/loa-parser — pure library holding the six-letter / 281-item IREPS
 * Letter-of-Acceptance regression corpus (DC-22; input contract:
 * research/DC-32-loa-parser-contract.md §0, §3).
 *
 * PURE LIBRARY CONTRACT: no database, no network, no filesystem access
 * outside this package's own fixtures/ directory, and no runtime dependency
 * on @auto-mb/db or @auto-mb/api (packages/config/test/workspace-layout.test.ts
 * (e) and packages/loa/test/corpus-manifest.test.ts both enforce this).
 * The fixtures directory is resolved relative to THIS file (import.meta.url),
 * never process.cwd() — root `pnpm test` collects this package's tests from
 * the repo root while `pnpm --filter @auto-mb/loa-parser test` runs them from the
 * package directory, and the fixture path must resolve identically either
 * way.
 */

// DC-23 — text normalisation and header extraction. Re-exported here so the
// package's public surface stays coherent (loadCorpus/loadLetter alongside
// the normalisation functions that consume their output), per the ticket's
// "Keep the public API surface coherent" instruction.
export type { FieldResult } from './field.js';
export { found, notFound, optionalAbsent, preview } from './field.js';
export { isPrintFurnitureLine, stripPrintFurniture } from './furniture.js';
export { toIsoDate, parseDdMmYyyy } from './dates.js';
export { indianWordsToNumber, parseRupeesWords } from './words-to-number.js';
export { flatten, paragraphs, hyphenJoin, nonBlankLines } from './text.js';
export {
  extractLetterNumberAndDate,
  type LetterNumberAndDate,
} from './letter-number.js';
export {
  extractHeader,
  type LoaHeader,
  type ContractValueField,
  type EmdField,
  type SecurityDepositField,
  type PerformanceGuaranteeField,
  type CompletionPeriodField,
} from './header.js';
// DC-25 — item-row parsing (par-token anchoring, wrapped descriptions,
// schedule binding). Re-exported for the same "coherent public surface"
// reason as DC-23's header exports above.
export {
  parseItems,
  type ParsedItem,
  type ParTokenDirection,
  type ItemScheduleBinding,
  type ItemReconciliation,
} from './items.js';
export { parseDecimalToMinorUnits, formatMinorUnits } from './decimal.js';
// DC-24 — pricing-shape classifier (Shape A letter-level percentage vs
// Shape B per-schedule totals; research/DC-32-loa-parser-contract.md §1).
// Re-exported for the same "coherent public surface" reason as DC-23's and
// DC-25's exports above.
export {
  classifyPricingShape,
  parseTotalsBlockStructure,
  classifyShapeKind,
  type PricingShapeValue,
  type LetterPercentageDirectionValue,
  type WorksPricingColumns,
  type PricingShapeResult,
  type ShapeKind,
  type TotalsBlockStructure,
  type ScheduleTotalEntry,
  type TotalsRoundingDivergence,
} from './pricing-shape.js';
// DC-26 — the needsReview trigger set (six proven traps, additive review
// flags, never a work-writing function). Re-exported for the same "coherent
// public surface" reason as DC-23's, DC-24's and DC-25's exports above; this
// is also the ONLY new surface DC-26 adds, and test/needs-review.test.ts's
// never-auto-commit block scans exactly this file for a work-writing
// function name.
export {
  reviewLoaLetter,
  detectCorrigendumKeyword,
  detectCorrigendumItemUnitCorrections,
  parseItemNumberList,
  detectQtyDecomposition,
  detectPaymentTermsProse,
  resolveCanonicalUnitCode,
  detectUnresolvedUnits,
  detectItemCodeNamespaceMismatch,
  detectLayoutJunk,
  detectUnexpectedItemBreakup,
  detectUnexpectedRebate,
  detectUnexpectedAbovePar,
  detectBannedItemsBlock,
  detectBannedItemsBranch,
  CANONICAL_UNIT_NAMES,
  type ReviewFlagScope,
  type FlagCode,
  type ReviewFlag,
  type ProposedUnitCorrection,
  type QtyDecomposition,
  type NeedsReviewRollup,
  type LoaReviewPayload,
  type BannedBlockSpelling,
  type BannedItemsBlockDetection,
} from './needs-review.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures');
const MANIFEST_PATH = path.join(FIXTURES_DIR, 'corpus.json');

/** Shape A: a single letter-level percentage in the totals block
 * (`Total Value <advertised> <pct> %Below|%Above|%At Par <net>`), every
 * `Schedule Totals` line reading `0.00`. Shape B: per-schedule totals with no
 * percentage token, where the populated `Schedule Totals` lines sum to the
 * Net Bid Value. See research/DC-32-loa-parser-contract.md §1. */
export type PricingShape = 'A' | 'B';

/** The percentage is signed by its printed token — `%Below`/`%At Par` apply
 * `net = advertised * (1 - pct/100)`, `%Above` applies
 * `net = advertised * (1 + pct/100)`. `%At Par` (0.00%) is modeled as "no
 * percentage declared" (`letter_percentage: null`) rather than as
 * `{ value: 0, direction: ... }` — at par there is no below/above direction
 * to assign, per DC-22's manifest-test requirement that the at-par Shape-A
 * letter declare none. */
export type PercentageDirection = 'Below' | 'Above';

export interface LetterPercentage {
  readonly value: number;
  readonly direction: PercentageDirection;
}

/** One entry per letter in fixtures/corpus.json. Field names mirror the
 * `pricing_shape` / `letter_percentage` vocabulary research §6 assigns to
 * the eventual `works` schema, since this manifest is that schema's
 * regression ground truth. */
export interface CorpusManifestEntry {
  readonly id: string;
  readonly zone: string;
  readonly division: string;
  readonly schedule_count: number;
  readonly item_count: number;
  readonly advertised_value: number;
  readonly net_bid_value: number;
  readonly pricing_shape: PricingShape;
  readonly letter_percentage: LetterPercentage | null;
  /** Redaction mode applied to personal data (officer names, addresses) in
   * the fixture text. Per the CEO decision (tickets/DC-22.md, "Decided —
   * CEO, 2026-07-28"), officer names are retained verbatim rather than
   * redacted, so every entry currently declares the same mode:
   * "verbatim-names-retained". The field exists so a future redaction
   * policy change is a manifest diff, not a silent one. */
  readonly redaction: string;
  /** Filename within fixtures/, e.g. "PL273-JHS.txt". Never a path — see
   * resolveFixturePath. */
  readonly fixture_file: string;
  /** Lowercase hex SHA-256 of the fixture file's raw bytes, computed once at
   * manifest-authoring time. The load-bearing verbatimness guard: fixture
   * tampering that preserves the anchor-token count (an edited money figure,
   * an altered description line, stripped print furniture) still changes
   * every byte's digest, so `test/corpus-manifest.test.ts` recomputing this
   * over the live file catches it even though git history is not consulted
   * at test time. DC-23's furniture-stripping work reads the fixture through
   * this same guard. */
  readonly sha256: string;
}

/** A loaded corpus letter: its manifest entry plus the raw `pdftotext
 * -layout` text extraction, verbatim (print-furniture noise included). */
export interface CorpusLetter {
  readonly manifest: CorpusManifestEntry;
  readonly text: string;
}

function readManifest(): CorpusManifestEntry[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as CorpusManifestEntry[];
}

/**
 * Resolves a manifest-declared fixture filename to a path inside
 * fixtures/, refusing anything that could escape the directory. Enforces
 * the "no filesystem access outside its own fixture directory" contract
 * even against a malformed manifest, not just against caller input.
 */
function resolveFixturePath(fileName: string): string {
  if (
    fileName.length === 0 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..')
  ) {
    throw new Error(`@auto-mb/loa-parser: unsafe fixture_file "${fileName}"`);
  }
  const resolved = path.join(FIXTURES_DIR, fileName);
  const rel = path.relative(FIXTURES_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `@auto-mb/loa-parser: fixture_file "${fileName}" escapes fixtures/`,
    );
  }
  return resolved;
}

function readFixtureText(entry: CorpusManifestEntry): string {
  return readFileSync(resolveFixturePath(entry.fixture_file), 'utf8');
}

/**
 * Loads the full six-letter corpus: manifest entry plus raw fixture text
 * for every letter, in `fixtures/corpus.json` order. This is the ONLY
 * sanctioned access path to the fixtures — later parser tickets must not
 * read `packages/loa/fixtures/**` directly.
 */
export function loadCorpus(): CorpusLetter[] {
  return readManifest().map((manifest) => ({
    manifest,
    text: readFixtureText(manifest),
  }));
}

/**
 * Loads a single corpus letter by its manifest `id` (e.g. `"PL273-JHS"`).
 * Throws if no manifest entry matches.
 *
 * This is a sanctioned convenience wrapper, not a second access path: the
 * ticket's "loadCorpus() is the only way later parser tickets reach the
 * fixtures" intent is about the RESOLUTION mechanism, and loadLetter routes
 * through the exact same guarded resolveFixturePath as loadCorpus, reads
 * from the same manifest, and leaks no filesystem path a caller could use to
 * bypass it. loadCorpus() stays the canonical, load-everything access path;
 * loadLetter(id) is API sugar for the common single-letter case within that
 * same intent, recorded here so the deviation from the literal wording is on
 * the record rather than silent.
 */
export function loadLetter(id: string): CorpusLetter {
  const manifest = readManifest().find((entry) => entry.id === id);
  if (manifest === undefined) {
    throw new Error(`@auto-mb/loa-parser: no manifest entry for id "${id}"`);
  }
  return { manifest, text: readFixtureText(manifest) };
}
