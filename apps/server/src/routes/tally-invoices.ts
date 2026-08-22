import { randomUUID } from 'node:crypto';
import {
  type ErrorCode,
  ImportedInvoiceDetailSchema,
  ResolveTallyDisputeSchema,
  TallyInvoiceImportResultSchema,
  TallyInvoiceUploadQuerySchema,
  type TallyVoucherProposal,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { TallyImportError } from '../tally-scan.js';
import {
  type RegisterInvoice,
  type TallyVoucher,
  matchTallyVouchers,
  readTallyVouchers,
} from '../tally-vouchers.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_TALLY_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import {
  type ContactCandidate,
  type WorkCandidate,
  type WorkLinkSubject,
  indexContacts,
  matchIndexedContact,
  proposeWorkLink,
} from '../zoho-invoices.js';
import { readImportedInvoiceDetail } from './imported-invoices.js';
import {
  IdParamsSchema,
  audit,
  errorResponses,
  requireTrimmed,
  writeRefusals,
} from './shared.js';

/**
 * The Tally ↔ Zoho invoice cross-reference (migration 0119) — wave T2 of
 * the Tally migration train.
 *
 * ## The shape of the feature, in two calls against the same bytes
 *
 * `POST /api/tally-invoices/import?mode=preview` reads the voucher
 * export, ties every sales voucher it can to an invoice already on the
 * historical register, works out which vouchers have no counterpart and
 * would therefore become register rows of their own, and answers with the
 * whole reconciliation. It writes nothing. `?mode=commit` does the
 * identical reading and then writes.
 *
 * That is `imported-invoices.ts`'s shape and `tally-masters.ts`'s, and it
 * is here for the same reason: the judgement is a pure function of the
 * bytes and the register, so re-sending the bytes to commit is exactly
 * equivalent to committing a staged copy, minus a staging table and its
 * lifecycle.
 *
 * ## THE INTAKE IS A FILTERED EXPORT, AND THAT IS A DESIGN DECISION
 *
 * TallyPrime's full `Transactions.xml` is 3.18 GB. The upload cap is 192
 * MB and the malware scanner's is 256 MB, so the whole file cannot go
 * through this route and nothing here pretends otherwise. It does not
 * need to: 96 % of that corpus is Payment, Journal, Purchase and Contra
 * vouchers this product does not model and the census proposes importing
 * none of (§ 5), and the three sales-side types are 1,185 vouchers and
 * 61 MB — a quarter of the fifth of the cap.
 *
 * So the owner exports the Day Book narrowed to Sales, Credit Note and
 * Debit Note, and uploads that. `docs/OPERATIONS.md` carries the steps.
 * The alternative — a server-side file path the operator names, read off
 * the host's disk — was deliberately NOT taken: it would put an
 * operator-supplied path into a file read, skip the malware scan and the
 * signature check that every other upload in this application goes
 * through, and require the 3.18 GB file to be on the server in the first
 * place. A narrowed export keeps the whole upload chain intact and asks
 * the owner for four clicks in a program they use every day.
 *
 * The reader filters again on the way in, because an operator who forgot
 * to narrow the export is a real Tuesday and skipping a Payment voucher
 * costs a string comparison.
 *
 * ## What it writes, and what it deliberately does not
 *
 * Owner ruling 23: where BOTH systems hold an invoice, Zoho is
 * authoritative and the Tally voucher is provenance, so the commit writes
 * a LINK and no register row. Where Tally alone holds it — the three
 * years before Zoho — the voucher becomes a register row behind the
 * `tally` source discriminator, with an `origin` link carrying its GUID.
 *
 * It writes no payment, no work, no contact and no credit note. A Work is
 * PROPOSED through 0115's own `proposeWorkLink`, on the same
 * propose-and-prove terms, because a Tally voucher's narration carries a
 * v1 work code exactly as a Zoho invoice's reference does.
 *
 * ## Permissions
 *
 * The `import` authority on top of the writer role, exactly as 0094, 0115
 * and 0118: pointing a file at a register is a different act from adding
 * one row to it. There is no read route here — the cross-reference is
 * read through the historical register it annotates.
 *
 * ## Work scope
 *
 * The Work PROPOSAL is scoped, and the candidates are narrowed rather
 * than the proposals filtered afterwards — `imported-invoices.ts`'s rule,
 * for its reason: that is the difference between "this member cannot link
 * to that Work" and "this member is told that Work exists".
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * 23T02 and 23T03 are migration 0119's guards. The route refuses both
 * first, under the advisory lock, so a row that gets here has lost a race
 * or arrived another way — and it should say so as a 409 with a remedy
 * rather than as a 500.
 *
 * The PostgreSQL-native codes beneath are BACKSTOPS, for this route's
 * input being a file: the reader refuses an over-long name, an impossible
 * date and a control character up front, in the preview, where the
 * refusal carries a line number and nothing has been written.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23T02': [
    'TALLY_INVOICE_LINK_IMMUTABLE',
    'A Tally invoice link records what an export said about one correspondence, and it is never edited or attached to a withdrawn invoice.',
  ],
  '23T03': [
    'TALLY_INVOICE_LINK_IMMUTABLE',
    'That Tally voucher already brought in a historical invoice that is still on the register. Discard the existing one before importing the export again.',
  ],
  '23X01': [
    'IMPORTED_INVOICE_IMMUTABLE',
    'A historical invoice records what the export said; only its Work link, its customer link and its discard can change.',
  ],
  // 22008 datetime_field_overflow, 22003 numeric_value_out_of_range,
  // 23514 check_violation, 23503 foreign_key_violation.
  '22008': [
    'TALLY_VOUCHERS_UNREADABLE',
    'That export carries a date no calendar has. The preview names the voucher and the line.',
  ],
  '22003': [
    'TALLY_VOUCHERS_UNREADABLE',
    'That export carries a figure too large for this register to store. The preview names the voucher and the line.',
  ],
  '23514': [
    'TALLY_VOUCHERS_UNREADABLE',
    'That export carries a value this register refuses. The preview names the voucher and the line.',
  ],
  '23503': [
    'WORK_NOT_FOUND',
    'A Work this import proposed has since been withdrawn. Read the file again and the proposal will be recomputed.',
  ],
};

const rethrowWriteRefusal = writeRefusals(DATABASE_REFUSALS);

/** Cut to a column's width, with an ellipsis where anything was lost, so
 * a truncated value never reads as a complete one. */
