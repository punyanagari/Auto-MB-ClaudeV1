/**
 * Tally vouchers, in Tally's own XML import envelope.
 *
 * ## What this is, and what it deliberately is not
 *
 * The owner's accounting strategy is EXPORT, not replacement: the agency's
 * accountant keeps working in Tally, and this product stops being the place
 * they have to re-type a hundred invoices from. `docs/PRODUCT.md` records
 * Tally reconciliation as deliberately not built because it is an INGESTION
 * problem; this is the other direction, which is not, and the distinction is
 * the whole reason this file is short. Nothing here reads a Tally file,
 * reconciles against one, or holds any accounting state. It renders records
 * this product already owns into the shape Tally's `Import Data` accepts.
 *
 * ## Every figure comes from a snapshot. Nothing is recomputed.
 *
 * This is the rule the whole file is built around and it is not a style
 * preference. A tax invoice's taxable value, its CGST/SGST/IGST split, its
 * total, its number, its date and its buyer are all FROZEN columns on
 * `tax_invoices` — migration 0035's `tax_invoices_draft_shape` constraint
 * refuses a submitted invoice that is missing any of them, and the
 * split-coherence constraint beside it refuses one whose intra/inter-state
 * arms disagree. Those are the figures on the paper the buyer holds and the
 * figures reported to the IRP. Re-deriving any of them here — from the
 * Work's rate, from the current GST master, from the place of supply —
 * would mean a voucher that disagrees with the invoice it claims to be,
 * and it would disagree silently and only for old documents, which is the
 * worst shape a money bug can take. Every builder below therefore takes a
 * row of frozen columns and does arithmetic on none of them.
 *
 * The same holds for credit notes (0051's full-value columns, proven equal
 * to the superseded invoice by `guard_credit_note_full_value`) and for
 * payment receipts (0067's recorded credit amount).
 *
 * ## The shape
 *
 * Tally's import envelope is fixed and old, and its tag names are its own:
 *
 *   ENVELOPE / HEADER / TALLYREQUEST=Import
 *   ENVELOPE / BODY / IMPORTDATA / REQUESTDESC / REPORTNAME=Vouchers
 *   ENVELOPE / BODY / IMPORTDATA / REQUESTDATA / TALLYMESSAGE* / VOUCHER
 *
 * Each VOUCHER carries a DATE (`YYYYMMDD`, no separators), a
 * VOUCHERTYPENAME, a VOUCHERNUMBER, the party's name, and a list of
 * `ALLLEDGERENTRIES.LIST` legs whose AMOUNTs must sum to zero — Tally is
 * double-entry and refuses a voucher that is not balanced. The sign
 * convention is Tally's, not accountancy's plain one: a DEBIT is NEGATIVE
 * and a CREDIT is POSITIVE in the XML, which is the single most common way
 * a hand-written Tally import fails.
 *
 * Balance is achieved by CONSTRUCTION rather than by addition: the party
 * leg carries the invoice's own `total_amount` on one side, and the income
 * and tax legs carry the taxable value and each tax amount on the other.
 * Those four frozen columns already satisfy `taxable + cgst + sgst + igst =
 * total` — 0052's money backstops enforce it in the database — so the
 * voucher balances because the invoice does, and this file never adds two
 * money strings together to find out.
 *
 * ## Ledger names
 *
 * A voucher names ledgers by STRING, and the strings have to be the ones
 * that exist in the accountant's own Tally company or the import is
 * rejected. There is no way to discover them from here and no configuration
 * surface for them in this pack, so the names below are the Indian
 * statutory defaults every Tally company has (`Output CGST`, `Sales`,
 * `Bank`), and the party ledger is the buyer's own name exactly as it was
 * snapshotted on the invoice.
 *
 * ponytail: fixed ledger names, no per-organisation mapping table. The
 * accountant renames on import or a mapping screen is added when a second
 * customer's chart of accounts actually differs — one table and one
 * settings card, no change to this file's shape.
 */

/** Tally's own date format: `YYYYMMDD`, no separators. The input is a
 * date-only `YYYY-MM-DD` legal value, so this is a string edit and never a
 * `Date` — `AGENTS.md` rule 6 forbids the round trip that would introduce. */
