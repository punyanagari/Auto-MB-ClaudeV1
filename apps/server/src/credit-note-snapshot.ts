/** Strict parser for the immutable credit-note snapshot frozen at issue,
 * and the CRN payload built exclusively from it.
 *
 * The credit note bills nothing new: its parties, line and totals are
 * the superseded invoice's issued snapshot VERBATIM, embedded under
 * `invoice`. What the note adds is its own identity (number, date,
 * financial year), the Section 34 reason, and the reference to the
 * invoice it supersedes — which is exactly what prints and exactly what
 * goes to the IRP as a DocTyp CRN document. Values stay POSITIVE: NIC's
 * convention is that the document type, not a sign, marks the credit
 * (verified against the bundled Whitebooks INV-01 spec, whose value
 * schema carries no negative-value provision and whose lookup names the
 * document type separately).
 */

import { buildIrpPayload, type IrpPayload } from './gsp/irp-payload.js';
import {
  parseTaxInvoiceIssuedSnapshot,
  TaxInvoiceSnapshotError,
  EInvoiceB2cUnsupportedError,
  type TaxInvoiceIssuedSnapshotV1,
} from './tax-invoice-snapshot.js';

export const CREDIT_NOTE_TEMPLATE_VERSION = 'cn-v1';

export interface CreditNoteIssuedSnapshotV1 {
  readonly templateVersion: 'cn-v1';
  readonly noteNumber: string;
  readonly noteDate: string;
  readonly fyLabel: string;
  readonly reason: string;
  /** The superseded invoice's whole issued snapshot, verbatim. Its
   * invoiceNumber/invoiceDate are the reference printed on the face. */
  readonly invoice: TaxInvoiceIssuedSnapshotV1;
}

type JsonObject = Record<string, unknown>;

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaxInvoiceSnapshotError(`${path} is not a non-empty string`);
  }
  return value;
}

export function parseCreditNoteIssuedSnapshot(
  value: unknown,
): CreditNoteIssuedSnapshotV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot is not an object');
  }
  const root = value as JsonObject;
  if (root.templateVersion !== 'cn-v1') {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.templateVersion is unsupported');
  }
  const noteDate = text(root.noteDate, 'issuedSnapshot.noteDate');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(noteDate)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.noteDate is invalid');
  }
  const fyLabel = text(root.fyLabel, 'issuedSnapshot.fyLabel');
  if (!/^[0-9]{4}-[0-9]{2}$/.test(fyLabel)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.fyLabel is invalid');
  }
  return {
    templateVersion: 'cn-v1',
    noteNumber: text(root.noteNumber, 'issuedSnapshot.noteNumber'),
    noteDate,
    fyLabel,
    reason: text(root.reason, 'issuedSnapshot.reason'),
    invoice: parseTaxInvoiceIssuedSnapshot(root.invoice),
  };
}

/** Build the CRN provider payload exclusively from frozen issued facts.
 * Same INV-01 schema and refusals as the invoice's; only DocDtls names
 * the note's own number and date with Typ CRN. */
export function buildFrozenCrnPayload(value: unknown): IrpPayload {
  const snapshot = parseCreditNoteIssuedSnapshot(value);
  const base = snapshot.invoice;
  if (base.reverseChargeApplicable !== false) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.invoice.reverseChargeApplicable must explicitly confirm forward charge',
    );
  }
  if (base.buyer.gstin === null) throw new EInvoiceB2cUnsupportedError();
  if (base.supplier.locality === null) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.invoice.supplier.locality is missing; NIC locality is never inferred',
    );
  }
  if (base.buyer.locality === null) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.invoice.buyer.locality is missing; NIC locality is never inferred',
    );
  }
  const frozenShipTo = (() => {
    if (base.shipTo === null) return null;
    const gstin = base.shipTo.gstin;
    const locality = base.shipTo.locality;
    if (gstin === null || locality === null) {
      throw new TaxInvoiceSnapshotError(
        'issuedSnapshot.invoice.shipTo needs GSTIN and explicit locality for NIC',
      );
    }
    return {
      gstin,
      legalName: base.shipTo.designation,
      address: base.shipTo.address,
      location: locality,
      pincode: base.shipTo.pincode,
      stateCode: base.shipTo.stateCode,
    };
  })();
  return buildIrpPayload({
    documentType: 'CRN',
    invoiceNumber: snapshot.noteNumber,
    invoiceDate: snapshot.noteDate,
    sacCode: base.line.sacCode,
    serviceDescription: base.line.description,
    placeOfSupply: base.placeOfSupply,
    reverseChargeApplicable: base.reverseChargeApplicable,
    gstRate: base.line.gstRate,
    taxableValue: base.totals.taxableValue,
    cgstAmount: base.totals.cgstAmount,
    sgstAmount: base.totals.sgstAmount,
    igstAmount: base.totals.igstAmount,
    totalAmount: base.totals.totalAmount,
    roundOff: base.totals.roundOff,
    lineValue: base.line.lineValue,
    seller: {
      gstin: base.supplier.gstin,
      legalName: base.supplier.name,
      tradeName: base.supplier.tradeName,
      address: base.supplier.address,
      location: base.supplier.locality,
      pincode: base.supplier.pincode,
      stateCode: base.supplier.stateCode,
    },
    buyer: {
      gstin: base.buyer.gstin,
      legalName: base.buyer.designation,
      address: base.buyer.address,
      location: base.buyer.locality,
      pincode: base.buyer.pincode,
      stateCode: base.buyer.stateCode,
    },
    shipTo: frozenShipTo,
  });
}
