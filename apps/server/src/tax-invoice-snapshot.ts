/** Strict parser for the immutable tax-invoice snapshot frozen at submit. */

import { buildIrpPayload, type IrpItem, type IrpPayload } from './gsp/irp-payload.js';
import { amountInWords as renderAmountInWords } from './amount-in-words.js';
import { paiseText } from './money.js';

interface FrozenParty {
  readonly designation: string;
  readonly contactPerson: string | null;
  readonly gstin: string | null;
  readonly address: string;
  readonly stateCode: string;
  readonly pincode: string;
  readonly locality: string | null;
}

interface FrozenSupplier {
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

/** One line of an ITEMISED invoice, as frozen at submit (snapshot v2,
 * migration 0057). The v1 snapshot's single cumulative service line
 * NORMALISES into the same shape through `snapshotLines`, so every
 * consumer — the printed document, the IRP payload — reads one thing. */
interface FrozenInvoiceLine {
  readonly position: number;
  readonly isService: boolean;
  readonly hsnSacCode: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitLabel: string;
  readonly rate: string;
  readonly gstRate: string;
  readonly amount: string;
  readonly lineValue: string;
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

/** Snapshot v2 (migration 0057): the ITEMISED invoice. Identical to v1
 * in every party, total and word — it differs in exactly one place, the
 * single `line` becoming a `lines` array. v1 is NOT rewritten or
 * upgraded: an invoice renders from the snapshot it was issued under,
 * forever, and every stored invoice today is v1. */
interface TaxInvoiceIssuedSnapshotV2 {
  readonly templateVersion: 'ti-v2';
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly fyLabel: string | null;
  readonly supplier: FrozenSupplier;
  readonly buyer: FrozenParty;
  readonly shipTo: FrozenParty | null;
  readonly placeOfSupply: string;
  readonly reverseChargeApplicable: boolean | null;
  readonly customerPoReference: string | null;
  readonly lines: readonly FrozenInvoiceLine[];
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

export type TaxInvoiceIssuedSnapshot =
  TaxInvoiceIssuedSnapshotV1 | TaxInvoiceIssuedSnapshotV2;

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

/** The same arithmetic as `money.ts`'s `toPaise`, kept local for its
 * REFUSAL: a snapshot fault is a `TaxInvoiceSnapshotError` naming the JSON
 * path, which the invoice, credit-note and e-way routes map onto a 409
 * carrying `TAX_INVOICE_SNAPSHOT_INVALID`. The shared parser throws a plain
 * Error, which those routes would surface as a 500 — so the formatter is
 * shared and this is not. */
function scaledPaise(value: string, path: string): bigint {
  // Fully anchored, with a fraction bounded to two digits.
  // eslint-disable-next-line security/detect-unsafe-regex
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!match) throw new TaxInvoiceSnapshotError(`${path} is not a 2dp amount`);
  const sign = match[1] === '-' ? -1n : 1n;
  return (
    sign * (BigInt(match[2] ?? '0') * 100n + BigInt((match[3] ?? '').padEnd(2, '0')))
  );
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TaxInvoiceSnapshotError(`${path} is not a positive integer`);
  }
  return value;
}

function boolean_(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TaxInvoiceSnapshotError(`${path} is not a boolean`);
  }
  return value;
}

/**
 * The strict entry point. Dispatches on the frozen template version and
 * NEVER migrates one shape into the other: a v1 snapshot is parsed by the
 * v1 parser, byte for byte as it always was, and a v2 snapshot by the v2
 * one. Consumers that want a uniform view take `snapshotLines` below.
 */
export function parseTaxInvoiceIssuedSnapshot(
  value: unknown,
): TaxInvoiceIssuedSnapshot {
  const root = object(value, 'issuedSnapshot');
  if (root.templateVersion === 'ti-v2') {
    return parseIssuedSnapshotV2(root);
  }
  return parseIssuedSnapshotV1(root);
}

/**
 * The ITEMISED lines a snapshot carries, in print order. A v1 snapshot
 * has exactly one — its cumulative service line, which is a SERVICE at a
 * SAC by construction — so this is the ONLY place the two shapes meet and
 * no consumer branches on the version itself.
 */
