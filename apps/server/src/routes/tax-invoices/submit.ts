import { TaxInvoiceDetailResponseSchema, type GstBasis } from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { toTaxableBasis, type WorkGstBasis } from '../../executed-value.js';
import { jsonb } from '@auto-mb/db';
import { amountInWords } from '../../amount-in-words.js';
import type { Auth } from '../../auth.js';
import { assertGstRateNotified } from '../../gst-rates.js';
import { httpError } from '../../http.js';
import {
  NumberTemplateError,
  loadNumberTemplate,
  renderNumberTemplate,
} from '../../number-series.js';
import {
  audit,
  IdParamsSchema,
  upstreamErrorResponses as errorResponses,
} from '../shared.js';
import type { AppInstance } from '../../app-instance.js';
import { createTenantRouteRegistrar } from '../../tenant-route.js';
import {
  assertInvoiceDateNotFuture,
  assertInvoiceWorkAccess,
  DEFAULT_UNIT_LABEL,
  financialYearLabel,
  lockInvoice,
  lockInvoiceableBook,
  readDetail,
  readInvoiceLines,
  requireBuyer,
  requireShipTo,
  requireStatus,
  TAX_INVOICE_ITEMISED_TEMPLATE_VERSION,
  TAX_INVOICE_TEMPLATE_VERSION,
} from './internal.js';
import type {
  BuyerRow,
  InvoiceableBook,
  InvoiceLineRow,
  InvoiceRow,
} from './internal.js';

/**
 * Submitting is the money moment, and it is one transaction with five
 * phases: the supplier and buyer profiles must be complete, the taxable
 * value is resolved from the Measurement Book or the direct draft, the
 * number is assigned under the counter row lock, the tax is split in SQL
 * numeric, and the document is frozen. Each phase is a named function
 * below and the route is their sequence — the order and every refusal
 * are exactly what they were when this was one 420-line handler.
 */

/** The supplier profile as the frozen invoice will state it. Refused
 * here, not at draft time — the profile may well be completed between
 * drafting and the money moment. */
interface SupplierProfile {
  name: string;
  state_code: string;
  gstin: string;
  address: string;
  pincode: string;
  locality: string;
  trade_name: string | null;
  msme_number: string | null;
  contact_phone: string | null;
  invoice_number_prefix: string | null;
  invoice_notes: string | null;
  einvoice_applicability: 'undeclared' | 'not_applicable' | 'applicable';
  einvoice_applicable_from: string | null;
  irp_reporting_window_days: number | null;
}

/** Phase 1a: reverse charge must be answered, and answered 'no' — the
 * reverse-charge invoice is not implemented and must not be guessed. */
function assertReverseChargeAnswered(invoice: InvoiceRow): void {
  if (invoice.reverse_charge_applicable === null) {
    throw httpError(
      400,
      'REVERSE_CHARGE_CONFIRMATION_REQUIRED',
      'Confirm whether tax is payable under reverse charge before submitting this invoice.',
    );
  }
  if (invoice.reverse_charge_applicable) {
    throw httpError(
      409,
      'REVERSE_CHARGE_UNSUPPORTED',
      'Reverse-charge tax invoices are not implemented. Keep this invoice as a draft and issue it outside Auto-MB.',
    );
  }
}

/** Phase 1b: the split is decided by the organisation's state against
 * the place of supply; without a state it is undecidable, and the IRP
 * payload cannot name a seller without a GSTIN. */
