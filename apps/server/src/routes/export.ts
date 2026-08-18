import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { ApiErrorSchema } from '@auto-mb/contracts';
import { Type, type TSchema } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import { parseJsonbColumn } from '../jsonb-column.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

const errorResponses = {
  400: ApiErrorSchema,
  401: ApiErrorSchema,
  403: ApiErrorSchema,
} as const;

/**
 * export-v26: the spreadsheet importer (0094) joins the package — every
 * batch an organisation staged and every row of every sheet it uploaded,
 * with the verdict each row was given and the record it became.
 *
 * WHAT DOES NOT TRAVEL is the row's `cells`, and that is the decision
 * worth recording. They are the operator's own file, and a contacts
 * sheet's file is a column of bank account numbers and IFSCs — precisely
 * the values the direct write path is deliberately discreet about
 * ("never audited and never logged"). The register they fed already holds
 * the authoritative copy under that discretion; a second, unredacted copy
 * in the recovery package would be the one place it did not reach. The
 * route forgets them as a batch turns terminal, and this section excludes
 * them regardless, so the format does not depend on that timing.
 *
 * `organisation_memberships.can_sign_documents` (0091) also joins here,
 * and it is a REPAIR rather than an addition: it should have arrived with
 * v24 and was left off the members section's explicit column list, so a
 * restored organisation came back with signing revoked from everyone. The
 * census that would have caught it is added in the same pull request.
 *
 * v25 is the notifications pack's, allocated by the coordinator rather
 * than claimed on merge, for the reason the v15, v17 and v21 notes record
 * at length.
 *
 * export-v24: the signing trail (0091, ADR-0012) joins the package — the
 * kiosk credentials, and every request to put the organisation's own
 * Class 3 certificate on an issued document.
 *
 * The requirement this section answers is narrower and harder than "the
 * table is exported": a restored organisation must be able to prove WHAT
 * was signed, WHEN, and BY WHICH CERTIFICATE, years after the token
 * expired and the kiosk was scrapped. All three travel.
 *
 *   what      `source_object_key` and `source_sha256` name the exact bytes
 *             the signature covers, `signed_object_key` and
 *             `signed_sha256` the result, and both keys are in
 *             `objectManifest` so the archive carries the files.
 *   when      `completed_at`, beside `signature_verified_at` and the
 *             verifier's own stored verdict — so the export says not just
 *             that it was signed but on what evidence it was accepted.
 *   which     `certificate_thumbprint` on the request, joining to
 *             `signingAgents.certificate_chain_pem`, which is the whole
 *             chain in PEM. This is the part a naive export loses: a
 *             thumbprint alone is a fingerprint of a certificate nobody
 *             kept, and the CCA hierarchy is not something a restore can
 *             re-fetch offline years later.
 *
 * One column is deliberately withheld — `signing_agents.token_hash`. See
 * that section for why: it proves nothing and is the one value an offline
 * attacker could grind.
 *
 * v22 (maintenance) and v23 (HR payroll) are the two packs of this wave
 * that landed ahead of it. The numbers were ALLOCATED by the coordinator
 * rather than claimed on merge, for the reason the v15, v17 and v21 notes
 * record at length: a version string identifies a format, two formats
 * sharing one string is the failure that matters, and a gap is not.
 * export-v23: the employee master, the dated statutory schedules and the
 * payroll runs (0089, 0090) join the package.
 *
 * Six sections and a counter, and the reason all of them travel is one
 * sentence: an organisation restored without its payroll history cannot
 * answer a provident-fund inspector. The payslips are the primary record
 * of every contribution the agency deducted and every one it owed, and
 * unlike a challan or an invoice they exist nowhere else — there is no
 * counterparty holding a copy.
 *
 * The THREE SCHEDULE TABLES travel too, and that is not decoration. A run
 * snapshots the rates it used onto each line, so a restore can still read
 * what was deducted; what it could not do without the schedules is
 * compute the NEXT month, and it could not show an inspector the
 * notification the organisation was relying on. They are also editable
 * per organisation, so a restore that re-seeded them from the migration
 * would silently discard an owner's own corrections.
 *
 * `employees` carries the PAN, the UAN, the ESIC number and — through the
 * `contacts` section that has done so since v13 — the salary bank
 * account. That is the same posture v13 recorded for the bank accounts:
 * the API withholds those columns because no screen needs them back,
 * while this export is the contractor's own portability snapshot and an
 * export you cannot restore a payroll from is not one. No Aadhaar exists
 * anywhere in the schema to travel.
 *
 * v22 (maintenance) is the pack of this wave that landed ahead of it. The
 * numbers were ALLOCATED by the coordinator rather than claimed on merge,
 * for the reason the v15 and v17 notes record at length: a version string
 * identifies a format, two formats sharing one string is the failure that
 * matters, and a gap is not.
 *
 * No manifest bucket: payroll stores no PDFs. A payslip is rendered from
 * the frozen columns that travel here, so a restored export can reprint
 * every one it holds — the same reasoning the v20 note gives for outward
 * letters.
 * export-v22: maintenance (0088) joins the package — the site material
 * requests, what each asked for, the dispatch challans that answered
 * them, the quantities each challan carried, the defective units
 * received back, and both numbering counters.
 *
 * All seven tables travel, because six of the module's numbers are
 * DERIVED from rows rather than stored: how much of a line is reserved,
 * dispatched and received back is the sum of its dispatch lines and its
 * returns, so an export carrying only the requests would restore an
 * organisation whose every maintenance line read as untouched. The
 * counters travel for the reason the standalone-challan note below
 * gives: without them a restored organisation reissues a challan number
 * a site receiver has already signed for.
 *
 * No manifest bucket: maintenance stores no PDFs. The dispatch challan
 * is a pure function of columns frozen at insert, like the outward
 * letter in the v20 note below, and nothing here accepts an upload.
 *
 * The one column 0088 adds to another module's table — the stock
 * ledger's `maintenance_dispatch_id` — rides along inside that section's
 * existing `select *`.
 *
 * export-v21: the stock ledger (0087) joins the package — every movement
 * of every part, with the source document that caused it, and the
 * per-item ledger position that orders them. It is exported as ROWS and
 * not as balances, because the balance is not a stored fact: it is the
 * last movement's running total, so an export carrying the ledger can
 * rebuild every balance, while one carrying balances could not explain a
 * single one of them. The two columns Inventory added to
 * `purchase_order_lines` ride along inside that section's existing
 * `select *`.
 *
 * v19 (production) and v20 (correspondence) are the two packs of this
 * wave that landed ahead of it, and both notes are below. The numbers
 * were ALLOCATED by the coordinator rather than claimed on merge, for the
 * reason the v15 and v17 notes record at length: a version string
 * identifies a format, two formats sharing one string is the failure that
 * matters, and a gap is not.
 *
 * export-v20: the correspondence register (0086) joins the package — the
 * inward and outward letters with their numbering counters, and the
 * inward scans in the manifest. Outward letters carry no stored object
 * because their PDF is rendered on demand from the frozen columns that
 * travel here, so a restored export can reprint every letter it holds.
 *
 * export-v19: OEM production (0084) joins the package — the item master,
 * the recursive bill of material, the job cards, the finished serials,
 * the per-unit component genealogy, the despatches, and all three of the
 * module's counters.
 *
 * Left out, a restored organisation would come back with the contracts
 * and none of the factory: no record of what it manufactures, no bill of
 * material behind any of it, and — the loss that cannot be reconstructed
 * from anywhere else — no serial genealogy. A delivered unit's challan
 * says a number moved; only these tables say what is inside it. The
 * counters travel for the reason the standalone-challan note below
 * gives: without them a restored organisation reissues serials it has
 * already stamped on hardware.
 *
 * No manifest bucket: production stores no PDFs. Every other module here
 * that carries one does so because it accepted an upload, and this one
 * accepts none.
 *
 * export-v18: the tender pipeline (0083) joins the package — the tenders
 * themselves, the notices they were read from with their stored PDFs, the
 * bid checklists and the status trails. A pre-award record is the only
 * evidence of why an agency bid for a contract, or did not; an export that
 * carried the Works and not the tenders would hand back the outcomes with
 * none of the deciding.
 *
 * This pack coded v17 while the merge order still had it landing ahead of
 * payments. The order flipped, payments merged with v17, and a second v17
 * would be two formats behind one string — the failure the v13 note below
 * says is the one that matters. So the tender format is v18, and the
 * skipped v15 stays skipped.
 *
 * export-v17: the payments workspace joins the record — employee
 * payment requests with their per-financial-year counter, vendor
 * invoices, and the vendor payments that carry tax deducted at source
 * (migration 0080).
 *
 * export-v16: the inspection lifecycle (0082) joins the package — the
 * per-item clauses, the per-Work document checklist, the calls with
 * their item coverage, and the evidence with its stored PDFs. Left out,
 * an export could not explain why a Work's despatches were refused, nor
 * hand back the certificates that permitted the ones that went.
 *
 * v15 is SKIPPED and now unclaimed. The v16 note reserved it for this
 * payments pack, but inspection merged first and a v15 landing after v16
 * would be a format number that went BACKWARDS — a reader comparing two
 * exports would take the newer one for the older. So payments took v17
 * and v15 belongs to nothing. The reasoning is the v13 note's below: a
 * version string identifies a format, two formats sharing one string is
 * the failure that matters, and a gap is not.
 *
 * export-v14: the company document library (0079) joins the package —
 * the credentials themselves, their version history, and the stored
 * PDFs in the manifest. Left out, a data-portability export would hand
 * an agency back everything about its Works and nothing about the
 * company: no GST registration, no PAN, no experience certificates.
 *
 * export-v13: the two masters migration 0078 added — the canonical item
 * catalogue and the organisation's own bank accounts — join the record.
 * Both sections take `select *`, which for the bank accounts means the
 * STORED account number travels. That is deliberate and is not a
 * contradiction of `routes/organisation.ts`, which never projects that
 * column: the API withholds it because no screen needs it back, while
 * this export is the contractor's own portability snapshot and an export
 * you cannot restore an account from is not one. The contacts section
 * has carried beneficiary numbers on the same terms since 0078 too, by
 * the same `select *`.
 *
 * export-v12: every inbound PDF carries the digital-signature verdict
 * recorded when its bytes were accepted (0060) — signature_status,
 * signature_verdict and signature_verified_at ride along on loaDocuments.
 * The export is the incident procedure's evidence snapshot and the
 * contractor's data portability, and a document exported without the
 * verdict that was relied on when it was accepted is missing the part
 * that says whether it was authentic.
 *
 * export-v11: an ITEMISED invoice's lines (0057) join the record —
 * without them such an invoice would export as a header with no
 * document.
 */
