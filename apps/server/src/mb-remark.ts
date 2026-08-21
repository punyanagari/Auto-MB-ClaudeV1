/**
 * The MB remark algorithm — the contractual wording engine for Measurement
 * Book lines (spec: docs/reference/legacy-product-spec.md §"The MB remark
 * algorithm (contractual wording)"; ADR-0006 decision 5 and its consequence
 * that the remark renders from the finalised snapshot alone).
 *
 * Pure functions only: no database, no IO, no clock. Every quantity, percent,
 * rate, and amount is an exact decimal STRING; arithmetic runs over scaled
 * BigInt so no JavaScript float ever touches an authoritative value (the same
 * discipline as packages/loa-parser/src/decimal.ts, which this module cannot
 * reuse directly because remark quantities carry arbitrary — not fixed —
 * fractional scale).
 *
 * The regression contract is apps/server/test/fixtures/mb-remark-workbook.v1.json:
 * every expectedRemark must match this module's output character-for-character.
 */

/**
 * Version tag of the remark wording template. Finalized MBs snapshot the
 * rendered remark TEXT plus this version string; any change to the wording
 * rules in this module — punctuation, ordering, phrasing, rendering of
 * numbers — must bump this constant. Historical MBs are never re-rendered:
 * they keep the snapshotted text and the version they were rendered with.
 *
 * THE AMC PERIOD CLAUSE (owner ruling Q3, 2026-08-19) DOES NOT BUMP IT,
 * and the argument is the rule's own: what the version protects is that
 * no already-finalised MB's string could have been rendered differently.
 * The clause fires only when a line's schedule carries
 * `amc_billing_periods`, a column migration 0107 creates — so on every MB
 * finalised before it, the input is absent and this module's output is
 * character-for-character what v1 produced. The regression workbook
 * (`apps/server/test/fixtures/mb-remark-workbook.v1.json`) carries no
 * cadence and stays byte-green, which is the check that says so rather
 * than the claim.
 */
export const MB_REMARK_TEMPLATE_VERSION = 'mb-remark-v1';

/** The four payment stages, in the fixed contractual rendering order. */
export const MB_STAGE_ORDER = ['supply', 'installation', 'pac', 'final_bill'] as const;

type MbStage = (typeof MB_STAGE_ORDER)[number];

export interface MbRemarkStageInput {
  readonly stage: MbStage;
  /** Stage percentage from the payment-matrix snapshot, e.g. '80', '12.5'. */
  readonly percent: string;
  /**
   * True cumulative quantity billed for this stage across all prior
   * non-cancelled MBs (spec: "Cumulative means true cumulative").
   */
  readonly priorCumulativeQuantity: string;
  /** Quantity newly billed for this stage by THIS MB. */
  readonly deltaQuantity: string;
}

/**
 * An AMC item's billing cadence, when its schedule states one (migration
 * 0107). Present ONLY for AMC items on a schedule carrying
 * `amc_billing_periods`; absent everywhere else, which is every line the
 * template version below was authored against.
 */
export interface MbRemarkAmcCycle {
  /** Q — the sanctioned quantity the cadence divides. */
  readonly totalQuantity: string;
  /** M — how many billing periods it divides into. */
  readonly billingPeriods: number;
  /** The word the agency calls one period: 'quarter', 'month', 'visit'. */
  readonly cycleNoun: string;
}

interface MbRemarkInput {
  /** The item's unit string, rendered verbatim (e.g. 'mtr', 'Set', 'RMT'). */
  readonly unit: string;
  /**
   * At most one entry per stage, in ANY order — rendering always follows
   * MB_STAGE_ORDER. A stage may be omitted entirely (treated as absent).
   */
  readonly stages: ReadonlyArray<MbRemarkStageInput>;
  /**
   * When present, every fragment counts PERIODS instead of quantity: the
   * owner's Q3 ruling of 2026-08-19 keeps this engine's grammar and has
   * the AMC branch render period language INSIDE it — "Now to pay 95% for
   * 1 quarter." See `stageFragment` for the arithmetic and
   * MB_REMARK_TEMPLATE_VERSION for why this is not a version bump.
   */
  readonly amcCycle?: MbRemarkAmcCycle;
}

interface StageAmountInput {
  readonly stage: string;
  readonly percent: string;
  readonly deltaQuantity: string;
}

interface StageAmountsInput {
  /** The item's effective (snapshotted) rate as an exact decimal string. */
  readonly effectiveRate: string;
  readonly stages: ReadonlyArray<StageAmountInput>;
}