async function requireCompleteSupplierProfile(
  tx: TransactionSql,
): Promise<SupplierProfile> {
  const [organisation] = await tx<
    {
      name: string;
      state_code: string | null;
      gstin: string | null;
      address: string | null;
      pincode: string | null;
      locality: string | null;
      trade_name: string | null;
      msme_number: string | null;
      contact_phone: string | null;
      invoice_number_prefix: string | null;
      invoice_notes: string | null;
      einvoice_applicability: 'undeclared' | 'not_applicable' | 'applicable';
      einvoice_applicable_from: string | null;
      irp_reporting_window_days: number | null;
    }[]
  >`
    select name, state_code, gstin, address, pincode, locality, trade_name,
           msme_number, contact_phone, invoice_number_prefix,
           invoice_notes, einvoice_applicability,
           einvoice_applicable_from::text as einvoice_applicable_from,
           irp_reporting_window_days
    from organisations
    where id = app_private.current_organisation_id()
  `;
  if (!organisation?.state_code) {
    throw httpError(
      400,
      'ORG_STATE_REQUIRED',
      'The organisation profile has no GST state code, so the CGST+SGST/IGST split is undecidable — set it and retry.',
    );
  }
  if (!organisation.gstin) {
    throw httpError(
      400,
      'ORG_GSTIN_REQUIRED',
      'The organisation profile has no GSTIN — the e-invoice names the seller by it. Set it and retry.',
    );
  }

  if (!organisation.address) {
    throw httpError(
      400,
      'ORG_ADDRESS_REQUIRED',
      'The organisation profile has no address; the immutable invoice and IRP payload need it. Set it and retry.',
    );
  }
  if (!organisation.pincode) {
    throw httpError(
      400,
      'ORG_PINCODE_REQUIRED',
      'The organisation profile has no PIN code; the immutable invoice and IRP payload need it. Set it and retry.',
    );
  }
  if (!organisation.locality) {
    throw httpError(
      400,
      'ORG_LOCALITY_REQUIRED',
      'The organisation profile has no explicit locality for the NIC seller block. Set it before issuing this IRP-ready invoice.',
    );
  }
  return {
    ...organisation,
    state_code: organisation.state_code,
    gstin: organisation.gstin,
    address: organisation.address,
    pincode: organisation.pincode,
    locality: organisation.locality,
  };
}

/** Phase 2: the draft's buyer is ordinary relational state since 0041;
 * the audit trail is evidence, never the operational store. */
async function requireCompleteBuyer(
  tx: TransactionSql,
  invoice: InvoiceRow,
): Promise<BuyerRow> {
  const buyer = await requireBuyer(tx, invoice.buyer_contact_id);
  const missing = [
    ...(buyer.address === null ? ['address'] : []),
    ...(buyer.state_code === null ? ['stateCode'] : []),
    ...(buyer.pincode === null ? ['pincode'] : []),
    ...(buyer.gstin !== null && buyer.locality === null ? ['locality'] : []),
  ];
  if (missing.length > 0) {
    throw httpError(
      400,
      'BUYER_PROFILE_INCOMPLETE',
      `The buyer contact is missing ${missing.join(', ')} — the invoice snapshot and the e-invoice payload need them. Complete the contact and retry.`,
    );
  }
  return buyer;
}

/**
 * Phase 3: a DIRECT invoice — one raised against a private customer —
 * names no Measurement Book, so there is nothing to lock and the taxable
 * value is the one stated on the draft. An MB-backed invoice locks its
 * book (serialising against a cancel the trigger would refuse anyway) and
 * derives its taxable value from the MB total ON THE WORK'S RECORDED GST
 * BASIS. The 0039 CHECK guarantees exactly one of the two is present, so
 * this is a real either/or, not a fallback.
 *
 * THE BASIS (owner ruling 2, 13 August 2026;
 * docs/FINDING-2026-08-13-invoice-money-basis.md). An MB total is
 * quantity x the Work's accepted rate, so it is stated on whatever basis
 * that rate is quoted on. When the LOA is GST-INCLUSIVE — which it usually
 * is — the MB total already contains the tax, and taking it as the taxable
 * value and adding GST charged the tax twice: an invoice 18% above the
 * railway's own bill, sent to a government buyer who reconciles the two.
 *
 * The corpus settles what it should be. PL-270's bill states 24,516,112
 * "Including Tax (GST)" and adds no tax to its own schedule total; the
 * invoice raised against it states a taxable value of 20,776,366.10 and a
 * GRAND total of 24,516,112 — the bill, exactly. So the taxable value is
 * the measured total less the tax already in it, and the invoice total
 * comes back to the bill.
 *
 * A GST-EXCLUSIVE Work needs no conversion and gets none: `toTaxableBasis`
 * is identity there, and the figure passes through as it always did.
 */
async function resolveTaxableValue(
  tx: TransactionSql,
  invoice: InvoiceRow,
): Promise<{ book: InvoiceableBook | null; taxableValue: string }> {
  const book =
    invoice.measurement_book_id === null || invoice.work_id === null
      ? null
      : await lockInvoiceableBook(tx, invoice.work_id, invoice.measurement_book_id);
  if (book !== null && book.total_amount === null) {
    throw new Error(`finalized Measurement Book ${book.id} has no total`);
  }
  if (book === null) {
    // Direct invoice: the drafted figure is already a taxable value.
    if (invoice.stated_taxable_value === null) {
      throw new Error(
        `tax invoice ${invoice.id} has neither an MB total nor a stated value`,
      );
    }
    return { book, taxableValue: invoice.stated_taxable_value };
  }
  const gst = await readWorkGstBasis(tx, invoice.work_id ?? '');
  return {
    book,
    taxableValue: toTaxableBasis(book.total_amount ?? '0', gst.basis, gst),
  };
}