function tallyDate(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

/** XML text escaping. Tally's parser is strict about `&` and the angle
 * brackets and indifferent to the rest; quotes are escaped anyway because
 * nothing here writes an attribute and a future one should not have to
 * remember. */
function escapeXml(value: string): string {
  let text = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (character === '&') text += '&amp;';
    else if (character === '<') text += '&lt;';
    else if (character === '>') text += '&gt;';
    else if (character === '"') text += '&quot;';
    else if (character === "'") text += '&apos;';
    else text += character;
  }
  return text;
}

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

/**
 * One ledger leg. `amount` is the decimal string as it stands in the
 * database, with the Tally sign already applied by the caller: negative for
 * a debit, positive for a credit.
 */
interface LedgerEntry {
  readonly ledger: string;
  readonly amount: string;
  readonly isDeemedPositive: boolean;
}

/**
 * Flips a decimal string's SIGN without doing arithmetic on it.
 *
 * A negative value comes back positive, a positive one comes back
 * negative, and a zero of any spelling (`0`, `0.00`) stays as it is — so a
 * zero leg never reads as `-0.00`, which Tally accepts and an accountant
 * reads twice. String editing, not maths: the digits that reach the
 * voucher are the digits the database stored.
 */
function isZero(amount: string): boolean {
  return !/[1-9]/.test(amount);
}

function negated(amount: string): string {
  if (amount.startsWith('-')) return amount.slice(1);
  if (isZero(amount)) return amount;
  return `-${amount}`;
}

function ledgerXml(entry: LedgerEntry): string {
  return [
    '<ALLLEDGERENTRIES.LIST>',
    tag('LEDGERNAME', entry.ledger),
    tag('ISDEEMEDPOSITIVE', entry.isDeemedPositive ? 'Yes' : 'No'),
    tag('AMOUNT', entry.amount),
    '</ALLLEDGERENTRIES.LIST>',
  ].join('');
}

interface Voucher {
  readonly date: string;
  readonly voucherType: string;
  readonly voucherNumber: string;
  readonly partyLedger: string;
  readonly narration: string;
  readonly entries: readonly LedgerEntry[];
}

function voucherXml(voucher: Voucher): string {
  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<VOUCHER VCHTYPE="${escapeXml(voucher.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    tag('DATE', tallyDate(voucher.date)),
    tag('EFFECTIVEDATE', tallyDate(voucher.date)),
    tag('VOUCHERTYPENAME', voucher.voucherType),
    tag('VOUCHERNUMBER', voucher.voucherNumber),
    tag('PARTYLEDGERNAME', voucher.partyLedger),
    tag('NARRATION', voucher.narration),
    tag('PERSISTEDVIEW', 'Accounting Voucher View'),
    ...voucher.entries.map(ledgerXml),
    '</VOUCHER>',
    '</TALLYMESSAGE>',
  ].join('');
}

/** The tax legs an invoice or credit note carries, skipping the arm that is
 * zero. 0035's split-coherence constraint guarantees exactly one arm is
 * non-zero on a submitted document, so this emits either CGST+SGST or IGST
 * and never both. */
function taxLegs(
  document: { readonly cgst: string; readonly sgst: string; readonly igst: string },
  prefix: 'Output' | 'Input',
  credit: boolean,
): LedgerEntry[] {
  const legs: LedgerEntry[] = [];
  const push = (name: string, amount: string): void => {
    if (isZero(amount)) return;
    legs.push({
      ledger: `${prefix} ${name}`,
      amount: credit ? amount : negated(amount),
      isDeemedPositive: !credit,
    });
  };
  push('CGST', document.cgst);
  push('SGST', document.sgst);
  push('IGST', document.igst);
  return legs;
}

/** A submitted tax invoice, straight off `tax_invoices`' frozen columns. */
export interface TallyInvoice {
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly buyerName: string;
  readonly buyerGstin: string | null;
  readonly taxableValue: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly total: string;
  readonly serviceDescription: string;
}

/** An issued credit note, off `credit_notes`' full-value columns. */
export interface TallyCreditNote {
  readonly noteNumber: string;
  readonly noteDate: string;
  readonly buyerName: string;
  readonly taxableValue: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly total: string;
  readonly reason: string;
}