interface StageAmountsResult {
  /** One entry per input stage, in input order; amount has exactly 2 fraction digits. */
  readonly perStage: ReadonlyArray<{ readonly stage: string; readonly amount: string }>;
  /** Sum of the LINE-ROUNDED amounts (R13); exactly 2 fraction digits. */
  readonly total: string;
}

export interface FinalBillBaseInput {
  /**
   * The item's payment category (SUPPLY, SUPPLY_AND_INSTALLATION,
   * PURE_INSTALLATION, SPARE_SUPPLY, AMC) or null for an uncategorised
   * item.
   */
  readonly paymentCategory: string | null;
  /** The item description; only consulted for uncategorised items. */
  readonly description: string;
  /** Cumulative delivered quantity at final-MB time (issued DCs). */
  readonly deliveredQuantity: string;
  /** Cumulative installed quantity at final-MB time (non-cancelled installations). */
  readonly installedQuantity: string;
  /** Cumulative certified quantity at final-MB time (non-cancelled
   * acceptance certificates) for an AMC item — the final-bill base of an
   * item that is neither delivered nor installed.
   *
   * The name carries the restriction on purpose. Only the AMC branch
   * reads it, so it is filled only for AMC items and every other category
   * gets 0. It is deliberately NOT part of `ITEM_INPUTS_SQL`: that
   * statement is P11's six laterals and stays byte-identical to them, so
   * the certified read is its own statement, `loadAmcCertified`, issued
   * by `computeForBook` only when a final book actually holds an AMC item
   * (`routes/measurement-books/internal.ts`). A zero here means "not an
   * AMC item", never "certified nothing" — read the acceptance-certificate
   * aggregates directly if you want the certified total of an installable
   * item. */
  readonly amcCertifiedQuantity: string;
}

interface FinalBillBaseResult {
  readonly baseQuantity: string;
  readonly branch: 'delivered' | 'installed' | 'certified';
}

// ---------------------------------------------------------------------------
// Exact-decimal helper (scaled BigInt; arbitrary fractional scale)
// ---------------------------------------------------------------------------

interface ScaledDecimal {
  /** The value multiplied by 10^scale, exactly (sign included). */
  readonly units: bigint;
  /** Number of fractional digits captured in `units`. */
  readonly scale: number;
}

// eslint-disable-next-line security/detect-unsafe-regex -- fully anchored, two adjacent digit runs with no nested quantifier; linear on all inputs
const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string ('5000', '12.50', '0.005', '-1.2') into an
 * exact scaled-BigInt representation. Throws on anything else — the engine's
 * inputs are SQL numeric renderings and snapshot fields, so a malformed value
 * is a caller bug, never data to be guessed at.
 */
function parseDecimal(raw: string): ScaledDecimal {
  const m = DECIMAL_RE.exec(raw.trim());
  if (m === null) {
    throw new Error(`Not a plain decimal string: ${JSON.stringify(raw)}`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] ?? '0';
  const frac = m[3] ?? '';
  const units = sign * BigInt(whole + frac);
  return { units, scale: frac.length };
}

/** Rescales to exactly `scale` fractional digits; `scale` must be >= current. */
function rescale(value: ScaledDecimal, scale: number): ScaledDecimal {
  if (scale < value.scale) {
    throw new Error('rescale() must not lose precision');
  }
  return { units: value.units * 10n ** BigInt(scale - value.scale), scale };
}

/** True when the decimal string is strictly greater than zero. */
function isPositive(raw: string): boolean {
  return parseDecimal(raw).units > 0n;
}

/** Formats a scaled decimal back to a plain decimal string at its full scale. */
function formatScaled(value: ScaledDecimal): string {
  const negative = value.units < 0n;
  const abs = negative ? -value.units : value.units;
  const digits = abs.toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale);
  const sign = negative ? '-' : '';
  if (value.scale === 0) {
    return `${sign}${whole}`;
  }
  return `${sign}${whole}.${digits.slice(digits.length - value.scale)}`;
}

/**
 * Adds two plain decimal strings exactly; the result carries the larger of
 * the two scales (no trailing-zero trimming — that is renderQuantity's job).
 * Exported so cumulative quantities can be accumulated without floats.
 */
export function addDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const ra = rescale(pa, scale);
  const rb = rescale(pb, scale);
  return formatScaled({ units: ra.units + rb.units, scale });
}

