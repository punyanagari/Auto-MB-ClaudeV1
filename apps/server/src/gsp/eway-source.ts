import type { TransactionSql } from '@auto-mb/db';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import {
  parseTaxInvoiceIssuedSnapshot,
  snapshotLines,
  TaxInvoiceSnapshotError,
} from '../tax-invoice-snapshot.js';

/**
 * The one place the e-way bill applicability rule lives (ADR-0013).
 *
 * The 2026-08-10 disposition ruled that a contractor-to-Railways invoice
 * carries a SAC service line and needs no e-way bill, and NIC confirmed it
 * empirically during sandbox certification — generation by IRN refused
 * with error 4009, "E Way Bill can be generated provided at least HSN of
 * one item belongs to goods". The wave-4 ruling does not overturn that
 * reasoning; it narrows its reach. Auto-MB now also serves movements
 * outside the railway-contract scope, and those movements carry goods.
 *
 * So the refusal stops being a property of the document KIND and becomes a
 * property of its LINES: an e-way bill can be raised when the source
 * document carries at least one goods (HSN) line. A service-only document
 * keeps the refusal it already had, with the same error code. The rule is
 * the same for railway and private documents; there is no
 * per-customer-type switch, and there is no second copy of this test
 * anywhere else in the server.
 *
 * Both source kinds resolve to ONE shape below, so the payload builder,
 * the printable summary and the routes read a single thing regardless of
 * which document the consignment travels under.
 */

/** A line of the source document as the e-way bill needs it: what moved,
 * how much of it, and what it was worth. */
export interface EwaySourceLine {
  readonly position: number;
  readonly isService: boolean;
  readonly hsnSacCode: string;
  readonly description: string;
  /** Exact decimal text throughout; money never round-trips a float. */
  readonly quantity: string;
  readonly unitLabel: string | null;
  readonly taxableValue: string;
}

/** A party block, as either source document froze it. */
export interface EwaySourceParty {
  readonly name: string;
  readonly gstin: string | null;
  readonly address: string;
  readonly stateCode: string | null;
  readonly pincode: string | null;
}

export interface EwayBillSourceFacts {
  readonly kind: 'tax_invoice' | 'delivery_challan';
  readonly id: string;
  /** The source document's own number and date — what goes on the wire as
   * the document reference NIC prints on the e-way bill. */
  readonly documentNumber: string;
  readonly documentDate: string;
  readonly supplier: EwaySourceParty;
  readonly consignee: EwaySourceParty;
  readonly lines: readonly EwaySourceLine[];
  /** Why the goods move, in NIC's vocabulary. An invoice-sourced movement
   * is a supply by definition; a challan states its own reason. */
  readonly movementReason: 'supply' | 'job_work' | 'for_own_use' | 'others';
  /** The IRN, on the invoice path only: generation by IRN is that path's
   * shape and the challan path has no IRN to offer. */
  readonly irn: string | null;
  // No transport block here: the e-way bill ROW (EwayCarriage) is the sole
  // authority for what goes on the NIC wire, exactly as 0075 states — the
  // challan's own transport columns are the recorded fact of the movement
  // and are displayed on the challan detail, but the payload never reads
  // them. A prefill projection was resolved here and consumed by nothing,
  // so it is not carried: two records of one movement, neither reading the
  // other at write time (0075).
}

/** Does this document move goods at all?
 *
 * The whole applicability question, in one expression. A v1 (cumulative
 * SAC) invoice snapshot normalises through `snapshotLines` into a single
 * service line, so it answers false without needing a special case. */
export function carriesGoods(
  lines: readonly { readonly isService: boolean }[],
): boolean {
  return lines.some((line) => !line.isService);
}

/** The refusal a service-only document gets, with the code it has always
 * had. `EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE` predates ADR-0013 and
 * is deliberately kept: the refusal it names is unchanged, only its reach
 * narrowed, and a client switching on it should not have to learn a new
 * string to keep working. */
export function assertCarriesGoods(source: EwayBillSourceFacts): void {
  if (carriesGoods(source.lines)) return;
  throw httpError(
    409,
    'EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE',
    source.kind === 'tax_invoice'
      ? 'Every line of this tax invoice is a SAC service line. An e-way bill moves goods, so NIC refuses one for a service-only document.'
      : 'No line of this delivery challan is classified as goods. An e-way bill moves goods, so NIC refuses one for a service-only document.',
  );
}

/** One challan line's statutory classification, as either the panel read
 * (readDetail's items) or the route read (delivery_challan_items) holds it. */
export interface ChallanClassificationLine {
  readonly isService: boolean | null;
  readonly hsnSacCode: string | null;
}

