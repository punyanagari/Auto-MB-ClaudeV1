/**
 * Legacy standalone NIC EWB-01 payload builder.
 *
 * The current invoice model is a cumulative service/SAC invoice, so direct
 * production generation from this payload is deliberately gated by the route.
 * The builder remains for historical records, sandbox contract testing, and a
 * future goods/DC model. Exact statutory numbers never use Number().
 */

import { formatNicDate } from './irp-payload.js';
import {
  exactJsonInteger,
  exactJsonNumber,
  type ExactJsonNumber,
} from './statutory-json.js';

const TRANS_MODES = { road: '1', rail: '2', air: '3', ship: '4' } as const;
export type EwbTransportMode = keyof typeof TRANS_MODES;

export interface EwbPartyInput {
  gstin: string | null;
  tradeName: string;
  address: string;
  location: string;
  stateCode: string;
}

export interface EwbInput {
  invoiceNumber: string;
  invoiceDate: string;
  sacCode: string;
  serviceDescription: string;
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
  transportDocDate: string | null;
  distanceKm: number;
  fromPincode: string;
  toPincode: string;
}

function positiveDecimal(value: string): boolean {
  // Anchored decimal grammar; input length is bounded by DB numeric columns.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(?:0|([1-9][0-9]*))(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new Error(`Invalid non-negative decimal: ${value}`);
  return BigInt(match[1] ?? '0') > 0n || /[1-9]/.test(match[2] ?? '');
}

/** Exact division of a <=2dp rate by two. 0.25 becomes 0.125. */
function halfRate(rate: string): string {
  // Anchored rate grammar with a maximum two-digit fractional part.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(rate);
  if (!match) throw new Error(`Invalid GST rate: ${rate}`);
  const hundredths =
    BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  const thousandths = hundredths * 5n;
  const whole = thousandths / 1000n;
  const fraction = (thousandths % 1000n)
    .toString()
    .padStart(3, '0')
    .replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
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
  fromPincode: ExactJsonNumber;
  fromStateCode: ExactJsonNumber;
  actFromStateCode: ExactJsonNumber;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toPlace: string;
  toPincode: ExactJsonNumber;
  toStateCode: ExactJsonNumber;
  actToStateCode: ExactJsonNumber;
  transactionType: 1;
  itemList: [
    {
      itemNo: 1;
      productDesc: string;
      hsnCode: ExactJsonNumber;
      quantity: ExactJsonNumber;
      qtyUnit: 'OTH';
      taxableAmount: ExactJsonNumber;
      cgstRate: ExactJsonNumber;
      sgstRate: ExactJsonNumber;
      igstRate: ExactJsonNumber;
      cessRate: ExactJsonNumber;
    },
  ];
  totalValue: ExactJsonNumber;
  cgstValue: ExactJsonNumber;
  sgstValue: ExactJsonNumber;
  igstValue: ExactJsonNumber;
  cessValue: ExactJsonNumber;
  totInvValue: ExactJsonNumber;
  transMode: '1' | '2' | '3' | '4';
  transDistance: string;
  transporterId?: string;
  transporterName?: string;
  vehicleNo?: string;
  transDocNo?: string;
  transDocDate?: string;
}

export function buildEwbPayload(input: EwbInput): EwbPayload {
  const interState = positiveDecimal(input.igstAmount);
  const half = exactJsonNumber(halfRate(input.gstRate));
  const zero = exactJsonNumber('0');
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
    fromPincode: exactJsonInteger(input.fromPincode),
    fromStateCode: exactJsonInteger(input.seller.stateCode),
    actFromStateCode: exactJsonInteger(input.seller.stateCode),
    toGstin: input.buyer.gstin ?? 'URP',
    toTrdName: input.buyer.tradeName,
    toAddr1: input.buyer.address,
    toPlace: input.buyer.location,
    toPincode: exactJsonInteger(input.toPincode),
    toStateCode: exactJsonInteger(input.buyer.stateCode),
    actToStateCode: exactJsonInteger(input.buyer.stateCode),
    transactionType: 1,
    itemList: [
      {
        itemNo: 1,
        productDesc: input.serviceDescription,
        hsnCode: exactJsonInteger(input.sacCode),
        quantity: exactJsonNumber('1'),
        qtyUnit: 'OTH',
        taxableAmount: exactJsonNumber(input.taxableValue),
        cgstRate: interState ? zero : half,
        sgstRate: interState ? zero : half,
        igstRate: interState ? exactJsonNumber(input.gstRate) : zero,
        cessRate: zero,
      },
    ],
    totalValue: exactJsonNumber(input.taxableValue),
    cgstValue: exactJsonNumber(input.cgstAmount),
    sgstValue: exactJsonNumber(input.sgstAmount),
    igstValue: exactJsonNumber(input.igstAmount),
    cessValue: zero,
    totInvValue: exactJsonNumber(input.totalAmount),
    transMode: TRANS_MODES[input.transportMode],
    transDistance: String(input.distanceKm),
    ...(input.transporterId === null ? {} : { transporterId: input.transporterId }),
    ...(input.transporterName === null
      ? {}
      : { transporterName: input.transporterName }),
    ...(input.transportMode === 'road'
      ? { vehicleNo: input.vehicleNumber ?? '' }
      : {
          transDocNo: input.transportDocNumber ?? '',
          transDocDate:
            input.transportDocDate === null ? '' : formatNicDate(input.transportDocDate),
        }),
  };
}
