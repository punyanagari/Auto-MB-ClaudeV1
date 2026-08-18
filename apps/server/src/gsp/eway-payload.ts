import { httpError } from '../http.js';
import { paiseText } from '../money.js';
import type { EwayBillSourceFacts } from './eway-source.js';
import { exactJsonInteger, exactJsonNumber } from './statutory-json.js';

/**
 * The NIC e-way bill payloads, built from the goods model (ADR-0013).
 *
 * The builders deleted as dead code after the 2026-08-10 disposition are
 * deliberately NOT resurrected from history: they were written against the
 * cumulative-service invoice this product used to be the only producer of,
 * and the shapes they read no longer exist. What follows is written
 * against `EwayBillSourceFacts`, which both source documents resolve to.
 *
 * Two payloads, because NIC offers two doors:
 *
 *   - the INVOICE path uses generation by IRN. The IRP already holds every
 *     item and party fact from the e-invoice, so the payload carries the
 *     IRN and the carriage particulars and nothing else. Sending the items
 *     again would invite a disagreement between two records of one
 *     document.
 *   - the CHALLAN path uses direct generation, which has no IRN behind it
 *     and therefore states everything: parties, items, taxable values and
 *     carriage.
 *
 * Money and quantities travel as exact decimal lexemes through
 * `exactJsonNumber`; no authoritative figure is put through a JavaScript
 * float on its way to the government (rule 5).
 *
 * NOTE (ADR-0013 consequence): the sandbox certification of 12 August
 * covered IRN registration and EWB authentication only. These payloads
 * have not been exercised against NIC and the certification must be re-run
 * before production use.
 */

/** NIC's sub-supply-type codes for the movement reasons this product
 * records. The vocabulary is NIC's; the names are the product's. */
const SUB_SUPPLY_TYPE: Record<EwayBillSourceFacts['movementReason'], string> = {
  supply: '1',
  job_work: '4',
  for_own_use: '5',
  others: '8',
};

/** NIC's transport-mode codes. */
const TRANS_MODE: Record<string, string> = {
  road: '1',
  rail: '2',
  air: '3',
  ship: '4',
};

/** NIC's closed Unit Quantity Code list. The wire will only accept a code
 * from this set; a free-text trade unit ('m', 'each', 'metre') is not one
 * and inventing a mapping would put a false claim on a statutory filing.
 * A label is sent through only when it is already a UQC verbatim; anything
 * else becomes 'OTH', the same refusal the IRP item builder documents. */
const UQC_CODES: ReadonlySet<string> = new Set([
  'BAG',
  'BAL',
  'BDL',
  'BKL',
  'BOU',
  'BOX',
  'BTL',
  'BUN',
  'CAN',
  'CBM',
  'CCM',
  'CMS',
  'CTN',
  'DOZ',
  'DRM',
  'GGK',
  'GMS',
  'GRS',
  'GYD',
  'KGS',
  'KLR',
  'KME',
  'LTR',
  'MLT',
  'MTR',
  'MTS',
  'NOS',
  'PAC',
  'PCS',
  'PRS',
  'QTL',
  'ROL',
  'SET',
  'SQF',
  'SQM',
  'SQY',
  'TBS',
  'TGM',
  'THD',
  'TON',
  'TUB',
  'UGS',
  'UNT',
  'YDS',
  'OTH',
]);

/** A source line's free-text unit, resolved to a NIC UQC. Only an exact
 * (case-insensitive) match to a real UQC survives; every other label —
 * 'm', 'each', 'metre' — is 'OTH'. Never truncate-to-fit: 'metre'.slice(3)
 * is 'MET', which is not a UQC and which NIC would reject or, worse,
 * silently mis-read as a different unit. */
function qtyUnitCode(unitLabel: string | null): string {
  if (unitLabel === null) return 'OTH';
  const candidate = unitLabel.trim().toUpperCase();
  return UQC_CODES.has(candidate) ? candidate : 'OTH';
}

/** The carriage facts as the e-way bill row holds them. The row is
 * authoritative for the wire: it is the record the carriage CHECK measures
 * and the one an operator edits while the bill is a draft. */
export interface EwayCarriage {
  readonly transportMode: string;
  readonly transporterId: string | null;
  readonly transporterName: string | null;
  readonly vehicleNumber: string | null;
  readonly transportDocNumber: string | null;
  readonly transportDocDate: string | null;
  readonly distanceKm: number;
  readonly fromPincode: string;
  readonly toPincode: string;
}

