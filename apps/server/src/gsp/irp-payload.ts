/**
 * The canonical NIC e-invoice (INV-01, schema version 1.1) JSON for a
 * SUBMITTED tax invoice — what the GSP (Taxilla, most likely) carries to
 * the IRP verbatim. Built from the stored rows only: nothing here
 * computes money, it re-serialises the amounts the submit transaction
 * froze in SQL numeric arithmetic.
 *
 * Mappings settled here and pinned by the golden payload test:
 *
 * - SupTyp: the buyer snapshot carries a GSTIN -> 'B2B'; it carries none
 *   -> 'B2C' (an unregistered domestic buyer — 'URP' on the wire). The
 *   export types (EXPWP/EXPWOP) are out of scope: a works contract for
 *   an Indian railway/government consignee is always a domestic supply
 *   with an Indian place of supply.
 * - ItemList has EXACTLY ONE line: the works contract is a cumulative
 *   supply of services, so the line is the service at its SAC for the
 *   billed Measurement Book's total. IsServc 'Y', Qty 1, Unit 'OTH',
 *   UnitPrice = AssAmt = the taxable value.
 * - Dates go on the wire as DD/MM/YYYY (the NIC shape), converted from
 *   the stored date-only strings without any timezone round-trip.
 * - Numbers go as JSON numbers, taken from the stored 2dp numeric
 *   strings. Number() on a numeric(18,2) text round-trips exactly
 *   through JSON serialisation, and no arithmetic happens on them here.
 *
 * The organisation profile has no pincode or location column, so the
 * seller's Pin and Loc are read out of the profile address: the LAST
 * standalone six-digit run is the PIN (Indian addresses end with it),
 * and the last comma-separated segment that is not just the PIN is the
 * location. The route refuses payload assembly when the address or an
 * extractable PIN is missing — a payload with an invented PIN would be
 * rejected by the IRP anyway, later and less legibly.
 */

export interface IrpSeller {
  gstin: string;
  legalName: string;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

export interface IrpBuyer {
  /** null = unregistered buyer: 'URP' on the wire and SupTyp 'B2C'. */
  gstin: string | null;
  legalName: string;
  address: string;
  location: string;
  pincode: string;
  stateCode: string;
}

export interface IrpInvoiceInput {
  invoiceNumber: string;
  /** Date-only YYYY-MM-DD, converted to DD/MM/YYYY on the wire. */
  invoiceDate: string;
  sacCode: string;
  serviceDescription: string;
  placeOfSupply: string;
  /** All five as the stored numeric(18,2)/(5,2) strings, verbatim. */
  gstRate: string;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalAmount: string;
  seller: IrpSeller;
  buyer: IrpBuyer;
}

/** A stored numeric string as a JSON number. The stored values are at
 * most 2dp (the columns' own scale), so Number() is an exact reading —
 * this is serialisation, never arithmetic. */
function toAmount(value: string): number {
  return Number(value);
}

/** YYYY-MM-DD -> DD/MM/YYYY, on the string itself (rule 6: date-only
 * values never round-trip through a timezone). */
export function formatNicDate(dateOnly: string): string {
  const [year, month, day] = dateOnly.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** The LAST standalone six-digit run in an address — Indian addresses
 * close with the PIN, and "standalone" (no digit on either side) keeps a
 * plot number like '1100223' from being misread. Null when the address
 * names no PIN. */
export function extractPincode(address: string): string | null {
  const matches = address.match(/(?<![0-9])[0-9]{6}(?![0-9])/g);
  return matches === null ? null : (matches[matches.length - 1] ?? null);
}

/** The address's location: the last comma-separated segment that still
 * says something once the PIN (and any joining dashes) is removed —
 * 'Plot 12, Industrial Area, New Delhi, 110002' and
 * 'Industrial Area, New Delhi - 110002' both read 'New Delhi'. Falls
 * back to the whole trimmed address when no segment survives. */
export function extractLocation(address: string, pincode: string | null): string {
  const segments = address
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';
    const cleaned = (pincode === null ? segment : segment.replaceAll(pincode, ' '))
      .replace(/[\s-]+$/u, '')
      .trim();
    if (cleaned.length > 0) return cleaned;
  }
  return address.trim();
}

export interface IrpPayload {
  Version: '1.1';
  TranDtls: { TaxSch: 'GST'; SupTyp: 'B2B' | 'B2C' };
  DocDtls: { Typ: 'INV'; No: string; Dt: string };
  SellerDtls: {
    Gstin: string;
    LglNm: string;
    Addr1: string;
    Loc: string;
    Pin: number;
    Stcd: string;
  };
  BuyerDtls: {
    Gstin: string;
    LglNm: string;
    Pos: string;
    Addr1: string;
    Loc: string;
    Pin: number;
    Stcd: string;
  };
  ItemList: [
    {
      SlNo: '1';
      PrdDesc: string;
      IsServc: 'Y';
      HsnCd: string;
      Qty: 1;
      Unit: 'OTH';
      UnitPrice: number;
      TotAmt: number;
      AssAmt: number;
      GstRt: number;
      CgstAmt: number;
      SgstAmt: number;
      IgstAmt: number;
      TotItemVal: number;
    },
  ];
  ValDtls: {
    AssVal: number;
    CgstVal: number;
    SgstVal: number;
    IgstVal: number;
    TotInvVal: number;
  };
}

export function buildIrpPayload(input: IrpInvoiceInput): IrpPayload {
  const taxable = toAmount(input.taxableValue);
  return {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: input.buyer.gstin === null ? 'B2C' : 'B2B',
    },
    DocDtls: {
      Typ: 'INV',
      No: input.invoiceNumber,
      Dt: formatNicDate(input.invoiceDate),
    },
    SellerDtls: {
      Gstin: input.seller.gstin,
      LglNm: input.seller.legalName,
      Addr1: input.seller.address,
      Loc: input.seller.location,
      Pin: Number(input.seller.pincode),
      Stcd: input.seller.stateCode,
    },
    BuyerDtls: {
      Gstin: input.buyer.gstin ?? 'URP',
      LglNm: input.buyer.legalName,
      Pos: input.placeOfSupply,
      Addr1: input.buyer.address,
      Loc: input.buyer.location,
      Pin: Number(input.buyer.pincode),
      Stcd: input.buyer.stateCode,
    },
    ItemList: [
      {
        SlNo: '1',
        PrdDesc: input.serviceDescription,
        IsServc: 'Y',
        HsnCd: input.sacCode,
        Qty: 1,
        Unit: 'OTH',
        UnitPrice: taxable,
        TotAmt: taxable,
        AssAmt: taxable,
        GstRt: toAmount(input.gstRate),
        CgstAmt: toAmount(input.cgstAmount),
        SgstAmt: toAmount(input.sgstAmount),
        IgstAmt: toAmount(input.igstAmount),
        TotItemVal: toAmount(input.totalAmount),
      },
    ],
    ValDtls: {
      AssVal: taxable,
      CgstVal: toAmount(input.cgstAmount),
      SgstVal: toAmount(input.sgstAmount),
      IgstVal: toAmount(input.igstAmount),
      TotInvVal: toAmount(input.totalAmount),
    },
  };
}