/** The Work's recorded GST basis (migration 0062). Read inside the submit
 * transaction rather than carried on the draft: the basis belongs to the
 * contract, not to a document raised against it, and a draft written
 * before the basis was corrected must not bill on the stale one. */
async function readWorkGstBasis(
  tx: TransactionSql,
  workId: string,
): Promise<WorkGstBasis> {
  const [row] = await tx<{ gst_basis: GstBasis; gst_rate: string }[]>`
    select gst_basis, gst_rate::text as gst_rate
    from works where id = ${workId}
  `;
  if (!row) {
    // An MB-backed invoice always has a Work; a missing one is a broken
    // invariant, not a case to default through. Defaulting here would
    // silently pick a basis and bill on it.
    throw new Error(`tax invoice work ${workId} not found for GST basis`);
  }
  return { basis: row.gst_basis, ratePercent: row.gst_rate };
}

/**
 * Phase 3b, ITEMISED only: the lines are the document, so they are what
 * the money is computed from — but an MB-backed invoice still BILLS its
 * Measurement Book, and a set of lines that does not add up to the
 * measured total would silently charge something the measurement never
 * said. Compared in SQL numeric, so '118.00' and '118' are one figure.
 *
 * A DIRECT itemised invoice needs no such check: its stated taxable value
 * was derived from these same lines when the draft was written, and the
 * 0057 tax-heads guard re-proves the identity at the database.
 */
async function assertLinesMatchMeasuredTotal(
  tx: TransactionSql,
  book: InvoiceableBook | null,
  expectedTaxable: string,
  linesTaxable: string,
): Promise<void> {
  if (book?.total_amount == null) return;
  const [row] = await tx<{ matches: boolean }[]>`
    select ${linesTaxable}::numeric = ${expectedTaxable}::numeric as matches
  `;
  if (row?.matches !== true) {
    // The expectation is the measured total ON THE INVOICE'S BASIS (ruling
    // 2), not the raw MB total: on a GST-inclusive Work the two differ by
    // the tax, and holding the lines to the raw figure would force every
    // itemised invoice to overcharge. The message names both so the
    // operator can see which one their lines were built against.
    const measured =
      expectedTaxable === book.total_amount
        ? `measures ${book.total_amount}`
        : `measures ${book.total_amount} inclusive of GST, which is ${expectedTaxable} taxable`;
    throw httpError(
      409,
      'ITEMISED_LINES_TOTAL_MISMATCH',
      `The itemised lines total ${linesTaxable}, but Measurement Book ${book.mb_number ?? book.id} ${measured}. An MB-backed invoice bills exactly what was measured — correct the lines (or amend the Measurement Book) and retry.`,
    );
  }
}

/**
 * Phase 4: gapless per (organisation, financial year) under the counter
 * row lock — concurrent submits serialise here, and a rolled-back
 * transaction rolls the number back with it.
 */
async function assignInvoiceNumber(
  tx: TransactionSql,
  organisationId: string,
  invoice: InvoiceRow,
  organisation: SupplierProfile,
  buyer: BuyerRow,
): Promise<{
  fyLabel: string;
  prefix: string | null;
  sequence: number;
  invoiceNumber: string;
}> {
  const fyLabel = financialYearLabel(invoice.invoice_date);
  // The number is COMPOSED, not templated: the owner's series is
  // a prefix, the financial year's opening year, and one gapless
  // serial per year SHARED across every prefix — P10 26 044 and
  // P14 26 048 are the 44th and 48th invoices of 2026-27 under
  // two prefixes. The invoice's own prefix wins over the house
  // default; neither present is a refusal rather than a guess,
  // because inventing a series would put a number on a legal
  // document that the owner's books do not recognise.
  const prefix = invoice.number_prefix ?? organisation.invoice_number_prefix;
  const template = await loadNumberTemplate(tx, 'tax_invoice');
  const [counter] = await tx<{ next_value: number }[]>`
    insert into tax_invoice_counters (organisation_id, fy_label)
    values (${organisationId}, ${fyLabel})
    on conflict (organisation_id, fy_label)
    do update set next_value = tax_invoice_counters.next_value + 1
    returning next_value
  `;
  if (!counter) throw new Error('tax invoice counter upsert returned no row');
  const sequence = counter.next_value;
  // The organisation's own format. The default is TI/<FY>/NNN;
  // an organisation whose series names a division ({DIV}) draws
  // it from the BUYER, which is why a buyer with no division
  // code is a named refusal rather than a number with a hole.
  let invoiceNumber: string;
  try {
    invoiceNumber = renderNumberTemplate(template, {
      prefix,
      divisionCode: buyer.division_code,
      financialYear: fyLabel,
      documentDate: invoice.invoice_date,
      sequence,
    });
  } catch (cause) {
    if (cause instanceof NumberTemplateError) {
      throw httpError(400, 'INVOICE_NUMBER_UNFILLABLE', cause.message);
    }
    throw cause;
  }
  return { fyLabel, prefix, sequence, invoiceNumber };
}

