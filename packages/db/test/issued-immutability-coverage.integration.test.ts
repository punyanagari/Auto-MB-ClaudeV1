import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createDatabasePool } from '../src/pool.js';
import { runMigrations } from '../src/migration-runner.js';
import {
  SETUP_TIMEOUT_MS,
  adminUrl,
  migrationsDirectory,
} from './support/invariant-db.js';

/**
 * Immutability coverage: no column may be added to a guarded table without
 * a decision being recorded about it.
 *
 * The issued-document guards freeze business facts by comparing a ROW of
 * NEW columns against the same ROW of OLD columns. That list is written by
 * hand in the migration, which makes it a DENYLIST: a column added later
 * and not added to the list is silently mutable on an issued document. It
 * has already happened once — `tax_invoices.reverse_charge_applicable`
 * (0044) went in without joining the freeze and needed its own trigger
 * afterwards.
 *
 * This suite closes that shape. For every table whose triggers compare any
 * column for change, it derives the frozen set FROM THE DATABASE (the
 * function bodies as PostgreSQL stores them, not the migration text) and
 * requires
 *
 *     frozen  ∪  declared-mutable  ≡  the table's columns
 *
 * with the two sides disjoint. A new column is therefore a test failure
 * until somebody writes it into the freeze or names it here as mutable —
 * which is the decision that was previously skippable.
 *
 * Behavioural immutability itself is proved elsewhere and is not repeated
 * here: `apps/server/test/finding47-parent-immutability.integration.test.ts`
 * and the 0052/0057 suites attack the guards with raw SQL. What is proved
 * here is COVERAGE, and the last test proves the coverage rule itself is
 * not vacuous by putting an unknown column through it.
 *
 * Every read below is a catalog read, so this suite runs against the
 * development database rather than creating one of its own — a full
 * migration run per suite is what starves this package under parallel
 * execution.
 */

/**
 * Columns that may legitimately change after the row is written, per
 * table. Everything else must be compared for change by a trigger.
 *
 * Three recurring groups appear throughout:
 *
 *   surrogate/timestamp — `id` is the primary key (a changed primary key
 *     is a different row, and the FKs that reference it refuse the move);
 *     `updated_at` is maintained by `touch_updated_at`.
 *   lifecycle — `status` moves through a state machine that each table's
 *     own guard polices arm by arm, and the cancellation evidence written
 *     alongside it (`cancelled_at`, `cancelled_by_user_id`,
 *     `cancellation_note`) is written exactly once at cancel time, held
 *     coherent by a CHECK, and frozen thereafter where the table freezes
 *     it.
 *   render pointers — `template_version`, `rendered_object_key`,
 *     `rendered_sha256` and the signed-copy pair are written AFTER the
 *     document is issued, because rendering and uploading a signed copy
 *     happen after issue. They are evidence about the document, not facts
 *     of it.
 */