const EXPORT_FORMAT_VERSION = 'export-v26';

/** Rows fetched per round-trip while streaming a section. Large enough
 * that a big table is not a per-row conversation, small enough that no
 * section is ever fully resident. */
const CURSOR_ROWS = 500;

/** One stored object the record refers to. */
interface ManifestEntry {
  readonly kind: string;
  readonly objectKey: unknown;
  readonly sha256: unknown;
}

/** Where a section's rows contribute to the object manifest. Buckets are
 * emitted in a fixed order (MANIFEST_ORDER), independent of the order
 * their sections stream, so the manifest reads the same as it always
 * has. */
type ManifestBucket =
  | 'organisation-logo'
  | 'loa-document'
  | 'received-railway-bill'
  | 'challan'
  | 'correction-notice'
  | 'pac-certificate'
  | 'company-document'
  | 'inspection'
  | 'tender-notice'
  | 'correspondence-scan'
  | 'issue-challan'
  | 'extension'
  | 'measurement-book'
  | 'credit-note'
  | 'tax-invoice-render'
  | 'eway-bill-render'
  | 'signed-document';

const MANIFEST_ORDER: readonly ManifestBucket[] = [
  'organisation-logo',
  'loa-document',
  'received-railway-bill',
  'challan',
  'correction-notice',
  'pac-certificate',
  'company-document',
  'inspection',
  'tender-notice',
  'correspondence-scan',
  'issue-challan',
  'extension',
  'measurement-book',
  'credit-note',
  'tax-invoice-render',
  'eway-bill-render',
  'signed-document',
];

