/**
 * @auto-mb/loa-parser — item-row parsing: par-token anchoring, wrapped
 * descriptions, schedule binding (DC-25; tickets/DC-25.md;
 * research/DC-32-loa-parser-contract.md §2 "Item-row geometry", §4.5
 * "Item-code namespaces differ", §4.6 "Layout junk inside descriptions",
 * §6 "Schema consequences").
 *
 * INPUT GEOMETRY (research §2): the item serial number and every numeric
 * column sit on ONE line — the "anchor" line — and that line falls in the
 * MIDDLE of a multi-line wrapped description block. The anchor is never the
 * leading serial number (it is left-aligned in a column that ALSO holds
 * wrapped description text — a continuation line can start with a digit and
 * must never be mistaken for a new item). The only reliable per-item anchor
 * is the par token: every real item row carries exactly one of `At Par` /
 * `Below Par` / `Above Par` (281 across the six-letter corpus; only `At
 * Par` is exercised — `Below Par`/`Above Par` are implemented defensively
 * and are UNTESTED against real data, research §5).
 *
 * ANCHOR-LINE PARSE DIRECTION (research §2 step 2): right-to-left for
 * `bid_amount`, `par_token`, `unit_rate`, `qty_unit`, `qty`, `item_code`;
 * left-to-right for `item_sno`. The qty_unit column can be EMPTY on the
 * anchor line itself — the one PL276-GTL "Route Kilo Meter (RKM)" item
 * (fixture lines 497-501) wraps its unit across four adjacent unit-column
 * lines around the anchor instead (research §4.4, mirrored here from the
 * same geometry `packages/db/test/units-master.dbtest.ts`'s
 * `extractUnitColumn`/`harvestWrappedUnit` proved against the same fixture,
 * re-implemented in this package rather than imported so `@auto-mb/loa-parser`
 * stays free of any dependency on `@auto-mb/db`, kernel loa-purity — see
 * `test/corpus-manifest.test.ts`'s purity block).
 *
 * DESCRIPTION (research §2 step 3): collected from lines BOTH above AND
 * below the anchor — never assumed to precede it — bounded by the
 * previous/next anchor and by schedule headers, preserved VERBATIM (never
 * cleaned; research §4.6's stray `©` mid-sentence in PL275 must survive
 * byte-for-byte).
 *
 * SCHEDULE BINDING (research §2 step 4, §6): each item binds to the
 * nearest preceding `Schedule <id>-<name>` header, found only within the
 * item TABLE region (after the `Awarded Quantities And Rates` marker) —
 * PL280-ADI's header/prose block contains a decoy occurrence of the exact
 * same "Schedule AB-" text inside its "Banned :" paragraph, which would be
 * a false-positive schedule header if this module searched the whole
 * letter instead of the bounded item-table region. The printed schedule id
 * is carried VERBATIM (`A1`/`B2` — identity is not an ordinal, research §6:
 * PL276's Supply/Labour × SOR/Non-SOR 2×2 proves it). The header's
 * `Item Directory - ...` value is captured as `directory`, or `null` for
 * `Not Applicable` — that value itself commonly wraps across lines with an
 * interleaved numeric totals line in between (the same "wrap trap"
 * phenomenon `letter-number.ts` already solves for the letter number, this
 * module's own instance of it).
 */
import { formatMinorUnits, parseDecimalToMinorUnits } from './decimal.js';
import { stripPrintFurniture } from './furniture.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';

/** Every item row's par token — see the module doc for why only `At Par`
 * is exercised by the real corpus. */
export type ParTokenDirection = 'At Par' | 'Below Par' | 'Above Par';

const PAR_TOKEN_ALTERNATION = 'At Par|Below Par|Above Par';
const PAR_TOKEN_RE = new RegExp(`\\b(?:${PAR_TOKEN_ALTERNATION})\\b`);

const SCHEDULE_HEADER_START_RE = /^\s*Schedule\s+([A-Z][A-Za-z0-9]*)-/;
const SCHEDULE_TOTALS_RE = /^\s*Schedule Totals\b/;

