/**
 * Canonical NIC e-invoice (INV-01, schema 1.1) payload.
 *
 * The input comes only from the immutable submit-time invoice snapshot.
 * Exact PostgreSQL numeric strings remain branded decimal lexemes until
 * stringifyStatutoryJson writes the final bytes; statutory money and rates
 * never round-trip through JavaScript floating point.
 *
 * This provider integration deliberately supports B2B only. Local invoices
 * may name an unregistered buyer, but an IRP payload is refused until an
 * explicit provider-backed B2C contract exists.
 */

import {
  exactJsonInteger,
  exactJsonNumber,
  type ExactJsonNumber,
} from './statutory-json.js';

export interface IrpSeller {
  gstin: string;
  legalName: string;
  tradeName: string | null;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

export interface IrpBuyer {
  gstin: string;
  legalName: string;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

export type IrpShipTo = IrpBuyer;

/** INV-01 document type: the tax invoice or the Section 34 credit note.
 * A CRN rides the SAME schema with POSITIVE values — NIC's convention
 * is that the document type, not a sign, marks the credit. */
export type IrpDocumentType = 'INV' | 'CRN';

export interface IrpInvoiceInput {
  /** 'INV' (default) or 'CRN'. */
  documentType?: IrpDocumentType;
  invoiceNumber: string;
  /** Date-only YYYY-MM-DD, converted to DD/MM/YYYY on the wire. */
  invoiceDate: string;
  sacCode: string;
  serviceDescription: string;
  placeOfSupply: string;
  reverseChargeApplicable: boolean;
  gstRate: string;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalAmount: string;
  roundOff: string;
  /** Unrounded taxable + tax sum for TotItemVal. */
  lineValue: string;
  seller: IrpSeller;
  buyer: IrpBuyer;
  /** Null means Bill-To and Ship-To are the same frozen party. */
  shipTo: IrpShipTo | null;
}

/** YYYY-MM-DD -> DD/MM/YYYY, without a timezone round-trip. */
export function formatNicDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** Last standalone six-digit PIN in a legacy address. New snapshots store PIN
 * explicitly; this remains for old non-statutory call sites and migrations. */
export function extractPincode(address: string): string | null {
  const matches = address.match(/(?<![0-9])[0-9]{6}(?![0-9])/g);
  return matches === null ? null : (matches[matches.length - 1] ?? null);
}

interface WirePartyAddress {
  LglNm: string;
  Addr1: string;
  Loc: string;
  Pin: ExactJsonNumber;
  Stcd: string;
}

export interface IrpPayload {
  Version: '1.1';
  TranDtls: { TaxSch: 'GST'; SupTyp: 'B2B'; RegRev: 'Y' | 'N' };
  DocDtls: { Typ: IrpDocumentType; No: string; Dt: string };
  SellerDtls: WirePartyAddress & { Gstin: string; TrdNm?: string };
  BuyerDtls: WirePartyAddress & { Gstin: string; Pos: string };
  ShipDtls?: WirePartyAddress & { Gstin: string };
  ItemList: [
    {
      SlNo: '1';
      PrdDesc: string;
      IsServc: 'Y';
      HsnCd: string;
      Qty: ExactJsonNumber;
      Unit: 'OTH';
      UnitPrice: ExactJsonNumber;
      TotAmt: ExactJsonNumber;
      AssAmt: ExactJsonNumber;
      GstRt: ExactJsonNumber;
      CgstAmt: ExactJsonNumber;
      SgstAmt: ExactJsonNumber;
      IgstAmt: ExactJsonNumber;
      TotItemVal: ExactJsonNumber;
    },
  ];
  ValDtls: {
    AssVal: ExactJsonNumber;
    CgstVal: ExactJsonNumber;
    SgstVal: ExactJsonNumber;
    IgstVal: ExactJsonNumber;
    RndOffAmt: ExactJsonNumber;
    TotInvVal: ExactJsonNumber;
  };
}

function wireParty(party: IrpBuyer): WirePartyAddress & { Gstin: string } {
  return {
    Gstin: party.gstin,
    LglNm: party.legalName,
    Addr1: party.address,
    Loc: party.location,
    Pin: exactJsonInteger(party.pincode),
    Stcd: party.stateCode,
  };
}

function wireShipTo(party: IrpShipTo): WirePartyAddress & { Gstin: string } {
  return {
    Gstin: party.gstin,
    LglNm: party.legalName,
    Addr1: party.address,
    Loc: party.location,
    Pin: exactJsonInteger(party.pincode),
    Stcd: party.stateCode,
  };
}

export function buildIrpPayload(input: IrpInvoiceInput): IrpPayload {
  const taxable = exactJsonNumber(input.taxableValue);
  return {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: 'B2B',
      RegRev: input.reverseChargeApplicable ? 'Y' : 'N',
    },
    DocDtls: {
      Typ: input.documentType ?? 'INV',
      No: input.invoiceNumber,
      Dt: formatNicDate(input.invoiceDate),
    },
    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.legalName,
      ...(input.seller.tradeName === null ? {} : { TrdNm: input.seller.tradeName }),
      Addr1: input.seller.address,
      Loc: input.seller.location,
      Pin: exactJsonInteger(input.seller.pincode),
      Stcd: input.seller.stateCode,
    },
    BuyerDtls: {
      ...wireParty(input.buyer),
      Pos: input.placeOfSupply,
    },
    ...(input.shipTo === null ? {} : { ShipDtls: wireShipTo(input.shipTo) }),
    ItemList: [
      {
        SlNo: '1',
        PrdDesc: input.serviceDescription,
        IsServc: 'Y',
        HsnCd: input.sacCode,
        Qty: exactJsonNumber('1'),
        Unit: 'OTH',
        UnitPrice: taxable,
        TotAmt: taxable,
        AssAmt: taxable,
        GstRt: exactJsonNumber(input.gstRate),
        CgstAmt: exactJsonNumber(input.cgstAmount),
        SgstAmt: exactJsonNumber(input.sgstAmount),
        IgstAmt: exactJsonNumber(input.igstAmount),
        TotItemVal: exactJsonNumber(input.lineValue),
      },
    ],
    ValDtls: {
      AssVal: taxable,
      CgstVal: exactJsonNumber(input.cgstAmount),
      SgstVal: exactJsonNumber(input.sgstAmount),
      IgstVal: exactJsonNumber(input.igstAmount),
      RndOffAmt: exactJsonNumber(input.roundOff),
      TotInvVal: exactJsonNumber(input.totalAmount),
    },
  };
}
