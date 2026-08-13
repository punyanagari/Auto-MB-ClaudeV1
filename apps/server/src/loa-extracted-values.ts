/**
 * The LOA extracted-value lock (owner ruling, 2026-08-13: "the details
 * extracted from LOA like date, above/below % etc should not be user
 * editable as it's the truth source").
 *
 * WHY THIS LIVES ON THE SERVER. The review screen renders locked values as
 * read-only text, but the screen is not the control: `POST
 * /api/loa-documents/:id/confirm` takes a client-supplied payload of
 * header, PBG requirement, schedules and items, and everything downstream —
 * every delivered quantity, every challan line, every Measurement Book
 * total — is measured against what that payload stored. A rule only the
 * browser enforces is not a rule (AGENTS.md: business rules live in the
 * server module, never in the client alone).
 *
 * THE RULE, in one sentence:
 *
 *   A field is LOCKED if and only if the stored parse produced a usable
 *   value for it AND the parser did not declare that value unverifiable;
 *   every other field is FILLABLE, and the operator may supply it.
 *
 * Unpacked, because each clause does work:
 *
 *  1. "the stored parse" — never the client's copy of it. The comparison
 *     reads `loa_documents.extraction_payload`, written once at upload and
 *     never rewritten.
 *  2. "produced a usable value" — `null` is a hole (`FieldResult.value`,
 *     `PricingShapeResult.contract_value`, `ParsedItem.qtyUnit`, an absent
 *     performance-guarantee clause). So is a printed figure that cannot be
 *     transported through the wire schema at all: a quantity the parser
 *     read as `0` cannot be submitted (`PositiveDecimalStringSchema` is
 *     strictly positive), and a decimal carrying more fraction digits than
 *     its column cannot round-trip. Locking a value nobody can submit would
 *     make the letter permanently unconfirmable, so those are holes too.
 *  3. "did not declare that value unverifiable" — the parser's own
 *     `needsReview` signals, at the granularity the parser publishes them:
 *     `FieldResult.needsReview` per header field,
 *     `PricingShapeResult.needsReview` for the totals block,
 *     `PerformanceGuaranteeField.needsReview` for the PBG clause,
 *     `ItemReconciliation.ok` for an item's qty/rate/amount triple,
 *     `ParsedItem.descriptionSource` for a description boundary, and the
 *     `ReviewFlag` codes in `review.flags` for the rest (`unresolved_unit`,
 *     `unresolved_item_description`, `prose_unit_correction`,
 *     `prose_qty_decomposition`, `layout_junk`). The locked set is
 *     therefore DERIVED from each stored parse, never a hardcoded field
 *     list: the same field is locked on one letter and fillable on the
 *     next, exactly as the parser found it.
 *  4. Filling a hole is not overriding a truth — it is answering a question
 *     the parser itself asked. That is the only editing the review screen
 *     still offers on parsed rows.
 *  5. If a LOCKED value is wrong, there is no silent edit: the letter is
 *     discarded (`POST /api/loa-documents/:id/discard`) and a corrected one
 *     uploaded. The refusal below says so.
 *
 * PROVENANCE MUST BE PROVED, NOT ASSUMED. `extraction_payload` is JSONB and
 * older rows carry other shapes (a synthetic identity-only payload, a
 * failed extraction's `{ error }`). Everything below is read through
 * `readStoredReview`, which narrows defensively and yields a HOLE for any
 * value whose parser provenance it cannot establish — a missing
 * `needsReview`, an absent totals block, an unrecognised field shape. A
 * value the parser cannot be shown to have asserted is not a truth this
 * lock may claim to protect, so absence never manufactures a lock.
 *
 * WHAT IS DELIBERATELY NOT LOCKED, and why — each is a value the parser
 * never produced, so there is no extracted truth to protect:
 *
 *  - `workCode`: the contractor's own filing reference. The letter does not
 *    print it.
 *  - `itemNumber`: the product's per-Work item label. The parser publishes
 *    `itemSno` and `itemCode`; `itemNumber` is composed by the client and
 *    is not a parser field. The row's binding to its printed source is
 *    carried by `sourceRef` (checked by `sourceEvidenceFor`), which no
 *    relabelling can loosen.
 *  - `scheduleCode` / schedule `title`: container labels the client
 *    composes around the parsed rows.
 *  - `paymentCategory` and the initial payment matrix: the parser never
 *    proposes either; both are the reviewer's judgement (spec §8).
 *  - Rows the reviewer ADDS (`manualEntry: true`): not extracted values.
 *    They stay allowed and stay marked manual.
 *  - Rows the reviewer REMOVES: a parsed row omitted from the payload is
 *    counted and audited (`parsedRowsOmitted`), not refused. Refusing it
 *    would leave no exit at all from a spurious row the parser reads out of
 *    layout junk — re-uploading the same PDF reproduces it, so "discard and
 *    upload a corrected letter" is not a remedy the operator can actually
 *    perform. Every VALUE on a kept row is still locked.
 */
