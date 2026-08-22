/**
 * How an audit event reads in English.
 *
 * Extracted from `views/Timeline.tsx`, which had carried all of it since
 * Milestone 6 and is now one of two readers: the per-Work timeline and the
 * organisation-wide audit register (migration 0095) show the SAME events,
 * and two copies of this vocabulary would drift the first time a pack
 * added an action to one of them. The Timeline imports from here and is
 * otherwise unchanged.
 *
 * Everything here is display text over data the server wrote. Nothing is
 * authoritative and nothing is arithmetic.
 */

const ACTION_LABELS: Record<string, string> = {
  'work.created': 'Work created',
  'challan.created': 'Challan drafted',
  'challan.updated': 'Challan draft updated',
  'challan.deleted': 'Challan draft deleted',
  'challan.issued': 'Challan issued',
  'challan.cancelled': 'Challan cancelled',
  'challan.rendered': 'Challan PDF generated',
  'challan.signed_copy_uploaded': 'Signed copy uploaded',
  'challan.received': 'Delivery receipt recorded',
  'correspondence_letter.dispatched': 'Outward letter dispatched',
  'correspondence_letter.received': 'Inward letter registered',
  'correspondence_letter.cancelled': 'Letter cancelled',
  'serials.recorded': 'Serial numbers recorded',
  'serial.installed': 'Installation recorded',
  'instrument.created': 'Instrument recorded',
  'instrument.updated': 'Instrument updated',
  'mb.recorded': 'Measurement recorded',
  'bill.prepared': 'Bill prepared',
  'bill.submitted': 'Bill submitted',
  'bill.paid': 'Bill paid',
  'received_railway_bill.recorded': 'Railway bill recorded',
  'received_railway_bill.discarded': 'Railway bill discarded',
  'railway_measurement.recorded': 'Railway measurement recorded',
  'railway_measurement.line_confirmed': 'Railway measurement line confirmed',
  'railway_measurement.discarded': 'Railway measurement discarded',
  'measurement_book.closed': 'Measurement closed by railway bill',
  // The inspection lifecycle (0082). `inspection.clauses_saved` and
  // `inspection.checklist_saved` are filed against the WORK, not the call
  // — they are configuration of the contract, and there is no call yet to
  // hang them on — so the Timeline's own filter lists them under Works
  // while the six call events list under Inspection calls.
  'inspection.clauses_saved': 'Inspection clause mapping saved',
  'inspection.checklist_saved': 'Inspection checklist saved',
  'inspection_call.raised': 'Inspection call raised',
  'inspection_call.letter_received': 'Inward call letter received',
  'inspection_call.document_attached': 'Inspection document attached',
  'inspection_call.certificate_recorded': 'Inspection certificate recorded',
  'inspection_call.closed': 'Inspection call closed',
  'inspection_call.cancelled': 'Inspection certificate withdrawn',
  'bill_payment.recorded': 'Payment received',
  'bill_payment.voided': 'Payment withdrawn',
  // The production job card (0084). Only the card reaches the timeline;
  // its units and their releases would flood a Work with one row each.
  'production_job_card.raised': 'Job card raised',
  'production_job_card.revised': 'Job card revised',
  'production_job_card.completed': 'Job card completed',
  'production_job_card.cancelled': 'Job card cancelled',
  // The organisation-level acts. These never appear on a Work's timeline
  // — they belong to no Work — and they are much of what the audit
  // register exists to show, which is why the register refuses an
  // assigned-scope reader rather than serving them a trail without these
  // in it.
  'organisation.created': 'Organisation created',
  'organisation.updated': 'Organisation profile changed',
  'organisation.exported': 'Organisation data exported',
  'membership.added': 'Member added',
  'membership.updated': 'Member permissions changed',
  'audit_trail.exported': 'Audit trail exported',
  'register.exported': 'Register exported',
  'works_analysis.exported': 'Works analysis exported',
  'tally_export.produced': 'Tally file produced',
};