const DECLARED_MUTABLE: Record<string, readonly string[]> = {
  // The vendor liability register (0080), which 0109 gave a guard. That
  // guard is NARROW on purpose and this table is not an issued document:
  // it records what a vendor has billed this organisation, and every
  // ordinary fact on it stays correctable. What 0109 freezes is exactly
  // the evidence a purchase order's close rests on — the order the bill
  // is against, and the uploaded document — and only ONCE SET, so a bill
  // recorded without either can still gain both. Everything below is the
  // liability itself and its lifecycle.
  vendor_invoices: [
    'id',
    'organisation_id',
    'vendor_contact_id',
    'vendor_snapshot',
    'invoice_number',
    'invoice_date',
    'credit_days',
    'amount',
    'work_id',
    'tds_section',
    'tds_payee_class',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancel_reason',
    'recorded_by_user_id',
    'created_at',
    'updated_at',
    // The eight the 0109 guard freezes ONCE SET — the order link and the
    // seven that describe the uploaded document, the uploader among them
    // — are read out of that guard by the census itself and are
    // deliberately absent here. The group matches
    // `vendor_invoices_document_shape_check` exactly, so a closed order's
    // evidence cannot be swapped OR re-attributed after the fact.
  ],

  // The OEM item master (0084). Its guard is narrow on purpose: it is a
  // MASTER, and a master is meant to be edited. What it freezes is the
  // three things a physical object depends on — the tenant and
  // provenance, the serial series once it has minted a unit, and the
  // manufactured flag once job cards exist — plus the retirement, which
  // is refused while a job card is open rather than frozen outright.
  // Everything below is ordinary master data an operator may correct.
  production_items: [
    'id',
    'updated_at',
    'item_code',
    'name',
    'category',
    'unit',
    'serial_controlled',
    'specifications',
    // Both of these DO change, which is why they are here rather than in
    // the freeze: an item stops being manufactured when the agency stops
    // making it, and retiring one is the masters delete. Each carries a
    // one-way rule instead — the guard refuses clearing `manufactured`
    // once job cards exist, and refuses clearing `active` while one is
    // open — and a one-way rule is not a freeze.
    'manufactured',
    'active',
    // The stock ledger's one column on this master (0087). Editable by
    // design and by nothing else here: it is a threshold an operator
    // tunes as consumption changes, and the guard has no opinion on it.
    'reorder_level',
  ],

  // A payroll run (0090). Its identity is frozen from the first write —
  // the number, the month it pays, and who opened it — and everything
  // below is the lifecycle it is allowed to move through: calculated
  // while it is a draft, finalised once, cancelled with a reason and
  // never reopened. `updated_at` is maintained by the shared trigger.
  //
  // The lifecycle columns are DECLARED rather than frozen because the
  // guard holds them by STATUS rather than by column: a finalised run
  // takes exactly one further write, the cancel, so nothing needs to
  // compare `calculated_at` or `finalized_at` to protect them.
  //
  // The PAYSLIPS are not here because their guard freezes them wholesale
  // rather than column by column: after the run is issued the only write
  // a line takes is the payment-request stamp, and the guard compares
  // every other column as one row.
  payroll_runs: [
    'id',
    'updated_at',
    'status',
    'calculated_at',
    // The frozen basis snapshot moves at calculate time, beside
    // calculated_at, and is held by the same status rule after that (0090).
    'statutory_basis',
    'finalized_at',
    'finalized_by_user_id',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancel_reason',
  ],

  // The amendment decision ledger: everything proposed is frozen, the
  // decision is what gets written.
  approval_requests: [
    'id',
    'status',
    'decided_by_user_id',
    'decided_at',
    'decision_note',
  ],

  // A recorded receipt of money (0067). Every fact of it is frozen the
  // moment it is written — there is no edit path at all — and the only
  // later act is the void, which is the three columns below plus the
  // maintained timestamp.
  bill_payments: ['id', 'updated_at', 'voided_at', 'voided_by_user_id', 'void_reason'],

  // An employee advance or reimbursement (0080). Everything about it may
  // be corrected while it is a draft or a submission; what the trigger
  // freezes once it has been DECIDED is the money it authorises — the
  // amount, the kind, the beneficiary and the number. The columns below
  // are the lifecycle itself, which is the whole point of the record.
  payment_requests: [
    'id',
    'updated_at',
    'status',
    'decided_by_user_id',
    'decided_at',
    'decision_note',
    'paid_at',
    'paid_reference',
    'bills_recorded_at',
    // Draft-stage corrections. The trigger permits these only while the
    // request is undecided; after that the freeze above applies.
    'work_id',
    'beneficiary_snapshot',
    'purpose',
    'category',
    'proof_reference',
    'proof_filename',
    'fy_label',
    'sequence_number',
  ],

  // A recorded vendor payment (0080), on the same terms as bill_payments
  // above: every fact of it is frozen when written, and the void is the
  // only later act.
  vendor_payments: [
    'id',
    'updated_at',
    'voided_at',
    'voided_by_user_id',
    'void_reason',
  ],

  // The legacy bill record (0006). Its money and lines snapshot are
  // frozen; submission and payment are the two later facts.
  bills: ['id', 'status', 'submitted_at', 'paid_at'],

  // 0045 froze the budgetary quotation whole once it is not a draft:
  // nothing but the maintained timestamp is outside the freeze.
  budgetary_quotations: ['updated_at'],

  // A registered letter (0086). Everything on the paper is frozen the
  // moment the row exists — there is no draft state and no edit path at
  // all — and the cancellation triple is frozen too, one step later: the
  // guard's first comparison exempts it so the single legal UPDATE can
  // write it, and its third refuses any change once `cancelled_at` is
  // set. So the triple is write-once, which the freeze detector reads as
  // frozen and which is the honest reading — it is the record that
  // explains what a retained number now stands for. Only the primary key
  // and the maintained timestamp sit outside a freeze.
  correspondence_letters: [
    // `id` is the primary key of the row the guard was handed; there is
    // nothing for the ROW comparison to freeze it against.
    'id',
    'updated_at',
  ],

  // A site material request (0088). There is no draft state, so the whole
  // of what was asked for — the Work, the station, the requester, the
  // priority, the fault, the number — is frozen from the moment the row
  // exists. The approval triple is write-once on the same terms as a
  // letter's cancellation above: the first comparison exempts it so the
  // approving UPDATE can write it, and the second refuses any change once
  // `approved_at` is set, which the freeze detector reads as frozen.
  //
  // What is genuinely mutable is the lifecycle and the closure evidence.
  // The closure pair is write-once in practice — the guard's first
  // statement refuses every update to a closed request — but it is
  // declared here rather than left to the detector, because "no update at
  // all once closed" is a rule about the ROW and not a comparison of
  // those two columns.
  maintenance_requests: [
    'id',
    'updated_at',
    'status',
    'closed_by_user_id',
    'closed_at',
  ],

  // A material line (0088). Everything asked for is frozen; the write-off
  // is the one later fact, and it is write-once — the guard refuses a
  // second one outright rather than comparing the columns, so both are
  // declared here.
  maintenance_request_lines: ['id', 'cancelled_quantity', 'cancellation_reason'],

  // A reusable company credential (0079). Its provenance is frozen; the
  // name and category stay editable so a mis-typed credential can be
  // corrected without discarding its version history, and archiving is
  // the one lifecycle act — one-way, which the same guard enforces.
  company_documents: [
    'id',
    'updated_at',
    'title',
    'category',
    'archived_at',
    'archived_by_user_id',
  ],

  // The tender (0083). Its tenant and provenance are frozen outright.
  // Its FACTS are frozen conditionally — correctable while the bid is a
  // draft, fixed from submission onwards — and the guard is what decides
  // when. What is genuinely free is the status trail's own columns, the
  // award link, and the maintained timestamp.
  // The facts themselves are NOT declared here even though a draft's may
  // be corrected: the guard names them, conditionally, and this census
  // reads "named by a trigger" as covered. Declaring them too would be
  // the two statements contradicting each other, which is exactly what
  // the assertion below catches.
  tenders: ['status', 'ireps_reference', 'award_loa_document_id', 'updated_at'],

  // A bid-checklist line (0083). The tender it belongs to and who created
  // it are frozen outright; what is free is the line's own wording and
  // whether it is mandatory.
  // `attached_at` and `attached_by_user_id` are absent deliberately: the
  // guard names them, tying them to the credential so provenance cannot
  // be rewritten on its own, so the census reads them as covered.
  // `company_document_id` is the thing they are tied TO and is genuinely
  // free — attaching and detaching is what this line is for.
  tender_checklist_items: ['company_document_id', 'mandatory', 'title', 'updated_at'],

  // The tender notice (0083). The bytes, the hash and the machine's
  // reading of them are evidence and are frozen whole. The confirmation
  // link is frozen too, and conditionally so — the guard names it, which
  // is why it is not declared here: it may be set once, from null, and
  // never moved afterwards. Only the maintained timestamp is free.
  tender_notices: ['updated_at'],

  correction_notices: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
  ],

  credit_notes: [
    'id',
    'updated_at',
    'status',
    // The recipient's ITC reversal is confirmed after the note is issued —
    // it is a fact about the counterparty, not about the document.
    'recipient_itc_status',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
  ],

  // created_at is outside this table's freeze, unlike tax_invoices and
  // credit_notes, which do freeze it. It is set by DEFAULT now() and never
  // written by the product; recorded here so the difference is visible
  // rather than accidental.
  delivery_challans: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
    'signed_copy_object_key',
    'signed_copy_sha256',
  ],

  // The render pointer (0076) moves every time the printable summary is
  // regenerated, exactly as it does on delivery_challans and credit_notes
  // above: the PDF is a convenience print of frozen facts, so reprinting
  // one changes which bytes the pointer names and nothing that NIC said.
  eway_bills: [
    'id',
    'updated_at',
    'status',
    'rendered_object_key',
    'rendered_sha256',
    'rendered_version',
  ],

  extension_requests: [
    'id',
    'updated_at',
    'status',
    'rendered_object_key',
    'rendered_sha256',
  ],

  installations: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
  ],

  // The serial released when its installation is cancelled: the release
  // itself is frozen by the guard, so only the key is outside it.
  installation_serials: ['id'],

  // The defect liability period (0099). What is frozen is what the
  // railway's guarantee is measured against: the installation it runs
  // on, the term it was started under, the day it started, and the day
  // it ORIGINALLY ran to.
  //
  // `dlp_expires_on` reads as FROZEN here and is absent from this list on
  // purpose. It is the one business date that moves — a defect rectified
  // inside the period extends it — but it moves only through the guard's
  // own arm, which compares it against OLD and admits exactly one shape
  // of change: forward, never past ten years from the start, and never in
  // the same write that ends the period. That comparison is what this
  // census reads, and it is the honest answer: the column does not change
  // without the guard's say-so.
  //
  // What is left is the lifecycle group — the status, and the two
  // complete-or-absent evidence sets written once at discharge and once
  // at void.
  installation_warranties: [
    'id',
    'updated_at',
    'status',
    'closed_on',
    'closure_note',
    'closed_by_user_id',
    'closed_at',
    'void_note',
    'voided_by_user_id',
    'voided_at',
  ],

  // The Work's warranty term (0099). Its guard is narrow on purpose: a
  // term is a CLAUSE somebody read off a contract, and reading it wrong
  // is exactly the mistake an operator has to be able to correct. What it
  // freezes is the tenant, the Work and the provenance. Correcting the
  // term never reaches a period already running, because each period
  // froze its own copy.
  work_warranty_terms: ['id', 'updated_at', 'dlp_months', 'start_basis', 'notes'],

  // Same created_at note as delivery_challans.
  issue_challans: [
    'id',
    'created_at',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'rendered_object_key',
    'rendered_sha256',
    'signed_copy_object_key',
    'signed_copy_sha256',
  ],

  // The uploaded contract source document: object key, digest, extraction
  // payload and signature verdict are all frozen by 0040/0055/0060.
  loa_documents: ['id', 'created_at', 'updated_at'],

  // The claim a measurement book draws a source from; the release is
  // inside the freeze.
  mb_sources: ['id'],

  // A finalized measurement book freezes its number, date, kind and total.
  // consignee_contact_id, merged_into_id and is_final sit outside that
  // freeze: the first two are set as part of the merge the book takes
  // part in and the third marks the closing book of a Work, and all three
  // are written by routes that check the book's state themselves rather
  // than by a trigger.
  //
  // The three railway-closure columns 0066 adds are deliberately NOT here:
  // the restated guard compares them, so closure is append-once in the
  // database and not merely in the route that writes it.
  measurement_books: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
    'consignee_contact_id',
    'merged_into_id',
    'is_final',
  ],

  pac_certificates: [
    'id',
    'updated_at',
    'status',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancellation_note',
    // The scanned certificate is attached after the record is created.
    'document_object_key',
    'document_sha256',
  ],

  // 0045 froze the purchase order whole once it is not a draft.
  purchase_orders: ['updated_at'],

  // The railway's own On-Account Bill (0066). Its bytes and every fact
  // extracted from them are frozen by
  // `guard_received_railway_bill_update`, and its signature verdict by
  // 0060's append-once function reused verbatim. What is left is the
  // discard evidence — written once when a bill turns out to be attached
  // to the wrong Measurement Book, and made terminal by the same guard.
  received_railway_bills: [
    'id',
    'updated_at',
    'discarded_at',
    'discarded_by_user_id',
    'discard_reason',
  ],

  // The provider attempt ledger (0041): the request is frozen at start,
  // and the outcome is the append that closes it.
  statutory_provider_operations: [
    'id',
    'status',
    'provider_code',
    'http_status',
    'completed_at',
  ],

  tax_invoices: [
    'id',
    'updated_at',
    'status',
    'template_version',
    'rendered_object_key',
    'rendered_sha256',
  ],

  // Not an issued document: a PBG/security instrument whose STATUS is the
  // guarded fact (0008 refuses any transition out of a non-active state).
  // Its fields stay editable while it is live, so the whole row is
  // declared mutable and the state machine is the invariant.
  work_instruments: [
    'id',
    'organisation_id',
    'work_id',
    'kind',
    'reference',
    'amount',
    'issued_on',
    'expires_on',
    'notes',
    'created_by_user_id',
    'created_at',
    'updated_at',
  ],

  // Not an issued document either: the contract line. 0012 freezes the
  // AWARDED baseline (awarded_quantity, effective_rate, amendment_added,
  // the approval that moved it) so an amendment cannot rewrite history;
  // everything else is amendable master data, and 0030 polices the floors
  // that the amendable columns must respect.
  work_items: [
    'id',
    'schedule_id',
    'item_number',
    'description',
    'unit_code',
    'requires_serials',
    'payment_category',
    'source_evidence',
    'updated_at',
    'deleted_at',
    'effective_quantity',
    'effective_unit_rate',
    'effective_description',
    'effective_unit',
    'hsn_code',
    'gst_rate',
    'is_service',
    'advertised_rate',
    // Derived, and mutable precisely because it is derived: the 0077
    // trigger recomputes it on every write of this row, so it tracks the
    // installed total rather than recording a decision anyone made. It
    // carries no contract fact that freezing could protect — and freezing
    // it would freeze the recomputation itself.
    'pending_variation',
  ],

  // The Work itself. 0031 freezes the completion and reopen evidence and
  // 0011 the completion dates; the contract header stays editable, which
  // is what the amendment and review flows exist to do.
  works: [
    'id',
    'organisation_id',
    'work_code',
    'letter_number',
    'letter_date',
    'title',
    'advertised_value',
    'contract_value',
    'pricing_shape',
    'letter_percentage',
    'letter_percentage_direction',
    'allow_excess_delivery',
    'status',
    'created_by_user_id',
    'created_at',
    'updated_at',
    'deleted_at',
    'pbg_required_amount',
    'pbg_submission_days',
    'pbg_extension_days',
    'pbg_penal_interest_percent',
    'pbg_requirement_source',
    'gst_basis',
    'gst_rate',
  ],

  // A supersession record (0071) is written whole when a Work is
  // withdrawn, and admits exactly two later facts, mutually exclusive and
  // each written once: the Work that replaced it, or the discarding of the
  // letter that would have produced one. Both are bind-once, and the guard
  // freezes each the moment it stops being NULL — exactly as
  // `approval_requests.entity_id` is bound once by an approved apply —
  // which is why neither appears here. Nothing but the maintained
  // timestamp is outside the freeze.
  work_supersessions: ['updated_at'],

  // The signing queue (0091). Everything the signature is computed over —
  // the document, the bytes, the digest, the certificate, the dictionary
  // entries and the expiry — is frozen the moment the request is raised,
  // because a preparation that can change is one the completion path
  // cannot re-derive, and that re-derivation IS the integrity check
  // (ADR-0012 § "The approval is the authority"). What remains is the
  // outcome: where the request has got to, when it got there, and what
  // came back.
  signing_requests: [
    'status',
    'signed_object_key',
    'signed_sha256',
    'signature_status',
    'signature_verdict',
    'signature_verified_at',
    'failure_reason',
    'claimed_at',
    'completed_at',
    'updated_at',
  ],
  // A kiosk credential is written once. The three columns outside the
  // freeze are the two halves of revocation and the poll timestamp — none
  // of which changes what the credential IS, which is the property every
  // signature already made depends on.
  signing_agents: ['last_seen_at', 'revoked_at', 'revoked_by_user_id'],

  // Notifications (0092). A channel's identity is which organisation and
  // which channel; everything else about it is configuration an operator
  // revises as Meta onboarding progresses, which is the whole reason the
  // row exists before it is complete.
  notification_channels: [
    'enabled',
    'waba_phone_number_id',
    'waba_business_account_id',
    'display_phone_number',
    'api_base_url',
    'from_address',
    'reply_to_address',
    'configured_by_user_id',
    'updated_at',
  ],
  // A template's identity is the name and language Meta knows it by, and
  // its body freezes at submission because the WABA then holds the
  // reviewed text and it is that text which is sent.
  //
  // `body_text`, `parameter_count` and `category` are absent from this
  // list and therefore counted as FROZEN, which is the conservative half
  // of a truth the census's binary model cannot state: the guard's second
  // arm refuses them only once the status has left `draft`, so they are
  // editable exactly while nobody outside this system has seen them. The
  // reader sees the ROW comparison and reads it as a freeze; listing them
  // as mutable instead would claim they are editable after submission,
  // which is the direction that would matter if it were wrong.
  notification_templates: ['status', 'status_reason', 'email_subject', 'updated_at'],
  // Which contact and which channel a consent is about are written once.
  // The address, the state and the evidence are revised: an agreement
  // given for a new number is a new agreement on the same row, with its
  // own evidence sentence.
  notification_consents: [
    'address',
    'state',
    'evidence',
    'recorded_by_user_id',
    'updated_at',
  ],
  // What was sent, to whom, through what, is frozen. What moves is the
  // delivery ledger — forwards only, and its own guard arm proves that
  // separately.
  //
  // `provider_message_id` is absent for the same reason the template's
  // body is: the guard freezes it with a scalar comparison the moment it
  // stops being NULL, which the reader sees as a freeze. It is written
  // once, by the transaction that records what the provider answered, and
  // never again — rewriting it would re-point every future receipt at a
  // row it is not about.
  notification_messages: [
    'status',
    'failure_code',
    'failure_detail',
    'sent_at',
    'delivered_at',
    'read_at',
    'failed_at',
    'updated_at',
  ],
  // An import batch's identity — the file it was, its digest, and the
  // register it aims at — is written once, because the rows beneath it
  // were judged against that answer. What moves is where it has got to
  // and the census of what happened there.
  spreadsheet_import_batches: [
    'status',
    'row_count',
    'valid_row_count',
    'error_row_count',
    'imported_row_count',
    'completed_at',
    'completed_by_user_id',
    'cancelled_at',
    'cancelled_by_user_id',
    'cancelled_reason',
    'updated_at',
  ],
  // A staged row's CELLS are evidence: they are what the sheet
  // contained, and a row whose content could be corrected in place is one
  // where nobody can tell what was uploaded from what was fixed
  // afterwards. The verdict written over them is the outcome.
  //
  // `cells` and `imported_record_id` are deliberately NOT here, and the
  // reason is worth stating because it looks like an omission.
  //
  // `cells` may be EMPTIED and may never be changed — the route forgets
  // a sheet's own text as its batch turns terminal, because a contacts
  // sheet carries account numbers the direct path never logs. Destroying
  // evidence is not restating it, so the freeze the scan below reads is
  // the right reading of the rule.
  //
  // `imported_record_id` is WRITE-ONCE
  // rather than mutable: null until the row reaches the register, and
  // frozen from that moment, because re-pointing it at a second record
  // would leave the first orphaned from the row that explains it. The
  // scan above reads that rule as a freeze — it sees `NEW.x IS DISTINCT
  // FROM OLD.x` and cannot see the `OLD.x IS NOT NULL` in front of it —
  // and for this census's purpose that reading is the correct one.
  spreadsheet_import_rows: ['status', 'errors'],

  // A recurring check's identity is its organisation and its kind (0096),
  // and both are frozen: letting either move would silently repoint a run
  // history at a different check. Everything else on the row is a setting
  // an owner is meant to change or state the scheduler maintains — which
  // is exactly the split this census exists to make explicit.
  statutory_job_schedules: [
    'enabled',
    'cadence',
    'horizon_days',
    'next_run_at',
    'last_run_at',
    'last_job_id',
    'authority_user_id',
    'disabled_reason',
    'updated_at',
  ],

  // An export request (0096). Who asked and when is frozen outright, and
  // the six artefact facts — key, size, digest, format, expiry,
  // completion — are frozen from the moment the artefact exists, which is
  // why none of them appears below: the build writes them on the
  // `running -> ready` transition and nothing may touch them afterwards.
  // (The one carve-out is in the guard itself: the expiry sweep clears
  // `object_key` to NULL as it deletes the bytes.)
  //
  // What is genuinely mutable is the state walk, the build's own
  // timestamps, the failure reason and the download counters.
  organisation_export_requests: [
    'state',
    'started_at',
    'failure_reason',
    'download_count',
    'last_downloaded_at',
    'updated_at',
  ],

  // A recorded retention release (0098), on exactly the terms
  // `bill_payments` sits on above: every fact of it is frozen the moment
  // it is written — there is no edit path at all — and the only later act
  // is the withdrawal, which is the three columns below plus the
  // maintained timestamp.
  retention_releases: [
    'id',
    'updated_at',
    'voided_at',
    'voided_by_user_id',
    'void_reason',
  ],

  // A liquidated-damages assessment (0098). Everything the arithmetic was
  // computed FROM is frozen — the basis, the window and the three terms —
  // and so are the generated figures, which cannot be written at all.
  // What moves is the decision: the status walks draft -> levied ->
  // waived/cancelled and never back, the levy is written once (the guard
  // refuses a second value), and the reason and the decider are the
  // record of who decided what.
  //
  // `notes` is genuinely free and is the only ordinary column here that
  // is: it is the operator's own working note about a computation, not
  // part of it.
  //
  // `id` and `levied_amount` are absent deliberately, and for two
  // different reasons. `id` is in the frozen snapshot's own comparison,
  // like every other identity column this census reads as covered.
  // `levied_amount` IS written — that is the levy — but only once: the
  // guard refuses any change to a value already set, which the freeze
  // detector reads as frozen and which is the honest reading. Correcting
  // what the railway took is a waiver of this assessment and a new one,
  // so the trail says what was claimed and what replaced it.
  //
  // THE FIVE GENERATED COLUMNS ARE LISTED HERE AND ARE NOT MUTABLE, and
  // the mismatch is worth naming rather than leaving to be discovered.
  // `delay_days`, `chargeable_periods`, `uncapped_amount`, `cap_amount`
  // and `assessed_amount` are STORED GENERATED: PostgreSQL refuses the
  // assignment outright, before any trigger runs, so they are not merely
  // frozen but unwritable, and each is a pure function of the snapshot
  // columns the guard does freeze. This census reads its catalog straight
  // from `pg_attribute` and has no notion of a generated column, so the
  // only two ways to satisfy it are to list them here or to write a
  // comparison into the guard for a value that can never differ. Listing
  // them is what `measurement_books.is_final` already does, for the same
  // reason, so the shape follows the precedent rather than inventing a
  // third answer.
  ld_assessments: [
    'updated_at',
    'status',
    'levy_reference',
    'outcome_reason',
    'notes',
    'decided_by_user_id',
    'decided_at',
    'delay_days',
    'chargeable_periods',
    'uncapped_amount',
    'cap_amount',
    'assessed_amount',
  ],
};

