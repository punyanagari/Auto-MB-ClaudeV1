/**
 * Verifying a railway VARIATION ORDER against the omission it is claimed to
 * authorise (owner ruling, 2026-08-13).
 *
 * WHY THIS MODULE EXISTS. Omitting an item after the LOA has been accepted
 * is a contractual event, not a correction, and the railway authorises it
 * by a variation order. A letter number somebody TYPED is a claim; a letter
 * number found in the uploaded order's own text layer, beside the item it
 * names, is evidence. This module is the second half of the truth-source
 * discipline `loa-extracted-values.ts` established for the LOA: extracted
 * values are the truth, and the operator does not get to assert them.
 *
 * WHAT THE DOCUMENTS ACTUALLY ARE. Five real orders were examined (two
 * Central Railway/Bhusawal, Western Railway/Mumbai, Northeast Frontier
 * Railway/Lumding, Western Railway/Ahmedabad). Every machine-readable one
 * is the same IREPS-generated "Variation Statement", identical in layout
 * across three different railways, with three sections:
 *
 *   1. "Agreement Details" — labelled key/value pairs laid out several to a
 *      line, including LOA Number, LOA Date, LOA Amount (Rs.), Agreement No
 *      and Variation Number.
 *   2. "Schedules Details" — per-schedule money totals. Not read here.
 *   3. "Variation Details" — the item level, one row per item followed by a
 *      `Description:` line and a `Remarks:` line.
 *
 * THE DECISIVE READING. A variation order does not carry a "delete"
 * instruction. An omission appears in the Variation Details table as a
 * PROPOSED QUANTITY OF ZERO on the item's row (with the %age-variation
 * column reading -100). That was confirmed on 67 genuinely omitted items
 * across the corpus. Verifying an omission therefore means finding the
 * item's row and reading its Proposed Qty. — nothing about the document
 * needs to be interpreted as prose.
 *
 * WHAT IS PROVISIONAL. The label spellings, the column order, and the
 * item-type anchor below were read off three real orders. They are
 * deliberately isolated in this file — no recognition regex lives in the
 * route — so that widening them when a new railway's layout appears is a
 * change to one module with a fixture beside it. Every recognition
 * constant carries a PROVISIONAL note naming what it was calibrated on.
 *
 * FAIL CLOSED. Every required claim must be positively VERIFIED. Anything
 * that cannot be read — no text layer, a wrapped row whose columns cannot
 * be told apart, an ambiguous item match — is `unverified`, and unverified
 * refuses the approval. There is no warning an approver can click past.
 * Two of the five real samples are photographs of paper (a phone scan and
 * a print-to-PDF of an image) with no text layer at all, and both are
 * refused: the machine-readable IREPS original is what must be uploaded.
 *
 * EXTENDING TO QUANTITY AMENDMENTS. The same table states the proposed
 * quantity for EVERY item, not only omitted ones, so verifying a
 * quantity/rate amendment is the same read with a different expected
 * value. `verifyVariationOrder` already returns the row it found; the
 * owner scoped this ruling to omissions, so only the zero-quantity
 * expectation is wired up.
 */
import { resolveCanonicalUnitCode } from '@auto-mb/loa-parser';

// ---------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------

/** Every claim this module can make about an uploaded order. Codes are
 * stable: they are stored in the verdict JSONB, shown to the approver, and
 * named in the refusal message. */
export const VARIATION_ORDER_CLAIM_CODES = [
  'text_layer',
  'variation_statement',
  'loa_number',
  'loa_date',
  'variation_number',
  'item_listed',
  'item_omitted',
  'item_unit',
  'item_original_quantity',
  'loa_amount',
] as const;

export type VariationOrderClaimCode = (typeof VARIATION_ORDER_CLAIM_CODES)[number];

export interface VariationOrderClaim {
  readonly code: VariationOrderClaimCode;
  /** Whether the document positively supports the claim. */
  readonly verified: boolean;
  /** Whether a failure of this claim refuses the approval. Exactly one
   * claim is advisory — see ADVISORY_CLAIMS. */
  readonly required: boolean;
  /** One operator-readable sentence: what was expected and what the
   * document says. Never contains the whole document. */
  readonly detail: string;
  /** The document's own value, when one was found. */
  readonly found: string | null;
  /** The value the amendment or the Work asserted, when applicable. */
  readonly expected: string | null;
}

