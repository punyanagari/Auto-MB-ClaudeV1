/**
 * Reading the Zoho Books invoice export into the historical register
 * (migration 0115).
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is a pure reading of a CSV export: no database handle, no request, no
 * clock. Everything below is a function from text (and, for the two link
 * proposals, from a list of candidates the route read under RLS) to plain
 * values. That is what makes the whole of it testable against synthetic
 * fixtures — which matters here more than usual, because the only file
 * that exercises every branch is a real customer's billing history and no
 * row of it may enter this repository.
 *
 * It is NOT a validator of the organisation's billing. The register stores
 * what Zoho said, and the one judgement it makes about a figure is whether
 * it is an exact decimal lexeme — because a money column that silently
 * became a float is the failure this repository refuses everywhere else.
 *
 * ## The four things the export lies about, and what is done instead
 *
 * 1. `Invoice Status` says `Draft` on invoices that carry an IRN — 372 of
 *    638 in the real export, every one of them e-invoiced and filed. It is
 *    a Zoho workflow flag, not a statement about whether the invoice was
 *    issued. So ISSUED-NESS IS DERIVED FROM THE IRN and the raw status is
 *    kept beside it as evidence rather than as truth.
 * 2. `Balance` is not receivable truth. Receipts against these invoices
 *    live in Tally, not in Zoho, so a balance here is the balance of a
 *    system that never saw the money. Stored as evidence; nothing reads it
 *    as an amount owed and nothing in this pack computes a receivable.
 * 3. One CSV row is one LINE, not one invoice. The invoice-level columns
 *    are repeated verbatim on every line of a multi-line invoice, so rows
 *    are grouped by `Invoice ID` — Zoho's own stable identifier, which is
 *    also the idempotency key the register is unique on.
 * 4. `HSN/SAC` mixes a service code (998734) and goods HSNs in one column,
 *    because the organisation bills both. It is stored as text and nothing
 *    infers a supply kind from it.
 */

import { CsvParseError, headerKey, parseCsv } from './csv.js';

/* --- refusals -------------------------------------------------------------- */

/**
 * A refusal about the CONTENT of the export, as opposed to `CsvParseError`
 * which is about its shape. Carries the row and the column so an operator
 * can find the cell, in the spelling the file itself uses — the same
 * discipline `spreadsheet_import_rows.errors` follows (0094).
 */
export class ZohoInvoiceImportError extends Error {
  constructor(
    message: string,
    readonly rowNumber: number,
    readonly column: string,
  ) {
    super(message);
    this.name = 'ZohoInvoiceImportError';
  }
}

/* --- the columns this reader knows about ----------------------------------- */

/**
 * The export carries 193 columns and this register types 22 of them.
 *
 * The rest are not discarded: every row's FULL cell set is stored as
 * jsonb, which is 0066's `extraction_payload` discipline — the typed
 * columns are what the register is queried on, and the raw row is what
 * answers a question nobody anticipated without a re-import.
 *
 * Matched by NORMALISED header text, so `SubTotal`, `Sub Total` and
 * `SUBTOTAL ` are one column. Zoho's own header spelling is the value
 * here; the normalisation is what survives a re-export whose casing moved.
 */
const COLUMNS = {
  zohoInvoiceId: 'Invoice ID',
  invoiceNumber: 'Invoice Number',
  invoiceDate: 'Invoice Date',
  zohoStatus: 'Invoice Status',
  customerZohoId: 'Customer ID',
  customerName: 'Customer Name',
  customerGstin: 'GST Identification Number (GSTIN)',
  placeOfSupply: 'Place of Supply',
  referenceText: 'PurchaseOrder',
  subTotal: 'SubTotal',
  total: 'Total',
  balance: 'Balance',
  roundOff: 'Round Off',
  irn: 'e-Invoice Reference Number',
  ackNumber: 'e-Invoice Ack Number',
  ackDate: 'e-Invoice Ack Date',
  qrPayload: 'e-Invoice QR Raw Data',
  itemName: 'Item Name',
  itemDescription: 'Item Desc',
  quantity: 'Quantity',
  usageUnit: 'Usage unit',
  itemPrice: 'Item Price',
  itemTotal: 'Item Total',
  hsnSac: 'HSN/SAC',
  supplyType: 'Supply Type',
  cgstRate: 'CGST Rate %',
  sgstRate: 'SGST Rate %',
  igstRate: 'IGST Rate %',
  cgstAmount: 'CGST',
  sgstAmount: 'SGST',
  igstAmount: 'IGST',
} as const;