/**
 * Columns a trigger compares for change, read out of the stored function
 * body: the `ROW(NEW...) IS DISTINCT FROM ROW(OLD...)` freezes plus the
 * scalar `NEW.x IS DISTINCT FROM OLD.x` form some guards use for a single
 * column.
 */
function frozenColumns(definition: string): Set<string> {
  const found = new Set<string>();
  const rowBlock = /ROW\s*\(([\s\S]*?)\)\s*\r?\n?\s*IS DISTINCT FROM\s*ROW\s*\(/gi;
  for (const block of definition.matchAll(rowBlock)) {
    for (const column of (block[1] ?? '').matchAll(/\bNEW\.([a-z_][a-z0-9_]*)/gi)) {
      found.add((column[1] ?? '').toLowerCase());
    }
  }
  const scalar =
    /\bNEW\.([a-z_][a-z0-9_]*)\s+IS DISTINCT FROM\s+OLD\.([a-z_][a-z0-9_]*)/gi;
  for (const match of definition.matchAll(scalar)) {
    const left = (match[1] ?? '').toLowerCase();
    const right = (match[2] ?? '').toLowerCase();
    if (left === right) found.add(left);
  }
  return found;
}

interface TriggerRow {
  readonly table_name: string;
  readonly definition: string;
}

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

async function readFrozen(pool: Sql): Promise<Map<string, Set<string>>> {
  const triggers = await pool<TriggerRow[]>`
    select c.relname as table_name, pg_get_functiondef(p.oid) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and n.nspname = 'public'
      and (t.tgtype & 1) <> 0 and (t.tgtype & 2) <> 0 and (t.tgtype & 16) <> 0
  `;
  const byTable = new Map<string, Set<string>>();
  for (const trigger of triggers) {
    const frozen = frozenColumns(trigger.definition);
    if (frozen.size === 0) continue;
    const existing = byTable.get(trigger.table_name) ?? new Set<string>();
    for (const column of frozen) existing.add(column);
    byTable.set(trigger.table_name, existing);
  }
  return byTable;
}

async function readColumns(pool: Sql): Promise<Map<string, string[]>> {
  const rows = await pool<ColumnRow[]>`
    select c.relname as table_name, a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `;
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byTable.get(row.table_name) ?? [];
    existing.push(row.column_name);
    byTable.set(row.table_name, existing);
  }
  return byTable;
}