export interface VariationOrderVerdict {
  /** True only when every REQUIRED claim is verified. */
  readonly verified: boolean;
  readonly claims: readonly VariationOrderClaim[];
  /** The codes of required claims that failed, in claim order. Empty when
   * `verified`. */
  readonly failedClaims: readonly VariationOrderClaimCode[];
  /** Facts read out of the order, for the audit trail and the approver's
   * screen. Null where the document did not yield them. */
  readonly document: VariationOrderFacts;
}

/** Identity read out of the order itself. Nothing here is operator input:
 * a value the document did not state stays null and fails its claim. */
export interface VariationOrderFacts {
  readonly loaNumber: string | null;
  /** ISO `YYYY-MM-DD`, converted from the printed `DD/MM/YYYY`. */
  readonly loaDate: string | null;
  /** The printed LOA amount, verbatim (`5.311708E+7`, `41,301,860`). */
  readonly loaAmountText: string | null;
  readonly agreementNumber: string | null;
  readonly agreementDate: string | null;
  readonly variationNumber: string | null;
  readonly railwayName: string | null;
  readonly unitName: string | null;
  /** The Variation Details row matched to the amendment's item. */
  readonly itemRow: VariationOrderItemRow | null;
}

/** One fully-read row of the Variation Details table. A row whose columns
 * could not be told apart is never produced — it is simply not found. */
export interface VariationOrderItemRow {
  readonly scheduleType: string;
  readonly schedule: string;
  readonly itemNumber: string;
  readonly itemType: string;
  readonly unit: string;
  readonly originalQuantity: string;
  readonly baseRate: string;
  readonly lastVariationQuantity: string;
  readonly agreementRate: string;
  readonly originalAmount: string;
  readonly proposedQuantity: string;
  readonly proposedAmount: string;
  readonly proposedAmountWithSpecialConditions: string;
  readonly percentageVariation: string;
}

/** What the product holds, and what the order must therefore describe. */
export interface OmissionUnderVerification {
  /** `works.letter_number` — the LOA letter number, the strong contract
   * link: the order prints it as "LOA Number". */
  readonly workLetterNumber: string;
  /** `works.letter_date`, ISO `YYYY-MM-DD`. */
  readonly workLetterDate: string;
  /** The item being omitted, as the product labels it (`A/20`). */
  readonly itemNumber: string;
  /** The item's stored unit code. */
  readonly unitCode: string;
  /** The item's sanctioned quantity, as a decimal string. */
  readonly awardedQuantity: string;
  /** `works.contract_value`, for the advisory amount claim. */
  readonly contractValue: string | null;
}

/**
 * The single advisory claim. The printed LOA amount is rendered by IREPS in
 * SCIENTIFIC NOTATION on some orders (`5.311708E+7` for an agreement worth
 * 53,117,080.42), which throws away everything past seven significant
 * figures, and the figure printed is the agreement value at the time the
 * order was raised — which legitimately differs from our stored contract
 * value once an earlier variation has been sanctioned. Requiring it would
 * refuse lawful orders for arithmetic the document itself cannot express.
 * It is read, compared with tolerance, and SHOWN to the approver, so a
 * genuine mismatch is in front of a human; it does not gate approval.
 */
const ADVISORY_CLAIMS: ReadonlySet<VariationOrderClaimCode> = new Set(['loa_amount']);

// ---------------------------------------------------------------------------
// text normalisation
// ---------------------------------------------------------------------------

/** Poppler emits CRLF on Windows and LF elsewhere, and a form feed at every
 * page break. Recognition must not depend on which host extracted the PDF. */
function normaliseText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\f', '\n');
}

/**
 * A document with no text layer at all. PROVISIONAL floor: the three
 * machine-readable samples yield 38 000–208 000 characters, while the two
 * photographed ones yield exactly zero. 200 sits far below any real order
 * and far above the empty case, and exists so a PDF carrying nothing but a
 * digital-signature annotation is still refused.
 */