/** The columns without which the file is not an invoice export at all. A
 * missing one refuses the upload rather than producing 638 identical
 * row-level complaints. */
const REQUIRED_COLUMNS = [
  COLUMNS.zohoInvoiceId,
  COLUMNS.invoiceNumber,
  COLUMNS.invoiceDate,
  COLUMNS.customerName,
  COLUMNS.subTotal,
  COLUMNS.total,
] as const;

/* --- value readers --------------------------------------------------------- */

function trimmed(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  return text.length === 0 ? null : text;
}

/**
 * An exact decimal at a fixed scale, or a refusal naming the cell.
 *
 * Thousands separators and a stray currency symbol are stripped, because
 * a spreadsheet that was opened and re-saved acquires both; everything
 * after that must be a plain decimal lexeme. Trailing zeros beyond the
 * scale are accepted (`1.500` at scale 2 is `1.50`); a significant digit
 * beyond it is NOT, because dropping it would invent an amount.
 *
 * INTERIOR WHITESPACE IS A REFUSAL, not something to collapse. Only the
 * ends are trimmed. An earlier reading stripped every space anywhere in
 * the cell, which turned `1 200` into `1200` and `12 00` into `1200` with
 * equal confidence — a cell that has a space in the middle of a number is
 * a cell nobody should be guessing about, and the two readings of it
 * differ by a factor of ten.
 *
 * THE CANONICAL FORM IS WHAT THE API'S OWN PATTERNS ACCEPT. Leading zeros
 * are stripped, because `SignedMoneyStringSchema` spells its integer part
 * `0|[1-9]\d*` — a spreadsheet's `0000123.00` parsed cleanly here and then
 * failed response validation as a 500 with nothing naming the cell. The
 * integer digits are bounded for the mirror-image reason: the column is
 * `numeric(18, scale)` and a twenty-digit figure reached PostgreSQL as a
 * numeric field overflow, which is also a 500 with no cell named. Both are
 * refused HERE, in the preview, where the refusal carries a row number and
 * nothing has been written.
 *
 * Nothing here goes through `Number`. The string is padded and truncated
 * as text, so an eighteen-digit figure is exact for the same reason
 * `money.ts` counts in BigInt.
 */
function exactDecimal(
  raw: string | undefined,
  scale: number,
  column: string,
  rowNumber: number,
): string | null {
  const text = (raw ?? '').trim().replace(/[,₹]/g, '');
  if (text.length === 0) return null;
  // Fully anchored, one digit run then an optional fraction. Each
  // repetition consumes a digit no other branch can also consume, so this
  // is linear on every input — `money.ts` waives the same rule for the
  // same lexeme and the same reason.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(raw ?? '')}, which is not a number this can store.`,
      rowNumber,
      column,
    );
  }
  const fraction = match[3] ?? '';
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(raw ?? '')}, which carries more precision than this register stores (${String(scale)} decimal places).`,
      rowNumber,
      column,
    );
  }
  // The column is numeric(18, scale), and the API's money and quantity
  // patterns stop at fifteen integer digits — so the narrower of the two
  // is the bound, computed rather than restated per call site.
  const limit = Math.min(18 - scale, 15);
  const integer = (match[2] ?? '0').replace(/^0+(?=\d)/, '');
  if (integer.length > limit) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(raw ?? '')}, which is wider than this register stores (${String(limit)} digits before the decimal point).`,
      rowNumber,
      column,
    );
  }
  return `${match[1] ?? ''}${integer}.${fraction.slice(0, scale).padEnd(scale, '0')}`;
}