import type {
  ConfirmPbgRequirement,
  ConfirmWorkItem,
  ConfirmWorkRequest,
} from '@auto-mb/contracts';
import {
  parseDecimalToMinorUnits,
  resolveCanonicalUnitCode,
} from '@auto-mb/loa-parser';
import { httpError } from './http.js';

/** What the confirm audit records about the lock having run. */
export interface ExtractedValueLockSummary {
  readonly lockedFieldsVerified: number;
  /** Letter-level fields (header, totals block, performance guarantee) the
   * parser left null or flagged, and which this confirmation therefore
   * supplied. Named rather than counted: there are at most a dozen, and
   * knowing WHICH one a human established is the point. Values are not
   * recorded — the created Work already carries them. */
  readonly letterHolesFilled: readonly string[];
  /** The same across item rows, counted rather than named: a hundred-row
   * letter would otherwise write four hundred field names into one audit
   * row. */
  readonly itemHolesFilled: number;
  readonly manualRows: number;
  readonly parsedRowsOmitted: number;
}

/** Wire scales, from packages/contracts/src/primitives.ts. A locked value
 * that does not survive its own scale is a hole (rule 2 above). */
const MONEY_SCALE = 3; // NonNegativeDecimalStringSchema / DecimalStringSchema
const PERCENT_SCALE = 3; // LetterPercentageSchema
const QUANTITY_SCALE = 3; // PositiveDecimalStringSchema
const RATE_SCALE = 6; // NonNegativeRateStringSchema

type ItemField = 'description' | 'unitCode' | 'awardedQuantity' | 'effectiveRate';

/**
 * The item-scoped flag codes that unlock a specific confirm field. Codes
 * absent from this map unlock nothing:
 *
 *  - `prose_corrigendum` comes from a deliberately broad keyword scan (any
 *    `NOTE:` in the letter — three of the six corpus letters raise it). It
 *    marks a letter worth reading, not a field worth editing.
 *  - `item_code_namespace_mismatch` and `unexpected_above_par` concern
 *    `itemCode` and the par token, neither of which is a confirm field.
 *  - `prose_payment_terms` concerns the payment category, which the
 *    reviewer owns outright.
 *  - the letter-scoped template codes (`unexpected_item_breakup`,
 *    `banned_items_block`, `unexpected_rebate`) describe the letter's
 *    shape; `unexpected_rebate` already forces `pricingShape.needsReview`,
 *    which unlocks the totals block on its own.
 */
const ITEM_FLAG_UNLOCKS: Readonly<Record<string, readonly ItemField[]>> = {
  // The printed unit did not resolve to a canonical unit; the reviewer
  // picks the intended one.
  unresolved_unit: ['unitCode'],
  // A prose corrigendum proposes a different unit from the one printed in
  // the table. The parser retains both and applies neither.
  prose_unit_correction: ['unitCode'],
  // The Qty column is a billing artifact (`2 set x 24 month = 48 month`);
  // the deliverable count and its unit are both contested.
  prose_qty_decomposition: ['awardedQuantity', 'unitCode'],
  // Layout noise leaked into the row; its description cannot be trusted.
  layout_junk: ['description'],
};

// ---------------------------------------------------------------------------
// defensive narrowing of the stored payload
// ---------------------------------------------------------------------------

/** A header field the parser asserts, reduced to what the lock needs.
 * `value` is null whenever provenance could not be established. */
interface StoredText {
  readonly value: string | null;
}

interface StoredPricing {
  readonly advertisedValue: number | null;
  readonly contractValue: number | null;
  readonly pricingShape: string | null;
  readonly letterPercentage: number | null;
  readonly direction: string | null;
  /** True when the totals block is unusable as truth — including when the
   * stored payload carries no recognisable totals block at all. */
  readonly flagged: boolean;
}