export function snapshotLines(
  snapshot: TaxInvoiceIssuedSnapshot,
): readonly FrozenInvoiceLine[] {
  if (snapshot.templateVersion === 'ti-v2') return snapshot.lines;
  return [
    {
      position: 1,
      isService: true,
      hsnSacCode: snapshot.line.sacCode,
      description: snapshot.line.description,
      quantity: snapshot.line.quantity,
      unitLabel: snapshot.line.unitLabel,
      rate: snapshot.line.rate,
      gstRate: snapshot.line.gstRate,
      amount: snapshot.line.amount,
      lineValue: snapshot.line.lineValue,
    },
  ];
}

function parseIssuedSnapshotV1(root: JsonObject): TaxInvoiceIssuedSnapshotV1 {
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
  const shipTo =
    root.shipTo === null ? null : party(root.shipTo, 'issuedSnapshot.shipTo');
  const totalAmount = decimal(totals.totalAmount, 'issuedSnapshot.totals.totalAmount');
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

function parseIssuedSnapshotLine(value: unknown, index: number): FrozenInvoiceLine {
  const path = `issuedSnapshot.lines[${String(index)}]`;
  const row = object(value, path);
  const hsnSacCode = text(row.hsnSacCode, `${path}.hsnSacCode`);
  const isService = boolean_(row.isService, `${path}.isService`);
  if (!/^[0-9]{6,8}$/.test(hsnSacCode)) {
    throw new TaxInvoiceSnapshotError(`${path}.hsnSacCode is invalid`);
  }
  // A SAC takes no eight-digit deepening: the frozen document says which
  // reading applies, and a service line that carries a longer code is not
  // a document this parser will hand to a statutory payload.
  if (isService && !/^[0-9]{6}$/.test(hsnSacCode)) {
    throw new TaxInvoiceSnapshotError(
      `${path}.hsnSacCode is not a six-digit SAC on a service line`,
    );
  }
  return {
    position: integer(row.position, `${path}.position`),
    isService,
    hsnSacCode,
    description: text(row.description, `${path}.description`),
    quantity: decimal(row.quantity, `${path}.quantity`),
    unitLabel: text(row.unitLabel, `${path}.unitLabel`),
    rate: decimal(row.rate, `${path}.rate`),
    gstRate: decimal(row.gstRate, `${path}.gstRate`),
    amount: decimal(row.amount, `${path}.amount`),
    lineValue: decimal(row.lineValue, `${path}.lineValue`),
  };
}

function parseIssuedSnapshotV2(root: JsonObject): TaxInvoiceIssuedSnapshotV2 {
  const totals = object(root.totals, 'issuedSnapshot.totals');
  const rawLines = root.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.lines is not a non-empty array');
  }
  const lines = rawLines.map((line, index) => parseIssuedSnapshotLine(line, index));
  const invoiceDate = text(root.invoiceDate, 'issuedSnapshot.invoiceDate');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(invoiceDate)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.invoiceDate is invalid');
  }
  const fyLabel = nullableText(root.fyLabel, 'issuedSnapshot.fyLabel');
  if (fyLabel !== null && !/^[0-9]{4}-[0-9]{2}$/.test(fyLabel)) {
    throw new TaxInvoiceSnapshotError('issuedSnapshot.fyLabel is invalid');
  }
  const totalAmount = decimal(totals.totalAmount, 'issuedSnapshot.totals.totalAmount');
  return {
    templateVersion: 'ti-v2',
    invoiceNumber: text(root.invoiceNumber, 'issuedSnapshot.invoiceNumber'),
    invoiceDate,
    fyLabel,
    supplier: supplier(root.supplier),
    buyer: party(root.buyer, 'issuedSnapshot.buyer'),
    shipTo: root.shipTo === null ? null : party(root.shipTo, 'issuedSnapshot.shipTo'),
    placeOfSupply: text(root.placeOfSupply, 'issuedSnapshot.placeOfSupply'),
    reverseChargeApplicable: nullableBoolean(
      root.reverseChargeApplicable,
      'issuedSnapshot.reverseChargeApplicable',
    ),
    customerPoReference: nullableText(
      root.customerPoReference,
      'issuedSnapshot.customerPoReference',
    ),
    lines,
    totals: {
      taxableValue: decimal(totals.taxableValue, 'issuedSnapshot.totals.taxableValue'),
      cgstAmount: decimal(totals.cgstAmount, 'issuedSnapshot.totals.cgstAmount'),
      sgstAmount: decimal(totals.sgstAmount, 'issuedSnapshot.totals.sgstAmount'),
      igstAmount: decimal(totals.igstAmount, 'issuedSnapshot.totals.igstAmount'),
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

/**
 * The ItemList, mapped from the frozen document.
 *
 * A v1 (cumulative) snapshot produces EXACTLY the bytes it always has:
 * one item, `Qty` the integer 1 rather than the snapshot's '1.00', and
 * UnitPrice/TotAmt/AssAmt all the invoice's taxable value with the header
 * tax heads. That is not a shortcut — it is the wire this system has been
 * sending since the payload existed, and an itemised feature has no
 * business rewriting the statutory bytes of a cumulative invoice.
 *
 * A v2 (itemised) snapshot produces one item per line, at the line's own
 * quantity, rate, GST rate and tax heads.
 */
export function frozenIrpItems(snapshot: TaxInvoiceIssuedSnapshot): IrpItem[] {
  if (snapshot.templateVersion === 'ti-v1') {
    return [
      {
        description: snapshot.line.description,
        isService: true,
        hsnCode: snapshot.line.sacCode,
        quantity: '1',
        unitPrice: snapshot.totals.taxableValue,
        totalAmount: snapshot.totals.taxableValue,
        assessableAmount: snapshot.totals.taxableValue,
        gstRate: snapshot.line.gstRate,
        cgstAmount: snapshot.totals.cgstAmount,
        sgstAmount: snapshot.totals.sgstAmount,
        igstAmount: snapshot.totals.igstAmount,
        totalItemValue: snapshot.line.lineValue,
      },
    ];
  }
  return snapshot.lines.map((line) => {
    const heads = lineTaxHeads(line, snapshot);
    return {
      description: line.description,
      isService: line.isService,
      hsnCode: line.hsnSacCode,
      quantity: line.quantity,
      unitPrice: line.rate,
      totalAmount: line.amount,
      assessableAmount: line.amount,
      gstRate: line.gstRate,
      ...heads,
      totalItemValue: line.lineValue,
    };
  });
}

/**
 * A line's own CGST/SGST/IGST, recovered exactly from what was frozen:
 * `lineValue - amount` is the tax the line carries, and the INVOICE's
 * split decides which heads hold it (the 0035 split-coherence CHECK and
 * the 0052 place-of-supply guard both make that one decision per
 * document). All arithmetic in scaled paise integers — never floats.
 */
function lineTaxHeads(
  line: FrozenInvoiceLine,
  snapshot: TaxInvoiceIssuedSnapshot,
): { cgstAmount: string; sgstAmount: string; igstAmount: string } {
  const tax =
    scaledPaise(line.lineValue, 'lineValue') - scaledPaise(line.amount, 'amount');
  const interState = scaledPaise(snapshot.totals.igstAmount, 'igstAmount') > 0n;
  if (interState) {
    return {
      cgstAmount: '0.00',
      sgstAmount: '0.00',
      igstAmount: paiseText(tax),
    };
  }
  const half = tax / 2n;
  if (half * 2n !== tax) {
    throw new TaxInvoiceSnapshotError(
      'issuedSnapshot line tax does not split into two equal intra-state halves',
    );
  }
  return {
    cgstAmount: paiseText(half),
    sgstAmount: paiseText(half),
    igstAmount: '0.00',
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
    placeOfSupply: snapshot.placeOfSupply,
    reverseChargeApplicable: snapshot.reverseChargeApplicable,
    items: frozenIrpItems(snapshot),
    taxableValue: snapshot.totals.taxableValue,
    cgstAmount: snapshot.totals.cgstAmount,
    sgstAmount: snapshot.totals.sgstAmount,
    igstAmount: snapshot.totals.igstAmount,
    totalAmount: snapshot.totals.totalAmount,
    roundOff: snapshot.totals.roundOff,
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