/**
 * Multiplies two plain decimal strings exactly; the result carries the SUM of
 * the two scales, which is the exact scale of the product and never a rounded
 * one. No trailing-zero trimming — that is renderQuantity's job.
 *
 * Exported for the railway-measurement matcher (0111), which has to derive the
 * quantity IWRCMS prints on its measurement sheet: the railway states one
 * "Total" per item, and that figure is the stage quantity multiplied by the
 * stage percentage rather than the quantity itself. Deriving it in floating
 * point would put an authoritative comparison a rounding error away from
 * refusing a document that agrees, which is AGENTS.md rule 5 exactly.
 */
export function multiplyDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  return formatScaled({ units: pa.units * pb.units, scale: pa.scale + pb.scale });
}

/**
 * Rounds to exactly 2 fractional digits, half away from zero ("commercial"
 * rounding: 0.005 -> 0.01). This is the round2 of the stage-amount rule; the
 * snapshotted amounts make this choice permanent per MB.
 */
function roundToPaise(value: ScaledDecimal): bigint {
  return roundScaled(value, 2);
}

/** The same commercial rounding at an arbitrary scale. Money rounds at 2;
 * the railway's coefficient QUANTITY also rounds at 2 but is not money, so
 * the rule is stated once and parameterised rather than copied. */
function roundScaled(value: ScaledDecimal, scale: number): bigint {
  if (value.scale <= scale) {
    return rescale(value, scale).units;
  }
  const divisor = 10n ** BigInt(value.scale - scale);
  const quotient = value.units / divisor;
  const remainder = value.units % divisor;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= divisor) {
    return quotient + (value.units < 0n ? -1n : 1n);
  }
  return quotient;
}

/**
 * Rounds a plain decimal string to `scale` fractional digits, half away
 * from zero, returned at exactly that scale.
 *
 * Exported for the coefficient rendering (migration 0113). The railway's
 * own sheets print a SCALED quantity rounded to at most two decimals and
 * then multiply that figure by the rate, so reproducing their arithmetic
 * needs the rounding as a first-class step rather than as a side effect of
 * formatting.
 */
export function roundDecimalString(value: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new Error(`roundDecimalString: scale must be a non-negative integer`);
  }
  return formatScaled({ units: roundScaled(parseDecimal(value), scale), scale });
}

