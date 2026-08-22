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
 * export-v38: a contact's ADDRESS LIST (migration 0116) joins the
 * package.
 *
 * It travels for the reason the contacts section itself travels: the
 * primary address is mirrored onto `contacts`, so a restore without this
 * section would come back with every contact holding exactly one address
 * and every second address — the vendor's works, the consignee's goods
 * shed — silently gone. An inspection clause citing one would restore
 * pointing at nothing.
 *
 * Numbered 38 by coordinator allocation: versions are monotonic with the
 * order packages MERGE, not the order they are branched (the notes
 * below say the same) — v36 went to the Zoho register and v37 to the
 * production-item kinds that landed first.
 *
 * ---------------------------------------------------------------------
 * export-v37: what kind of catalogue entry a production item is (0117)
 * rides along. The `productionItems` section takes `select *`, so
 * `item_role` travels without an edit here — what moves the version is
 * the format, not the query: a v36 package restored into a 0117 schema
 * would land every item on the column's default and file the agency's
 * own products as parts, so a reader has to be able to tell the two
 * shapes apart by the string alone. No new section, no manifest change.
 *
 * NUMBERED 37 AT MERGE, not when this pack was written: it was branched
 * claiming 35, and 0114's and 0115's packages landed on main first and
 * took 35 and 36. Same rule as the two notes below — export versions are
 * monotonic with the order packages MERGE, and `export-format.ts` moves
 * with this one.
 *
 * ---------------------------------------------------------------------
 * export-v36: the historical Zoho Books register (0115) joins the package
 * — the invoices this organisation raised before this application
 * existed, their lines, and the raw export row each was read from.
 *
 * NUMBERED 36 AT MERGE, not when this pack was written: it was branched
 * claiming 35, and 0114's package landed on main first and took it.
 * Export versions are monotonic with the order packages MERGE rather than
 * the order they are branched — a version string identifies a format, two
 * formats sharing one string is the failure that matters, and a gap is
 * not. `apps/server/test/helpers/export-format.ts` carries the value the
 * suite expects and moves with this one.
 *
 * It travels because the whole export exists to hand an organisation back
 * everything of its own, and five years of billing is not an exception to
 * that. The raw CSV row rides as the stored jsonb rather than being
 * rebuilt from the typed columns beside it: the row is the truth source
 * and the columns are a reading of it, so a package that reconstructed it
 * would return this schema's opinion of the export instead of the export.
 *
 * ---------------------------------------------------------------------
 * export-v35: the opening billing position of a pre-system Work (0114)
 * joins the package — the baseline, its per-item lines, the opening
 * deductions, and the two railway documents it rests on.
 *
 * It travels because for an IMPORTED Work it is not a copy of anything.
 * Every other prior-cumulative figure in this package can be re-derived
 * from the Measurement Books beside it; a Work that arrived at the v1
 * cutover has no Measurement Books here, and the baseline IS its billing
 * memory. A package that dropped it would restore an organisation whose
 * imported Works bill from zero and re-claim quantities the railway paid
 * for years ago. The confirmations travel with the lines for migration
 * 0111's reason, restated one document back: on a figure a person
 * confirmed, the opening position rests on that person, and a package
 * without their name restores the figure with no account of it.
 *
 * NUMBERED 35, and allocated at merge time rather than claimed when the
 * pack was written — export versions are monotonic with the order
 * packages MERGE, not the order they are branched. See the v32 note
 * below for why a gap is not a defect.
 *
 * ---------------------------------------------------------------------
 * export-v34: the railway's own measurement (0111) joins the package —
 * the document IWRCMS raises its On-Account Bill from, its per-line
 * verdicts, and the manual confirmations that stood in for a reading
 * when the PDF could not be extracted.
 *
 * The bill has travelled since export-v1 and the measurement behind it
 * did not exist until now, so this is the first version in which a
 * restored organisation can answer the question the gate asks: not "was
 * this bill received", which the bill's own row already said, but "was
 * it ever allowed to be". Both halves of the answer travel — the stored
 * verdicts for a document that was read, and the named confirmations for
 * one that was not — because on an unreadable measurement the gate rests
 * on a person, and a package that dropped their statement would restore
 * a settlement with no account of why it was accepted.
 *
 * The bytes ride in the archive beside the bill's. A verdict without the
 * document it was computed over is a claim, which is the same reason
 * every other inbound PDF in this package carries its file.
 *
 * NUMBERED 34, AND v32 IS DELIBERATELY SKIPPED — read this before
 * "correcting" it back to the allocated number.
 *
 * This pack claimed v31 while it was written, lost it to 0106, and was
 * then ALLOCATED v32 on the expectation that it would merge before
 * 0109. It did not: 0109 merged first and took v33. Emitting v32 now
 * would label a package that contains v33's org-purchase-order sections
 * with a lower number than the pack that added them, and — the failure
 * that actually matters — would leave two different shapes answering to
 * `export-v33`: main's, without the railway measurement, and this
 * tree's, with it. The v24 note names that hazard and settles the
 * remedy in the same breath: "a version string identifies a format, two
 * formats sharing one string is the failure that matters, and a gap is
 * not."
 *
 * So the gap is taken. v32 was allocated and never emitted; no package
 * will ever carry it.
 *
 * export-v33: purchase orders raised outside any LOA (0109) bring a
 * second numbering counter, and the vendor tax invoice brings BYTES.
 *
 * `organisationPurchaseOrderCounters` is a new top-level section, which
 * is what moves this version at all: a restored organisation without it
 * would hand out `PO-01` a second time. The two altered tables need no
 * entry — `purchaseOrders` and `vendorInvoices` both export `select *`,
 * so the relaxed `work_id` and the eight new invoice columns ride them.
 *
 * THE MANIFEST BUCKET IS THE POINT OF THE VERSION, THOUGH. 0109 made a
 * purchase order's close depend on a vendor tax invoice whose PDF is
 * stored, and its own header says why the bytes are stored rather than
 * referenced: "a stored key with no upload behind it and no route to
 * fetch it is a proof that cannot be produced". An export that published
 * the invoice ROW without the file would restore an organisation holding
 * closed orders whose proof cannot be produced — the same sentence, one
 * layer out. The bytes travel, beside the credential and certificate
 * PDFs they sit next to in kind.
 *
 * (export-v32 is #159's; this pack takes v33 by coordinator allocation
 * rather than by claiming the next free number on merge.)
 *
 * export-v31: the measured-quantity adjustments (0106) join the package —
 * one row per draft Measurement Book line an operator reduced.
 *
 * They live only on DRAFTS, which is exactly why they travel. A restored
 * organisation whose open draft came back with its source selection but
 * not its adjustments would recompute that draft at the full claimed
 * quantity, and the operator would meet the difference as a preview that
 * silently disagrees with the one they left. Finalized books need nothing
 * here: their lines already carry the adjusted quantity as the snapshot.
 *
 * The AMC billing cycles (0107) add no entry: `workSchedules` already
 * exports with `select *`, so the two new columns ride it.
 *
 * export-v30: the defect liability periods (0099) join the package — the
 * Work's warranty term, and one row per installation whose warranty
 * clock has been started.
 *
 * Both tables travel, and the reason is the Performance Bank Guarantee.
 * A restored organisation that could not say when each installation
 * comes out of warranty could not say when its guarantees may be
 * released either, and a guarantee left standing after the liability
 * ended is money the agency's bank is holding for nothing. The expiry is
 * a STORED legal date rather than a derivation from the term, which is
 * what makes the export self-sufficient: a period extended after a
 * defect, or started under a term the Work has since corrected, restores
 * as the date the railway is actually holding cover against rather than
 * as whatever the current term would recompute.
 *
 * The reason each extension was granted does NOT live in these tables —
 * it lives in `audit_events`, which this package has exported since v1 —
 * so an extended period restores with both its date and its explanation.
 *
 * No manifest bucket: the module stores no PDFs. It issues no document
 * and mints no number, so there is nothing to render and no counter to
 * carry.
 *
 * v25 through v29 belong to the other packs of this wave. The numbers
 * were ALLOCATED by the coordinator rather than claimed on merge, for
 * the reason the v15, v17 and v21 notes record at length: a version
 * string identifies a format, two formats sharing one string is the
 * failure that matters, and a gap is not.
 *
 * export-v29: retention, security deposit and liquidated damages (0098)
 * join the package — the contract's own deduction terms, every retention
 * release, and every liquidated-damages assessment with the snapshot it
 * was computed from.
 *
 * The requirement this section answers is the one a deduction register
 * cannot answer alone. `bill_payment_deductions` already travels and says
 * what the railway KEPT; on its own that is a record of money leaving and
 * nothing else. An organisation restored from an export has to be able to
 * say what is still HELD against a contract closed years ago, and to show
 * the railway which completion date, which rate and which cap produced
 * the damages it argued about. So:
 *
 *   held      stays derived, and needs nothing new here: it is the
 *             SECURITY_DEPOSIT deductions of the payment register, which
 *             this package has carried since export-v1.
 *   released  `retentionReleases`, including the withdrawn rows and their
 *             reasons — a release that was retracted is part of the
 *             balance's history and dropping it would make the arithmetic
 *             unreconstructable.
 *   assessed  `ldAssessments`, whose generated columns travel as ordinary
 *             values. The frozen snapshot beside them is what makes the
 *             figures re-derivable rather than merely believable.
 *   agreed    `workRetentionTerms`, the contract's own rates, which are
 *             read off a letter the product may not hold a copy of.
 *
 * The version numbers between v24 and this one belong to the packs of the
 * waves that landed ahead of it — v25 through v28, whose notes follow. The
 * numbers were ALLOCATED by the coordinator rather than claimed on merge,
 * for the reason the v15, v17 and v21 notes record at length: a version
 * string identifies a format, two formats sharing one string is the
 * failure that matters, and a gap is not.
 *
 * export-v27: the audit authority and the retention policy (0095) join the
 * package.
 *
 * `can_view_audit_trail` joins the members section's explicit grant list.
 * Three packs of this wave reached that line independently and two of them
 * arrived carrying the SAME omission — `can_sign_documents` (0091) had been
 * on the column and off this list since export-v24, and
 * `can_manage_notifications` (0092) repeated it. 0094's column-level census
 * is what caught both, and it is why this one cannot go missing.
 *
 * `organisations` exports with `select *`, so `audit_retention_months`
 * travels without an edit — which is the point of the difference between
 * the two sections rather than an inconsistency: a membership's grants are
 * enumerated precisely so that dropping one is a visible edit.
 *
 * The audit EVENTS themselves already travelled: `auditEvents` has been a
 * section since the first version, and 0095's retention policy deliberately
 * does not narrow it. The package is the organisation's own portability
 * snapshot, and a viewing window that quietly truncated the exported trail
 * would make the package disagree with the table it was taken from.
 *
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
 *
 * export-v25: notifications (0092) join the package — the channels the
 * organisation speaks through, the templates it may say, the consent that
 * permits each recipient to be spoken to, and every message it sent.
 *
 * THE CONSENT REGISTER IS THE POINT OF THIS SECTION. An organisation
 * asked years later to show that it had permission to message a
 * counterparty needs the agreement, the address it was given for, the
 * words the member wrote down about how it was obtained, and the date —
 * and unlike a challan there is no counterparty holding a copy. The
 * delivery log is its other half: it says what was actually sent, to
 * which address, and whether the handset acknowledged it.
 *
 * Nothing is withheld and nothing needs to be, because there was never a
 * credential to withhold: the WhatsApp access token, the Meta app secret
 * and the SMTP password are deployment environment held inside an
 * injected adapter (`notify/transport.ts`), so `select *` publishes
 * identity — a phone number id, a display number, a sender address — and
 * no secret. That is a property of the schema rather than of this query,
 * which is why it is stated here rather than defended by naming columns
 * as `signingAgents` has to.
 *
 * The RENDERED text of a message is absent because it was never stored:
 * a message row carries the template it was rendered from and the ordered
 * parameter values, and the text is reproducible from the two. An export
 * carrying one fewer copy of a recipient's personal data is the right
 * trade when the copy is derivable.
 *
 * v24 (signing) is the pack of this wave that landed ahead of it. The
 * numbers were ALLOCATED by the coordinator rather than claimed on merge,
 * for the reason the v15, v17 and v21 notes record at length: a version
 * string identifies a format, two formats sharing one string is the
 * failure that matters, and a gap is not.
 *
 * export-v28: the platform controls (0096) join the package — the
 * organisation's module entitlements, its recurring statutory schedules,
 * and the register of the exports it has taken of itself.
 *
 * The last of those is the one worth arguing for, because a naive reading
 * says an export has no business containing a list of exports. It does,
 * and for the reason every disclosure register exists: the rows record
 * that on a date, a named member took a complete copy of the organisation
 * away, and that is a fact the organisation needs to keep whether or not
 * the file it produced still exists. The artefacts themselves are not in
 * the manifest and could not be — they expire, their bytes are deleted,
 * and a package that promised them would promise files no restore could
 * fetch. `object_key` is NULL on every expired row for exactly that
 * reason, so the export carries the record and not a broken pointer.
 *
 * Entitlements travel because a restored organisation that came back with
 * the e-way bill module silently on, or the signing module silently off,
 * would be a restore that changed what the product does. Schedules travel
 * for the same reason, and they carry `authority_user_id` — the member
 * whose membership their jobs borrow — because a restore that lost it
 * would leave the checks unable to say whose authority they ever ran on.
 *
 * No manifest bucket: none of the three stores a document.
 *
 * v25, v26 and v27 are the three sibling packs of this wave. The numbers
 * were ALLOCATED by the coordinator rather than claimed on merge, for the
 * reason the v15, v17, v21 and v24 notes record at length: a version
 * string identifies a format, two formats sharing one string is the
 * failure that matters, and a gap is not.
 *
 * TWO FIXES RIDE WITH IT, and neither is this pack's own. The `members`
 * section listed every authority column except `can_sign_documents`
 * (migration 0091) and `can_manage_notifications` (0092): a restored
 * organisation came back unable to sign and unable to message, with
 * nobody able to see why, which is precisely the failure that section's
 * own comment warns about. This version restores both alongside the two
 * columns 0096 adds — and the pattern is now three for three, so the
 * next authority to be added should be added HERE in the same commit.
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
 *
 * export-v41: the railway receipts (0120) join the record — the payments
 * themselves, the deduction heads under each, and which historical
 * invoice each settled. Without them a package would restore a billing
 * history with no statement of what the railway has actually paid
 * against it, or of what it withheld under each statutory head.
 *
 * export-v40: the Tally ↔ Zoho invoice cross-reference (0119) joins the
 * record. Without it a historical invoice exports with no statement of
 * which TallyPrime voucher it corresponds to, and the ones Tally alone
 * sourced export with no provenance at all — their voucher GUID lives
 * only on the link.
 *
 * export-v39: the Tally ledger census (0118) joins the record. It is
 * this organisation's own chart of accounts as another system holds it,
 * and every Tally wave after T1 reaches its ledgers through it.
 *
 * ⚠ PLACEHOLDER, WAVE T3. This constant and the suite's expected value in
 * `apps/server/test/helpers/export-format.ts` sit in different files and
 * auto-merge SILENTLY against each other, so a wave that lands beside
 * this one takes the same number without a conflict. v40 was T2's
 * (merged); v41 is claimed here on that basis. THE COORDINATOR RENUMBERS
 * BOTH FILES BY HAND AT MERGE if anything landed in between — which is
 * exactly what happened to v37 two waves ago, and what this note exists
 * to force.
 *
 * CHECKED AGAINST `main` WHEN THIS WAVE BRANCHED: it holds v40 and its
 * newest migration is 0119, so v41 and 0120 are both unclaimed. The UX
 * section was checked the same way — `main` holds § 40, so this wave
 * takes § 41 — and that file at least conflicts loudly when two waves
 * claim one number, which is why the version constants need the note and
 * it does not.
 */