interface InvoiceMoney {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  round_off: string;
  line_value: string;
}

/**
 * Phase 5a, ITEMISED only: freeze each line's own money, then sum the
 * header from the lines. Two statements, both entirely in SQL numeric:
 *
 *   1. every line's taxable value is round(quantity * unit_rate, 2), and
 *      its tax is split at ITS OWN GST rate the way the invoice's supply
 *      geography says — intra-state two equal halves of
 *      round(taxable * rate / 200, 2), inter-state
 *      round(taxable * rate / 100, 2) as IGST. This is the cumulative
 *      arithmetic, per line, and the 0057 line CHECKs re-prove it;
 *   2. the header's four money columns are the SUM of the lines', and the
 *      total rounds to the whole rupee exactly as it always has.
 *
 * The lines are written while the invoice is still a DRAFT, which is the
 * only window the 0057 mutation guard leaves open — the header moves to
 * submitted afterwards, in the same transaction.
 */
async function freezeLineMoney(
  tx: TransactionSql,
  invoiceId: string,
  intraState: boolean,
): Promise<void> {
  await tx`
    update tax_invoice_lines l
    set taxable_value = priced.taxable,
        cgst_amount = priced.half,
        sgst_amount = priced.half,
        igst_amount = priced.igst
    from (
      select id,
             round(quantity * unit_rate, 2)::numeric(18,2) as taxable,
             case when ${intraState}
               then round(round(quantity * unit_rate, 2) * gst_rate / 200, 2)
               else 0 end::numeric(18,2) as half,
             case when ${intraState}
               then 0
               else round(round(quantity * unit_rate, 2) * gst_rate / 100, 2)
               end::numeric(18,2) as igst
      from tax_invoice_lines
      where tax_invoice_id = ${invoiceId}
    ) as priced
    where l.id = priced.id
  `;
}

async function computeItemisedMoney(
  tx: TransactionSql,
  invoiceId: string,
): Promise<InvoiceMoney> {
  const [money] = await tx<InvoiceMoney[]>`
    with base as (
      select sum(taxable_value)::numeric(18,2) as taxable,
             sum(cgst_amount)::numeric(18,2) as cgst,
             sum(sgst_amount)::numeric(18,2) as sgst,
             sum(igst_amount)::numeric(18,2) as igst
      from tax_invoice_lines
      where tax_invoice_id = ${invoiceId}
    )
    select taxable::text as taxable, cgst::text as cgst, sgst::text as sgst,
           igst::text as igst,
           round(taxable + cgst + sgst + igst, 0)::numeric(18,2)::text as total,
           (round(taxable + cgst + sgst + igst, 0)
             - (taxable + cgst + sgst + igst))::numeric(18,2)::text as round_off,
           (taxable + cgst + sgst + igst)::numeric(18,2)::text as line_value
    from base
  `;
  if (!money) throw new Error('itemised tax computation returned no row');
  return money;
}

/**
 * Phase 5: THE MONEY, entirely in SQL numeric arithmetic. Taxable is the
 * MB total verbatim; intra-state (organisation state = place of supply)
 * splits into equal CGST and SGST halves of round(taxable*rate/200, 2);
 * inter-state carries round(taxable*rate/100, 2) as IGST. The total
 * re-adds the rounded parts, so what is charged is exactly what the
 * parts say.
 */