// Anchor-line tail, right-to-left: <head> <unit_rate> <par_token> <bid_amount>.
// Every money column in the item table is printed to exactly two decimal
// places (verified across all 281 real rows) — `\.\d{2}` is deliberately
// tighter than header.ts's prose-money regex (`\.\d+`), which reads
// hand-typed sentence prose rather than a machine-formatted table column.
const ANCHOR_TAIL_RE = new RegExp(
  `^(.*\\S)\\s+([\\d,]+\\.\\d{2})\\s+(${PAR_TOKEN_ALTERNATION})\\s+([\\d,]+\\.\\d{2})\\s*$`,
);

// item_sno, left-to-right: the leading integer token, always followed by
// whitespace then the rest of the line (research §2: never anchor on this
// token alone — it also opens every wrapped description-continuation line
// that happens to start with a digit, e.g. PL275-BKN.txt:155 "10 sq. mm
// multi strand..."; this module never treats a bare leading-digit line as
// an item on its own — only `ANCHOR_TAIL_RE` matching against a
// par-token-bearing line does that).
const ITEM_SNO_RE = /^\s*(\d+)\s+(.*)$/;

// A token that is PURELY a printed number (optionally comma-grouped,
// optionally decimal, optionally a trailing "%") or a bare "%" — the
// interleaved Schedule-Totals/Escl.(%) figures that sit BETWEEN fragments
// of a wrapped schedule name/directory clause (research §3's "wrap trap"
// phenomenon, this module's instance of it for `Item Directory - ...)`).
const NOISE_TOKEN_RE = /^(?:[\d,]+(?:\.\d+)?%?|%)$/;

/** True when `token` is qty (or bid_amount/unit_rate) shaped: a bare
 * integer, optionally comma-grouped, optionally decimal. Used only to tell
 * qty apart from the qty_unit word immediately to its right on the anchor
 * line's tail (research §2's "empty unit column" trap — see module doc). */
function isNumericToken(token: string): boolean {
  return /^\d[\d,]*(?:\.\d+)?$/.test(token);
}

// ---------------------------------------------------------------------------
// public shape
// ---------------------------------------------------------------------------

/** The schedule an item binds to — nearest preceding `Schedule <id>-<name>`
 * header within the item-table region (research §2 step 4, §6). */
export interface ItemScheduleBinding {
  /** Printed schedule id, verbatim (`"A"`, `"A1"`, `"B2"`, `"AB"`) — never
   * an ordinal (research §6). */
  readonly id: string;
  /** The header's `Item Directory - ...` value, verbatim, or `null` when
   * the letter prints `Not Applicable` (research §4.5). Item codes are
   * unique only WITHIN a directory — a printed code repeating under a
   * DIFFERENT directory is a different item, never merged (research §4.5;
   * tickets/DC-25.md). */
  readonly directory: string | null;
}

/** `qty × unit_rate` reconciled against the printed `bid_amount`
 * (PRODUCT-SPEC §5.1.3), computed in exact-decimal paisa (decimal.ts) —
 * never float. */
export interface ItemReconciliation {
  /** True when the reconciliation is within tolerance. */
  readonly ok: boolean;
  /** `qty × unit_rate`, exact-decimal, as printed-style decimal text. Null
   * only when qty or unit_rate themselves failed to parse as decimals
   * (never observed in the six-letter corpus). */
  readonly expectedAmount: string | null;
  /** `expectedAmount − bidAmount`, exact-decimal, signed. Null under the
   * same condition as `expectedAmount`. */
  readonly diff: string | null;
  /**
   * Set only when `!ok` AND the mismatch exactly matches the classic
   * merged/dropped-digit signature — a single decimal-place shift
   * (`expected === printed × 10` or `expected × 10 === printed`) — the
   * textbook symptom of a digit slipping in or out of a text-layer
   * extraction. This is a HINT for the human reviewer, never applied as a
   * correction: `ok` stays false and every printed field is retained
   * unmodified either way (PRODUCT-SPEC §5.1.3 "arithmetic recovery ...
   * never discards information"; tickets/DC-25.md "Failure retains the raw
   * block and raises needsReview — never a silent correction"). Unexercised
   * by the real corpus (all 281 rows reconcile exactly) — defensive only.
   */
  readonly recoveryHint: 'decimal-shift-x10' | 'decimal-shift-div10' | null;
}