const MIN_TEXT_LAYER_CHARACTERS = 200;

/** IREPS section markers. PROVISIONAL: identical across the three
 * machine-readable samples (Northeast Frontier, Central and Western
 * Railway). All three must be present — a tender document or an LOA has
 * none of them. */
const STATEMENT_MARKERS: readonly RegExp[] = [
  /^\s*Variation Statement\s*$/m,
  /^\s*Agreement Details:/m,
  /^\s*Variation Details:/m,
];

// ---------------------------------------------------------------------------
// the Agreement Details block
// ---------------------------------------------------------------------------

/**
 * Field labels as IREPS prints them. PROVISIONAL, calibrated on three
 * orders. Whitespace inside a label is irregular in the extracted text
 * (`LOA  Amount   (Rs.):` carries doubled spaces), so every label is
 * matched with `\s+` between its words rather than verbatim.
 *
 * Several labelled pairs share one line, so a value ends at the first run
 * of TWO OR MORE spaces — the column gap — or at end of line.
 */
const AGREEMENT_LABELS = {
  loaNumber: ['LOA', 'Number'],
  loaDate: ['LOA', 'Date'],
  loaAmount: ['LOA', 'Amount', '\\(Rs\\.\\)'],
  agreementNumber: ['Agreement', 'No'],
  agreementDate: ['Agreement', 'Date'],
  variationNumber: ['Variation', 'Number'],
  railwayName: ['Railway', 'Name'],
  unitName: ['Unit', 'Name'],
} as const satisfies Record<string, readonly string[]>;

function readLabelledField(text: string, words: readonly string[]): string | null {
  const label = words.join('\\s+');
  // The value runs to a two-space column gap or the end of the line. A
  // label is anchored at a line start or after a column gap so that
  // "Agreement Date" can never be read as "Date".
  const pattern = new RegExp(
    `(?:^|\\s{2})${label}\\s*:\\s*(\\S(?:[^\\n]*?\\S)?)(?:\\s{2}|$)`,
    'm',
  );
  const match = pattern.exec(text);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/** IREPS prints calendar dates as `DD/MM/YYYY` throughout. PROVISIONAL:
 * every date on all three samples uses this form. Converted to the
 * product's date-only ISO representation; anything else yields null rather
 * than a guess. */
const PRINTED_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function printedDateToIso(printed: string | null): string | null {
  if (printed === null) return null;
  const match = PRINTED_DATE_RE.exec(printed.trim());
  if (match === null) return null;
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) return null;
  const iso = `${year}-${month}-${day}`;
  // Reject 31/02: a date the calendar does not carry is not a date read.
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)
    ? null
    : iso;
}

/** `5.311708E+7`, `41,301,860`, `79,892,180` — every amount form seen.
 * Returns null rather than NaN for anything else. */
