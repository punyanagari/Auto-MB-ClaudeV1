import type { ErrorCode } from '@auto-mb/contracts';

/**
 * What to do about a refusal, one reviewed sentence per error code.
 *
 * The panel measurement that produced this file: roughly three-quarters of
 * the server's 633 refusals stated a fact and stopped. "This Work already
 * has a draft challan" is true and complete and leaves a clerk holding
 * nothing to do next. `message` keeps stating the fact — it is written by
 * the route that refused, and often carries the numbers only that route
 * knows. `remedy` states the action, and belongs to the CODE rather than
 * the call site, because the action is the same wherever a code is thrown.
 *
 * That is why this is one catalog rather than a fifth argument at 633 call
 * sites: the same advice written forty times drifts, and a route file being
 * edited for an unrelated reason is exactly where it drifts. The error
 * handler in `app.ts` looks the code up and attaches the result.
 *
 * House rules for an entry, enforced by `test/error-remedies.test.ts`:
 *
 *  - It is an instruction, not an apology. No "sorry", no "unfortunately",
 *    no "please". The operator is at work.
 *  - It names where the action happens when that is not obvious — a
 *    screen, a register, a tab.
 *  - It does not repeat the message. The message says what happened; this
 *    says what to do.
 *  - It is one sentence, ending in a full stop.
 *
 * Coverage rule, also enforced by the test: every code the server throws
 * three or more times carries a remedy. Rarer codes may carry one when the
 * refusal is one an operator actually meets — an over-delivery, a malware
 * rejection, a missing authority — and the test checks that every key here
 * is a code the tree still throws, so a retired refusal cannot leave its
 * advice behind.
 *
 * Since pack P12 the key type is `ErrorCode`, so a remedy written against
 * a code the declared vocabulary does not carry is a compile error rather
 * than dead advice waiting for the census test to notice it.
 */
