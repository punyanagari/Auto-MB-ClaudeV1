import { RequestFailedError } from '../api.js';
import { mastersHash, SETTINGS_HASH, workHash } from './workspace-routes.js';

/** Where a refused action is actually fixed. Rendered next to the
 * refusal as a real link, so "set it and retry" stops being a scavenger
 * hunt (UX principle 6: a blocked action states which workflow resolves
 * the block). */
export interface Wayfind {
  readonly label: string;
  readonly hash: string;
}

/** The refusal codes whose remedy lives on another screen, mapped to
 * that screen. Codes that resolve on the current screen (dates, notes,
 * statuses) deliberately stay unmapped — a link elsewhere would be
 * noise. */
export function wayfindingOf(
  error: unknown,
  context: { readonly workId?: string } = {},
): Wayfind | null {
  if (!(error instanceof RequestFailedError)) return null;
  switch (error.code) {
    // MB finalize: the payment matrix cannot price an item. The matrix
    // is edited on the Work's Schedules & items section.
    case 'MB_PERCENTAGES_UNRESOLVED':
      return context.workId === undefined
        ? null
        : {
            label: 'Open the payment matrix',
            hash: workHash(context.workId, 'schedules'),
          };
    // Challan issue: the item is gated on an inspection certificate that
    // does not cover the despatch. Both remedies live on the Work's
    // Inspection clause tab — certify more, or clear the gate — and the
    // tab links on to the Inspection workspace from there.
    case 'INSPECTION_CERTIFICATE_MISSING':
      return context.workId === undefined
        ? { label: 'Open Inspection', hash: '#/inspection' }
        : {
            label: 'Open the inspection clause',
            hash: workHash(context.workId, 'inspection'),
          };
    // Invoice submit: seller facts live on the organisation profile.
    case 'ORG_STATE_REQUIRED':
    case 'ORG_GSTIN_REQUIRED':
    case 'ORG_ADDRESS_REQUIRED':
    case 'ORG_PINCODE_REQUIRED':
    case 'ORG_LOCALITY_REQUIRED':
    case 'E_INVOICE_APPLICABILITY_UNDECLARED':
      return { label: 'Open organisation settings', hash: SETTINGS_HASH };
    // Invoice draft/submit: buyer facts live on the contact master (a
    // number series naming {DIV} draws the division from the buyer, so
    // INVOICE_NUMBER_UNFILLABLE is fixed on the contact too).
    case 'BUYER_PROFILE_INCOMPLETE':
    case 'INVOICE_NUMBER_UNFILLABLE':
    case 'CONTACT_NOT_FOUND':
    case 'CONTACT_RETIRED':
    case 'SHIP_TO_NOT_FOUND':
    case 'SHIP_TO_RETIRED':
      return { label: 'Open Masters → Contacts', hash: mastersHash('contacts') };
    // Invoice draft/submit: the accepted rate list is a master.
    case 'GST_RATE_NOT_NOTIFIED':
      return { label: 'Open Masters → GST rates', hash: mastersHash('gst-rates') };
    default:
      return null;
  }
}