async function computeInvoiceMoney(
  tx: TransactionSql,
  invoice: InvoiceRow,
  taxableValue: string,
  intraState: boolean,
): Promise<InvoiceMoney> {
  const [money] = await tx<InvoiceMoney[]>`
    with base as (
      select ${taxableValue}::numeric(18,2) as taxable,
             case when ${intraState}
               then round(${taxableValue}::numeric(18,2)
                      * ${invoice.gst_rate}::numeric / 200, 2)
               else 0 end::numeric(18,2) as half,
             case when ${intraState}
               then 0
               else round(${taxableValue}::numeric(18,2)
                      * ${invoice.gst_rate}::numeric / 100, 2)
               end::numeric(18,2) as igst
    )
    select taxable::text as taxable, half::text as cgst, half::text as sgst,
           igst::text as igst,
           -- The invoice is payable in whole rupees, so the total
           -- is rounded and the delta is kept and printed. Both
           -- in SQL numeric: 4226994.01 + 380429.46 + 380429.46 =
           -- 4987852.93 becomes 4987853 with a round_off of 0.07,
           -- which is exactly what the customer's own invoice
           -- says.
           round(taxable + half + half + igst, 0)::numeric(18,2)::text
             as total,
           (round(taxable + half + half + igst, 0)
             - (taxable + half + half + igst))::numeric(18,2)::text
             as round_off,
           (taxable + half + half + igst)::numeric(18,2)::text
             as line_value
    from base
  `;
  if (!money) throw new Error('tax computation returned no row');
  return money;
}

/**
 * Phase 6: THE DOCUMENT, frozen. Everything the printed invoice says
 * about parties and money, captured at the one moment it becomes legal —
 * so correcting the company address in Settings tomorrow cannot rewrite
 * the masthead of an invoice the Government has already registered. A
 * re-render REPRODUCES this; it never recomputes from live tables.
 */
async function freezeIssuedSnapshot(
  tx: TransactionSql,
  invoice: InvoiceRow,
  organisation: SupplierProfile,
  buyer: BuyerRow,
  money: InvoiceMoney,
  invoiceNumber: string,
  fyLabel: string,
  lines: readonly InvoiceLineRow[],
): Promise<{
  buyerSnapshot: Record<string, unknown>;
  shipToSnapshot: Record<string, unknown> | null;
  issuedSnapshot: Record<string, unknown>;
}> {
  // The buyer exactly as invoiced, frozen so master edits never
  // rewrite the document (rule 7). contactId makes the read
  // model's provenance resolution total.
  const buyerSnapshot = {
    contactId: buyer.id,
    designation: buyer.designation,
    contactPerson: buyer.contact_person,
    gstin: buyer.gstin,
    address: buyer.address,
    stateCode: buyer.state_code,
    pincode: buyer.pincode,
    locality: buyer.locality,
  };

  // The ship-to, when one was named. Same freeze as the buyer,
  // and deliberately NOT a copy of it. NIC requires the frozen
  // ship-to GSTIN and explicit locality when this block is present.
  const shipTo =
    invoice.ship_to_contact_id === null
      ? null
      : await requireShipTo(tx, invoice.ship_to_contact_id);
  if (shipTo !== null) {
    const missingShipTo = [
      ...(shipTo.address === null ? ['address'] : []),
      ...(shipTo.state_code === null ? ['stateCode'] : []),
      ...(shipTo.pincode === null ? ['pincode'] : []),
      ...(shipTo.gstin === null ? ['gstin'] : []),
      ...(shipTo.locality === null ? ['locality'] : []),
    ];
    if (missingShipTo.length > 0) {
      throw httpError(
        400,
        'SHIP_TO_PROFILE_INCOMPLETE',
        `The ship-to contact is missing ${missingShipTo.join(', ')} — complete it before the invoice is frozen.`,
      );
    }
  }
  const shipToSnapshot =
    shipTo === null
      ? null
      : {
          contactId: shipTo.id,
          designation: shipTo.designation,
          contactPerson: shipTo.contact_person,
          gstin: shipTo.gstin,
          address: shipTo.address,
          stateCode: shipTo.state_code,
          pincode: shipTo.pincode,
          locality: shipTo.locality,
        };

  // The itemised document freezes SNAPSHOT V2, which differs from v1 in
  // exactly one place: `lines` instead of `line`. A cumulative invoice
  // keeps freezing v1 byte for byte — an itemised feature has no business
  // changing the frozen shape of the document the railway trade issues
  // most, and every stored invoice is v1.
  const itemised = invoice.line_shape === 'itemised';
  const lineBlock = itemised
    ? {
        templateVersion: TAX_INVOICE_ITEMISED_TEMPLATE_VERSION,
        lines: lines.map((line) => ({
          position: line.position,
          isService: line.is_service,
          hsnSacCode: line.hsn_sac_code,
          description: line.description,
          quantity: line.quantity,
          unitLabel: line.unit_label ?? DEFAULT_UNIT_LABEL,
          rate: line.unit_rate,
          gstRate: line.gst_rate,
          amount: line.taxable_value ?? '0.00',
          lineValue: line.line_value ?? '0.00',
        })),
      }
    : {
        templateVersion: TAX_INVOICE_TEMPLATE_VERSION,
        line: {
          sacCode: invoice.sac_code ?? '',
          description: invoice.service_description ?? '',
          quantity: '1.00',
          unitLabel: invoice.unit_label ?? DEFAULT_UNIT_LABEL,
          rate: money.taxable,
          gstRate: invoice.gst_rate ?? '0.00',
          amount: money.taxable,
          lineValue: money.line_value,
        },
      };

  const issuedSnapshot = {
    ...lineBlock,
    invoiceNumber,
    invoiceDate: invoice.invoice_date,
    fyLabel,
    supplier: {
      name: organisation.name,
      tradeName: organisation.trade_name,
      address: organisation.address,
      pincode: organisation.pincode,
      locality: organisation.locality,
      stateCode: organisation.state_code,
      gstin: organisation.gstin,
      phone: organisation.contact_phone,
      msmeNumber: organisation.msme_number,
    },
    buyer: buyerSnapshot,
    shipTo: shipToSnapshot,
    placeOfSupply: invoice.place_of_supply,
    reverseChargeApplicable: invoice.reverse_charge_applicable,
    customerPoReference: invoice.customer_po_reference,
    totals: {
      taxableValue: money.taxable,
      cgstAmount: money.cgst,
      sgstAmount: money.sgst,
      igstAmount: money.igst,
      roundOff: money.round_off,
      totalAmount: money.total,
    },
    // The organisation's standing line unless this invoice set
    // its own; one sample carries it and the other does not.
    notes: invoice.notes ?? organisation.invoice_notes,
    amountInWords: amountInWords(money.total),
  };

  return { buyerSnapshot, shipToSnapshot, issuedSnapshot };
}

