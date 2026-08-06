/**
 * @auto-mb/loa-parser — pricing-shape classifier (DC-24; tickets/DC-24.md;
 * research/DC-32-loa-parser-contract.md §1, "the finding that governs
 * correctness").
 *
 * `classifyPricingShape` is the single public entry point. It is the sole
 * authority for the five `works` columns tickets/DC-14.md adds
 * (`advertised_value`, `contract_value`, `pricing_shape`, `letter_percentage`,
 * `letter_percentage_direction`) — DISTINCT from header.ts's
 * `ContractValueField` (`extractHeader().contractValue`), which extracts the
 * unrelated header-block PROSE figure ("... works out to Rs. X (Y)"),
 * printed once near the top of the letter, before the item table. This
 * module never reads that region; it reads the TOTALS BLOCK that follows the
 * LAST item row (`Schedule Totals` × N, then `Total Value` /
 * `Rebate on Total Value (%)` / `Net Bid Value`, research §1).
 *
 * CLASSIFY BEFORE COMPUTE (the ticket's own framing, load-bearing): this
 * module is built as three strictly ordered phases, and each later phase's
 * INPUT TYPE makes the ordering a structural fact, not just a convention —
 *
 *   1. `parseTotalsBlockStructure` — locates the totals block and extracts
 *      every figure/token as a printed STRING or presence flag. Zero
 *      arithmetic: no addition, no multiplication, no rounding.
 *   2. `classifyShapeKind` — a pure function of that structure alone
 *      (`TotalsBlockStructure -> ShapeKind`). It inspects presence/shape
 *      only (is every `Schedule Totals` line `0.00`? is there a percentage
 *      token at all?) — still zero arithmetic. This is the function whose
 *      OUTPUT selects which branch of phase 3 runs.
 *   3. Exactly one of two arithmetic functions runs, chosen by phase 2's
 *      result: `computeLetterPercentageContract` (Shape A, research §1's
 *      signed formula) or `computeScheduleSumContract` (Shape B, plain
 *      summation). Their PARAMETER LISTS make "the Shape-B path never
 *      touches the percentage arithmetic" a compile-time fact rather than a
 *      runtime promise: `computeScheduleSumContract` takes only
 *      `scheduleTotals` — no percentage/direction value is even in scope for
 *      it to read, and `computeLetterPercentageContract` takes only the
 *      advertised figure + percentage/direction — no schedule-totals array
 *      is in scope for it either. Neither function can reach the other's
 *      inputs by construction, not merely by discipline.
 *
 * Never sums item rows (research §1's correctness hinge: under Shape A the
 * printed per-item `Bid Amount` is at the ADVERTISED rate, not the contract
 * rate — summing items reproduces `advertised_value`, not `contract_value`,
 * a 29% error on PL275). This module never imports items.ts and never reads
 * an item row.
 *
 * Item-row `Above Par` (the never-observed-in-corpus PAR TOKEN on an
 * individual item line, research §5) stays items.ts's concern — this module
 * never reads item-row tokens at all, so there is nothing to duplicate here.
 *
 * REBATE DECOY (research §1 "The decoy"): `Rebate on Total Value (%)` is
 * parsed and surfaced on the result (`rebateOnTotalValue`) for audit
 * visibility only — it is NEVER read by either arithmetic function, and a
 * non-zero value raises `needsReview` as a data CONTRADICTION rather than
 * being applied either way ("never quietly prefers either number").
 *
 * TOTALS-ROUNDING TOLERANCE (tickets/DC-24.md, 2026-08-05 manager ruling,
 * review R1 ride-along): the printed Net Bid Value ALWAYS wins as
 * `contract_value` once the shape reconciles at all — the letter is the
 * document the railway signed, the recomputation is only its checksum, never
 * the datum. Three bands on `diff = |computed - printed|` (exact bigint
 * paisa, both shapes' computation): `diff = 0` -> `contract_value` = the
 * printed figure (identical to computed), no flag at all (all six corpus
 * letters land here — flagging a universal zero-diff would drown the
 * signal). `0 < diff <= 0.01` -> `contract_value` is STILL the printed
 * figure (never the computed one), classification stands, and a
 * `divergence` flag (`code: 'totals_rounding_divergence'`) carries
 * `{ printed, computed, diff }` plus the raw totals block — the computed
 * figure survives only in this flag, never silently overwriting
 * `contract_value`. `diff > 0.01` -> the existing criterion-6 failure branch
 * (`pricing_shape: null`), unchanged.
 *
 * AT-PAR CONTRADICTION (n1, same ruling round): a totals block that prints
 * the `At Par` token together with a NON-ZERO percentage is internally
 * contradictory (`At Par` means "no percentage") even though the printed
 * figures otherwise reconcile — flagged via `needsReview`, classification
 * still stands (same "flag, don't refuse" treatment as the rebate decoy).
 *
 * ARITHMETIC: every money figure is parsed to bigint PAISA via decimal.ts's
 * `parseDecimalToMinorUnits`/`formatMinorUnits` (reused, not reimplemented —
 * see decimal.ts's own module doc for why float64 cannot hold these
 * exactly). The letter-percentage formula itself (round-half-up division)
 * is new arithmetic this module owns; decimal.ts has no rounding-division
 * helper because DC-25's item reconciliation never needed one (qty is
 * always a whole number, so qty*rate needs no rounding at all).
 *
 * NAMING: the five DC-14-column fields on `PricingShapeResult` use the
 * DB's own snake_case spelling (`advertised_value`, not `advertisedValue`),
 * matching this package's own precedent — `index.ts`'s `CorpusManifestEntry`
 * already mirrors DB/schema column names verbatim for the same reason (it
 * IS the eventual row shape). Diagnostic-only fields (`needsReview`,
 * `scheduleTotals`, …) keep this package's usual camelCase FieldResult-style
 * convention (field.ts, header.ts, items.ts). `packages/works/src/service.ts`'s
 * `CreateWorkInput` mirrors the same five columns under ITS OWN camelCase
 * convention for its own DB-insert purpose — this module does not import it
 * (this package stays free of any `@auto-mb/works`/`@auto-mb/db` dependency,
 * the purity contract `test/corpus-manifest.test.ts` enforces) and is not
 * required to share its exact TS spelling, only its column SET, which
 * `test/pricing-shape.test.ts`'s type-level + runtime key-set assertions
 * prove independently.
 */
