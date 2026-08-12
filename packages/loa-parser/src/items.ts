/**
 * @auto-mb/loa-parser â€” item-row parsing: par-token anchoring, wrapped
 * descriptions, schedule binding (DC-25; legacy ticket DC-25;
 * docs/reference/loa-parser-contract.md Â§2 "Item-row geometry", Â§4.5
 * "Item-code namespaces differ", Â§4.6 "Layout junk inside descriptions",
 * Â§6 "Schema consequences").
 *
 * INPUT GEOMETRY (research Â§2): the item serial number and every numeric
 * column sit on ONE line â€” the "anchor" line â€” and that line falls in the
 * MIDDLE of a multi-line wrapped description block. The anchor is never the
 * leading serial number (it is left-aligned in a column that ALSO holds
 * wrapped description text â€” a continuation line can start with a digit and
 * must never be mistaken for a new item). The only reliable per-item anchor
 * is the par token: every real item row carries exactly one of `At Par` /
 * `Below Par` / `Above Par` (281 across the six-letter corpus; only `At
 * Par` is exercised â€” `Below Par`/`Above Par` are implemented defensively
 * and are UNTESTED against real data, research Â§5).
 *
 * ANCHOR-LINE PARSE DIRECTION (research Â§2 step 2): right-to-left for
 * `bid_amount`, `par_token`, `unit_rate`, `qty_unit`, `qty`, `item_code`;
 * left-to-right for `item_sno`. The qty_unit column can be EMPTY on the
 * anchor line itself â€” the one PL276-GTL "Route Kilo Meter (RKM)" item
 * (fixture lines 497-501) wraps its unit across four adjacent unit-column
 * lines around the anchor instead (research Â§4.4, mirrored here from the
 * same geometry `packages/db/test/units-master.dbtest.ts`'s
 * `extractUnitColumn`/`harvestWrappedUnit` proved against the same fixture,
 * re-implemented in this package rather than imported so `@auto-mb/loa-parser`
 * stays free of any dependency on `@auto-mb/db`, kernel loa-purity â€” see
 * `test/corpus-manifest.test.ts`'s purity block).
 *
 * DESCRIPTION (research Â§2 step 3): collected from lines BOTH above AND
 * below the anchor â€” never assumed to precede it â€” bounded by the
 * previous/next anchor and by schedule headers, preserved VERBATIM (never
 * cleaned; research Â§4.6's stray `Â©` mid-sentence in PL275 must survive
 * byte-for-byte).
 *
 * SCHEDULE BINDING (research Â§2 step 4, Â§6): each item binds to the
 * nearest preceding `Schedule <id>-<name>` header, found only within the
 * item TABLE region (after the `Awarded Quantities And Rates` marker) â€”
 * PL280-ADI's header/prose block contains a decoy occurrence of the exact
 * same "Schedule AB-" text inside its "Banned :" paragraph, which would be
 * a false-positive schedule header if this module searched the whole
 * letter instead of the bounded item-table region. The printed schedule id
 * is carried VERBATIM (`A1`/`B2` â€” identity is not an ordinal, research Â§6:
 * PL276's Supply/Labour Ã— SOR/Non-SOR 2Ã—2 proves it). The header's
 * `Item Directory - ...` value is captured as `directory`, or `null` for
 * `Not Applicable` â€” that value itself commonly wraps across lines with an
 * interleaved numeric totals line in between (the same "wrap trap"
 * phenomenon `letter-number.ts` already solves for the letter number, this
 * module's own instance of it).
 */
import { formatMinorUnits, parseDecimalToMinorUnits } from './decimal.js';
import { stripPrintFurniture } from './furniture.js';
import {
  recoverRawItemDescriptions,
  type RawItemExpectation,
} from './raw-item-descriptions.js';

const ITEM_TABLE_MARKER = 'Awarded Quantities And Rates';

/** Every item row's par token â€” see the module doc for why only `At Par`
 * is exercised by the real corpus. */
export type ParTokenDirection = 'At Par' | 'Below Par' | 'Above Par';

const PAR_TOKEN_ALTERNATION = 'At Par|Below Par|Above Par';
const PAR_TOKEN_RE = new RegExp(`\\b(?:${PAR_TOKEN_ALTERNATION})\\b`);

const SCHEDULE_HEADER_START_RE = /^\s*Schedule\s+([A-Z][A-Za-z0-9]*)-/;
const SCHEDULE_TOTALS_RE = /^\s*Schedule Totals\b/;

// Anchor-line tail, right-to-left: <head> <unit_rate> <par_token> <bid_amount>.
// Every money column in the item table is printed to exactly two decimal
// places (verified across all 281 real rows) â€” `\.\d{2}` is deliberately
// tighter than header.ts's prose-money regex (`\.\d+`), which reads
// hand-typed sentence prose rather than a machine-formatted table column.
const ANCHOR_TAIL_RE = new RegExp(
  `^(.*\\S)\\s+([\\d,]+\\.\\d{2})\\s+(${PAR_TOKEN_ALTERNATION})\\s+([\\d,]+\\.\\d{2})\\s*$`,
);

// item_sno, left-to-right: the leading integer token, always followed by
// whitespace then the rest of the line (research Â§2: never anchor on this
// token alone â€” it also opens every wrapped description-continuation line
// that happens to start with a digit, e.g. PL275-BKN.txt:155 "10 sq. mm
// multi strand..."; this module never treats a bare leading-digit line as
// an item on its own â€” only `ANCHOR_TAIL_RE` matching against a
// par-token-bearing line does that).
const ITEM_SNO_RE = /^\s*(\d+)\s+(.*)$/;

// A token that is PURELY a printed number (optionally comma-grouped,
// optionally decimal, optionally a trailing "%") or a bare "%" â€” the
// interleaved Schedule-Totals/Escl.(%) figures that sit BETWEEN fragments
// of a wrapped schedule name/directory clause (research Â§3's "wrap trap"
// phenomenon, this module's instance of it for `Item Directory - ...)`).
const NOISE_TOKEN_RE = /^(?:[\d,]+(?:\.\d+)?%?|%)$/;

/** True when `token` is qty (or bid_amount/unit_rate) shaped: a bare
 * integer, optionally comma-grouped, optionally decimal. Used only to tell
 * qty apart from the qty_unit word immediately to its right on the anchor
 * line's tail (research Â§2's "empty unit column" trap â€” see module doc). */
function isNumericToken(token: string): boolean {
  return /^\d[\d,]*(?:\.\d+)?$/.test(token);
}

// ---------------------------------------------------------------------------
// public shape
// ---------------------------------------------------------------------------

/** The schedule an item binds to â€” nearest preceding `Schedule <id>-<name>`
 * header within the item-table region (research Â§2 step 4, Â§6). */
export interface ItemScheduleBinding {
  /** Printed schedule id, verbatim (`"A"`, `"A1"`, `"B2"`, `"AB"`) â€” never
   * an ordinal (research Â§6). */
  readonly id: string;
  /** The header's `Item Directory - ...` value, verbatim, or `null` when
   * the letter prints `Not Applicable` (research Â§4.5). Item codes are
   * unique only WITHIN a directory â€” a printed code repeating under a
   * DIFFERENT directory is a different item, never merged (research Â§4.5;
   * legacy ticket DC-25). */
  readonly directory: string | null;
}

/** `qty Ã— unit_rate` reconciled against the printed `bid_amount`
 * (PRODUCT-SPEC Â§5.1.3), computed in exact-decimal paisa (decimal.ts) â€”
 * never float. */