interface StoredPbg {
  /** True only when a performance-guarantee clause was actually parsed. */
  readonly present: boolean;
  readonly amountFigures: number | null;
  readonly submissionDays: number | null;
  readonly extensionDays: number | null;
  readonly penalInterestPercent: number | null;
  readonly flagged: boolean;
}

interface StoredItem {
  readonly targetId: string;
  readonly description: string | null;
  readonly descriptionExact: boolean;
  readonly qtyUnit: string | null;
  readonly qty: string | null;
  readonly unitRate: string | null;
  readonly reconciled: boolean;
}

interface StoredReview {
  readonly letterNumber: StoredText;
  readonly letterDate: StoredText;
  readonly workDescription: StoredText;
  readonly pricing: StoredPricing;
  readonly pbg: StoredPbg;
  readonly items: readonly StoredItem[];
  /** Item fields unlocked by a flag, keyed by the flag's `targetId`, plus
   * the letter-wide description unlock. */
  readonly unlockedByTarget: ReadonlyMap<string, ReadonlySet<ItemField>>;
  readonly allDescriptionsUnlocked: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A `FieldResult<string>`: its value counts as extracted truth only when
 * the field itself carries `needsReview: false`. A field with no
 * `needsReview` at all is a shape this lock does not recognise, so it
 * yields a hole rather than a lock. */
function readField(source: Record<string, unknown> | null, key: string): StoredText {
  const field = asRecord(source?.[key]);
  if (field === null || field['needsReview'] !== false) return { value: null };
  return { value: asString(field['value']) };
}

function readPricing(review: Record<string, unknown> | null): StoredPricing {
  const shape = asRecord(review?.['pricingShape']);
  const flagged = shape === null || shape['needsReview'] !== false;
  return {
    advertisedValue: flagged ? null : asNumber(shape['advertised_value']),
    contractValue: flagged ? null : asNumber(shape['contract_value']),
    pricingShape: flagged ? null : asString(shape['pricing_shape']),
    letterPercentage: flagged ? null : asNumber(shape['letter_percentage']),
    direction: flagged ? null : asString(shape['letter_percentage_direction']),
    flagged,
  };
}

function readPbg(header: Record<string, unknown> | null): StoredPbg {
  const clause = asRecord(header?.['performanceGuarantee']);
  const flagged = clause === null || clause['needsReview'] !== false;
  return {
    present: clause !== null,
    amountFigures: flagged ? null : asNumber(clause['amountFigures']),
    submissionDays: flagged ? null : asNumber(clause['submissionDays']),
    extensionDays: flagged ? null : asNumber(clause['extensionDays']),
    penalInterestPercent: flagged ? null : asNumber(clause['penalInterestPercent']),
    flagged,
  };
}

function readItems(review: Record<string, unknown> | null): StoredItem[] {
  const raw = review?.['items'];
  if (!Array.isArray(raw)) return [];
  const items: StoredItem[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (item === null) continue;
    const itemSno = asString(item['itemSno']);
    if (itemSno === null) continue;
    const scheduleId = asString(asRecord(item['schedule'])?.['id']) ?? 'UNBOUND';
    const reconciliation = asRecord(item['reconciliation']);
    items.push({
      targetId: `${scheduleId}#${itemSno}`,
      description: asString(item['description']),
      descriptionExact: item['descriptionSource'] === 'raw-exact',
      qtyUnit: asString(item['qtyUnit']),
      qty: asString(item['qty']),
      unitRate: asString(item['unitRate']),
      reconciled: reconciliation !== null && reconciliation['ok'] === true,
    });
  }
  return items;
}

function readFlags(review: Record<string, unknown> | null): {
  unlockedByTarget: Map<string, Set<ItemField>>;
  allDescriptionsUnlocked: boolean;
} {
  const unlockedByTarget = new Map<string, Set<ItemField>>();
  let allDescriptionsUnlocked = false;
  const raw = review?.['flags'];
  if (!Array.isArray(raw)) {
    return { unlockedByTarget, allDescriptionsUnlocked };
  }
  for (const entry of raw) {
    const flag = asRecord(entry);
    if (flag === null) continue;
    const code = asString(flag['code']);
    if (code === null) continue;
    // Letter-scoped: the PDF's reading order could not confirm ANY row's
    // description boundary, so every description stays correctable.
    if (code === 'unresolved_item_description') {
      allDescriptionsUnlocked = true;
      continue;
    }
    const targetId = asString(flag['targetId']);
    const fields = ITEM_FLAG_UNLOCKS[code];
    if (targetId === null || fields === undefined) continue;
    const set = unlockedByTarget.get(targetId) ?? new Set<ItemField>();
    for (const field of fields) set.add(field);
    unlockedByTarget.set(targetId, set);
  }
  return { unlockedByTarget, allDescriptionsUnlocked };
}

/** Narrows a stored `extraction_payload.review` into exactly what the lock
 * can prove the parser asserted. Anything unrecognised becomes a hole. */
function readStoredReview(review: unknown): StoredReview {
  const record = asRecord(review);
  const header = asRecord(record?.['header']);
  const { unlockedByTarget, allDescriptionsUnlocked } = readFlags(record);
  return {
    letterNumber: readField(header, 'letterNumber'),
    letterDate: readField(header, 'letterDate'),
    workDescription: readField(header, 'workDescription'),
    pricing: readPricing(record),
    pbg: readPbg(header),
    items: readItems(record),
    unlockedByTarget,
    allDescriptionsUnlocked,
  };
}

// ---------------------------------------------------------------------------
// comparison primitives
// ---------------------------------------------------------------------------

/** The named refusal. It carries the field, the letter's own value and the
 * submitted one in `details`, so a client can point at the offending
 * control without parsing prose, and it names the remedy, because under
 * this ruling there is exactly one. */
function refuseModification(
  field: string,
  extracted: string,
  submitted: string,
): never {
  throw httpError(
    400,
    'LOA_EXTRACTED_VALUE_MODIFIED',
    `${field} was extracted from the letter and cannot be changed at confirmation. The letter reads ${extracted}; this confirmation submitted ${submitted}. The extracted letter is the source of truth: if it is wrong, discard this LOA document and upload a corrected letter. Nothing was saved.`,
    { field, extracted, submitted },
  );
}

function describe(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return 'nothing';
  return JSON.stringify(String(value));
}

/** Accumulates the audit summary while the checks run. */
class LockTally {
  verified = 0;
  readonly letterHoles: string[] = [];
  itemHoles = 0;
  manualRows = 0;
  parsedRowsOmitted = 0;