/** Whether an issued standalone challan may raise an e-way bill, as a pure
 * predicate over the two facts the route gates on: the movement reason and
 * the classified lines. `readDetail` offers the Raise action exactly when
 * this is true, so the panel can never offer it where the route would
 * refuse. The route enforces the same three conditions through
 * `assertChallanStatutoryFactsComplete` (movement reason present AND no
 * unclassified/half-classified line) and `assertCarriesGoods` (at least one
 * goods line), which together accept exactly this predicate — both read
 * this shape so the panel and the route cannot drift. Kind and status are
 * the caller's to check; this is the per-line completeness the panel used
 * to omit. */
export function challanEwayEligible(
  movementReason: string | null,
  lines: readonly ChallanClassificationLine[],
): boolean {
  return (
    isMovementReason(movementReason) &&
    lines.every((line) => line.hsnSacCode !== null && line.isService !== null) &&
    lines.some((line) => line.isService === false)
  );
}

interface InvoiceRow {
  readonly status: string;
  readonly invoice_number: string | null;
  readonly invoice_date: string;
  readonly irn: string | null;
  readonly issued_snapshot: unknown;
}

/** The invoice path's facts, read from the FROZEN issue-time snapshot.
 *
 * Rule 7: the snapshot is what the document says, and master data behind
 * it may have moved since. The live columns are read only for the two
 * facts the snapshot does not hold — the status the guard tests, and the
 * IRN the generation call needs. */
export async function readInvoiceSourceFacts(
  tx: TransactionSql,
  taxInvoiceId: string,
): Promise<EwayBillSourceFacts> {
  const [invoice] = (await tx.unsafe(
    `select status, invoice_number, invoice_date::text as invoice_date, irn,
            issued_snapshot
       from tax_invoices where id = $1`,
    [taxInvoiceId],
  )) as unknown as InvoiceRow[];
  if (!invoice) throw httpError(404, 'TAX_INVOICE_NOT_FOUND', 'No such tax invoice.');

  let snapshot: ReturnType<typeof parseTaxInvoiceIssuedSnapshot>;
  try {
    snapshot = parseTaxInvoiceIssuedSnapshot(parseJsonbColumn(invoice.issued_snapshot));
  } catch (error) {
    if (error instanceof TaxInvoiceSnapshotError) {
      throw httpError(409, error.code, error.message);
    }
    throw error;
  }

  return {
    kind: 'tax_invoice',
    id: taxInvoiceId,
    documentNumber: snapshot.invoiceNumber,
    documentDate: snapshot.invoiceDate,
    supplier: {
      name: snapshot.supplier.tradeName ?? snapshot.supplier.name,
      gstin: snapshot.supplier.gstin,
      address: snapshot.supplier.address,
      stateCode: snapshot.supplier.stateCode,
      pincode: snapshot.supplier.pincode,
    },
    consignee: {
      name: (snapshot.shipTo ?? snapshot.buyer).designation,
      gstin: (snapshot.shipTo ?? snapshot.buyer).gstin,
      address: (snapshot.shipTo ?? snapshot.buyer).address,
      stateCode: (snapshot.shipTo ?? snapshot.buyer).stateCode,
      pincode: (snapshot.shipTo ?? snapshot.buyer).pincode,
    },
    lines: snapshotLines(snapshot).map((line) => ({
      position: line.position,
      isService: line.isService,
      hsnSacCode: line.hsnSacCode,
      description: line.description,
      quantity: line.quantity,
      unitLabel: line.unitLabel,
      taxableValue: line.amount,
    })),
    // An invoice is a supply. The other three NIC reasons describe
    // movements that have no invoice behind them, which is exactly the
    // case the challan path exists for.
    movementReason: 'supply',
    irn: invoice.irn,
  };
}

interface ChallanRow {
  readonly status: string;
  readonly challan_kind: string;
  readonly challan_number: string | null;
  readonly challan_date: string;
  readonly consignee_snapshot: unknown;
  readonly consignee_gstin: string | null;
  readonly movement_reason: string | null;
  readonly organisation_name: string;
  readonly trade_name: string | null;
  readonly organisation_gstin: string | null;
  readonly organisation_address: string | null;
  readonly organisation_state_code: string | null;
  readonly organisation_pincode: string | null;
  readonly contact_state_code: string | null;
  readonly contact_pincode: string | null;
}

interface ChallanLineRow {
  readonly position: number;
  readonly is_service: boolean | null;
  readonly hsn_sac_code: string | null;
  readonly description_snapshot: string;
  readonly unit_snapshot: string;
  readonly quantity: string;
  readonly line_amount: string;
}

/** The challan path's facts.
 *
 * The consignor is the organisation itself: a delivery challan has no
 * supplier snapshot because, unlike an invoice, it never needed one — the
 * document is the organisation's own paper. The consignee block comes from
 * the challan's frozen `consignee_snapshot` and the GSTIN 0075 froze
 * beside it. */