/**
 * A GST rate: an exact decimal that is also a PERCENTAGE.
 *
 * The three rate columns are the only cells in the export whose meaning
 * bounds them — a CGST rate is 0, 2.5, 6, 9 or 14 in practice and cannot
 * exceed 100 in principle. Without the ceiling a mis-mapped column (an
 * amount read as a rate is the obvious way it happens) is stored as a rate
 * of nine hundred thousand percent and nothing ever says so.
 *
 * `Number` appears here and nowhere else in this file, and only as a
 * COMPARISON against a bound — never as a value that is stored. The lexeme
 * it reads has already been proven to be at most two integer digits' worth
 * of interest either side of the bound, so the comparison is exact.
 */
function rate(
  raw: string | undefined,
  column: string,
  rowNumber: number,
): string | null {
  const value = exactDecimal(raw, 2, column, rowNumber);
  if (value !== null && Math.abs(Number(value)) > 100) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(raw ?? '')}, which is not a tax rate — a rate is a percentage and cannot exceed 100.`,
      rowNumber,
      column,
    );
  }
  return value;
}

/** A required money figure. The header-level totals are always present in
 * a Zoho export; a blank one means the row is not the row it claims. */
function requiredMoney(
  raw: string | undefined,
  column: string,
  rowNumber: number,
): string {
  const value = exactDecimal(raw, 2, column, rowNumber);
  if (value === null) {
    throw new ZohoInvoiceImportError(
      `"${column}" is empty, and an invoice without it is not a record of anything.`,
      rowNumber,
      column,
    );
  }
  return value;
}

/**
 * A date-only `YYYY-MM-DD`, refused in any other spelling.
 *
 * The real export writes ISO dates throughout, and the refusal is
 * deliberate rather than a fallback chain: `07/04/2023` is the fourth of
 * July in one locale and the seventh of April in another, and a register
 * of invoice dates that guessed wrong by three months would be wrong
 * silently and forever. AGENTS.md rule 6 — a legal date is a date, never a
 * timezone round-trip — is the same rule read from the other end.
 */
function dateOnly(
  raw: string | undefined,
  column: string,
  rowNumber: number,
  required: boolean,
): string | null {
  const text = trimmed(raw);
  if (text === null) {
    if (!required) return null;
    throw new ZohoInvoiceImportError(`"${column}" is empty.`, rowNumber, column);
  }
  // The date part only: Zoho writes an acknowledgement as
  // `2023-04-07 15:22:00`, and the time of an IRP acknowledgement is not
  // something this register has any use for.
  // Fixed-width groups then a single optional tail; nothing here can
  // backtrack, so the linter's warning is about the shape rather than
  // about this expression.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(text);
  if (match === null) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(text)}; this reader only accepts YYYY-MM-DD, because guessing between day-first and month-first would be wrong silently.`,
      rowNumber,
      column,
    );
  }
  // WELL-SHAPED IS NOT THE SAME AS REAL. `2023-02-30` and `2023-13-01`
  // both satisfy the pattern above and neither is a date; PostgreSQL
  // refuses them with 22008, which arrives as a 500 in the middle of a
  // commit with nothing naming the row. Proved here instead, in the
  // preview, where the refusal carries the row number and nothing has
  // been written. The round trip through UTC is the check: a component
  // that does not survive it was never a day of that month.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ZohoInvoiceImportError(
      `"${column}" is ${JSON.stringify(text)}, which is not a date on any calendar.`,
      rowNumber,
      column,
    );
  }
  return `${match[1] ?? ''}-${match[2] ?? ''}-${match[3] ?? ''}`;
}

/* --- what a read produces -------------------------------------------------- */