export const REMEDIES: Readonly<Partial<Record<ErrorCode, string>>> = {
  // ---- Records the address no longer resolves to -------------------------
  //
  // A 404 is rarely a typo in this product: a link is followed after a
  // colleague deleted the draft it named, or an id from one organisation
  // is opened while another is bound. The remedy is always the register
  // that lists what does exist.
  WORK_NOT_FOUND:
    'Open the Work from the Works register; a link can outlive the Work it named, and an id from another organisation never resolves here.',
  WORK_ITEM_NOT_FOUND:
    'Reload the Work and pick the item from its current schedule — an approved amendment can omit or renumber an item.',
  RAILWAY_BILL_NOT_FOUND:
    "Open the railway bill from the Measurement Book's Railway bill panel; a discarded bill keeps its record but a deleted link resolves to nothing.",
  CHALLAN_NOT_FOUND:
    'Open the challan from the Delivery Challans register; a draft deleted elsewhere leaves its link behind.',
  MEASUREMENT_BOOK_NOT_FOUND:
    "Open the Measurement Book from the Work's Measurement tab; a discarded draft keeps no record.",
  TAX_INVOICE_NOT_FOUND: "Open the invoice from the Work's Tax Invoices tab.",
  CREDIT_NOTE_NOT_FOUND:
    'Open the credit note from the invoice it supersedes; credit notes are listed under their invoice, not on their own.',
  ISSUE_CHALLAN_NOT_FOUND: "Open the Issue Challan from the Work's Issue Challans tab.",
  PURCHASE_ORDER_NOT_FOUND:
    "Open the purchase order from the Work's Purchase Orders tab.",
  PAC_CERTIFICATE_NOT_FOUND:
    "Open the certificate from the Work's guarantees and acceptance tab.",
  EXTENSION_NOT_FOUND: "Open the extension from the Work's completion section.",
  NOTICE_NOT_FOUND: 'Open the correction notice from the challan it corrects.',
  APPROVAL_NOT_FOUND:
    'Open the request from the Approvals queue; a decided or withdrawn request leaves it.',
  CONTACT_NOT_FOUND:
    'Pick the contact again from Masters, Contacts — a contact removed or renamed there is no longer selectable by its old id.',
  DOCUMENT_NOT_FOUND:
    'Open the LOA document from the Works register, under documents awaiting review.',
  // Crossed the coverage bar when P12 collapsed three spellings of "that
  // letter was discarded" into one code — which is the dedupe paying for
  // itself: one refusal now earns one reviewed sentence.
  DOCUMENT_DISCARDED:
    'Upload the letter again if it was discarded by mistake; a discarded intake package keeps its record but accepts no further work.',
  SERIAL_NOT_FOUND:
    'Find the serial with Serial Lookup; it names the challan that delivered it and where it now stands.',
  NOT_FOUND:
    'Choose the organisation again from the organisation picker; the one addressed is not one this account can open.',

  // ---- The record is real but is in another state ------------------------
  //
  // The most common shape of refusal in the product, and the one where a
  // fact alone is least useful: a status conflict almost always means
  // somebody else moved the record, so the remedy starts with reloading.
  CHALLAN_STATUS_CONFLICT:
    'Reload the challan and read its status; an issued challan is changed by cancelling and re-issuing, or by a correction notice.',
  ISSUE_CHALLAN_STATUS_CONFLICT:
    'Reload the Issue Challan; an issued one is changed by cancelling and re-issuing, and a draft is edited directly.',
  MB_STATUS_CONFLICT:
    'Reload the Measurement Book; a draft is edited or deleted, a finalized one is cancelled with a note, and a merged one moves only through the book that absorbed it.',
  MB_ALREADY_CLOSED:
    'Reload the Measurement Book; the railway bill that settled this measurement is already recorded against it, and a closure is never re-taken.',
  MB_NOT_FINALIZED:
    'Finalize the Measurement Book first; a draft has measured nothing the railway could have billed.',
  TAX_INVOICE_STATUS_CONFLICT:
    'Reload the invoice; a submitted invoice is corrected by issuing a credit note against it, never by editing.',
  CREDIT_NOTE_STATUS_CONFLICT:
    'Reload the credit note; a draft is deleted and an issued one is cancelled.',
  NOTICE_STATUS_CONFLICT:
    'Reload the correction notice and act on it in its current state.',
  EXTENSION_STATUS_CONFLICT:
    'Reload the extension; once a response is recorded the extension is a record of what the railway granted, not a draft.',
  EWAY_BILL_STATUS_CONFLICT:
    'Reload the e-way bill and read its state before acting on it again; the portal moves it independently of this screen.',
  APPROVAL_NOT_PENDING:
    'Reload the Approvals queue; this request has already been decided or withdrawn, and a decision is not re-taken.',
  WORK_NOT_ACTIVE:
    'Reopen the Work only if the railway extended it; a completed or cancelled Work accepts no new documents.',
  CORRECTION_TARGET_MISSING:
    'Reload the challan and file the correction against a line it still carries.',
  AMENDMENT_ITEM_MISSING:
    'Reload the Work and raise the amendment against its current items.',

  // ---- One-of-a-kind rules -----------------------------------------------
  DRAFT_EXISTS:
    'Open the draft this Work already carries and issue or delete it; one open draft at a time is what keeps the number series gap-free.',
  PENDING_EXISTS:
    'Decide or withdraw the request already pending on this record, then raise the new one.',
  FINAL_MB_EXISTS:
    "Cancel the final Measurement Book first — it closes the Work's payment cycle, so anything recorded after it could never be billed.",
  MB_SOURCE_ALREADY_BILLED:
    'Pick measurements no live Measurement Book already carries; each source is billed exactly once.',
  RAILWAY_BILL_ALREADY_RECORDED:
    'Discard the railway bill already recorded against this measurement before uploading another; one bill settles one measurement.',
  CONTACT_EXISTS:
    'Open the existing contact in Masters, Contacts and edit it rather than adding a second under the same designation and address.',
  DUPLICATE_ENTRY:
    'Give the item a number no item in this Work has held; numbers stay reserved even after an item is omitted.',
  DUPLICATE_ITEM:
    'Remove the repeated line and carry its quantity on the single line for that item.',
  NUMBER_CONFLICT:
    'Issue again under a distinct prefix in Settings, Number series; a number already used in this organisation is never reissued.',
  IRP_ALREADY_RECORDED:
    'Reload the document; its IRN is already recorded, and a second registration of the same document is what the portal refuses.',
  LAST_OWNER:
    'Make another member an owner first; an organisation with no owner can never be administered again.',

  // ---- Dates and quantities the operator typed ---------------------------
  CHALLAN_DATE_INVALID:
    'Enter a challan date on or after the letter date and no later than today.',
  LETTER_DATE_INVALID:
    'Enter the letter date exactly as the letter states it, and no later than today.',
  EXTENSION_GRANTED_DATE_INVALID:
    'Record "accepted" to grant exactly the date proposed, "modified" with the date the railway actually granted, or "rejected" with no date.',
  QUANTITY_INVALID:
    'Enter a quantity greater than zero, and check the line for a mistyped digit.',
  QUANTITY_EXCEEDED:
    'Reduce the line to the remaining balance shown against the item, or amend the awarded quantity first.',
  LOCALITY_INVALID: 'Enter the locality as it appears on the postal address.',

  // ---- Physical order of work --------------------------------------------
  //
  // The delivery-before-installation floor and its neighbours. These are
  // the refusals where the remedy is another screen entirely, which is
  // exactly the case `docs/UX.md` calls a blocked action with a corrective
  // workflow.
  INSTALLATION_EXCEEDS_DELIVERY:
    'Issue the Delivery Challan for the balance first; installation is only ever recorded against material already delivered.',
  INSTALLATION_EXCEEDS_LOA:
    'Amend the item quantity first if the railway sanctioned more; installation never exceeds the sanctioned quantity.',
  SERIAL_BEFORE_DELIVERY:
    'Record the installation on or after the delivery date shown on the challan that carried the serial.',
  CHALLAN_HAS_EVIDENCE:
    'Issue a correction notice against the challan; once a receipt, serials or measurements exist, cancelling would contradict evidence already recorded.',
  CORRECTION_EMPTY:
    'Change at least one line before filing the correction; a notice identical to the issued document corrects nothing.',
  WORK_NOT_FULLY_EXECUTED:
    'Deliver and install the balance, record the acceptance certificate for any maintenance period already served, or amend the outstanding quantities down, before completing the Work.',

  // ---- The settlement chain the agency does not control -------------------
  //
  // The railway's own On-Account Bill is the only chain document this
  // product receives rather than writes, so the remedy for every refusal
  // around it names something OUTSIDE the product: a bill to obtain, a
  // signature to chase, a trust anchor for whoever runs the server. A
  // remedy that said "try again" would be a lie about who is holding the
  // work up.
  MB_RAILWAY_BILL_MISSING:
    "Upload the railway's On-Account Bill for this measurement on the Measurement Book's Railway bill panel; the measurement stays open until it arrives.",
  MB_RAILWAY_BILL_UNVERIFIED:
    'Read the signature panel on the recorded railway bill, and ask the railway for a correctly signed copy if the bill itself is at fault.',
  BILL_MEASUREMENT_BOOK_NOT_CLOSED:
    "Close the Measurement Book with the railway's verified On-Account Bill first; payment is recorded against a settlement the railway signed.",
  BILL_ALREADY_PAID:
    'Record the correction as a receipt or a deduction against a later bill, the way a billed Measurement Book is corrected on a subsequent one, because the register of a paid bill is closed in both directions.',
  RAILWAY_BILL_EXTRACTION_FAILED:
    'Upload the IWRCMS bill PDF as downloaded rather than a scan or a print; the bill number, date, amount and measurement are read from its text layer.',
  RAILWAY_BILL_MEASUREMENT_UNMATCHED:
    'Finalize the Measurement Book this bill measures before recording the bill, and check the measurement number printed on the bill names this Work.',
  RAILWAY_BILL_NOT_FOR_WORK:
    'Open the Work whose LOA number the bill prints and record it there; a bill is filed against the letter it names.',

  // ---- Masters and configuration -----------------------------------------
  CONTACT_RETIRED:
    'Reactivate the contact in Masters, Contacts, or pick an active one; retiring withdraws a contact from the pickers without touching issued documents.',
  CHALLAN_NUMBER_UNFILLABLE:
    'Set a usable format for this document in Settings, Number series, then issue again.',
  PDF_NOT_AVAILABLE:
    "Generate the PDF from the document's own screen, then download it.",

  // ---- Authority and membership ------------------------------------------
  OWNER_REQUIRED:
    'Ask an owner of this organisation to make the change; the Members screen names them.',
  AUTHORITY_REQUIRED:
    'Ask an owner to grant this authority on the Members screen, or ask a member who already holds it to act.',
  ROLE_FORBIDDEN:
    'Ask an owner to change your role on the Members screen, or ask a member whose role covers this to act.',
  NOT_A_MEMBER:
    'Switch to an organisation this account belongs to, or ask its owner to add you.',
  MFA_ENROLMENT_REQUIRED:
    'Enrol in two-factor authentication under Settings, Account security; document authority requires it.',

  // ---- Statutory transport ------------------------------------------------
  //
  // The portal is a second system of record with its own state. Every one
  // of these means the two disagree, and the portal wins, so every remedy
  // is a form of "read the portal's answer first".
  STATUTORY_OPERATION_IN_PROGRESS:
    'Wait for the registration already running to finish, then reload the document and read its result before acting again.',
  STATUTORY_PROVIDER_NOT_CONFIGURED:
    'Record the portal result manually against the document, or ask the owner to configure the statutory provider in Settings.',
  IRP_STATE_CONFLICT:
    "Reload the document and read its registration state; the portal's record is the authoritative one.",
  IRP_CANCEL_WINDOW_CLOSED:
    'Issue a credit note against the invoice; the portal accepts no cancellation once its 24-hour window has closed.',
  EWAY_PROVIDER_STATE_CONFLICT:
    "Reload the e-way bill and let the provider operation settle before changing carriage facts; the portal's state is the authoritative one.",
  EWAY_BILL_LIVE:
    'Cancel the live e-way bill first; goods cannot be under a live way bill for an invoice being withdrawn.',

  // ---- Uploads and rendering ----------------------------------------------
  MALWARE_DETECTED:
    'Scan the file locally and upload a clean copy; nothing was stored.',
  PDF_TEXT_EXTRACTION_UNAVAILABLE:
    'Ask your administrator to check the PDF text-extraction toolchain on the server; no document was rejected on its contents.',
  LOA_DOCUMENT_DUPLICATE:
    'Open the document already holding this file, or discard it first if this upload is meant to replace it.',

  // ---- The envelope's own codes -------------------------------------------
  //
  // These three are minted by the error handler in `app.ts` rather than by
  // a route, so the census below cannot find them in a `httpError` call.
  DATABASE_UNAVAILABLE:
    'Try again in a moment; nothing was saved, so nothing is half-written.',
  INTERNAL_ERROR:
    'Try again, and quote the request id above to your administrator if it recurs.',
  RATE_LIMITED: 'Wait a few minutes before trying again.',
};

/** Codes the error handler mints itself; they are legitimate catalog keys
 * even though no route throws them. */
export const ENVELOPE_CODES: readonly ErrorCode[] = [
  'DATABASE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'RATE_LIMITED',
];

/** The reviewed remedy for a refusal code, or undefined when none has been
 * written. Undefined omits the field: a refusal with no reviewed action is
 * better than one carrying filler. */
export function remedyFor(code: string): string | undefined {
  // Indexed by an arbitrary string: the error handler looks up whatever
  // code an error carried, which includes the framework's own.
  return (REMEDIES as Readonly<Record<string, string | undefined>>)[code];
}
