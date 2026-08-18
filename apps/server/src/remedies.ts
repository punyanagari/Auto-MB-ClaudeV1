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
  COMPANY_DOCUMENT_NOT_FOUND:
    'Pick the credential again from Company documents; one archived or renamed there is no longer reachable by its old id.',
  TENDER_NOT_FOUND:
    'Open the tender from the Tenders register; one confirmed on another branch of the pipeline is reached from there.',
  TENDER_STATUS_CONFLICT:
    'Check where the bid actually stands on the tender before recording the next step; the trail runs one way and awarded and lost are final.',
  TENDER_CHECKLIST_LOCKED:
    'Reopen nothing — a submitted bid keeps the checklist that went out; record what changed as a step on the tender instead.',
  TENDER_NOTICE_NOT_FOUND:
    'Upload the notice again from Tenders, Upload NIT; a notice already confirmed is reached through the tender it became.',
  CORRESPONDENCE_LETTER_NOT_FOUND:
    'Pick the letter again from the Correspondence register; a letter filed against a Work you are not assigned to is not listed there.',
  // OEM production (migration 0084). The remedies say what to DO, not
  // what went wrong: the message already carries that.
  PRODUCTION_ITEM_NOT_FOUND:
    'Pick the item again from the OEM catalogue on Production, Item master; one retired there is no longer selectable by its old id.',
  PRODUCTION_ITEM_EXISTS:
    'Give the item a part number no other item carries; a retired item keeps its code, because the code is printed on labels and reissuing it would make an old label name a new thing.',
  PRODUCTION_ITEM_INVALID:
    'A manufactured item needs a serial series before it can be saved, and the series cannot change once it has minted a unit — create a new item instead of renumbering this one.',
  PRODUCTION_ITEM_IN_USE:
    'Close or cancel the open job cards for this item before retiring it; finished job cards are history and do not block.',
  PRODUCTION_BOM_CYCLE:
    'Take the component out of the assembly it already contains, or build the shared part as an item of its own; a bill of material that reaches itself has no bottom.',
  PRODUCTION_BOM_LINE_EXISTS:
    'Change the quantity on the line that already names this component instead of adding a second one.',
  PRODUCTION_BOM_LINE_INVALID:
    'A bill of material hangs off a manufactured item and names live parts; mark the parent manufactured, or reactivate the part, before adding the line.',
  PRODUCTION_BOM_LINE_NOT_FOUND:
    "Open the bill of material again from the item's page; a line removed there is no longer reachable by its old id.",
  PRODUCTION_JOB_CARD_NOT_FOUND:
    'Open the job card from the Production register; one cancelled is still listed there.',
  PRODUCTION_JOB_CARD_STATE_INVALID:
    'Check where the job card actually stands before recording the next step; a completed or cancelled card is final and its units keep their serials.',
  PRODUCTION_JOB_CARD_INCOMPLETE:
    'Serialise the outstanding units before completing the card, or reduce the planned quantity to what was actually built.',
  PRODUCTION_QUANTITY_EXCEEDED:
    'Raise the job card quantity if more units are genuinely wanted; a card builds what was ordered and no more.',
  PRODUCTION_SERIAL_NOT_FOUND:
    "Open the job card's Serials tab again; a unit removed there is no longer reachable by its old id.",
  PRODUCTION_SERIAL_LOCKED:
    'A unit that has been despatched or whose card is finished keeps its record; correct the stock movement instead of the unit.',
  PRODUCTION_COMPONENT_SERIAL_NOT_FOUND:
    "Open the unit again from the job card's Serials tab; a component record removed there is no longer reachable by its old id.",
  PRODUCTION_COMPONENT_SERIAL_INVALID:
    "Scan a part the unit is actually built from, and no more of it than the bill of material calls for; check the assembly's bill if the part should be there.",
  PRODUCTION_COMPONENT_SERIAL_EXISTS:
    'That component serial is already recorded inside another unit — check the label, because one physical part cannot be in two places.',
  PRODUCTION_DISPATCH_NOT_FOUND:
    "Open the job card's Dispatch tab again; a release deleted there is no longer reachable by its old id.",
  PRODUCTION_DISPATCH_INVALID:
    'Release only units of this job card that are still in the factory and have every required component serial captured.',
  // The stock ledger (migration 0087). Every remedy names the movement
  // that fixes the situation, because in a ledger the answer to a wrong
  // number is always another row rather than an edit.
  STOCK_BACKDATED:
    'Post the movement at today’s date and put the docket’s own date in the reason; a ledger records changes in the order they happen, so a running balance cannot be inserted behind one already written.',
  STOCK_ITEM_NOT_FOUND:
    'Pick the part again from the stock register; one retired on Production, Item master is no longer selectable by its old id.',
  STOCK_INSUFFICIENT:
    'Receive the material before issuing it, or post an adjustment with the reason the shelf count was wrong; stock is never taken below zero.',
  STOCK_MOVEMENT_INVALID:
    'Check the movement type against what it names: a receipt needs its purchase order line, an issue needs a job card or a Work, and an adjustment needs a reason.',
  STOCK_SOURCE_INVALID:
    'Post the movement against a document that can still take it — an issued purchase order, an open job card, an active Work.',
  STOCK_DISPATCH_RECEIVED:
    'This despatch is already on the shelf; correct the quantity with an adjustment rather than receiving it twice.',
  STOCK_NOT_SHORT:
    'Order only the parts the shortage list is still showing; one that has been received since the list was drawn no longer needs buying.',
  STOCK_JOB_CARD_HAS_NO_WORK:
    'Raise the purchase order from a job card that serves a Work; a purchase order belongs to a Work, and this card serves a private order.',

  FIELD_TOO_SHORT:
    'Fill the named field in and submit again; a value of nothing but spaces is not a value.',
  // Crossed the three-throw coverage bar when the production and
  // correspondence registers each added a keyset list of their own. An
  // operator meets it by following a stale link, and the register they
  // came from is the way back.
  CURSOR_INVALID:
    'Reload the register and page through it again; a cursor from an older list, or one naming a record outside your Works, no longer places a page.',
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
  CORRESPONDENCE_LETTER_CANCELLED:
    'File the correct letter as a new one; a cancelled letter keeps its number forever and is never reinstated.',
  CORRESPONDENCE_LETTER_ANSWERED:
    'Cancel the reply first, then this letter; a thread is unwound from its newest end.',
  CORRESPONDENCE_LETTER_IMMUTABLE:
    'Cancel the letter with a reason and file the corrected one; a letter that has been sent or received is a record of what was actually on the paper.',
  CORRESPONDENCE_NUMBER_CONFLICT:
    'File the letter again; it takes the next number in the series.',
  CORRESPONDENCE_DATE_IN_FUTURE:
    'Date the letter on or before today; the register keeps the day it was actually dispatched or received.',
  CORRESPONDENCE_RESPONSE_DUE_BEFORE_LETTER:
    'Set the reply-due date on or after the day the letter arrived, or leave it empty when the letter asks for nothing.',
  CORRESPONDENCE_SENDER_DATE_AFTER_LETTER:
    "Check the date printed on the received letter against the day it was registered; the sender's date cannot be later.",
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
    'Name each Work item once in the request; on a challan, carry the whole quantity on that item’s single line.',
  PAYMENT_MATRIX_ROW_MISSING:
    'Enter the four stage percentages for every category this Work’s items bill through, under the Work’s Schedules and items tab; an item with no matrix row stops the Measurement Book that would bill it.',
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
  INSPECTION_DOCUMENT_NOT_FOUND:
    'Open the call on the Inspection screen and upload the paper against its checklist row; a row with nothing attached has no file to open.',
  INSPECTION_CALL_NOT_FOUND:
    'Open the call from the Inspection screen; a withdrawn call keeps its record, but a link can outlive the Work it named.',
  INSPECTION_DATE_INVALID:
    'Enter the date the paper itself carries: a call letter is dated on or after the request it answers, and a certificate on or before the day its validity ends.',
  INSPECTION_CERTIFICATE_MISSING:
    "Raise and close an inspection call covering the outstanding quantity on the Inspection screen, or clear the item's dispatch gate on the Work's Inspection clause tab if the contract does not require one.",
  INSPECTION_CALL_INCOMPLETE:
    'Upload the outstanding mandatory documents and the inspection certificate on the call before closing it.',
  INSPECTION_CALL_STATE_INVALID:
    'Reload the call; a call moves request → call letter received → closed, and a cancelled or closed call takes no further changes.',
  INSPECTION_CALL_CLOSED:
    'Raise a fresh inspection call for the material; a closed or cancelled call is a finished record and is never reopened.',
  INSPECTION_CLAUSE_INVALID:
    'Pick RDSO or RITES for an item whose despatch is gated — consignee inspection happens after arrival, so a certificate for it can never exist before despatch.',
  SERIAL_BEFORE_DELIVERY:
    'Record the installation on or after the delivery date shown on the challan that carried the serial.',
  CHALLAN_HAS_EVIDENCE:
    'Issue a correction notice against the challan; once a receipt, serials or measurements exist, cancelling would contradict evidence already recorded.',
  CORRECTION_EMPTY:
    'Change at least one line before filing the correction; a notice identical to the issued document corrects nothing.',
  WORK_NOT_FULLY_EXECUTED:
    'Deliver and install the balance, record the acceptance certificate for any maintenance period already served, or amend the outstanding quantities down, before completing the Work.',
  WORK_HAS_DOWNSTREAM_DOCUMENTS:
    'Correct the Work through an amendment or a correction notice; superseding is available only while nothing has been issued or received against it.',
  WORK_HAS_NO_LOA_DOCUMENT:
    'Correct this Work through an amendment; a Work with no letter in the product has nothing to read again and no successor to be confirmed from.',
  WORK_ALREADY_SUPERSEDED:
    'Open the successor Work; the letter this Work came from has already been released and can be confirmed only once more.',
  SUCCESSOR_IDENTITY_MISMATCH:
    'Confirm the released letter under the withdrawn Work’s own work code and letter number, or discard it and upload the correct letter if the identity itself was the mistake.',
  WORK_IDENTITY_RESERVED:
    'Confirm or discard the released letter that is waiting for this identity before using it for another Work.',
  SUPERSEDE_IN_PROGRESS:
    'Confirm the released letter first, or discard the letter itself — that withdraws its whole package together rather than one document at a time.',

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
  BILL_NOT_FULLY_SETTLED:
    'Record the receipts and their deduction breakup against this bill until nothing is outstanding, because paid now means the money is accounted for and not merely that the railway settled the measurement.',
  BILL_PAYMENT_EXCEEDS_SETTLEMENT:
    'Re-read the register before recording this receipt: another one may have been recorded first, and the total of received plus deducted can never pass the amount the railway billed.',
  BILL_PAYMENT_DUPLICATE_REFERENCE:
    'Check whether this advice is already in the register under the same UTR or cheque number, and withdraw the earlier receipt first if it was recorded in error.',
  BILL_PAYMENT_DATE_INVALID:
    'Enter the date the money actually reached the bank, which is on or after the railway bill it settles and never in the future.',
  BILL_PAYMENT_DEDUCTION_UNDESCRIBED:
    'Say what the other deduction is, because a head with no name cannot be reconciled against a statement or claimed back later.',
  BILL_PAYMENT_ALREADY_VOIDED:
    'Reload the register: this receipt has already been withdrawn, and the amount it carried is outstanding again.',
  VENDOR_INVOICE_NOT_FOUND:
    'Reload the vendor ledger: the invoice was cancelled or belongs to another organisation, so record it again if it is genuinely outstanding.',
  VENDOR_PAYMENT_EXCEEDS_INVOICE:
    'Reload the vendor ledger and pay at most what the invoice still shows outstanding; record the rest against the invoice it actually belongs to.',
  VENDOR_PAYMENT_TDS_EXCEEDS_GROSS:
    'Pay at least the tax that falls due, or record the earlier untaxed payments of this financial year against their own deduction first.',
  PAYMENT_REQUEST_STATE_CONFLICT:
    'Reload the register: somebody else approved, paid or closed this request while you were looking at it.',
  PAYMENT_REQUEST_FROZEN:
    'Reject this request and raise a new one for the corrected amount; what an approver agreed to does not change underneath them.',

  // Payroll (migrations 0089 and 0090). A payroll refusal is almost
  // always about a schedule that has not been recorded or a run that has
  // already been settled, so every remedy names the thing to record or
  // the register to read rather than suggesting a retry.
  EMPLOYEE_NOT_FOUND:
    'Open the employee from the Employees register; one removed from the payroll is no longer reachable by an old link.',
  EMPLOYEE_CODE_TAKEN:
    'Give this employee a code no other employee in the organisation holds; the code is what a provident-fund return names them by.',
  EMPLOYEE_INVALID:
    'Check the dates and the profession-tax State against the employment record before saving; a State without the arm of its schedule that applies cannot produce a deduction.',
  PAYROLL_RUN_NOT_FOUND:
    'Open the run from the Payroll register; a cancelled run is still listed there.',
  PAYROLL_RUN_EXISTS:
    'Open the run that already covers this month, or cancel it with a reason before running the month again.',
  PAYROLL_RUN_IMMUTABLE:
    'Cancel this run with a reason and run the month again; a finalised payroll is the record of what was paid and its payslips do not move.',
  PAYROLL_RUN_STATE_CONFLICT:
    'Reload the run and read where it stands; a run is calculated, finalised once, and then only cancelled.',
  PAYROLL_RUN_NOT_CALCULATED:
    'Calculate the run before finalising it, so the payslips exist to be finalised.',
  PAYROLL_RUN_EMPTY:
    'Add the employees to the Employees register before running the month; a run with nobody on it pays nobody.',
  PAYROLL_LINE_INVALID:
    'Check the loss-of-pay days against the days in the month, then calculate the run again.',
  PAYROLL_SCHEDULE_MISSING:
    'Ask an organisation owner to record the notified rate or State profession-tax schedule this month needs before running it; the run reads the schedule in force on its own month and will not guess one.',
  PAYROLL_TAX_OUT_OF_SCOPE:
    'Take this employee off the run and have their tax computed by a practitioner; income above the surcharge threshold is deliberately outside what this product deducts.',
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
  EWAY_BILL_NOT_APPLICABLE_TO_SERVICE_INVOICE:
    'Raise the e-way bill from the delivery challan carrying the goods instead, because NIC issues none for a document whose every line is a service.',
  CHALLAN_STATUTORY_FACTS_REQUIRED:
    'Record the movement reason and the per-line HSN codes on the challan draft before issuing it, because an issued challan is immutable and cannot gain them afterwards.',
  EWAY_SOURCE_FACTS_INCOMPLETE:
    'Complete the organisation profile under Administration, and the consignee contact, so the document can state the parties NIC requires.',
  CHALLAN_NOT_STANDALONE:
    'Open this challan from its own Work, where a Work-bound movement is edited and issued.',
  LINE_SHAPE_INVALID:
    'Give the line one shape and complete it: a Work item, or a manual description with its unit and rate, and an HSN code only alongside its goods-or-service marker.',
  RENDER_INPUT_INVALID:
    'Check the frozen facts the document was issued with; nothing was overwritten and the previous PDF, if any, is still current.',
  RENDER_SOURCE_CHANGED:
    'Render again; the evidence moved while the renderer ran and the previous PDF remains the current one.',
  RENDER_STORAGE_FAILED:
    'Try the render again once storage is reachable; the document and any previous PDF are unaffected.',
  RENDERED_PDF_INTEGRITY_FAILED:
    'Render the document again, because the retained bytes no longer match the digest recorded when they were stored.',

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