/** Everything a guarded table's columns are judged against, for one
 * table: what a trigger compares for change, and what is declared free. */
function uncoveredColumns(
  catalog: readonly string[],
  frozenHere: ReadonlySet<string>,
  declared: readonly string[],
): string[] {
  return catalog.filter(
    (column) => !frozenHere.has(column) && !declared.includes(column),
  );
}

let admin: Sql;
let frozen: Map<string, Set<string>>;
let columns: Map<string, string[]>;

beforeAll(async () => {
  admin = createDatabasePool({
    url: adminUrl,
    max: 2,
    applicationName: 'auto-mb-immutability-admin',
  });
  await admin`select 1 as ready`;
  await runMigrations(admin, migrationsDirectory);
  frozen = await readFrozen(admin);
  columns = await readColumns(admin);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await admin?.end();
}, SETUP_TIMEOUT_MS);

describe('issued-document immutability coverage', () => {
  it('reads a non-empty freeze out of the database', () => {
    // A regex that stopped matching would make every assertion below pass
    // vacuously; these two are the canary.
    expect(frozen.size).toBeGreaterThanOrEqual(20);
    expect([...(frozen.get('tax_invoices') ?? [])]).toEqual(
      expect.arrayContaining([
        'taxable_value',
        'invoice_number',
        'reverse_charge_applicable',
      ]),
    );
  });

  it('declares every table whose triggers freeze a column, and no others', () => {
    const discovered = [...frozen.keys()].sort();
    const declared = Object.keys(DECLARED_MUTABLE).sort();
    const undeclared = discovered.filter((table) => !declared.includes(table));
    const stale = declared.filter((table) => !discovered.includes(table));
    expect(
      undeclared,
      `tables whose triggers freeze columns but that are absent from ` +
        `DECLARED_MUTABLE: ${undeclared.join(', ')}. Add each with the list of ` +
        'columns that may legitimately change after the row is written.',
    ).toEqual([]);
    expect(
      stale,
      `DECLARED_MUTABLE entries whose table no longer freezes anything: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it.each(Object.keys(DECLARED_MUTABLE).sort())(
    'accounts for every column of %s',
    (table) => {
      const catalog = columns.get(table);
      expect(catalog, `${table} is not a table in the database`).toBeDefined();
      const declared = DECLARED_MUTABLE[table] ?? [];
      const frozenHere = frozen.get(table) ?? new Set<string>();

      const unknown = declared.filter((column) => !(catalog ?? []).includes(column));
      expect(
        unknown,
        `${table}: DECLARED_MUTABLE names columns the table does not have: ${unknown.join(', ')}`,
      ).toEqual([]);

      const both = declared.filter((column) => frozenHere.has(column));
      expect(
        both,
        `${table}: declared mutable but frozen by a trigger: ${both.join(', ')}. ` +
          'One of the two statements is wrong.',
      ).toEqual([]);

      const uncovered = uncoveredColumns(catalog ?? [], frozenHere, declared);
      expect(
        uncovered,
        `${table}: neither frozen by a trigger nor declared mutable: ` +
          `${uncovered.join(', ')}. A column added to a guarded table has to be ` +
          'written into the freeze or named in DECLARED_MUTABLE — the denylist ' +
          'shape of the ROW guards means it is otherwise silently editable on ' +
          'an issued document.',
      ).toEqual([]);
    },
  );

  it('catches a column added to the most heavily guarded table', () => {
    // The proof that the rule is not fail-open, run through exactly the
    // comparison the per-table assertions use, with the real frozen set
    // and the real declaration for tax_invoices — only the catalog is
    // extended, by the column a future migration would add.
    const declared = DECLARED_MUTABLE.tax_invoices ?? [];
    const frozenHere = frozen.get('tax_invoices') ?? new Set<string>();
    const catalog = columns.get('tax_invoices') ?? [];
    expect(uncoveredColumns(catalog, frozenHere, declared)).toEqual([]);
    expect(
      uncoveredColumns([...catalog, 'coverage_probe'], frozenHere, declared),
    ).toEqual(['coverage_probe']);
  });
});
