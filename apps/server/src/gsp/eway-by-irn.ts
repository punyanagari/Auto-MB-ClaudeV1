import type { TransportMode } from '@auto-mb/contracts';
import {
  parseTaxInvoiceIssuedSnapshot,
  type TaxInvoiceIssuedSnapshot,
} from '../tax-invoice-snapshot.js';
import { formatNicDate } from './irp-payload.js';
import { exactJsonInteger, stringifyStatutoryJson } from './statutory-json.js';

export class EwayByIrnPayloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EwayByIrnPayloadError';
  }
}

export interface EwayByIrnFacts {
  readonly irn: string;
  readonly transportMode: TransportMode;
  readonly transporterId: string | null;
  readonly transporterName: string | null;
  readonly vehicleNumber: string | null;
  readonly transportDocNumber: string | null;
  readonly transportDocDate: string | null;
  readonly distanceKm: number;
  readonly fromPincode: string;
  readonly toPincode: string;
}

const TRANS_MODE: Record<TransportMode, string> = {
  road: '1',
  rail: '2',
  air: '3',
  ship: '4',
};

function validateLocations(
  snapshot: TaxInvoiceIssuedSnapshot,
  input: EwayByIrnFacts,
): void {
  const destination = snapshot.shipTo ?? snapshot.buyer;
  if (input.fromPincode !== snapshot.supplier.pincode) {
    throw new EwayByIrnPayloadError(
      'EWAY_DISPATCH_SNAPSHOT_MISMATCH',
      'The draft From PIN differs from the frozen supplier PIN. A different dispatch address needs a fully snapshotted dispatch model before provider generation.',
    );
  }
  if (input.toPincode !== destination.pincode) {
    throw new EwayByIrnPayloadError(
      'EWAY_DELIVERY_SNAPSHOT_MISMATCH',
      'The draft To PIN differs from the frozen ship-to/buyer PIN. A different delivery address needs a fully snapshotted delivery model before provider generation.',
    );
  }
}

/** Whitebooks' GENERATE_EWAYBILL-by-IRN payload. The registered IRN owns
 * the item and tax facts; this payload adds only frozen-consistent carriage
 * facts. It never re-expresses a service SAC as a standalone goods line. */
export function buildEwayByIrnPayload(
  issuedSnapshot: unknown,
  input: EwayByIrnFacts,
): string {
  const snapshot = parseTaxInvoiceIssuedSnapshot(issuedSnapshot);
  validateLocations(snapshot, input);
  const payload: Record<string, unknown> = {
    Irn: input.irn,
    Distance: exactJsonInteger(String(input.distanceKm)),
    TransMode: TRANS_MODE[input.transportMode],
    ...(input.transporterId === null ? {} : { TransId: input.transporterId }),
    ...(input.transporterName === null ? {} : { TransName: input.transporterName }),
  };
  if (input.transportMode === 'road') {
    if (input.vehicleNumber === null) {
      throw new EwayByIrnPayloadError(
        'VEHICLE_REQUIRED',
        'A road movement requires a vehicle number.',
      );
    }
    payload.VehNo = input.vehicleNumber;
    payload.VehType = 'R';
  } else {
    if (input.transportDocNumber === null || input.transportDocDate === null) {
      throw new EwayByIrnPayloadError(
        'TRANSPORT_DOC_REQUIRED',
        `A ${input.transportMode} movement requires its transport document number and date.`,
      );
    }
    payload.TransDocNo = input.transportDocNumber;
    payload.TransDocDt = formatNicDate(input.transportDocDate);
  }
  return stringifyStatutoryJson(payload);
}