export interface ItemReconciliation {
  /** True when the reconciliation is within tolerance. */
  readonly ok: boolean;
  /** `qty Ã— unit_rate`, exact-decimal, as printed-style decimal text. Null
   * only when qty or unit_rate themselves failed to parse as decimals
   * (never observed in the six-letter corpus). */
  readonly expectedAmount: string | null;
  /** `expectedAmount âˆ’ bidAmount`, exact-decimal, signed. Null under the
   * same condition as `expectedAmount`. */
  readonly diff: string | null;
  /**
   * Set only when `!ok` AND the mismatch exactly matches the classic
   * merged/dropped-digit signature â€” a single decimal-place shift
   * (`expected === printed Ã— 10` or `expected Ã— 10 === printed`) â€” the
   * textbook symptom of a digit slipping in or out of a text-layer
   * extraction. This is a HINT for the human reviewer, never applied as a
   * correction: `ok` stays false and every printed field is retained
   * unmodified either way (PRODUCT-SPEC Â§5.1.3 "arithmetic recovery ...
   * never discards information"; legacy ticket DC-25 "Failure retains the raw
   * block and raises needsReview â€” never a silent correction"). Unexercised
   * by the real corpus (all 281 rows reconcile exactly) â€” defensive only.
   */
  readonly recoveryHint: 'decimal-shift-x10' | 'decimal-shift-div10' | null;
}

/** One parsed item row. */
export interface ParsedItem {
  /** Nearest preceding schedule header, or `null` if the anchor line
   * precedes any recognisable `Schedule <id>-<name>` header â€” unexercised
   * by the real corpus (every item in all six letters binds to a schedule)
   * and defensive only. */
  readonly schedule: ItemScheduleBinding | null;
  /** Printed item serial number, verbatim (`"1"`, `"01"`, `"10"`) â€” parsed
   * LEFT-TO-RIGHT off the anchor line (research Â§2). Not assumed unique
   * across the letter (PL275-BKN's serials run 1..45 continuously across
   * both its schedules; other letters restart per schedule). */
  readonly itemSno: string;
  /** Printed item code, verbatim â€” unique only within `schedule.directory`
   * (research Â§4.5; e.g. SOR `13010300` vs non-SOR `S01`). Empty string
   * only on the defensive malformed-anchor-line fallback (see
   * `raw.anchorLine` and `needsReview`). */
  readonly itemCode: string;
  /** Description assembled from every line bound to this item â€” the lines
   * above the anchor, the anchor line's own description fragment (if any),
   * and the lines below the anchor, in that reading order â€” verbatim,
   * never cleaned (research Â§4.6). Layout whitespace (indentation, the
   * exact run-length between words) is normalised to single spaces the
   * same way `text.ts`'s `flatten`/`paragraphs` already do for every other
   * prose field in this package; no character of CONTENT is ever altered,
   * dropped, or replaced.
   *
   * ADJACENT ITEMS' DESCRIPTIONS INTENTIONALLY OVERLAP. Research Â§2 step 3
   * says to collect from lines both above AND below the anchor, bounded by
   * the previous/next anchor â€” which means the physical lines strictly
   * BETWEEN two anchors are claimed by BOTH neighbours: item N's
   * `belowLines` and item N+1's `aboveLines` are the exact same slice
   * (`aboveStart`/`belowEnd` in `parseItems`, both computed from the same
   * `prevAnchorIdx`/`nextAnchorIdx` pair). This is deliberate over-inclusion,
   * never loss â€” the alternative (assigning that region to only one
   * neighbour) risks silently dropping prose that actually belongs to the
   * OTHER item, and this module's own charter is "nothing is discarded and
   * nothing is guessed" (field.ts's contract, applied at the item level).
   * Concretely, on PL273-JHS: item 2's `description` contains BOTH item 1's
   * `(Qty = 2 set x 24 month = 48 month)` parenthetical (leaked in via item
   * 2's `aboveLines`) and item 2's own `(Qty = 2 nos x 24 month = 48
   * month)` (in its `belowLines`) â€” pinned by
   * `test/item-anchor.test.ts`'s "adjacent items' descriptions
   * intentionally overlap" case. A consumer that needs to distinguish "this
   * item's own trailing prose" from "the next item's leading prose" â€” DC-26's
   * `needsReview` qty-decomposition trigger is the first one that does â€”
   * must read the LAST matching occurrence in a multi-line-wrapped clause
   * like this one, never the first, since a neighbour's leaked text always
   * sits in `aboveLines`, which this module always joins BEFORE
   * `belowLines`.
   *
   * Production PDF parsing also supplies Poppler's `-raw` reading-order
   * view. When its complete row set and every numeric tuple match this
   * layout parse, that view replaces the conservative overlap with one
   * exact, non-overlapping description per row. The replacement is
   * all-or-nothing; any ambiguity retains this fallback and raises review. */
  readonly description: string;
  /** Whether `description` is the exact row-owned `pdftotext -raw` value or
   * the conservative, intentionally over-inclusive `-layout` fallback. */
  readonly descriptionSource: 'raw-exact' | 'layout-overinclusive';
  /** Printed quantity, verbatim numeric text (no unit). */
  readonly qty: string;
  /** Printed unit-column text, verbatim. `null` when the anchor line's
   * unit column is empty AND the wrapped-band harvest (research Â§4.4)
   * could not recover it either â€” `needsReview` is raised in that case.
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
  /** The exact source text this item was derived from â€” nothing discarded,
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
    /** Populated only after the all-or-nothing raw quality gate succeeds. */
    readonly exactDescriptionLines?: readonly string[];
  };
}

export interface ParseItemsOptions {
  /** Poppler `pdftotext -raw` output from the same PDF as `rawText`. */
  readonly rawItemText?: string;
}

// ---------------------------------------------------------------------------
// schedule header parsing (id + directory, tolerant of the wrap trap)
// ---------------------------------------------------------------------------

interface ScheduleHeaderBlock {
  readonly startIdx: number;
  readonly id: string;
  readonly directory: string | null;
  /** Index of the last line consumed by this header block (the line whose
   * `Item Directory - ...)` closing paren was found, or â€” in the
   * unexercised-by-corpus case where it never closes within `endBoundIdx`
   * â€” the last line scanned). Item description collection starts strictly
   * after this line, so header text never leaks into a description. */
  readonly blockEndIdx: number;
}