export function parsePrintedAmount(printed: string | null): number | null {
  if (printed === null) return null;
  const cleaned = printed.replaceAll(',', '').trim();
  if (!/^[+-]?\d+(\.\d+)?([Ee][+-]?\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// the Variation Details table
// ---------------------------------------------------------------------------

/**
 * The item-type column, used as the row anchor. PROVISIONAL: every row of
 * every sample reads `Individual`; `Composite` is included because IREPS
 * offers composite items and one would otherwise be silently unreadable
 * (which fails closed, but unhelpfully).
 *
 * Anchoring on this column is what makes the reader robust: the three
 * columns before it are (schedule type, schedule, item no.) whether or not
 * the optional "Previous Variation Revno." column is filled, and the
 * columns after it are the unit followed by exactly nine numbers.
 */
const ITEM_TYPE_ANCHORS: readonly string[] = ['Individual', 'Composite'];

/** Columns after the unit, in printed order. Their count is the row's own
 * integrity check: a row that wrapped across lines yields fewer and is
 * discarded rather than mis-read. */
const NUMERIC_COLUMNS = [
  'originalQuantity',
  'baseRate',
  'lastVariationQuantity',
  'agreementRate',
  'originalAmount',
  'proposedQuantity',
  'proposedAmount',
  'proposedAmountWithSpecialConditions',
  'percentageVariation',
] as const;

const NUMERIC_TOKEN_RE = /^[+-]?[\d,]*\d(\.\d+)?([Ee][+-]?\d+)?$/;

function isNumericToken(token: string): boolean {
  return NUMERIC_TOKEN_RE.test(token) && /\d/.test(token);
}

/** The Variation Details section, i.e. everything after the LAST line that
 * is exactly `Variation Details:`. The qualifier matters: orders that
 * carry earlier sanctioned variations also print a `Last Sanctioned
 * Variation Details:` heading above it. */
function variationDetailsSection(text: string): string | null {
  const lines = text.split('\n');
  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === 'Variation Details:') start = index;
  }
  return start === -1 ? null : lines.slice(start + 1).join('\n');
}

/** Parses every fully-readable row of the section. Rows whose cells wrapped
 * across lines do not parse and are deliberately absent. */
export function readVariationRows(sectionText: string): VariationOrderItemRow[] {
  const rows: VariationOrderItemRow[] = [];
  for (const rawLine of sectionText.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Prose rows sit under every item and may themselves contain the
    // anchor word; skipping them by prefix removes the obvious case, and
    // the nine-number requirement below removes the rest.
    if (line.startsWith('Description:') || line.startsWith('Remarks:')) continue;
    const tokens = line.split(/\s+/);
    const anchor = tokens.findIndex((token) => ITEM_TYPE_ANCHORS.includes(token));
    if (anchor < 3) continue;
    const unit = tokens[anchor + 1];
    if (unit === undefined || isNumericToken(unit)) continue;
    const numbers = tokens.slice(anchor + 2);
    if (numbers.length !== NUMERIC_COLUMNS.length) continue;
    if (!numbers.every(isNumericToken)) continue;
    const scheduleType = tokens[anchor - 3];
    const schedule = tokens[anchor - 2];
    const itemNumber = tokens[anchor - 1];
    const itemType = tokens[anchor];
    if (
      scheduleType === undefined ||
      schedule === undefined ||
      itemNumber === undefined ||
      itemType === undefined
    ) {
      continue;
    }
    const values = Object.fromEntries(
      NUMERIC_COLUMNS.map((name, index) => [name, numbers[index] ?? '']),
    ) as Record<(typeof NUMERIC_COLUMNS)[number], string>;
    rows.push({ scheduleType, schedule, itemNumber, itemType, unit, ...values });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// matching the product's item to a printed row
// ---------------------------------------------------------------------------

/** The same normalisation `contract-sources.ts` uses to compare an item
 * reference with an item number: case, punctuation and spacing carry no
 * meaning in these labels. */
function normaliseReference(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Finds the printed row for a product item, or explains why it could not.
 *
 * The product labels an item `A/20`; IREPS prints the schedule (`A`) and
 * the item number (`20`) in separate columns. A label carrying a separator
 * is therefore matched against schedule+item together, which keeps `A/20`
 * and `B/20` apart. A label with no separator is matched against the item
 * column alone. More than one match is AMBIGUOUS and yields nothing —
 * guessing which row the railway meant is exactly what this module exists
 * not to do.
 */
export function findRowForItem(
  rows: readonly VariationOrderItemRow[],
  itemNumber: string,
): { readonly row: VariationOrderItemRow | null; readonly ambiguous: boolean } {
  const wanted = normaliseReference(itemNumber);
  if (wanted.length === 0) return { row: null, ambiguous: false };
  const hasSeparator = /[^A-Za-z0-9]/.test(itemNumber.trim());
  const matches = rows.filter((row) => {
    const combined = normaliseReference(`${row.schedule}${row.itemNumber}`);
    if (combined === wanted) return true;
    return !hasSeparator && normaliseReference(row.itemNumber) === wanted;
  });
  if (matches.length > 1) return { row: null, ambiguous: true };
  return { row: matches[0] ?? null, ambiguous: false };
}

// ---------------------------------------------------------------------------
// decimal comparison
// ---------------------------------------------------------------------------

/** Compares two decimal strings by value, never by spelling: `4`, `4.0`
 * and `4.000` are the same quantity. Returns null when either side is not
 * a number this module is willing to read. */
function decimalsEqual(left: string | null, right: string | null): boolean | null {
  const a = parsePrintedAmount(left);
  const b = parsePrintedAmount(right);
  if (a === null || b === null) return null;
  // Quantities carry at most three decimals in this product, so a
  // comparison in thousandths is exact for every value either side can
  // hold, without float equality.
  return Math.round(a * 1000) === Math.round(b * 1000);
}

function isZeroQuantity(value: string): boolean {
  const parsed = parsePrintedAmount(value);
  return parsed !== null && Math.round(parsed * 1000) === 0;
}

/** The advisory amount comparison. A relative tolerance of one part in a
 * million absorbs the seven-significant-figure scientific notation IREPS
 * prints (53,117,080.42 becomes `5.311708E+7`). */
const AMOUNT_RELATIVE_TOLERANCE = 1e-6;

function amountsAgree(printed: number, stored: number): boolean {
  if (printed === stored) return true;
  const scale = Math.max(Math.abs(printed), Math.abs(stored));
  return scale > 0 && Math.abs(printed - stored) / scale <= AMOUNT_RELATIVE_TOLERANCE;
}

// ---------------------------------------------------------------------------
// unit comparison
// ---------------------------------------------------------------------------

/**
 * The order and the Work item descend from the same IREPS schedule, so the
 * printed unit is normally the identical spelling the LOA carried
 * (`Numbers`, `Metre`, `Kilometre`, `Pair`, `Set`, `Job`, `Lot`, and the
 * non-canonical `Boxes` / `System` seen once each). Agreement is accepted
 * on the spelling, or on the canonical unit code when BOTH sides resolve —
 * never on a guess, and never on an alias lookup this module does not own.
 */
function unitsAgree(printed: string, stored: string): boolean {
  if (printed.trim().toLowerCase() === stored.trim().toLowerCase()) return true;
  const printedCode = resolveCanonicalUnitCode(printed.trim());
  const storedCode = resolveCanonicalUnitCode(stored.trim());
  return printedCode !== null && printedCode === storedCode;
}

// ---------------------------------------------------------------------------
// the verifier
// ---------------------------------------------------------------------------

class ClaimSet {
  private readonly claims: VariationOrderClaim[] = [];

  add(
    code: VariationOrderClaimCode,
    verified: boolean,
    detail: string,
    found: string | null = null,
    expected: string | null = null,
  ): void {
    this.claims.push({
      code,
      verified,
      required: !ADVISORY_CLAIMS.has(code),
      detail,
      found,
      expected,
    });
  }

  /** Claims not reached because an earlier one failed are recorded as
   * unverified with the reason, so the verdict is never silently short. */
  addUnreached(codes: readonly VariationOrderClaimCode[], reason: string): void {
    for (const code of codes) this.add(code, false, reason);
  }

  finish(document: VariationOrderFacts): VariationOrderVerdict {
    const failedClaims = this.claims
      .filter((claim) => claim.required && !claim.verified)
      .map((claim) => claim.code);
    return {
      verified: failedClaims.length === 0,
      claims: this.claims,
      failedClaims,
      document,
    };
  }
}

const EMPTY_FACTS: VariationOrderFacts = {
  loaNumber: null,
  loaDate: null,
  loaAmountText: null,
  agreementNumber: null,
  agreementDate: null,
  variationNumber: null,
  railwayName: null,
  unitName: null,
  itemRow: null,
};

/**
 * Verifies that `text` — the Poppler-extracted text layer of an uploaded
 * PDF — is a railway variation order that authorises omitting
 * `omission.itemNumber` from the Work.
 *
 * Pure: no I/O, no clock, no database. Everything it knows arrives in its
 * two arguments, which is what makes the recognition rules testable
 * against fixtures alone.
 */
export function verifyVariationOrder(
  text: string,
  omission: OmissionUnderVerification,
): VariationOrderVerdict {
  const claims = new ClaimSet();
  const normalised = normaliseText(text);

  if (normalised.trim().length < MIN_TEXT_LAYER_CHARACTERS) {
    claims.add(
      'text_layer',
      false,
      'The uploaded PDF has no usable text layer. A photographed or scanned copy cannot be verified; upload the machine-readable variation order issued by IREPS.',
    );
    claims.addUnreached(
      VARIATION_ORDER_CLAIM_CODES.filter((code) => code !== 'text_layer'),
      'Not checked: the document has no text layer to read.',
    );
    return claims.finish(EMPTY_FACTS);
  }
  claims.add(
    'text_layer',
    true,
    `The PDF carries a readable text layer (${String(normalised.trim().length)} characters).`,
  );

  const missingMarker = STATEMENT_MARKERS.find((marker) => !marker.test(normalised));
  if (missingMarker !== undefined) {
    claims.add(
      'variation_statement',
      false,
      'The uploaded PDF is not a railway Variation Statement: its "Variation Statement", "Agreement Details" and "Variation Details" sections were not all found.',
    );
    claims.addUnreached(
      VARIATION_ORDER_CLAIM_CODES.filter(
        (code) => code !== 'text_layer' && code !== 'variation_statement',
      ),
      'Not checked: the document is not a recognised Variation Statement.',
    );
    return claims.finish(EMPTY_FACTS);
  }
  claims.add(
    'variation_statement',
    true,
    'The document is a railway Variation Statement.',
  );

  const loaNumber = readLabelledField(normalised, AGREEMENT_LABELS.loaNumber);
  const loaDatePrinted = readLabelledField(normalised, AGREEMENT_LABELS.loaDate);
  const loaAmountText = readLabelledField(normalised, AGREEMENT_LABELS.loaAmount);
  const section = variationDetailsSection(normalised);
  const rows = section === null ? [] : readVariationRows(section);
  const { row, ambiguous } = findRowForItem(rows, omission.itemNumber);
  const facts: VariationOrderFacts = {
    loaNumber,
    loaDate: printedDateToIso(loaDatePrinted),
    loaAmountText,
    agreementNumber: readLabelledField(normalised, AGREEMENT_LABELS.agreementNumber),
    agreementDate: readLabelledField(normalised, AGREEMENT_LABELS.agreementDate),
    variationNumber: readLabelledField(normalised, AGREEMENT_LABELS.variationNumber),
    railwayName: readLabelledField(normalised, AGREEMENT_LABELS.railwayName),
    unitName: readLabelledField(normalised, AGREEMENT_LABELS.unitName),
    itemRow: row,
  };

  // --- the contract link ---------------------------------------------------
  // The order's LOA Number against the Work's LOA letter number. This is
  // the claim that stops a genuine variation order for a DIFFERENT contract
  // authorising an omission here.
  const loaNumberMatches =
    loaNumber !== null &&
    normaliseReference(loaNumber) === normaliseReference(omission.workLetterNumber) &&
    normaliseReference(loaNumber).length > 0;
  claims.add(
    'loa_number',
    loaNumberMatches,
    loaNumber === null
      ? 'The order does not print an LOA Number, so it cannot be tied to this Work.'
      : loaNumberMatches
        ? 'The order cites this Work’s LOA number.'
        : 'The order cites a different LOA number from this Work’s, so it does not authorise a change here.',
    loaNumber,
    omission.workLetterNumber,
  );

  const loaDateMatches =
    facts.loaDate !== null && facts.loaDate === omission.workLetterDate;
  claims.add(
    'loa_date',
    loaDateMatches,
    facts.loaDate === null
      ? 'The order does not print a readable LOA Date.'
      : loaDateMatches
        ? 'The order’s LOA date matches this Work’s.'
        : 'The order’s LOA date does not match this Work’s.',
    facts.loaDate,
    omission.workLetterDate,
  );

  // The variation's own identity. Recorded and required to be PRESENT, but
  // deliberately not required to be sequential: a Work adopted mid-contract
  // legitimately never saw variations 1..n-1, so enforcing an order would
  // refuse lawful paperwork. The number is surfaced to the approver instead.
  const variationNumber = facts.variationNumber;
  claims.add(
    'variation_number',
    variationNumber !== null,
    variationNumber === null
      ? 'The order does not print a Variation Number.'
      : `The order is variation ${variationNumber} of this agreement.`,
    variationNumber,
  );

  // --- the item ------------------------------------------------------------
  if (row === null) {
    const detail = ambiguous
      ? `More than one row of the Variation Details table matches item ${omission.itemNumber}; the order cannot be read as naming one item.`
      : section === null
        ? 'The order carries no readable Variation Details table.'
        : `Item ${omission.itemNumber} is not named in the order’s Variation Details table (${String(rows.length)} item rows were read).`;
    claims.add('item_listed', false, detail, null, omission.itemNumber);
    claims.addUnreached(
      ['item_omitted', 'item_unit', 'item_original_quantity'],
      `Not checked: item ${omission.itemNumber} was not found in the order.`,
    );
  } else {
    claims.add(
      'item_listed',
      true,
      `The order names item ${omission.itemNumber} (schedule ${row.schedule}, item ${row.itemNumber}).`,
      `${row.schedule}/${row.itemNumber}`,
      omission.itemNumber,
    );

    // THE claim: a variation order omits an item by proposing zero for it.
    const omitted = isZeroQuantity(row.proposedQuantity);
    claims.add(
      'item_omitted',
      omitted,
      omitted
        ? `The order proposes a quantity of ${row.proposedQuantity} for item ${omission.itemNumber}, which is the omission.`
        : `The order proposes a quantity of ${row.proposedQuantity} for item ${omission.itemNumber}, not zero, so it does not omit the item.`,
      row.proposedQuantity,
      '0',
    );

    const unitOk = unitsAgree(row.unit, omission.unitCode);
    claims.add(
      'item_unit',
      unitOk,
      unitOk
        ? `The order’s unit for item ${omission.itemNumber} matches the Work.`
        : `The order states the unit of item ${omission.itemNumber} as ${row.unit}, but the Work holds ${omission.unitCode}, so the order does not describe the item we hold.`,
      row.unit,
      omission.unitCode,
    );

    const quantityOk = decimalsEqual(row.originalQuantity, omission.awardedQuantity);
    claims.add(
      'item_original_quantity',
      quantityOk === true,
      quantityOk === true
        ? `The order’s original agreement quantity for item ${omission.itemNumber} matches the Work.`
        : `The order states the original agreement quantity of item ${omission.itemNumber} as ${row.originalQuantity}, but the Work holds ${omission.awardedQuantity}, so the order does not describe the item we hold.`,
      row.originalQuantity,
      omission.awardedQuantity,
    );
  }

  // --- advisory ------------------------------------------------------------
  const printedAmount = parsePrintedAmount(loaAmountText);
  const storedAmount =
    omission.contractValue === null ? null : parsePrintedAmount(omission.contractValue);
  const amountAgrees =
    printedAmount !== null &&
    storedAmount !== null &&
    amountsAgree(printedAmount, storedAmount);
  claims.add(
    'loa_amount',
    amountAgrees,
    printedAmount === null
      ? 'The order does not print a readable LOA amount. Advisory only.'
      : storedAmount === null
        ? `The order prints an LOA amount of ${String(loaAmountText)}; this Work holds no comparable contract value. Advisory only.`
        : amountAgrees
          ? 'The order’s LOA amount agrees with this Work’s contract value.'
          : `The order prints an LOA amount of ${String(loaAmountText)} against this Work’s contract value of ${String(omission.contractValue)}. Advisory only — an earlier sanctioned variation legitimately moves this figure.`,
    loaAmountText,
    omission.contractValue,
  );

  return claims.finish(facts);
}

/** The operator-facing sentence for a refusal: the failed claims in order,
 * each already carrying its own explanation. */
export function describeFailedClaims(verdict: VariationOrderVerdict): string {
  return verdict.claims
    .filter((claim) => claim.required && !claim.verified)
    .map((claim) => `${claim.code}: ${claim.detail}`)
    .join(' ');
}
