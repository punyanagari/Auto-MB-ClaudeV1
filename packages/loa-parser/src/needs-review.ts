/**
 * @auto-mb/loa-parser — the `needsReview` trigger set (DC-26; legacy ticket DC-26;
 * docs/reference/loa-parser-contract.md §4 "Traps that must raise
 * `needsReview` rather than parse silently", §5 "Unexercised template
 * branches").
 *
 * This module never re-parses raw text where a sibling module already owns
 * the field: it composes `extractHeader` (header.ts), `parseItems`
 * (items.ts) and `classifyPricingShape` (pricing-shape.ts) and layers a
 * SECOND pass of review triggers on top of their output, plus a small set of
 * text-scans for prose that no sibling module extracts as a field at all
 * (the corrigendum keyword, the item-naming corrigendum sentence, the
 * `Item Breakup` / `Banned` template sections). PRODUCT-SPEC §5.1's "never
 * discards information" contract is upheld by construction here: every flag
 * this module produces is ADDITIVE — a record alongside the already-parsed
 * data, never a replacement for it, and never a reason to drop a field.
 *
 * FLAG SHAPE (ticket, verbatim): `{ code, scope: 'letter'|'schedule'|'item',
 * targetId, rawBlock, message }`. A `detail` field carries the two
 * ticket-specified structured payloads (`ProposedUnitCorrection`,
 * `QtyDecomposition`) where a criterion calls for one — still additive, never
 * instead of the four required fields.
 *
 * NEVER AUTO-COMMIT (ticket "Additional required behaviour"; PRODUCT-SPEC
 * §5.1 step 2, "extraction always lands on a review screen"): this module's
 * only public surface is `reviewLoaLetter`, which returns a
 * `LoaReviewPayload` — header + items + pricingShape + flags + a
 * `needsReview` roll-up. There is no function here, or anywhere in this
 * package's public surface (`src/index.ts`), that writes a `work`, a
 * `schedule`, or a `work_item` row; `test/needs-review.test.ts`'s
 * `never-auto-commit` block proves this by scanning the package's exported
 * identifier names, not just by this module's own restraint.
 */
import { preview } from './field.js';
import { stripPrintFurniture } from './furniture.js';
import { extractHeader, type LoaHeader } from './header.js';
import { type ParsedItem, parseItems } from './items.js';
import { classifyPricingShape, type PricingShapeResult } from './pricing-shape.js';
import { flatten, paragraphs } from './text.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';

// ---------------------------------------------------------------------------
// public shape
// ---------------------------------------------------------------------------

export type ReviewFlagScope = 'letter' | 'schedule' | 'item';

/** Every trigger this module raises, one code per ticket criterion (plus the
 * defensive-branch and banned-items-block codes from "Additional required
 * behaviour"). Kept as a closed union (rather than a bare `string`) so a
 * typo in a new trigger's code fails `tsc`, not a runtime assertion. */
export type FlagCode =
  | 'prose_corrigendum'
  | 'prose_unit_correction'
  | 'prose_qty_decomposition'
  | 'prose_payment_terms'
  | 'unresolved_item_description'
  | 'unresolved_unit'
  | 'item_code_namespace_mismatch'
  | 'layout_junk'
  | 'unexpected_item_breakup'
  | 'unexpected_rebate'
  | 'unexpected_above_par'
  | 'banned_items_block';

/** Criterion 1's structured payload: PL280's corrigendum proposes correcting
 * a printed unit in PROSE, and the parser must never apply the override —
 * both values are retained, verbatim, for the DC-28 human to resolve. */
export interface ProposedUnitCorrection {
  readonly printed_unit: string;
  readonly proposed_unit: string;
  readonly source: 'prose';
}

/** Criterion 2's structured payload. `base_qty` is the DELIVERABLE — the
 * ticket's own framing ("the Qty column says 48, the deliverable is 2") —
 * and `multiplier` is the recurring factor (PL273: always 24, the AMC's
 * month count) such that `multiplier * base_qty` equals the printed Qty
 * column exactly on all four real occurrences (verified: item 1
 * `24 * 2 = 48`, item 2 `24 * 2 = 48`, item 3 `24 * 4 = 96`, item 4
 * `24 * 2 = 48`). `base_unit` is the LEFT-hand unit word in the prose
 * (`"set"`/`"nos"`), i.e. the unit the deliverable count is denominated in —
 * distinct from the printed Qty column's own unit (`"Month"`), which is a
 * billing artifact of the AMC structure, not the deliverable's unit. R4's
 * delivery cap must be read against `base_qty`, never the printed Qty
 * column. */
export interface QtyDecomposition {
  readonly multiplier: number;
  readonly base_qty: number;
  readonly base_unit: string;
  readonly source: 'prose';
}

/** Every flag is additive: a record alongside already-parsed data, never a
 * replacement for it (ticket, verbatim shape). `detail` carries a
 * criterion-specific structured payload where one is called for
 * (criteria 1, 2) — still additive; the four required fields are always
 * present regardless of whether `detail` is. */