export interface ZohoInvoiceLine {
  readonly position: number;
  readonly itemName: string | null;
  readonly itemDescription: string | null;
  readonly quantity: string | null;
  readonly usageUnit: string | null;
  readonly itemPrice: string | null;
  readonly itemTotal: string | null;
  readonly hsnSac: string | null;
  readonly supplyType: string | null;
  readonly cgstRate: string | null;
  readonly sgstRate: string | null;
  readonly igstRate: string | null;
  readonly cgstAmount: string | null;
  readonly sgstAmount: string | null;
  readonly igstAmount: string | null;
  /** This CSV row's every non-empty cell, keyed by the file's own header
   * spelling. */
  readonly rawRow: Readonly<Record<string, string>>;
}

export interface ZohoInvoice {
  readonly zohoInvoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  /** Zoho's own workflow flag, kept as evidence. NOT the issued signal —
   * see the header. */
  readonly zohoStatus: string | null;
  readonly customerZohoId: string | null;
  readonly customerName: string;
  readonly customerGstin: string | null;
  readonly placeOfSupply: string | null;
  /** The `PurchaseOrder` column: free text in which the LOA or PO
   * reference usually sits. */
  readonly referenceText: string | null;
  readonly subTotal: string;
  readonly total: string;
  readonly balance: string | null;
  readonly roundOff: string | null;
  readonly irn: string | null;
  readonly ackNumber: string | null;
  readonly ackDate: string | null;
  readonly qrPayload: string | null;
  /** Derived: an invoice that reached the IRP was issued. */
  readonly issued: boolean;
  readonly rawRow: Readonly<Record<string, string>>;
  readonly lines: readonly ZohoInvoiceLine[];
  /** The CSV row the invoice first appeared on, where 1 is the header.
   * Reported so a refusal points at a line an operator can open. */
  readonly rowNumber: number;
}

/* --- the read -------------------------------------------------------------- */

/**
 * Reads a Zoho Books invoice export into one record per invoice.
 *
 * Rows are grouped by `Invoice ID` and the invoice-level values are taken
 * from the FIRST row of each group. Zoho repeats them identically on every
 * line, and taking the first rather than reconciling all of them is
 * deliberate: a disagreement between two rows of one invoice would be a
 * defect in the export, and averaging or last-wins would hide it. The
 * first row's raw cells are what the header row stores.
 */
