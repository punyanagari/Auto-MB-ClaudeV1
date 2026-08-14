import { describe, expect, it } from 'vitest';
import {
  buildDirectEwayBillPayload,
  type EwayCarriage,
} from '../src/gsp/eway-payload.js';
import type { EwayBillSourceFacts, EwaySourceLine } from '../src/gsp/eway-source.js';

/**
 * NIC-wire correctness for the challan (direct-generation) payload,
 * ADR-0013. These are the facts that reach a statutory filing, so a wrong
 * value here is a wrong government declaration, not a display bug.
 */

function line(overrides: Partial<EwaySourceLine> = {}): EwaySourceLine {
  return {
    position: 1,
    isService: false,
    hsnSacCode: '84213900',
    description: 'Point machine',
    quantity: '2.000',
    unitLabel: 'Nos',
    taxableValue: '1000.00',
    ...overrides,
  };
}

function source(overrides: Partial<EwayBillSourceFacts> = {}): EwayBillSourceFacts {
  return {
    kind: 'delivery_challan',
    id: 'challan-1',
    documentNumber: 'DC/1',
    documentDate: '2026-08-15',
    supplier: {
      name: 'Consignor Rail Works',
      gstin: '29ABCDE1234F1Z5',
      address: 'Yard Road, Bengaluru',
      stateCode: '29',
      pincode: '560001',
    },
    consignee: {
      name: 'Vendor Pvt Ltd',
      gstin: '27ABCDE1234F1Z5',
      address: 'Depot Lane, Mumbai',
      stateCode: '27',
      pincode: '400001',
    },
    lines: [line()],
    movementReason: 'supply',
    irn: null,
    ...overrides,
  };
}

function carriage(overrides: Partial<EwayCarriage> = {}): EwayCarriage {
  return {
    transportMode: 'road',
    transporterId: null,
    transporterName: null,
    vehicleNumber: 'KA01AB1234',
    transportDocNumber: null,
    transportDocDate: null,
    distanceKm: 12,
    fromPincode: '560001',
    toPincode: '400001',
    ...overrides,
  };
}

interface WireItem {
  readonly hsnCode: unknown;
  readonly qtyUnit: unknown;
}
function firstItem(payload: unknown): WireItem {
  const list = (payload as { itemList: WireItem[] }).itemList;
  const item = list[0];
  if (item === undefined) throw new Error('payload carried no item');
  return item;
}

describe('e-way bill direct payload — HSN is an identifier, not a number', () => {
  it('sends a chapter-01 HSN as a string with its leading zero intact', () => {
    const payload = buildDirectEwayBillPayload(
      source({ lines: [line({ hsnSacCode: '01012100' })] }),
      carriage(),
    );
    // A leading zero survives: exactJsonInteger would have stripped it to
    // 1012100, declaring a different commodity to NIC.
    expect(firstItem(payload).hsnCode).toBe('01012100');
  });
});

describe('e-way bill direct payload — the quantity unit is a UQC or OTH', () => {
  it("maps a free-text 'm' to OTH rather than an invented code", () => {
    const payload = buildDirectEwayBillPayload(
      source({ lines: [line({ unitLabel: 'm' })] }),
      carriage(),
    );
    expect(firstItem(payload).qtyUnit).toBe('OTH');
  });

  it("maps 'each' to OTH, never a truncated 'EAC'", () => {
    const payload = buildDirectEwayBillPayload(
      source({ lines: [line({ unitLabel: 'each' })] }),
      carriage(),
    );
    expect(firstItem(payload).qtyUnit).toBe('OTH');
  });

  it('passes a label that is already a valid UQC through verbatim', () => {
    const payload = buildDirectEwayBillPayload(
      source({ lines: [line({ unitLabel: 'mtr' })] }),
      carriage(),
    );
    expect(firstItem(payload).qtyUnit).toBe('MTR');
  });
});

describe('e-way bill direct payload — the consignee state code is required', () => {
  it('refuses a URP consignee whose master carries no state code', () => {
    let thrown: unknown;
    try {
      buildDirectEwayBillPayload(
        source({
          consignee: {
            name: 'Unregistered Buyer',
            gstin: null,
            address: 'Somewhere',
            stateCode: null,
            pincode: null,
          },
        }),
        carriage(),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe('EWAY_SOURCE_FACTS_INCOMPLETE');
    expect((thrown as { message?: string }).message).toContain(
      "consignee's state code",
    );
  });
});