/** A recorded receipt against a railway bill, off `bill_payments`. */
export interface TallyReceipt {
  readonly reference: string;
  readonly receivedOn: string;
  readonly payerName: string;
  readonly amount: string;
  readonly narration: string;
}

/**
 * A sales voucher.
 *
 * Party debited by the invoice total (negative, Tally's debit sign), sales
 * income credited by the taxable value, each applicable output tax ledger
 * credited by its own frozen amount. The legs balance because the frozen
 * columns do.
 */
function invoiceVoucher(invoice: TallyInvoice): Voucher {
  return {
    date: invoice.invoiceDate,
    voucherType: 'Sales',
    voucherNumber: invoice.invoiceNumber,
    partyLedger: invoice.buyerName,
    narration:
      invoice.buyerGstin === null
        ? invoice.serviceDescription
        : `${invoice.serviceDescription} (GSTIN ${invoice.buyerGstin})`,
    entries: [
      {
        ledger: invoice.buyerName,
        amount: negated(invoice.total),
        isDeemedPositive: true,
      },
      { ledger: 'Sales', amount: invoice.taxableValue, isDeemedPositive: false },
      ...taxLegs(invoice, 'Output', true),
    ],
  };
}

/** A credit-note voucher: the sales voucher's legs, reversed. */
function creditNoteVoucher(note: TallyCreditNote): Voucher {
  return {
    date: note.noteDate,
    voucherType: 'Credit Note',
    voucherNumber: note.noteNumber,
    partyLedger: note.buyerName,
    narration: note.reason,
    entries: [
      { ledger: note.buyerName, amount: note.total, isDeemedPositive: false },
      {
        ledger: 'Sales',
        amount: negated(note.taxableValue),
        isDeemedPositive: true,
      },
      ...taxLegs(note, 'Output', false),
    ],
  };
}

/** A receipt voucher: bank debited, party credited. */
function receiptVoucher(receipt: TallyReceipt): Voucher {
  return {
    date: receipt.receivedOn,
    voucherType: 'Receipt',
    voucherNumber: receipt.reference,
    partyLedger: receipt.payerName,
    narration: receipt.narration,
    entries: [
      { ledger: 'Bank', amount: negated(receipt.amount), isDeemedPositive: true },
      { ledger: receipt.payerName, amount: receipt.amount, isDeemedPositive: false },
    ],
  };
}

export interface TallyExport {
  readonly invoices: readonly TallyInvoice[];
  readonly creditNotes: readonly TallyCreditNote[];
  readonly receipts: readonly TallyReceipt[];
}

/**
 * The whole import envelope, as a string.
 *
 * Built in one pass and returned whole rather than streamed: the export is
 * bounded by a financial-year window and a register's own page limit, and a
 * Tally import is a file an accountant saves and feeds to a desktop
 * application, not a stream anything consumes incrementally.
 *
 * Vouchers appear invoices, then credit notes, then receipts — the order a
 * ledger is built in, so an import that stops partway has not credited a
 * payment against an invoice that does not exist yet.
 */
export function buildTallyXml(data: TallyExport): string {
  const vouchers = [
    ...data.invoices.map(invoiceVoucher),
    ...data.creditNotes.map(creditNoteVoucher),
    ...data.receipts.map(receiptVoucher),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER>',
    tag('TALLYREQUEST', 'Import Data'),
    '</HEADER>',
    '<BODY>',
    '<IMPORTDATA>',
    '<REQUESTDESC>',
    tag('REPORTNAME', 'Vouchers'),
    '<STATICVARIABLES>',
    tag('SVCURRENTCOMPANY', ''),
    '</STATICVARIABLES>',
    '</REQUESTDESC>',
    '<REQUESTDATA>',
    ...vouchers.map(voucherXml),
    '</REQUESTDATA>',
    '</IMPORTDATA>',
    '</BODY>',
    '</ENVELOPE>',
  ].join('\n');
}

/**
 * ONE-WAY. Nothing in this product reads a Tally file, reconciles against
 * one, or learns that a voucher was imported — the header above says so and
 * the operator is told the same thing on the Reports screen, because an
 * export that looks like an integration invites somebody to expect their
 * Tally edits to come back.
 */
/** The media type a Tally import file answers with. */
export const TALLY_CONTENT_TYPE = 'application/xml; charset=utf-8';
