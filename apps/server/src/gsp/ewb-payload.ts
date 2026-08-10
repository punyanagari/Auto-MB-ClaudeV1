/**
 * The canonical NIC e-way bill (EWB-01) generation JSON for a drafted
 * e-way bill and the submitted tax invoice it moves — what the GSP
 * carries to NIC verbatim. Like the IRP payload, nothing here computes
 * money: the values are the invoice's frozen SQL-numeric amounts,
 * re-serialised.
 *
 * Mappings settled here and pinned by the golden payload test:
 *
 * - supplyType 'O' (outward) with subSupplyType '1' (Supply). NIC's
 *   sub-supply list has no works-contract entry; '3' is Export, which a
 *   domestic railway works contract never is. An invoice-backed works
 *   contract movement is an ordinary outward SUPPLY, so '1' — the
 *   service character of the supply lives in the SAC on the item line,
 *   not in the sub-supply code.
 * - docType 'INV' with the tax invoice's number and DD/MM/YYYY date.
 * - transactionType 1 (Regular): bill-to and ship-to are the same party
 *   in this model — the buyer snapshotted on the invoice.
 * - itemList has EXACTLY ONE line, the invoice's cumulative service
 *   line. The e-way bill carries RATES per line (not amounts): an
 *   intra-state movement splits the GST rate into equal CGST and SGST
 *   halves, an inter-state one carries it whole as IGST — the same
 *   decision the submit froze, read back off which tax amounts are
 *   non-zero-capable (igstAmount decides).
 * - The from/to pincodes are the MOVEMENT's own (the e-way bill row),
 *   which may differ from either party's registered address; the state
 *   codes are the parties' (seller profile, buyer snapshot), because
 *   NIC's act*StateCode wants the state the goods actually move
 *   between and the pincode is the finer fact we hold.
 * - transDistance goes as a string (the NIC sample shape); pincodes and
 *   state codes go as numbers.
 * - Road movements name vehicleNo; rail/air/ship name transDocNo and
 *   transDocDate. The route refuses to assemble a payload for a draft
 *   still missing its carriage — NIC would refuse it later and less
 *   legibly.
 */

import { formatNicDate } from './irp-payload.js';

const TRANS_MODES = { road: '1', rail: '2', air: '3', ship: '4' } as const;
export type EwbTransportMode = keyof typeof TRANS_MODES;

export interface EwbPartyInput {
  /** null on the buyer side = unregistered: 'URP' on the wire. */
  gstin: string | null;
  tradeName: string;
  address: string;
  location: string;
  stateCode: string;
}

export interface EwbInput {
  invoiceNumber: string;
  /** Date-only YYYY-MM-DD. */
  invoiceDate: string;
  sacCode: string;
  serviceDescription: string;
  /** The invoice's frozen numeric strings, verbatim. */
  gstRate: string;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalAmount: string;
  seller: EwbPartyInput;
  buyer: EwbPartyInput;
  transportMode: EwbTransportMode;
  transporterId: string | null;
  transporterName: string | null;
  vehicleNumber: string | null;
  transportDocNumber: string | null;
  /** Date-only YYYY-MM-DD, or null. */
  transportDocDate: string | null;
  distanceKm: number;
  fromPincode: string;
  toPincode: string;
}

/** Exact halving of a <=2dp rate string via scaled integers — the halves
 * NIC wants (9 from 18, 0.125 from 0.25) come out as clean JSON numbers
 * with no float arithmetic on the decimal itself. */
function halveRate(rate: string): number {
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaled = Number(whole + fraction.padEnd(2, '0').slice(0, 2));
  return scaled / 200;
}

function toAmount(value: string): number {
  return Number(value);
}

export interface EwbPayload {
  supplyType: 'O';
  subSupplyType: '1';
  docType: 'INV';
  docNo: string;
  docDate: string;
  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromPlace: string;
  fromPincode: number;
  fromStateCode: number;
  actFromStateCode: number;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toPlace: string;
  toPincode: number;
  toStateCode: number;
  actToStateCode: number;
  transactionType: 1;
  itemList: [
    {
      itemNo: 1;
      productDesc: string;
      hsnCode: number;
      quantity: 1;
      qtyUnit: 'OTH';
      taxableAmount: number;
      cgstRate: number;
      sgstRate: number;
      igstRate: number;
      cessRate: 0;
    },
  ];
  totalValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: 0;
  totInvValue: number;
  transMode: '1' | '2' | '3' | '4';
  transDistance: string;
  transporterId?: string;
  transporterName?: string;
  vehicleNo?: string;
  transDocNo?: string;
  transDocDate?: string;
}

export function buildEwbPayload(input: EwbInput): EwbPayload {
  // The submit froze the split, and the 0035 split-coherence CHECK pins
  // its shape: IGST above zero IS the inter-state branch. (A nil-rated
  // inter-state supply reads as intra here, but every rate on the line
  // is zero then, so the emitted numbers are identical either way.)
  const interState = toAmount(input.igstAmount) > 0;
  const half = halveRate(input.gstRate);
  return {
    supplyType: 'O',
    subSupplyType: '1',
    docType: 'INV',
    docNo: input.invoiceNumber,
    docDate: formatNicDate(input.invoiceDate),
    fromGstin: input.seller.gstin ?? 'URP',
    fromTrdName: input.seller.tradeName,
    fromAddr1: input.seller.address,
    fromPlace: input.seller.location,
    fromPincode: Number(input.fromPincode),
    fromStateCode: Number(input.seller.stateCode),
    actFromStateCode: Number(input.seller.stateCode),
    toGstin: input.buyer.gstin ?? 'URP',
    toTrdName: input.buyer.tradeName,
    toAddr1: input.buyer.address,
    toPlace: input.buyer.location,
    toPincode: Number(input.toPincode),
    toStateCode: Number(input.buyer.stateCode),
    actToStateCode: Number(input.buyer.stateCode),
    transactionType: 1,
    itemList: [
      {
        itemNo: 1,
        productDesc: input.serviceDescription,
        hsnCode: Number(input.sacCode),
        quantity: 1,
        qtyUnit: 'OTH',
        taxableAmount: toAmount(input.taxableValue),
        cgstRate: interState ? 0 : half,
        sgstRate: interState ? 0 : half,
        igstRate: interState ? toAmount(input.gstRate) : 0,
        cessRate: 0,
      },
    ],
    totalValue: toAmount(input.taxableValue),
    cgstValue: toAmount(input.cgstAmount),
    sgstValue: toAmount(input.sgstAmount),
    igstValue: toAmount(input.igstAmount),
    cessValue: 0,
    totInvValue: toAmount(input.totalAmount),
    transMode: TRANS_MODES[input.transportMode],
    transDistance: String(input.distanceKm),
    ...(input.transporterId !== null ? { transporterId: input.transporterId } : {}),
    ...(input.transporterName !== null
      ? { transporterName: input.transporterName }
      : {}),
    ...(input.transportMode === 'road'
      ? { vehicleNo: input.vehicleNumber ?? '' }
      : {
          transDocNo: input.transportDocNumber ?? '',
          transDocDate:
            input.transportDocDate === null
              ? ''
              : formatNicDate(input.transportDocDate),
        }),
  };
}