export const EXPORT_FORMAT_VERSION = 'export-v41';

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
  | 'railway-measurement'
  | 'billing-baseline'
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
  | 'signed-document'
  | 'vendor-invoice';

const MANIFEST_ORDER: readonly ManifestBucket[] = [
  'organisation-logo',
  'loa-document',
  'received-railway-bill',
  'railway-measurement',
  'billing-baseline',
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
  'vendor-invoice',
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
       the same way.

       It earned its keep immediately: `can_manage_notifications` (0092)
       arrived on the same merge with the same omission, and the census
       named it rather than a restored organisation discovering it. */
    sql: `select user_id, role, work_scope, can_issue_documents,
                 can_cancel_documents, can_approve_amendments,
                 can_manage_statutory_reporting, can_manage_payments,
                 can_manage_payroll, can_sign_documents, can_import_data,
                 can_manage_notifications, can_view_audit_trail,
                 can_manage_entitlements, can_export_org,
                 can_manage_retention, status, created_at
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
    // The railway's own measurement (0111), the document the bill above
    // was raised from. Its bytes travel for the bill's reason and one
    // more: this document is what ADMITTED the bill, so a package
    // carrying the bill without it hands back a settlement whose gate
    // cannot be re-examined. The per-line verdicts ride as stored jsonb
    // rather than being recomputed on restore, because a re-read by a
    // later matcher is a different statement from the one the
    // organisation relied on.
    key: 'railwayMeasurements',
    // `, id` closes the order: two measurements recorded in one second
    // would otherwise come back in whatever order the planner chose, and
    // a package whose row order is not deterministic cannot be diffed
    // against the one taken yesterday.
    sql: `select * from railway_measurements order by created_at, id`,
    jsonbColumns: ['line_verdicts', 'extraction_payload'],
    manifest: {
      bucket: 'railway-measurement',
      entries: (row) => [
        {
          kind: 'railway-measurement',
          objectKey: row.object_key,
          sha256: row.sha256,
        },
      ],
    },
  },
  {
    // And who confirmed which line, when the document could not be read.
    // Without these rows a restored organisation could not answer why a
    // bill was accepted against an unreadable measurement — which is the
    // one case where the gate rests on a person rather than on a parse.
    key: 'railwayMeasurementConfirmations',
    sql: `select * from railway_measurement_confirmations order by confirmed_at, id`,
  },
  {
    // The opening billing position of a Work whose history predates this
    // product (0114), and the two documents it rests on. Without it a
    // restored organisation's imported Works would bill from zero all
    // over again — the baseline IS the prior-cumulative memory for them,
    // and it is the one that cannot be re-derived from anything else in
    // the package.
    key: 'workBillingBaselines',
    sql: `select * from work_billing_baselines order by created_at, id`,
    jsonbColumns: ['bill_extraction', 'measurement_extraction'],
    manifest: {
      bucket: 'billing-baseline',
      entries: (row) => [
        {
          kind: 'billing-baseline-bill',
          objectKey: row.bill_object_key,
          sha256: row.bill_sha256,
        },
        // The measurement sheet is optional, and a manifest entry for a
        // document that was never uploaded would name an object that does
        // not exist.
        ...(row.measurement_object_key !== null
          ? [
              {
                kind: 'billing-baseline-measurement',
                objectKey: row.measurement_object_key,
                sha256: row.measurement_sha256,
              },
            ]
          : []),
      ],
    },
  },
  {
    // The per-item figures, and who confirmed each of them. The rows the
    // Measurement Book engine actually reads.
    key: 'workBillingBaselineLines',
    sql: `select * from work_billing_baseline_lines order by created_at, id`,
  },
  {
    // What has been withheld against bills this product never saw.
    key: 'workDeductionEntries',
    sql: `select * from work_deduction_entries order by created_at, id`,
  },
  {
    // The historical Zoho Books invoice register (0115). It travels for
    // the reason the whole export exists: this is five years of the
    // organisation's billing, and a package that handed back everything
    // except what the organisation had already invoiced would be a
    // portability promise with the history taken out.
    //
    // The raw CSV row rides as stored jsonb rather than being rebuilt from
    // the typed columns. It is the truth source — the typed columns are a
    // reading of it — and a restore that reconstructed it would hand back
    // this schema's opinion of the export instead of the export.
    //
    // `, id` closes the order for the reason the measurement above gives:
    // two invoices bearing the same date would otherwise come back in
    // whatever order the planner chose, and a package whose row order is
    // not deterministic cannot be diffed against yesterday's.
    key: 'importedInvoices',
    sql: `select * from imported_invoices order by invoice_date, id`,
    jsonbColumns: ['raw_row'],
  },
  {
    key: 'importedInvoiceLines',
    sql: `select * from imported_invoice_lines order by imported_invoice_id, position`,
    jsonbColumns: ['raw_row'],
  },
  {
    // The Tally ledger census (0118). `source_fields` rides as stored
    // jsonb for `raw_row`'s reason above: it is what the export said, and
    // rebuilding it from the typed columns would hand back this schema's
    // opinion of a Tally master instead of the master.
    //
    // Ordered by the GUID, which is the only key here that is stable
    // across imports — `ledger_name` moves when somebody renames a ledger
    // in Tally, and a package whose row order is not deterministic cannot
    // be diffed against yesterday's.
    key: 'tallyLedgers',
    sql: `select * from tally_ledgers order by tally_guid`,
    jsonbColumns: ['source_fields'],
  },
  {
    // The Tally ↔ Zoho invoice cross-reference (0119). Ordered by the
    // voucher GUID and then the invoice it names, which is the pair the
    // table is unique on and the only key here that is stable across
    // imports — a package whose row order is not deterministic cannot be
    // diffed against yesterday's.
    key: 'tallyInvoiceLinks',
    sql: `select * from tally_invoice_links
          order by tally_guid, imported_invoice_id`,
  },
  {
    // Railway receipts as imported payments (0120), and the two child
    // tables that carry what the receipt MEANS: what was deducted under
    // each head, and which historical invoice was settled. All three ride
    // together because `gross = net + Σ heads` is only true across them —
    // a package holding the payments without their heads would restore a
    // register whose arithmetic does not close.
    //
    // `source_fields` rides as stored jsonb for `raw_row`'s reason above.
    // Ordered by the voucher GUID, the only key stable across imports.
    key: 'importedPayments',
    sql: `select * from imported_payments order by tally_guid`,
    jsonbColumns: ['source_fields'],
  },
  {
    key: 'importedPaymentDeductions',
    sql: `select * from imported_payment_deductions
          order by imported_payment_id, tally_ledger_name`,
  },
  {
    key: 'importedPaymentInvoiceLinks',
    sql: `select * from imported_payment_invoice_links
          order by imported_payment_id, imported_invoice_id`,
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
    // The vendor's own tax invoice (0080), and since 0109 its stored PDF.
    // The bytes travel for the reason the credential PDFs do and then
    // one more: a purchase order does not CLOSE without this file, so an
    // export that published the row alone would restore an organisation
    // holding closed orders it cannot produce the proof for. Nullable
    // throughout — most vendor invoices carry no document at all — so
    // the entry is emitted only where there is an object to name.
    key: 'vendorInvoices',
    sql: `select * from vendor_invoices
          order by vendor_contact_id, invoice_date, id`,
    manifest: {
      bucket: 'vendor-invoice',
      entries: (row) =>
        row.object_key === null
          ? []
          : [
              {
                kind: 'vendor-invoice',
                objectKey: row.object_key,
                sha256: row.document_sha256 ?? null,
              },
            ],
    },
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
  // The defect liability period that runs on an installation, and the
  // Work term it was started under (0099). `order by work_id` first is
  // about ROW order inside each section — one contract's periods arrive
  // contiguously — and not about where these two sections sit. The
  // certificates a 'pac'-basis period was started from are several
  // sections further down under `pacCertificates`, which is fine: a
  // restore reads the whole package, and section adjacency buys nothing
  // that the foreign keys do not already guarantee.
  {
    key: 'workWarrantyTerms',
    sql: `select * from work_warranty_terms order by work_id`,
  },
  {
    key: 'installationWarranties',
    sql: `select * from installation_warranties
          order by work_id, dlp_expires_on, id`,
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
    key: 'mbMeasuredOverrides',
    sql: `select * from mb_measured_overrides
          order by measurement_book_id, work_item_id, id`,
  },
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
  // The addresses each contact keeps (0116). Ordered by contact then by
  // the operator's own arrangement, so a restored file reads the way the
  // register does.
  {
    key: 'contactAddresses',
    sql: `select * from contact_addresses
          order by contact_id, sort_order, id`,
  },
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
    // The channels an organisation speaks through (0092). `select *`
    // publishes no secret, because the schema holds none: the access
    // token, the app secret and the mail password are the deployment's
    // and live inside the injected adapter.
    key: 'notificationChannels',
    sql: `select * from notification_channels order by channel`,
  },
  {
    // What the organisation is allowed to say (0092), before the messages
    // that name it. Every logged message renders from one of these, so a
    // package carrying the log without the templates would say that
    // something was sent and not what.
    key: 'notificationTemplates',
    sql: `select * from notification_templates order by name, language, id`,
  },
  {
    // The consent register (0092). The most load-bearing section of this
    // pack: an organisation asked to show it had permission to message a
    // counterparty has nowhere else to look, because unlike a challan
    // there is no counterparty holding a copy.
    key: 'notificationConsents',
    sql: `select * from notification_consents order by recorded_at, id`,
  },
  {
    // The delivery log (0092). What was sent, to which address, and what
    // became of it. The rendered text is absent because it was never
    // stored — the template above plus `parameters` reproduce it.
    key: 'notificationMessages',
    sql: `select * from notification_messages order by queued_at, id`,
    jsonbColumns: ['parameters'],
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
    // The second purchase-order series (0109), for orders raised outside
    // any LOA. Exported beside the per-Work one for the reason every
    // counter here travels: a restore without it hands out `PO-01` a
    // second time.
    key: 'organisationPurchaseOrderCounters',
    sql: `select * from organisation_purchase_order_counters order by organisation_id`,
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
  // The platform controls (0096). Three tables, no manifest bucket: none
  // of them stores a document.
  {
    key: 'organisationEntitlements',
    sql: `select * from organisation_entitlements order by flag_key`,
  },
  {
    key: 'statutoryJobSchedules',
    sql: `select * from statutory_job_schedules order by kind`,
  },
  // The disclosure register, not the artefacts. Every row says that on a
  // date a named member took a complete copy of the organisation away —
  // a fact worth keeping whether or not the file still exists — and
  // `object_key` is already NULL on every expired row, so nothing here
  // promises a restore a file it cannot fetch.
  {
    key: 'organisationExportRequests',
    sql: `select * from organisation_export_requests
          order by requested_at, id`,
  },
  // Retention, security deposit and liquidated damages (0098). The
  // generated columns of `ld_assessments` are exported as plain values
  // beside the snapshot they were derived from, which is what makes a
  // restored assessment checkable rather than merely readable: a reader
  // years later can recompute the figure from the same four inputs and
  // see that it matches.
  {
    key: 'workRetentionTerms',
    sql: `select * from work_retention_terms order by work_id`,
  },
  {
    // Withdrawn releases travel too, with their reasons. A retracted
    // release is part of the balance's history — dropping it would leave
    // a restored organisation unable to explain why its retention
    // position moved, which is exactly the reconstruction an export is
    // for.
    key: 'retentionReleases',
    sql: `select * from retention_releases
          order by work_id, released_on, id`,
  },
  {
    key: 'ldAssessments',
    sql: `select * from ld_assessments order by work_id, assessed_on, id`,
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
 * Writes the whole package, one chunk at a time, to whatever sink the
 * caller gives it.
 *
 * Extracted from the route below because migration 0096 gave the same
 * package a second destination — a stored artefact an operator downloads
 * later — and two copies of a sixty-table serialiser is two places for a
 * table to be forgotten. The route pipes chunks into the response; the
 * asynchronous build pipes them into object storage.
 *
 * `tx` MUST be a REPEATABLE READ transaction and must stay open for the
 * whole call. That is not a preference: the package is around sixty
 * sequential SELECTs, and under READ COMMITTED each takes its own
 * snapshot, so a writer committing midway is invisible to the earlier
 * queries and visible to the later ones and the package comes out
 * referentially broken — challan items whose parent challan is absent,
 * lines pointing at a document read before it existed.
 *
 * It writes the audit row itself, before reading `audit_events`, so the
 * package always contains its own record of having been taken.
 */
export async function writeExportPackage(
  tx: TransactionSql,
  organisationId: string,
  userId: string,
  write: (chunk: string) => Promise<void>,
): Promise<void> {
  const manifest = new Map<ManifestBucket, ManifestEntry[]>();
  const collect = (bucket: ManifestBucket, entries: ManifestEntry[]): void => {
    if (entries.length === 0) return;
    const existing = manifest.get(bucket);
    if (existing) existing.push(...entries);
    else manifest.set(bucket, [...entries]);
  };

  await write(
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
  await write(`"organisation":${JSON.stringify(organisation ?? null)},`);

  for (const section of SECTIONS) {
    await write(`${JSON.stringify(section.key)}:[`);
    let separator = '';
    // The async-iterable cursor: PostgreSQL hands back CURSOR_ROWS at a
    // time and the section is written as it arrives, so no table is ever
    // fully resident.
    for await (const rows of tx
      .unsafe(section.sql)
      .cursor(CURSOR_ROWS) as AsyncIterable<ExportRow[]>) {
      for (const row of rows) {
        const parsed = parseRow(row, section.jsonbColumns ?? []);
        if (section.manifest) {
          collect(section.manifest.bucket, section.manifest.entries(parsed));
        }
        await write(separator + JSON.stringify(parsed));
        separator = ',';
      }
    }
    await write('],');
  }

  // A portable manifest of every stored object the record refers to —
  // logo, uploaded LOAs, rendered and signed PDFs — with the recorded
  // hashes, so an offboarding or incident package can fetch and verify
  // the bytes (external re-audit). Emitted in a fixed bucket order, so
  // streaming the sections did not reorder it.
  const objectManifest = MANIFEST_ORDER.flatMap((bucket) => manifest.get(bucket) ?? []);
  await write(`"objectManifest":${JSON.stringify(objectManifest)},`);

  // Recorded before the audit section is read, so the package contains
  // its own audit record.
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, entity_type, details
    )
    values (
      ${organisationId}, ${userId}, 'organisation.exported',
      'organisations', '{}'::jsonb
    )
  `;
  await write('"auditEvents":[');
  let separator = '';
  for await (const rows of tx
    .unsafe(`select * from audit_events order by occurred_at, id`)
    .cursor(CURSOR_ROWS) as AsyncIterable<ExportRow[]>) {
    for (const row of rows) {
      await write(separator + JSON.stringify(parseRow(row, ['details'])));
      separator = ',';
    }
  }
  await write(']}');
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

        try {
          await writeExportPackage(tx, organisationId, user.id, (chunk) =>
            out.write(chunk),
          );
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