  locked(): void {
    this.verified += 1;
  }

  letterHole(field: string): void {
    this.letterHoles.push(field);
  }

  itemHole(): void {
    this.itemHoles += 1;
  }
}

/** Every wire form of an extracted text value: the value itself, plus the
 * `maxLength` truncation the confirm schema forces on a longer one. */
function textForms(value: string, maxLength: number): readonly string[] {
  const trimmed = value.trim();
  return trimmed.length > maxLength
    ? [trimmed, trimmed.slice(0, maxLength)]
    : [trimmed];
}

/** Compares a locked TEXT value. `accepted` holds every form the wire can
 * carry the same extracted value in. Comparison ignores surrounding
 * whitespace only. */
function checkText(
  tally: LockTally,
  field: string,
  extractedDisplay: string,
  accepted: readonly string[],
  submitted: string,
): void {
  const normalised = submitted.trim();
  if (!accepted.some((candidate) => candidate.trim() === normalised)) {
    refuseModification(field, describe(extractedDisplay), describe(submitted));
  }
  tally.locked();
}

/** Compares a locked DECIMAL value in exact integer minor units — never
 * float arithmetic, and never string equality, so `"900"` and `"900.00"`
 * are the same extracted rupee figure. An extracted value that does not
 * survive the wire scale (or a strictly-positive column's floor) is a hole,
 * not a lock. */
function checkDecimal(
  tally: LockTally,
  field: string,
  extracted: string | number | null,
  scale: number,
  submitted: string | undefined,
  options: {
    readonly requirePositive?: boolean;
    readonly scope?: 'letter' | 'item';
  } = {},
): void {
  const expected =
    extracted === null ? null : parseDecimalToMinorUnits(String(extracted), scale);
  if (expected === null || (options.requirePositive === true && expected <= 0n)) {
    if (options.scope === 'item') tally.itemHole();
    else tally.letterHole(field);
    return;
  }
  const actual =
    submitted === undefined ? null : parseDecimalToMinorUnits(submitted, scale);
  if (actual === null || actual !== expected) {
    refuseModification(field, describe(extracted), describe(submitted));
  }
  tally.locked();
}

function checkInteger(
  tally: LockTally,
  field: string,
  extracted: number | null,
  submitted: number | undefined,
): void {
  if (extracted === null) {
    tally.letterHole(field);
    return;
  }
  if (submitted !== extracted) {
    refuseModification(field, describe(extracted), describe(submitted));
  }
  tally.locked();
}

// ---------------------------------------------------------------------------
// header, totals block and performance guarantee
// ---------------------------------------------------------------------------

function checkHeader(
  tally: LockTally,
  review: StoredReview,
  body: ConfirmWorkRequest,
): void {
  // Letter identity and the legal date every later document window is
  // measured from — the ruling's own examples. `minLength` mirrors the
  // confirm schema: an extracted value the wire cannot carry is a hole
  // (rule 2), never a lock nobody could satisfy.
  const letterDate = review.letterDate.value;
  const texts = [
    ['letterNumber', review.letterNumber.value, body.letterNumber, 200, 1],
    [
      'letterDate',
      letterDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(letterDate) ? letterDate : null,
      body.letterDate,
      10,
      10,
    ],
    ['title', review.workDescription.value, body.title, 1000, 3],
  ] as const;
  for (const [field, extracted, submitted, maxLength, minLength] of texts) {
    if (extracted === null || extracted.trim().length < minLength) {
      tally.letterHole(field);
      continue;
    }
    checkText(tally, field, extracted, textForms(extracted, maxLength), submitted);
  }

  // The totals block is classified as one unit: `needsReview` here means
  // the letter's own arithmetic did not reconcile, or a contradiction (a
  // rebate decoy, an at-par letter carrying a non-zero percentage) was
  // found. In that state none of its five columns is a verified truth, so
  // all five are the reviewer's to establish.
  const { pricing } = review;
  checkDecimal(
    tally,
    'advertisedValue',
    pricing.advertisedValue,
    MONEY_SCALE,
    body.advertisedValue,
  );
  checkDecimal(
    tally,
    'contractValue',
    pricing.contractValue,
    MONEY_SCALE,
    body.contractValue,
  );
  if (pricing.pricingShape === null) {
    tally.letterHole('pricingShape');
  } else {
    checkText(
      tally,
      'pricingShape',
      pricing.pricingShape,
      [pricing.pricingShape],
      body.pricingShape,
    );
  }
  if (pricing.direction === null) {
    tally.letterHole('letterPercentageDirection');
  } else {
    checkText(
      tally,
      'letterPercentageDirection',
      pricing.direction,
      [pricing.direction],
      body.letterPercentageDirection ?? '',
    );
  }
  // An at-par letter declares no percentage at all (LetterPercentageSchema's
  // own note), so a null here is a hole the reviewer fills with '0' — not a
  // value being overridden.
  checkDecimal(
    tally,
    'letterPercentage',
    pricing.letterPercentage,
    PERCENT_SCALE,
    body.letterPercentage,
  );
}

function checkPbgRequirement(
  tally: LockTally,
  review: StoredReview,
  submitted: ConfirmPbgRequirement | undefined,
): void {
  const { pbg } = review;
  // A letter whose clause was not found, or was found but could not be read
  // fully, leaves the whole requirement to the reviewer — including whether
  // the letter demands a guarantee at all. A letter that genuinely demands
  // none is the same case: there is nothing to lock.
  const clauseLocked = pbg.amountFigures !== null && pbg.submissionDays !== null;
  if (!clauseLocked) {
    tally.letterHole('pbgRequirement');
    return;
  }
  if (submitted === undefined) {
    // Dropping an extracted requirement is a modification like any other:
    // the guarantee, its window and the penal interest are what the letter
    // demands, and a Work confirmed with none would silently lose the PBG
    // due date the dashboard is built on.
    refuseModification(
      'pbgRequirement',
      describe(
        `a performance guarantee of ${String(pbg.amountFigures)} within ${String(pbg.submissionDays)} days`,
      ),
      'nothing',
    );
  }
  checkDecimal(
    tally,
    'pbgRequirement.requiredAmount',
    pbg.amountFigures,
    MONEY_SCALE,
    submitted.requiredAmount,
  );
  checkInteger(
    tally,
    'pbgRequirement.submissionDays',
    pbg.submissionDays,
    submitted.submissionDays,
  );
  if (pbg.extensionDays === null) {
    tally.letterHole('pbgRequirement.extensionDays');
  } else {
    checkInteger(
      tally,
      'pbgRequirement.extensionDays',
      pbg.extensionDays,
      submitted.extensionDays,
    );
  }
  checkDecimal(
    tally,
    'pbgRequirement.penalInterestPercent',
    pbg.penalInterestPercent,
    PERCENT_SCALE,
    submitted.penalInterestPercent,
  );
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

function checkItem(
  tally: LockTally,
  review: StoredReview,
  parsed: StoredItem,
  submitted: ConfirmWorkItem,
): void {
  const label = `item ${parsed.targetId}`;
  const unlocked = review.unlockedByTarget.get(parsed.targetId);

  // A description is locked only when it is the exact row-owned reading
  // from the PDF's own reading order. The `layout-overinclusive` fallback
  // deliberately claims the prose between two anchors for BOTH neighbours,
  // so it is not a verified per-row value and must stay correctable.
  const description = parsed.description?.trim() ?? '';
  if (
    !review.allDescriptionsUnlocked &&
    unlocked?.has('description') !== true &&
    parsed.descriptionExact &&
    description.length >= 3
  ) {
    checkText(
      tally,
      `${label}.description`,
      description,
      [description],
      submitted.description,
    );
  } else {
    tally.itemHole();
  }

  // The unit is locked when the printed spelling resolves to a canonical
  // unit code exactly (the same test that raises `unresolved_unit`). Both
  // the canonical code and the printed spelling name the same extracted
  // unit, so either may be submitted.
  const canonicalUnit = resolveCanonicalUnitCode(parsed.qtyUnit);
  if (unlocked?.has('unitCode') !== true && canonicalUnit !== null) {
    checkText(
      tally,
      `${label}.unitCode`,
      parsed.qtyUnit ?? canonicalUnit,
      [canonicalUnit, ...textForms(parsed.qtyUnit ?? canonicalUnit, 20)],
      submitted.unitCode,
    );
  } else {
    tally.itemHole();
  }

  // Quantity and rate are locked only when the row's own arithmetic
  // reconciled: a row where `qty × rate` does not equal the printed bid
  // amount is the letter contradicting itself, and the parser says so
  // rather than choosing a winner. Neither figure is a truth then.
  if (unlocked?.has('awardedQuantity') !== true && parsed.reconciled) {
    checkDecimal(
      tally,
      `${label}.awardedQuantity`,
      parsed.qty,
      QUANTITY_SCALE,
      submitted.awardedQuantity,
      { requirePositive: true, scope: 'item' },
    );
  } else {
    tally.itemHole();
  }
  if (unlocked?.has('effectiveRate') !== true && parsed.reconciled) {
    checkDecimal(
      tally,
      `${label}.effectiveRate`,
      parsed.unitRate,
      RATE_SCALE,
      submitted.effectiveRate,
      { scope: 'item' },
    );
  } else {
    tally.itemHole();
  }
}

function checkItems(
  tally: LockTally,
  review: StoredReview,
  body: ConfirmWorkRequest,
): void {
  const parsedByRef = new Map<string, StoredItem>();
  for (const item of review.items) parsedByRef.set(item.targetId, item);

  const seen = new Set<string>();
  for (const schedule of body.schedules) {
    for (const item of schedule.items) {
      if (item.manualEntry === true) {
        tally.manualRows += 1;
        continue;
      }
      if (!item.sourceRef) continue; // sourceEvidenceFor refuses this by name.
      const key = `${item.sourceRef.scheduleId}#${item.sourceRef.itemSno}`;
      const parsed = parsedByRef.get(key);
      if (parsed === undefined) continue; // SOURCE_REF_UNRESOLVED, likewise.
      seen.add(key);
      checkItem(tally, review, parsed, item);
    }
  }
  tally.parsedRowsOmitted = review.items.length - seen.size;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Refuses a confirmation that changes any value the stored parse
 * established, and reports what it verified for the audit trail.
 *
 * `review` is the stored `extraction_payload.review`, untyped: it is read
 * defensively, and a payload that carries no recognisable parse simply
 * locks nothing.
 */
export function assertExtractedValuesUnmodified(
  review: unknown,
  body: ConfirmWorkRequest,
): ExtractedValueLockSummary {
  const stored = readStoredReview(review);
  const tally = new LockTally();
  checkHeader(tally, stored, body);
  checkPbgRequirement(tally, stored, body.pbgRequirement);
  checkItems(tally, stored, body);
  return {
    lockedFieldsVerified: tally.verified,
    letterHolesFilled: tally.letterHoles,
    itemHolesFilled: tally.itemHoles,
    manualRows: tally.manualRows,
    parsedRowsOmitted: tally.parsedRowsOmitted,
  };
}