import { formatMinorUnits, parseDecimalToMinorUnits } from './decimal.js';
import { stripPrintFurniture } from './furniture.js';
import { flatten } from './text.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';
const SCHEDULE_HEADER_START_RE = /^\s*Schedule\s+([A-Z][A-Za-z0-9]*)-/;
const SCHEDULE_TOTALS_LINE_RE = /^Schedule Totals\s+(-?[\d,]+\.\d{2})\s*$/;
const TOTAL_VALUE_LINE_TEST_RE = /^Total Value\s+-?[\d,]+\.\d{2}/;
const TOTAL_VALUE_LINE_PARSE_RE =
  /^Total Value\s+(-?[\d,]+\.\d{2})(?:\s+(.*))?$/;
const DECIMAL_TOKEN_RE = /-?[\d,]+\.\d{2}/g;
const REBATE_LABEL = 'Rebate on Total Value';
const NET_BID_LABEL = 'Net Bid Value';

export type PricingShapeValue = 'letter_percentage' | 'per_schedule';
export type LetterPercentageDirectionValue = 'below' | 'at_par' | 'above';

/** One `Schedule Totals` occurrence, in document order, paired with the
 * nearest preceding `Schedule <id>-` header (`null` only if the totals
 * block is somehow reached before any schedule header — unexercised by the
 * corpus, defensive). Ticket criterion 3: "each schedule total is carried
 * onto its schedule in the output." */
export interface ScheduleTotalEntry {
  readonly scheduleId: string | null;
  readonly total: number | null;
}

