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
 * explicit provider-backed B2C contract exists. SupTyp therefore stays
 * 'B2B' whatever the ItemList carries: migration 0057 made the invoice's
 * LINES goods-or-service, which is IsServc per item, and said nothing
 * about the supply type.
 */

import {
  exactJsonInteger,
  exactJsonNumber,
  type ExactJsonNumber,
} from './statutory-json.js';

interface IrpSeller {
  gstin: string;
  legalName: string;
  tradeName: string | null;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

interface IrpBuyer {
  gstin: string;
  legalName: string;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

type IrpShipTo = IrpBuyer;

/** INV-01 document type: the tax invoice or the Section 34 credit note.
 * A CRN rides the SAME schema with POSITIVE values — NIC's convention
 * is that the document type, not a sign, marks the credit. */
type IrpDocumentType = 'INV' | 'CRN';

/**
 * One ItemList entry. A CUMULATIVE invoice contributes exactly one, built
 * from its header line and the invoice totals; an ITEMISED invoice
 * (migration 0057) contributes one per frozen line, each with its own
 * HSN/SAC, goods-or-services flag, quantity, rate and tax heads.
 *
 * `SlNo` is not stated here: it is the item's 1-based position in the
 * list, which is what NIC means by it and what the single-line payload
 * has always sent.
 */
export interface IrpItem {
  description: string;
  /** Goods or services — becomes IsServc. Stated by the frozen document,
   * never inferred from the code's length. */
  isService: boolean;
  /** HSN (goods, 6-8 digits) or SAC (services, 6 digits). */
  hsnCode: string;
  quantity: string;
  unitPrice: string;
  totalAmount: string;
  assessableAmount: string;
  gstRate: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  /** The item's own unrounded taxable + tax sum, for TotItemVal. */
  totalItemValue: string;
}

interface IrpInvoiceInput {
  /** 'INV' (default) or 'CRN'. */
  documentType?: IrpDocumentType;
  invoiceNumber: string;
  /** Date-only YYYY-MM-DD, converted to DD/MM/YYYY on the wire. */
  invoiceDate: string;
  placeOfSupply: string;
  reverseChargeApplicable: boolean;
  /** At least one item; see IrpItem. */
  items: readonly IrpItem[];
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalAmount: string;
  roundOff: string;
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
  ItemList: IrpWireItem[];
  ValDtls: {
    AssVal: ExactJsonNumber;
    CgstVal: ExactJsonNumber;
    SgstVal: ExactJsonNumber;
    IgstVal: ExactJsonNumber;
    RndOffAmt: ExactJsonNumber;
    TotInvVal: ExactJsonNumber;
  };
}

interface IrpWireItem {
  SlNo: string;
  PrdDesc: string;
  IsServc: 'Y' | 'N';
  HsnCd: string;
  Qty: ExactJsonNumber;
  /** OTH for every line. The frozen unit label is the trade's own word
   * ('set', 'm'), not a NIC UQC code, and inventing a mapping from one to
   * the other would put a claim on the wire that the document does not
   * make. The single-line payload has always sent OTH. */
  Unit: 'OTH';
  UnitPrice: ExactJsonNumber;
  TotAmt: ExactJsonNumber;
  AssAmt: ExactJsonNumber;
  GstRt: ExactJsonNumber;
  CgstAmt: ExactJsonNumber;
  SgstAmt: ExactJsonNumber;
  IgstAmt: ExactJsonNumber;
  TotItemVal: ExactJsonNumber;
}

function wireItem(item: IrpItem, index: number): IrpWireItem {
  return {
    SlNo: String(index + 1),
    PrdDesc: item.description,
    IsServc: item.isService ? 'Y' : 'N',
    HsnCd: item.hsnCode,
    Qty: exactJsonNumber(item.quantity),
    Unit: 'OTH',
    UnitPrice: exactJsonNumber(item.unitPrice),
    TotAmt: exactJsonNumber(item.totalAmount),
    AssAmt: exactJsonNumber(item.assessableAmount),
    GstRt: exactJsonNumber(item.gstRate),
    CgstAmt: exactJsonNumber(item.cgstAmount),
    SgstAmt: exactJsonNumber(item.sgstAmount),
    IgstAmt: exactJsonNumber(item.igstAmount),
    TotItemVal: exactJsonNumber(item.totalItemValue),
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
  if (input.items.length === 0) {
    throw new Error('an IRP payload needs at least one item');
  }
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
    ItemList: input.items.map(wireItem),
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
