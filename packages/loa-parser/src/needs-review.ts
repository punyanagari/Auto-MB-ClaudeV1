/**
 * @auto-mb/loa-parser â€” the `needsReview` trigger set (DC-26; legacy ticket DC-26;
 * docs/reference/loa-parser-contract.md Â§4 "Traps that must raise
 * `needsReview` rather than parse silently", Â§5 "Unexercised template
 * branches").
 *
 * This module never re-parses raw text where a sibling module already owns
 * the field: it composes `extractHeader` (header.ts), `parseItems`
 * (items.ts) and `classifyPricingShape` (pricing-shape.ts) and layers a
 * SECOND pass of review triggers on top of their output, plus a small set of
 * text-scans for prose that no sibling module extracts as a field at all
 * (the corrigendum keyword, the item-naming corrigendum sentence, the
 * `Item Breakup` / `Banned` template sections). PRODUCT-SPEC Â§5.1's "never
 * discards information" contract is upheld by construction here: every flag
 * this module produces is ADDITIVE â€” a record alongside the already-parsed
 * data, never a replacement for it, and never a reason to drop a field.
 *
 * FLAG SHAPE (ticket, verbatim): `{ code, scope: 'letter'|'schedule'|'item',
 * targetId, rawBlock, message }`. A `detail` field carries the two
 * ticket-specified structured payloads (`ProposedUnitCorrection`,
 * `QtyDecomposition`) where a criterion calls for one â€” still additive, never
 * instead of the four required fields.
 *
 * NEVER AUTO-COMMIT (ticket "Additional required behaviour"; PRODUCT-SPEC
 * Â§5.1 step 2, "extraction always lands on a review screen"): this module's
 * only public surface is `reviewLoaLetter`, which returns a
 * `LoaReviewPayload` â€” header + items + pricingShape + flags + a
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
 * a printed unit in PROSE, and the parser must never apply the override â€”
 * both values are retained, verbatim, for the DC-28 human to resolve. */
export interface ProposedUnitCorrection {
  readonly printed_unit: string;
  readonly proposed_unit: string;
  readonly source: 'prose';
}

/** Criterion 2's structured payload. `base_qty` is the DELIVERABLE â€” the
 * ticket's own framing ("the Qty column says 48, the deliverable is 2") â€”
 * and `multiplier` is the recurring factor (PL273: always 24, the AMC's
 * month count) such that `multiplier * base_qty` equals the printed Qty
 * column exactly on all four real occurrences (verified: item 1
 * `24 * 2 = 48`, item 2 `24 * 2 = 48`, item 3 `24 * 4 = 96`, item 4
 * `24 * 2 = 48`). `base_unit` is the LEFT-hand unit word in the prose
 * (`"set"`/`"nos"`), i.e. the unit the deliverable count is denominated in â€”
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
 * (criteria 1, 2) â€” still additive; the four required fields are always
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

/** The parser's public review payload (PRODUCT-SPEC Â§5.1 step 2: "extraction
 * always lands on a review screen"). This is the ONLY shape this module's
 * entry point returns â€” nothing here writes a `work`. */
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