const FIELD_LABELS: Record<string, string> = {
  challanDate: 'Challan date',
  prefix: 'Number prefix',
  consignee: 'Consignee',
  items: 'Line items',
  challanNumber: 'Challan number',
  totalAmount: 'Total amount',
  itemCount: 'Line count',
  // Job-card audit details (0084).
  number: 'Number',
  quantity: 'Quantity',
  dueDate: 'Due date',
  units: 'Units',
  sequence: 'Sequence',
  note: 'Note',
  status: 'Status',
  expiresOn: 'Expires on',
  notes: 'Notes',
  installedOn: 'Installed on',
  installationRemarks: 'Installation remarks',
  receivedOn: 'Received on',
  measuredQuantity: 'Measured quantity',
  billNumber: 'Bill number',
  entryCount: 'Measurements',
  kind: 'Kind',
  reference: 'Reference',
  count: 'Count',
  role: 'Role',
  workScope: 'Work scope',
  canIssueDocuments: 'Issue authority',
  canCancelDocuments: 'Cancel authority',
  canApproveAmendments: 'Amendment approval authority',
  canManageStatutoryReporting: 'Statutory reporting authority',
  canManagePayments: 'Payments authority',
  canSignDocuments: 'Signing authority',
  canManagePayroll: 'Payroll authority',
  canViewAuditTrail: 'Audit authority',
  auditRetentionMonths: 'Audit register window (months)',
  workIds: 'Assigned Works',
  name: 'Name',
  address: 'Address',
  gstin: 'GSTIN',
  contactPhone: 'Contact phone',
  contactEmail: 'Contact email',
  register: 'Register',
  rows: 'Rows',
  windowFrom: 'Window from',
  windowTo: 'Window to',
};

/** The event's action as a sentence. An unmapped action degrades to its
 * own token with the punctuation softened, rather than to nothing: a
 * register that hid the actions nobody had labelled yet would be a
 * register with holes in it. */
export function humaniseAction(action: string): string {
  return ACTION_LABELS[action] ?? action.replaceAll('.', ' ').replaceAll('_', ' ');
}

export function humaniseField(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field
      .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .toLowerCase()
  );
}

/** The record type a row is about, as a noun a reader recognises. Derived
 * rather than mapped: the entity type is a table name, and every table in
 * this schema is a plural snake_case noun already. */
export function humaniseEntityType(entityType: string): string {
  const words = entityType.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How many elements of a collection a diff cell prints before summarising
 * the rest.
 *
 * An audit detail is not always small. A challan revision carries its whole
 * `items` array on both sides of the diff, and a five-hundred-line challan
 * therefore renders one string of several hundred kilobytes into a single
 * table cell — which is not a readable diff at any length, and is a
 * render the browser does badly. Twenty is enough to recognise WHAT
 * changed; the record itself is one click away and is where anyone reading
 * five hundred lines should be.
 */
const MAX_LISTED = 20;

function summarise(shown: readonly string[], total: number): string {
  if (total <= MAX_LISTED) return shown.join('; ');
  return `${shown.join('; ')}; … ${String(total - MAX_LISTED)} more`;
}

/** Compact human text for a diff side: scalars verbatim, objects as
 * "key: value" pairs, arrays summarised per element — never raw JSON, and
 * never unbounded (see `MAX_LISTED`). */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value.length > 0 ? value : '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return summarise(value.slice(0, MAX_LISTED).map(displayValue), value.length);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return summarise(
      entries
        .slice(0, MAX_LISTED)
        .map(([key, entry]) => `${humaniseField(key)}: ${displayValue(entry)}`),
      entries.length,
    );
  }
  return '—';
}

export interface DiffRow {
  readonly field: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/** Update events carry { before: {field: old}, after: {field: new} } for
 * the changed fields only; anything else renders no diff. */
export function diffRows(details: unknown): readonly DiffRow[] {
  if (!isPlainObject(details)) return [];
  const { before, after } = details;
  if (!isPlainObject(before) || !isPlainObject(after)) return [];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({
    field,
    label: humaniseField(field),
    before: displayValue(before[field]),
    after: displayValue(after[field]),
  }));
}

/** Scalar context facts (challan number, note, quantity…) shown under the
 * action label; structured diffs and identifiers are handled elsewhere. */
export function contextFacts(details: unknown): readonly string[] {
  if (!isPlainObject(details)) return [];
  return Object.entries(details)
    .filter(
      ([key, value]) =>
        key !== 'before' &&
        key !== 'after' &&
        !key.endsWith('Id') &&
        (typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean') &&
        !(typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) &&
        !(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)),
    )
    .map(([key, value]) => `${humaniseField(key)}: ${String(value)}`);
}