export function readZohoInvoiceCsv(text: string): ZohoInvoice[] {
  const records = parseCsv(text);
  const header = records[0];
  if (header === undefined) {
    throw new CsvParseError('That file has no rows at all.');
  }

  const byKey = new Map<string, number>();
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    // First occurrence wins, as `imports.ts` does: a duplicated header is a
    // copy-paste artefact and reading the second copy silently prefers
    // whichever column happened to sit further right.
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, index);
  });

  const missing = REQUIRED_COLUMNS.filter((column) => !byKey.has(headerKey(column)));
  if (missing.length > 0) {
    throw new CsvParseError(
      `That file is missing these columns: ${missing.join(', ')}. Export the invoice register from Zoho Books without changing the column selection.`,
    );
  }

  const cell = (row: readonly string[], column: string): string | undefined => {
    const index = byKey.get(headerKey(column));
    return index === undefined ? undefined : row[index];
  };

  // EACH ROW CARRIES ITS OWN CSV LINE NUMBER, rather than the group's
  // first plus the line's position. Zoho does not write an invoice's lines
  // contiguously — a second line of invoice 1001 can sit twenty rows below
  // the first — so `first + index` names whichever unrelated row happens
  // to be there, and a refusal that points at the wrong line is worse than
  // one that points at none.
  const groups = new Map<
    string,
    { rowNumber: number; rows: { row: string[]; rowNumber: number }[] }
  >();
  records.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    const id = trimmed(cell(row, COLUMNS.zohoInvoiceId));
    if (id === null) {
      // A wholly blank trailing row is what a spreadsheet leaves behind
      // when content is deleted without deleting the row; a row with
      // content but no invoice id is a real defect.
      if (row.every((value) => value.trim().length === 0)) return;
      throw new ZohoInvoiceImportError(
        'This row has no Invoice ID, so there is nothing to attach it to.',
        rowNumber,
        COLUMNS.zohoInvoiceId,
      );
    }
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { rowNumber, rows: [{ row, rowNumber }] });
    else group.rows.push({ row, rowNumber });
  });

  if (groups.size === 0) {
    throw new CsvParseError('That file has a header row and no invoices beneath it.');
  }

  const rawOf = (row: readonly string[]): Record<string, string> => {
    const raw: Record<string, string> = {};
    header.forEach((name, index) => {
      const value = row[index];
      if (value !== undefined && value.length > 0) raw[name] = value;
    });
    return raw;
  };

  return [...groups.entries()].map(([zohoInvoiceId, group]) => {
    const first = group.rows[0]?.row ?? [];
    const rowNumber = group.rowNumber;
    const invoiceNumber = trimmed(cell(first, COLUMNS.invoiceNumber));
    if (invoiceNumber === null) {
      throw new ZohoInvoiceImportError(
        'This invoice has no number.',
        rowNumber,
        COLUMNS.invoiceNumber,
      );
    }
    const customerName = trimmed(cell(first, COLUMNS.customerName));
    if (customerName === null) {
      throw new ZohoInvoiceImportError(
        'This invoice names no customer.',
        rowNumber,
        COLUMNS.customerName,
      );
    }
    const irn = trimmed(cell(first, COLUMNS.irn));

    return {
      zohoInvoiceId,
      invoiceNumber,
      invoiceDate: dateOnly(
        cell(first, COLUMNS.invoiceDate),
        COLUMNS.invoiceDate,
        rowNumber,
        true,
      ) as string,
      zohoStatus: trimmed(cell(first, COLUMNS.zohoStatus)),
      customerZohoId: trimmed(cell(first, COLUMNS.customerZohoId)),
      customerName,
      customerGstin: trimmed(cell(first, COLUMNS.customerGstin))?.toUpperCase() ?? null,
      placeOfSupply: trimmed(cell(first, COLUMNS.placeOfSupply)),
      referenceText: trimmed(cell(first, COLUMNS.referenceText)),
      subTotal: requiredMoney(
        cell(first, COLUMNS.subTotal),
        COLUMNS.subTotal,
        rowNumber,
      ),
      total: requiredMoney(cell(first, COLUMNS.total), COLUMNS.total, rowNumber),
      balance: exactDecimal(
        cell(first, COLUMNS.balance),
        2,
        COLUMNS.balance,
        rowNumber,
      ),
      roundOff: exactDecimal(
        cell(first, COLUMNS.roundOff),
        2,
        COLUMNS.roundOff,
        rowNumber,
      ),
      irn,
      ackNumber: trimmed(cell(first, COLUMNS.ackNumber)),
      ackDate: dateOnly(
        cell(first, COLUMNS.ackDate),
        COLUMNS.ackDate,
        rowNumber,
        false,
      ),
      qrPayload: trimmed(cell(first, COLUMNS.qrPayload)),
      issued: irn !== null,
      rawRow: rawOf(first),
      rowNumber,
      lines: group.rows.map(({ row, rowNumber: lineRowNumber }, index) => {
        return {
          position: index + 1,
          itemName: trimmed(cell(row, COLUMNS.itemName)),
          itemDescription: trimmed(cell(row, COLUMNS.itemDescription)),
          quantity: exactDecimal(
            cell(row, COLUMNS.quantity),
            3,
            COLUMNS.quantity,
            lineRowNumber,
          ),
          usageUnit: trimmed(cell(row, COLUMNS.usageUnit)),
          // SIX, not two. `Item Price` is a unit RATE and the real export
          // carries three fraction digits on real lines; reading it at
          // money scale would have rounded the third away without saying
          // so. Migration 0115 stores it as numeric(18,6) for the same
          // reason, and anything finer than six is refused rather than
          // truncated.
          itemPrice: exactDecimal(
            cell(row, COLUMNS.itemPrice),
            6,
            COLUMNS.itemPrice,
            lineRowNumber,
          ),
          itemTotal: exactDecimal(
            cell(row, COLUMNS.itemTotal),
            2,
            COLUMNS.itemTotal,
            lineRowNumber,
          ),
          hsnSac: trimmed(cell(row, COLUMNS.hsnSac)),
          supplyType: trimmed(cell(row, COLUMNS.supplyType)),
          cgstRate: rate(cell(row, COLUMNS.cgstRate), COLUMNS.cgstRate, lineRowNumber),
          sgstRate: rate(cell(row, COLUMNS.sgstRate), COLUMNS.sgstRate, lineRowNumber),
          igstRate: rate(cell(row, COLUMNS.igstRate), COLUMNS.igstRate, lineRowNumber),
          cgstAmount: exactDecimal(
            cell(row, COLUMNS.cgstAmount),
            2,
            COLUMNS.cgstAmount,
            lineRowNumber,
          ),
          sgstAmount: exactDecimal(
            cell(row, COLUMNS.sgstAmount),
            2,
            COLUMNS.sgstAmount,
            lineRowNumber,
          ),
          igstAmount: exactDecimal(
            cell(row, COLUMNS.igstAmount),
            2,
            COLUMNS.igstAmount,
            lineRowNumber,
          ),
          rawRow: rawOf(row),
        };
      }),
    };
  });
}