/** `YYYY-MM-DD` to NIC's `DD/MM/YYYY`, without constructing a Date — a
 * date-only legal value must not be timezone-round-tripped (rule 6). */
function nicDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`not a date-only value: ${iso}`);
  return `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''}`;
}

function transModeCode(mode: string): string {
  const code = TRANS_MODE[mode];
  if (code === undefined) throw new Error(`unknown transport mode: ${mode}`);
  return code;
}

/** Everything the challan payload needs and the source document may not
 * have recorded. Named as one refusal rather than eight so an operator
 * fixes the document once. */
function assertDirectPayloadComplete(
  source: EwayBillSourceFacts,
  carriage: EwayCarriage,
): void {
  const missing: string[] = [];
  if (source.supplier.gstin === null) missing.push("the organisation's GSTIN");
  if (source.supplier.stateCode === null) missing.push("the organisation's state code");
  if (source.supplier.address.trim().length === 0) {
    missing.push("the organisation's address");
  }
  if (source.consignee.address.trim().length === 0) {
    missing.push("the consignee's address");
  }
  // Every other party fact is checked here; the consignee state code was
  // the one omission, and buildDirectEwayBillPayload defaults a null to
  // '0' — a toStateCode of 0 is not a state, so an unregistered consignee
  // whose contact master carries no state code would sail onto the wire
  // as a false declaration. Refuse it by name instead.
  if (source.consignee.stateCode === null) {
    missing.push("the consignee's state code");
  }
  if (source.documentNumber.trim().length === 0) {
    missing.push('the challan number, which is assigned at issue');
  }
  if (missing.length > 0) {
    throw httpError(
      409,
      'EWAY_SOURCE_FACTS_INCOMPLETE',
      `NIC needs ${missing.join(', ')} on this e-way bill and the record does not carry it. Complete the organisation profile and the challan, then try again.`,
    );
  }
  // The carriage rule is the 0035 CHECK and the route asserts it before
  // reaching here; this is the assertion restated where the payload would
  // otherwise silently omit the field.
  if (carriage.transportMode === 'road' && carriage.vehicleNumber === null) {
    throw httpError(
      400,
      'VEHICLE_REQUIRED',
      'A road movement names the vehicle — set vehicleNumber on the e-way bill first.',
    );
  }
}

/** Generation by IRN: the invoice path.
 *
 * `Irn` is load-bearing beyond the payload — the Whitebooks adapter
 * refuses to send a body whose Irn is not the one the call names, so the
 * two can never drift apart. */
export function buildEwayBillByIrnPayload(
  source: EwayBillSourceFacts,
  carriage: EwayCarriage,
): unknown {
  if (source.irn === null) {
    // Reachable through the payload-preview route on an invoice that has
    // not been registered at the IRP, so it is a named refusal rather
    // than a bare Error the operator reads as a 500.
    throw httpError(
      409,
      'EWAY_IRP_REGISTRATION_REQUIRED',
      'This invoice has no IRN yet, and the invoice path generates an e-way bill BY IRN. Register the invoice at the IRP first.',
    );
  }
  return {
    Irn: source.irn,
    Distance: exactJsonInteger(String(carriage.distanceKm)),
    TransMode: transModeCode(carriage.transportMode),
    TransId: carriage.transporterId,
    TransName: carriage.transporterName,
    TransDocDt:
      carriage.transportDocDate === null ? null : nicDate(carriage.transportDocDate),
    TransDocNo: carriage.transportDocNumber,
    VehNo: carriage.vehicleNumber,
    // Regular, as against ODC (over-dimensional cargo). The product has no
    // way to record ODC and must not guess one.
    VehType: carriage.vehicleNumber === null ? null : 'R',
  };
}

/** Direct generation: the challan path.
 *
 * Tax heads are stated as zero rather than omitted. A delivery challan is
 * not a tax document — it declares no GST, which is precisely why it is
 * accompanied by one when tax is due — and NIC's direct-generation call
 * reads absent tax fields as unstated rather than as nil. Saying zero says
 * what is true about this document. */
