/** Strict parser for the immutable tax-invoice snapshot frozen at submit. */

import { buildIrpPayload, type IrpPayload } from './gsp/irp-payload.js';
import { amountInWords as renderAmountInWords } from './amount-in-words.js';

export interface FrozenParty {
  readonly designation: string;
  readonly contactPerson: string | null;
  readonly gstin: string | null;
  readonly address: string;
  readonly stateCode: string;
  readonly pincode: string;
  readonly locality: string | null;
}

export interface FrozenSupplier {
  readonly name: string;
  readonly tradeName: string | null;
  readonly gstin: string;
  readonly address: string;
  readonly stateCode: string;
  readonly pincode: string;
  readonly locality: string | null;
  readonly phone: string | null;
  readonly msmeNumber: string | null;
}

export interface TaxInvoiceIssuedSnapshotV1 {
  readonly templateVersion: 'ti-v1';
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly fyLabel: string | null;
  readonly supplier: FrozenSupplier;
  readonly buyer: FrozenParty;
  readonly shipTo: FrozenParty | null;
  readonly placeOfSupply: string;
  /** FALSE is an explicit forward-charge confirmation. NULL means a
   * historical snapshot did not capture the fact; it must not render or go
   * to IRP. Reverse charge is not supported by this module yet. */
  readonly reverseChargeApplicable: boolean | null;
  readonly customerPoReference: string | null;
  readonly line: {
    readonly sacCode: string;
    readonly description: string;
    readonly quantity: string;
    readonly unitLabel: string;
    readonly rate: string;
    readonly gstRate: string;
    readonly amount: string;
    readonly lineValue: string;
  };
  readonly totals: {
    readonly taxableValue: string;
    readonly cgstAmount: string;
    readonly sgstAmount: string;
    readonly igstAmount: string;
    readonly roundOff: string;
    readonly totalAmount: string;
  };
  readonly amountInWords: string;
  readonly notes: string | null;
}

export class TaxInvoiceSnapshotError extends Error {
  readonly code = 'TAX_INVOICE_SNAPSHOT_INVALID';
}

export class EInvoiceB2cUnsupportedError extends Error {
  readonly code = 'E_INVOICE_B2C_UNSUPPORTED';