function ellipsised(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** How many rows one insert statement carries. The driver builds one
 * placeholder per value and a thousand rows times twenty columns is well
 * past what one statement should hold; the same order every bulk write
 * here uses. */
const CHUNK = 500;

/** Live Works this member may see, for the proposal. Narrowed here rather
 * than after the fact — see the header. */
async function candidateWorks(
  tx: TransactionSql,
  userId: string,
): Promise<WorkCandidate[]> {
  const full = await hasFullWorkScope(tx, userId);
  const rows = await tx<{ id: string; work_code: string; letter_number: string }[]>`
    select w.id, w.work_code, w.letter_number
    from works w
    where w.deleted_at is null
      and (${full} or exists (
        select 1 from work_assignments wa
        where wa.work_id = w.id and wa.user_id = ${userId}
      ))
  `;
  return rows.map((row) => ({
    id: row.id,
    workCode: row.work_code,
    letterNumber: row.letter_number,
  }));
}

/** Live contacts, for the GSTIN-then-name match. Retired contacts are
 * excluded for `imported-invoices.ts`'s reason: matching onto a party the
 * organisation has since retired would revive it in every picker that
 * reads the join. */
async function candidateContacts(tx: TransactionSql): Promise<ContactCandidate[]> {
  const rows = await tx<{ id: string; designation: string; gstin: string | null }[]>`
    select id, designation, gstin from contacts where active
  `;
  return rows.map((row) => ({ id: row.id, name: row.designation, gstin: row.gstin }));
}

/**
 * A Tally voucher, dressed as the subject `proposeWorkLink` reads.
 *
 * The shared matcher is CALLED rather than reimplemented, because "a v1
 * work code in the document's own text, ambiguity proposes nothing" is
 * one rule this product applies in two places and a second
 * implementation of it would drift — the same argument `tally-masters.ts`
 * makes about `matchContact`. What differs is the HAYSTACK: a Zoho
 * invoice offers a reference field and its line descriptions, and a Tally
 * voucher offers its narration and its reference, which is where 716 of
 * the 1,052 real sales vouchers carry a `PL-` code.
 */
function workSubject(voucher: TallyVoucher): WorkLinkSubject {
  return {
    referenceText: [voucher.reference ?? '', voucher.narration ?? ''].join('\n'),
    lines: [],
  };
}

export function registerTallyInvoiceRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  malwareScanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tally-invoices/import',
      schema: {
        querystring: TallyInvoiceUploadQuerySchema,
        response: { 200: TallyInvoiceImportResultSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
      bodyLimit: MAX_TALLY_UPLOAD_BYTES,
    },
    async ({ request, user, organisationId, tenant }) => {
      // AUTHORISE FIRST — before the format guard, not merely before the
      // scanner, and `test/route-inventory.integration.test.ts` is why:
      // this format HAS a signature, so `consumeUpload` refuses a wrong
      // body with a 400 — and a 400 where every other tenant route
      // answers 403 tells an unauthorised caller that the route exists.
      // An empty bound transaction runs the membership, role and
      // authority checks, so a stranger's file never reaches the scanner
      // or the reader. The masters import next door keeps the same order
      // for the same reason.
      await tenant(() => Promise.resolve());

      const { bytes } = consumeUpload(request.body, {
        format: 'tally-xml',
        description: 'the TallyPrime sales voucher export',
      });
      // STRIP FIRST, THEN TRIM, for `imports.ts`'s reason: the other
      // order lets a control character survive the blank check and then
      // vanish, leaving an untrimmed value for a CHECK to refuse as a
      // 500.
      const filename = requireTrimmed(
        request.query.filename.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''),
        'Name the file being imported.',
      );

      await assertNotMalware(malwareScanner, bytes);

      let read;
      try {
        read = readTallyVouchers(bytes);
      } catch (cause: unknown) {
        if (cause instanceof TallyImportError) {
          // The two codes are written out as LITERALS rather than passed
          // through as `cause.code`, and `test/error-remedies.test.ts` is
          // why: it reads this server's source for the codes each route
          // can actually answer with, and a code that only ever appears
          // as a variable is invisible to it. They are also the VOUCHER
          // codes rather than the masters ones the reader's own union
          // names — the refusal is the same, the remedy is a different
          // export.
          if (cause.code === 'TALLY_EXPORT_TRUNCATED') {
            throw httpError(400, 'TALLY_VOUCHERS_TRUNCATED', cause.message);
          }
          throw httpError(400, 'TALLY_VOUCHERS_UNREADABLE', cause.message);
        }
        throw cause;
      }
      if (read.vouchers.length === 0) {
        throw httpError(
          400,
          'TALLY_VOUCHERS_UNREADABLE',
          'That export declares no Sales, Credit Note or Debit Note vouchers. In TallyPrime, export the Day Book narrowed to those voucher types rather than a different register.',
        );
      }

      const commit = request.query.mode === 'commit';
      return await tenant(async (tx) => {
        // ONE IMPORT PER ORGANISATION AT A TIME, and it refuses rather
        // than queues — the masters import's lock argument exactly, plus
        // one of its own: the "one voucher sources at most one live
        // register row" rule this route checks in application code is
        // only race-free under it, and 0119's guard is the arm that holds
        // if it is ever not. Transaction-scoped, so it is released by the
        // commit or the rollback with nothing to unwind. The key shares
        // the bigint space `rate-limit.ts` uses and the literal keeps
        // this family from colliding with that one.
        const [lock] = await tx<{ taken: boolean }[]>`
          select pg_try_advisory_xact_lock(
            hashtextextended(${`tally-invoices:${organisationId}`}, 0)
          ) as taken
        `;
        if (lock?.taken !== true) {
          throw httpError(
            409,
            'TALLY_IMPORT_IN_PROGRESS',
            'Another Tally invoice import is running for this organisation. Wait for it to finish, then read the file again.',
          );
        }

        // THE REGISTER AS IT STANDS, live rows only — the same reading
        // 0115's partial unique index takes. A discarded invoice is one
        // the operator withdrew in order to import a corrected copy;
        // matching against it would tie a Tally voucher to evidence that
        // has been taken off the record.
        const registerRows = await tx<
          {
            id: string;
            invoice_number: string;
            customer_name: string;
            customer_gstin: string | null;
            total: string;
            source: string;
          }[]
        >`
          select id, invoice_number, customer_name, customer_gstin, total, source
          from imported_invoices
          where discarded_at is null
        `;
        // ONLY ZOHO ROWS ARE MATCH CANDIDATES. A Tally-sourced row is a
        // voucher this import already brought in, and matching a voucher
        // to it by NUMBER would manufacture a cross-reference between a
        // document and itself under a method that claims two systems
        // agreed.
        const candidates: RegisterInvoice[] = registerRows
          .filter((row) => row.source === 'zoho')
          .map((row) => ({
            id: row.id,
            invoiceNumber: row.invoice_number,
            customerName: row.customer_name,
            customerGstin: row.customer_gstin,
            total: row.total,
          }));

        // RULING 22. Cancelled and optional vouchers are skipped, and
        // named in the report rather than only counted: silence would
        // leave an operator unable to tell a document TallyPrime
        // cancelled from one this reader could not read.
        const skipped = read.vouchers.filter(
          (voucher) => voucher.cancelled || voucher.optional,
        );
        const live = read.vouchers.filter(
          (voucher) => !voucher.cancelled && !voucher.optional,
        );

        // What a previous import of this export already dealt with. Keyed
        // on the voucher GUID and narrowed to links whose invoice is
        // LIVE, which is the same reading the register's own idempotency
        // takes: discarding a Tally-sourced invoice and importing the
        // corrected export is the correction path, and a check that
        // counted the withdrawn row would close it.
        const guids = [...new Set(read.vouchers.map((voucher) => voucher.guid))];
        const held = await tx<{ tally_guid: string; match_method: string }[]>`
          select l.tally_guid, l.match_method
          from tally_invoice_links l
          join imported_invoices i
            on i.organisation_id = l.organisation_id and i.id = l.imported_invoice_id
          where l.tally_guid = any(${tx.array(guids)}::text[])
            and i.discarded_at is null
        `;
        // EVERY LIVE CORRESPONDENCE THE REGISTER HOLDS, not only the ones
        // this file names. The matcher reconciles by connected component,
        // and a component is only meaningful over ALL the vouchers that
        // cover an invoice — so a narrower second file has to be able to
        // see what the first one already accounted for, or it reports the
        // part it cannot see as a disagreement. `ExistingTallyLink` in
        // `tally-vouchers.ts` carries the argument in full.
        const carriedLinks = await tx<
          { tally_guid: string; imported_invoice_id: string; tally_amount: string }[]
        >`
          select l.tally_guid, l.imported_invoice_id, l.tally_amount
          from tally_invoice_links l
          join imported_invoices i
            on i.organisation_id = l.organisation_id and i.id = l.imported_invoice_id
          where i.discarded_at is null and l.match_method <> 'origin'
        `;

        const matched = matchTallyVouchers(
          live,
          candidates,
          carriedLinks.map((row) => ({
            tallyGuid: row.tally_guid,
            invoiceId: row.imported_invoice_id,
            amount: row.tally_amount,
          })),
        );
        const heldOrigin = new Set(
          held
            .filter((row) => row.match_method === 'origin')
            .map((row) => row.tally_guid),
        );
        const heldAny = new Set(held.map((row) => row.tally_guid));

        const works = await candidateWorks(tx, user.id);
        const contacts = await candidateContacts(tx);
        // Indexed ONCE for the whole file. `matchContact` filters the
        // candidate array per subject, which is right for one invoice and
        // wrong for four hundred.
        const contactIndex = indexContacts(contacts);

        /* --- what each voucher would do ------------------------------- */

        /* THE TWO GATES ARE DIFFERENT, and inverting either one is a
           defect. What each is protecting is not the same thing:

           MINTING A REGISTER ROW is gated on ANY live link, because a
           voucher that already corresponds to something on the register
           must never also become a row of its own. A voucher can leave
           the matched population without leaving the register: somebody
           edits its reference in Tally, or the Zoho invoice it matched is
           discarded, and the next import finds it unmatched while its old
           link still stands. Minting then would put a second row on the
           register for a document the register already holds — the exact
           double-count ruling 23 exists to prevent. Such a voucher is
           reported instead (`previouslyLinkedCount`), because it is a
           real thing an operator should look at rather than a silence.

           WRITING A MATCH LINK is gated on the ORIGIN links only, which
           is the one hazard that was ever argued: a voucher that sourced
           its own register row must not also be tied to a Zoho invoice,
           or the register holds two rows for one document from the other
           direction. Everything else is admitted, and that is what makes
           the promise on the screen true — "uploading the same file again
           adds what is missing and changes nothing else". A voucher that
           matched invoice A last month and matches A and B today gets its
           B link; the A pair collides on the unique index and is a no-op.
           Gating this on `heldAny` silently withheld every such link. */
        const freshLinks = matched.links.filter(
          (link) => !heldOrigin.has(link.voucher.guid),
        );
        const freshOrigins = matched.unmatched.filter(
          (voucher) => !heldAny.has(voucher.guid),
        );
        /** Unmatched in THIS file, and still linked to something on the
         * register from an earlier one. Neither imported nor linked, and
         * named in the report rather than passed over in silence. */
        const previouslyLinked = matched.unmatched.filter((voucher) =>
          heldAny.has(voucher.guid),
        );
        const judged = freshOrigins.map((voucher) => ({
          voucher,
          proposal: proposeWorkLink(workSubject(voucher), works),
          contact: matchIndexedContact(
            { customerGstin: voucher.partyGstin, customerName: voucher.partyLedger },
            contactIndex,
          ),
        }));

        let importedInvoiceCount = 0;
        let importedLinkCount = 0;

        if (commit) {
          /* --- the pre-Zoho half becomes register rows (ruling 23) ---- */
          const linkRows: Record<string, unknown>[] = [];
          /** The ids this route minted, in `judged` order, so the origin
           * links and the per-invoice audit events below both pair without
           * depending on anything the database returns. */
          const numberedIds: string[] = [];

          if (judged.length > 0) {
            const now = new Date().toISOString();
            const invoiceRows = judged.map(({ voucher, proposal, contact }) => ({
              // THE ID IS MINTED HERE, not read back from `returning`, and
              // that is what makes the origin link below provably about
              // the right invoice. The column defaults to
              // `gen_random_uuid()` and reading the ids back would work in
              // practice — but only because a plain multi-row insert
              // happens to return rows in order, which PostgreSQL does not
              // promise. An origin link is the provenance of a money row;
              // pairing it by an ordering nobody guarantees is the kind of
              // bug that shows up as one invoice wearing another's Tally
              // voucher, years later, in a reconciliation.
              id: randomUUID(),
              organisation_id: organisationId,
              source: 'tally',
              // NO ZOHO ID and NO SUB-TOTAL. Migration 0119 § B argues
              // both: Zoho's identifier belongs to Zoho, and TallyPrime
              // states a document total and never a sub-total.
              zoho_invoice_id: null,
              // The document number as Tally holds it. The voucher number
              // first, because that is what a numbered voucher IS; the
              // reference second, because `Sales` is numbered manually
              // here and 341 real vouchers carry no number at all.
              invoice_number: (voucher.voucherNumber ?? voucher.reference ?? '')
                .slice(0, 60)
                .trim(),
              invoice_date: voucher.date,
              customer_zoho_id: null,
              customer_name: voucher.partyLedger,
              customer_gstin: voucher.partyGstin,
              place_of_supply: null,
              contact_id: contact?.contactId ?? null,
              contact_match_method: contact?.method ?? null,
              // ZOHO'S WORKFLOW FLAG IS ZOHO'S. A Tally voucher has no
              // such column, and putting 'Imported' or 'Tally' here would
              // put a value in a column whose comment says it is the
              // export's own status, verbatim.
              zoho_status: null,
              irn: null,
              ack_number: null,
              ack_date: null,
              qr_payload: null,
              reference_text: voucher.reference ?? voucher.narration,
              sub_total: null,
              total: voucher.amount,
              // EVIDENCE ONLY on a Zoho row and ABSENT here: Tally states
              // an outstanding balance in its ledgers rather than on the
              // voucher, and wave T3 is what reads the receipts.
              balance: null,
              round_off: null,
              work_id: proposal?.workId ?? null,
              link_method: proposal?.method ?? null,
              linked_by_user_id: proposal === null ? null : user.id,
              linked_at: proposal === null ? null : now,
              raw_row: tx.json(voucher.sourceFields as never),
              imported_by_user_id: user.id,
            }));
            // NO FILE-LEVEL REFUSAL HERE, and its absence is the fix.
            // A live sales voucher with no document number anywhere is
            // refused by the READER, per voucher, with its line — so the
            // preview and the commit see the same population and reach
            // the same outcome. This route used to discover the condition
            // at commit and answer a 400 for the whole file, which meant
            // an operator could read and approve a preview and then be
            // refused by a row-level problem that named no row.
            const numbered = invoiceRows;
            numberedIds.push(...numbered.map((row) => row.id));

            for (let index = 0; index < numbered.length; index += CHUNK) {
              const rows = await tx<{ id: string }[]>`
                insert into imported_invoices ${tx(numbered.slice(index, index + CHUNK))}
                returning id
              `.catch(rethrowWriteRefusal);
              importedInvoiceCount += rows.length;
            }

            // The ORIGIN link, which is what carries the voucher GUID —
            // migration 0119 § A and § D: the register gains no
            // provenance column, so the link is where a re-import finds
            // that this voucher has already been read. Paired by the id
            // this route MINTED, so the pairing depends on nothing the
            // database returns.
            judged.forEach(({ voucher }, index) => {
              const invoiceId = numberedIds[index];
              if (invoiceId === undefined) return;
              linkRows.push({
                organisation_id: organisationId,
                tally_guid: voucher.guid,
                tally_alterid: voucher.alterId,
                tally_voucher_type: voucher.voucherType,
                tally_voucher_date: voucher.date,
                tally_voucher_number: voucher.voucherNumber,
                tally_reference: voucher.reference,
                tally_party_ledger: voucher.partyLedger,
                tally_amount: voucher.amount,
                imported_invoice_id: invoiceId,
                match_method: 'origin',
                match_evidence: null,
                disputed: false,
                component_tally_total: null,
                component_invoice_total: null,
                source_filename: filename,
                imported_by_user_id: user.id,
              });
            });
          }

          /* --- the overlap becomes cross-references (ruling 12) ------- */
          for (const link of freshLinks) {
            linkRows.push({
              organisation_id: organisationId,
              tally_guid: link.voucher.guid,
              tally_alterid: link.voucher.alterId,
              tally_voucher_type: link.voucher.voucherType,
              tally_voucher_date: link.voucher.date,
              tally_voucher_number: link.voucher.voucherNumber,
              tally_reference: link.voucher.reference,
              tally_party_ledger: link.voucher.partyLedger,
              tally_amount: link.voucher.amount,
              imported_invoice_id: link.invoiceId,
              match_method: link.method,
              match_evidence: link.evidence,
              disputed: link.disputed,
              // Stored only where there IS a disagreement: 0119's shape
              // check requires both figures behind a dispute, and storing
              // two agreeing sums on 716 links would be the same number
              // twice on every row that has nothing to say.
              component_tally_total: link.disputed ? link.componentTallyTotal : null,
              component_invoice_total: link.disputed
                ? link.componentInvoiceTotal
                : null,
              source_filename: filename,
              imported_by_user_id: user.id,
            });
          }

          for (let index = 0; index < linkRows.length; index += CHUNK) {
            const rows = await tx<{ id: string }[]>`
              insert into tally_invoice_links ${tx(linkRows.slice(index, index + CHUNK))}
              -- A re-import adds the correspondences that are missing and
              -- collides on the ones that are not, which is what makes
              -- running the same export twice safe. The arbiter is the
              -- PAIR, because one voucher may name several invoices.
              on conflict (organisation_id, tally_guid, imported_invoice_id) do nothing
              returning id
            `.catch(rethrowWriteRefusal);
            importedLinkCount += rows.length;
          }

          // ONE AUDIT EVENT PER REGISTER ROW THIS IMPORT CREATED, on the
          // terms `imported-invoices.ts` sets and under the SAME action
          // and entity type: such a row is an invoice, and "where did
          // this invoice come from" has to be answerable from the invoice
          // rather than only from whoever ran the import. The Tally
          // voucher's own GUID rides in the payload, which is what makes
          // the answer specific.
          //
          // Written as an INSERT … SELECT over two unnested arrays rather
          // than through the driver's row helper, for the reason the Zoho
          // importer gives: `test/audit-timeline-census.test.ts` reads
          // this server's source for the action and entity type of every
          // `audit_events` write, and it can only read them where the two
          // literals sit side by side.
          const auditIds: string[] = [];
          const auditDetails: string[] = [];
          judged.forEach(({ voucher, proposal }, index) => {
            const invoiceId = numberedIds[index];
            if (invoiceId === undefined) return;
            auditIds.push(invoiceId);
            auditDetails.push(
              JSON.stringify({
                filename,
                source: 'tally',
                tallyGuid: voucher.guid,
                tallyAlterId: voucher.alterId,
                invoiceNumber: voucher.voucherNumber ?? voucher.reference,
                workId: proposal?.workId ?? null,
                linkMethod: proposal?.method ?? null,
              }),
            );
          });
          if (auditIds.length > 0) {
            await tx`
              insert into audit_events (
                organisation_id, actor_user_id, action, entity_type,
                entity_id, details
              )
              select ${organisationId}, ${user.id},
                     'imported_invoice.imported', 'imported_invoices',
                     v.entity_id::uuid, v.details::jsonb
              from unnest(
                ${tx.array(auditIds)}::uuid[],
                ${tx.array(auditDetails)}::text[]
              ) as v(entity_id, details)
            `;
          }

          // AND ONE FOR THE IMPORT ITSELF, not one per voucher. A
          // cross-reference row is not a document somebody filed, and 736
          // audit events per import would bury the timeline that answers
          // what a person did. The file, the counts and the guard's own
          // refusals are the act.
          await audit(
            tx,
            organisationId,
            user.id,
            'tally_invoice_link.imported',
            'tally_invoice_links',
            null,
            {
              filename,
              voucherCount: read.voucherCount,
              salesCount: live.filter((v) => v.voucherType === 'Sales').length,
              skippedCount: skipped.length,
              linkCount: importedLinkCount,
              invoiceCount: importedInvoiceCount,
              disputedLinkCount: freshLinks.filter((link) => link.disputed).length,
              serialMatchCount: freshLinks.filter(
                (link) => link.method === 'serial_tolerant',
              ).length,
              serialCollisionCount: matched.serialCollisions,
              refusalCount: read.refusals.length,
            },
          );
        }

        /* --- the report ---------------------------------------------- */

        const linkByGuid = new Map(
          matched.links.map((link) => [link.voucher.guid, link]),
        );
        const invoiceNumberById = new Map(
          registerRows.map((row) => [row.id, row.invoice_number]),
        );

        const vouchers: TallyVoucherProposal[] = read.vouchers.map((voucher) => {
          const base = {
            tallyGuid: voucher.guid,
            voucherType: voucher.voucherType,
            voucherDate: voucher.date,
            voucherNumber: voucher.voucherNumber,
            reference: voucher.reference,
            partyLedger: voucher.partyLedger,
            amount: voucher.amount,
          };
          if (voucher.cancelled || voucher.optional) {
            return {
              ...base,
              outcome: 'skipped' as const,
              skipReason: voucher.cancelled
                ? 'Cancelled in TallyPrime.'
                : 'Marked optional in TallyPrime.',
              matchMethod: null,
              matchEvidence: null,
              invoiceNumber: null,
              componentTallyTotal: null,
              componentInvoiceTotal: null,
              disputed: false,
            };
          }
          if (voucher.voucherType !== 'Sales') {
            return {
              ...base,
              outcome: 'skipped' as const,
              skipReason:
                'A credit or debit note reverses an invoice rather than raising one, so it is read and reported and not added to a register of invoices raised.',
              matchMethod: null,
              matchEvidence: null,
              invoiceNumber: null,
              componentTallyTotal: null,
              componentInvoiceTotal: null,
              disputed: false,
            };
          }
          const link = linkByGuid.get(voucher.guid);
          if (link !== undefined) {
            return {
              ...base,
              // `heldOrigin` is the gate the link write uses, so it is
              // the gate the outcome has to report — a voucher already
              // holding a match link still gets any NEW match written,
              // and calling that "already read" would contradict the row
              // the commit goes on to insert.
              outcome: heldOrigin.has(voucher.guid)
                ? ('already_read' as const)
                : ('linked' as const),
              skipReason: null,
              matchMethod: link.method,
              matchEvidence: link.evidence,
              invoiceNumber: invoiceNumberById.get(link.invoiceId) ?? null,
              componentTallyTotal: link.disputed ? link.componentTallyTotal : null,
              componentInvoiceTotal: link.disputed ? link.componentInvoiceTotal : null,
              disputed: link.disputed,
            };
          }
          // Unmatched in this file. Three ways that happens, and they are
          // different things to an operator.
          if (heldOrigin.has(voucher.guid)) {
            return {
              ...base,
              outcome: 'already_read' as const,
              skipReason: null,
              matchMethod: 'origin' as const,
              matchEvidence: null,
              invoiceNumber: null,
              componentTallyTotal: null,
              componentInvoiceTotal: null,
              disputed: false,
            };
          }
          if (heldAny.has(voucher.guid)) {
            // MATCHED ONCE, NOT NOW. Its old link still stands, so it
            // mints nothing — see the gate comment above. Worth a
            // sentence rather than a silence: somebody edited a reference
            // in TallyPrime, or the invoice it matched was discarded.
            return {
              ...base,
              outcome: 'previously_linked' as const,
              // Bounded by the contract's 200 characters, which an
              // earlier draft of this sentence exceeded — and a response
              // that fails its own schema is a 500 with nothing named.
              skipReason:
                'Matched an invoice in an earlier import and matches none now; its existing link stands and no row is created. Check whether its number changed in TallyPrime.',
              matchMethod: null,
              matchEvidence: null,
              invoiceNumber: null,
              componentTallyTotal: null,
              componentInvoiceTotal: null,
              disputed: false,
            };
          }
          return {
            ...base,
            outcome: 'imported' as const,
            skipReason: null,
            matchMethod: null,
            matchEvidence: null,
            invoiceNumber: null,
            componentTallyTotal: null,
            componentInvoiceTotal: null,
            disputed: false,
          };
        });

        const linkedInvoiceIds = new Set(matched.links.map((link) => link.invoiceId));
        return {
          mode: request.query.mode,
          filename,
          voucherCount: read.voucherCount,
          salesCount: read.vouchers.filter((v) => v.voucherType === 'Sales').length,
          creditNoteCount: read.vouchers.filter((v) => v.voucherType === 'Credit Note')
            .length,
          debitNoteCount: read.vouchers.filter((v) => v.voucherType === 'Debit Note')
            .length,
          cancelledCount: read.vouchers.filter((v) => v.cancelled).length,
          optionalCount: read.vouchers.filter((v) => v.optional && !v.cancelled).length,
          // RULING 22, and the fallback is not decoration: TallyPrime
          // strips a cancelled voucher of its number as well as its
          // party, so half the real ones have nothing but a reference and
          // some have not even that. The date is what is left, and it is
          // what an operator opens the Day Book at.
          // BOUNDED TO SIXTY, because that is what the contract types and
          // a `REFERENCE` runs to two hundred: an over-long one failed
          // RESPONSE validation as a 500 with nothing naming the file.
          // The ellipsis is what stops a truncated reference reading as a
          // complete one an operator would then fail to find in Tally.
          skippedVoucherNumbers: skipped.map((voucher) =>
            ellipsised(
              voucher.voucherNumber ??
                voucher.reference ??
                `(unnumbered, ${voucher.date})`,
              60,
            ),
          ),
          exactMatchCount: matched.links.filter((l) => l.method === 'exact_number')
            .length,
          serialMatchCount: matched.links.filter((l) => l.method === 'serial_tolerant')
            .length,
          serialCollisionCount: matched.serialCollisions,
          disputedComponentCount: matched.disputedComponentCount,
          disputedLinkCount: matched.links.filter((link) => link.disputed).length,
          unmatchedCount: freshOrigins.length,
          previouslyLinkedCount: previouslyLinked.length,
          proposedLinkCount: judged.filter(({ proposal }) => proposal !== null).length,
          matchedContactCount: judged.filter(({ contact }) => contact !== null).length,
          // The other half of the reconciliation: invoices this file has
          // no voucher for. Ruling 11 — the import proceeds and marks
          // them unmatched rather than refusing over them.
          invoicesWithNoVoucherCount: candidates.filter(
            (invoice) => !linkedInvoiceIds.has(invoice.id),
          ).length,
          // `heldOrigin` is a subset of `heldAny`, so this is the one
          // question: did a previous import of this export already deal
          // with the voucher, by either route.
          alreadyReadCount: read.vouchers.filter((voucher) => heldAny.has(voucher.guid))
            .length,
          importedInvoiceCount,
          importedLinkCount,
          vouchers,
          refusals: read.refusals.map((refusal) => ({ ...refusal })),
        };
      });
    },
  );

  /* --- ruling on a disagreement (ruling 21's second half) ---------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tally-invoices/links/:id/resolve',
      schema: {
        params: IdParamsSchema,
        body: ResolveTallyDisputeSchema,
        response: { 200: ImportedInvoiceDetailSchema, ...errorResponses },
      },
      role: 'writer',
      // THE PAYMENTS AUTHORITY, NOT THE IMPORT ONE, and the distinction is
      // the whole reason this route is separate from the import above.
      // Pointing a file at a register is a clerical act; deciding which of
      // two accounting systems is right about a rupee figure — and thereby
      // what this organisation reports as having billed — is a money
      // decision, which is what `canManagePayments` gates everywhere else
      // in this application.
      authority: 'payments',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const { resolution } = request.body;
      return await tenant(async (tx) => {
        // Locked before it is read, so a concurrent ruling cannot land
        // between the two — `imported-invoices.ts` takes the same order
        // for the same reason.
        const [locked] = await tx<{ id: string }[]>`
          select id from tally_invoice_links where id = ${id} for update
        `;
        if (!locked) {
          throw httpError(
            404,
            'TALLY_INVOICE_LINK_NOT_FOUND',
            'No such Tally correspondence.',
          );
        }
        const [link] = await tx<
          {
            imported_invoice_id: string;
            disputed: boolean;
            resolution: string | null;
            discarded_at: string | null;
          }[]
        >`
          select l.imported_invoice_id, l.disputed, l.resolution, i.discarded_at
          from tally_invoice_links l
          join imported_invoices i
            on i.organisation_id = l.organisation_id and i.id = l.imported_invoice_id
          where l.id = ${id}
        `;
        if (!link) {
          throw httpError(
            404,
            'TALLY_INVOICE_LINK_NOT_FOUND',
            'No such Tally correspondence.',
          );
        }
        if (link.discarded_at !== null) {
          throw httpError(
            409,
            'IMPORTED_INVOICE_DISCARDED',
            'The historical invoice this correspondence names was discarded, so there is no figure left to rule on.',
          );
        }
        // A RULING ON A LINK NOBODY DISPUTED is a ruling on nothing, and
        // it would move an invoice into or out of the billed total on the
        // strength of a decision about a disagreement that never existed.
        // 0119's own CHECK refuses it too; this is the sentence.
        if (!link.disputed) {
          throw httpError(
            409,
            'TALLY_DISPUTE_NOT_OPEN',
            'TallyPrime and Zoho agree about this correspondence, so there is nothing to rule on.',
          );
        }
        // The invoice's Work, if it has one, is the scope this member
        // must already hold — the same check every other act on a
        // historical invoice makes.
        const [invoice] = await tx<{ work_id: string | null }[]>`
          select work_id from imported_invoices where id = ${link.imported_invoice_id}
        `;
        if (invoice?.work_id != null) {
          await assertWorkAccess(tx, user.id, invoice.work_id);
        }

        await tx`
          update tally_invoice_links
          set resolution = ${resolution},
              resolved_by_user_id = ${user.id},
              resolved_at = now()
          where id = ${id}
        `.catch(rethrowWriteRefusal);

        await audit(
          tx,
          organisationId,
          user.id,
          'tally_invoice_link.resolved',
          'tally_invoice_links',
          id,
          {
            resolution,
            previousResolution: link.resolution,
            importedInvoiceId: link.imported_invoice_id,
            // Whether this ruling puts the invoice back into the billed
            // total, recorded because it is the consequence somebody will
            // be asked about later.
            restoresToTotal: resolution !== 'tally_correct',
          },
        );
        return await readImportedInvoiceDetail(tx, link.imported_invoice_id);
      });
    },
  );
}