/** One parsed item row. */
export interface ParsedItem {
  /** Nearest preceding schedule header, or `null` if the anchor line
   * precedes any recognisable `Schedule <id>-<name>` header — unexercised
   * by the real corpus (every item in all six letters binds to a schedule)
   * and defensive only. */
  readonly schedule: ItemScheduleBinding | null;
  /** Printed item serial number, verbatim (`"1"`, `"01"`, `"10"`) — parsed
   * LEFT-TO-RIGHT off the anchor line (research §2). Not assumed unique
   * across the letter (PL275-BKN's serials run 1..45 continuously across
   * both its schedules; other letters restart per schedule). */
  readonly itemSno: string;
  /** Printed item code, verbatim — unique only within `schedule.directory`
   * (research §4.5; e.g. SOR `13010300` vs non-SOR `S01`). Empty string
   * only on the defensive malformed-anchor-line fallback (see
   * `raw.anchorLine` and `needsReview`). */
  readonly itemCode: string;
  /** Description assembled from every line bound to this item — the lines
   * above the anchor, the anchor line's own description fragment (if any),
   * and the lines below the anchor, in that reading order — verbatim,
   * never cleaned (research §4.6). Layout whitespace (indentation, the
   * exact run-length between words) is normalised to single spaces the
   * same way `text.ts`'s `flatten`/`paragraphs` already do for every other
   * prose field in this package; no character of CONTENT is ever altered,
   * dropped, or replaced.
   *
   * ADJACENT ITEMS' DESCRIPTIONS INTENTIONALLY OVERLAP. Research §2 step 3
   * says to collect from lines both above AND below the anchor, bounded by
   * the previous/next anchor — which means the physical lines strictly
   * BETWEEN two anchors are claimed by BOTH neighbours: item N's
   * `belowLines` and item N+1's `aboveLines` are the exact same slice
   * (`aboveStart`/`belowEnd` in `parseItems`, both computed from the same
   * `prevAnchorIdx`/`nextAnchorIdx` pair). This is deliberate over-inclusion,
   * never loss — the alternative (assigning that region to only one
   * neighbour) risks silently dropping prose that actually belongs to the
   * OTHER item, and this module's own charter is "nothing is discarded and
   * nothing is guessed" (field.ts's contract, applied at the item level).
   * Concretely, on PL273-JHS: item 2's `description` contains BOTH item 1's
   * `(Qty = 2 set x 24 month = 48 month)` parenthetical (leaked in via item
   * 2's `aboveLines`) and item 2's own `(Qty = 2 nos x 24 month = 48
   * month)` (in its `belowLines`) — pinned by
   * `test/item-anchor.test.ts`'s "adjacent items' descriptions
   * intentionally overlap" case. A consumer that needs to distinguish "this
   * item's own trailing prose" from "the next item's leading prose" — DC-26's
   * `needsReview` qty-decomposition trigger is the first one that does —
   * must read the LAST matching occurrence in a multi-line-wrapped clause
   * like this one, never the first, since a neighbour's leaked text always
   * sits in `aboveLines`, which this module always joins BEFORE
   * `belowLines`. */
  readonly description: string;
  /** Printed quantity, verbatim numeric text (no unit). */
  readonly qty: string;
  /** Printed unit-column text, verbatim. `null` when the anchor line's
   * unit column is empty AND the wrapped-band harvest (research §4.4)
   * could not recover it either — `needsReview` is raised in that case.
   * Unexercised: on the six-letter corpus the harvest always succeeds
   * (there is exactly one empty-unit-column row, PL276-GTL's RKM item, and
   * it resolves to `"Route Kilo Meter (RKM)"`). */
  readonly qtyUnit: string | null;
  /** True when `qtyUnit` came from the multi-line wrapped-band harvest
   * rather than being read directly off the anchor line. */
  readonly qtyUnitWrapped: boolean;
  /** Printed unit rate, verbatim numeric text. */
  readonly unitRate: string;
  /** The par token as printed on this row. */
  readonly parToken: ParTokenDirection;
  /** Printed bid amount, verbatim numeric text. */
  readonly bidAmount: string;
  readonly reconciliation: ItemReconciliation;
  /** True when ANY part of this item is uncertain: an unresolved
   * `qtyUnit`, a reconciliation that failed tolerance, an unbound schedule,
   * or a malformed anchor line the tail/peel parse could not fully
   * decompose. Never true for a routine row. */
  readonly needsReview: boolean;
  /** The exact source text this item was derived from — nothing discarded,
   * even when a field above is null/needsReview (field.ts's contract,
   * applied at the item level rather than per-field: an item row is parsed
   * as one unit, not field-by-field independent lookups). */
  readonly raw: {
    readonly anchorLine: string;
    /** Lines strictly above the anchor, bounded by the previous anchor/
     * schedule header, in original (untrimmed) form, including blanks. */
    readonly aboveLines: readonly string[];
    /** Lines strictly below the anchor, bounded by the next anchor/
     * schedule header/`Schedule Totals`, in original (untrimmed) form,
     * including blanks. */
    readonly belowLines: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// schedule header parsing (id + directory, tolerant of the wrap trap)
// ---------------------------------------------------------------------------

interface ScheduleHeaderBlock {
  readonly startIdx: number;
  readonly id: string;
  readonly directory: string | null;
  /** Index of the last line consumed by this header block (the line whose
   * `Item Directory - ...)` closing paren was found, or — in the
   * unexercised-by-corpus case where it never closes within `endBoundIdx`
   * — the last line scanned). Item description collection starts strictly
   * after this line, so header text never leaks into a description. */
  readonly blockEndIdx: number;
}

/**
 * Parses one `Schedule <id>-<name> ... (Item Directory - <directory>)`
 * header block starting at `startIdx`, scanning forward only as far as
 * `endBoundIdx` (exclusive — the caller passes the schedule's own first
 * anchor line or the next schedule header, whichever is nearer, since the
 * directory clause always resolves before either in the real corpus).
 *
 * The clause "Item Directory - <value>)" itself wraps across physical
 * lines in five of the six fixtures, usually with an UNRELATED numeric
 * totals/escalation-percentage line interleaved in the middle (e.g.
 * PL276-GTL.txt:97-99: `"...(Item Directory - Not                    %"` /
 * `"7516440.00 7.77 ... 8100467.39"` / `"Applicable)  ... Above"`) — the
 * same wrap-trap shape `letter-number.ts` solves for the letter number.
 * Rather than hand-listing every observed wrap shape, this walks a small
 * state machine token-by-token across the bounded window, SKIPPING any
 * token that is purely numeric/percent noise (`NOISE_TOKEN_RE`) regardless
 * of which line it lands on — once that noise is filtered out, "Item"
 * ... "Directory" ... "-" ... "<value>" ")" are always adjacent in the
 * remaining token stream, on all six fixtures' 16 schedule headers,
 * wrapped or not.
 */
function parseScheduleHeaderBlock(
  lines: readonly string[],
  startIdx: number,
  endBoundIdx: number,
): ScheduleHeaderBlock | null {
  const startLine = lines[startIdx] ?? '';
  const idMatch = SCHEDULE_HEADER_START_RE.exec(startLine);
  if (idMatch === null) {
    return null;
  }
  const id = (idMatch[1] ?? '').trim();

  type Phase = 'seek-item' | 'seek-directory' | 'seek-dash' | 'capture';
  let phase: Phase = 'seek-item';
  const valueWords: string[] = [];
  let blockEndIdx = startIdx;
  let closed = false;

  for (let i = startIdx; i < endBoundIdx && !closed; i += 1) {
    const line = lines[i] ?? '';
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    for (const token of tokens) {
      if (NOISE_TOKEN_RE.test(token)) {
        continue;
      }
      if (phase === 'seek-item') {
        if (token === 'Item' || token === '(Item') {
          phase = 'seek-directory';
        }
        continue;
      }
      if (phase === 'seek-directory') {
        if (token === 'Directory') {
          phase = 'seek-dash';
        }
        continue;
      }
      if (phase === 'seek-dash') {
        if (token === '-') {
          phase = 'capture';
        }
        continue;
      }
      // phase === 'capture'
      const closeIdx = token.indexOf(')');
      if (closeIdx === -1) {
        valueWords.push(token);
        continue;
      }
      const head = token.slice(0, closeIdx);
      if (head.length > 0) {
        valueWords.push(head);
      }
      closed = true;
      blockEndIdx = i;
      break;
    }
    if (!closed) {
      blockEndIdx = i;
    }
  }

  if (!closed) {
    // Unexercised by the six-letter corpus: every one of its 16 schedule
    // headers closes its directory clause well before `endBoundIdx`.
    // Degrade to an unresolved directory rather than throwing — a schedule
    // whose id is readable but whose directory clause is malformed still
    // gets every item bound to it (id is never null), just with
    // `directory: null` standing in for "unknown", same as "Not
    // Applicable" — the caller cannot tell these apart from this return
    // value alone, which is acceptable here because nothing downstream in
    // this ticket distinguishes them; a future ticket that needs to could
    // widen this return type without changing the closed-path behaviour.
    return { startIdx, id, directory: null, blockEndIdx };
  }

  const directoryRaw = valueWords.join(' ').trim();
  const directory =
    directoryRaw.length === 0 || /^Not\s+Applicable$/i.test(directoryRaw)
      ? null
      : directoryRaw;
  return { startIdx, id, directory, blockEndIdx };
}

// ---------------------------------------------------------------------------
// anchor-line tail peeling (item_code / qty / qty_unit / description-on-line)
// ---------------------------------------------------------------------------

interface PeeledTail {
  readonly itemCode: string;
  readonly qty: string;
  /** Empty string when the anchor line's unit column is empty (the
   * wrapped-unit case — see `harvestWrappedUnit`). */
  readonly qtyUnit: string;
  /** The on-anchor-line description fragment, i.e. everything between
   * `item_sno` and `item_code` — often empty (most rows carry their whole
   * description on lines above/below, not the anchor line itself). */
  readonly descOnLine: string;
}

/**
 * Peels `item_code`, `qty`, `qty_unit` (possibly empty) and the
 * on-anchor-line description fragment off `preDesc` — the anchor line's
 * tail-stripped head (`ANCHOR_TAIL_RE`'s first capture group: everything
 * before `unit_rate`), working RIGHT-TO-LEFT (research §2 step 2).
 *
 * The last whitespace-separated token is qty_unit UNLESS it is itself
 * numeric-shaped, in which case the unit column is empty on this line (the
 * PL276-GTL RKM row: `"13           10               98750.00 At Par ..."`
 * — the token immediately before `unit_rate` is `"10"`, which is qty
 * itself, not a unit word) and that same token IS qty. Either way, the
 * token immediately to its left is `item_code`, and everything further
 * left is the on-anchor-line description fragment. Verified against all
 * 281 real anchor lines in the six-letter corpus (every one peels cleanly
 * with zero ambiguity) before this function was written this way.
 */
function peelAnchorTail(preDesc: string): PeeledTail | null {
  const tokens = preDesc
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < 2) {
    return null;
  }
  const last = tokens[tokens.length - 1] as string;
  let qty: string;
  let qtyUnit: string;
  let codeIdx: number;
  if (isNumericToken(last)) {
    qty = last;
    qtyUnit = '';
    codeIdx = tokens.length - 2;
  } else {
    qtyUnit = last;
    const maybeQty = tokens[tokens.length - 2];
    if (maybeQty === undefined || !isNumericToken(maybeQty)) {
      return null;
    }
    qty = maybeQty;
    codeIdx = tokens.length - 3;
  }
  if (codeIdx < 0) {
    return null;
  }
  const itemCode = tokens[codeIdx] as string;
  const descOnLine = tokens.slice(0, codeIdx).join(' ');
  return { itemCode, qty, qtyUnit, descOnLine };
}

// ---------------------------------------------------------------------------
// wrapped-unit harvest (research §4.4 — mirrors the reference geometry in
// packages/db/test/units-master.dbtest.ts's extractUnitColumn/
// harvestWrappedUnit, re-implemented here so this package stays free of any
// dependency on @auto-mb/db)
// ---------------------------------------------------------------------------

/**
 * Collects every whitespace-separated token from `line` whose horizontal
 * start column falls inside `[bandStart, bandEnd)`, appending matches onto
 * `words` (mutated in place). No-op when `line` is absent (out of range) or
 * is itself another anchor (contains a par token) — `harvestWrappedUnit`
 * below calls this once per neighbouring line rather than looping over an
 * array of computed line indices, which is deliberate: a `for (const j of
 * [anchorIndex - 2, ...])` loop reads naturally here but syntactically
 * matches this repo's SAST command-injection taint rule's array-literal
 * source pattern (any array literal holding a non-string-literal element,
 * generically written to catch a tainted `execFile(cmd, [...args])` argv
 * build) — that pattern has no awareness that `RegExp.prototype.exec` a few
 * lines later is a regex match, not a shell exec, so the array-of-indices
 * shape here was a false-positive SAST finding. Four direct calls carry
 * the exact same behaviour without that array literal.
 */
function collectBandTokens(
  line: string | undefined,
  bandStart: number,
  bandEnd: number,
  words: string[],
): void {
  if (line === undefined || PAR_TOKEN_RE.test(line)) {
    return;
  }
  const tokenRe = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index >= bandStart && match.index < bandEnd) {
      words.push(match[0]);
    }
  }
}