export async function readChallanSourceFacts(
  tx: TransactionSql,
  challanId: string,
): Promise<EwayBillSourceFacts> {
  const [challan] = (await tx.unsafe(
    `select dc.status, dc.challan_kind, dc.challan_number,
            dc.challan_date::text as challan_date, dc.consignee_snapshot,
            dc.consignee_gstin, dc.movement_reason,
            org.name as organisation_name, org.trade_name,
            org.gstin as organisation_gstin, org.address as organisation_address,
            org.state_code as organisation_state_code,
            org.pincode as organisation_pincode,
            party.state_code as contact_state_code,
            party.pincode as contact_pincode
       from delivery_challans dc
       join organisations org on org.id = dc.organisation_id
       left join contacts party
         on party.organisation_id = dc.organisation_id
        and party.id = dc.consignee_contact_id
      where dc.id = $1`,
    [challanId],
  )) as unknown as ChallanRow[];
  if (!challan) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such delivery challan.');

  const lines = (await tx.unsafe(
    `select position, is_service, hsn_sac_code, description_snapshot,
            unit_snapshot, quantity::text as quantity,
            line_amount::text as line_amount
       from delivery_challan_items
      where delivery_challan_id = $1
      order by position`,
    [challanId],
  )) as unknown as ChallanLineRow[];

  const consignee = parseJsonbColumn(challan.consignee_snapshot) as {
    name?: unknown;
    address?: unknown;
  };

  return {
    kind: 'delivery_challan',
    id: challanId,
    documentNumber: challan.challan_number ?? '',
    documentDate: challan.challan_date,
    supplier: {
      name: challan.trade_name ?? challan.organisation_name,
      gstin: challan.organisation_gstin,
      address: challan.organisation_address ?? '',
      stateCode: challan.organisation_state_code,
      pincode: challan.organisation_pincode,
    },
    consignee: {
      name: typeof consignee.name === 'string' ? consignee.name : '',
      gstin: challan.consignee_gstin,
      address: typeof consignee.address === 'string' ? consignee.address : '',
      // A GSTIN's first two digits ARE the state code, by construction,
      // so the frozen GSTIN answers this without reading master data back
      // through history (rule 7). Only an unregistered consignee, which
      // has no GSTIN to read, falls back to the contact master — there is
      // nothing frozen to prefer, and the alternative is declaring no
      // state at all.
      stateCode: challan.consignee_gstin?.slice(0, 2) ?? challan.contact_state_code,
      pincode: challan.contact_pincode,
    },
    lines: lines
      // A line with no statutory classification is not a line the e-way
      // bill can describe. It is dropped here rather than guessed at, and
      // the completeness check below is what refuses the document.
      .filter(
        (
          line,
        ): line is ChallanLineRow & { hsn_sac_code: string; is_service: boolean } =>
          line.hsn_sac_code !== null && line.is_service !== null,
      )
      .map((line) => ({
        position: line.position,
        isService: line.is_service,
        hsnSacCode: line.hsn_sac_code,
        description: line.description_snapshot,
        quantity: line.quantity,
        unitLabel: line.unit_snapshot,
        taxableValue: line.line_amount,
      })),
    movementReason: isMovementReason(challan.movement_reason)
      ? challan.movement_reason
      : 'supply',
    irn: null,
  };
}

function isMovementReason(
  value: string | null,
): value is 'supply' | 'job_work' | 'for_own_use' | 'others' {
  return (
    value === 'supply' ||
    value === 'job_work' ||
    value === 'for_own_use' ||
    value === 'others'
  );
}

/** What a challan must carry before it may raise an e-way bill.
 *
 * The facts are optional on the table (migration 0075) because a challan
 * is a valid movement document without them. They are mandatory HERE,
 * on the one transition that turns them into a statutory declaration, and
 * the refusal names every missing fact at once rather than making the
 * operator discover them one save at a time. */
export async function assertChallanStatutoryFactsComplete(
  tx: TransactionSql,
  challanId: string,
): Promise<void> {
  const [challan] = (await tx.unsafe(
    `select movement_reason,
            (select count(*) from delivery_challan_items line
              where line.delivery_challan_id = dc.id
                and (line.hsn_sac_code is null or line.is_service is null)
            )::int as unclassified_lines
       from delivery_challans dc where dc.id = $1`,
    [challanId],
  )) as unknown as {
    movement_reason: string | null;
    unclassified_lines: number;
  }[];
  if (!challan) throw httpError(404, 'CHALLAN_NOT_FOUND', 'No such delivery challan.');

  const missing: string[] = [];
  if (challan.movement_reason === null) missing.push('the reason for the movement');
  if (challan.unclassified_lines > 0) {
    missing.push(
      `an HSN/SAC code and a goods or service marker on every line (${String(challan.unclassified_lines)} still unclassified)`,
    );
  }
  if (missing.length === 0) return;
  throw httpError(
    409,
    'CHALLAN_STATUTORY_FACTS_REQUIRED',
    `This delivery challan is missing ${missing.join(' and ')}. An e-way bill declares those facts to NIC, so they have to be on the challan before one can be raised.`,
  );
}