/** The exact DC-14 `works` pricing-column subset this module is
 * authoritative for (migrations/0050_add_works_pricing_columns.sql;
 * packages/db/src/schema/index.ts's `works` table). `pricing_shape` and
 * `letter_percentage_direction` use the DB's own CHECK-constraint enum
 * literals verbatim. `null` across all three shape/percentage fields is the
 * "unrecognised totals block" / "arithmetic did not reconcile" case
 * (ticket criterion 6) — `advertised_value`/`contract_value` stay `null`
 * only when even those verbatim printed figures could not be located. */
export interface WorksPricingColumns {
  readonly advertised_value: number | null;
  readonly contract_value: number | null;
  readonly pricing_shape: PricingShapeValue | null;
  readonly letter_percentage: number | null;
  readonly letter_percentage_direction: LetterPercentageDirectionValue | null;
}

/** `classifyPricingShape`'s full return shape: the five DC-14 columns
 * (`WorksPricingColumns`) plus audit/diagnostic fields that are NOT part of
 * that column set (kept separate so the "no field dropped/renamed"
 * assignability check in test/pricing-shape.test.ts is meaningful — adding
 * a diagnostic field here must never require touching the column names
 * above). */
export interface PricingShapeResult extends WorksPricingColumns {
  /** True when the totals block could not be classified/reconciled
   * (criterion 6), OR when it classified fine but a data CONTRADICTION was
   * found (criterion 4's rebate decoy, the totals-rounding `divergence`
   * below, or n1's at-par-with-nonzero-percentage check) — distinguishable
   * from each other by which of `pricing_shape`/`divergence`/
   * `rebateOnTotalValue`/`letter_percentage_direction` is set. */
  readonly needsReview: boolean;
  /** Set iff the shape classified and reconciled WITHIN tolerance but not
   * exactly (`0 < |computed - printed| <= 0.01`, module doc "TOTALS-ROUNDING
   * TOLERANCE") — `null` on an exact (`diff = 0`) reconciliation, which is
   * every one of the six real corpus letters, and also `null` when the
   * totals block failed to reconcile at all (`pricing_shape: null` instead).
   * `contract_value` is ALWAYS the printed figure in both the `null` and
   * non-`null` case here — this flag exists purely to surface that the
   * letter's own arithmetic didn't land on the printed figure exactly,
   * never to select which figure wins. */
  readonly divergence: TotalsRoundingDivergence | null;
  /** Every `Schedule Totals` line found, in document order, verbatim
   * figure + nearest preceding schedule id. Populated regardless of shape
   * (Shape A's entries are all `0`; Shape B's are the real breakdown). */
  readonly scheduleTotals: readonly ScheduleTotalEntry[];
  /** `Rebate on Total Value (%)` as printed, surfaced for audit visibility
   * only — see module doc "REBATE DECOY". `null` only if the field itself
   * could not be located (unexercised: present in all six real letters). */
  readonly rebateOnTotalValue: number | null;
  /** The raw totals-block text (verbatim lines, print-furniture already
   * stripped), retained per criterion 6 so a human reviewer never has to
   * re-open the source PDF. `null` only when neither a `Schedule Totals`
   * nor a `Total Value` line could be found at all. */
  readonly rawTotalsBlock: string | null;
}

/** The `needsReview` payload for a within-tolerance-but-nonzero
 * reconciliation gap (module doc "TOTALS-ROUNDING TOLERANCE"; tickets/
 * DC-24.md's 2026-08-05 manager ruling). `printed` is what `contract_value`
 * is actually set to; `computed` is what either arithmetic function
 * produced and survives ONLY here, never overwriting `contract_value`. */
export interface TotalsRoundingDivergence {
  readonly code: 'totals_rounding_divergence';
  readonly printed: number;
  readonly computed: number;
  readonly diff: number;
  readonly rawTotalsBlock: string | null;
}

/** Phase-2's output type — `null` is the "could not classify" case
 * (criterion 6: unrecognised totals block, or a structural signal
 * contradiction such as a percentage token with populated schedule
 * totals). */