/* --- proposing a Work ------------------------------------------------------ */

export interface WorkCandidate {
  readonly id: string;
  readonly workCode: string;
  readonly letterNumber: string;
}

export type WorkLinkMethod = 'pl_code' | 'loa_match' | 'manual';

export interface WorkLinkProposal {
  readonly workId: string;
  readonly method: Exclude<WorkLinkMethod, 'manual'>;
  /** The text that produced the match, so the preview can show an operator
   * WHY a Work is being proposed rather than only that it is. */
  readonly evidence: string;
}

/**
 * The v1 work-code shape as it actually appears in this billing history:
 * `PL-` and two or more digits. 483 rows carry `PL-999` and 8 carry
 * `PL-99` in the real export, which is the whole population — so the
 * pattern is narrow on purpose. A looser one (`[A-Z]{2}-\d+`) would match
 * a GST rate, a phone extension and half the item descriptions.
 *
 * THE SEPARATOR IS A HYPHEN OR A SPACE, and deliberately not `\s`. The
 * haystack below is the reference text and every line's name and
 * description joined with newlines, and `\s` matches a newline: a
 * reference field ending in `PL` beside an item description beginning
 * `270` would have been read as `PL270` and filed the invoice against a
 * contract neither field named. A separator that cannot cross the join is
 * what keeps a match inside one field.
 */
const PL_CODE = /\bPL[- ]?(\d{2,})\b/gi;

/** Punctuation and case removed, so `LOA/2023/117` and `loa-2023-117`
 * compare equal. A letter number is copied by hand into a Zoho field and
 * arrives with whatever separators the typist used. */