/** The money moment: submit assigns the gapless per-financial-year
 * number, resolves and freezes the buyer, computes the GST split in SQL
 * numeric, and stamps the IRP reporting deadline. */
export function registerTaxInvoiceSubmitRoute(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'POST',
      url: '/api/tax-invoices/:id/submit',
      schema: {
        params: IdParamsSchema,
        response: { 201: TaxInvoiceDetailResponseSchema, ...errorResponses },
      },
      authority: 'issue',
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { id } = request.params;
      const detail = await tenant(async (tx) => {
        // Submitting assigns a legal number and freezes money: issue
        // authority, like challan issue and MB finalize.
        const invoice = await lockInvoice(tx, id);
        await assertInvoiceWorkAccess(tx, user.id, invoice.work_id);
        requireStatus(invoice, 'draft');
        await assertInvoiceDateNotFuture(tx, invoice.invoice_date);
        // Re-checked at the money moment: the rate and the date were
        // both checked when the draft was written, but either may have
        // been edited since, and the rate master itself may have been
        // end-dated between drafting and submit. Nothing is computed
        // from a rate the Government had not notified on this date.
        const itemised = invoice.line_shape === 'itemised';
        if (invoice.gst_rate !== null) {
          await assertGstRateNotified(tx, invoice.gst_rate, invoice.invoice_date);
        }

        assertReverseChargeAnswered(invoice);
        const organisation = await requireCompleteSupplierProfile(tx);
        const buyer = await requireCompleteBuyer(tx, invoice);
        const { book, taxableValue } = await resolveTaxableValue(tx, invoice);
        const { fyLabel, prefix, sequence, invoiceNumber } = await assignInvoiceNumber(
          tx,
          organisationId,
          invoice,
          organisation,
          buyer,
        );
        const intraState = organisation.state_code === invoice.place_of_supply;
        let money: InvoiceMoney;
        let lines: InvoiceLineRow[] = [];
        if (itemised) {
          // Every line's rate is re-checked at the money moment for the
          // same reason the header's is: the invoice date may have moved
          // since drafting, and the rate master itself may have been
          // end-dated. Nothing is monetised from a rate the Government
          // had not notified on this date.
          const drafted = await readInvoiceLines(tx, invoice.id);
          if (drafted.length === 0) {
            throw new Error(`itemised tax invoice ${invoice.id} has no lines`);
          }
          for (const line of drafted) {
            await assertGstRateNotified(
              tx,
              line.gst_rate,
              invoice.invoice_date,
              `Line ${String(line.position)}`,
            );
          }
          await freezeLineMoney(tx, invoice.id, intraState);
          money = await computeItemisedMoney(tx, invoice.id);
          await assertLinesMatchMeasuredTotal(tx, book, taxableValue, money.taxable);
          lines = await readInvoiceLines(tx, invoice.id);
        } else {
          money = await computeInvoiceMoney(tx, invoice, taxableValue, intraState);
        }
        const { buyerSnapshot, shipToSnapshot, issuedSnapshot } =
          await freezeIssuedSnapshot(
            tx,
            invoice,
            organisation,
            buyer,
            money,
            invoiceNumber,
            fyLabel,
            lines,
          );

        // THE REPORTING WINDOW, frozen with the rest (migration 0049):
        // the organisation's e-invoicing declaration as it stands at
        // this money moment decides whether this invoice ever had an
        // IRP reporting deadline, and the consequence is stamped on
        // the row so a later declaration edit cannot rewrite which
        // invoices were lawfully reportable. Date-only arithmetic in
        // SQL (rule 6): invoice date + window days. An invoice dated
        // before the applicable-from date carries NULL — the mandate
        // did not cover it — as does any invoice submitted while no
        // window is declared. Submit itself is NEVER refused by this:
        // the local document is valid regardless of IRP reporting.
        const reportingWindowApplies =
          organisation.einvoice_applicability === 'applicable' &&
          organisation.einvoice_applicable_from !== null &&
          invoice.invoice_date >= organisation.einvoice_applicable_from &&
          organisation.irp_reporting_window_days !== null;

        const [stamped] = await tx<{ irp_reporting_deadline: string | null }[]>`
            update tax_invoices
            set status = 'submitted', invoice_number = ${invoiceNumber},
                number_prefix = ${prefix},
                sequence_number = ${sequence}, fy_label = ${fyLabel},
                buyer_snapshot = ${jsonb(tx, buyerSnapshot)},
                ship_to_snapshot = ${shipToSnapshot === null ? null : jsonb(tx, shipToSnapshot)},
                issued_snapshot = ${jsonb(tx, issuedSnapshot)},
                taxable_value = ${money.taxable}, cgst_amount = ${money.cgst},
                sgst_amount = ${money.sgst}, igst_amount = ${money.igst},
                round_off = ${money.round_off}, total_amount = ${money.total},
                irp_reporting_deadline = case when ${reportingWindowApplies}
                  then ${invoice.invoice_date}::date
                    + ${organisation.irp_reporting_window_days ?? 0}::int
                  else null end,
                submitted_by_user_id = ${user.id}, submitted_at = now()
            where id = ${id}
            returning irp_reporting_deadline::text as irp_reporting_deadline
          `.catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === '23505') {
            throw httpError(
              409,
              'TAX_INVOICE_NUMBER_CONFLICT',
              `Tax invoice number ${invoiceNumber} already exists in this organisation.`,
            );
          }
          throw error;
        });

        await audit(
          tx,
          organisationId,
          user.id,
          'tax_invoice.submitted',
          'tax_invoices',
          id,
          {
            invoiceNumber,
            fyLabel,
            sequence,
            lineShape: invoice.line_shape,
            lineCount: itemised ? lines.length : 1,
            measurementBookId: invoice.measurement_book_id,
            mbNumber: book?.mb_number ?? null,
            buyerContactId: buyer.id,
            taxableValue: money.taxable,
            cgstAmount: money.cgst,
            sgstAmount: money.sgst,
            igstAmount: money.igst,
            totalAmount: money.total,
            placeOfSupply: invoice.place_of_supply,
            reverseChargeApplicable: invoice.reverse_charge_applicable,
            intraState,
            irpReportingDeadline: stamped?.irp_reporting_deadline ?? null,
          },
        );
        return readDetail(tx, id);
      });
      return reply.status(201).send(detail);
    },
  );
}