export type ShapeKind = PricingShapeValue | null;

/** Phase-1 output: every totals-block figure/token as a printed STRING or
 * presence flag — zero arithmetic performed to build this. See module doc
 * "CLASSIFY BEFORE COMPUTE". */
export interface TotalsBlockStructure {
  readonly found: boolean;
  readonly advertisedRaw: string | null;
  readonly netRaw: string | null;
  readonly percentRaw: string | null;
  readonly percentTokenDirection: LetterPercentageDirectionValue | null;
  readonly scheduleTotals: readonly {
    scheduleId: string | null;
    totalRaw: string | null;
  }[];
  readonly rebateRaw: string | null;
  readonly rawBlockText: string | null;
}

// ---------------------------------------------------------------------------
// small string/decimal helpers
// ---------------------------------------------------------------------------

/** `"Below"` / `"%Above"` / `"At   Par"` (any whitespace run) -> the DB enum
 * literal, or `null` if the text is not one of the three known tokens. */
function normalizeToken(raw: string): LetterPercentageDirectionValue | null {
  const cleaned = raw.replace(/%/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^Below$/i.test(cleaned)) {
    return 'below';
  }
  if (/^Above$/i.test(cleaned)) {
    return 'above';
  }
  if (/^At\s+Par$/i.test(cleaned)) {
    return 'at_par';
  }
  return null;
}

/**
 * PL273's wrap trap: `%At Par` sometimes prints as two vertically-stacked
 * fragments (`%At` on the line immediately ABOVE the `Total Value` row,
 * `Par` immediately BELOW it) rather than inline — the same "cell taller
 * than its row" pdftotext -layout phenomenon letter-number.ts and items.ts
 * each solve their own instance of. Tries the two fragments joined (reading
 * order: above then below) first, then either fragment alone (defensive —
 * a lone-fragment wrap is not observed in the six-letter corpus).
 */
function reconstructWrappedToken(
  lines: readonly string[],
  totalValueLineIdx: number,
): LetterPercentageDirectionValue | null {
  const above = (lines[totalValueLineIdx - 1] ?? '').trim();
  const below = (lines[totalValueLineIdx + 1] ?? '').trim();
  const combined = `${above} ${below}`.trim();
  return (
    normalizeToken(combined) ?? normalizeToken(above) ?? normalizeToken(below)
  );
}

/** `true` iff `raw` parses as exactly zero to the paisa (bigint-exact, never
 * a float comparison). `null`/unparseable is never treated as zero. */
function isZeroAmount(raw: string | null): boolean {
  if (raw === null) {
    return false;
  }
  const minor = parseDecimalToMinorUnits(raw, 2);
  return minor === 0n;
}