/**
 * Parses one `Schedule <id>-×Íõ¶‰Ëkºwµç|…µ‰¥Õ¥Ñä¤‰•™½É”Ñ¡¥Ì™Õ¹Ñ¥½¸İ…ÌİÉ¥ÑÑ•¸Ñ¡¥Ìİ…ä¸(€¨¼)™Õ¹Ñ¥½¸Á••±¹¡½ÉQ…¥°¡ÁÉ••ÍŒèÍÑÉ¥¹œ¤èA••±•‘Q…¥°ğ¹Õ±°ì(€½¹ÍĞÑ½­•¹Ì€ôÁÉ••ÍŒ(€€€€¹ÑÉ¥´ ¤(€€€€¹ÍÁ±¥Ğ ½qÌ¬¼¤(€€€€¹™¥±Ñ•È ¡Ğ¤€ôøĞ¹±•¹Ñ €ø€À¤ì(€¥˜€¡Ñ½­•¹Ì¹±•¹Ñ €ğ€È¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô(€½¹ÍĞ±…ÍĞ€ôÑ½­•¹ÍmÑ½­•¹Ì¹±•¹Ñ €´€Åt…ÌÍÑÉ¥¹œì(€±•ĞÅÑäèÍÑÉ¥¹œì(€±•ĞÅÑåU¹¥ĞèÍÑÉ¥¹œì(€±•Ğ½‘•%‘àè¹Õµ‰•Èì(€¥˜€¡¥Í9Õµ•É¥Q½­•¸¡±…ÍĞ¤¤ì(€€€ÅÑä€ô±…ÍĞì(€€€ÅÑåU¹¥Ğ€ô€œœì(€€€½‘•%‘à€ôÑ½­•¹Ì¹±•¹Ñ €´€Èì(€ô•±Í”ì(€€€ÅÑåU¹¥Ğ€ô±…ÍĞì(€€€½¹ÍĞµ…å‰•EÑä€ôÑ½­•¹ÍmÑ½­•¹Ì¹±•¹Ñ €´€Étì(€€€¥˜€¡µ…å‰•EÑä€ôôôÕ¹‘•™¥¹•ñğ€…¥Í9Õµ•É¥Q½­•¸¡µ…å‰•EÑä¤¤ì(€€€€€É•ÑÕÉ¸¹Õ±°ì(€€€ô(€€€ÅÑä€ôµ…å‰•EÑäì(€€€½‘•%‘à€ôÑ½­•¹Ì¹±•¹Ñ €´€Ìì(€ô(€¥˜€¡½‘•%‘à€ğ€À¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô(€½¹ÍĞ¥Ñ•µ½‘”€ôÑ½­•¹Ím½‘•%‘át…ÌÍÑÉ¥¹œì(€½¹ÍĞ‘•Í=¹1¥¹”€ôÑ½­•¹Ì¹Í±¥” À°½‘•%‘à¤¹©½¥¸ œ€œ¤ì(€É•ÑÕÉ¸ì¥Ñ•µ½‘”°ÅÑä°ÅÑåU¹¥Ğ°‘•Í=¹1¥¹”ôì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼İÉ…ÁÁ•µÕ¹¥Ğ¡…ÉÙ•ÍĞ€¡É•Í•…É ƒ
œĞ¸ĞƒŠPµ¥ÉÉ½ÉÌÑ¡”É•™•É•¹”•½µ•ÑÉä¥¸(¼¼Á…­…•Ì½‘ˆ½Ñ•ÍĞ½Õ¹¥ÑÌµµ…ÍÑ•È¹‘‰Ñ•ÍĞ¹ÑÌÌ•áÑÉ…ÑU¹¥Ñ½±Õµ¸¼(¼¼¡…ÉÙ•ÍÑ]É…ÁÁ•‘U¹¥Ğ°É”µ¥µÁ±•µ•¹Ñ•¡•É”Í¼Ñ¡¥ÌÁ…­…”ÍÑ…åÌ™É•”½˜…¹ä(¼¼‘•Á•¹‘•¹ä½¸…ÕÑ¼µµˆ½‘ˆ¤(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¨¨(€¨½±±•ÑÌ•Ù•Éäİ¡¥Ñ•ÍÁ…”µÍ•Á…É…Ñ•Ñ½­•¸™É½´±¥¹•€İ¡½Í”¡½É¥é½¹Ñ…°(€¨ÍÑ…ÉĞ½±Õµ¸™…±±Ì¥¹Í¥‘”m‰…¹‘MÑ…ÉĞ°‰…¹‘¹¥€°…ÁÁ•¹‘¥¹œµ…Ñ¡•Ì½¹Ñ¼(€¨İ½É‘Í€€¡µÕÑ…Ñ•¥¸Á±…”¤¸9¼µ½Àİ¡•¸±¥¹•€¥Ì…‰Í•¹Ğ€¡½ÕĞ½˜É…¹”¤½È(€¨¥Ì¥ÑÍ•±˜…¹½Ñ¡•È…¹¡½È€¡½¹Ñ…¥¹Ì„Á…ÈÑ½­•¸¤ƒŠP¡…ÉÙ•ÍÑ]É…ÁÁ•‘U¹¥Ñ€(€¨‰•±½Ü…±±ÌÑ¡¥Ì½¹”Á•È¹•¥¡‰½ÕÉ¥¹œ±¥¹”É…Ñ¡•ÈÑ¡…¸±½½Á¥¹œ½Ù•È…¸(€¨…ÉÉ…ä½˜½µÁÕÑ•±¥¹”¥¹‘¥•Ì°İ¡¥ ¥Ì‘•±¥‰•É…Ñ”è„™½È€¡½¹ÍĞ¨½˜(€¨m…¹¡½É%¹‘•à€´€È°€¸¸¹t¥€±½½ÀÉ•…‘Ì¹…ÑÕÉ…±±ä¡•É”‰ÕĞÍå¹Ñ…Ñ¥…±±ä(€¨µ…Ñ¡•ÌÑ¡¥ÌÉ•Á¼ÌMMP½µµ…¹µ¥¹©•Ñ¥½¸Ñ…¥¹ĞÉÕ±”Ì…ÉÉ…äµ±¥Ñ•É…°(€¨Í½ÕÉ”Á…ÑÑ•É¸€¡…¹ä…ÉÉ…ä±¥Ñ•É…°¡½±‘¥¹œ„¹½¸µÍÑÉ¥¹œµ±¥Ñ•É…°•±•µ•¹Ğ°(€¨•¹•É¥…±±äİÉ¥ÑÑ•¸Ñ¼…Ñ „Ñ…¥¹Ñ••á•¥±”¡µ°l¸¸¹…ÉÍt¥€…ÉØ(€¨‰Õ¥±¤ƒŠPÑ¡…ĞÁ…ÑÑ•É¸¡…Ì¹¼…İ…É•¹•ÍÌÑ¡…ĞI•áÀ¹ÁÉ½Ñ½ÑåÁ”¹•á•€„™•Ü(€¨±¥¹•Ì±…Ñ•È¥Ì„É••àµ…Ñ °¹½Ğ„Í¡•±°•á•Œ°Í¼Ñ¡”…ÉÉ…äµ½˜µ¥¹‘¥•Ì(€¨Í¡…Á”¡•É”İ…Ì„™…±Í”µÁ½Í¥Ñ¥Ù”MMP™¥¹‘¥¹œ¸½ÕÈ‘¥É•Ğ…±±Ì…ÉÉä(€¨Ñ¡”•á…ĞÍ…µ”‰•¡…Ù¥½ÕÈİ¥Ñ¡½ÕĞÑ¡…Ğ…ÉÉ…ä±¥Ñ•É…°¸(€¨¼)™Õ¹Ñ¥½¸½±±•Ñ	…¹‘Q½­•¹Ì (€±¥¹”èÍÑÉ¥¹œğÕ¹‘•™¥¹•°(€‰…¹‘MÑ…ÉĞè¹Õµ‰•È°(€‰…¹‘¹è¹Õµ‰•È°(€İ½É‘ÌèÍÑÉ¥¹mt°(¤èÙ½¥ì(€¥˜€¡±¥¹”€ôôôÕ¹‘•™¥¹•ñğAI}Q=-9}I¹Ñ•ÍĞ¡±¥¹”¤¤ì(€€€É•ÑÕÉ¸ì(€ô(€½¹ÍĞÑ½­•¹I”€ô€½qL¬½œì(€±•Ğµ…Ñ èI•áÁá•ÉÉ…äğ¹Õ±°ì(€İ¡¥±”€ ¡µ…Ñ €ôÑ½­•¹I”¹•á•Œ¡±¥¹”¤¤€„ôô¹Õ±°¤ì(€€€¥˜€¡µ…Ñ ¹¥¹‘•à€øô‰…¹‘MÑ…ÉĞ€˜˜µ…Ñ ¹¥¹‘•à€ğ‰…¹‘¹¤ì(€€€€€İ½É‘Ì¹ÁÕÍ ¡µ…Ñ¡lÁt¤ì(€€€ô(€ô)ô((¼¨¨(€¨!…ÉÙ•ÍÑÌÕ¹¥Ğµ½±Õµ¸Ñ½­•¹Ì™É½´ÕÀÑ¼Ñİ¼±¥¹•Ì…‰½Ù”½‰•±½ÜÑ¡”…¹¡½È(€¨İ¡½Í”¡½É¥é½¹Ñ…°ÍÑ…ÉĞ½±Õµ¸™…±±Ì¥¹Í¥‘”m‰…¹‘MÑ…ÉĞ°‰…¹‘¹¥€ƒŠPÑ¡”(€¨•µÁÑäÕ¹¥Ğµ½±Õµ¸‰…¹½¸Ñ¡”…¹¡½È±¥¹”¥ÑÍ•±˜¸MÑ½ÁÌ½¹Í¥‘•É¥¹œ…¹ä(€¨¹•¥¡‰½ÕÉ¥¹œ±¥¹”Ñ¡…Ğ¥Ì¥ÑÍ•±˜…¹½Ñ¡•È…¹¡½È€¡½¹Ñ…¥¹Ì„Á…ÈÑ½­•¸¤°(€¨µ…Ñ¡¥¹œÑ¡”É•™•É•¹”•½µ•ÑÉä•á…Ñ±ä¸(€¨¼)™Õ¹Ñ¥½¸¡…ÉÙ•ÍÑ]É…ÁÁ•‘U¹¥Ğ (€±¥¹•ÌèÉ•…‘½¹±äÍÑÉ¥¹mt°(€…¹¡½É%¹‘•àè¹Õµ‰•È°(€‰…¹‘MÑ…ÉĞè¹Õµ‰•È°(€‰…¹‘¹è¹Õµ‰•È°(¤èÍÑÉ¥¹œì(€½¹ÍĞİ½É‘ÌèÍÑÉ¥¹mt€ômtì(€½±±•Ñ	…¹‘Q½­•¹Ì¡±¥¹•Ím…¹¡½É%¹‘•à€´€Ét°‰…¹‘MÑ…ÉĞ°‰…¹‘¹°İ½É‘Ì¤ì(€½±±•Ñ	…¹‘Q½­•¹Ì¡±¥¹•Ím…¹¡½É%¹‘•à€´€Åt°‰…¹‘MÑ…ÉĞ°‰…¹‘¹°İ½É‘Ì¤ì(€½±±•Ñ	…¹‘Q½­•¹Ì¡±¥¹•Ím…¹¡½É%¹‘•à€¬€Åt°‰…¹‘MÑ…ÉĞ°‰…¹‘¹°İ½É‘Ì¤ì(€½±±•Ñ	…¹‘Q½­•¹Ì¡±¥¹•Ím…¹¡½É%¹‘•à€¬€Ét°‰…¹‘MÑ…ÉĞ°‰…¹‘¹°İ½É‘Ì¤ì(€É•ÑÕÉ¸İ½É‘Ì¹©½¥¸ œ€œ¤ì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É•½¹¥±¥…Ñ¥½¸€¡ÅÑäƒ\Õ¹¥Ñ}É…Ñ”ƒŠ& ‰¥‘}…µ½Õ¹Ğ°AI=UPµMAƒ
œÔ¸Ä¸Ì¤(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¼Ù•ÉäÕ¹¥Ñ}É…Ñ”½‰¥‘}…µ½Õ¹Ğ¥¸Ñ¡”¥Ñ•´Ñ…‰±”¥ÌÁÉ¥¹Ñ•Ñ¼•á…Ñ±ä€È(¼¼‘•¥µ…°Á±…•Ì°…¹•Ù•ÉäÅÑä¥¸Ñ¡”Í¥àµ±•ÑÑ•È½ÉÁÕÌ¥Ì„İ¡½±”¹Õµ‰•È(¼¼€¡¹¼™É…Ñ¥½¹…°ÅÕ…¹Ñ¥Ñä¥Ì•Ù•ÈÁÉ¥¹Ñ•¤ƒŠPÍ¼ÅÑäƒ\Õ¹¥Ñ}É…Ñ”É•½¹¥±•Ì(¼¼Ñ¼‰¥‘}…µ½Õ¹ĞÑ¼Ñ¡”aPÁ…¥Í„½¸…±°€ÈàÄÉ•…°É½İÌ€¡Ù•É¥™¥•¤¸i•É¼¥Ì(¼¼Ñ¡•É•™½É”Ñ¡”½ÉÉ•ĞÑ½±•É…¹”™½ÈÑ¡¥Ì½ÉÁÕÌì¥Ğ¥ÌÍÑ¥±°…¸•áÁ±¥¥Ğ°(¼¼ÍÑ…Ñ•°…¹©ÕÍÑ¥™¥•‰½Õ¹€¡É…Ñ¡•ÈÑ¡…¸…¸Õ¹ÍÑ…Ñ•…ÍÍÕµÁÑ¥½¸¤‰•…ÕÍ”(¼¼„™ÕÑÕÉ”™¥áÑÕÉ”İ¥Ñ „•¹Õ¥¹•±ä™É…Ñ¥½¹…°ÅÑä¥Ì„‘…Ñ„µÍ¡…Á”¡…¹”(¼¼Ñ¡¥Ì½µµ•¹Ğ™±…Ì™½ÈÑ¡”¹•áĞÉ•…‘•È°¹½ĞÍ½µ•Ñ¡¥¹œ„Í¥±•¹Ñ±äµİ¥‘•¹•(¼¼‰…¹Í¡½Õ±Á…Á•È½Ù•È¸)½¹ÍĞI=9%1%Q%=9}Q=1I9}A%M€ô€Á¸ì()™Õ¹Ñ¥½¸É•½¹¥±•%Ñ•´ (€ÅÑäèÍÑÉ¥¹œ°(€Õ¹¥ÑI…Ñ”èÍÑÉ¥¹œ°(€‰¥‘µ½Õ¹ĞèÍÑÉ¥¹œ°(¤è%Ñ•µI•½¹¥±¥…Ñ¥½¸ì(€½¹ÍĞÅÑå5¥¹½È€ôÁ…ÉÍ••¥µ…±Q½5¥¹½ÉU¹¥ÑÌ¡ÅÑä°€À¤ì(€½¹ÍĞÉ…Ñ•5¥¹½È€ôÁ…ÉÍ••¥µ…±Q½5¥¹½ÉU¹¥ÑÌ¡Õ¹¥ÑI…Ñ”°€È¤ì(€½¹ÍĞ‰¥‘5¥¹½È€ôÁ…ÉÍ••¥µ…±Q½5¥¹½ÉU¹¥ÑÌ¡‰¥‘µ½Õ¹Ğ°€È¤ì(€¥˜€¡ÅÑå5¥¹½È€ôôô¹Õ±°ñğÉ…Ñ•5¥¹½È€ôôô¹Õ±°ñğ‰¥‘5¥¹½È€ôôô¹Õ±°¤ì(€€€É•ÑÕÉ¸ì(€€€€€½¬è™…±Í”°(€€€€€•áÁ•Ñ•‘µ½Õ¹Ğè¹Õ±°°(€€€€€‘¥™˜è¹Õ±°°(€€€€€É•½Ù•Éå!¥¹Ğè¹Õ±°°(€€€ôì(€ô(€€¼¼ÅÑä¥Ì„Á±…¥¸¥¹Ñ••È½Õ¹Ğ…¹É…Ñ•5¥¹½È¥Ì…±É•…‘ä¥¸Á…¥Í„°Í¼Ñ¡•¥È(€€¼¼ÁÉ½‘ÕĞ¥Ì•á…Ñ±äÑ¡”•áÁ•Ñ•‰¥…µ½Õ¹Ğ¥¸Á…¥Í„ƒŠP¹¼™ÕÉÑ¡•È(€€¼¼É½Õ¹‘¥¹œÍÑ•À°…¹Ñ¡•É•™½É”¹¼É½Õ¹‘¥¹œ•ÉÉ½È°¥ÌÁ½ÍÍ¥‰±”¸(€½¹ÍĞ•áÁ•Ñ•‘5¥¹½È€ôÅÑå5¥¹½È€¨É…Ñ•5¥¹½Èì(€½¹ÍĞ‘¥™™5¥¹½È€ô•áÁ•Ñ•‘5¥¹½È€´‰¥‘5¥¹½Èì(€½¹ÍĞ…‰Í¥™˜€ô‘¥™™5¥¹½È€ğ€Á¸€ü€µ‘¥™™5¥¹½È€è‘¥™™5¥¹½Èì(€½¹ÍĞ½¬€ô…‰Í¥™˜€ğôI=9%1%Q%=9}Q=1I9}A%Mì((€±•ĞÉ•½Ù•Éå!¥¹Ğè%Ñ•µI•½¹¥±¥…Ñ¥½¹lÉ•½Ù•Éå!¥¹Ğt€ô¹Õ±°ì(€¥˜€ …½¬¤ì(€€€¥˜€¡•áÁ•Ñ•‘5¥¹½È€ôôô‰¥‘5¥¹½È€¨€ÄÁ¸¤ì(€€€€€É•½Ù•Éå!¥¹Ğ€ô€‘•¥µ…°µÍ¡¥™ĞµàÄÀœì(€€€ô•±Í”¥˜€¡•áÁ•Ñ•‘5¥¹½È€¨€ÄÁ¸€ôôô‰¥‘5¥¹½È¤ì(€€€€€É•½Ù•Éå!¥¹Ğ€ô€‘•¥µ…°µÍ¡¥™Ğµ‘¥ØÄÀœì(€€€ô(€ô((€É•ÑÕÉ¸ì(€€€½¬°(€€€•áÁ•Ñ•‘µ½Õ¹Ğè™½Éµ…Ñ5¥¹½ÉU¹¥ÑÌ¡•áÁ•Ñ•‘5¥¹½È°€È¤°(€€€‘¥™˜è™½Éµ…Ñ5¥¹½ÉU¹¥ÑÌ¡‘¥™™5¥¹½È°€È¤°(€€€É•½Ù•Éå!¥¹Ğ°(€ôì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼•¹ÑÉäÁ½¥¹Ğ(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()™Õ¹Ñ¥½¸¹½¹	±…¹­QÉ¥µµ•¡±¥¹•ÌèÉ•…‘½¹±äÍÑÉ¥¹mt¤èÍÑÉ¥¹mtì(€É•ÑÕÉ¸±¥¹•Ì¹µ…À ¡°¤€ôø°¹ÑÉ¥´ ¤¤¹™¥±Ñ•È ¡°¤€ôø°¹±•¹Ñ €ø€À¤ì)ô((¼¨¨(€¨A…ÉÍ•Ì•Ù•Éä¥Ñ•´É½Ü½ÕĞ½˜„É…Ü€¡½È…±É•…‘äÁÉ¥¹Ğµ™ÕÉ¹¥ÑÕÉ”µÍÑÉ¥ÁÁ•ƒŠP(€¨ÍÑÉ¥ÁÁ¥¹œ¥Ì¥‘•µÁ½Ñ•¹Ğ¤Á‘™Ñ½Ñ•áĞ€µ±…å½ÕÑ€1=•áÑÉ…Ñ¥½¸°Á•È(€¨É•Í•…É ƒ
œÈÌ…±½É¥Ñ¡´¸MÑÉ¥ÁÌÁÉ¥¹Ğ™ÕÉ¹¥ÑÕÉ”™¥ÉÍĞ€¡™ÕÉ¹¥ÑÕÉ”¹ÑÌ°Á•È(€¨Ñ¡”Ñ¥­•ĞÌ½É‘•É¥¹œÉ•ÅÕ¥É•µ•¹ĞƒŠPµ¥ÉÉ½ÉÌ•áÑÉ…Ñ!•…‘•É€Ì½İ¸™¥ÉÍĞ(€¨ÍÑ•À¤°Ñ¡•¸±½…Ñ•ÌÑ¡”¥Ñ•´µÑ…‰±”É•¥½¸€¡…™Ñ•ÈÑ¡”(€¨İ…É‘•EÕ…¹Ñ¥Ñ¥•Ì¹I…Ñ•Í€µ…É­•ÈƒŠPÑ¡¥Ì•á±ÕÍ¥½¸¥Ìİ¡…Ğ­••ÁÌ(€¨A0ÈàÀµ$Ì€‰	…¹¹•€è€¸¸¸M¡•‘Õ±”´ˆÁÉ½Í”‘•½ä™É½´‰•¥¹œµ¥ÍÑ…­•¸(€¨™½È„É•…°Í¡•‘Õ±”¡•…‘•È¤°Ñ¡•¸…¹¡½ÉÌ½¸Ñ¡”Á…ÈÑ½­•¸Á•ÈÉ½Ü¸(€¨(€¨9•Ù•ÈÑ¡É½İÌ…¹¹•Ù•È‘É½ÁÌ…¸…¹¡½Èè„Á…ÈµÑ½­•¸µ‰•…É¥¹œ±¥¹”Ñ¡¥Ì(€¨µ½‘Õ±”…¹¹½Ğ™Õ±±ä‘•½µÁ½Í”ÍÑ¥±°ÁÉ½‘Õ•Ì½¹”A…ÉÍ•‘%Ñ•µ€€¡İ¥Ñ (€¨¹••‘ÍI•Ù¥•ÜèÑÉÕ•€…¹•Ù•ÉäÕ¹É•Í½±Ù•™¥•±±•™Ğ…Ì…¸•µÁÑäÍÑÉ¥¹œ(€¨É…Ñ¡•ÈÑ¡…¸Õ•ÍÍ•¤ƒŠPÕ¹•á•É¥Í•‰äÑ¡”Í¥àµ±•ÑÑ•È½ÉÁÕÌ°İ¡•É”•Ù•Éä(€¨½¹”½˜Ñ¡”€ÈàÄ…¹¡½È±¥¹•Ì‘•½µÁ½Í•Ì±•…¹±ä°‰ÕĞ±½…µ‰•…É¥¹œ™½ÈÑ¡”(€¨€ˆÈàÄÑ½Ñ…°°¹•Ù•Èµ½É”°¹•Ù•È™•İ•È°¹•Ù•ÈÍ¥±•¹Ñ±ä‘É½ÁÁ•ˆÉ•É•ÍÍ¥½¸(€¨‰…ÈÑ¡¥ÌÑ¥­•Ğ•á¥ÍÑÌÑ¼¡½±¸(€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸Á…ÉÍ•%Ñ•µÌ (€É…İQ•áĞèÍÑÉ¥¹œ°(€½ÁÑ¥½¹ÌèA…ÉÍ•%Ñ•µÍ=ÁÑ¥½¹Ì€ôíô°(¤èÉ•…‘½¹±äA…ÉÍ•‘%Ñ•µmtì(€½¹ÍĞÍÑÉ¥ÁÁ•€ôÍÑÉ¥ÁAÉ¥¹ÑÕÉ¹¥ÑÕÉ”¡É…İQ•áĞ¤ì(€½¹ÍĞµ…É­•É%‘à€ôÍÑÉ¥ÁÁ•¹¥¹‘•á=˜¡%Q5}Q	1}5I-H¤ì(€½¹ÍĞ¥Ñ•µI•¥½¹Q•áĞ€ôµ…É­•É%‘à€ôôô€´Ä€ü€œœ€èÍÑÉ¥ÁÁ•¹Í±¥”¡µ…É­•É%‘à¤ì(€½¹ÍĞ±¥¹•Ì€ô¥Ñ•µI•¥½¹Q•áĞ¹ÍÁ±¥Ğ q¸œ¤ì((€½¹ÍĞ¡•…‘•ÉMÑ…ÉÑ%‘áÌè¹Õµ‰•Émt€ômtì(€½¹ÍĞ…¹¡½É%‘áÌè¹Õµ‰•Émt€ômtì(€½¹ÍĞÍ¡•‘Õ±•Q½Ñ…±Í%‘áÌè¹Õµ‰•Émt€ômtì(€±¥¹•Ì¹™½É…  ¡±¥¹”°¤¤€ôøì(€€€¥˜€¡M!U1}!I}MQIQ}I¹Ñ•ÍĞ¡±¥¹”¤¤ì(€€€€€¡•…‘•ÉMÑ…ÉÑ%‘áÌ¹ÁÕÍ ¡¤¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€¥˜€¡M!U1}Q=Q1M}I¹Ñ•ÍĞ¡±¥¹”¤¤ì(€€€€€Í¡•‘Õ±•Q½Ñ…±Í%‘áÌ¹ÁÕÍ ¡¤¤ì(€€€€€É•ÑÕÉ¸ì(€€€ô(€€€¥˜€¡AI}Q=-9}I¹Ñ•ÍĞ¡±¥¹”¤¤ì(€€€€€…¹¡½É%‘áÌ¹ÁÕÍ ¡¤¤ì(€€€ô(€ô¤ì((€½¹ÍĞ¡•…‘•ÉÌèM¡•‘Õ±•!•…‘•É	±½­mt€ô¡•…‘•ÉMÑ…ÉÑ%‘áÌ(€€€€¹µ…À ¡ÍÑ…ÉÑ%‘à°¡¤¤€ôøì(€€€€€½¹ÍĞ¹•áÑ!•…‘•É%‘à€ô¡•…‘•ÉMÑ…ÉÑ%‘áÍm¡¤€¬€Åt€üü±¥¹•Ì¹±•¹Ñ ì(€€€€€½¹ÍĞ¹•áÑ¹¡½É%‘à€ô…¹¡½É%‘áÌ¹™¥¹ ¡„¤€ôø„€øÍÑ…ÉÑ%‘à¤€üü±¥¹•Ì¹±•¹Ñ ì(€€€€€½¹ÍĞ•¹‘	½Õ¹€ô5…Ñ ¹µ¥¸¡¹•áÑ!•…‘•É%‘à°¹•áÑ¹¡½É%‘à¤ì(€€€€€É•ÑÕÉ¸Á…ÉÍ•M¡•‘Õ±•!•…‘•É	±½¬¡±¥¹•Ì°ÍÑ…ÉÑ%‘à°•¹‘	½Õ¹¤ì(€€€ô¤(€€€€¹™¥±Ñ•È ¡ ¤è ¥ÌM¡•‘Õ±•!•…‘•É	±½¬€ôø €„ôô¹Õ±°¤ì((€™Õ¹Ñ¥½¸Í¡•‘Õ±•½È¡…¹¡½É%‘àè¹Õµ‰•È¤èM¡•‘Õ±•!•…‘•É	±½¬ğ¹Õ±°ì(€€€±•Ğ™½Õ¹èM¡•‘Õ±•!•…‘•É	±½¬ğ¹Õ±°€ô¹Õ±°ì(€€€™½È€¡½¹ÍĞ ½˜¡•…‘•ÉÌ¤ì(€€€€€¥˜€¡ ¹ÍÑ…ÉÑ%‘à€ğô…¹¡½É%‘à¤ì(€€€€€€€™½Õ¹€ô ì(€€€€€ô•±Í”ì(€€€€€€€‰É•…¬ì(€€€€€ô(€€€ô(€€€É•ÑÕÉ¸™½Õ¹ì(€ô((€½¹ÍĞÁ…ÉÍ•‘%Ñ•µÌ€ô…¹¡½É%‘áÌ¹µ…À ¡„°…¤¤èA…ÉÍ•‘%Ñ•´€ôøì(€€€½¹ÍĞ…¹¡½É1¥¹”€ô±¥¹•Ím…t€üü€œœì(€€€½¹ÍĞÍ¡•‘Õ±”€ôÍ¡•‘Õ±•½È¡„¤ì(€€€½¹ÍĞÍ¡•‘Õ±•	¥¹‘¥¹œè%Ñ•µM¡•‘Õ±•	¥¹‘¥¹œğ¹Õ±°€ô(€€€€€Í¡•‘Õ±”€ôôô¹Õ±°€ü¹Õ±°€èì¥èÍ¡•‘Õ±”¹¥°‘¥É•Ñ½ÉäèÍ¡•‘Õ±”¹‘¥É•Ñ½Éäôì((€€€½¹ÍĞÁÉ•Ù¹¡½É%‘à€ô…¤€ø€À€ü€¡…¹¡½É%‘áÍm…¤€´€Åt…Ì¹Õµ‰•È¤€è€´Äì(€€€½¹ÍĞ¡•…‘•É	±½­¹€ôÍ¡•‘Õ±”€ôôô¹Õ±°€ü€´Ä€èÍ¡•‘Õ±”¹‰±½­¹‘%‘àì(€€€½¹ÍĞ…‰½Ù•MÑ…ÉĞ€ô5…Ñ ¹µ…à¡ÁÉ•Ù¹¡½É%‘à°¡•…‘•É	±½­¹¤€¬€Äì(€€€½¹ÍĞ¹•áÑ¹¡½É%‘à€ô…¹¡½É%‘áÍm…¤€¬€Åt€üü±¥¹•Ì¹±•¹Ñ ì(€€€½¹ÍĞ¹•áÑ!•…‘•ÉMÑ…ÉĞ€ô¡•…‘•ÉMÑ…ÉÑ%‘áÌ¹™¥¹ ¡ ¤€ôø €ø„¤€üü±¥¹•Ì¹±•¹Ñ ì(€€€½¹ÍĞ¹•áÑM¡•‘Õ±•Q½Ñ…±Ì€ôÍ¡•‘Õ±•Q½Ñ…±Í%‘áÌ¹™¥¹ ¡Ì¤€ôøÌ€ø„¤€üü±¥¹•Ì¹±•¹Ñ ì(€€€½¹ÍĞ‰•±½İ¹€ô5…Ñ ¹µ¥¸¡¹•áÑ¹¡½É%‘à°¹•áÑ!•…‘•ÉMÑ…ÉĞ°¹•áÑM¡•‘Õ±•Q½Ñ…±Ì¤€´€Äì((€€€½¹ÍĞÉ…İ‰½Ù•1¥¹•Ì€ô±¥¹•Ì¹Í±¥”¡…‰½Ù•MÑ…ÉĞ°„¤ì(€€€½¹ÍĞÉ…İ	•±½İ1¥¹•Ì€ô±¥¹•Ì¹Í±¥”¡„€¬€Ä°5…Ñ ¹µ…à¡‰•±½İ¹€¬€Ä°„€¬€Ä¤¤ì((€€€½¹ÍĞÍ¹½5…Ñ €ô%Q5}M9=}I¹•á•Œ¡…¹¡½É1¥¹”¤ì(€€€¥˜€¡Í¹½5…Ñ €ôôô¹Õ±°¤ì(€€€€€É•ÑÕÉ¸µ…±™½Éµ•‘%Ñ•´ (€€€€€€€Í¡•‘Õ±•	¥¹‘¥¹œ°(€€€€€€€€œœ°(€€€€€€€…¹¡½É1¥¹”°(€€€€€€€É…İ‰½Ù•1¥¹•Ì°(€€€€€€€É…İ	•±½İ1¥¹•Ì°(€€€€€€¤ì(€€€ô(€€€½¹ÍĞ¥Ñ•µM¹¼€ô€¡Í¹½5…Ñ¡lÅt€üü€œœ¤¹ÑÉ¥´ ¤ì(€€€½¹ÍĞÉ•ÍĞ€ôÍ¹½5…Ñ¡lÉt€üü€œœì(€€€½¹ÍĞÉ•ÍÑ=™™Í•Ğ€ô…¹¡½É1¥¹”¹±•¹Ñ €´É•ÍĞ¹±•¹Ñ ì((€€€½¹ÍĞÑ…¥±5…Ñ €ô9!=I}Q%1}I¹•á•Œ¡É•ÍĞ¤ì(€€€¥˜€¡Ñ…¥±5…Ñ €ôôô¹Õ±°¤ì(€€€€€É•ÑÕÉ¸µ…±™½Éµ•‘%Ñ•´ (€€€€€€€Í¡•‘Õ±•	¥¹‘¥¹œ°(€€€€€€€¥Ñ•µM¹¼°(€€€€€€€…¹¡½É1¥¹”°(€€€€€€€É…İ‰½Ù•1¥¹•Ì°(€€€€€€€É…İ	•±½İ1¥¹•Ì°(€€€€€€¤ì(€€€ô(€€€½¹ÍĞÁÉ••ÍŒ€ôÑ…¥±5…Ñ¡lÅt€üü€œœì(€€€½¹ÍĞÕ¹¥ÑI…Ñ”€ôÑ…¥±5…Ñ¡lÉt€üü€œœì(€€€½¹ÍĞÁ…ÉQ½­•¸€ô€¡Ñ…¥±5…Ñ¡lÍt€üü€œœ¤…ÌA…ÉQ½­•¹¥É•Ñ¥½¸ì(€€€½¹ÍĞ‰¥‘µ½Õ¹Ğ€ôÑ…¥±5…Ñ¡lÑt€üü€œœì((€€€½¹ÍĞÁ••±•€ôÁ••±¹¡½ÉQ…¥°¡ÁÉ••ÍŒ¤ì(€€€¥˜€¡Á••±•€ôôô¹Õ±°¤ì(€€€€€É•ÑÕÉ¸µ…±™½Éµ•‘%Ñ•´ (€€€€€€€Í¡•‘Õ±•	¥¹‘¥¹œ°(€€€€€€€¥Ñ•µM¹¼°(€€€€€€€…¹¡½É1¥¹”°(€€€€€€€É…İ‰½Ù•1¥¹•Ì°(€€€€€€€É…İ	•±½İ1¥¹•Ì°(€€€€€€¤ì(€€€ô((€€€±•ĞÅÑåU¹¥ĞèÍÑÉ¥¹œğ¹Õ±°€ôÁ••±•¹ÅÑåU¹¥Ğ¹±•¹Ñ €ø€À€üÁ••±•¹ÅÑåU¹¥Ğ€è¹Õ±°ì(€€€±•ĞÅÑåU¹¥Ñ]É…ÁÁ•€ô™…±Í”ì(€€€¥˜€¡ÅÑåU¹¥Ğ€ôôô¹Õ±°¤ì(€€€€€½¹ÍĞÅÑå¹‘%¹I•ÍĞ€ôÁÉ••ÍŒ¹±•¹Ñ ì(€€€€€½¹ÍĞÉ…Ñ•MÑ…ÉÑ%¹I•ÍĞ€ôÉ•ÍĞ¹¥¹‘•á=˜¡Õ¹¥ÑI…Ñ”°ÅÑå¹‘%¹I•ÍĞ¤ì(€€€€€½¹ÍĞ‰…¹‘MÑ…ÉĞ€ôÉ•ÍÑ=™™Í•Ğ€¬ÅÑå¹‘%¹I•ÍĞì(€€€€€½¹ÍĞ‰…¹‘¹€ô(€€€€€€€É•ÍÑ=™™Í•Ğ€¬€¡É…Ñ•MÑ…ÉÑ%¹I•ÍĞ€ôôô€´Ä€üÅÑå¹‘%¹I•ÍĞ€èÉ…Ñ•MÑ…ÉÑ%¹I•ÍĞ¤ì(€€€€€½¹ÍĞ¡…ÉÙ•ÍÑ•€ô¡…ÉÙ•ÍÑ]É…ÁÁ•‘U¹¥Ğ¡±¥¹•Ì°„°‰…¹‘MÑ…ÉĞ°‰…¹‘¹¤ì(€€€€€¥˜€¡¡…ÉÙ•ÍÑ•¹±•¹Ñ €ø€À¤ì(€€€€€€€ÅÑåU¹¥Ğ€ô¡…ÉÙ•ÍÑ•ì(€€€€€€€ÅÑåU¹¥Ñ]É…ÁÁ•€ôÑÉÕ”ì(€€€€€ô(€€€ô((€€€½¹ÍĞ…‰½Ù•1¥¹•Ì€ô¹½¹	±…¹­QÉ¥µµ•¡É…İ‰½Ù•1¥¹•Ì¤ì(€€€½¹ÍĞ‰•±½İ1¥¹•Ì€ô¹½¹	±…¹­QÉ¥µµ•¡É…İ	•±½İ1¥¹•Ì¤ì(€€€½¹ÍĞ‘•ÍÉ¥ÁÑ¥½¸€ôl(€€€€€€¸¸¹…‰½Ù•1¥¹•Ì°(€€€€€€¸¸¸¡Á••±•¹‘•Í=¹1¥¹”¹±•¹Ñ €ø€À€ümÁ••±•¹‘•Í=¹1¥¹•t€èmt¤°(€€€€€€¸¸¹‰•±½İ1¥¹•Ì°(€€€t¹©½¥¸ œ€œ¤ì((€€€½¹ÍĞÉ•½¹¥±¥…Ñ¥½¸€ôÉ•½¹¥±•%Ñ•´¡Á••±•¹ÅÑä°Õ¹¥ÑI…Ñ”°‰¥‘µ½Õ¹Ğ¤ì(€€€½¹ÍĞ¹••‘ÍI•Ù¥•Ü€ô(€€€€€ÅÑåU¹¥Ğ€ôôô¹Õ±°ñğ€…É•½¹¥±¥…Ñ¥½¸¹½¬ñğÍ¡•‘Õ±•	¥¹‘¥¹œ€ôôô¹Õ±°ì((€€€É•ÑÕÉ¸ì(€€€€€Í¡•‘Õ±”èÍ¡•‘Õ±•	¥¹‘¥¹œ°(€€€€€¥Ñ•µM¹¼°(€€€€€¥Ñ•µ½‘”èÁ••±•¹¥Ñ•µ½‘”°(€€€€€‘•ÍÉ¥ÁÑ¥½¸°(€€€€€‘•ÍÉ¥ÁÑ¥½¹M½ÕÉ”è€±…å½ÕĞµ½Ù•É¥¹±ÕÍ¥Ù”œ°(€€€€€ÅÑäèÁ••±•¹ÅÑä°(€€€€€ÅÑåU¹¥Ğ°(€€€€€ÅÑåU¹¥Ñ]É…ÁÁ•°(€€€€€Õ¹¥ÑI…Ñ”°(€€€€€Á…ÉQ½­•¸°(€€€€€‰¥‘µ½Õ¹Ğ°(€€€€€É•½¹¥±¥…Ñ¥½¸°(€€€€€¹••‘ÍI•Ù¥•Ü°(€€€€€É…Üèì(€€€€€€€…¹¡½É1¥¹”°(€€€€€€€…‰½Ù•1¥¹•ÌèÉ…İ‰½Ù•1¥¹•Ì°(€€€€€€€‰•±½İ1¥¹•ÌèÉ…İ	•±½İ1¥¹•Ì°(€€€€€ô°(€€€ôì(€ô¤ì((€¥˜€¡½ÁÑ¥½¹Ì¹É…İ%Ñ•µQ•áĞ€ôôôÕ¹‘•™¥¹•ñğÁ…ÉÍ•‘%Ñ•µÌ¹±•¹Ñ €ôôô€À¤ì(€€€É•ÑÕÉ¸Á…ÉÍ•‘%Ñ•µÌì(€ô(€½¹ÍĞ•áÁ•Ñ…Ñ¥½¹ÌèI…İ%Ñ•µáÁ•Ñ…Ñ¥½¹mt€ôÁ…ÉÍ•‘%Ñ•µÌ¹µ…À ¡¥Ñ•´¤€ôø€¡ì(€€€Í¡•‘Õ±•%è¥Ñ•´¹Í¡•‘Õ±”ü¹¥€üü¹Õ±°°(€€€¥Ñ•µM¹¼è¥Ñ•´¹¥Ñ•µM¹¼°(€€€¥Ñ•µ½‘”è¥Ñ•´¹¥Ñ•µ½‘”°(€€€ÅÑäè¥Ñ•´¹ÅÑä°(€€€ÅÑåU¹¥Ğè¥Ñ•´¹ÅÑåU¹¥Ğ°(€€€ÅÑåU¹¥Ñ]É…ÁÁ•è¥Ñ•´¹ÅÑåU¹¥Ñ]É…ÁÁ•°(€€€Õ¹¥ÑI…Ñ”è¥Ñ•´¹Õ¹¥ÑI…Ñ”°(€€€Á…ÉQ½­•¸è¥Ñ•´¹Á…ÉQ½­•¸°(€€€‰¥‘µ½Õ¹Ğè¥Ñ•´¹‰¥‘µ½Õ¹Ğ°(€ô¤¤ì(€½¹ÍĞÉ•½Ù•Éä€ôÉ•½Ù•ÉI…İ%Ñ•µ•ÍÉ¥ÁÑ¥½¹Ì¡½ÁÑ¥½¹Ì¹É…İ%Ñ•µQ•áĞ°•áÁ•Ñ…Ñ¥½¹Ì¤ì(€¥˜€ …É•½Ù•Éä¹½¬¤É•ÑÕÉ¸Á…ÉÍ•‘%Ñ•µÌì(€½¹ÍĞ•á…Ñ%Ñ•µÌèA…ÉÍ•‘%Ñ•µmt€ômtì(€™½È€¡±•Ğ¥¹‘•à€ô€Àì¥¹‘•à€ğÁ…ÉÍ•‘%Ñ•µÌ¹±•¹Ñ ì¥¹‘•à€¬ô€Ä¤ì(€€€½¹ÍĞ¥Ñ•´€ôÁ…ÉÍ•‘%Ñ•µÍm¥¹‘•átì(€€€½¹ÍĞ•á…Ğ€ôÉ•½Ù•Éä¹‘•ÍÉ¥ÁÑ¥½¹Ím¥¹‘•átì(€€€¥˜€¡¥Ñ•´€ôôôÕ¹‘•™¥¹•ñğ•á…Ğ€ôôôÕ¹‘•™¥¹•¤É•ÑÕÉ¸Á…ÉÍ•‘%Ñ•µÌì(€€€•á…Ñ%Ñ•µÌ¹ÁÕÍ ¡ì(€€€€€€¸¸¹¥Ñ•´°(€€€€€‘•ÍÉ¥ÁÑ¥½¸è•á…Ğ¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€‘•ÍÉ¥ÁÑ¥½¹M½ÕÉ”è€É…Üµ•á…Ğœ°(€€€€€É…Üèì(€€€€€€€€¸¸¹¥Ñ•´¹É…Ü°(€€€€€€€•á…Ñ•ÍÉ¥ÁÑ¥½¹1¥¹•Ìè•á…Ğ¹Í½ÕÉ•1¥¹•Ì°(€€€€€ô°(€€€ô¤ì(€ô(€É•ÑÕÉ¸•á…Ñ%Ñ•µÌì)ô((¼¨¨(€¨•™•¹Í¥Ù”™…±±‰…¬™½È„Á…ÈµÑ½­•¸µ‰•…É¥¹œ±¥¹”Ñ¡¥Ìµ½‘Õ±”½Õ±¹½Ğ(€¨™Õ±±ä‘•½µÁ½Í”€¡Õ¹•á•É¥Í•‰äÑ¡”Í¥àµ±•ÑÑ•È½ÉÁÕÌƒŠP•Ù•Éä½¹”½˜¥ÑÌ(€¨€ÈàÄ…¹¡½È±¥¹•Ì‘•½µÁ½Í•Ì±•…¹±ä¤¸Ù•ÉäÕ¹É•Í½±Ù•™¥•±¥Ì…¸•µÁÑä(€¨ÍÑÉ¥¹œ°¹•Ù•È„Õ•ÍÌ°…¹¹••‘ÍI•Ù¥•İ€¥Ì…±İ…åÌÑÉÕ”ìÑ¡”…¹¡½È¥Ì(€¨ÍÑ¥±°½Õ¹Ñ•€¡¹•Ù•ÈÍ¥±•¹Ñ±ä‘É½ÁÁ•¤°ÁÉ•Í•ÉÙ¥¹œÑ¡”€ÈàÄµ¥Ñ•´(€¨É•É•ÍÍ¥½¸‰…È•Ù•¸Õ¹‘•Èµ…±™½Éµ•¥¹ÁÕĞÑ¡¥Ìµ½‘Õ±”¡…Ì¹•Ù•È…ÑÕ…±±ä(€¨Í••¸¸(€¨¼)™Õ¹Ñ¥½¸µ…±™½Éµ•‘%Ñ•´ (€Í¡•‘Õ±”è%Ñ•µM¡•‘Õ±•	¥¹‘¥¹œğ¹Õ±°°(€¥Ñ•µM¹¼èÍÑÉ¥¹œ°(€…¹¡½É1¥¹”èÍÑÉ¥¹œ°(€É…İ‰½Ù•1¥¹•ÌèÉ•…‘½¹±äÍÑÉ¥¹mt°(€É…İ	•±½İ1¥¹•ÌèÉ•…‘½¹±äÍÑÉ¥¹mt°(¤èA…ÉÍ•‘%Ñ•´ì(€€¼¼…¹¡½É1¥¹•€¥Ì½¹±ä•Ù•ÈÉ½ÕÑ•¡•É”…™Ñ•È…±É•…‘äµ…Ñ¡¥¹œ(€€¼¼AI}Q=-9}I€€¡Ñ¡…ĞÌ¡½Ü¥Ğ‰•…µ”…¸…¹¡½È¥¹‘•à¥¸Ñ¡”™¥ÉÍĞ(€€¼¼Á±…”¤ƒŠPÍ¼Ñ¡”É•…°ÁÉ¥¹Ñ•Ñ½­•¸¥ÌÉ•½Ù•É…‰±”•Ù•¸Ñ¡½Õ Ñ¡”(€€¼¼ÍÑÉ¥Ñ•ÈÑ…¥°½Á••°Á…ÉÍ”™…¥±•¸…±±Ì‰…¬Ñ¼ĞA…É€½¹±ä¥¸Ñ¡”(€€¼¼ÍÑÉÕÑÕÉ…±±äµ¥µÁ½ÍÍ¥‰±”…Í”İ¡•É”¥ĞÍ½µ•¡½Ü¥Ì¹½Ğ€¡¹•Ù•È„Õ•ÍÌ(€€¼¼‰•å½¹€‰Ñ¡”½ÉÁÕÌÌ½Ù•Éİ¡•±µ¥¹±ä½µµ½¸Ñ½­•¸ˆ°…¹¹••‘ÍI•Ù¥•İ€¥Ì(€€¼¼Õ¹½¹‘¥Ñ¥½¹…±±äÑÉÕ”•¥Ñ¡•Èİ…äÍ¼¹½Ñ¡¥¹œ‘½İ¹ÍÑÉ•…´ÑÉÕÍÑÌÑ¡¥Ì(€€¼¼Ù…±Õ”Í¥±•¹Ñ±ä¤¸(€½¹ÍĞÁ…ÉQ½­•¹5…Ñ €ôAI}Q=-9}I¹•á•Œ¡…¹¡½É1¥¹”¤ì(€½¹ÍĞÁ…ÉQ½­•¸€ô€¡Á…ÉQ½­•¹5…Ñ ü¹lÁt€üü€ĞA…Èœ¤…ÌA…ÉQ½­•¹¥É•Ñ¥½¸ì(€É•ÑÕÉ¸ì(€€€Í¡•‘Õ±”°(€€€¥Ñ•µM¹¼°(€€€¥Ñ•µ½‘”è€œœ°(€€€‘•ÍÉ¥ÁÑ¥½¸è¹½¹	±…¹­QÉ¥µµ•¡l¸¸¹É…İ‰½Ù•1¥¹•Ì°…¹¡½É1¥¹”°€¸¸¹É…İ	•±½İ1¥¹•Ít¤¹©½¥¸ (€€€€€€œ€œ°(€€€€¤°(€€€‘•ÍÉ¥ÁÑ¥½¹M½ÕÉ”è€±…å½ÕĞµ½Ù•É¥¹±ÕÍ¥Ù”œ°(€€€ÅÑäè€œœ°(€€€ÅÑåU¹¥Ğè¹Õ±°°(€€€ÅÑåU¹¥Ñ]É…ÁÁ•è™…±Í”°(€€€Õ¹¥ÑI…Ñ”è€œœ°(€€€Á…ÉQ½­•¸°(€€€‰¥‘µ½Õ¹Ğè€œœ°(€€€É•½¹¥±¥…Ñ¥½¸èì(€€€€€½¬è™…±Í”°(€€€€€•áÁ•Ñ•‘µ½Õ¹Ğè¹Õ±°°(€€€€€‘¥™˜è¹Õ±°°(€€€€€É•½Ù•Éå!¥¹Ğè¹Õ±°°(€€€ô°(€€€¹••‘ÍI•Ù¥•ÜèÑÉÕ”°(€€€É…Üèì(€€€€€…¹¡½É1¥¹”°(€€€€€…‰½Ù•1¥¹•ÌèÉ…İ‰½Ù•1¥¹•Ì°(€€€€€‰•±½İ1¥¹•ÌèÉ…İ	•±½İ1¥¹•Ì°(€€€ô°(€ôì)ô(