function squeeze(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * Which Work an imported invoice is about, if the evidence says so
 * unambiguously.
 *
 * TWO ROUTES, tried in order, and both are PROPOSALS: nothing here writes
 * a link. The operator confirms the preview, which is the only reason a
 * regex is allowed near a contract record at all (AGENTS.md rule 10 — a
 * reading may propose and never commit).
 *
 * 1. The v1 work code, matched out of the reference text and the line
 *    items against `works.work_code`.
 * 2. The LOA letter number, matched out of the reference text against
 *    `works.letter_number`, compared with punctuation and case removed.
 *
 * AMBIGUITY IS NOT A MATCH. Text naming two different Works produces no
 * proposal and the invoice is reported unlinked, because a coin flip
 * between two contracts is worse than an operator's five seconds. Two
 * codes that resolve to the SAME Work are one match, not an ambiguity.
 */
export function proposeWorkLink(
  invoice: ZohoInvoice,
  candidates: readonly WorkCandidate[],
): WorkLinkProposal | null {
  const haystack = [
    invoice.referenceText ?? '',
    ...invoice.lines.flatMap((line) => [
      line.itemName ?? '',
      line.itemDescription ?? '',
    ]),
  ].join('\n');

  const byCode = new Map<string, WorkCandidate>();
  for (const candidate of candidates)
    byCode.set(squeeze(candidate.workCode), candidate);

  const codeHits = new Map<string, string>();
  for (const match of haystack.matchAll(PL_CODE)) {
    const found = byCode.get(squeeze(`PL${match[1] ?? ''}`));
    if (found !== undefined) codeHits.set(found.id, match[0]);
  }
  if (codeHits.size === 1) {
    const [workId, evidence] = [...codeHits.entries()][0] as [string, string];
    return { workId, method: 'pl_code', evidence };
  }
  if (codeHits.size > 1) return null;

  // The LOA route reads the reference text only. A letter number in an
  // item description is a description of the work, not a claim about which
  // contract the invoice bills against, and the reference field is where
  // the organisation actually records it (626 of 638 invoices carry one).
  const reference = squeeze(invoice.referenceText ?? '');
  if (reference.length === 0) return null;
  const letterHits = new Map<string, string>();
  for (const candidate of candidates) {
    const letter = squeeze(candidate.letterNumber);
    // Six characters is the floor. A letter number squeezed to fewer than
    // that is not distinctive enough to be evidence of anything, and a
    // two-character one would match nearly every reference string there
    // is.
    if (letter.length >= 6 && reference.includes(letter)) {
      letterHits.set(candidate.id, candidate.letterNumber);
    }
  }
  if (letterHits.size === 1) {
    const [workId, evidence] = [...letterHits.entries()][0] as [string, string];
    return { workId, method: 'loa_match', evidence };
  }
  return null;
}

/* --- matching the contacts master ------------------------------------------ */

export interface ContactCandidate {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
}

export type ContactMatchMethod = 'gstin' | 'name';

export interface ContactMatch {
  readonly contactId: string;
  readonly method: ContactMatchMethod;
}

/**
 * Everything the match reads. A `ZohoInvoice` satisfies it structurally,
 * so the invoice importer's own call is unchanged; it is written out so
 * the Tally ledger census (0118) can put a party ledger's name and GSTIN
 * through the SAME rule rather than growing a second implementation of
 * "GSTIN first, then exact name" that drifts from this one.
 */
export interface ContactSubject {
  readonly customerGstin: string | null;
  readonly customerName: string;
}

/**
 * The contact this invoice was billed to, by GSTIN and then by exact name.
 *
 * GSTIN FIRST because it is the identifier the tax system itself uses: two
 * spellings of one company's name are one GSTIN, and one name shared by
 * two group companies is two. The name fallback is EXACT (case- and
 * whitespace-insensitive only) rather than fuzzy — a near-match on a
 * customer name is how an invoice ends up filed against the wrong party,
 * and an unmatched invoice is a visible, fixable state where a wrong match
 * is neither.
 *
 * No match leaves the link null and the invoice is reported as unmatched.
 * The register is complete either way: the customer's name and GSTIN are
 * stored on the row itself, so a missing contact costs a join, not a fact.
 */
export function matchContact(
  invoice: ContactSubject,
  candidates: readonly ContactCandidate[],
): ContactMatch | null {
  if (invoice.customerGstin !== null) {
    const gstin = invoice.customerGstin.toUpperCase();
    const hits = candidates.filter(
      (candidate) => (candidate.gstin ?? '').toUpperCase() === gstin,
    );
    if (hits.length === 1)
      return { contactId: (hits[0] as ContactCandidate).id, method: 'gstin' };
    if (hits.length > 1) return null;
  }
  const name = invoice.customerName.toLowerCase().replace(/\s+/g, ' ').trim();
  const hits = candidates.filter(
    (candidate) => candidate.name.toLowerCase().replace(/\s+/g, ' ').trim() === name,
  );
  return hits.length === 1
    ? { contactId: (hits[0] as ContactCandidate).id, method: 'name' }
    : null;
}