type ExportRow = Record<string, unknown>;

interface ExportSection {
  /** The key this section is published under. */
  readonly key: string;
  /** The statement, streamed through a cursor. RLS scopes every one of
   * them; nothing here names the organisation id in SQL. */
  readonly sql: string;
  /** Columns postgres.js hands back as JSON text and the package
   * publishes as structured values. */
  readonly jsonbColumns?: readonly string[];
  /** Stored objects this section's rows refer to. */
  readonly manifest?: {
    readonly bucket: ManifestBucket;
    readonly entries: (row: ExportRow) => ManifestEntry[];
  };
}

/**
 * Every section of the package, in the order it is written — which is
 * also the order it is READ, and that order is load-bearing: the
 * consistency proof in `test/integrity.integration.test.ts` parks the
 * export on a `loa_documents` lock between the `works` read and the
 * `delivery_challans` read.
 *
 * The catalog-driven completeness test in the same file fails the build
 * when a tenant table has no section here, so a new table cannot be
 * silently left out of a recovery package.
 */
const SECTIONS: readonly ExportSection[] = [
  {
    key: 'members',
    /* Every grant is listed explicitly, so a new one that is not added
       here is silently dropped from the recovery package — a restored
       organisation would come back with the authority revoked and
       nobody able to pay a vendor until an owner noticed.

       `can_sign_documents` (0091) WAS missing, and this is the pack that
       found it: the export census is per-table, so a column left off this
       list is invisible to every check in the suite. It is added here
       beside `can_import_data`, and
       `test/integrity.integration.test.ts` gains a census that reads the
       catalog's own `can_%` columns and fails when one of them is absent
       from this statement — so the next pack's authority cannot be lost
       the same way. */
    sql: `select user_id, role, work_scope, can_issue_documents,
                 can_cancel_documents, can_approve_amendments,
                 can_manage_statutory_reporting, can_manage_payments,
                 can_manage_payroll, can_sign_documents, can_import_data,
                 status, created_at
          from organisation_memberships
          where organisation_id = app_private.current_organisation_id()
          order by created_at`,
  },
  {
    key: 'workAssignments',
    sql: `select user_id, work_id, created_at
          from work_assignments order by created_at`,
  },
  { key: 'works', sql: `select * from works order by created_at` },
  {
    key: 'workSchedules',
    sql: `select * from work_schedules order by work_id, position`,
  },
  {
    key: 'workItems',
    sql: `select * from work_items order by work_id, item_number`,
    jsonbColumns: ['source_evidence'],
  },
  {
    key: 'loaDocuments',
    sql: `select * from loa_documents order by created_at`,
    jsonbColumns: ['extraction_payload', 'identity_match', 'signature_verdict'],
    manifest: {
      bucket: 'loa-document',
      entries: (row) => [
        { kind: 'loa-document', objectKey: row.object_key, sha256: row.sha256 },
      ],
    },
  },
  {
    // The railway's own On-Account Bill (0066). Its bytes ride in the
    // archive beside the LOA and challan PDFs: it is the evidence the
    // organisation's settlements rest on, and an export without it would
    // hand back a chain with the counterparty's half missing.
    key: 'receivedRailwayBills',
    sql: `select * from received_railway_bills order by created_at`,
    jsonbColumns: ['extraction_payload', 'signature_verdict'],
    manifest: {
      bucket: 'received-railway-bill',
      entries: (row) => [
        {
          kind: 'received-railway-bill',
          objectKey: row.object_key,
          sha256: row.sha256,
        },
      ],
    },
  },
  {
    key: 'deliveryChallans',
    sql: `select * from delivery_challans order by created_at`,
    jsonbColumns: ['consignee_snapshot', 'issued_snapshot'],
    manifest: {
      bucket: 'challan',
      entries: (row) => [
        ...(row.rendered_object_key !== null
          ? [
              {
                kind: 'challan-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : []),
        ...(row.signed_copy_object_key !== null
          ? [
              {
                kind: 'challan-signed-copy',
                objectKey: row.signed_copy_object_key,
                sha256: row.signed_copy_sha256 ?? null,
              },
            ]
          : []),
      ],
    },
  },
  {
    key: 'deliveryChallanItems',
    sql: `select * from delivery_challan_items
          order by delivery_challan_id, position`,
    jsonbColumns: ['source_evidence'],
  },
  { key: 'challanReceipts', sql: `select * from challan_receipts order by created_at` },
  {
    key: 'challanItemSerials',
    sql: `select * from challan_item_serials order by created_at`,
  },
  {
    key: 'issueChallans',
    sql: `select * from issue_challans order by created_at, id`,
    jsonbColumns: ['issued_snapshot'],
    manifest: {
      bucket: 'issue-challan',
      entries: (row) => [
        ...(row.rendered_object_key !== null
          ? [
              {
                kind: 'issue-challan-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : []),
        ...(row.signed_copy_object_key !== null
          ? [
              {
                kind: 'issue-challan-signed-copy',
                objectKey: row.signed_copy_object_key,
                sha256: row.signed_copy_sha256 ?? null,
              },
            ]
          : []),
      ],
    },
  },
  {
    key: 'issueChallanLines',
    sql: `select * from issue_challan_lines order by issue_challan_id, position`,
  },
  { key: 'workInstruments', sql: `select * from work_instruments order by created_at` },
  {
    key: 'extensionRequests',
    sql: `select * from extension_requests order by created_at, id`,
    jsonbColumns: ['finalised_snapshot'],
    manifest: {
      bucket: 'extension',
      entries: (row) => [
        ...(row.rendered_object_key !== null
          ? [
              {
                kind: 'extension-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : []),
        ...(row.response_object_key !== null
          ? [
              {
                kind: 'extension-response-document',
                objectKey: row.response_object_key,
                sha256: row.response_sha256 ?? null,
              },
            ]
          : []),
      ],
    },
  },
  {
    key: 'mbEntries',
    sql: `select * from mb_entries order by measured_on, created_at`,
  },
  {
    key: 'bills',
    sql: `select * from bills order by work_id, bill_number`,
    jsonbColumns: ['lines_snapshot'],
  },
  {
    // The payment register (0067). Deductions follow their payment, and
    // both are ordered so a diff of two exports is readable.
    key: 'billPayments',
    sql: `select * from bill_payments order by bill_id, received_on, id`,
  },
  {
    key: 'billPaymentDeductions',
    sql: `select * from bill_payment_deductions
          order by bill_payment_id, category, id`,
  },
  {
    // Outbound money (0080). Payments follow their invoice and requests
    // follow their sequence, so a diff of two exports is readable.
    key: 'paymentRequests',
    sql: `select * from payment_requests order by fy_label, sequence_number, id`,
  },
  {
    key: 'paymentRequestCounters',
    sql: `select * from payment_request_counters order by fy_label`,
  },
  {
    key: 'vendorInvoices',
    sql: `select * from vendor_invoices
          order by vendor_contact_id, invoice_date, id`,
  },
  {
    key: 'vendorPayments',
    sql: `select * from vendor_payments order by vendor_invoice_id, paid_on, id`,
  },
  {
    key: 'installations',
    sql: `select * from installations order by installed_on, created_at, id`,
  },
  {
    key: 'installationSerials',
    sql: `select * from installation_serials order by created_at, id`,
  },
  {
    key: 'approvalRequests',
    sql: `select * from approval_requests order by created_at, id`,
    jsonbColumns: ['proposed', 'diff'],
  },
  // The railway variation orders cited for omissions (0058). The stored
  // PDFs travel with the object store, as every uploaded document does;
  // this is the row that proves which order authorised which omission,
  // and its verdict.
  {
    key: 'amendmentVariationOrders',
    sql: `select * from amendment_variation_orders order by created_at, id`,
    jsonbColumns: ['verdict'],
  },
  // Which Works were withdrawn, why, on whose approval, and what replaced
  // them (0071). A recovery package that carried the successor and not the
  // withdrawal would present a Work with no history.
  {
    key: 'workSupersessions',
    sql: `select * from work_supersessions order by superseded_at, id`,
  },
  {
    key: 'correctionNotices',
    sql: `select * from correction_notices order by created_at, id`,
    jsonbColumns: ['snapshot'],
    manifest: {
      bucket: 'correction-notice',
      entries: (row) =>
        row.rendered_object_key !== null
          ? [
              {
                kind: 'correction-notice-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : [],
    },
  },
  {
    key: 'paymentMatrices',
    sql: `select * from payment_matrices order by work_id, category`,
  },
  {
    key: 'pacCertificates',
    sql: `select * from pac_certificates order by issue_date, created_at, id`,
    manifest: {
      bucket: 'pac-certificate',
      entries: (row) =>
        row.document_object_key !== null
          ? [
              {
                kind: 'pac-certificate-document',
                objectKey: row.document_object_key,
                sha256: row.document_sha256 ?? null,
              },
            ]
          : [],
    },
  },
  {
    key: 'pacCertificateItems',
    sql: `select * from pac_certificate_items
          order by pac_certificate_id, work_item_id`,
  },
  // Milestone 8 phase 2 (Measurement Book lifecycle).
  {
    key: 'measurementBooks',
    sql: `select * from measurement_books order by created_at, id`,
    manifest: {
      bucket: 'measurement-book',
      entries: (row) =>
        row.rendered_object_key !== null
          ? [
              {
                kind: 'measurement-book-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : [],
    },
  },
  {
    key: 'measurementBookLines',
    sql: `select * from measurement_book_lines
          order by measurement_book_id, item_number, id`,
  },
  { key: 'mbSources', sql: `select * from mb_sources order by created_at, id` },
  {
    key: 'measurementBookMergeProvenance',
    sql: `select * from measurement_book_merge_provenance
          order by target_measurement_book_id, record_measurement_book_id,
                   source_type nulls first, source_id, id`,
  },
  {
    key: 'importBatches',
    sql: `select * from import_batches order by started_at, id`,
    jsonbColumns: ['reconciliation'],
  },
  {
    key: 'importRecords',
    sql: `select * from import_records order by imported_at, id`,
    jsonbColumns: ['payload'],
  },
  // The spreadsheet importer (0094). Adjacent to the two sections above
  // on purpose: those are the v1 cutover CLI's, these are the product
  // feature's, and a reader of a recovery package who does not know they
  // are different will otherwise assume one of them is a duplicate.
  //
  // BOTH TABLES TRAVEL, and the row table travels WITHOUT ITS CELLS.
  // `test/integrity.integration.test.ts` § NOT_EXPORTED is where a table
  // is declared scratch, and it holds exactly one entry after eight waves
  // — a bar neither of these clears. The verdicts are what makes a
  // committed import auditable: which row, what was wrong with it in the
  // register's own words, and what it became. None of that is a value.
  //
  // The cells are, and for a contacts sheet they are a column of bank
  // account numbers and IFSCs — the values `contact-fields.ts` says are
  // "never audited and never logged". The register they fed already holds
  // the authoritative copy under that discretion, so a second unredacted
  // copy here would be the one place it did not reach.
  {
    key: 'spreadsheetImportBatches',
    sql: `select * from spreadsheet_import_batches order by created_at, id`,
  },
  {
    key: 'spreadsheetImportRows',
    sql: `select id, organisation_id, batch_id, row_number, status, errors,
                 imported_record_id
          from spreadsheet_import_rows order by batch_id, row_number`,
    jsonbColumns: ['errors'],
  },
  // M6/7 retrofit (migration 0028): the unified Contacts master and the
  // Work<->consignee association. consignee_masters was never a section
  // of this export; contacts supersedes it, so the format became part of
  // the current export with the procurement/statutory set.
  { key: 'contacts', sql: `select * from contacts order by created_at, id` },
  {
    key: 'workConsignees',
    sql: `select * from work_consignees order by created_at, id`,
  },
  { key: 'locationMasters', sql: `select * from location_masters order by name, id` },
  { key: 'unitMasters', sql: `select * from unit_masters order by name, id` },
  {
    key: 'gstRates',
    sql: `select * from gst_rates order by rate, effective_from, id`,
  },
  {
    key: 'organisationSignatories',
    sql: `select * from organisation_signatories order by created_at, id`,
  },
  // Migration 0078. Aliases are a text[] rather than jsonb, so no
  // jsonbColumns entry: the driver already hands back a JavaScript array.
  {
    key: 'canonicalItems',
    sql: `select * from canonical_items order by group_name, name, id`,
  },
  {
    key: 'organisationBankAccounts',
    sql: `select * from organisation_bank_accounts order by created_at, id`,
  },
  {
    // The company document library (0079). Organisation-level master
    // data like the rows above it, and the only one of them with stored
    // bytes — the credential PDFs travel in the manifest so an export
    // taken for a data-portability request carries the certificates and
    // not merely the fact that they existed.
    key: 'companyDocuments',
    sql: `select * from company_documents order by lower(title), id`,
  },
  {
    key: 'companyDocumentVersions',
    sql: `select * from company_document_versions
          order by company_document_id, version_number`,
    manifest: {
      bucket: 'company-document',
      entries: (row) => [
        {
          kind: 'company-document-version',
          objectKey: row.object_key,
          sha256: row.sha256 ?? null,
        },
      ],
    },
  },
  {
    // The inspection lifecycle (0082). The clause is what makes a
    // despatch refusable, so an export without it could not explain the
    // Work's own history; the call documents carry stored bytes and
    // travel in the manifest for the same reason the credential PDFs do.
    key: 'inspectionClauses',
    sql: `select * from inspection_clauses order by work_id, work_item_id`,
  },
  {
    key: 'inspectionChecklistFields',
    sql: `select * from inspection_checklist_fields
          order by work_id, agency, position, id`,
  },
  {
    key: 'inspectionCallCounters',
    sql: `select * from inspection_call_counters order by work_id`,
  },
  {
    key: 'inspectionCalls',
    sql: `select * from inspection_calls order by work_id, sequence_number`,
  },
  {
    key: 'inspectionCallItems',
    sql: `select * from inspection_call_items
          order by inspection_call_id, work_item_id`,
  },
  {
    key: 'inspectionCallDocuments',
    sql: `select * from inspection_call_documents
          order by inspection_call_id, position, id`,
    manifest: {
      bucket: 'inspection',
      // An empty checklist row carries no bytes yet — it is a demand
      // outstanding — so it contributes no manifest entry rather than an
      // entry pointing at nothing.
      entries: (row) =>
        row.object_key === null
          ? []
          : [
              {
                kind: 'inspection-call-document',
                objectKey: row.object_key,
                sha256: row.sha256 ?? null,
              },
            ],
    },
  },
  {
    // The tender pipeline (0083). Organisation-level like the library
    // above it, and ordered by closing moment so the export reads the way
    // the register does. The children follow their parent so a restore
    // sees the tender before the lines that hang off it.
    key: 'tenders',
    sql: `select * from tenders order by bid_closes_at, id`,
  },
  {
    key: 'tenderNotices',
    sql: `select * from tender_notices order by created_at, id`,
    jsonbColumns: ['extraction_payload'],
    manifest: {
      bucket: 'tender-notice',
      entries: (row) => [
        {
          kind: 'tender-notice',
          objectKey: row.object_key,
          sha256: row.sha256 ?? null,
        },
      ],
    },
  },
  {
    key: 'tenderChecklistItems',
    sql: `select * from tender_checklist_items order by tender_id, created_at, id`,
  },
  {
    key: 'tenderStatusEvents',
    sql: `select * from tender_status_events order by tender_id, occurred_at, id`,
  },
  {
    key: 'correspondenceLetters',
    sql: `select * from correspondence_letters order by letter_date, id`,
    manifest: {
      bucket: 'correspondence-scan',
      entries: (row) =>
        row.scan_object_key === null
          ? []
          : [
              {
                kind: 'correspondence-scan',
                objectKey: row.scan_object_key,
                sha256: row.scan_sha256,
              },
            ],
    },
  },
  {
    key: 'correspondenceLetterCounters',
    sql: `select * from correspondence_letter_counters
          order by direction, fy_label`,
  },
  {
    key: 'purchaseOrders',
    sql: `select * from purchase_orders order by created_at, id`,
    jsonbColumns: ['vendor_snapshot'],
  },
  {
    key: 'purchaseOrderLines',
    sql: `select * from purchase_order_lines order by purchase_order_id, line_number, id`,
  },
  {
    key: 'budgetaryQuotations',
    sql: `select * from budgetary_quotations order by created_at, id`,
    jsonbColumns: ['customer_snapshot'],
  },
  {
    key: 'budgetaryQuotationLines',
    sql: `select * from budgetary_quotation_lines
          order by budgetary_quotation_id, line_number, id`,
  },
  {
    key: 'taxInvoices',
    sql: `select * from tax_invoices order by created_at, id`,
    jsonbColumns: ['buyer_snapshot', 'ship_to_snapshot', 'issued_snapshot'],
  },
  // An ITEMISED invoice's document IS its lines (0057), so an export
  // without them would hand back an incomplete invoice.
  {
    key: 'taxInvoiceLines',
    sql: `select * from tax_invoice_lines order by tax_invoice_id, position, id`,
  },
  {
    key: 'taxInvoiceRenders',
    sql: `select * from tax_invoice_renders
          order by tax_invoice_id, version, created_at, id`,
    manifest: {
      bucket: 'tax-invoice-render',
      entries: (row) => [
        {
          kind: 'tax-invoice-rendered-pdf-version',
          objectKey: row.object_key,
          sha256: row.pdf_sha256,
        },
        ...(row.logo_object_key === null
          ? []
          : [
              {
                kind: 'tax-invoice-render-logo',
                objectKey: row.logo_object_key,
                sha256: row.logo_sha256,
              },
            ]),
      ],
    },
  },
  {
    key: 'creditNotes',
    sql: `select * from credit_notes order by created_at, id`,
    jsonbColumns: ['issued_snapshot'],
    manifest: {
      bucket: 'credit-note',
      entries: (row) =>
        row.rendered_object_key !== null
          ? [
              {
                kind: 'credit-note-rendered-pdf',
                objectKey: row.rendered_object_key,
                sha256: row.rendered_sha256 ?? null,
              },
            ]
          : [],
    },
  },
  { key: 'ewayBills', sql: `select * from eway_bills order by created_at, id` },
  {
    key: 'ewayBillRenders',
    sql: `select * from eway_bill_renders
          order by eway_bill_id, version, created_at, id`,
    manifest: {
      bucket: 'eway-bill-render',
      entries: (row) => [
        {
          kind: 'eway-bill-rendered-pdf-version',
          objectKey: row.object_key,
          sha256: row.pdf_sha256,
        },
      ],
    },
  },
  {
    key: 'documentNumberSeries',
    sql: `select * from document_number_series order by document_type`,
  },
  {
    key: 'statutoryProviderOperations',
    sql: `select * from statutory_provider_operations order by started_at, id`,
  },
  // OEM production (0084). Organisation-level, like the masters above
  // it: the item master and its bill of material describe what the
  // factory can build and outlive every Work built against them. The
  // children follow their parents so a restore sees an item before the
  // edge that names it, and a job card before its units.
  {
    key: 'productionItems',
    sql: `select * from production_items order by item_code, id`,
    jsonbColumns: ['specifications'],
  },
  {
    key: 'productionBomLines',
    sql: `select * from production_bom_lines order by parent_item_id, component_item_id`,
  },
  {
    key: 'productionJobCards',
    sql: `select * from production_job_cards order by fy_label, sequence_number, id`,
  },
  {
    key: 'productionSerials',
    sql: `select * from production_serials order by item_id, sequence_number, id`,
  },
  {
    // The genealogy. Ordered by the unit it belongs to, so a restore
    // reads a finished serial's components together.
    key: 'productionComponentSerials',
    sql: `select * from production_component_serials order by finished_serial_id, component_item_id, serial_number`,
  },
  {
    key: 'productionDispatches',
    sql: `select * from production_dispatches order by job_card_id, sequence_number, id`,
  },
  {
    key: 'productionDispatchSerials',
    sql: `select * from production_dispatch_serials order by production_dispatch_id, production_serial_id`,
  },
  {
    // The stock ledger (0087), placed AFTER the production tables it
    // points at. Sections stream in the order they are listed, so a
    // movement naming a despatch follows that despatch — the
    // parents-before-children ordering every other section here keeps,
    // and the reason this one is not up beside the purchase orders that
    // its other foreign key names.
    //
    // Ordered by the part and its ledger position, which is the order the
    // balances were built in. Note what that does and does not promise:
    // NO IMPORTER EXISTS for this format, and a naive one would not
    // simply replay these rows — every insert re-enters
    // `app_private.guard_stock_movement`, which re-derives
    // `balance_after`, re-reads the CURRENT status of the purchase order
    // or job card each movement names, and refuses a date behind the
    // part's last. A restore is a rebuild against today's state, not a
    // replay of yesterday's, and an importer will have to say so — most
    // likely by loading as the owner role with the trigger disabled, the
    // way 0043 handled the same problem. What this export guarantees is
    // that every row needed to do that is present.
    key: 'stockMovements',
    sql: `select * from stock_movements
          order by production_item_id, sequence_number`,
  },
  {
    // The kiosk credentials (0091), before the requests that name them.
    //
    // WHAT IS AND IS NOT IN THIS SECTION. `select *` would publish
    // `token_hash`, and a signing credential's hash has no business in a
    // file the organisation downloads and mails to its accountant: it is
    // not evidence of anything — a signature is proved by its
    // certificate, never by the bearer token that requested it — and it
    // is the one value an offline attacker could grind. The columns are
    // therefore named, not starred, and the certificate travels in full
    // because that IS the evidence.
    key: 'signingAgents',
    sql: `select id, organisation_id, label, certificate_thumbprint,
                 certificate_subject, certificate_serial, certificate_not_after,
                 certificate_chain_pem, operator_user_id, created_by_user_id,
                 created_at, last_seen_at, revoked_at, revoked_by_user_id
          from signing_agents order by created_at, id`,
  },
  {
    // The signing trail (0091, ADR-0012). A restored organisation must be
    // able to prove WHAT was signed, WHEN, and BY WHICH CERTIFICATE, and
    // all three are here: the source key and its digest say what, the
    // completion timestamp and the verifier's own verdict say when and on
    // what evidence, and the thumbprint joins to the chain in the section
    // above.
    //
    // The signed BYTES are not here, for the reason no other section
    // carries bytes either: stored objects travel in `objectManifest`,
    // which already lists every key this package references, and
    // `signed_object_key` is one of them.
    key: 'signingRequests',
    sql: `select * from signing_requests order by requested_at, id`,
    jsonbColumns: ['signature_verdict'],
    manifest: {
      bucket: 'signed-document',
      entries: (row) =>
        row.signed_object_key !== null
          ? [
              {
                kind: 'signed-document-pdf',
                objectKey: row.signed_object_key,
                sha256: row.signed_sha256 ?? null,
              },
            ]
          : [],
    },
  },
  {
    // Maintenance (0088). Five sections, and every one of them is load
    // bearing: the request states what was asked for, but how much of it
    // is reserved, has gone out and has come back is DERIVED from the
    // dispatch lines and the returns. An export carrying the requests
    // alone would restore an organisation whose every maintenance line
    // read as untouched, with challan numbers already signed for.
    key: 'maintenanceRequests',
    sql: `select * from maintenance_requests
          order by financial_year, sequence_number`,
  },
  {
    key: 'maintenanceRequestLines',
    sql: `select * from maintenance_request_lines
          order by maintenance_request_id, position`,
  },
  {
    key: 'maintenanceDispatches',
    sql: `select * from maintenance_dispatches order by work_id, sequence_number`,
  },
  {
    key: 'maintenanceDispatchLines',
    sql: `select * from maintenance_dispatch_lines
          order by maintenance_dispatch_id, maintenance_request_line_id`,
  },
  {
    key: 'maintenanceReturns',
    sql: `select * from maintenance_returns
          order by maintenance_request_id, received_on, id`,
  },
  {
    key: 'deliveryChallanCounters',
    sql: `select * from delivery_challan_counters order by work_id`,
  },
  { key: 'billCounters', sql: `select * from bill_counters order by work_id` },
  {
    key: 'extensionRequestCounters',
    sql: `select * from extension_request_counters order by work_id`,
  },
  {
    key: 'issueChallanCounters',
    sql: `select * from issue_challan_counters order by work_id`,
  },
  {
    key: 'correctionNoticeCounters',
    sql: `select * from correction_notice_counters order by work_id`,
  },
  {
    key: 'measurementBookCounters',
    sql: `select * from measurement_book_counters order by work_id`,
  },
  {
    key: 'purchaseOrderCounters',
    sql: `select * from purchase_order_counters order by work_id`,
  },
  {
    // Not a document series, but exported for the same reason every
    // other counter is: a restore that replayed the ledger without it
    // would start the next movement's position back at one and put two
    // rows at the same point in an item's history (0087).
    key: 'stockMovementCounters',
    sql: `select * from stock_movement_counters order by production_item_id`,
  },
  {
    // Both maintenance series (0088), for the reason every counter here
    // travels: without them a restored organisation reissues a request
    // number somebody has quoted and a challan number a site receiver
    // has already signed for.
    key: 'maintenanceRequestCounters',
    sql: `select * from maintenance_request_counters order by fy_label`,
  },
  {
    key: 'maintenanceDispatchCounters',
    sql: `select * from maintenance_dispatch_counters order by work_id`,
  },
  {
    key: 'budgetaryQuotationCounters',
    sql: `select * from budgetary_quotation_counters order by organisation_id`,
  },
  {
    key: 'taxInvoiceCounters',
    sql: `select * from tax_invoice_counters order by fy_label`,
  },
  {
    key: 'creditNoteCounters',
    sql: `select * from credit_note_counters order by fy_label`,
  },
  // The standalone Delivery Challan's per-FY sequence (0056). Found
  // missing by the catalog-driven completeness test: recovery needs
  // every counter, or a restored organisation reissues numbers it has
  // already used.
  {
    key: 'standaloneChallanCounters',
    sql: `select * from standalone_challan_counters order by fy_label`,
  },
  // The three production counters (0084). A serial counter especially:
  // its numbers are stamped on hardware, so a restore that reset one
  // would mint a second unit bearing a number already in the field.
  {
    key: 'productionJobCardCounters',
    sql: `select * from production_job_card_counters order by fy_label`,
  },
  {
    key: 'productionSerialCounters',
    sql: `select * from production_serial_counters order by production_item_id`,
  },
  {
    key: 'productionDispatchCounters',
    sql: `select * from production_dispatch_counters order by job_card_id`,
  },
  // Payroll (0089, 0090). Ordered parents before children, and the
  // schedules before the runs that read them, so a restore replaying
  // this package in section order never references a row it has not
  // written yet.
  {
    key: 'payrollStatutoryRates',
    sql: `select * from payroll_statutory_rates
          order by parameter, effective_from, id`,
  },
  {
    key: 'professionalTaxSlabs',
    sql: `select * from professional_tax_slabs
          order by state_code, payee_category, effective_from,
                   monthly_wage_from, id`,
  },
  {
    key: 'incomeTaxSlabs',
    sql: `select * from income_tax_slabs
          order by regime, payee_category, effective_from,
                   annual_income_from, id`,
  },
  {
    key: 'employees',
    sql: `select * from employees order by employee_code, id`,
  },
  {
    key: 'payrollRuns',
    sql: `select * from payroll_runs order by fy_label, sequence_number, id`,
  },
  {
    key: 'payrollRunLines',
    sql: `select * from payroll_run_lines
          order by payroll_run_id, employee_code, id`,
  },
  // The payroll counter, for the reason the production note above gives:
  // a restore that reset it would hand out a run number the organisation
  // has already used, and a gap-free series a provident-fund inspector
  // reads is the one thing a payroll number is for.
  {
    key: 'payrollRunCounters',
    sql: `select * from payroll_run_counters order by fy_label`,
  },
];

const rowsSchema = Type.Array(Type.Record(Type.String(), Type.Unknown()));

/**
 * The 200 shape, declared so the OpenAPI document stops calling the
 * organisation's whole business record an untyped success. It documents
 * the package rather than serialising it: the body is a stream, and
 * Fastify pipes a stream without running a serializer over it.
 */
const ExportResponseSchema = Type.Object(
  {
    exportedAt: Type.String({ format: 'date-time' }),
    formatVersion: Type.Literal(EXPORT_FORMAT_VERSION),
    organisation: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    ...(Object.fromEntries(
      SECTIONS.map((section) => [section.key, rowsSchema]),
    ) as Record<string, TSchema>),
    objectManifest: Type.Array(
      Type.Object(
        {
          kind: Type.String(),
          objectKey: Type.Unknown(),
          sha256: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
    ),
    auditEvents: rowsSchema,
  },
  {
    description:
      'The complete tenant record: one array per section, plus a manifest of every stored object it refers to.',
  },
);

function parseRow(row: ExportRow, jsonbColumns: readonly string[]): ExportRow {
  if (jsonbColumns.length === 0) return row;
  const parsed = { ...row };
  for (const column of jsonbColumns) {
    parsed[column] = parseJsonbColumn(row[column]);
  }
  return parsed;
}

/** Writes to the response stream, waiting for the consumer whenever the
 * buffer fills — the reason this route no longer holds the whole package
 * in memory. */
class ChunkWriter {
  constructor(private readonly stream: PassThrough) {}

  async write(chunk: string): Promise<void> {
    if (!this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
  }
}

/**
 * Full-organisation export (docs/SECURITY.md §incident/export procedures;
 * Milestone 4 support tooling). Owner-only: this is the tenant's complete
 * business record — data portability for the contractor, and the escape
 * hatch an incident procedure needs. RLS scopes every query; nothing here
 * names the organisation id in SQL.
 */
export function registerExportRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);
  tenantRoute(
    {
      method: 'GET',
      url: '/api/export',
      schema: { response: { 200: ExportResponseSchema, ...errorResponses } },
    },
    async ({ reply, user, organisationId, tenantSnapshot }) => {
      // REPEATABLE READ, not the default READ COMMITTED. The package below
      // is built from around sixty sequential SELECTs, and under READ
      // COMMITTED each one takes its own snapshot: a writer committing
      // midway is invisible to the earlier queries and visible to the
      // later ones, so the exported package can be referentially broken —
      // challan items whose parent challan is absent, lines pointing at a
      // document read before it existed. One snapshot for the whole
      // transaction makes the package a true picture of a single instant.
      // The transaction stays read-write for the audit event at the end.
      return tenantSnapshot(async (tx) => {
        await requireOwner(tx, user.id);

        // The package is STREAMED: each section is read through a cursor
        // and written straight to the response, so a large tenant no
        // longer needs its entire record — every row of every table —
        // resident in the server's heap at once, and the client starts
        // receiving before the last table is read. The transaction stays
        // open for the whole write, which is what keeps the one-instant
        // guarantee above.
        const stream = new PassThrough();
        const out = new ChunkWriter(stream);
        reply.header('content-type', 'application/json; charset=utf-8');
        void reply.send(stream);

        const manifest = new Map<ManifestBucket, ManifestEntry[]>();
        const collect = (bucket: ManifestBucket, entries: ManifestEntry[]): void => {
          if (entries.length === 0) return;
          const existing = manifest.get(bucket);
          if (existing) existing.push(...entries);
          else manifest.set(bucket, [...entries]);
        };

        try {
          await out.write(
            `{"exportedAt":${JSON.stringify(new Date().toISOString())},` +
              `"formatVersion":${JSON.stringify(EXPORT_FORMAT_VERSION)},`,
          );

          const [organisation] = await tx<ExportRow[]>`
            select * from organisations
            where id = app_private.current_organisation_id()
          `;
          if (organisation && organisation.logo_object_key !== null) {
            collect('organisation-logo', [
              {
                kind: 'organisation-logo',
                objectKey: organisation.logo_object_key,
                sha256: null,
              },
            ]);
          }
          await out.write(`"organisation":${JSON.stringify(organisation ?? null)},`);

          for (const section of SECTIONS) {
            await out.write(`${JSON.stringify(section.key)}:[`);
            let separator = '';
            // The async-iterable cursor: PostgreSQL hands back
            // CURSOR_ROWS at a time and the section is written as it
            // arrives, so no table is ever fully resident.
            for await (const rows of tx
              .unsafe(section.sql)
              .cursor(CURSOR_ROWS) as AsyncIterable<ExportRow[]>) {
              for (const row of rows) {
                const parsed = parseRow(row, section.jsonbColumns ?? []);
                if (section.manifest) {
                  collect(section.manifest.bucket, section.manifest.entries(parsed));
                }
                await out.write(separator + JSON.stringify(parsed));
                separator = ',';
              }
            }
            await out.write('],');
          }

          // A portable manifest of every stored object the record refers
          // to — logo, uploaded LOAs, rendered and signed PDFs — with the
          // recorded hashes, so an offboarding or incident package can
          // fetch and verify the bytes (external re-audit). Emitted in a
          // fixed bucket order, so streaming the sections did not reorder
          // it.
          const objectManifest = MANIFEST_ORDER.flatMap(
            (bucket) => manifest.get(bucket) ?? [],
          );
          await out.write(`"objectManifest":${JSON.stringify(objectManifest)},`);

          // Recorded before the audit section is read, so the package
          // contains its own audit record.
          await tx`
            insert into audit_events (
              organisation_id, actor_user_id, action, entity_type, details
            )
            values (
              ${organisationId}, ${user.id}, 'organisation.exported',
              'organisations', '{}'::jsonb
            )
          `;
          await out.write('"auditEvents":[');
          let separator = '';
          for await (const rows of tx
            .unsafe(`select * from audit_events order by occurred_at, id`)
            .cursor(CURSOR_ROWS) as AsyncIterable<ExportRow[]>) {
            for (const row of rows) {
              await out.write(separator + JSON.stringify(parseRow(row, ['details'])));
              separator = ',';
            }
          }
          await out.write(']}');
          stream.end();
          // The transaction closes only once the client has the whole
          // package: the snapshot is what makes it internally consistent.
          await finished(stream).catch(() => undefined);
        } catch (error) {
          // A half-written package must not read as a whole one: the
          // response is destroyed, which the client sees as a truncated
          // body, and the transaction rolls back.
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        return reply;
      });
    },
  );
}

async function requireOwner(tx: TransactionSql, userId: string): Promise<void> {
  const [membership] = await tx<{ role: string }[]>`
    select role from organisation_memberships
    where user_id = ${userId}
      and organisation_id = app_private.current_organisation_id()
  `;
  if (membership?.role !== 'owner') {
    throw httpError(
      403,
      'OWNER_REQUIRED',
      'Only an organisation owner may export the organisation.',
    );
  }
}
