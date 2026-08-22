import { randomUUID } from 'node:crypto';
import {
  type ErrorCode,
  type ImportedDeductionHead,
  type ImportedPayment,
  ImportedPaymentListQuerySchema,
  ImportedPaymentListSchema,
  TallyReceiptImportResultSchema,
  type TallyReceiptProposal,
  TallyReceiptUploadQuerySchema,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { paiseText, toPaise } from '../money.js';
import { registerKeyset } from '../pagination.js';
import {
  type TallyLedgerFacts,
  type TallyReceipt,
  readTallyReceipts,
} from '../tally-receipts.js';
import { TallyImportError } from '../tally-scan.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_TALLY_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import { type WorkCandidate, proposeWorkLink, squeeze } from '../zoho-invoices.js';
import { audit, errorResponses, requireTrimmed, writeRefusals } from './shared.js';

/**
 * Railway receipts as imported payments (migration 0120) — wave T3 of the
 * Tally migration train.
 *
 * ## The shape of the feature, in two calls against the same bytes
 *
 * `POST /api/tally-receipts/import?mode=preview` reads the receipt
 * export, maps every deduction line to a head, proposes a Work and a
 * customer for each receipt, ties the bill allocations to the historical
 * register, and answers with the whole reconciliation. It writes nothing.
 * `?mode=commit` does the identical reading and then writes. That is
 * `tally-invoices.ts`'s shape and `imported-invoices.ts`'s, for the same
 * reason: the judgement is a pure function of the bytes, the ledger
 * census and the register, so re-sending the bytes is exactly equivalent
 * to committing a staged copy, minus a staging table and its lifecycle.
 *
 * ## THE INTAKE IS A FILTERED EXPORT
 *
 * TallyPrime's full `Transactions.xml` is 3.18 GB against a 192 MB upload
 * cap. Narrowed to `Receipt` it is 2,025 vouchers — a fraction of the
 * cap, and `docs/OPERATIONS.md` carries the four clicks. The reader
 * filters again on the way in, because an operator who forgot to narrow
 * the export is a real Tuesday and skipping a Payment voucher costs a
 * string comparison.
 *
 * ## THE LEDGER CENSUS IS A PRECONDITION, AND SAYS SO
 *
 * Nothing on a voucher line says whether the ledger it names is a bank, a
 * customer or a TDS head; the group it sits under says it, and that lives
 * in `tally_ledgers` (0118). So this import refuses a file-level 400 when
 * the census is empty, naming the masters import as the remedy. That is a
 * PRECONDITION rather than a row condition, which is why it is the one
 * file-level refusal here: every per-voucher problem is refused per
 * voucher, with the line it opened on, in both modes.
 *
 * ## What it writes, and what it deliberately does not
 *
 * One `imported_payments` row per conforming receipt, its deduction lines
 * under 0114's five heads plus ruling 15's `other` bucket, and one link
 * per bill allocation that reaches a live invoice on the register.
 *
 * It writes no Work, no contact and no invoice. A Work is PROPOSED by
 * ruling 17's three routes; a contact comes from the proposal the ledger
 * census already holds. Nothing here creates either — ruling 5, and 0118's
 * own posture.
 *
 * ## Permissions: BOTH the import authority and the payments one
 *
 * `tally-invoices.ts` takes `import` alone, because a cross-reference
 * between two systems' invoice numbers is a clerical act. This is not
 * that. Every row this route writes is a MONEY row — what the railway
 * settled, what reached the bank, and what was withheld under each
 * statutory head — and those figures are what a receivables reading sums.
 * `canManagePayments` is what gates money decisions everywhere else in
 * this application, so it gates this one too, on top of `import`.
 *
 * RULED BY THE OWNER, 23 Aug 2026, after the choice was put to them
 * rather than made silently: the dual gate STANDS. It is strictly
 * narrower than the import authority alone — a member who can import
 * invoices may find they cannot import receipts — and that is the
 * intended consequence, because what this route writes is money.
 *
 * ## Work scope: THE IMPORT IS ORG-WIDE AND THE VIEW IS SCOPED
 *
 * `imported-invoices.ts` narrows the Work CANDIDATES to the member's own
 * scope, and this route deliberately does not — the coordinator's finding
 * 8 on #180, and the difference is what the two acts are. Filing an
 * invoice against a Work is one operator's annotation; an import states
 * which contract a railway PAID against, and that fact cannot depend on
 * who happened to upload the file. Scoped candidates meant two members
 * importing the same export wrote two different registers, silently and
 * indistinguishably afterwards.
 *
 * So the resolution reads every live Work in the organisation, and the
 * scope lands where it belongs — on what is SHOWN. The preview carries a
 * work CODE and never a work id, so a proposal reaching a Work this
 * member cannot open renders as a bare code with nothing to click, and
 * the register beside it stays scoped row by row: the receipt does not
 * appear for them until they hold the Work.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * 0120's three guards are the arm that holds when a writer reaches the
 * tables another way; the route refuses everything they cover first,
 * under the advisory lock and per voucher. The PostgreSQL-native codes
 * beneath are BACKSTOPS for this route's input being a file.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23T04': [
    'IMPORTED_PAYMENT_IMMUTABLE',
    'An imported payment records what a TallyPrime export said, and it is never edited or deleted.',
  ],
  '23T05': [
    'IMPORTED_PAYMENT_IMMUTABLE',
    'A receipt whose deduction heads do not sum to its stated deduction total is not imported: gross = net + heads is the one arithmetic this register keeps.',
  ],
  '23T06': [
    'IMPORTED_PAYMENT_IMMUTABLE',
    'A receipt cannot be tied to a historical invoice that has been discarded. Import the corrected invoice export first.',
  ],
  '22008': [
    'TALLY_RECEIPTS_UNREADABLE',
    'That export carries a date no calendar has. The preview names the voucher and the line.',
  ],
  '22003': [
    'TALLY_RECEIPTS_UNREADABLE',
    'That export carries a figure too large for this register to store. The preview names the voucher and the line.',
  ],
  '23514': [
    'TALLY_RECEIPTS_UNREADABLE',
    'That export carries a value this register refuses. The preview names the voucher and the line.',
  ],
  '23503': [
    'WORK_NOT_FOUND',
    'A Work this import proposed has since been withdrawn. Read the file again and the proposal will be recomputed.',
  ],
};

const rethrowWriteRefusal = writeRefusals(DATABASE_REFUSALS);

/** How many rows one insert statement carries — the same order every bulk
 * write here uses. */
const CHUNK = 500;

/** The register's default page. 755 real receipts arrive in eight. */
const PAGE_LIMIT = 100;

/** 0114's heads in the order the screens read them: the two statutory
 * ones, then what the railway holds, then the bucket. Stated once so the
 * import report and the register's totals cannot disagree about the
 * order. */
const HEAD_ORDER: readonly ImportedDeductionHead[] = [
  'gst_tds',
  'income_tax_tds',
  'security_deposit',
  'retention',
  'liquidated_damages',
  'other',
];

/** What one receipt would be filed against, and by which of ruling 17's
 * three routes. */
interface WorkProposal {
  readonly workId: string;
  readonly method: 'sd_ledger' | 'bill_reference' | 'narration';
}

/**
 * Ruling 17's three routes, in the order the ruling sets.
 *
 * The ORDER is the ruling and not a preference: the security-deposit head
 * names the work directly and no receipt splits security deposit across
 * two works, so it is the strongest evidence on the voucher. A bill
 * allocation is second because it reaches the Work only through an
 * invoice somebody else linked. The narration is third because it is
 * free text an operator typed.
 *
 * Every arm PROPOSES. Ambiguity proposes nothing — the shared matcher's
 * rule, kept here by calling it rather than by reimplementing it.
 */
function proposeWork(
  receipt: TallyReceipt,
  worksByCode: ReadonlyMap<string, WorkCandidate>,
  works: readonly WorkCandidate[],
  invoiceWorkIds: readonly string[],
): WorkProposal | null {
  if (receipt.securityDepositPlCode !== null) {
    const work = worksByCode.get(squeeze(receipt.securityDepositPlCode));
    if (work !== undefined) return { workId: work.id, method: 'sd_ledger' };
  }
  // A bill allocation reaches a Work through the invoice it names. Two
  // invoices naming two DIFFERENT Works propose nothing, for the reason
  // every other arm gives.
  const distinct = [...new Set(invoiceWorkIds)];
  if (distinct.length === 1) {
    return { workId: distinct[0] as string, method: 'bill_reference' };
  }
  const proposal = proposeWorkLink(
    { referenceText: receipt.voucher.narration, lines: [] },
    works,
  );
  return proposal === null ? null : { workId: proposal.workId, method: 'narration' };
}

/** The register's own read, one payment with its heads and allocations. */
async function readPayments(
  tx: TransactionSql,
  ids: string[],
): Promise<ImportedPayment[]> {
  if (ids.length === 0) return [];
  const rows = await tx<
    {
      id: string;
      tally_guid: string;
      tally_voucher_number: string | null;
      tally_voucher_date: string;
      tally_narration: string | null;
      counterparty_ledger: string;
      contact_id: string | null;
      contact_name: string | null;
      work_id: string | null;
      work_code: string | null;
      work_withdrawn: boolean;
      work_link_method: string | null;
      gross_amount: string;
      net_amount: string;
      deduction_total: string;
      round_off_amount: string;
      created_at: string;
    }[]
  >`
    select p.id, p.tally_guid, p.tally_voucher_number,
           p.tally_voucher_date::text as tally_voucher_date, p.tally_narration,
           p.counterparty_ledger, p.contact_id, c.designation as contact_name,
           p.work_id, w.work_code,
           (w.deleted_at is not null) as work_withdrawn, p.work_link_method,
           p.gross_amount, p.net_amount, p.deduction_total, p.round_off_amount,
           p.created_at
    from imported_payments p
    left join contacts c
      on c.organisation_id = p.organisation_id and c.id = p.contact_id
    left join works w on w.organisation_id = p.organisation_id and w.id = p.work_id
    where p.id = any(${tx.array(ids)}::uuid[])
    order by p.tally_voucher_date desc, p.id desc
  `;
  const deductions = await tx<
    {
      id: string;
      imported_payment_id: string;
      head: string;
      tally_ledger_name: string;
      amount: string;
      amount_missing: boolean;
      leg_count: number;
      pl_code: string | null;
    }[]
  >`
    select id, imported_payment_id, head, tally_ledger_name, amount,
           amount_missing, leg_count, pl_code
    from imported_payment_deductions
    where imported_payment_id = any(${tx.array(ids)}::uuid[])
    order by tally_ledger_name
  `;
  const links = await tx<
    {
      id: string;
      imported_payment_id: string;
      imported_invoice_id: string;
      invoice_number: string;
      tally_bill_reference: string;
      amount: string | null;
      match_method: string;
    }[]
  >`
    select l.id, l.imported_payment_id, l.imported_invoice_id,
           i.invoice_number, l.tally_bill_reference, l.amount, l.match_method
    from imported_payment_invoice_links l
    join imported_invoices i
      on i.organisation_id = l.organisation_id and i.id = l.imported_invoice_id
    where l.imported_payment_id = any(${tx.array(ids)}::uuid[])
    order by l.tally_bill_reference
  `;
  return rows.map((row) => ({
    id: row.id,
    tallyGuid: row.tally_guid,
    voucherNumber: row.tally_voucher_number,
    voucherDate: row.tally_voucher_date,
    narration: row.tally_narration,
    counterpartyLedger: row.counterparty_ledger,
    contactId: row.contact_id,
    contactName: row.contact_name,
    workId: row.work_id,
    workCode: row.work_code,
    // FINDING 7: the Work was withdrawn after this receipt was filed
    // against it. The row still names it — nothing may edit an imported
    // payment — so the register says so rather than rendering a link to a
    // Work that is gone, and counts the receipt in the manual-link queue.
    workWithdrawn: row.work_withdrawn,
    workLinkMethod: row.work_link_method as ImportedPayment['workLinkMethod'],
    gross: row.gross_amount,
    net: row.net_amount,
    deductionTotal: row.deduction_total,
    roundOff: row.round_off_amount,
    deductions: deductions
      .filter((line) => line.imported_payment_id === row.id)
      .map((line) => ({
        id: line.id,
        head: line.head as ImportedDeductionHead,
        tallyLedgerName: line.tally_ledger_name,
        amount: line.amount,
        amountMissing: line.amount_missing,
        legCount: line.leg_count,
        plCode: line.pl_code,
      })),
    invoiceLinks: links
      .filter((link) => link.imported_payment_id === row.id)
      .map((link) => ({
        id: link.id,
        importedInvoiceId: link.imported_invoice_id,
        invoiceNumber: link.invoice_number,
        tallyBillReference: link.tally_bill_reference,
        amount: link.amount,
        matchMethod: link.match_method as 'exact_number' | 'manual',
      })),
    importedAt: new Date(row.created_at).toISOString(),
  }));
}

export function registerTallyReceiptRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  malwareScanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- the register ------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/imported-payments',
      schema: {
        querystring: ImportedPaymentListQuerySchema,
        response: { 200: ImportedPaymentListSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, user, tenantSnapshot }) => {
      const query = request.query;
      return await tenantSnapshot(async (tx) => {
        if (query.work !== undefined) {
          await assertWorkAccess(tx, user.id, query.work);
        }
        const full = await hasFullWorkScope(tx, user.id);
        // LINKED IN EFFECT, STATED ONCE — the coordinator's finding 7.
        //
        // A Work can be WITHDRAWN after a receipt was filed against it
        // (0071's supersession), and nothing here may edit an imported
        // payment, so the row keeps pointing at it. Read naively, that
        // receipt is "linked": it drops out of the manual-link queue, out
        // of `unlinkedCount`, and into a Work cell rendering a link to a
        // 404 — which is precisely the state ruling 17's queue exists to
        // surface. So every reading of "has a Work" in this route is this
        // expression, and a receipt whose Work is withdrawn is unlinked
        // in effect: it rejoins the queue, and the register says
        // `CODE (withdrawn)` where it would have said a link — the same
        // shape `imported-invoices.ts` took for the same reason (#167).
        const linkedInEffect = tx`(
          p.work_id is not null
          and exists (
            select 1 from works w
            where w.organisation_id = p.organisation_id
              and w.id = p.work_id and w.deleted_at is null
          )
        )`;
        const seek = registerKeyset(undefined, query.cursor, {
          table: 'imported_payments',
          alias: 'p',
          columns: ['tally_voucher_date', 'id'],
        });
        // The cursor is proven against the SAME predicate the rows are,
        // and refused exactly as a nonexistent one is, so the register
        // cannot be used as an oracle for rows out of scope.
        let cursor: string | null = null;
        if (seek.cursor !== undefined) {
          const [row] = await tx<{ id: string }[]>`
            select p.id from imported_payments p
            where p.id = ${seek.cursor}
              and (not ${linkedInEffect} or ${full} or exists (
                select 1 from work_assignments wa
                where wa.work_id = p.work_id and wa.user_id = ${user.id}
              ))
          `;
          if (!row) {
            throw httpError(
              400,
              'CURSOR_INVALID',
              'The pagination cursor does not name a row in this register.',
            );
          }
          cursor = row.id;
        }

        const limit = query.limit ?? PAGE_LIMIT;
        // One predicate, written once and composed into both statements —
        // the page and its totals must not be able to disagree about
        // which register they are describing.
        //
        // THE SCOPE READS THE SAME "LINKED IN EFFECT" AS EVERYTHING ELSE.
        // A receipt no live Work claims is readable by every member: it
        // is the manual-link queue, and a queue only its future owner can
        // see is not a queue. That covers the receipt whose Work was
        // WITHDRAWN as well as the one that never had one — the row is
        // nobody's Work now, and hiding it from everyone but the members
        // who were assigned to a contract that no longer exists would
        // bury it exactly when somebody needs to re-point it.
        const filters = tx`
          (not ${linkedInEffect} or ${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = p.work_id and wa.user_id = ${user.id}
          ))
          and (${query.work ?? null}::uuid is null or p.work_id = ${query.work ?? null})
          and (${query.linked ?? null}::text is null
               or (${query.linked ?? null} = 'linked') = ${linkedInEffect})
        `;

        const page = await tx<{ id: string }[]>`
          select p.id
          from imported_payments p
          where ${filters}
            and ${seek.predicate(tx, cursor)}
          order by ${tx.unsafe(seek.orderBy)}
          limit ${limit + 1}
        `;
        const hasMore = page.length > limit;
        const ids = page.slice(0, limit).map((row) => row.id);
        const payments = await readPayments(tx, ids);

        // FIRST PAGE ONLY. A request carrying a cursor is continuing a
        // walk whose totals the screen already has, and recounting the
        // register per page is an aggregate over every row to answer a
        // question nothing on screen re-asks.
        let totals = null;
        if (cursor === null) {
          const [summary] = await tx<
            {
              count: string;
              gross: string;
              net: string;
              deduction_total: string;
              unlinked: string;
            }[]
          >`
            -- CAST THROUGH THE DOMAIN, not to a bare zero. Coalescing a
            -- null sum to 0 falls back to an INTEGER literal, so an empty
            -- register answers "0" where every other figure on the screen
            -- says "0.00" — the defect pack P15's review found in the
            -- bill-payment register and the reason this is written out.
            select count(*)::text as count,
                   coalesce(sum(p.gross_amount), 0)::money_amount::text as gross,
                   coalesce(sum(p.net_amount), 0)::money_amount::text as net,
                   coalesce(sum(p.deduction_total), 0)::money_amount::text
                     as deduction_total,
                   count(*) filter (where not ${linkedInEffect})::text as unlinked
            from imported_payments p
            where ${filters}
          `;
          const heads = await tx<
            { head: string; amount: string; line_count: string }[]
          >`
            select d.head, sum(d.amount)::money_amount::text as amount,
                   count(*)::text as line_count
            from imported_payment_deductions d
            join imported_payments p
              on p.organisation_id = d.organisation_id and p.id = d.imported_payment_id
            where ${filters}
            group by d.head
          `;
          const byHead = new Map(heads.map((row) => [row.head, row]));
          totals = {
            count: Number(summary?.count ?? '0'),
            gross: summary?.gross ?? '0.00',
            net: summary?.net ?? '0.00',
            deductionTotal: summary?.deduction_total ?? '0.00',
            unlinkedCount: Number(summary?.unlinked ?? '0'),
            // EVERY HEAD, INCLUDING THE EMPTY ONES. `retention` is
            // permanently empty for imported payments (ruling 13) and
            // saying so is the point: a head missing from the list reads
            // as a head nobody thought about.
            heads: HEAD_ORDER.map((head) => ({
              head,
              amount: byHead.get(head)?.amount ?? '0.00',
              lineCount: Number(byHead.get(head)?.line_count ?? '0'),
            })),
          };
        }

        return {
          payments,
          nextCursor: hasMore ? seek.tag(ids.at(-1) ?? null) : null,
          totals,
        };
      });
    },
  );

  /* --- the import --------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tally-receipts/import',
      schema: {
        querystring: TallyReceiptUploadQuerySchema,
        response: { 200: TallyReceiptImportResultSchema, ...errorResponses },
      },
      role: 'writer',
      // BOTH AUTHORITIES. See the header: this writes money rows, and
      // `payments` is what gates a money decision everywhere else here.
      authority: ['import', 'payments'],
      bodyLimit: MAX_TALLY_UPLOAD_BYTES,
    },
    async ({ request, user, organisationId, tenant }) => {
      // AUTHORISE FIRST — before the format guard, not merely before the
      // scanner: this format HAS a signature, so `consumeUpload` refuses
      // a wrong body with a 400, and a 400 where every other tenant route
      // answers 403 tells an unauthorised caller that the route exists.
      await tenant(() => Promise.resolve());

      const { bytes } = consumeUpload(request.body, {
        format: 'tally-xml',
        description: 'the TallyPrime receipt voucher export',
      });
      // STRIP FIRST, THEN TRIM: the other order lets a control character
      // survive the blank check and then vanish, leaving an untrimmed
      // value for a CHECK to refuse as a 500.
      const filename = requireTrimmed(
        request.query.filename.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''),
        'Name the file being imported.',
      );

      await assertNotMalware(malwareScanner, bytes);

      const commit = request.query.mode === 'commit';
      // THE MAPPER WRAPS THE WHOLE TRANSACTION, NOT ONLY THE STATEMENTS.
      //
      // 0120's head-sum check is a DEFERRED constraint trigger, so it
      // fires at COMMIT — which happens when this callback returns, after
      // every `.catch(rethrowWriteRefusal)` inside it has gone out of
      // scope. A 23T05 raised there escaped raw and reached the client as
      // an unmapped 500 with no remedy, which is precisely the shape the
      // named-refusal discipline exists to prevent. Mapping here as well
      // costs one try/catch and closes the only door the per-statement
      // catches cannot see through.
      try {
        return await tenant(async (tx) => {
          // ONE IMPORT PER ORGANISATION AT A TIME, refusing rather than
          // queueing — the masters and invoice imports' argument exactly,
          // plus one of its own: the "one voucher imports at most one
          // payment" rule this route checks in application code is only
          // race-free under it, and 0120's unique index is the arm that
          // holds if it is ever not. Transaction-scoped, so it is released
          // by the commit or the rollback with nothing to unwind.
          const [lock] = await tx<{ taken: boolean }[]>`
          select pg_try_advisory_xact_lock(
            hashtextextended(${`tally-receipts:${organisationId}`}, 0)
          ) as taken
        `;
          if (lock?.taken !== true) {
            throw httpError(
              409,
              'TALLY_IMPORT_IN_PROGRESS',
              'Another Tally receipt import is running for this organisation. Wait for it to finish, then read the file again.',
            );
          }

          // THE LEDGER CENSUS, WHICH IS WHAT SAYS WHICH LEG IS WHICH.
          //
          // THE LATEST IMPORT ONLY, in the shape migration 0118 § pins for
          // every wave that joins this table: `last_seen_at = (select
          // max(last_seen_at) …)`, never the table unfiltered. A row a
          // later masters import stopped naming describes a master Tally no
          // longer has, and classifying today's voucher by it is exactly
          // the failure the column exists to prevent — most sharply when a
          // ledger NAME is reused: the stale row would answer "bank" for a
          // name the current chart of accounts gives to something else.
          //
          // Deleted masters are excluded on top of that: a ledger Tally
          // itself marked deleted is not one to classify a live voucher by.
          const latestCensus = tx`(select max(last_seen_at) from tally_ledgers)`;
          const ledgerRows = await tx<
            {
              ledger_name: string;
              group_path: string[];
              classification: string;
              pl_code: string | null;
              proposed_contact_id: string | null;
              proposed_contact_method: string | null;
            }[]
          >`
          select ledger_name, group_path, classification, pl_code,
                 proposed_contact_id, proposed_contact_method
          from tally_ledgers
          where not tally_is_deleted
            and last_seen_at = ${latestCensus}
        `;
          // A PRECONDITION, NOT A ROW CONDITION, and therefore the one
          // file-level refusal this route makes. Without the census every
          // bank line reads as a deduction head and every receipt in the
          // file would be refused for not reconciling — a hundred confusing
          // refusals in place of one true sentence.
          if (ledgerRows.length === 0) {
            throw httpError(
              409,
              'TALLY_LEDGER_CENSUS_REQUIRED',
              'The Tally ledger census has not been imported yet, and it is what says whether a voucher line is a bank, a customer or a deduction head. Import the All Masters export on Administration → Tally census first, then read this file again.',
            );
          }
          const ledgers = new Map<string, TallyLedgerFacts>(
            ledgerRows.map((row) => [
              row.ledger_name,
              {
                name: row.ledger_name,
                groupPath: row.group_path,
                classification: row.classification,
                plCode: row.pl_code,
                proposedContactId: row.proposed_contact_id,
                proposedContactMethod:
                  row.proposed_contact_method as TallyLedgerFacts['proposedContactMethod'],
              },
            ]),
          );

          let read;
          try {
            read = readTallyReceipts(bytes, ledgers);
          } catch (cause: unknown) {
            if (cause instanceof TallyImportError) {
              // The two codes are written out as LITERALS rather than
              // passed through as `cause.code`, and the error-remedy census
              // in `apps/server/test/error-remedies.test.ts` is why: it
              // reads this server's source for the codes each route can
              // answer with, and a code that only appears as a variable is
              // invisible to it.
              if (cause.code === 'TALLY_EXPORT_TRUNCATED') {
                throw httpError(400, 'TALLY_RECEIPTS_TRUNCATED', cause.message);
              }
              throw httpError(400, 'TALLY_RECEIPTS_UNREADABLE', cause.message);
            }
            throw cause;
          }
          if (read.receiptCount === 0) {
            throw httpError(
              400,
              'TALLY_RECEIPTS_UNREADABLE',
              'That export declares no Receipt vouchers. In TallyPrime, export the Day Book narrowed to Receipt rather than a different register.',
            );
          }

          // What a previous import already brought in, keyed on the voucher
          // GUID — the idempotency key ruling 2 stores on every row.
          const guids = [...new Set(read.receipts.map((r) => r.voucher.guid))];
          const held = await tx<{ tally_guid: string }[]>`
          select tally_guid from imported_payments
          where tally_guid = any(${tx.array(guids)}::text[])
        `;
          const heldGuids = new Set(held.map((row) => row.tally_guid));

          // FINDING 8: THE PROPOSAL IS RESOLVED ORG-WIDE, AND ONLY THE
          // REPORT IS SCOPED.
          //
          // An import writes a fact about money — which contract the
          // railway paid against — and that fact cannot depend on which
          // Works the member running the import happens to be assigned to.
          // Scoping the CANDIDATES meant two members importing the same
          // file wrote different registers: the receipt whose
          // security-deposit head names a Work outside the operator's scope
          // landed unlinked for them and linked for the owner, silently,
          // with no way to tell the two apart afterwards.
          //
          // So the resolution reads every live Work in the organisation,
          // and the SCOPE is applied where it belongs — to what the
          // operator is shown, and the preview is what shows it: it carries
          // a work CODE and never a work id, so a proposal reaching a Work
          // this member may not open renders as a bare code with nothing to
          // click. The register beside it stays scoped row by row, so the
          // receipt itself does not appear for them until they are assigned
          // the Work — which is the difference between "this member cannot
          // reach that Work" and "this member's import wrote less".
          const works = await tx<
            { id: string; work_code: string; letter_number: string }[]
          >`
          select id, work_code, letter_number
          from works where deleted_at is null
        `.then((rows) =>
            rows.map((row) => ({
              id: row.id,
              workCode: row.work_code,
              letterNumber: row.letter_number,
            })),
          );
          const worksByCode = new Map(
            works.map((work) => [squeeze(work.workCode), work]),
          );

          // THE REGISTER AS IT STANDS, live rows only — the same reading
          // 0115's partial unique index takes. A discarded invoice is one
          // the operator withdrew; tying a receipt to it would file money
          // against evidence that has been taken off the record.
          const registerRows = await tx<
            { id: string; invoice_number: string; work_id: string | null }[]
          >`
          select id, invoice_number, work_id
          from imported_invoices
          where discarded_at is null
        `;
          const invoicesByNumber = new Map<
            string,
            { id: string; workId: string | null }[]
          >();
          for (const row of registerRows) {
            const key = squeeze(row.invoice_number);
            if (key.length < 3) continue;
            const bucket = invoicesByNumber.get(key);
            const entry = { id: row.id, workId: row.work_id };
            if (bucket === undefined) invoicesByNumber.set(key, [entry]);
            else bucket.push(entry);
          }
          /** Which Work an invoice is filed against, indexed once for the
           * whole file: ruling 17's second route reads it per receipt, and
           * scanning the register for each one is the register times the
           * file. */
          const workByInvoiceId = new Map(
            registerRows.map((row) => [row.id, row.work_id]),
          );

          /* --- what each receipt would do -------------------------------- */

          interface Judged {
            readonly receipt: TallyReceipt;
            readonly proposal: WorkProposal | null;
            readonly links: readonly {
              readonly invoiceId: string;
              readonly reference: string;
            }[];
            readonly unmatchedReferences: number;
            readonly ambiguousReferences: number;
          }
          const fresh = read.receipts.filter(
            (receipt) => !heldGuids.has(receipt.voucher.guid),
          );
          const judged: Judged[] = fresh.map((receipt) => {
            const links: { invoiceId: string; reference: string }[] = [];
            let unmatchedReferences = 0;
            let ambiguousReferences = 0;
            const seen = new Set<string>();
            for (const reference of receipt.billReferences) {
              const key = squeeze(reference);
              // A one- or two-character "bill number" matches half a
              // register; the invoice importers drop the same keys.
              const hits = key.length < 3 ? [] : (invoicesByNumber.get(key) ?? []);
              if (hits.length === 0) {
                unmatchedReferences += 1;
                continue;
              }
              // AMBIGUITY LINKS NOTHING — finding 6, and the same rule
              // `proposeWorkLink` keeps one level up. `squeeze` removes
              // punctuation, so `123/A` and `123-A` are one key: two real
              // invoices, one reference, and no way to tell which was
              // settled. Linking BOTH would file one payment against two
              // bills and double what the register says was received
              // against them; linking the first would pick by whatever
              // order the read came back in. So neither is linked, and the
              // count says how often it happened rather than leaving the
              // silence to be discovered in a reconciliation.
              if (hits.length > 1) {
                ambiguousReferences += 1;
                continue;
              }
              for (const hit of hits) {
                if (seen.has(hit.id)) continue;
                seen.add(hit.id);
                links.push({ invoiceId: hit.id, reference });
              }
            }
            const invoiceWorkIds = [...seen]
              .map((id) => workByInvoiceId.get(id) ?? null)
              .filter((id): id is string => id !== null);
            return {
              receipt,
              proposal: proposeWork(receipt, worksByCode, works, invoiceWorkIds),
              links,
              unmatchedReferences,
              ambiguousReferences,
            };
          });

          let importedPaymentCount = 0;
          let importedDeductionCount = 0;
          let importedInvoiceLinkCount = 0;

          if (commit && judged.length > 0) {
            /** The ids minted here, in `judged` order, so the deduction
             * lines and the allocations pair with their payment without
             * depending on anything the database returns. A plain multi-row
             * insert happens to return rows in order and PostgreSQL does
             * not promise it; these are money rows, and pairing them by an
             * ordering nobody guarantees is the kind of bug that shows up
             * years later as one receipt wearing another's deductions. */
            const paymentIds = judged.map(() => randomUUID());

            const paymentRows = judged.map(({ receipt, proposal }, index) => ({
              id: paymentIds[index] as string,
              organisation_id: organisationId,
              tally_guid: receipt.voucher.guid,
              tally_alterid: receipt.voucher.alterId,
              tally_voucher_number: receipt.voucher.voucherNumber,
              tally_voucher_date: receipt.voucher.date,
              tally_narration: receipt.voucher.narration,
              tally_party_ledger: receipt.voucher.partyLedger,
              counterparty_ledger: receipt.counterpartyLedger,
              contact_id: receipt.contactId,
              contact_match_method: receipt.contactMatchMethod,
              work_id: proposal?.workId ?? null,
              work_link_method: proposal?.method ?? null,
              gross_amount: receipt.gross,
              net_amount: receipt.net,
              deduction_total: receipt.deductionTotal,
              round_off_amount: receipt.roundOff,
              source_fields: tx.json(receipt.voucher.sourceFields as never),
              source_filename: filename,
              imported_by_user_id: user.id,
            }));

            for (let index = 0; index < paymentRows.length; index += CHUNK) {
              const rows = await tx<{ id: string }[]>`
              insert into imported_payments ${tx(paymentRows.slice(index, index + CHUNK))}
              -- A re-import adds the receipts that are missing and
              -- collides on the ones that are not, which is what makes
              -- running the same export twice safe.
              on conflict (organisation_id, tally_guid) do nothing
              returning id
            `.catch(rethrowWriteRefusal);
              importedPaymentCount += rows.length;
            }
            // WHICH PAYMENTS ACTUALLY LANDED. A re-import under a race can
            // collide on the unique key, and writing that payment's heads
            // against an id no row carries would fail the foreign key
            // mid-commit with nothing named. So the children are written
            // for the ids that exist.
            const landed = await tx<{ id: string }[]>`
            select id from imported_payments
            where id = any(${tx.array(paymentIds)}::uuid[])
          `;
            const landedIds = new Set(landed.map((row) => row.id));

            const deductionRows = judged.flatMap(({ receipt }, index) => {
              const paymentId = paymentIds[index] as string;
              if (!landedIds.has(paymentId)) return [];
              return receipt.deductions.map((line) => ({
                organisation_id: organisationId,
                imported_payment_id: paymentId,
                head: line.head,
                tally_ledger_name: line.tallyLedgerName,
                amount: line.amount,
                amount_missing: line.amountMissing,
                leg_count: line.legCount,
                pl_code: line.plCode,
              }));
            });
            for (let index = 0; index < deductionRows.length; index += CHUNK) {
              const rows = await tx<{ id: string }[]>`
              insert into imported_payment_deductions ${tx(deductionRows.slice(index, index + CHUNK))}
              on conflict (organisation_id, imported_payment_id, tally_ledger_name)
                do nothing
              returning id
            `.catch(rethrowWriteRefusal);
              importedDeductionCount += rows.length;
            }

            const linkRows = judged.flatMap(({ links }, index) => {
              const paymentId = paymentIds[index] as string;
              if (!landedIds.has(paymentId)) return [];
              return links.map((link) => ({
                organisation_id: organisationId,
                imported_payment_id: paymentId,
                imported_invoice_id: link.invoiceId,
                tally_bill_reference: link.reference.slice(0, 200).trim(),
                // NO AMOUNT. TallyPrime states a per-bill figure only on
                // some allocations, and this reader does not keep it — see
                // 0120 § 3: null means the export stated none, and putting
                // the receipt's own total here would be inventing it.
                amount: null,
                match_method: 'exact_number',
              }));
            });
            for (let index = 0; index < linkRows.length; index += CHUNK) {
              const rows = await tx<{ id: string }[]>`
              insert into imported_payment_invoice_links ${tx(linkRows.slice(index, index + CHUNK))}
              on conflict (organisation_id, imported_payment_id, imported_invoice_id)
                do nothing
              returning id
            `.catch(rethrowWriteRefusal);
              importedInvoiceLinkCount += rows.length;
            }

            // ONE AUDIT EVENT FOR THE IMPORT, not one per receipt. A
            // receipt is not a document somebody filed here, and 755 events
            // per import would bury the timeline that answers what a person
            // did. The file, the counts and the refusals are the act.
            await audit(
              tx,
              organisationId,
              user.id,
              'imported_payment.imported',
              'imported_payments',
              null,
              {
                filename,
                voucherCount: read.voucherCount,
                receiptCount: read.receiptCount,
                paymentCount: importedPaymentCount,
                deductionCount: importedDeductionCount,
                invoiceLinkCount: importedInvoiceLinkCount,
                refusedCount: read.refused.length,
                skippedCount: read.skipped.length,
                unlinkedCount: judged.filter(({ proposal }) => proposal === null)
                  .length,
              },
            );
          }

          /* --- the report ------------------------------------------------ */

          const workCodeById = new Map(works.map((work) => [work.id, work.workCode]));
          const judgedByGuid = new Map(
            judged.map((entry) => [entry.receipt.voucher.guid, entry]),
          );

          const receipts: TallyReceiptProposal[] = [];
          const headTotals = new Map<
            ImportedDeductionHead,
            { paise: bigint; lines: number }
          >();
          let grossPaise = 0n;
          let netPaise = 0n;
          let deductionPaise = 0n;
          let roundOffPaise = 0n;
          let roundOffLineCount = 0;
          let missingAmountLineCount = 0;
          let invoiceLinkCount = 0;
          let unmatchedBillReferenceCount = 0;
          let ambiguousBillReferenceCount = 0;

          for (const receipt of read.receipts) {
            const entry = judgedByGuid.get(receipt.voucher.guid);
            const alreadyRead = entry === undefined;
            if (!alreadyRead) {
              grossPaise += toPaise(receipt.gross);
              netPaise += toPaise(receipt.net);
              deductionPaise += toPaise(receipt.deductionTotal);
              roundOffPaise += toPaise(receipt.roundOff);
              roundOffLineCount += receipt.roundOffLineCount;
              invoiceLinkCount += entry.links.length;
              unmatchedBillReferenceCount += entry.unmatchedReferences;
              ambiguousBillReferenceCount += entry.ambiguousReferences;
              for (const line of receipt.deductions) {
                const bucket = headTotals.get(line.head) ?? { paise: 0n, lines: 0 };
                headTotals.set(line.head, {
                  paise: bucket.paise + toPaise(line.amount),
                  lines: bucket.lines + 1,
                });
                if (line.amountMissing) missingAmountLineCount += 1;
              }
            }
            const proposal = entry?.proposal ?? null;
            receipts.push({
              tallyGuid: receipt.voucher.guid,
              voucherNumber: receipt.voucher.voucherNumber,
              voucherDate: receipt.voucher.date,
              counterpartyLedger: receipt.counterpartyLedger,
              gross: receipt.gross,
              net: receipt.net,
              deductionTotal: receipt.deductionTotal,
              outcome: alreadyRead ? 'already_read' : 'imported',
              reason: null,
              workCode:
                proposal === null ? null : (workCodeById.get(proposal.workId) ?? null),
              workLinkMethod: proposal?.method ?? null,
              invoiceLinkCount: entry?.links.length ?? 0,
              missingAmountCount: receipt.deductions.filter(
                (line) => line.amountMissing,
              ).length,
              heads: receipt.deductions.map((line) => ({
                head: line.head,
                tallyLedgerName: line.tallyLedgerName,
                amount: line.amount,
                amountMissing: line.amountMissing,
              })),
            });
          }
          for (const skip of read.skipped) {
            receipts.push({
              tallyGuid: skip.voucher.guid,
              voucherNumber: skip.voucher.voucherNumber,
              voucherDate: skip.voucher.date,
              counterpartyLedger: skip.voucher.partyLedger,
              gross: '0.00',
              net: '0.00',
              deductionTotal: '0.00',
              outcome: 'skipped',
              reason:
                skip.reason === 'bank_party'
                  ? 'The party is a bank, so this is a loan drawdown, a deposit or EMD refund, or an FDR maturity rather than a collection. Wave T4 reads these.'
                  : 'This receipt carries no deduction at all — a plain collection, an advance or a refund. Wave T4 reads these.',
              workCode: null,
              workLinkMethod: null,
              invoiceLinkCount: 0,
              missingAmountCount: 0,
              heads: [],
            });
          }
          for (const refusal of read.refused) {
            receipts.push({
              tallyGuid: refusal.voucher.guid,
              voucherNumber: refusal.voucher.voucherNumber,
              voucherDate: refusal.voucher.date,
              counterpartyLedger: refusal.voucher.partyLedger,
              gross: '0.00',
              net: '0.00',
              deductionTotal: '0.00',
              outcome: 'refused',
              reason: refusal.reason.slice(0, 300),
              workCode: null,
              workLinkMethod: null,
              invoiceLinkCount: 0,
              missingAmountCount: 0,
              heads: [],
            });
          }

          return {
            mode: request.query.mode,
            filename,
            voucherCount: read.voucherCount,
            receiptCount: read.receiptCount,
            cancelledCount: read.cancelled.length,
            optionalCount: read.optional.length,
            bankPartyCount: read.skipped.filter((skip) => skip.reason === 'bank_party')
              .length,
            noDeductionCount: read.skipped.filter(
              (skip) => skip.reason === 'no_deduction',
            ).length,
            importableCount: judged.length,
            alreadyReadCount: read.receipts.length - judged.length,
            refusedCount: read.refused.length,
            workLinkedCount: judged.filter(({ proposal }) => proposal !== null).length,
            unlinkedCount: judged.filter(({ proposal }) => proposal === null).length,
            matchedContactCount: judged.filter(
              ({ receipt }) => receipt.contactId !== null,
            ).length,
            invoiceLinkCount,
            unmatchedBillReferenceCount,
            ambiguousBillReferenceCount,
            missingAmountLineCount,
            roundOffLineCount,
            roundOffTotal: paiseText(roundOffPaise),
            // FINDING 4: every one of these refused its voucher rather
            // than booking to the `other` bucket, so this counts vouchers
            // and the remedy is one fresh masters export.
            uncensusedLedgerRefusalCount: read.refused.filter(
              (refusal) => refusal.kind === 'uncensused_ledger',
            ).length,
            grossTotal: paiseText(grossPaise),
            netTotal: paiseText(netPaise),
            deductionTotal: paiseText(deductionPaise),
            heads: HEAD_ORDER.map((head) => ({
              head,
              amount: paiseText(headTotals.get(head)?.paise ?? 0n),
              lineCount: headTotals.get(head)?.lines ?? 0,
            })),
            importedPaymentCount,
            importedDeductionCount,
            importedInvoiceLinkCount,
            receipts,
            refusals: read.refusals.map((refusal) => ({ ...refusal })),
          };
        });
      } catch (cause: unknown) {
        rethrowWriteRefusal(cause);
      }
    },
  );
}