  constructor() {
    super(
      'Whitebooks IRP registration is enabled only for a frozen buyer GSTIN; this unregistered-buyer invoice remains valid locally but cannot be submitted through the B2B adapter.',
    );
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaxInvoiceSnapshotError(`${path} is not an object`);
  }
  return value as JsonObject;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaxInvoiceSnapshotError(`${path} is not a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, path);
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') {
    throw new TaxInvoiceSnapshotError(`${path} is not a boolean`);
  }
  return value;
}

function decimal(value: unknown, path: string): string {
  const parsed = text(value, path);
  // Fully anchored decimal grammar; each repetition consumes one digit.
  // eslint-disable-next-line security/detect-unsafe-regex
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(parsed)) {
    throw new TaxInvoiceSnapshotError(`${path} is not an exact decimal string`);
  }
  return parsed;
}

function party(value: unknown, path: string): FrozenParty {
  const row = object(value, path);
  const stateCode = text(row.stateCode, `${path}.stateCode`);
  const pincode = text(row.pincode, `${path}.pincode`);
  if (!/^[0-9]{2}$/.test(stateCode)) {
    throw new TaxInvoiceSnapshotError(`${path}.stateCode is invalid`);
  }
  if (!/^[0-9]{6}$/.test(pincode)) {
    throw new TaxInvoiceSnapshotError(`${path}.pincode is invalid`);
  }
  const gstin = nullableText(row.gstin, `${path}.gstin`);
  return {
    designation: text(row.designation, `${path}.designation`),
    contactPerson: nullableText(row.contactPerson, `${path}.contactPerson`),
    gstin,
    address: text(row.address, `${path}.address`),
    stateCode,
    pincode,
    locality: nullableText(row.locality, `${path}.locality`),
  };
}

function supplier(value: unknown): FrozenSupplier {
  const row = object(value, 'issuedSnapshot.supplier');
  const stateCode = text(row.stateCode, 'issuedSnapshot.supplier.stateCode');
  const pincode = text(row.pincode, 'issuedSnapshot.supplier.pincode');
  const gstin = text(row.gstin, 'issuedSnapshot.supplier.gstin');
  if (!/^[0-9]{2}$/.test(stateCode)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.supplier.stateCode is invalid');
  }
  if (!/^[0-9]{6}$/.test(pincode)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.supplier.pincode is invalid');
  }
  return {
    name: text(row.name, 'issuedSnapshot.supplier.name'),
    tradeName: nullableText(row.tradeName, 'issuedSnapshot.supplier.tradeName'),
    gstin,
    address: text(row.address, 'issuedSnapshot.supplier.address'),
    stateCode,
    pincode,
    locality: nullableText(row.locality, 'issuedSnapshot.supplier.locality'),
    phone: nullableText(row.phone, 'issuedSnapshot.supplier.phone'),
    msmeNumber: nullableText(row.msmeNumber, 'issuedSnapshot.supplier.msmeNumber'),
  };
}

function scaledPaise(value: string, path: string): bigint {
  // Fully anchored, with a fraction bounded to two digits.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) throw new TaxInvoiceSnapshotError(`${path} is not a 2dp amount`);
  const sign = match[1] === '-' ? -1n : 1n;
  return sign * (BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
}

function paiseText(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function parseTaxInvoiceIssuedSnapshot(
  value: unknown,
): TaxInvoiceIssuedSnapshotV1 {
  const root = object(value, 'issuedSnapshot');
  if (root.templateVersion !== 'ti-v1') {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.templateVersion is unsupported');
  }
  const line = object(root.line, 'issuedSnapshot.line');
  const totals = object(root.totals, 'issuedSnapshot.totals');
  const taxableValue = decimal(
    totals.taxableValue,
    'issuedSnapshot.totals.taxableValue',
  );
  const cgstAmount = decimal(totals.cgstAmount, 'issuedSnapshot.totals.cgstAmount');
  const sgstAmount = decimal(totals.sgstAmount, 'issuedSnapshot.totals.sgstAmount');
  const igstAmount = decimal(totals.igstAmount, 'issuedSnapshot.totals.igstAmount');
  const lineValue =
    line.lineValue === undefined
      ? paiseText(
          scaledPaise(taxableValue, 'taxableValue') +
            scaledPaise(cgstAmount, 'cgstAmount') +
            scaledPaise(sgstAmount, 'sgstAmount') +
            scaledPaise(igstAmount, 'igstAmount'),
        )
      : decimal(line.lineValue, 'issuedSnapshot.line.lineValue');
  const invoiceDate = text(root.invoiceDate, 'issuedSnapshot.invoiceDate');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(invoiceDate)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.invoiceDate is invalid');
  }
  const shipTo = root.shipTo === null ? null : party(root.shipTo, 'issuedSnapshot.shipTo');
  const totalAmount = decimal(
    totals.totalAmount,
    'issuedSnapshot.totals.totalAmount',
  );
  const fyLabel = nullableText(root.fyLabel, 'issuedSnapshot.fyLabel');
  if (fyLabel !== null && !/^[0-9]{4}-[0-9]{2}$/.test(fyLabel)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.fyLabel is invalid');
  }
  return {
    templateVersion: 'ti-v1',
    invoiceNumber: text(root.invoiceNumber, 'issuedSnapshot.invoiceNumber'),
    invoiceDate,
    fyLabel,
    supplier: supplier(root.supplier),
    buyer: party(root.buyer, 'issuedSnapshot.buyer'),
    shipTo,
    placeOfSupply: text(root.placeOfSupply, 'issuedSnapshot.placeOfSupply'),
    reverseChargeApplicable: nullableBoolean(
      root.reverseChargeApplicable,
      'issuedSnapshot.reverseChargeApplicable',
    ),
    customerPoReference: nullableText(
      root.customerPoReference,
      'issuedSnapshot.customerPoReference',
    ),
    line: {
      sacCode: text(line.sacCode, 'issuedSnapshot.line.sacCode'),
      description: text(line.description, 'issuedSnapshot.line.description'),
      quantity: decimal(line.quantity, 'issuedSnapshot.line.quantity'),
      unitLabel: text(line.unitLabel, 'issuedSnapshot.line.unitLabel'),
      rate: decimal(line.rate, 'issuedSnapshot.line.rate'),
      gstRate: decimal(line.gstRate, 'issuedSnapshot.line.gstRate'),
      amount: decimal(line.amount, 'issuedSnapshot.line.amount'),
      lineValue,
    },
    totals: {
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      roundOff: decimal(totals.roundOff, 'issuedSnapshot.totals.roundOff'),
      totalAmount,
    },
    amountInWords:
      root.amountInWords === undefined
        ? renderAmountInWords(totalAmount)
        : text(root.amountInWords, 'issuedSnapshot.amountInWords'),
    notes: nullableText(root.notes, 'issuedSnapshot.notes'),
  };
}

/** Build the provider payload exclusively from frozen issued facts. */
export function buildFrozenIrpPayload(value: unknown): IrpPayload {
  const snapshot = parseTaxInvoiceIssuedSnapshot(value);
  if (snapshot.reverseChargeApplicable !== false) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.reverseChargeApplicable must explicitly confirm forward charge',
    );
  }
  if (snapshot.buyer.gstin === null) throw new EInvoiceB2cUnsupportedError();
  if (snapshot.supplier.locality === null) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.supplier.locality is missing; NIC locality is never inferred',
    );
  }
  if (snapshot.buyer.locality === null) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot.buyer.locality is missing; NIC locality is never inferred',
    );
  }
  const frozenShipTo = (() => {
    if (snapshot.shipTo === null) return null;
    const gstin = snapshot.shipTo.gstin;
    const locality = snapshot.shipTo.locality;
    if (gstin === null || locality === null) {
      throw new TaxInvoiceSnapshotError(
        'issuedSnapshot.shipTo needs GSTIN and explicit locality for NIC',
      );
    }
    return {
      gstin,
      legalName: snapshot.shipTo.designation,
      address: snapshot.shipTo.address,
      location: locality,
      pincode: snapshot.shipTo.pincode,
      stateCode: snapshot.shipTo.stateCode,
    };
  })();
  return buildIrpPayload({
    invoiceNumber: snapshot.invoiceNumber,
    invoiceDate: snapshot.invoiceDate,
    sacCode: snapshot.line.sacCode,
    serviceDescription: snapshot.line.description,
    placeOfSupply: snapshot.placeOfSupply,
    reverseChargeApplicable: snapshot.reverseChargeApplicable,
    gstRate: snapshot.line.gstRate,
    taxableValue: snapshot.totals.taxableValue,
    cgstAmount: snapshot.totals.cgstAmount,
    sgstAmount: snapshot.totals.sgstAmount,
    igstAmount: snapshot.totals.igstAmount,
    totalAmount: snapshot.totals.totalAmount,
    roundOff: snapshot.totals.roundOff,
    lineValue: snapshot.line.lineValue,
    seller: {
      gstin: snapshot.supplier.gstin,
      legalName: snapshot.supplier.name,
      tradeName: snapshot.supplier.tradeName,
      address: snapshot.supplier.address,
      location: snapshot.supplier.locality,
      pincode: snapshot.supplier.pincode,
      stateCode: snapshot.supplier.stateCode,
    },
    buyer: {
      gstin: snapshot.buyer.gstin,
      legalName: snapshot.buyer.designation,
      address: snapshot.buyer.address,
      location: snapshot.buyer.locality,
      pincode: snapshot.buyer.pincode,
      stateCode: snapshot.buyer.stateCode,
    },
    shipTo: frozenShipTo,
  });
}