/** Formats an exact paise count as a decimal string with exactly 2 fraction digits. */
function formatPaise(paise: bigint): string {
  return formatScaled({ units: paise, scale: 2 });
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/**
 * Renders a decimal quantity string without trailing fractional zeros:
 * '5000.000' -> '5000', '12.50' -> '12.5', '0.500' -> '0.5'.
 */
export function renderQuantity(q: string): string {
  const parsed = parseDecimal(q);
  let { units, scale } = parsed;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return formatScaled({ units, scale });
}

/** Renders a percentage the same way as quantities: '12.50' -> '12.5'. */
export function renderPercent(p: string): string {
  return renderQuantity(p);
}

// ---------------------------------------------------------------------------
// The remark algorithm
// ---------------------------------------------------------------------------

function stagesInRenderOrder(
  stages: ReadonlyArray<MbRemarkStageInput>,
): ReadonlyArray<MbRemarkStageInput> {
  const byStage = new Map<MbStage, MbRemarkStageInput>();
  for (const entry of stages) {
    if (byStage.has(entry.stage)) {
      throw new Error(`Duplicate stage in remark input: ${entry.stage}`);
    }
    byStage.set(entry.stage, entry);
  }
  const ordered: MbRemarkStageInput[] = [];
  for (const stage of MB_STAGE_ORDER) {
    const entry = byStage.get(stage);
    if (entry !== undefined) {
      ordered.push(entry);
    }
  }
  return ordered;
}

/**
 * How many billing periods a quantity is, on a cadence that splits Q into
 * M periods: `quantity * M / Q`, in exact hundredths.
 *
 * IT NEVER ROUNDS A PART-PERIOD UP TO A WHOLE ONE. The remark is frozen
 * into a finalised Measurement Book and read as a contractual statement,
 * so a certificate covering half a quarter must not print "for 1
 * quarter". Only a value that is integral WITHIN THE SPLIT'S OWN WOBBLE
 * is rendered as an integer — the running-total split rounds each
 * cumulative to three decimals, so a whole period can arrive as
 * 0.9999 of one (Q=10, M=3: 3.333 * 3 / 10) and must still read "1".
 * That tolerance is a thousand times smaller than the smallest fraction
 * this could be asked to print, so it can never swallow a real
 * part-period.
 *
 * Anything else renders as a two-decimal fraction of a period ("0.5
 * quarters"), and a quantity that is not a period at all returns null,
 * which sends the caller back to the quantity fragment.
 */
const PERIOD_SCALE = 2;
const PERIOD_TOLERANCE_HUNDREDTHS = 1n; // 0.01 of a period

function periodsOf(quantity: string, cycle: MbRemarkAmcCycle): string | null {
  const q = parseDecimal(quantity);
  const total = parseDecimal(cycle.totalQuantity);
  if (total.units <= 0n || q.units <= 0n) {
    return null;
  }
  // quantity * M / Q, with both quantities rescaled to a common scale so
  // the ratio is scale-free, carried in hundredths of a period.
  const scale = Math.max(q.scale, total.scale);
  const numerator =
    rescale(q, scale).units *
    BigInt(cycle.billingPeriods) *
    10n ** BigInt(PERIOD_SCALE);
  const denominator = rescale(total, scale).units;
  const hundredths = (numerator * 2n + denominator) / (denominator * 2n);
  if (hundredths <= 0n) {
    return null;
  }
  const remainder = hundredths % 100n;
  if (remainder <= PERIOD_TOLERANCE_HUNDREDTHS) {
    return (hundredths / 100n).toString();
  }
  if (100n - remainder <= PERIOD_TOLERANCE_HUNDREDTHS) {
    return (hundredths / 100n + 1n).toString();
  }
  // Trailing zeros go, exactly as they do on a quantity: the grammar
  // reads "0.5 quarters", never "0.50 quarters".
  return renderQuantity(formatScaled({ units: hundredths, scale: PERIOD_SCALE }));
}

/** '<pct>% for <qty> <unit>' — the shared per-stage fragment of both
 * clauses. On an AMC cadence the quantity and unit become a period count
 * and the schedule's own word for a period ("95% for 1 quarter"), which
 * is the owner's Q3 ruling rendered inside this grammar rather than
 * beside it.
 *
 * ONLY ON THE ACCEPTANCE-CERTIFICATE STAGE. A maintenance cadence
 * divides the certified quantity and nothing else, so a supply or
 * installation delta on the same item — a delivery challan against a
 * maintenance schedule — would be counted against a Q it has no
 * relationship to. Those stages keep the item's own unit.
 *
 * A quantity the cadence cannot express as a period at all (a zero
 * total, or a quantity too small to be a hundredth of one) falls back to
 * the quantity, because a sentence saying "for 0 quarters" would be
 * worse than the number it replaced. */
function stageFragment(
  stage: MbStage,
  percent: string,
  quantity: string,
  unit: string,
  cycle: MbRemarkAmcCycle | undefined,
): string {
  if (cycle !== undefined && stage === 'pac') {
    const periods = periodsOf(quantity, cycle);
    if (periods !== null) {
      const noun = periods === '1' ? cycle.cycleNoun : `${cycle.cycleNoun}s`;
      return `${renderPercent(percent)}% for ${periods} ${noun}`;
    }
  }
  return `${renderPercent(percent)}% for ${renderQuantity(quantity)} ${unit}`;
}

/**
 * Builds the full contractual remark for one MB line.
 *
 * Prepaid clause: stages whose percent > 0 AND prior cumulative > 0, in fixed
 * stage order, joined ' and ', prefixed 'Prepaid ', ended with a full stop;
 * omitted entirely on the item's first-ever billing. Now-to-pay clause:
 * stages whose delta > 0, same format, prefixed 'Now to pay '; the fixed
 * stage order puts final_bill last, as the contract requires; when no stage
 * has a delta the clause is exactly 'Now to pay nill.' ('nill', double-l).
 * Clauses are joined with a single space.
 */
export function computeMbRemark(input: MbRemarkInput): string {
  const ordered = stagesInRenderOrder(input.stages);

  const prepaid = ordered
    .filter((s) => isPositive(s.percent) && isPositive(s.priorCumulativeQuantity))
    .map((s) =>
      stageFragment(
        s.stage,
        s.percent,
        s.priorCumulativeQuantity,
        input.unit,
        input.amcCycle,
      ),
    );

  const nowToPay = ordered
    .filter((s) => isPositive(s.deltaQuantity))
    .map((s) =>
      stageFragment(s.stage, s.percent, s.deltaQuantity, input.unit, input.amcCycle),
    );

  const clauses: string[] = [];
  if (prepaid.length > 0) {
    clauses.push(`Prepaid ${prepaid.join(' and ')}.`);
  }
  clauses.push(
    nowToPay.length > 0 ? `Now to pay ${nowToPay.join(' and ')}.` : 'Now to pay nill.',
  );
  return clauses.join(' ');
}

/**
 * Stage amounts: per stage round2(delta × rate × pct / 100) computed exactly
 * over scaled BigInt, each LINE rounded to paise first and the total taken as
 * the sum of the rounded lines (R13 — never round the sum independently).
 * Amounts render with exactly 2 fraction digits. perStage preserves the
 * caller's stage order and passes stage labels through verbatim.
 */
export function computeStageAmounts(input: StageAmountsInput): StageAmountsResult {
  const rate = parseDecimal(input.effectiveRate);
  const perStage: { stage: string; amount: string }[] = [];
  let totalPaise = 0n;
  for (const entry of input.stages) {
    const delta = parseDecimal(entry.deltaQuantity);
    const percent = parseDecimal(entry.percent);
    // delta × rate × pct / 100: dividing by 100 adds exactly 2 to the scale.
    const product: ScaledDecimal = {
      units: delta.units * rate.units * percent.units,
      scale: delta.scale + rate.scale + percent.scale + 2,
    };
    const paise = roundToPaise(product);
    totalPaise += paise;
    perStage.push({ stage: entry.stage, amount: formatPaise(paise) });
  }
  return { perStage, total: formatPaise(totalPaise) };
}

/**
 * Resolves the quantity base of the final-bill stage (billed only on the
 * final MB), per the spec's final-bill-stage-base rule and the workbook's
 * three special notes: SUPPLY and SPARE_SUPPLY items — and uncategorised
 * items whose description does not mention 'installation' (case-insensitive)
 * — earn the final percentage on 100% of the DELIVERED quantity,
 * irrespective of installation. SUPPLY_AND_INSTALLATION and
 * PURE_INSTALLATION items — and uncategorised items that do mention
 * installation — earn it on the INSTALLED quantity only:
 * supplied-but-never-installed material earns its supply stage and nothing
 * more.
 *
 * AMC items (migration 0068) earn it on the CERTIFIED quantity. They are
 * never delivered and never installed, so both of the workbook's two
 * bases are permanently zero for them; the quantity an annual
 * maintenance item has actually earned is the one the railway certified.
 * The workbook has no note for this case because the agency's example
 * carried no maintenance schedule — this branch is the same principle
 * applied to the dimension AMC moves on, not a rule read off the paper.
 */
export function resolveFinalBillBase(input: FinalBillBaseInput): FinalBillBaseResult {
  let branch: FinalBillBaseResult['branch'];
  switch (input.paymentCategory) {
    case 'SUPPLY':
    case 'SPARE_SUPPLY':
      branch = 'delivered';
      break;
    case 'SUPPLY_AND_INSTALLATION':
    case 'PURE_INSTALLATION':
      branch = 'installed';
      break;
    case 'AMC':
      branch = 'certified';
      break;
    // The residual category and "nothing chosen yet" take the same
    // branch, and they take it for the same reason: neither says what
    // the item MOVES on, so the description is the only evidence there
    // is. Migration 0105 split them apart as billing STATES — an
    // UNCATEGORISED item bills through the Work's residual row, a NULL
    // one bills nothing until it is answered — but that split says
    // nothing about which quantity a final bill is earned on, so the
    // reading here is deliberately shared rather than duplicated.
    //
    // A NULL item never actually reaches this function today: it fails
    // to resolve percentages first and the Measurement Book refuses to
    // finalize. The arm stays because the draft PREVIEW computes before
    // it refuses, and a preview that threw would answer a 500 where the
    // operator should be reading the list of items to categorise.
    case 'UNCATEGORISED':
    case null:
      branch = input.description.toLowerCase().includes('installation')
        ? 'installed'
        : 'delivered';
      break;
    default:
      throw new Error(
        `Unknown payment category: ${JSON.stringify(input.paymentCategory)}`,
      );
  }
  const baseByBranch = {
    delivered: input.deliveredQuantity,
    installed: input.installedQuantity,
    certified: input.amcCertifiedQuantity,
  } as const;
  return { branch, baseQuantity: baseByBranch[branch] };
}