function toNumberOrNull(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const n = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function minorToNumber(minor: bigint, scale: number): number {
  return Number.parseFloat(formatMinorUnits(minor, scale));
}

/** `abs(a - b)` in integer paisa (never float) — the shared basis for both
 * the criterion-6 failure threshold (`diff > 1n` = more than one paisa) and
 * the ruling's three-way band (`diff === 0n` / `0n < diff <= 1n` /
 * `diff > 1n`, module doc "TOTALS-ROUNDING TOLERANCE"). */
function diffPaise(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// ---------------------------------------------------------------------------
// phase 1 — locate the totals block, extract raw strings, ZERO arithmetic
// ---------------------------------------------------------------------------

/** Extracts the `Rebate on Total Value (%)` figure. The label and its value
 * wrap across up to three physical lines in five of the six letters
 * (`Rebate on Total Value` / `<value>` / `(%)`) and sit on one line in the
 * sixth (PL281) — rather than hand a shape per wrap pattern, this slices
 * the text strictly between the label and the next `Net Bid Value` label,
 * flattens it (text.ts's `flatten`, collapsing the wrap), and takes the
 * first decimal token in that window. `(%)` carries no digit, so it never
 * collides with the value itself regardless of which side of it prints
 * first. */
function extractRebateRaw(region: string): string | null {
  const labelIdx = region.indexOf(REBATE_LABEL);
  if (labelIdx === -1) {
    return null;
  }
  const searchFrom = labelIdx + REBATE_LABEL.length;
  const netIdx = region.indexOf(NET_BID_LABEL, searchFrom);
  const windowEnd =
    netIdx === -1 ? Math.min(region.length, searchFrom + 400) : netIdx;
  const window = region.slice(searchFrom, windowEnd);
  const m = DECIMAL_TOKEN_RE.exec(flatten(window));
  return m === null ? null : m[0];
}

function captureRawBlock(
  lines: readonly string[],
  scheduleTotalsLineIdx: readonly number[],
  totalValueLineIdx: number,
): string | null {
  if (scheduleTotalsLineIdx.length === 0 && totalValueLineIdx === -1) {
    return null;
  }
  const startIdx =
    scheduleTotalsLineIdx.length > 0
      ? Math.min(...scheduleTotalsLineIdx)
      : totalValueLineIdx;
  let endIdx = totalValueLineIdx === -1 ? startIdx : totalValueLineIdx;
  const scanLimit = Math.min(lines.length, endIdx + 8);
  for (let i = endIdx; i < scanLimit; i += 1) {
    if ((lines[i] ?? '').includes(NET_BID_LABEL)) {
      endIdx = i;
      break;
    }
  }
  const from = Math.max(0, startIdx);
  const to = Math.min(lines.length - 1, Math.max(endIdx, startIdx));
  return lines.slice(from, to + 1).join('\n');
}

/**
 * Phase 1 (module doc "CLASSIFY BEFORE COMPUTE"). Locates `Schedule Totals`
 * × N, the `Total Value` line, and `Rebate on Total Value (%)`, and returns
 * every figure/token it finds as a printed STRING or presence flag — no
 * addition, multiplication, or rounding happens here.
 */
export function parseTotalsBlockStructure(
  rawText: string,
): TotalsBlockStructure {
  const stripped = stripPrintFurniture(rawText);
  const markerIdx = stripped.indexOf(ITEM_TABLE_MARKER);
  const region = markerIdx === -1 ? stripped : stripped.slice(markerIdx);
  const lines = region.split('\n');

  const scheduleTotals: {
    scheduleId: string | null;
    totalRaw: string | null;
  }[] = [];
  const scheduleTotalsLineIdx: number[] = [];
  let currentScheduleId: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const headerMatch = SCHEDULE_HEADER_START_RE.exec(line);
    if (headerMatch !== null) {
      currentScheduleId = (headerMatch[1] ?? '').trim();
      continue;
    }
    const totalsMatch = SCHEDULE_TOTALS_LINE_RE.exec(line.trim());
    if (totalsMatch !== null) {
      scheduleTotals.push({
        scheduleId: currentScheduleId,
        totalRaw: totalsMatch[1] ?? null,
      });
      scheduleTotalsLineIdx.push(i);
    }
  }

  const totalValueLineIdx = lines.findIndex((l) =>
    TOTAL_VALUE_LINE_TEST_RE.test(l.trim()),
  );

  let advertisedRaw: string | null = null;
  let netRaw: string | null = null;
  let percentRaw: string | null = null;
  let percentTokenDirection: LetterPercentageDirectionValue | null = null;

  if (totalValueLineIdx !== -1) {
    const totalValueLine = (lines[totalValueLineIdx] ?? '').trim();
    const m = TOTAL_VALUE_LINE_PARSE_RE.exec(totalValueLine);
    if (m !== null) {
      advertisedRaw = m[1] ?? null;
      const restRaw = (m[2] ?? '').trim();
      const numbers = restRaw.match(DECIMAL_TOKEN_RE) ?? [];
      if (numbers.length === 1) {
        netRaw = numbers[0] ?? null;
      } else if (numbers.length === 2) {
        percentRaw = numbers[0] ?? null;
        netRaw = numbers[1] ?? null;
        const tokenWords = restRaw
          .replace(DECIMAL_TOKEN_RE, ' ')
          .replace(/%/g, ' ')
          .trim();
        percentTokenDirection =
          tokenWords.length > 0
            ? normalizeToken(tokenWords)
            : reconstructWrappedToken(lines, totalValueLineIdx);
      }
      // numbers.length === 0 or >= 3: rest is unrecognised — every field
      // above stays null, which classifyShapeKind treats as "no shape
      // matched" (criterion 6).
    }
  }

  const rebateRaw = extractRebateRaw(region);
  const rawBlockText = captureRawBlock(
    lines,
    scheduleTotalsLineIdx,
    totalValueLineIdx,
  );

  return {
    found: totalValueLineIdx !== -1 && advertisedRaw !== null,
    advertisedRaw,
    netRaw,
    percentRaw,
    percentTokenDirection,
    scheduleTotals,
    rebateRaw,
    rawBlockText,
  };
}

// ---------------------------------------------------------------------------
// phase 2 — classify the shape from structure alone, ZERO arithmetic
// ---------------------------------------------------------------------------

/**
 * Phase 2 (module doc "CLASSIFY BEFORE COMPUTE"). A pure function of
 * `TotalsBlockStructure` — inspects presence/shape only, computes nothing.
 * Research §1's rule, applied literally:
 *
 *   Shape A ("letter_percentage"): a percentage token was found AND every
 *   `Schedule Totals` line reads `0.00`.
 *   Shape B ("per_schedule"): NO percentage token, a net figure was found,
 *   AND at least one `Schedule Totals` line is non-zero.
 *
 * Any other combination (including the two ambiguous middle cases — a
 * token found but schedule totals are NOT all zero, or a bare net figure
 * but every schedule total reads `0.00`) is a CONTRADICTION between the two
 * independent signals research §1 gives, not a guessable third shape:
 * `null`, exactly per criterion 6 ("no fallback, no guess").
 */
export function classifyShapeKind(structure: TotalsBlockStructure): ShapeKind {
  if (!structure.found) {
    return null;
  }
  const allZero =
    structure.scheduleTotals.length > 0 &&
    structure.scheduleTotals.every((s) => isZeroAmount(s.totalRaw));
  const anyPopulated =
    structure.scheduleTotals.length > 0 &&
    structure.scheduleTotals.some((s) => !isZeroAmount(s.totalRaw));

  const hasPercentToken =
    structure.percentRaw !== null &&
    structure.percentTokenDirection !== null &&
    structure.netRaw !== null;
  const hasBareNetOnly =
    structure.percentRaw === null && structure.netRaw !== null;

  if (hasPercentToken && allZero) {
    return 'letter_percentage';
  }
  if (hasBareNetOnly && anyPopulated) {
    return 'per_schedule';
  }
  return null;
}

// ---------------------------------------------------------------------------
// phase 3 — arithmetic, dispatched STRICTLY by phase 2's result
// ---------------------------------------------------------------------------

/**
 * Shape-A arithmetic (research §1, SIGNED BY THE TOKEN):
 * `%Below`/`%At Par` -> `advertised * (1 - pct/100)`;
 * `%Above` -> `advertised * (1 + pct/100)`. Computed as an exact bigint
 * paisa numerator/denominator (never a JS float multiply), rounded
 * half-up to the nearest paisa. Note the parameter list: this function has
 * no `scheduleTotals` parameter at all — it CANNOT read Shape-B data
 * (module doc, phase 3).
 */
function computeLetterPercentageContract(
  advertisedPaisa: bigint,
  pctMilli: bigint,
  direction: LetterPercentageDirectionValue,
): bigint {
  // (1 +- pct/100) scaled by 100000 = 100 (the whole) * 1000 (pctMilli's
  // scale) -- see module doc "ARITHMETIC".
  const sign = direction === 'above' ? 1n : -1n;
  const scaledFactor = 100_000n + sign * pctMilli;
  const numerator = advertisedPaisa * scaledFactor;
  const denominator = 100_000n;
  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const quotient = absNumerator / denominator;
  const remainder = absNumerator % denominator;
  const roundedUp = remainder * 2n >= denominator;
  const rounded = roundedUp ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Shape-B arithmetic (research §1): plain summation, exact by construction
 * (every printed schedule total already carries exactly two decimal
 * places, so no rounding step — and therefore no rounding error — is
 * possible, the same reasoning items.ts's `reconcileItem` uses for
 * qty*rate). Note the parameter list: this function has no
 * `pct`/`direction` parameter at all — it CANNOT read Shape-A data (module
 * doc, phase 3).
 */
function computeScheduleSumContract(
  scheduleTotals: readonly { totalRaw: string | null }[],
): bigint | null {
  let sum = 0n;
  for (const entry of scheduleTotals) {
    if (entry.totalRaw === null) {
      return null;
    }
    const minor = parseDecimalToMinorUnits(entry.totalRaw, 2);
    if (minor === null) {
      return null;
    }
    sum += minor;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function toScheduleTotalsOutput(
  structure: TotalsBlockStructure,
): readonly ScheduleTotalEntry[] {
  return structure.scheduleTotals.map((s) => ({
    scheduleId: s.scheduleId,
    total: toNumberOrNull(s.totalRaw),
  }));
}

/** `true` iff the rebate figure parses and is non-zero — the ticket's
 * "raises needsReview for the contradiction" trigger (criterion 4). A
 * missing rebate field is NOT treated as a contradiction (defensive; every
 * real letter in the corpus carries it). */
function isContradictingRebate(rebateRaw: string | null): boolean {
  if (rebateRaw === null) {
    return false;
  }
  const minor = parseDecimalToMinorUnits(rebateRaw, 2);
  return minor !== null && minor !== 0n;
}

/** Criterion 6's fallback: `pricing_shape: null`, both printed figures
 * retained verbatim (never a computed/guessed value), raw block retained,
 * `needsReview: true`. Used both when phase 2 could not classify at all AND
 * when phase 3's arithmetic failed to reconcile with the printed figure
 * (`diff > 0.01`). */
function unrecognizedResult(
  structure: TotalsBlockStructure,
): PricingShapeResult {
  return {
    advertised_value: toNumberOrNull(structure.advertisedRaw),
    contract_value: toNumberOrNull(structure.netRaw),
    pricing_shape: null,
    letter_percentage: null,
    letter_percentage_direction: null,
    needsReview: true,
    divergence: null,
    scheduleTotals: toScheduleTotalsOutput(structure),
    rebateOnTotalValue: toNumberOrNull(structure.rebateRaw),
    rawTotalsBlock: structure.rawBlockText,
  };
}

/** Builds the `divergence` payload for a within-tolerance-but-nonzero gap
 * (module doc "TOTALS-ROUNDING TOLERANCE") — `diffMinor` is assumed already
 * checked to be in `(0n, 1n]` by the caller (a `0n` diff means no flag at
 * all, per the ruling: "a diff of exactly zero raises no flag"). */
function buildDivergence(
  printedMinor: bigint,
  computedMinor: bigint,
  diffMinor: bigint,
  rawTotalsBlock: string | null,
): TotalsRoundingDivergence {
  return {
    code: 'totals_rounding_divergence',
    printed: minorToNumber(printedMinor, 2),
    computed: minorToNumber(computedMinor, 2),
    diff: minorToNumber(diffMinor, 2),
    rawTotalsBlock,
  };
}

function computeLetterPercentageResult(
  structure: TotalsBlockStructure,
): PricingShapeResult {
  const advertisedPaisa = parseDecimalToMinorUnits(
    structure.advertisedRaw ?? '',
    2,
  );
  const printedNetPaisa = parseDecimalToMinorUnits(structure.netRaw ?? '', 2);
  const direction = structure.percentTokenDirection;
  const pctRaw = structure.percentRaw;
  const pctMilli = pctRaw === null ? null : parseDecimalToMinorUnits(pctRaw, 3);
  if (
    advertisedPaisa === null ||
    printedNetPaisa === null ||
    direction === null ||
    pctRaw === null ||
    pctMilli === null
  ) {
    return unrecognizedResult(structure);
  }
  const computedPaisa = computeLetterPercentageContract(
    advertisedPaisa,
    pctMilli,
    direction,
  );
  const diff = diffPaise(computedPaisa, printedNetPaisa);
  if (diff > 1n) {
    // criterion 6: "arithmetic that fails to reconcile within one paisa" —
    // fall back to the printed figures verbatim, never the (unreconciled)
    // computed one.
    return unrecognizedResult(structure);
  }
  // Ruling: the PRINTED figure always wins as contract_value once the shape
  // reconciles at all (diff <= 1n) -- the computed figure survives only in
  // `divergence`, which is `null` outright when diff is exactly zero (every
  // real corpus letter).
  const divergence =
    diff === 0n
      ? null
      : buildDivergence(
          printedNetPaisa,
          computedPaisa,
          diff,
          structure.rawBlockText,
        );
  // n1: `At Par` declares no percentage at all -- a nonzero printed pct
  // alongside it is a data contradiction even though the figures reconcile.
  const atParContradiction = direction === 'at_par' && pctMilli !== 0n;
  return {
    advertised_value: toNumberOrNull(structure.advertisedRaw),
    contract_value: minorToNumber(printedNetPaisa, 2),
    pricing_shape: 'letter_percentage',
    letter_percentage: toNumberOrNull(pctRaw),
    letter_percentage_direction: direction,
    needsReview:
      divergence !== null ||
      isContradictingRebate(structure.rebateRaw) ||
      atParContradiction,
    divergence,
    scheduleTotals: toScheduleTotalsOutput(structure),
    rebateOnTotalValue: toNumberOrNull(structure.rebateRaw),
    rawTotalsBlock: structure.rawBlockText,
  };
}

function computeScheduleSumResult(
  structure: TotalsBlockStructure,
): PricingShapeResult {
  const printedNetPaisa = parseDecimalToMinorUnits(structure.netRaw ?? '', 2);
  const sumPaisa = computeScheduleSumContract(structure.scheduleTotals);
  if (printedNetPaisa === null || sumPaisa === null) {
    return unrecognizedResult(structure);
  }
  const diff = diffPaise(sumPaisa, printedNetPaisa);
  if (diff > 1n) {
    return unrecognizedResult(structure);
  }
  const divergence =
    diff === 0n
      ? null
      : buildDivergence(
          printedNetPaisa,
          sumPaisa,
          diff,
          structure.rawBlockText,
        );
  return {
    advertised_value: toNumberOrNull(structure.advertisedRaw),
    contract_value: minorToNumber(printedNetPaisa, 2),
    pricing_shape: 'per_schedule',
    letter_percentage: null,
    letter_percentage_direction: null,
    needsReview:
      divergence !== null || isContradictingRebate(structure.rebateRaw),
    divergence,
    scheduleTotals: toScheduleTotalsOutput(structure),
    rebateOnTotalValue: toNumberOrNull(structure.rebateRaw),
    rawTotalsBlock: structure.rawBlockText,
  };
}

/**
 * The single public entry point (ticket: "classify the shape before
 * computing any value"). Runs phase 1 (locate/extract raw strings), then
 * phase 2 (`classifyShapeKind`, pure classification, zero arithmetic), then
 * dispatches to EXACTLY ONE of the two phase-3 arithmetic functions per
 * phase 2's result — see the module doc for why that dispatch is a
 * structural fact (the two arithmetic functions' parameter lists), not
 * just an `if`/`switch` a future edit could blur.
 */
export function classifyPricingShape(rawText: string): PricingShapeResult {
  const structure = parseTotalsBlockStructure(rawText);
  const kind = classifyShapeKind(structure);

  switch (kind) {
    case 'letter_percentage':
      return computeLetterPercentageResult(structure);
    case 'per_schedule':
      return computeScheduleSumResult(structure);
    case null:
      return unrecognizedResult(structure);
  }
}