export function buildDirectEwayBillPayload(
  source: EwayBillSourceFacts,
  carriage: EwayCarriage,
): unknown {
  assertDirectPayloadComplete(source, carriage);
  const totalValue = sumDecimals(source.lines.map((line) => line.taxableValue));
  return {
    supplyType: 'O',
    subSupplyType: SUB_SUPPLY_TYPE[source.movementReason],
    docType: 'CHL',
    docNo: source.documentNumber,
    docDate: nicDate(source.documentDate),
    fromGstin: source.supplier.gstin,
    fromTrdName: source.supplier.name,
    fromAddr1: source.supplier.address,
    fromPlace: source.supplier.address,
    fromPincode: exactJsonInteger(carriage.fromPincode),
    actFromStateCode: exactJsonInteger(source.supplier.stateCode ?? '0'),
    fromStateCode: exactJsonInteger(source.supplier.stateCode ?? '0'),
    // NIC's own convention for an unregistered counterparty. A consignee
    // with no GSTIN is lawful and common on a job-work or own-use
    // movement; inventing a registration for one would be a false
    // declaration.
    toGstin: source.consignee.gstin ?? 'URP',
    toTrdName: source.consignee.name,
    toAddr1: source.consignee.address,
    toPlace: source.consignee.address,
    toPincode: exactJsonInteger(carriage.toPincode),
    actToStateCode: exactJsonInteger(source.consignee.stateCode ?? '0'),
    toStateCode: exactJsonInteger(source.consignee.stateCode ?? '0'),
    transactionType: 1,
    totalValue: exactJsonNumber(totalValue),
    cgstValue: exactJsonNumber('0'),
    sgstValue: exactJsonNumber('0'),
    igstValue: exactJsonNumber('0'),
    cessValue: exactJsonNumber('0'),
    totInvValue: exactJsonNumber(totalValue),
    transporterId: carriage.transporterId,
    transporterName: carriage.transporterName,
    transDocNo: carriage.transportDocNumber,
    transMode: transModeCode(carriage.transportMode),
    transDistance: exactJsonInteger(String(carriage.distanceKm)),
    transDocDate:
      carriage.transportDocDate === null ? null : nicDate(carriage.transportDocDate),
    vehicleNo: carriage.vehicleNumber,
    vehicleType: carriage.vehicleNumber === null ? null : 'R',
    itemList: source.lines.map((line) => ({
      productName: line.description.slice(0, 100),
      productDesc: line.description.slice(0, 100),
      // HSN is an identifier, not a quantity: exactJsonInteger would strip
      // a chapter-01 code's leading zero (01012100 -> 1012100) and declare
      // a different commodity. It travels as the string it is, exactly as
      // the IRP item builder sends HsnCd.
      hsnCode: line.hsnSacCode,
      quantity: exactJsonNumber(trimDecimal(line.quantity)),
      qtyUnit: qtyUnitCode(line.unitLabel),
      cgstRate: exactJsonNumber('0'),
      sgstRate: exactJsonNumber('0'),
      igstRate: exactJsonNumber('0'),
      cessRate: exactJsonNumber('0'),
      taxableAmount: exactJsonNumber(trimDecimal(line.taxableValue)),
    })),
  };
}

/** Exact decimal addition over the paisa, with no float anywhere in it.
 * PostgreSQL hands these over as text precisely so they can stay text. */
export function sumDecimals(values: readonly string[]): string {
  let paise = 0n;
  for (const value of values) {
    paise += toPaise(value);
  }
  return paiseText(paise);
}

/** Deliberately LAXER than `money.ts`'s parser, which is why it stays
 * here. A tax-invoice snapshot's `decimal` grammar permits any number of
 * fraction digits, so a frozen '100.000' reaches this builder legitimately
 * and means 10000 paise; only a genuinely non-zero sub-paisa digit is a
 * refusal, and it gets a message of its own naming that. The shared parser
 * would reject both alike. */
function toPaise(value: string): bigint {
  // Anchored, and every repetition consumes a digit that no other branch
  // can also consume: linear on all inputs.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal value: ${value}`);
  const fraction = (match[3] ?? '').padEnd(2, '0');
  if (fraction.slice(2).replace(/0/g, '').length > 0) {
    throw new Error(`decimal value carries sub-paisa precision: ${value}`);
  }
  const magnitude = BigInt(match[2] ?? '0') * 100n + BigInt(fraction.slice(0, 2));
  return match[1] === '-' ? -magnitude : magnitude;
}

/** `12.000` reads as `12` on the wire without touching a float: NIC's
 * quantity field takes a plain decimal and trailing zeroes only invite a
 * mismatch when the portal echoes the value back. */
function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed.length === 0 ? '0' : trimmed;
}