export interface ReviewFlag {
  readonly code: FlagCode;
  readonly scope: ReviewFlagScope;
  readonly targetId: string;
  readonly rawBlock: string;
  readonly message: string;
  readonly detail?:
    ProposedUnitCorrection | QtyDecomposition | Readonly<Record<string, unknown>>;
}

/** "Extraction output carries a `needsReview` roll-up: total flag count,
 * counts by code, and whether any letter-level flag exists" (ticket,
 * "Additional required behaviour"). */
export interface NeedsReviewRollup {
  readonly total: number;
  readonly byCode: Readonly<Record<string, number>>;
  readonly anyLetterLevel: boolean;
}

/** The parser's public review payload (PRODUCT-SPEC §5.1 step 2: "extraction
 * always lands on a review screen"). This is the ONLY shape this module's
 * entry point returns — nothing here writes a `work`. */
export interface LoaReviewPayload {
  readonly header: LoaHeader;
  readonly items: readonly ParsedItem[];
  readonly pricingShape: PricingShapeResult;
  readonly flags: readonly ReviewFlag[];
  readonly needsReview: NeedsReviewRollup;
}

export interface ReviewLoaOptions {
  /** Poppler `pdftotext -raw` output from the same PDF as `rawText`. */
  readonly rawItemText?: string;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** A stable per-item identifier for `targetId` — `<scheduleId>#<itemSno>`,
 * or `UNBOUND#<itemSno>` for the (corpus-unexercised) unbound-schedule case
 * items.ts's own `malformedItem` fallback can produce. Not asserted globally
 * unique (PL275's schedule A and B both print item numbers that can collide
 * across schedules in principle — research §4.5, "codes are unique only
 * within a directory" applies the same way to serials) — this exists for
 * human-readable review targeting, not as a database key. */
function itemTargetId(item: ParsedItem): string {
  return `${item.schedule?.id ?? 'UNBOUND'}#${item.itemSno}`;
}

function headerRegion(rawText: string): string {
  const stripped = stripPrintFurniture(rawText);
  const markerIdx = stripped.indexOf(ITEM_TABLE_MARKER);
  return markerIdx === -1 ? stripped : stripped.slice(0, markerIdx);
}

// ---------------------------------------------------------------------------
// criterion 1 — prose corrigenda that contradict the table
// ---------------------------------------------------------------------------

// Case-insensitive, ticket-verbatim keyword set. Scans the WHOLE letter
// (never just the header block): PL275's own trigger occurrence
// ("Note: The installation ...") sits INSIDE the item-table region
// (fixture line 192, past the `Awarded Quantities And Rates` marker), so a
// header-only scan would silently miss it — exactly the "run against the
// real corpus where the corpus contains the case" failure this ticket
// exists to prevent.
const CORRIGENDUM_KEYWORDS_RE =
  /NOTE:|clarification|corrigendum|to be read as|oversight/i;

/** Criterion 1's letter-level half: any letter containing one of the five
 * keywords raises ONE letter-level flag (never per-occurrence — a letter
 * either carries corrigendum-shaped prose or it doesn't). Exercised by the
 * real corpus on three letters: PL280 (`NOTE:` / `oversight` /
 * `clarification` — the genuine unit-correction corrigendum), and PL273 /
 * PL275 (both carry an unrelated `Note:` — stamp-duty guidance and an
 * installation-responsibility note respectively, neither naming an item) —
 * the keyword trigger is deliberately broad; criterion 1's item-naming
 * half (`detectCorrigendumItemUnitCorrections`, below) is what narrows to
 * the one real unit-correction case. */
export function detectCorrigendumKeyword(
  rawText: string,
  letterTargetId: string,
): readonly ReviewFlag[] {
  const stripped = stripPrintFurniture(rawText);
  if (!CORRIGENDUM_KEYWORDS_RE.test(stripped)) {
    return [];
  }
  const paras = paragraphs(stripped);
  const para = paras.find((p) => CORRIGENDUM_KEYWORDS_RE.test(p));
  const rawBlock = para ?? preview(stripped);
  return [
    {
      code: 'prose_corrigendum',
      scope: 'letter',
      targetId: letterTargetId,
      rawBlock,
      message:
        'Letter contains prose corrigendum/clarification language (NOTE:/clarification/corrigendum/"to be read as"/oversight) that may contradict a printed field elsewhere in the table -- review before trusting any field it touches.',
    },
  ];
}

// The corpus's ONE evidenced item-naming corrigendum (PL280 only, verified
// unique: no other fixture contains "has been indicated as per" or "now be
// read as per" at all). A future letter phrasing this differently needs its
// own pattern -- this function is deliberately narrow rather than a
// speculative general-purpose "extract item numbers from arbitrary prose"
// parser, per this ticket's own charter (test against what the corpus
// PROVES, not a guessed general case).
const CORRIGENDUM_ITEM_UNIT_RE =
  /Item\s+Nos?\.\s*(.+?)\s+in\s+Schedule\s+([A-Za-z0-9]+)\s+has\s+been\s+indicated\s+as\s+per\s+(\w+)\s+and\s+it\s+is\s+now\s+be\s+read\s+as\s+per\s+(\w+)/i;

/** Parses an "N to M and K, L" style item-number list (the only shape the
 * corpus proves: PL280's "1 to 6 and 12") into a de-duplicated, ascending
 * array of item numbers. Splits on `,` and `and` (either as a list
 * separator), then resolves each segment as either an inclusive `N to M`
 * range or a single number. */
export function parseItemNumberList(text: string): readonly number[] {
  const numbers = new Set<number>();
  const segments = text
    .split(/\s*,\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    const range = /^(\d+)\s+to\s+(\d+)$/i.exec(segment);
    if (range !== null) {
      const start = Number.parseInt(range[1] ?? '', 10);
      const end = Number.parseInt(range[2] ?? '', 10);
      for (let n = start; n <= end; n += 1) {
        numbers.add(n);
      }
      continue;
    }
    const single = /^(\d+)$/.exec(segment);
    if (single !== null) {
      numbers.add(Number.parseInt(single[1] ?? '', 10));
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

/** Criterion 1's item-level half. Never applies the proposed correction —
 * both `printed_unit` and `proposed_unit` are retained on the flag's
 * `detail`, and every named item's ALREADY-PARSED fields (including its
 * printed `qtyUnit`) are left completely untouched; the human confirms at
 * review (DC-28). */
export function detectCorrigendumItemUnitCorrections(
  rawText: string,
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  const flat = flatten(stripPrintFurniture(rawText));
  const m = CORRIGENDUM_ITEM_UNIT_RE.exec(flat);
  if (m === null) {
    return [];
  }
  const scheduleId = (m[2] ?? '').trim();
  const printedUnit = (m[3] ?? '').trim();
  const proposedUnit = (m[4] ?? '').trim();
  const itemNumbers = parseItemNumberList((m[1] ?? '').trim());
  const rawBlock = m[0];

  const flags: ReviewFlag[] = [];
  for (const item of items) {
    if (item.schedule?.id !== scheduleId) {
      continue;
    }
    const sno = Number.parseInt(item.itemSno, 10);
    if (!itemNumbers.includes(sno)) {
      continue;
    }
    const detail: ProposedUnitCorrection = {
      printed_unit: printedUnit,
      proposed_unit: proposedUnit,
      source: 'prose',
    };
    flags.push({
      code: 'prose_unit_correction',
      scope: 'item',
      targetId: itemTargetId(item),
      rawBlock,
      message: `Prose corrigendum proposes correcting this item's unit description from "${printedUnit}" to "${proposedUnit}" -- the parser records BOTH values and does NOT apply the override; a human confirms which unit is correct at review (DC-28).`,
      detail,
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// criterion 2 — quantity decomposed in prose, not columns
// ---------------------------------------------------------------------------

// "(Qty = <base_qty> <base_unit> x <multiplier> <unit> = <total> <unit>)" —
// PL273's four occurrences, verified: `total` equals the printed Qty column
// on every one (item 1 `2*24=48`, item 2 `2*24=48`, item 3 `4*24=96`, item 4
// `2*24=48`).
const QTY_DECOMPOSITION_RE =
  /\(Qty\s*=\s*(\d+)\s+([A-Za-z]+)\s*x\s*(\d+)\s+([A-Za-z]+)\s*=\s*(\d+)\s+([A-Za-z]+)\)/gi;

/**
 * Criterion 2. Uses the LAST match in `item.description`, never the first.
 * Production `raw-exact` descriptions normally contain only their own
 * clause. The conservative layout-only fallback still intentionally
 * OVERLAPS adjacent descriptions (`description` is assembled as
 * `aboveLines + descOnLine + belowLines`, and the physical lines between two
 * anchors are shared: item N's `belowLines` and item N+1's `aboveLines`
 * cover the identical range, pinned by `test/item-anchor.test.ts`'s
 * "adjacent items' descriptions intentionally overlap" case). Concretely:
 * item 2's `description` contains BOTH item 1's decomposition parenthetical
 * (leaked in via item 2's `aboveLines`, appearing FIRST in the assembled
 * string) and item 2's own (in its `belowLines`, appearing LAST) — verified
 * against all four PL273 occurrences: taking the first match shifts EVERY
 * item onto its PRECEDING item's tuple (item 2 shows item 1's `2 set`; item
 * 3 shows item 2's `2 nos`; item 4 shows item 3's `4 nos` — an off-by-one
 * misattribution, not one shared wrong value repeated); taking the LAST
 * match recovers each item's own tuple exactly, and `multiplier * base_qty`
 * reconciles to the printed Qty column on every one. This asymmetry (own
 * text always sits after any leaked neighbour text, by construction of the
 * above/below join order) is why "last", not "first", is correct rather
 * than an arbitrary tiebreak.
 */
export function detectQtyDecomposition(
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const item of items) {
    const matches = [...item.description.matchAll(QTY_DECOMPOSITION_RE)];
    const last = matches[matches.length - 1];
    if (last === undefined) {
      continue;
    }
    const baseQty = Number.parseInt(last[1] ?? '', 10);
    const baseUnit = (last[2] ?? '').trim();
    const multiplier = Number.parseInt(last[3] ?? '', 10);
    const detail: QtyDecomposition = {
      multiplier,
      base_qty: baseQty,
      base_unit: baseUnit,
      source: 'prose',
    };
    flags.push({
      code: 'prose_qty_decomposition',
      scope: 'item',
      targetId: itemTargetId(item),
      rawBlock: last[0],
      message: `Printed Qty column (${item.qty} ${item.qtyUnit ?? ''}) is a decomposed prose product: ${String(baseQty)} ${baseUnit} x ${String(multiplier)} -- the deliverable is ${String(baseQty)} ${baseUnit}, not the printed Qty column; R4's delivery cap must read against the deliverable.`,
      detail,
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// criterion 3 — payment terms embedded in description prose
// ---------------------------------------------------------------------------

const PAYMENT_TERMS_PROSE_RE = /Payment\s*Terms\s*:/i;

/** Criterion 3. Deliberately a presence check, not an extraction: PL275
 * embeds a `Payment Terms: NN%` clause in nearly every one of its 45 items'
 * own description prose (42/45, self-consistently re-measured in
 * `test/needs-review.test.ts` from the same `parseItems` output this
 * function reads, never a hand-copied count) -- R10's payment matrix must
 * sum to 100 and its source here is prose, not a column, so every item
 * whose payment terms are stated only in prose is flagged for the reviewer
 * to set the category. Unlike criterion 2, over-inclusion from the
 * above/below description overlap (module doc, `detectQtyDecomposition`) is
 * not a correctness risk here -- the flag's job is "there is payment-terms
 * prose near this item, resolve it", not "extract an exact percentage", so
 * a neighbour's leaked clause still points the reviewer at real, relevant
 * prose. */
export function detectPaymentTermsProse(
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const item of items) {
    if (!PAYMENT_TERMS_PROSE_RE.test(item.description)) {
      continue;
    }
    flags.push({
      code: 'prose_payment_terms',
      scope: 'item',
      targetId: itemTargetId(item),
      rawBlock: item.description,
      message:
        'Payment terms are stated in item-description prose, not a column -- R10 requires the payment matrix to sum to 100; the reviewer must set the payment category for this item.',
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// criterion 4 — dirty unit vocabulary (design choice documented below)
// ---------------------------------------------------------------------------

/**
 * DESIGN CHOICE (ticket criterion 4, "pick the design that keeps
 * normalisation OUT of the parser; document the choice"): `packages/loa-parser`
 * cannot import `packages/db` (this package's purity contract,
 * `test/corpus-manifest.test.ts`'s purity block), so "resolves against the
 * units master" cannot mean querying it. Of the two designs the ticket
 * names, this module takes the FIRST: it carries the 12 canonical DISPLAY
 * spellings as the recognition set, and resolves a printed unit ONLY on an
 * EXACT match against one of those twelve strings.
 *
 * THE DEPENDENCY RUNS FROM THE DATABASE TO THIS LIST, NOT THE OTHER WAY.
 * There is no global units seed in any migration:
 * `packages/db/migrations/0013_masters_profile.sql` creates `unit_masters`
 * as a TENANT-OWNED table and says in its own header that it deliberately
 * carries no seed. Each organisation's defaults are inserted lazily by
 * `apps/server/src/routes/masters.ts`, which imports `CANONICAL_UNIT_NAMES`
 * from this file and inserts it with `ON CONFLICT DO NOTHING`. So the list
 * below is the authority the database tracks, and editing it changes what
 * new organisations are seeded with — it is not a copy of anything.
 *
 * It is NOT a synonym table: `Mtr`, `Nos`, `Km`, and the wrapped
 * `Route Kilo Meter (RKM)` spelling are description-prose / wrap-harvest
 * aliases that deliberately do NOT appear as keys or values anywhere below,
 * and deliberately do NOT resolve here. No alias table exists anywhere in
 * the product either: an alias spelling stays unresolved, gets flagged, and
 * the reviewer picks the intended unit from the organisation's Units master
 * by hand. `test/needs-review.test.ts` proves this two ways: behaviourally
 * (`resolveCanonicalUnitCode('Mtr')` etc. all return `null`) and by
 * source-scan (this file, comments stripped, contains none of those alias
 * spellings as a quoted string literal).
 *
 * The second design the ticket names ("emits null for anything non-canonical
 * and leaves resolution entirely to the db layer") collapses to the same
 * OBSERVABLE behaviour here: this module already emits `null` for every
 * printed unit that is not one of the twelve exact canonical strings
 * (including every alias spelling) — there is no code path in this module
 * that treats an alias as anything other than unresolved. The choice
 * actually made is which POSITIVE information survives on the flag: this
 * design keeps the resolved CODE (`'METRE'`, ...) for the items that DO
 * match exactly, so a reviewer/consumer never has to re-derive "this one
 * resolved cleanly" by re-running the check.
 */
const CANONICAL_UNIT_CODES: ReadonlyMap<string, string> = new Map([
  ['Numbers', 'NUMBERS'],
  ['Metre', 'METRE'],
  ['RMT', 'RMT'],
  ['Year', 'YEAR'],
  ['Month', 'MONTH'],
  ['Pair', 'PAIR'],
  ['Kilometre', 'KILOMETRE'],
  ['Set', 'SET'],
  ['Lumpsum', 'LUMPSUM'],
  ['Lot', 'LOT'],
  ['Job', 'JOB'],
  ['Route Kilometre', 'ROUTE_KILOMETRE'],
]);

/** The twelve canonical DISPLAY spellings this module recognises, in
 * recognition-set order. Exported because it IS the seed:
 * `apps/server/src/routes/masters.ts` inserts these names into a new
 * organisation's `unit_masters`, and `test/needs-review.test.ts` asserts
 * the count is still twelve, so neither side hand-copies the list. */
export const CANONICAL_UNIT_NAMES: readonly string[] = [...CANONICAL_UNIT_CODES.keys()];

/** Resolves `printedUnit` to its DC-45 canonical CODE on an EXACT match
 * only, or `null` — never a guess, never an alias lookup (module doc
 * above). `null` input (the unresolved-wrapped-unit-harvest case items.ts
 * itself can produce) resolves to `null`, not a thrown error. */
export function resolveCanonicalUnitCode(printedUnit: string | null): string | null {
  if (printedUnit === null) {
    return null;
  }
  return CANONICAL_UNIT_CODES.get(printedUnit) ?? null;
}

/** Criterion 4. Flags every item whose printed unit column does not resolve
 * against the canonical recognition set above. Exercised by the real
 * corpus on exactly one item, corpus-wide: PL276-GTL's RKM item (schedule
 * B1, item 13) — its wrapped-harvest printed unit reads verbatim `"Route
 * Kilo Meter (RKM)"`, a DIFFERENT literal string from the canonical
 * `"Route Kilometre"` display spelling, so it is (correctly, per research
 * §4.4's own framing: "the wrapped unit is itself a `needsReview`-grade
 * trap") unresolved here even though a human reading the review screen can
 * read it unambiguously and pick the intended unit. */
export function detectUnresolvedUnits(
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const item of items) {
    const resolved = resolveCanonicalUnitCode(item.qtyUnit);
    if (resolved !== null) {
      continue;
    }
    flags.push({
      code: 'unresolved_unit',
      scope: 'item',
      targetId: itemTargetId(item),
      rawBlock: item.raw.anchorLine,
      message: `Printed unit ${JSON.stringify(item.qtyUnit)} does not exactly match a canonical unit spelling -- select the intended unit from your organisation's Units master or confirm it during review.`,
      detail: { printedUnit: item.qtyUnit },
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// criterion 5 — item-code namespace mismatch
// ---------------------------------------------------------------------------

// research §4.5: SOR schedules carry 8-digit codes (13010300); non-SOR carry
// short alphanumeric codes (S01) or a bare serial. "Codes are unique only
// within a directory" (DC-25's own module doc, same citation).
const SOR_SHAPED_CODE_RE = /^\d{8}$/;

/**
 * READING CHOSEN, RATIFIED (originally an implementer reading under ticket
 * ambiguity per AGENTS.md non-negotiable 6 -- a data-quality heuristic, not
 * a numbering/challan/invoice/approval decision, so resolved here rather
 * than escalated to the CEO; the manager RATIFIED this reading 2026-08-05
 * and amended legacy ticket DC-26 criterion 5 to state it directly, replacing
 * the originally ambiguous disjunctive sentence): the trigger is ONE
 * condition -- an 8-digit SOR-shaped code found under a schedule whose
 * `Item Directory` is null (`Not Applicable`) or otherwise non-SOR -- never
 * "any code under a Not Applicable directory" as an independent condition
 * of its own. The rejected literal reading was MEASURED before rejection
 * (re-verified at ratification): 260 of the corpus's 281 items (92.5%) sit
 * under a "Not Applicable" directory -- every schedule except PL275's one
 * genuine SOR schedule, including PL276's schedules literally NAMED
 * "(SOR Items)" that nonetheless print `Item Directory - Not Applicable`
 * and carry no 8-digit codes at all. A trigger firing on 92.5% of the
 * corpus is noise, not review signal, inconsistent with every other DC-26
 * trigger's narrow, corpus-proven-trap shape (criterion 4 flags 1/281; the
 * rejected reading here would flag 260/281 -- both figures re-measured
 * independently in `test/needs-review.test.ts`'s per-letter regression, not
 * asserted on faith). The ratified reading also matches DC-25's OWN
 * precedent test ("item codes are unique only within a directory",
 * item-anchor.test.ts) which engineers exactly this shape -- an SOR-shaped
 * code mutated onto a non-SOR (`directory: null`) schedule -- as its
 * regression case.
 *
 * Unexercised by the real corpus under the ratified reading (measured:
 * every one of the corpus's 21 genuine 8-digit codes sits under PL275's one
 * real SOR directory, "SOR SNT NWR-Ver-2020"; zero natural collisions
 * exist; the corpus raises ZERO criterion-5 flags, per-letter, under this
 * trigger) -- proved instead by the amendment's required synthetic case: the
 * same real-fixture, single-token, in-memory mutation DC-25's own test uses
 * (`test/needs-review.test.ts`), never a wholly fabricated fixture.
 */
export function detectItemCodeNamespaceMismatch(
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const item of items) {
    const directory = item.schedule?.directory ?? null;
    if (directory !== null || !SOR_SHAPED_CODE_RE.test(item.itemCode)) {
      continue;
    }
    flags.push({
      code: 'item_code_namespace_mismatch',
      scope: 'item',
      targetId: itemTargetId(item),
      rawBlock: item.raw.anchorLine,
      message: `Item code "${item.itemCode}" is 8-digit SOR-shaped but its schedule's directory is "Not Applicable" (non-SOR) -- codes are unique only within a directory (research §4.5); this shape/directory pairing is a namespace mismatch.`,
      detail: { itemCode: item.itemCode, directory },
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// criterion 6 — layout junk / unparseable token, description or numeric column
// ---------------------------------------------------------------------------

// Corpus-derived, NOT a general "any non-ASCII character" filter -- that
// would misfire on legitimate technical-spec unicode already present and
// VERIFIED CONTENT in the real corpus: PL275's "3 ¾ digit" clamp-meter
// fraction, and PL276's "•" bulleted feature lists (a real, ~14-occurrence
// bulleted-list rendering, not junk). "©" is the one glyph measured across
// the six-letter corpus that is not legitimate content -- PL275 Schedule A
// item 1's description, mid-sentence, almost certainly a pdftotext -layout
// mis-rendering of a "(c)" list marker (the item's other list markers read
// "(a)", "(b)", "(d)", "(e)" — "(c)" is the one missing, exactly where "©"
// sits). items.ts's own module doc already names this exact character as
// the corpus's stray-token example.
const LAYOUT_JUNK_GLYPHS_RE = /[©]/;

/**
 * Criterion 6, both halves. The description half is exercised by the real
 * corpus (PL275 item 1, above). The numeric-column half — an anchor line
 * whose numeric columns could not be decomposed at all — is UNEXERCISED by
 * the real corpus (items.ts's own module doc: all 281 real anchor lines
 * decompose cleanly) and is proved by a targeted, in-memory mutation of a
 * real anchor line's money-figure format (breaking `items.ts`'s
 * `ANCHOR_TAIL_RE`), mirroring the same "engineer a case from real text,
 * never fabricate a fixture" precedent items.ts's own duplicate-code test
 * uses. Reads `item.itemCode === ''` as the signal: items.ts's
 * `malformedItem` fallback is the ONLY path that produces an empty
 * `itemCode` (`peelAnchorTail`'s successful path always returns a
 * non-empty token, by construction of its token-filtering). The raw
 * anchor line is retained either way; the description, when present, is
 * never cleaned.
 */
export function detectLayoutJunk(items: readonly ParsedItem[]): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const item of items) {
    if (LAYOUT_JUNK_GLYPHS_RE.test(item.description)) {
      flags.push({
        code: 'layout_junk',
        scope: 'item',
        targetId: itemTargetId(item),
        rawBlock: item.description,
        message:
          'Description contains a layout-junk glyph (a pdftotext -layout rendering artifact, e.g. a garbled list marker) -- retained verbatim, never cleaned.',
      });
    }
    if (item.itemCode === '') {
      flags.push({
        code: 'layout_junk',
        scope: 'item',
        targetId: itemTargetId(item),
        rawBlock: item.raw.anchorLine,
        message:
          "The anchor line's numeric columns could not be parsed (layout junk / an unparseable token) -- raw block retained, item flagged, nothing guessed.",
      });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// "Additional required behaviour" — unexercised defensive template branches
// ---------------------------------------------------------------------------

const ITEM_BREAKUP_LABEL_RE = /^Item Breakup\b/i;
const ITEM_BREAKUP_EXPECTED = 'no break up item added';

/** `Item Breakup` reads "No break up item added" in all six real letters
 * (research §5). Flags only when the section is PRESENT with different
 * content — absence is not itself a trap (the ticket: "raises `needsReview`
 * when it appears with unexpected content", not on absence). Unexercised by
 * the real corpus; proved by an in-memory substitution of a real fixture's
 * text. */
export function detectUnexpectedItemBreakup(
  rawText: string,
  letterTargetId: string,
): readonly ReviewFlag[] {
  const stripped = stripPrintFurniture(rawText);
  const para = paragraphs(stripped).find((p) => ITEM_BREAKUP_LABEL_RE.test(p));
  if (para === undefined) {
    return [];
  }
  const remainder = para.replace(ITEM_BREAKUP_LABEL_RE, '').trim();
  if (remainder.toLowerCase() === ITEM_BREAKUP_EXPECTED) {
    return [];
  }
  return [
    {
      code: 'unexpected_item_breakup',
      scope: 'letter',
      targetId: letterTargetId,
      rawBlock: para,
      message: `"Item Breakup" reads ${JSON.stringify(remainder)} instead of the template's universal "No break up item added" (6/6 in the real corpus) -- unexercised by real data, implemented defensively; review before confirm.`,
    },
  ];
}

/** `Rebate on Total Value (%)` reads `0.00` in all six real letters
 * (research §1's decoy field, §5). Reuses `pricingShape.rebateOnTotalValue`
 * (already extracted by pricing-shape.ts) rather than re-parsing it, so
 * this can never drift from the classifier's own reading of the same
 * figure. Flags only when found AND non-zero — a `null` (not located) is
 * pricing-shape.ts's own `needsReview` concern, not this trigger's. */
export function detectUnexpectedRebate(
  pricingShape: PricingShapeResult,
  letterTargetId: string,
): readonly ReviewFlag[] {
  const { rebateOnTotalValue, rawTotalsBlock } = pricingShape;
  if (rebateOnTotalValue === null || rebateOnTotalValue === 0) {
    return [];
  }
  return [
    {
      code: 'unexpected_rebate',
      scope: 'letter',
      targetId: letterTargetId,
      rawBlock: rawTotalsBlock ?? '',
      message: `"Rebate on Total Value (%)" reads ${String(rebateOnTotalValue)} instead of the template's universal 0.00 (6/6 in the real corpus) -- unexercised by real data, implemented defensively; review before confirm (research §1's decoy field).`,
    },
  ];
}

/** The item-row `Above Par` token — never observed in the real corpus
 * (281/281 read `At Par`, research §5). Unexercised by real data; proved by
 * mutating a real anchor line's par token in-memory. */
export function detectUnexpectedAbovePar(
  items: readonly ParsedItem[],
): readonly ReviewFlag[] {
  return items
    .filter((item) => item.parToken === 'Above Par')
    .map((item) => ({
      code: 'unexpected_above_par' as const,
      scope: 'item' as const,
      targetId: itemTargetId(item),
      rawBlock: item.raw.anchorLine,
      message:
        '"Above Par" item-row token -- never observed in the real corpus (281/281 read "At Par"), implemented defensively; review before confirm.',
    }));
}

// ---------------------------------------------------------------------------
// "Additional required behaviour" — Banned-items block, both spellings
// ---------------------------------------------------------------------------

export type BannedBlockSpelling = 'colon' | 'item';

export interface BannedItemsBlockDetection {
  /** Which of the two evidenced label spellings matched (module doc
   * below). */
  readonly spelling: BannedBlockSpelling;
  /** `false` for the documented empty case (the paragraph's content is
   * exactly `NIL`) -- `true` for a genuinely populated block. */
  readonly populated: boolean;
  readonly rawBlock: string;
}

// PL281's spelling: "Banned item: Rates of item no 2,6,8,16,17,18 of
// schedule A1 & rates of item no 8,15 of schedule A2 are baneed for future
// reference." (fixture lines 100-101, sic on "baneed" -- the letter's own
// typo, preserved verbatim in rawBlock). Checked FIRST, deliberately: it
// requires the word "item" between "Banned" and ":", so it can never match
// PL280's "Banned :" line (whose colon follows "Banned" directly, with only
// whitespace between).
const BANNED_ITEM_LABEL_RE = /Banned\s+item\s*:/i;

// PL280's spelling: "Banned : Rates of the following items are banned for
// future reference Schedule AB- NIL" (fixture lines 140-141). Cannot match
// "Banned item:" text (module doc above) -- the two arms are mutually
// exclusive by construction, not by check order.
const BANNED_COLON_LABEL_RE = /Banned\s*:/i;

// The documented empty case (PL280): the paragraph's trailing content is
// exactly "NIL". Any populated content -- a real item list, research §5's
// PL281 case -- never contains this token in the corpus.
const NIL_WORD_RE = /\bNIL\b/i;

/**
 * Recognises EITHER spelling of the Banned-items block (research §5,
 * corrected 2026-08-05 -- "no longer unexercised"), scanning the header/
 * prose region only (both real occurrences sit before the
 * `Awarded Quantities And Rates` marker: PL280 lines 140-141, PL281 lines
 * 100-101). Returns `null` if NEITHER spelling is present at all -- exposed
 * separately from the flag-producing wrapper below so
 * `test/needs-review.test.ts` can prove both spelling arms independently
 * (disabling either regex turns exactly one real letter's detection result
 * `null`, per the ticket's own negative-proof requirement), not just prove
 * the flag outcome, which is IDENTICAL ("no flag") for PL280 whether or not
 * the colon arm even runs (its content is NIL either way) and would not by
 * itself catch that arm being disabled.
 */
export function detectBannedItemsBlock(
  rawText: string,
): BannedItemsBlockDetection | null {
  const region = headerRegion(rawText);
  const paras = paragraphs(region);

  const itemPara = paras.find((p) => BANNED_ITEM_LABEL_RE.test(p));
  if (itemPara !== undefined) {
    return {
      spelling: 'item',
      populated: !NIL_WORD_RE.test(itemPara),
      rawBlock: itemPara,
    };
  }

  const colonPara = paras.find((p) => BANNED_COLON_LABEL_RE.test(p));
  if (colonPara !== undefined) {
    return {
      spelling: 'colon',
      populated: !NIL_WORD_RE.test(colonPara),
      rawBlock: colonPara,
    };
  }

  return null;
}

/** Flags a POPULATED banned-items block for review (ticket, verbatim: "flag
 * a populated banned-items block for review"). READING CHOSEN for the
 * NIL/empty case (ticket: "rather than treating the branch as untested" --
 * ambiguous on whether NIL itself should also flag): NIL is documented here
 * as the EMPTY case, symmetric with `detectUnexpectedItemBreakup` /
 * `detectUnexpectedRebate` above (both flag only on unexpected/populated
 * content, never on the template's normal/empty state) -- so PL280's NIL
 * block is recognised (proving the colon spelling arm works) but never
 * flagged, while PL281's populated block is both recognised AND flagged. */
export function detectBannedItemsBranch(
  rawText: string,
  letterTargetId: string,
): readonly ReviewFlag[] {
  const detection = detectBannedItemsBlock(rawText);
  if (detection === null || !detection.populated) {
    return [];
  }
  const spellingLabel = detection.spelling === 'item' ? '"Banned item:"' : '"Banned :"';
  return [
    {
      code: 'banned_items_block',
      scope: 'letter',
      targetId: letterTargetId,
      rawBlock: detection.rawBlock,
      message: `Banned-items block is populated (recognised via the ${spellingLabel} spelling) -- review the named items before confirm; rates for these items are banned for future reference.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// roll-up
// ---------------------------------------------------------------------------

function rollUp(flags: readonly ReviewFlag[]): NeedsReviewRollup {
  const byCode: Record<string, number> = {};
  for (const flag of flags) {
    byCode[flag.code] = (byCode[flag.code] ?? 0) + 1;
  }
  return {
    total: flags.length,
    byCode,
    anyLetterLevel: flags.some((flag) => flag.scope === 'letter'),
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/** The letter-level `targetId` every letter-scoped flag below uses: the
 * already-extracted letter number (header.ts), or a fixed sentinel on the
 * unexercised-by-the-corpus case where header.ts itself could not locate
 * one. */
function letterTargetIdOf(header: LoaHeader): string {
  return header.letterNumber.value ?? 'UNKNOWN_LETTER';
}

function detectUnresolvedItemDescription(
  items: readonly ParsedItem[],
  rawItemTextWasProvided: boolean,
  letterTargetId: string,
): readonly ReviewFlag[] {
  if (
    !rawItemTextWasProvided ||
    items.length === 0 ||
    items.every((item) => item.descriptionSource === 'raw-exact')
  ) {
    return [];
  }
  return [
    {
      code: 'unresolved_item_description',
      scope: 'letter',
      targetId: letterTargetId,
      rawBlock: items.map((item) => item.raw.anchorLine).join('\n'),
      message:
        'Exact per-item description boundaries could not be verified from the PDF reading order. Conservative layout text was retained; review item descriptions before confirmation.',
    },
  ];
}

/**
 * The single public entry point (ticket: "the parser's public API returns a
 * review payload"). Composes `extractHeader`, `parseItems` and
 * `classifyPricingShape` (never re-implementing any of their fields), then
 * runs every trigger in this module against that already-parsed output plus
 * the raw text triggers need for their own text-scans. Pure: no I/O, no
 * database, no work ever written (module doc above).
 */
export function reviewLoaLetter(
  rawText: string,
  options: ReviewLoaOptions = {},
): LoaReviewPayload {
  const header = extractHeader(rawText);
  const items =
    options.rawItemText === undefined
      ? parseItems(rawText)
      : parseItems(rawText, { rawItemText: options.rawItemText });
  const pricingShape = classifyPricingShape(rawText);
  const letterTargetId = letterTargetIdOf(header);

  const flags: ReviewFlag[] = [
    ...detectCorrigendumKeyword(rawText, letterTargetId),
    ...detectCorrigendumItemUnitCorrections(rawText, items),
    ...detectQtyDecomposition(items),
    ...detectPaymentTermsProse(items),
    ...detectUnresolvedItemDescription(
      items,
      options.rawItemText !== undefined,
      letterTargetId,
    ),
    ...detectUnresolvedUnits(items),
    ...detectItemCodeNamespaceMismatch(items),
    ...detectLayoutJunk(items),
    ...detectUnexpectedItemBreakup(rawText, letterTargetId),
    ...detectUnexpectedRebate(pricingShape, letterTargetId),
    ...detectUnexpectedAbovePar(items),
    ...detectBannedItemsBranch(rawText, letterTargetId),
  ];

  return {
    header,
    items,
    pricingShape,
    flags,
    needsReview: rollUp(flags),
  };
}