/** A stable per-item identifier for `targetId` â€” `<scheduleId>#<itemSno>`,
 * or `UNBOUND#<itemSno>` for the (corpus-unexercised) unbound-schedule case
 * items.ts's own `malformedItem` fallback can produce. Not asserted globally
 * unique (PL275's schedule A and B both print item numbers that can collide
 * across schedules in principle â€” research Â§4.5, "codes are unique only
 * within a directory" applies the same way to serials) â€” this exists for
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
// criterion 1 â€” prose corrigenda that contradict the table
// ---------------------------------------------------------------------------

// Case-insensitive, ticket-verbatim keyword set. Scans the WHOLE letter
// (never just the header block): PL275's own trigger occurrence
// ("Note: The installation ...") sits INSIDE the item-table region
// (fixture line 192, past the `Awarded Quantities And Rates` marker), so a
// header-only scan would silently miss it â€” exactly the "run against the
// real corpus where the corpus contains the case" failure this ticket
// exists to prevent.
const CORRIGENDUM_KEYWORDS_RE =
  /NOTE:|clarification|corrigendum|to be read as|oversight/i;

/** Criterion 1's letter-level half: any letter containing one of the five
 * keywords raises ONE letter-level flag (never per-occurrence â€” a letter
 * either carries corrigendum-shaped prose or it doesn't). Exercised by the
 * real corpus on three letters: PL280 (`NOTE:` / `oversight` /
 * `clarification` â€” the genuine unit-correction corrigendum), and PL273 /
 * PL275 (both carry an unrelated `Note:` â€” stamp-duty guidance and an
 * installation-responsibility note respectively, neither naming an item) â€”
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

/** Criterion 1's item-level half. Never applies the proposed correction â€”
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
// criterion 2 â€” quantity decomposed in prose, not columns
// ---------------------------------------------------------------------------

// "(Qty = <base_qty> <base_unit> x <multiplier> <unit> = <total> <unit>)" â€”
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
 * string) and item 2's own (in its `belowLines`, appearing LAST) â€” verified
 * against all four PL273 occurrences: taking the first match shifts EVERY
 * item onto its PRECEDING item's tuple (item 2 shows item 1's `2 set`; item
 * 3 shows item 2's `2 nos`; item 4 shows item 3's `4 nos` â€” an off-by-one
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
  for (const item of items)ß¹¶‰Ëkºwµçl(€½¹ÍĞ™±…ÌèI•Ù¥•İ±…mt€ômtì(€™½È€¡½¹ÍĞ¥Ñ•´½˜¥Ñ•µÌ¤ì(€€€½¹ÍĞ‘¥É•Ñ½Éä€ô¥Ñ•´¹Í¡•‘Õ±”ü¹‘¥É•Ñ½Éä€üü¹Õ±°ì(€€€¥˜€¡‘¥É•Ñ½Éä€„ôô¹Õ±°ñğ€…M=I}M!A}=}I¹Ñ•ÍĞ¡¥Ñ•´¹¥Ñ•µ½‘”¤¤ì(€€€€€½¹Ñ¥¹Õ”ì(€€€ô(€€€™±…Ì¹ÁÕÍ ¡ì(€€€€€½‘”è€¥Ñ•µ}½‘•}¹…µ•ÍÁ…•}µ¥Íµ…Ñ œ°(€€€€€Í½Á”è€¥Ñ•´œ°(€€€€€Ñ…É•Ñ%è¥Ñ•µQ…É•Ñ%¡¥Ñ•´¤°(€€€€€É…İ	±½¬è¥Ñ•´¹É…Ü¹…¹¡½É1¥¹”°(€€€€€µ•ÍÍ…”è%Ñ•´½‘”€ˆ‘í¥Ñ•´¹¥Ñ•µ½‘•ôˆ¥Ì€àµ‘¥¥ĞM=HµÍ¡…Á•‰ÕĞ¥ÑÌÍ¡•‘Õ±”Ì‘¥É•Ñ½Éä¥Ì€‰9½ĞÁÁ±¥…‰±”ˆ€¡¹½¸µM=H¤€´´½‘•Ì…É”Õ¹¥ÅÕ”½¹±äİ¥Ñ¡¥¸„‘¥É•Ñ½Éä€¡É•Í•…É ƒ
œĞ¸Ô¤ìÑ¡¥ÌÍ¡…Á”½‘¥É•Ñ½ÉäÁ…¥É¥¹œ¥Ì„¹…µ•ÍÁ…”µ¥Íµ…Ñ ¹€°(€€€€€‘•Ñ…¥°èì¥Ñ•µ½‘”è¥Ñ•´¹¥Ñ•µ½‘”°‘¥É•Ñ½Éäô°(€€€ô¤ì(€ô(€É•ÑÕÉ¸™±…Ìì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É¥Ñ•É¥½¸€ØƒŠP±…å½ÕĞ©Õ¹¬€¼Õ¹Á…ÉÍ•…‰±”Ñ½­•¸°‘•ÍÉ¥ÁÑ¥½¸½È¹Õµ•É¥Œ½±Õµ¸(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¼½ÉÁÕÌµ‘•É¥Ù•°9=P„•¹•É…°€‰…¹ä¹½¸µM%$¡…É…Ñ•Èˆ™¥±Ñ•È€´´Ñ¡…Ğ(¼¼İ½Õ±µ¥Í™¥É”½¸±•¥Ñ¥µ…Ñ”Ñ•¡¹¥…°µÍÁ•ŒÕ¹¥½‘”…±É•…‘äÁÉ•Í•¹Ğ…¹(¼¼YI%%=9Q9P¥¸Ñ¡”É•…°½ÉÁÕÌèA0ÈÜÔÌ€ˆÌƒ
ø‘¥¥Ğˆ±…µÀµµ•Ñ•È(¼¼™É…Ñ¥½¸°…¹A0ÈÜØÌ€‹Šˆˆ‰Õ±±•Ñ•™•…ÑÕÉ”±¥ÍÑÌ€¡„É•…°°øÄĞµ½ÕÉÉ•¹”(¼¼‰Õ±±•Ñ•µ±¥ÍĞÉ•¹‘•É¥¹œ°¹½Ğ©Õ¹¬¤¸€‹
¤ˆ¥ÌÑ¡”½¹”±åÁ µ•…ÍÕÉ•…É½ÍÌ(¼¼Ñ¡”Í¥àµ±•ÑÑ•È½ÉÁÕÌÑ¡…Ğ¥Ì¹½Ğ±•¥Ñ¥µ…Ñ”½¹Ñ•¹Ğ€´´A0ÈÜÔM¡•‘Õ±”(¼¼¥Ñ•´€ÄÌ‘•ÍÉ¥ÁÑ¥½¸°µ¥µÍ•¹Ñ•¹”°…±µ½ÍĞ•ÉÑ…¥¹±ä„Á‘™Ñ½Ñ•áĞ€µ±…å½ÕĞ(¼¼µ¥ÌµÉ•¹‘•É¥¹œ½˜„€ˆ¡Œ¤ˆ±¥ÍĞµ…É­•È€¡Ñ¡”¥Ñ•´Ì½Ñ¡•È±¥ÍĞµ…É­•ÉÌÉ•…(¼¼€ˆ¡„¤ˆ°€ˆ¡ˆ¤ˆ°€ˆ¡¤ˆ°€ˆ¡”¤ˆƒŠP€ˆ¡Œ¤ˆ¥ÌÑ¡”½¹”µ¥ÍÍ¥¹œ°•á…Ñ±äİ¡•É”€‹
¤ˆ(¼¼Í¥ÑÌ¤¸¥Ñ•µÌ¹ÑÌÌ½İ¸µ½‘Õ±”‘½Œ…±É•…‘ä¹…µ•ÌÑ¡¥Ì•á…Ğ¡…É…Ñ•È…Ì(¼¼Ñ¡”½ÉÁÕÌÌÍÑÉ…äµÑ½­•¸•á…µÁ±”¸)½¹ÍĞ1e=UQ})U9-}1eA!M}I€ô€½o
¥t¼ì((¼¨¨(€¨É¥Ñ•É¥½¸€Ø°‰½Ñ ¡…±Ù•Ì¸Q¡”‘•ÍÉ¥ÁÑ¥½¸¡…±˜¥Ì•á•É¥Í•‰äÑ¡”É•…°(€¨½ÉÁÕÌ€¡A0ÈÜÔ¥Ñ•´€Ä°…‰½Ù”¤¸Q¡”¹Õµ•É¥Œµ½±Õµ¸¡…±˜ƒŠP…¸…¹¡½È±¥¹”(€¨İ¡½Í”¹Õµ•É¥Œ½±Õµ¹Ì½Õ±¹½Ğ‰”‘•½µÁ½Í•…Ğ…±°ƒŠP¥ÌU9aI%M‰ä(€¨Ñ¡”É•…°½ÉÁÕÌ€¡¥Ñ•µÌ¹ÑÌÌ½İ¸µ½‘Õ±”‘½Œè…±°€ÈàÄÉ•…°…¹¡½È±¥¹•Ì(€¨‘•½µÁ½Í”±•…¹±ä¤…¹¥ÌÁÉ½Ù•‰ä„Ñ…É•Ñ•°¥¸µµ•µ½ÉäµÕÑ…Ñ¥½¸½˜„(€¨É•…°…¹¡½È±¥¹”Ìµ½¹•äµ™¥ÕÉ”™½Éµ…Ğ€¡‰É•…­¥¹œ¥Ñ•µÌ¹ÑÍ€Ì(€¨9!=I}Q%1}I€¤°µ¥ÉÉ½É¥¹œÑ¡”Í…µ”€‰•¹¥¹••È„…Í”™É½´É•…°Ñ•áĞ°(€¨¹•Ù•È™…‰É¥…Ñ”„™¥áÑÕÉ”ˆÁÉ••‘•¹Ğ¥Ñ•µÌ¹ÑÌÌ½İ¸‘ÕÁ±¥…Ñ”µ½‘”Ñ•ÍĞ(€¨ÕÍ•Ì¸I•…‘Ì¥Ñ•´¹¥Ñ•µ½‘”€ôôô€œ€…ÌÑ¡”Í¥¹…°è¥Ñ•µÌ¹ÑÌÌ(€¨µ…±™½Éµ•‘%Ñ•µ€™…±±‰…¬¥ÌÑ¡”=91dÁ…Ñ Ñ¡…ĞÁÉ½‘Õ•Ì…¸•µÁÑä(€¨¥Ñ•µ½‘•€€¡Á••±¹¡½ÉQ…¥±€ÌÍÕ•ÍÍ™Õ°Á…Ñ …±İ…åÌÉ•ÑÕÉ¹Ì„(€¨¹½¸µ•µÁÑäÑ½­•¸°‰ä½¹ÍÑÉÕÑ¥½¸½˜¥ÑÌÑ½­•¸µ™¥±Ñ•É¥¹œ¤¸Q¡”É…Ü(€¨…¹¡½È±¥¹”¥ÌÉ•Ñ…¥¹••¥Ñ¡•Èİ…äìÑ¡”‘•ÍÉ¥ÁÑ¥½¸°İ¡•¸ÁÉ•Í•¹Ğ°¥Ì(€¨¹•Ù•È±•…¹•¸(€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•Ñ1…å½ÕÑ)Õ¹¬¡¥Ñ•µÌèÉ•…‘½¹±äA…ÉÍ•‘%Ñ•µmt¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€½¹ÍĞ™±…ÌèI•Ù¥•İ±…mt€ômtì(€™½È€¡½¹ÍĞ¥Ñ•´½˜¥Ñ•µÌ¤ì(€€€¥˜€¡1e=UQ})U9-}1eA!M}I¹Ñ•ÍĞ¡¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸¤¤ì(€€€€€™±…Ì¹ÁÕÍ ¡ì(€€€€€€€½‘”è€±…å½ÕÑ}©Õ¹¬œ°(€€€€€€€Í½Á”è€¥Ñ•´œ°(€€€€€€€Ñ…É•Ñ%è¥Ñ•µQ…É•Ñ%¡¥Ñ•´¤°(€€€€€€€É…İ	±½¬è¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¸°(€€€€€€€µ•ÍÍ…”è(€€€€€€€€€€•ÍÉ¥ÁÑ¥½¸½¹Ñ…¥¹Ì„±…å½ÕĞµ©Õ¹¬±åÁ €¡„Á‘™Ñ½Ñ•áĞ€µ±…å½ÕĞÉ•¹‘•É¥¹œ…ÉÑ¥™…Ğ°”¹œ¸„…É‰±•±¥ÍĞµ…É­•È¤€´´É•Ñ…¥¹•Ù•É‰…Ñ¥´°¹•Ù•È±•…¹•¸œ°(€€€€€ô¤ì(€€€ô(€€€¥˜€¡¥Ñ•´¹¥Ñ•µ½‘”€ôôô€œœ¤ì(€€€€€™±…Ì¹ÁÕÍ ¡ì(€€€€€€€½‘”è€±…å½ÕÑ}©Õ¹¬œ°(€€€€€€€Í½Á”è€¥Ñ•´œ°(€€€€€€€Ñ…É•Ñ%è¥Ñ•µQ…É•Ñ%¡¥Ñ•´¤°(€€€€€€€É…İ	±½¬è¥Ñ•´¹É…Ü¹…¹¡½É1¥¹”°(€€€€€€€µ•ÍÍ…”è(€€€€€€€€€€‰Q¡”…¹¡½È±¥¹”Ì¹Õµ•É¥Œ½±Õµ¹Ì½Õ±¹½Ğ‰”Á…ÉÍ•€¡±…å½ÕĞ©Õ¹¬€¼…¸Õ¹Á…ÉÍ•…‰±”Ñ½­•¸¤€´´É…Ü‰±½¬É•Ñ…¥¹•°¥Ñ•´™±…•°¹½Ñ¡¥¹œÕ•ÍÍ•¸ˆ°(€€€€€ô¤ì(€€€ô(€ô(€É•ÑÕÉ¸™±…Ìì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼€‰‘‘¥Ñ¥½¹…°É•ÅÕ¥É•‰•¡…Ù¥½ÕÈˆƒŠPÕ¹•á•É¥Í•‘•™•¹Í¥Ù”Ñ•µÁ±…Ñ”‰É…¹¡•Ì(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()½¹ÍĞ%Q5}	I-UA}1	1}I€ô€½y%Ñ•´	É•…­ÕÁqˆ½¤ì)½¹ÍĞ%Q5}	I-UA}aAQ€ô€¹¼‰É•…¬ÕÀ¥Ñ•´…‘‘•œì((¼¨¨%Ñ•´	É•…­ÕÁ€É•…‘Ì€‰9¼‰É•…¬ÕÀ¥Ñ•´…‘‘•ˆ¥¸…±°Í¥àÉ•…°±•ÑÑ•ÉÌ(€¨€¡É•Í•…É ƒ
œÔ¤¸±…Ì½¹±äİ¡•¸Ñ¡”Í•Ñ¥½¸¥ÌAIM9Pİ¥Ñ ‘¥™™•É•¹Ğ(€¨½¹Ñ•¹ĞƒŠP…‰Í•¹”¥Ì¹½Ğ¥ÑÍ•±˜„ÑÉ…À€¡Ñ¡”Ñ¥­•Ğè€‰É…¥Í•Ì¹••‘ÍI•Ù¥•İ€(€¨İ¡•¸¥Ğ…ÁÁ•…ÉÌİ¥Ñ Õ¹•áÁ•Ñ•½¹Ñ•¹Ğˆ°¹½Ğ½¸…‰Í•¹”¤¸U¹•á•É¥Í•‰ä(€¨Ñ¡”É•…°½ÉÁÕÌìÁÉ½Ù•‰ä…¸¥¸µµ•µ½ÉäÍÕ‰ÍÑ¥ÑÕÑ¥½¸½˜„É•…°™¥áÑÕÉ”Ì(€¨Ñ•áĞ¸€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•ÑU¹•áÁ•Ñ•‘%Ñ•µ	É•…­ÕÀ (€É…İQ•áĞèÍÑÉ¥¹œ°(€±•ÑÑ•ÉQ…É•Ñ%èÍÑÉ¥¹œ°(¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€½¹ÍĞÍÑÉ¥ÁÁ•€ôÍÑÉ¥ÁAÉ¥¹ÑÕÉ¹¥ÑÕÉ”¡É…İQ•áĞ¤ì(€½¹ÍĞÁ…É„€ôÁ…É…É…Á¡Ì¡ÍÑÉ¥ÁÁ•¤¹™¥¹ ¡À¤€ôø%Q5}	I-UA}1	1}I¹Ñ•ÍĞ¡À¤¤ì(€¥˜€¡Á…É„€ôôôÕ¹‘•™¥¹•¤ì(€€€É•ÑÕÉ¸mtì(€ô(€½¹ÍĞÉ•µ…¥¹‘•È€ôÁ…É„¹É•Á±…”¡%Q5}	I-UA}1	1}I°€œœ¤¹ÑÉ¥´ ¤ì(€¥˜€¡É•µ…¥¹‘•È¹Ñ½1½İ•É…Í” ¤€ôôô%Q5}	I-UA}aAQ¤ì(€€€É•ÑÕÉ¸mtì(€ô(€É•ÑÕÉ¸l(€€€ì(€€€€€½‘”è€Õ¹•áÁ•Ñ•‘}¥Ñ•µ}‰É•…­ÕÀœ°(€€€€€Í½Á”è€±•ÑÑ•Èœ°(€€€€€Ñ…É•Ñ%è±•ÑÑ•ÉQ…É•Ñ%°(€€€€€É…İ	±½¬èÁ…É„°(€€€€€µ•ÍÍ…”è€‰%Ñ•´	É•…­ÕÀˆÉ•…‘Ì€‘í)M=8¹ÍÑÉ¥¹¥™ä¡É•µ…¥¹‘•È¥ô¥¹ÍÑ•…½˜Ñ¡”Ñ•µÁ±…Ñ”ÌÕ¹¥Ù•ÉÍ…°€‰9¼‰É•…¬ÕÀ¥Ñ•´…‘‘•ˆ€ Ø¼Ø¥¸Ñ¡”É•…°½ÉÁÕÌ¤€´´Õ¹•á•É¥Í•‰äÉ•…°‘…Ñ„°¥µÁ±•µ•¹Ñ•‘•™•¹Í¥Ù•±äìÉ•Ù¥•Ü‰•™½É”½¹™¥É´¹€°(€€€ô°(€tì)ô((¼¨¨I•‰…Ñ”½¸Q½Ñ…°Y…±Õ”€ ”¥€É•…‘Ì€À¸ÀÁ€¥¸…±°Í¥àÉ•…°±•ÑÑ•ÉÌ(€¨€¡É•Í•…É ƒ
œÄÌ‘•½ä™¥•±°ƒ
œÔ¤¸I•ÕÍ•ÌÁÉ¥¥¹M¡…Á”¹É•‰…Ñ•=¹Q½Ñ…±Y…±Õ•€(€¨€¡…±É•…‘ä•áÑÉ…Ñ•‰äÁÉ¥¥¹œµÍ¡…Á”¹ÑÌ¤É…Ñ¡•ÈÑ¡…¸É”µÁ…ÉÍ¥¹œ¥Ğ°Í¼(€¨Ñ¡¥Ì…¸¹•Ù•È‘É¥™Ğ™É½´Ñ¡”±…ÍÍ¥™¥•ÈÌ½İ¸É•…‘¥¹œ½˜Ñ¡”Í…µ”(€¨™¥ÕÉ”¸±…Ì½¹±äİ¡•¸™½Õ¹9¹½¸µé•É¼ƒŠP„¹Õ±±€€¡¹½Ğ±½…Ñ•¤¥Ì(€¨ÁÉ¥¥¹œµÍ¡…Á”¹ÑÌÌ½İ¸¹••‘ÍI•Ù¥•İ€½¹•É¸°¹½ĞÑ¡¥ÌÑÉ¥•ÈÌ¸€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•ÑU¹•áÁ•Ñ•‘I•‰…Ñ” (€ÁÉ¥¥¹M¡…Á”èAÉ¥¥¹M¡…Á•I•ÍÕ±Ğ°(€±•ÑÑ•ÉQ…É•Ñ%èÍÑÉ¥¹œ°(¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€½¹ÍĞìÉ•‰…Ñ•=¹Q½Ñ…±Y…±Õ”°É…İQ½Ñ…±Í	±½¬ô€ôÁÉ¥¥¹M¡…Á”ì(€¥˜€¡É•‰…Ñ•=¹Q½Ñ…±Y…±Õ”€ôôô¹Õ±°ñğÉ•‰…Ñ•=¹Q½Ñ…±Y…±Õ”€ôôô€À¤ì(€€€É•ÑÕÉ¸mtì(€ô(€É•ÑÕÉ¸l(€€€ì(€€€€€½‘”è€Õ¹•áÁ•Ñ•‘}É•‰…Ñ”œ°(€€€€€Í½Á”è€±•ÑÑ•Èœ°(€€€€€Ñ…É•Ñ%è±•ÑÑ•ÉQ…É•Ñ%°(€€€€€É…İ	±½¬èÉ…İQ½Ñ…±Í	±½¬€üü€œœ°(€€€€€µ•ÍÍ…”è€‰I•‰…Ñ”½¸Q½Ñ…°Y…±Õ”€ ”¤ˆÉ•…‘Ì€‘íMÑÉ¥¹œ¡É•‰…Ñ•=¹Q½Ñ…±Y…±Õ”¥ô¥¹ÍÑ•…½˜Ñ¡”Ñ•µÁ±…Ñ”ÌÕ¹¥Ù•ÉÍ…°€À¸ÀÀ€ Ø¼Ø¥¸Ñ¡”É•…°½ÉÁÕÌ¤€´´Õ¹•á•É¥Í•‰äÉ•…°‘…Ñ„°¥µÁ±•µ•¹Ñ•‘•™•¹Í¥Ù•±äìÉ•Ù¥•Ü‰•™½É”½¹™¥É´€¡É•Í•…É ƒ
œÄÌ‘•½ä™¥•±¤¹€°(€€€ô°(€tì)ô((¼¨¨Q¡”¥Ñ•´µÉ½Ü‰½Ù”A…É€Ñ½­•¸ƒŠP¹•Ù•È½‰Í•ÉÙ•¥¸Ñ¡”É•…°½ÉÁÕÌ(€¨€ ÈàÄ¼ÈàÄÉ•…ĞA…É€°É•Í•…É ƒ
œÔ¤¸U¹•á•É¥Í•‰äÉ•…°‘…Ñ„ìÁÉ½Ù•‰ä(€¨µÕÑ…Ñ¥¹œ„É•…°…¹¡½È±¥¹”ÌÁ…ÈÑ½­•¸¥¸µµ•µ½Éä¸€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•ÑU¹•áÁ•Ñ•‘‰½Ù•A…È (€¥Ñ•µÌèÉ•…‘½¹±äA…ÉÍ•‘%Ñ•µmt°(¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€É•ÑÕÉ¸¥Ñ•µÌ(€€€€¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹Á…ÉQ½­•¸€ôôô€‰½Ù”A…Èœ¤(€€€€¹µ…À ¡¥Ñ•´¤€ôø€¡ì(€€€€€½‘”è€Õ¹•áÁ•Ñ•‘}…‰½Ù•}Á…Èœ…Ì½¹ÍĞ°(€€€€€Í½Á”è€¥Ñ•´œ…Ì½¹ÍĞ°(€€€€€Ñ…É•Ñ%è¥Ñ•µQ…É•Ñ%¡¥Ñ•´¤°(€€€€€É…İ	±½¬è¥Ñ•´¹É…Ü¹…¹¡½É1¥¹”°(€€€€€µ•ÍÍ…”è(€€€€€€€€œ‰‰½Ù”A…Èˆ¥Ñ•´µÉ½ÜÑ½­•¸€´´¹•Ù•È½‰Í•ÉÙ•¥¸Ñ¡”É•…°½ÉÁÕÌ€ ÈàÄ¼ÈàÄÉ•…€‰ĞA…Èˆ¤°¥µÁ±•µ•¹Ñ•‘•™•¹Í¥Ù•±äìÉ•Ù¥•Ü‰•™½É”½¹™¥É´¸œ°(€€€ô¤¤ì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼€‰‘‘¥Ñ¥½¹…°É•ÅÕ¥É•‰•¡…Ù¥½ÕÈˆƒŠP	…¹¹•µ¥Ñ•µÌ‰±½¬°‰½Ñ ÍÁ•±±¥¹Ì(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()•áÁ½ÉĞÑåÁ”	…¹¹•‘	±½­MÁ•±±¥¹œ€ô€½±½¸œğ€¥Ñ•´œì()•áÁ½ÉĞ¥¹Ñ•É™…”	…¹¹•‘%Ñ•µÍ	±½­•Ñ•Ñ¥½¸ì(€€¼¨¨]¡¥ ½˜Ñ¡”Ñİ¼•Ù¥‘•¹•±…‰•°ÍÁ•±±¥¹Ìµ…Ñ¡•€¡µ½‘Õ±”‘½Œ(€€€¨‰•±½Ü¤¸€¨¼(€É•…‘½¹±äÍÁ•±±¥¹œè	…¹¹•‘	±½­MÁ•±±¥¹œì(€€¼¨¨™…±Í•€™½ÈÑ¡”‘½Õµ•¹Ñ••µÁÑä…Í”€¡Ñ¡”Á…É…É…Á Ì½¹Ñ•¹Ğ¥Ì(€€€¨•á…Ñ±ä9%1€¤€´´ÑÉÕ•€™½È„•¹Õ¥¹•±äÁ½ÁÕ±…Ñ•‰±½¬¸€¨¼(€É•…‘½¹±äÁ½ÁÕ±…Ñ•è‰½½±•…¸ì(€É•…‘½¹±äÉ…İ	±½¬èÍÑÉ¥¹œì)ô((¼¼A0ÈàÄÌÍÁ•±±¥¹œè€‰	…¹¹•¥Ñ•´èI…Ñ•Ì½˜¥Ñ•´¹¼€È°Ø°à°ÄØ°ÄÜ°Äà½˜(¼¼Í¡•‘Õ±”Ä€˜É…Ñ•Ì½˜¥Ñ•´¹¼€à°ÄÔ½˜Í¡•‘Õ±”È…É”‰…¹••™½È™ÕÑÕÉ”(¼¼É•™•É•¹”¸ˆ€¡™¥áÑÕÉ”±¥¹•Ì€ÄÀÀ´ÄÀÄ°Í¥Œ½¸€‰‰…¹••ˆ€´´Ñ¡”±•ÑÑ•ÈÌ½İ¸(¼¼ÑåÁ¼°ÁÉ•Í•ÉÙ•Ù•É‰…Ñ¥´¥¸É…İ	±½¬¤¸¡•­•%IMP°‘•±¥‰•É…Ñ•±äè¥Ğ(¼¼É•ÅÕ¥É•ÌÑ¡”İ½É€‰¥Ñ•´ˆ‰•Ñİ••¸€‰	…¹¹•ˆ…¹€ˆèˆ°Í¼¥Ğ…¸¹•Ù•Èµ…Ñ (¼¼A0ÈàÀÌ€‰	…¹¹•€èˆ±¥¹”€¡İ¡½Í”½±½¸™½±±½İÌ€‰	…¹¹•ˆ‘¥É•Ñ±ä°İ¥Ñ ½¹±ä(¼¼İ¡¥Ñ•ÍÁ…”‰•Ñİ••¸¤¸)½¹ÍĞ	99}%Q5}1	1}I€ô€½	…¹¹•‘qÌ­¥Ñ•µqÌ¨è½¤ì((¼¼A0ÈàÀÌÍÁ•±±¥¹œè€‰	…¹¹•€èI…Ñ•Ì½˜Ñ¡”™½±±½İ¥¹œ¥Ñ•µÌ…É”‰…¹¹•™½È(¼¼™ÕÑÕÉ”É•™•É•¹”M¡•‘Õ±”´9%0ˆ€¡™¥áÑÕÉ”±¥¹•Ì€ÄĞÀ´ÄĞÄ¤¸…¹¹½Ğµ…Ñ (¼¼€‰	…¹¹•¥Ñ•´èˆÑ•áĞ€¡µ½‘Õ±”‘½Œ…‰½Ù”¤€´´Ñ¡”Ñİ¼…ÉµÌ…É”µÕÑÕ…±±ä(¼¼•á±ÕÍ¥Ù”‰ä½¹ÍÑÉÕÑ¥½¸°¹½Ğ‰ä¡•¬½É‘•È¸)½¹ÍĞ	99}=1=9}1	1}I€ô€½	…¹¹•‘qÌ¨è½¤ì((¼¼Q¡”‘½Õµ•¹Ñ••µÁÑä…Í”€¡A0ÈàÀ¤èÑ¡”Á…É…É…Á ÌÑÉ…¥±¥¹œ½¹Ñ•¹Ğ¥Ì(¼¼•á…Ñ±ä€‰9%0ˆ¸¹äÁ½ÁÕ±…Ñ•½¹Ñ•¹Ğ€´´„É•…°¥Ñ•´±¥ÍĞ°É•Í•…É ƒ
œÔÌ(¼¼A0ÈàÄ…Í”€´´¹•Ù•È½¹Ñ…¥¹ÌÑ¡¥ÌÑ½­•¸¥¸Ñ¡”½ÉÁÕÌ¸)½¹ÍĞ9%1}]=I}I€ô€½q‰9%1qˆ½¤ì((¼¨¨(€¨I•½¹¥Í•Ì%Q!HÍÁ•±±¥¹œ½˜Ñ¡”	…¹¹•µ¥Ñ•µÌ‰±½¬€¡É•Í•…É ƒ
œÔ°(€¨½ÉÉ•Ñ•€ÈÀÈØ´Àà´ÀÔ€´´€‰¹¼±½¹•ÈÕ¹•á•É¥Í•ˆ¤°Í…¹¹¥¹œÑ¡”¡•…‘•È¼(€¨ÁÉ½Í”É•¥½¸½¹±ä€¡‰½Ñ É•…°½ÕÉÉ•¹•ÌÍ¥Ğ‰•™½É”Ñ¡”(€¨İ…É‘•EÕ…¹Ñ¥Ñ¥•Ì¹I…Ñ•Í€µ…É­•ÈèA0ÈàÀ±¥¹•Ì€ÄĞÀ´ÄĞÄ°A0ÈàÄ±¥¹•Ì(€¨€ÄÀÀ´ÄÀÄ¤¸I•ÑÕÉ¹Ì¹Õ±±€¥˜9%Q!HÍÁ•±±¥¹œ¥ÌÁÉ•Í•¹Ğ…Ğ…±°€´´•áÁ½Í•(€¨Í•Á…É…Ñ•±ä™É½´Ñ¡”™±…œµÁÉ½‘Õ¥¹œİÉ…ÁÁ•È‰•±½ÜÍ¼(€¨Ñ•ÍĞ½¹••‘ÌµÉ•Ù¥•Ü¹Ñ•ÍĞ¹ÑÍ€…¸ÁÉ½Ù”‰½Ñ ÍÁ•±±¥¹œ…ÉµÌ¥¹‘•Á•¹‘•¹Ñ±ä(€¨€¡‘¥Í…‰±¥¹œ•¥Ñ¡•ÈÉ••àÑÕÉ¹Ì•á…Ñ±ä½¹”É•…°±•ÑÑ•ÈÌ‘•Ñ•Ñ¥½¸É•ÍÕ±Ğ(€¨¹Õ±±€°Á•ÈÑ¡”Ñ¥­•ĞÌ½İ¸¹•…Ñ¥Ù”µÁÉ½½˜É•ÅÕ¥É•µ•¹Ğ¤°¹½Ğ©ÕÍĞÁÉ½Ù”(€¨Ñ¡”™±…œ½ÕÑ½µ”°İ¡¥ ¥Ì%9Q%0€ ‰¹¼™±…œˆ¤™½ÈA0ÈàÀİ¡•Ñ¡•È½È¹½Ğ(€¨Ñ¡”½±½¸…É´•Ù•¸ÉÕ¹Ì€¡¥ÑÌ½¹Ñ•¹Ğ¥Ì9%0•¥Ñ¡•Èİ…ä¤…¹İ½Õ±¹½Ğ‰ä(€¨¥ÑÍ•±˜…Ñ Ñ¡…Ğ…É´‰•¥¹œ‘¥Í…‰±•¸(€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	±½¬ (€É…İQ•áĞèÍÑÉ¥¹œ°(¤è	…¹¹•‘%Ñ•µÍ	±½­•Ñ•Ñ¥½¸ğ¹Õ±°ì(€½¹ÍĞÉ•¥½¸€ô¡•…‘•ÉI•¥½¸¡É…İQ•áĞ¤ì(€½¹ÍĞÁ…É…Ì€ôÁ…É…É…Á¡Ì¡É•¥½¸¤ì((€½¹ÍĞ¥Ñ•µA…É„€ôÁ…É…Ì¹™¥¹ ¡À¤€ôø	99}%Q5}1	1}I¹Ñ•ÍĞ¡À¤¤ì(€¥˜€¡¥Ñ•µA…É„€„ôôÕ¹‘•™¥¹•¤ì(€€€É•ÑÕÉ¸ì(€€€€€ÍÁ•±±¥¹œè€¥Ñ•´œ°(€€€€€Á½ÁÕ±…Ñ•è€…9%1}]=I}I¹Ñ•ÍĞ¡¥Ñ•µA…É„¤°(€€€€€É…İ	±½¬è¥Ñ•µA…É„°(€€€ôì(€ô((€½¹ÍĞ½±½¹A…É„€ôÁ…É…Ì¹™¥¹ ¡À¤€ôø	99}=1=9}1	1}I¹Ñ•ÍĞ¡À¤¤ì(€¥˜€¡½±½¹A…É„€„ôôÕ¹‘•™¥¹•¤ì(€€€É•ÑÕÉ¸ì(€€€€€ÍÁ•±±¥¹œè€½±½¸œ°(€€€€€Á½ÁÕ±…Ñ•è€…9%1}]=I}I¹Ñ•ÍĞ¡½±½¹A…É„¤°(€€€€€É…İ	±½¬è½±½¹A…É„°(€€€ôì(€ô((€É•ÑÕÉ¸¹Õ±°ì)ô((¼¨¨±…Ì„A=AU1Q‰…¹¹•µ¥Ñ•µÌ‰±½¬™½ÈÉ•Ù¥•Ü€¡Ñ¥­•Ğ°Ù•É‰…Ñ¥´è€‰™±…œ(€¨„Á½ÁÕ±…Ñ•‰…¹¹•µ¥Ñ•µÌ‰±½¬™½ÈÉ•Ù¥•Üˆ¤¸I%9!=M8™½ÈÑ¡”(€¨9%0½•µÁÑä…Í”€¡Ñ¥­•Ğè€‰É…Ñ¡•ÈÑ¡…¸ÑÉ•…Ñ¥¹œÑ¡”‰É…¹ …ÌÕ¹Ñ•ÍÑ•ˆ€´´(€¨…µ‰¥Õ½ÕÌ½¸İ¡•Ñ¡•È9%0¥ÑÍ•±˜Í¡½Õ±…±Í¼™±…œ¤è9%0¥Ì‘½Õµ•¹Ñ•¡•É”(€¨…ÌÑ¡”5AQd…Í”°Íåµµ•ÑÉ¥Œİ¥Ñ ‘•Ñ•ÑU¹•áÁ•Ñ•‘%Ñ•µ	É•…­ÕÁ€€¼(€¨‘•Ñ•ÑU¹•áÁ•Ñ•‘I•‰…Ñ•€…‰½Ù”€¡‰½Ñ ™±…œ½¹±ä½¸Õ¹•áÁ•Ñ•½Á½ÁÕ±…Ñ•(€¨½¹Ñ•¹Ğ°¹•Ù•È½¸Ñ¡”Ñ•µÁ±…Ñ”Ì¹½Éµ…°½•µÁÑäÍÑ…Ñ”¤€´´Í¼A0ÈàÀÌ9%0(€¨‰±½¬¥ÌÉ•½¹¥Í•€¡ÁÉ½Ù¥¹œÑ¡”½±½¸ÍÁ•±±¥¹œ…É´İ½É­Ì¤‰ÕĞ¹•Ù•È(€¨™±…•°İ¡¥±”A0ÈàÄÌÁ½ÁÕ±…Ñ•‰±½¬¥Ì‰½Ñ É•½¹¥Í•9™±…•¸€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	É…¹  (€É…İQ•áĞèÍÑÉ¥¹œ°(€±•ÑÑ•ÉQ…É•Ñ%èÍÑÉ¥¹œ°(¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€½¹ÍĞ‘•Ñ•Ñ¥½¸€ô‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	±½¬¡É…İQ•áĞ¤ì(€¥˜€¡‘•Ñ•Ñ¥½¸€ôôô¹Õ±°ñğ€…‘•Ñ•Ñ¥½¸¹Á½ÁÕ±…Ñ•¤ì(€€€É•ÑÕÉ¸mtì(€ô(€½¹ÍĞÍÁ•±±¥¹1…‰•°€ô‘•Ñ•Ñ¥½¸¹ÍÁ•±±¥¹œ€ôôô€¥Ñ•´œ€ü€œ‰	…¹¹•¥Ñ•´èˆœ€è€œ‰	…¹¹•€èˆœì(€É•ÑÕÉ¸l(€€€ì(€€€€€½‘”è€‰…¹¹•‘}¥Ñ•µÍ}‰±½¬œ°(€€€€€Í½Á”è€±•ÑÑ•Èœ°(€€€€€Ñ…É•Ñ%è±•ÑÑ•ÉQ…É•Ñ%°(€€€€€É…İ	±½¬è‘•Ñ•Ñ¥½¸¹É…İ	±½¬°(€€€€€µ•ÍÍ…”è	…¹¹•µ¥Ñ•µÌ‰±½¬¥ÌÁ½ÁÕ±…Ñ•€¡É•½¹¥Í•Ù¥„Ñ¡”€‘íÍÁ•±±¥¹1…‰•±ôÍÁ•±±¥¹œ¤€´´É•Ù¥•ÜÑ¡”¹…µ•¥Ñ•µÌ‰•™½É”½¹™¥É´ìÉ…Ñ•Ì™½ÈÑ¡•Í”¥Ñ•µÌ…É”‰…¹¹•™½È™ÕÑÕÉ”É•™•É•¹”¹€°(€€€ô°(€tì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼É½±°µÕÀ(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´()™Õ¹Ñ¥½¸É½±±UÀ¡™±…ÌèÉ•…‘½¹±äI•Ù¥•İ±…mt¤è9••‘ÍI•Ù¥•İI½±±ÕÀì(€½¹ÍĞ‰å½‘”èI•½ÉñÍÑÉ¥¹œ°¹Õµ‰•Èø€ôíôì(€™½È€¡½¹ÍĞ™±…œ½˜™±…Ì¤ì(€€€‰å½‘•m™±…œ¹½‘•t€ô€¡‰å½‘•m™±…œ¹½‘•t€üü€À¤€¬€Äì(€ô(€É•ÑÕÉ¸ì(€€€Ñ½Ñ…°è™±…Ì¹±•¹Ñ °(€€€‰å½‘”°(€€€…¹å1•ÑÑ•É1•Ù•°è™±…Ì¹Í½µ” ¡™±…œ¤€ôø™±…œ¹Í½Á”€ôôô€±•ÑÑ•Èœ¤°(€ôì)ô((¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´(¼¼•¹ÑÉäÁ½¥¹Ğ(¼¼€´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´´((¼¨¨Q¡”±•ÑÑ•Èµ±•Ù•°Ñ…É•Ñ%‘€•Ù•Éä±•ÑÑ•ÈµÍ½Á•™±…œ‰•±½ÜÕÍ•ÌèÑ¡”(€¨…±É•…‘äµ•áÑÉ…Ñ•±•ÑÑ•È¹Õµ‰•È€¡¡•…‘•È¹ÑÌ¤°½È„™¥á•Í•¹Ñ¥¹•°½¸Ñ¡”(€¨Õ¹•á•É¥Í•µ‰äµÑ¡”µ½ÉÁÕÌ…Í”İ¡•É”¡•…‘•È¹ÑÌ¥ÑÍ•±˜½Õ±¹½Ğ±½…Ñ”(€¨½¹”¸€¨¼)™Õ¹Ñ¥½¸±•ÑÑ•ÉQ…É•Ñ%‘=˜¡¡•…‘•Èè1½…!•…‘•È¤èÍÑÉ¥¹œì(€É•ÑÕÉ¸¡•…‘•È¹±•ÑÑ•É9Õµ‰•È¹Ù…±Õ”€üü€U9-9=]9}1QQHœì)ô()™Õ¹Ñ¥½¸‘•Ñ•ÑU¹É•Í½±Ù•‘%Ñ•µ•ÍÉ¥ÁÑ¥½¸ (€¥Ñ•µÌèÉ•…‘½¹±äA…ÉÍ•‘%Ñ•µmt°(€É…İ%Ñ•µQ•áÑ]…ÍAÉ½Ù¥‘•è‰½½±•…¸°(€±•ÑÑ•ÉQ…É•Ñ%èÍÑÉ¥¹œ°(¤èÉ•…‘½¹±äI•Ù¥•İ±…mtì(€¥˜€ (€€€€…É…İ%Ñ•µQ•áÑ]…ÍAÉ½Ù¥‘•ñğ(€€€¥Ñ•µÌ¹±•¹Ñ €ôôô€Àñğ(€€€¥Ñ•µÌ¹•Ù•Éä ¡¥Ñ•´¤€ôø¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¹M½ÕÉ”€ôôô€É…Üµ•á…Ğœ¤(€€¤ì(€€€É•ÑÕÉ¸mtì(€ô(€É•ÑÕÉ¸l(€€€ì(€€€€€½‘”è€Õ¹É•Í½±Ù•‘}¥Ñ•µ}‘•ÍÉ¥ÁÑ¥½¸œ°(€€€€€Í½Á”è€±•ÑÑ•Èœ°(€€€€€Ñ…É•Ñ%è±•ÑÑ•ÉQ…É•Ñ%°(€€€€€É…İ	±½¬è¥Ñ•µÌ¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹É…Ü¹…¹¡½É1¥¹”¤¹©½¥¸ q¸œ¤°(€€€€€µ•ÍÍ…”è(€€€€€€€€á…ĞÁ•Èµ¥Ñ•´‘•ÍÉ¥ÁÑ¥½¸‰½Õ¹‘…É¥•Ì½Õ±¹½Ğ‰”Ù•É¥™¥•™É½´Ñ¡”AÉ•…‘¥¹œ½É‘•È¸½¹Í•ÉÙ…Ñ¥Ù”±…å½ÕĞÑ•áĞİ…ÌÉ•Ñ…¥¹•ìÉ•Ù¥•Ü¥Ñ•´‘•ÍÉ¥ÁÑ¥½¹Ì‰•™½É”½¹™¥Éµ…Ñ¥½¸¸œ°(€€€ô°(€tì)ô((¼¨¨(€¨Q¡”Í¥¹±”ÁÕ‰±¥Œ•¹ÑÉäÁ½¥¹Ğ€¡Ñ¥­•Ğè€‰Ñ¡”Á…ÉÍ•ÈÌÁÕ‰±¥ŒA$É•ÑÕÉ¹Ì„(€¨É•Ù¥•ÜÁ…å±½…ˆ¤¸½µÁ½Í•Ì•áÑÉ…Ñ!•…‘•É€°Á…ÉÍ•%Ñ•µÍ€…¹(€¨±…ÍÍ¥™åAÉ¥¥¹M¡…Á•€€¡¹•Ù•ÈÉ”µ¥µÁ±•µ•¹Ñ¥¹œ…¹ä½˜Ñ¡•¥È™¥•±‘Ì¤°Ñ¡•¸(€¨ÉÕ¹Ì•Ù•ÉäÑÉ¥•È¥¸Ñ¡¥Ìµ½‘Õ±”……¥¹ÍĞÑ¡…Ğ…±É•…‘äµÁ…ÉÍ•½ÕÑÁÕĞÁ±ÕÌ(€¨Ñ¡”É…ÜÑ•áĞÑÉ¥•ÉÌ¹••™½ÈÑ¡•¥È½İ¸Ñ•áĞµÍ…¹Ì¸AÕÉ”è¹¼$½<°¹¼(€¨‘…Ñ…‰…Í”°¹¼İ½É¬•Ù•ÈİÉ¥ÑÑ•¸€¡µ½‘Õ±”‘½Œ…‰½Ù”¤¸(€¨¼)•áÁ½ÉĞ™Õ¹Ñ¥½¸É•Ù¥•İ1½…1•ÑÑ•È (€É…İQ•áĞèÍÑÉ¥¹œ°(€½ÁÑ¥½¹ÌèI•Ù¥•İ1½…=ÁÑ¥½¹Ì€ôíô°(¤è1½…I•Ù¥•İA…å±½…ì(€½¹ÍĞ¡•…‘•È€ô•áÑÉ…Ñ!•…‘•È¡É…İQ•áĞ¤ì(€½¹ÍĞ¥Ñ•µÌ€ô(€€€½ÁÑ¥½¹Ì¹É…İ%Ñ•µQ•áĞ€ôôôÕ¹‘•™¥¹•(€€€€€€üÁ…ÉÍ•%Ñ•µÌ¡É…İQ•áĞ¤(€€€€€€èÁ…ÉÍ•%Ñ•µÌ¡É…İQ•áĞ°ìÉ…İ%Ñ•µQ•áĞè½ÁÑ¥½¹Ì¹É…İ%Ñ•µQ•áĞô¤ì(€½¹ÍĞÁÉ¥¥¹M¡…Á”€ô±…ÍÍ¥™åAÉ¥¥¹M¡…Á”¡É…İQ•áĞ¤ì(€½¹ÍĞ±•ÑÑ•ÉQ…É•Ñ%€ô±•ÑÑ•ÉQ…É•Ñ%‘=˜¡¡•…‘•È¤ì((€½¹ÍĞ™±…ÌèI•Ù¥•İ±…mt€ôl(€€€€¸¸¹‘•Ñ•Ñ½ÉÉ¥•¹‘Õµ-•åİ½É¡É…İQ•áĞ°±•ÑÑ•ÉQ…É•Ñ%¤°(€€€€¸¸¹‘•Ñ•Ñ½ÉÉ¥•¹‘Õµ%Ñ•µU¹¥Ñ½ÉÉ•Ñ¥½¹Ì¡É…İQ•áĞ°¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•ÑEÑå•½µÁ½Í¥Ñ¥½¸¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•ÑA…åµ•¹ÑQ•ÉµÍAÉ½Í”¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•ÑU¹É•Í½±Ù•‘%Ñ•µ•ÍÉ¥ÁÑ¥½¸ (€€€€€¥Ñ•µÌ°(€€€€€½ÁÑ¥½¹Ì¹É…İ%Ñ•µQ•áĞ€„ôôÕ¹‘•™¥¹•°(€€€€€±•ÑÑ•ÉQ…É•Ñ%°(€€€€¤°(€€€€¸¸¹‘•Ñ•ÑU¹É•Í½±Ù•‘U¹¥ÑÌ¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•Ñ%Ñ•µ½‘•9…µ•ÍÁ…•5¥Íµ…Ñ ¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•Ñ1…å½ÕÑ)Õ¹¬¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•ÑU¹•áÁ•Ñ•‘%Ñ•µ	É•…­ÕÀ¡É…İQ•áĞ°±•ÑÑ•ÉQ…É•Ñ%¤°(€€€€¸¸¹‘•Ñ•ÑU¹•áÁ•Ñ•‘I•‰…Ñ”¡ÁÉ¥¥¹M¡…Á”°±•ÑÑ•ÉQ…É•Ñ%¤°(€€€€¸¸¹‘•Ñ•ÑU¹•áÁ•Ñ•‘‰½Ù•A…È¡¥Ñ•µÌ¤°(€€€€¸¸¹‘•Ñ•Ñ	…¹¹•‘%Ñ•µÍ	É…¹ ¡É…İQ•áĞ°±•ÑÑ•ÉQ…É•Ñ%¤°(€tì((€É•ÑÕÉ¸ì(€€€¡•…‘•È°(€€€¥Ñ•µÌ°(€€€ÁÉ¥¥¹M¡…Á”°(€€€™±…Ì°(€€€¹••‘ÍI•Ù¥•ÜèÉ½±±UÀ¡™±…Ì¤°(€ôì)ô(