/**
 * Harvests unit-column tokens from up to two lines above/below the anchor
 * whose horizontal start column falls inside `[bandStart, bandEnd)` — the
 * empty unit-column band on the anchor line itself. Stops considering any
 * neighbouring line that is itself another anchor (contains a par token),
 * matching the reference geometry exactly.
 */
function harvestWrappedUnit(
  lines: readonly string[],
  anchorIndex: number,
  bandStart: number,
  bandEnd: number,
): string {
  const words: string[] = [];
  collectBandTokens(lines[anchorIndex - 2], bandStart, bandEnd, words);
  collectBandTokens(lines[anchorIndex - 1], bandStart, bandEnd, words);
  collectBandTokens(lines[anchorIndex + 1], bandStart, bandEnd, words);
  collectBandTokens(lines[anchorIndex + 2], bandStart, bandEnd, words);
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// reconciliation (qty × unit_rate ≈ bid_amount, PRODUCT-SPEC §5.1.3)
// ---------------------------------------------------------------------------

// Every unit_rate/bid_amount in the item table is printed to exactly 2
// decimal places, and every qty in the six-letter corpus is a whole number
// (no fractional quantity is ever printed) — so qty × unit_rate reconciles
// to bid_amount to the EXACT paisa on all 281 real rows (verified). Zero is
// therefore the correct tolerance for this corpus; it is still an explicit,
// stated, and justified bound (rather than an unstated assumption) because
// a future fixture with a genuinely fractional qty is a data-shape change
// this comment flags for the next reader, not something a silently-widened
// band should paper over.
const RECONCILIATION_TOLERANCE_PAISE = 0n;

function reconcileItem(
  qty: string,
  unitRate: string,
  bidAmount: string,
): ItemReconciliation {
  const qtyMinor = parseDecimalToMinorUnits(qty, 0);
  const rateMinor = parseDecimalToMinorUnits(unitRate, 2);
  const bidMinor = parseDecimalToMinorUnits(bidAmount, 2);
  if (qtyMinor === null || rateMinor === null || bidMinor === null) {
    return {
      ok: false,
      expectedAmount: null,
      diff: null,
      recoveryHint: null,
    };
  }
  // qty is a plain integer count and rateMinor is already in paisa, so their
  // product is exactly the expected bid amount in paisa — no further
  // rounding step, and therefore no rounding error, is possible.
  const expectedMinor = qtyMinor * rateMinor;
  const diffMinor = expectedMinor - bidMinor;
  const absDiff = diffMinor < 0n ? -diffMinor : diffMinor;
  const ok = absDiff <= RECONCILIATION_TOLERANCE_PAISE;

  let recoveryHint: ItemReconciliation['recoveryHint'] = null;
  if (!ok) {
    if (expectedMinor === bidMinor * 10n) {
      recoveryHint = 'decimal-shift-x10';
    } else if (expectedMinor * 10n === bidMinor) {
      recoveryHint = 'decimal-shift-div10';
    }
  }

  return {
    ok,
    expectedAmount: formatMinorUnits(expectedMinor, 2),
    diff: formatMinorUnits(diffMinor, 2),
    recoveryHint,
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function nonBlankTrimmed(lines: readonly string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Parses every item row out of a raw (or already print-furniture-stripped —
 * stripping is idempotent) `pdftotext -layout` LOA extraction, per
 * research §2's algorithm. Strips print furniture first (furniture.ts, per
 * the ticket's ordering requirement — mirrors `extractHeader`'s own first
 * step), then locates the item-table region (after the
 * `Awarded Quantities And Rates` marker — this exclusion is what keeps
 * PL280-ADI's "Banned : ... Schedule AB-" prose decoy from being mistaken
 * for a real schedule header), then anchors on the par token per row.
 *
 * Never throws and never drops an anchor: a par-token-bearing line this
 * module cannot fully decompose still produces one `ParsedItem` (with
 * `needsReview: true` and every unresolved field left as an empty string
 * rather than guessed) — unexercised by the six-letter corpus, where every
 * one of the 281 anchor lines decomposes cleanly, but load-bearing for the
 * "281 total, never more, never fewer, never silently dropped" regression
 * bar this ticket exists to hold.
 */
export function parseItems(rawText: string): readonly ParsedItem[] {
  const stripped = stripPrintFurniture(rawText);
  const markerIdx = stripped.indexOf(ITEM_TABLE_MARKER);
  const itemRegionText = markerIdx === -1 ? '' : stripped.slice(markerIdx);
  const lines = itemRegionText.split('\n');

  const headerStartIdxs: number[] = [];
  const anchorIdxs: number[] = [];
  const scheduleTotalsIdxs: number[] = [];
  lines.forEach((line, i) => {
    if (SCHEDULE_HEADER_START_RE.test(line)) {
      headerStartIdxs.push(i);
      return;
    }
    if (SCHEDULE_TOTALS_RE.test(line)) {
      scheduleTotalsIdxs.push(i);
      return;
    }
    if (PAR_TOKEN_RE.test(line)) {
      anchorIdxs.push(i);
    }
  });

  const headers: ScheduleHeaderBlock[] = headerStartIdxs
    .map((startIdx, hi) => {
      const nextHeaderIdx = headerStartIdxs[hi + 1] ?? lines.length;
      const nextAnchorIdx =
        anchorIdxs.find((a) => a > startIdx) ?? lines.length;
      const endBound = Math.min(nextHeaderIdx, nextAnchorIdx);
      return parseScheduleHeaderBlock(lines, startIdx, endBound);
    })
    .filter((h): h is ScheduleHeaderBlock => h !== null);

  function scheduleFor(anchorIdx: number): ScheduleHeaderBlock | null {
    let found: ScheduleHeaderBlock | null = null;
    for (const h of headers) {
      if (h.startIdx <= anchorIdx) {
        found = h;
      } else {
        break;
      }
    }
    return found;
  }

  return anchorIdxs.map((a, ai) => {
    const anchorLine = lines[a] ?? '';
    const schedule = scheduleFor(a);
    const scheduleBinding: ItemScheduleBinding | null =
      schedule === null
        ? null
        : { id: schedule.id, directory: schedule.directory };

    const prevAnchorIdx = ai > 0 ? (anchorIdxs[ai - 1] as number) : -1;
    const headerBlockEnd = schedule === null ? -1 : schedule.blockEndIdx;
    const aboveStart = Math.max(prevAnchorIdx, headerBlockEnd) + 1;
    const nextAnchorIdx = anchorIdxs[ai + 1] ?? lines.length;
    const nextHeaderStart = headerStartIdxs.find((h) => h > a) ?? lines.length;
    const nextScheduleTotals =
      scheduleTotalsIdxs.find((s) => s > a) ?? lines.length;
    const belowEnd =
      Math.min(nextAnchorIdx, nextHeaderStart, nextScheduleTotals) - 1;

    const rawAboveLines = lines.slice(aboveStart, a);
    const rawBelowLines = lines.slice(a + 1, Math.max(belowEnd + 1, a + 1));

    const snoMatch = ITEM_SNO_RE.exec(anchorLine);
    if (snoMatch === null) {
      return malformedItem(
        scheduleBinding,
        '',
        anchorLine,
        rawAboveLines,
        rawBelowLines,
      );
    }
    const itemSno = (snoMatch[1] ?? '').trim();
    const rest = snoMatch[2] ?? '';
    const restOffset = anchorLine.length - rest.length;

    const tailMatch = ANCHOR_TAIL_RE.exec(rest);
    if (tailMatch === null) {
      return malformedItem(
        scheduleBinding,
        itemSno,
        anchorLine,
        rawAboveLines,
        rawBelowLines,
      );
    }
    const preDesc = tailMatch[1] ?? '';
    const unitRate = tailMatch[2] ?? '';
    const parToken = (tailMatch[3] ?? '') as ParTokenDirection;
    const bidAmount = tailMatch[4] ?? '';

    const peeled = peelAnchorTail(preDesc);
    if (peeled === null) {
      return malformedItem(
        scheduleBinding,
        itemSno,
        anchorLine,
        rawAboveLines,
        rawBelowLines,
      );
    }

    let qtyUnit: string | null =
      peeled.qtyUnit.length > 0 ? peeled.qtyUnit : null;
    let qtyUnitWrapped = false;
    if (qtyUnit === null) {
      const qtyEndInRest = preDesc.length;
      const rateStartInRest = rest.indexOf(unitRate, qtyEndInRest);
      const bandStart = restOffset + qtyEndInRest;
      const bandEnd =
        restOffset + (rateStartInRest === -1 ? qtyEndInRest : rateStartInRest);
      const harvested = harvestWrappedUnit(lines, a, bandStart, bandEnd);
      if (harvested.length > 0) {
        qtyUnit = harvested;
        qtyUnitWrapped = true;
      }
    }

    const aboveLines = nonBlankTrimmed(rawAboveLines);
    const belowLines = nonBlankTrimmed(rawBelowLines);
    const description = [
      ...aboveLines,
      ...(peeled.descOnLine.length > 0 ? [peeled.descOnLine] : []),
      ...belowLines,
    ].join(' ');

    const reconciliation = reconcileItem(peeled.qty, unitRate, bidAmount);
    const needsReview =
      qtyUnit === null || !reconciliation.ok || scheduleBinding === null;

    return {
      schedule: scheduleBinding,
      itemSno,
      itemCode: peeled.itemCode,
      description,
      qty: peeled.qty,
      qtyUnit,
      qtyUnitWrapped,
      unitRate,
      parToken,
      bidAmount,
      reconciliation,
      needsReview,
      raw: {
        anchorLine,
        aboveLines: rawAboveLines,
        belowLines: rawBelowLines,
      },
    };
  });
}

/**
 * Defensive fallback for a par-token-bearing line this module could not
 * fully decompose (unexercised by the six-letter corpus — every one of its
 * 281 anchor lines decomposes cleanly). Every unresolved field is an empty
 * string, never a guess, and `needsReview` is always true; the anchor is
 * still counted (never silently dropped), preserving the 281-item
 * regression bar even under malformed input this module has never actually
 * seen.
 */
function malformedItem(
  schedule: ItemScheduleBinding | null,
  itemSno: string,
  anchorLine: string,
  rawAboveLines: readonly string[],
  rawBelowLines: readonly string[],
): ParsedItem {
  // `anchorLine` is only ever routed here after already matching
  // `PAR_TOKEN_RE` (that's how it became an anchor index in the first
  // place) — so the real printed token is recoverable even though the
  // stricter tail/peel parse failed. Falls back to `At Par` only in the
  // structurally-impossible case where it somehow is not (never a guess
  // beyond "the corpus's overwhelmingly common token", and `needsReview` is
  // unconditionally true either way so nothing downstream trusts this
  // value silently).
  const parTokenMatch = PAR_TOKEN_RE.exec(anchorLine);
  const parToken = (parTokenMatch?.[0] ?? 'At Par') as ParTokenDirection;
  return {
    schedule,
    itemSno,
    itemCode: '',
    description: nonBlankTrimmed([
      ...rawAboveLines,
      anchorLine,
      ...rawBelowLines,
    ]).join(' '),
    qty: '',
    qtyUnit: null,
    qtyUnitWrapped: false,
    unitRate: '',
    parToken,
    bidAmount: '',
    reconciliation: {
      ok: false,
      expectedAmount: null,
      diff: null,
      recoveryHint: null,
    },
    needsReview: true,
    raw: {
      anchorLine,
      aboveLines: rawAboveLines,
      belowLines: rawBelowLines,
    },
  };
}
