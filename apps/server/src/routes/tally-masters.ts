import {
  type ErrorCode,
  TallyLedgerListSchema,
  TallyLedgerQuerySchema,
  TallyMasterImportResultSchema,
  TallyMasterUploadQuerySchema,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import type { MalwareScanner } from '../malware-scan.js';
import { keysetPage, registerKeyset, sqlLimit } from '../pagination.js';
import {
  TallyMasterImportError,
  proposeContact,
  readTallyMasters,
} from '../tally-masters.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_TALLY_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import { type ContactCandidate, indexContacts } from '../zoho-invoices.js';
import { audit, errorResponses, requireTrimmed, writeRefusals } from './shared.js';

/**
 * The Tally ledger census (migration 0118) — wave T1 of the Tally
 * migration train.
 *
 * ## The shape of the feature, in two calls against the same bytes
 *
 * `POST /api/tally-masters/import?mode=preview` reads the export,
 * classifies every ledger, proposes a contact for every party ledger it
 * can, and answers with the whole census as a REPORT: counts by class, by
 * root group, the work-coded instruments, the parties the contacts master
 * could not answer for, and every ledger it refused, by line. It writes
 * nothing. `?mode=commit` does the identical reading and then writes.
 *
 * That is `imported-invoices.ts`'s shape and it is here for the same
 * reason: the judgement is a pure function of the bytes, so re-sending
 * them to commit is exactly equivalent to committing a staged copy, minus
 * a staging table and its lifecycle.
 *
 * ## Where it deliberately differs from the invoice importer
 *
 * The invoice register is IMMUTABLE — a record of documents another
 * system issued — so its import inserts and never updates, and its
 * correction path is to discard a row. This census MIRRORS a file the
 * organisation is still using every day (owner ruling 1: Tally remains
 * the general accounting books), and owner ruling 3 says the import runs
 * on a fresh export taken on import day. So the commit UPSERTS: a master
 * whose ALTERID moved is refreshed, and a row the newest export does not
 * name is left behind by `last_seen_at` rather than discarded. Migration
 * 0118's header argues both halves.
 *
 * The preview also returns a REPORT rather than every row. 638 invoices
 * is a list a clerk reads before pressing commit; 4,327 ledgers is not.
 * The rows are on the census screen afterwards, filtered.
 *
 * ## What it does not do
 *
 * It creates no contact, links no contact, creates no Work and fabricates
 * no instrument — owner rulings 4, 5, 6 and 18. Every contact it finds is
 * stored as a PROPOSAL for a person to confirm in a later wave, and a
 * ledger name that names two works proposes nothing at all.
 *
 * ## Permissions
 *
 * The `import` authority on top of the writer role, exactly as 0094 and
 * 0115: pointing a file at a register is a different act from adding one
 * row to it. The census's READS carry the writer role alone — which
 * parties this organisation trades with is ordinary reference data, and
 * gating it on the import authority would send every member who is not a
 * founding owner into a 403 on a screen the rail draws for them.
 *
 * ## Work scope
 *
 * There is none, and that is a property of the schema rather than an
 * omission: `tally_ledgers` reaches `works` nowhere. Owner rulings 4 and
 * 5 keep the work code as TEXT, so no row here names a Work, and a
 * census of the organisation's own chart of accounts is organisation-wide
 * by nature.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * 23T01 is migration 0118's single guard: which Tally master a census row
 * is about never changes, and an older export cannot overwrite a newer
 * one. The import upserts on the GUID and cannot reach either arm, so a
 * row that gets here has lost a race or arrived another way — and it
 * should say so as a 409 with a remedy rather than as a 500.
 *
 * The PostgreSQL-native codes beneath are BACKSTOPS, for this route's
 * input being a file: the reader refuses an over-long name, a malformed
 * GSTIN and a control character up front, in the preview, where the
 * refusal carries a line number and nothing has been written.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23T01': [
    'TALLY_LEDGER_IMMUTABLE',
    'A census row mirrors one Tally master. Which master it is about cannot change, and an export older than the one already imported cannot overwrite it.',
  ],
  // 22003 numeric_value_out_of_range, 23514 check_violation,
  // 23503 foreign_key_violation.
  '22003': [
    'TALLY_EXPORT_UNREADABLE',
    'That export carries a figure too large for this census to store. The preview names the ledger and the line.',
  ],
  '23514': [
    'TALLY_EXPORT_UNREADABLE',
    'That export carries a value this census refuses. The preview names the ledger and the line.',
  ],
  '23503': [
    'CONTACT_NOT_FOUND',
    'A customer this import proposed has since left the contacts master. Import the export again and the proposal will be recomputed.',
  ],
};

const rethrowWriteRefusal = writeRefusals(DATABASE_REFUSALS);

/** How many ledgers the census returns when the caller asks for no page.
 * The whole census is 4,327 rows and the screen filters it by class
 * before it scrolls. */
const PAGE_LIMIT = 100;

/**
 * The columns every read of the census selects, so a new field is added in
 * one place rather than in two queries that drift apart —
 * `imported-invoices.ts`'s shape, for its reason.
 *
 * `source_fields` is deliberately ABSENT: it is the truth source rather
 * than a field of the wire model, it is ~770 bytes per row, and nothing
 * on screen renders it. Anybody who needs it reads it from the table.
 */
const LEDGER_COLUMNS = `
  l.id, l.tally_guid, l.tally_alterid, l.ledger_name, l.parent_group,
  l.group_path, l.classification, l.gstin, l.opening_balance, l.pl_code,
  l.tally_is_deleted, l.name_ambiguous, l.proposed_contact_id,
  l.proposed_contact_method, l.source_filename, l.last_seen_at, l.created_at,
  c.designation as proposed_contact_name
`;

interface LedgerRow {
  id: string;
  tally_guid: string;
  tally_alterid: string | number;
  ledger_name: string;
  parent_group: string;
  group_path: string[];
  classification: string;
  gstin: string | null;
  opening_balance: string | null;
  pl_code: string | null;
  tally_is_deleted: boolean;
  name_ambiguous: boolean;
  proposed_contact_id: string | null;
  proposed_contact_name: string | null;
  proposed_contact_method: string | null;
  source_filename: string;
  last_seen_at: string;
  created_at: string;
}

function toLedger(row: LedgerRow) {
  return {
    id: row.id,
    tallyGuid: row.tally_guid,
    tallyAlterId: Number(row.tally_alterid),
    ledgerName: row.ledger_name,
    parentGroup: row.parent_group,
    groupPath: row.group_path,
    classification: row.classification as
      'customer' | 'vendor' | 'instrument' | 'other',
    gstin: row.gstin,
    openingBalance: row.opening_balance,
    plCode: row.pl_code,
    tallyIsDeleted: row.tally_is_deleted,
    nameAmbiguous: row.name_ambiguous,
    proposedContactId: row.proposed_contact_id,
    proposedContactName: row.proposed_contact_name,
    proposedContactMethod: row.proposed_contact_method as 'gstin' | 'name' | null,
    sourceFilename: row.source_filename,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    importedAt: new Date(row.created_at).toISOString(),
  };
}

/** Live contacts, for the GSTIN-then-name proposal. Retired contacts are
 * excluded for `imported-invoices.ts`'s reason: proposing a party the
 * organisation has since retired would revive it in every picker that
 * reads the join. */
async function candidateContacts(tx: TransactionSql): Promise<ContactCandidate[]> {
  const rows = await tx<{ id: string; designation: string; gstin: string | null }[]>`
    select id, designation, gstin from contacts where active
  `;
  return rows.map((row) => ({ id: row.id, name: row.designation, gstin: row.gstin }));
}

export function registerTallyMasterRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  malwareScanner: MalwareScanner,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  /* --- the census --------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/tally-masters/ledgers',
      schema: {
        querystring: TallyLedgerQuerySchema,
        response: { 200: TallyLedgerListSchema, ...errorResponses },
      },
      role: 'writer',
    },
    async ({ request, tenantSnapshot }) => {
      const query = request.query;
      return await tenantSnapshot(async (tx) => {
        // THE LATEST IMPORT IS THE CENSUS. Stated once, as a scalar
        // subquery both statements below compose, so the page and its
        // totals cannot end up describing two different exports. Null on
        // an empty census, where the `is null` arm admits everything and
        // there is nothing to admit.
        const latest = tx`(select max(last_seen_at) from tally_ledgers)`;

        // `date_asc` is the shared helper's name for "walk the key tuple
        // upwards", and the key tuple here is the ledger NAME. A census
        // is read alphabetically — an operator is looking for a party by
        // name, not for the most recently exported master — so the
        // ascending arm is taken always rather than offered as a `?sort`
        // nothing has asked for.
        const seek = registerKeyset('date_asc', query.cursor, {
          table: 'tally_ledgers',
          alias: 'l',
          columns: ['ledger_name', 'id'],
        });
        // The cursor is proven against the same table the rows come from,
        // and refused exactly as a nonexistent one is, so the census
        // cannot be used as an oracle.
        let cursor: string | null = null;
        if (seek.cursor !== undefined) {
          const [row] = await tx<{ id: string }[]>`
            select id from tally_ledgers where id = ${seek.cursor}
          `;
          if (!row) {
            throw httpError(
              400,
              'CURSOR_INVALID',
              'The pagination cursor does not name a row in this census.',
            );
          }
          cursor = row.id;
        }

        const limit = query.limit ?? PAGE_LIMIT;
        // One predicate, written once and composed into both statements.
        const filters = tx`
          (${query.includeSuperseded === true}
            or ${latest} is null or l.last_seen_at = ${latest})
          and (${query.classification ?? null}::text is null
               or l.classification = ${query.classification ?? null})
          and (${query.coded ?? null}::boolean is null
               or (l.pl_code is not null) = ${query.coded ?? null})
          and (${query.matched ?? null}::text is null
               or (l.classification in ('customer', 'vendor')
                   and (${query.matched ?? null} = 'matched')
                       = (l.proposed_contact_id is not null)))
          and (${query.search ?? null}::text is null
               or l.ledger_name ilike '%' || ${query.search ?? null} || '%')
        `;
        const rows = await tx<LedgerRow[]>`
          select ${tx.unsafe(LEDGER_COLUMNS)}
          from tally_ledgers l
          left join contacts c on c.id = l.proposed_contact_id
          where ${filters}
            and ${seek.predicate(tx, cursor)}
          order by ${tx.unsafe(seek.orderBy)}
          limit ${sqlLimit(limit)}
        `;
        // Totals over the WHOLE filtered census, and computed ONLY for
        // the first page: a request carrying a cursor is continuing a
        // walk whose totals the screen already has.
        const totalRows =
          cursor !== null
            ? []
            : await tx<
                {
                  ledger_count: number;
                  customer_count: number;
                  vendor_count: number;
                  instrument_count: number;
                  other_count: number;
                  proposed_contact_count: number;
                  unmatched_party_count: number;
                  coded_count: number;
                  distinct_code_count: number;
                  last_imported_at: string | null;
                  last_filename: string | null;
                }[]
              >`
                select count(*)::int as ledger_count,
                       count(*) filter (
                         where l.classification = 'customer')::int as customer_count,
                       count(*) filter (
                         where l.classification = 'vendor')::int as vendor_count,
                       count(*) filter (
                         where l.classification = 'instrument')::int as instrument_count,
                       count(*) filter (
                         where l.classification = 'other')::int as other_count,
                       count(l.proposed_contact_id)::int as proposed_contact_count,
                       count(*) filter (
                         where l.classification in ('customer', 'vendor')
                           and l.proposed_contact_id is null
                       )::int as unmatched_party_count,
                       count(l.pl_code)::int as coded_count,
                       count(distinct l.pl_code)::int as distinct_code_count,
                       max(l.last_seen_at)::text as last_imported_at,
                       -- The filename of the newest row, which is the file
                       -- the census currently describes.
                       (array_agg(l.source_filename order by l.last_seen_at desc)
                         )[1] as last_filename
                from tally_ledgers l
                where ${filters}
              `;
        // Counted OUTSIDE the filters, and deliberately: "how many rows
        // is the latest export no longer naming" is a question about the
        // whole census, and computing it inside a predicate that already
        // excludes them would answer zero every time.
        const [superseded] = await tx<{ count: number }[]>`
          select count(*)::int as count from tally_ledgers l
          where ${latest} is not null and l.last_seen_at < ${latest}
        `;
        const totals = totalRows[0] ?? null;
        const page = keysetPage(rows, limit, (row) => row.id);
        return {
          ledgers: page.rows.map(toLedger),
          nextCursor: seek.tag(page.nextCursor),
          totals:
            totals === null
              ? null
              : {
                  ledgerCount: totals.ledger_count,
                  customerCount: totals.customer_count,
                  vendorCount: totals.vendor_count,
                  instrumentCount: totals.instrument_count,
                  otherCount: totals.other_count,
                  proposedContactCount: totals.proposed_contact_count,
                  unmatchedPartyCount: totals.unmatched_party_count,
                  codedCount: totals.coded_count,
                  distinctCodeCount: totals.distinct_code_count,
                  lastImportedAt:
                    totals.last_imported_at === null
                      ? null
                      : new Date(totals.last_imported_at).toISOString(),
                  lastFilename: totals.last_filename,
                  supersededCount: superseded?.count ?? 0,
                },
        };
      });
    },
  );

  /* --- importing ---------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/tally-masters/import',
      schema: {
        querystring: TallyMasterUploadQuerySchema,
        response: { 200: TallyMasterImportResultSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
      bodyLimit: MAX_TALLY_UPLOAD_BYTES,
    },
    async ({ request, user, organisationId, tenant }) => {
      // AUTHORISE FIRST — before the format guard, not merely before the
      // scanner. An empty bound transaction runs the membership, role and
      // authority checks, so a stranger's 133 MB file never reaches the
      // scanner or the reader.
      //
      // The ORDER here is stricter than the Zoho importer's next door and
      // `test/route-inventory.integration.test.ts` is why: this format
      // HAS a signature, so `consumeUpload` refuses a wrong body with a
      // 400 — and a 400 where every other tenant route answers 403 tells
      // an unauthorised caller that the route exists. The Zoho importer
      // gets away with the other order only because a CSV has no
      // signature to fail. Authorising first makes the two
      // indistinguishable, which is what the census sweeps for.
      await tenant(() => Promise.resolve());

      const { bytes } = consumeUpload(request.body, {
        format: 'tally-xml',
        description: 'the TallyPrime All Masters export',
      });
      // STRIP FIRST, THEN TRIM, for `imports.ts`'s reason: the other order
      // lets a control character survive the blank check and then vanish,
      // leaving an untrimmed value for a CHECK to refuse as a 500.
      const filename = requireTrimmed(
        request.query.filename.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''),
        'Name the file being imported.',
      );

      await assertNotMalware(malwareScanner, bytes);

      let read;
      try {
        read = readTallyMasters(bytes);
      } catch (cause: unknown) {
        if (cause instanceof TallyMasterImportError) {
          // The two codes are written out as LITERALS rather than passed
          // through as `cause.code`, and `test/error-remedies.test.ts` is
          // why: it reads this server's source for the codes each route
          // can actually answer with, and a code that only ever appears
          // as a variable is invisible to it — which makes its remedy
          // look like advice about a refusal nothing throws.
          if (cause.code === 'TALLY_EXPORT_TRUNCATED') {
            throw httpError(400, 'TALLY_EXPORT_TRUNCATED', cause.message);
          }
          throw httpError(400, 'TALLY_EXPORT_UNREADABLE', cause.message);
        }
        throw cause;
      }
      if (read.ledgers.length === 0) {
        throw httpError(
          400,
          'TALLY_EXPORT_UNREADABLE',
          'That export declares no ledger masters. In TallyPrime, export All Masters rather than a single report.',
        );
      }

      const commit = request.query.mode === 'commit';
      const forced = request.query.force === true;
      return await tenant(async (tx) => {
        // ONE IMPORT PER ORGANISATION AT A TIME, and it refuses rather
        // than queues.
        //
        // Two imports of two different exports interleaving would write
        // rows from both under two different `now()` stamps, and the
        // census — which is defined as "the rows carrying the newest
        // stamp" — would then describe a file that never existed. Nor is
        // waiting the right answer: the second caller is holding a 133 MB
        // body, and queueing it behind a multi-second import doubles the
        // memory the server is committed to. `try` returns immediately
        // and the caller gets a named 409.
        //
        // Transaction-scoped, so it is released by the commit or the
        // rollback with nothing to unwind. The key is the organisation's
        // id hashed into the same bigint space `rate-limit.ts` uses for
        // its own advisory locks; the extra literal keeps this family from
        // ever colliding with that one.
        const [lock] = await tx<{ taken: boolean }[]>`
          select pg_try_advisory_xact_lock(
            hashtextextended(${`tally-masters:${organisationId}`}, 0)
          ) as taken
        `;
        if (lock?.taken !== true) {
          throw httpError(
            409,
            'TALLY_IMPORT_IN_PROGRESS',
            'Another Tally masters import is running for this organisation. Wait for it to finish, then read the file again.',
          );
        }

        const contacts = await candidateContacts(tx);
        // Indexed ONCE for the whole file rather than re-scanned per
        // ledger. `matchContact` filters the candidate array, which is
        // fine for one invoice and is 2,235 party ledgers times every
        // contact here — with a string normalisation inside the loop.
        const contactIndex = indexContacts(contacts);

        // What the census already holds for these GUIDs, so the report can
        // say what the import would ADD, REFRESH and LEAVE ALONE before
        // anything is written. Keyed on Tally's edit counter: a master
        // whose ALTERID has not moved has not been altered.
        //
        // `null` is preserved as null rather than coerced: the census may
        // hold a master whose export carried no counter, and that is not
        // the same as a counter of zero.
        const held = new Map<string, number | null>(
          (
            await tx<{ tally_guid: string; tally_alterid: string | null }[]>`
              select tally_guid, tally_alterid from tally_ledgers
              where tally_guid = any(${tx.array(
                read.ledgers.map((ledger) => ledger.guid),
              )}::text[])
            `
          ).map((row) => [
            row.tally_guid,
            row.tally_alterid === null ? null : Number(row.tally_alterid),
          ]),
        );

        // ROWS THE LATEST CENSUS HOLDS THAT THIS EXPORT DOES NOT NAME.
        //
        // Counted against the CURRENT latest import only, because that is
        // what the census screen shows and therefore what this number has
        // to describe. The first reading subtracted the matched GUIDs
        // from EVERY row in the table, which counted rows already
        // superseded by an EARLIER import a second time — so after two
        // shrinking imports the same missing master was reported twice
        // and nobody could tell that from two masters going missing.
        //
        // Read BEFORE anything writes, and computed ENTIRELY IN SQL. Both
        // halves are deliberate. Before, because on a commit every row
        // this import touches takes `now()` and `max(last_seen_at)` would
        // then be this import's own instant, making the answer trivially
        // zero. In SQL, because the obvious alternative — read the stamp
        // out, compare against it afterwards — does not survive the round
        // trip: the driver hands a timestamptz back as text and sends it
        // back as an untyped parameter, and the equality quietly stops
        // matching the row it was read from. Never leaving the database
        // is both simpler and the only version that is right.
        const [superseded] = await tx<{ count: number }[]>`
          select count(*)::int as count
          from tally_ledgers l
          where l.last_seen_at = (select max(last_seen_at) from tally_ledgers)
            and not (l.tally_guid = any(${tx.array(
              read.ledgers.map((ledger) => ledger.guid),
            )}::text[]))
        `;
        const supersededCount = superseded?.count ?? 0;

        const judged = read.ledgers.map((ledger) => ({
          ledger,
          contact: proposeContact(ledger, contactIndex),
        }));

        let newCount = 0;
        let updatedCount = 0;
        let unchangedCount = 0;
        let staleCount = 0;
        for (const { ledger } of judged) {
          if (!held.has(ledger.guid)) {
            newCount += 1;
            continue;
          }
          const heldAlterId = held.get(ledger.guid) ?? null;
          if (heldAlterId === ledger.alterId) {
            unchangedCount += 1;
            continue;
          }
          // UNKNOWN EITHER SIDE IS NOT A REGRESSION. Only two real
          // counters can be compared, which is the same rule 0118's guard
          // keeps — stated in both places because the preview has to
          // predict exactly what the commit will do.
          if (
            heldAlterId !== null &&
            ledger.alterId !== null &&
            ledger.alterId < heldAlterId
          ) {
            staleCount += 1;
          }
          updatedCount += 1;
        }

        // THE PREVIEW AND THE COMMIT AGREE, which is the whole promise of
        // reading the file twice. Refused here rather than left to 0118's
        // guard so the operator gets the count, the remedy and the
        // override in one sentence instead of a 409 naming one row.
        if (commit && staleCount > 0 && !forced) {
          throw httpError(
            409,
            'TALLY_EXPORT_STALE',
            `${String(staleCount)} master(s) in this export carry an older Tally edit counter than the census already holds, so this is an older export than the one already imported. Import the current export instead — or, if a Tally backup was restored and this file is the current one, re-run the import with the override.`,
          );
        }
        if (commit && forced) {
          // Transaction-local, so it is gone at commit or rollback and
          // cannot leak into another statement. 0118's guard reads it.
          await tx`select set_config('app.tally_force', 'on', true)`;
        }

        let importedCount = 0;
        if (commit) {
          // ONE STATEMENT for 4,327 rows. A per-ledger loop inside a
          // transaction is what `test/query-write-loop-census.test.ts`
          // exists to prevent, and there is nothing to isolate: the
          // conflict arm is the whole point of the write.
          //
          // The column list is the keys of the row objects rather than a
          // written-out spread, for `imported-invoices.ts`'s reason —
          // every row is built by the same expression, so every row has
          // the same keys, and each value is explicit rather than
          // omitted.
          //
          // ON CONFLICT DO UPDATE, not DO NOTHING, and migration 0118's
          // header argues it: this census mirrors a file the organisation
          // is still editing, and a second import that skipped every
          // master Tally has altered would leave the census describing an
          // export nobody uses any more.
          const rows = judged.map(({ ledger, contact }) => ({
            organisation_id: organisationId,
            tally_guid: ledger.guid,
            tally_alterid: ledger.alterId,
            ledger_name: ledger.name,
            parent_group: ledger.parentGroup,
            group_path: ledger.groupPath as string[],
            classification: ledger.classification,
            gstin: ledger.gstin,
            opening_balance: ledger.openingBalance,
            pl_code: ledger.plCode,
            tally_is_deleted: ledger.isDeleted,
            name_ambiguous: ledger.nameAmbiguous,
            proposed_contact_id: contact?.contactId ?? null,
            proposed_contact_method: contact?.method ?? null,
            source_fields: tx.json(ledger.sourceFields as never),
            source_filename: filename,
            imported_by_user_id: user.id,
          }));
          // Chunked, because the driver builds one placeholder per value
          // and 4,327 rows times seventeen columns is well past what one
          // statement should carry. Sized so a chunk is a few thousand
          // placeholders — the same order every bulk write here uses.
          const CHUNK = 500;
          for (let index = 0; index < rows.length; index += CHUNK) {
            const written = await tx<{ id: string }[]>`
              insert into tally_ledgers ${tx(rows.slice(index, index + CHUNK))}
              on conflict (organisation_id, tally_guid) do update set
                tally_alterid = excluded.tally_alterid,
                ledger_name = excluded.ledger_name,
                parent_group = excluded.parent_group,
                group_path = excluded.group_path,
                classification = excluded.classification,
                gstin = excluded.gstin,
                opening_balance = excluded.opening_balance,
                pl_code = excluded.pl_code,
                tally_is_deleted = excluded.tally_is_deleted,
                name_ambiguous = excluded.name_ambiguous,
                proposed_contact_id = excluded.proposed_contact_id,
                proposed_contact_method = excluded.proposed_contact_method,
                source_fields = excluded.source_fields,
                source_filename = excluded.source_filename,
                -- now() is this transaction's timestamp, so every row one
                -- import touches carries the SAME instant. That is what
                -- makes "the latest census" an equality rather than a
                -- window, and it is why a superseded row can be found
                -- without a flag anybody has to maintain.
                last_seen_at = now()
              returning id
            `.catch(rethrowWriteRefusal);
            importedCount += written.length;
          }

          // ONE AUDIT EVENT FOR THE IMPORT, not one per ledger. A census
          // row is not a document somebody filed — 4,327 audit events per
          // import would bury the timeline that answers what a person
          // did. The file, the counts and the classes are the act.
          //
          // `forced` rides in the payload because it is the whole point
          // of the override being explicit: "on this date a named member
          // accepted an export whose counters had gone backwards" is the
          // sentence somebody will need afterwards.
          await audit(
            tx,
            organisationId,
            user.id,
            'tally_ledger.imported',
            'tally_ledgers',
            null,
            {
              filename,
              ledgerCount: read.ledgers.length,
              groupCount: read.groupCount,
              newCount,
              updatedCount,
              unchangedCount,
              staleCount,
              forced,
              refusalCount: read.refusals.length,
              proposedContactCount: judged.filter(({ contact }) => contact !== null)
                .length,
            },
          );
        }

        const byRootGroup = new Map<string, number>();
        for (const { ledger } of judged) {
          const root = ledger.groupPath[0] ?? '(no group)';
          byRootGroup.set(root, (byRootGroup.get(root) ?? 0) + 1);
        }
        const partyCount = judged.filter(
          ({ ledger }) =>
            ledger.classification === 'customer' || ledger.classification === 'vendor',
        ).length;
        const proposedContactCount = judged.filter(
          ({ contact }) => contact !== null,
        ).length;

        return {
          mode: request.query.mode,
          filename,
          forced,
          ledgerCount: read.ledgers.length,
          groupCount: read.groupCount,
          newCount,
          updatedCount,
          unchangedCount,
          staleCount,
          supersededCount,
          customerCount: judged.filter(
            ({ ledger }) => ledger.classification === 'customer',
          ).length,
          vendorCount: judged.filter(({ ledger }) => ledger.classification === 'vendor')
            .length,
          instrumentCount: judged.filter(
            ({ ledger }) => ledger.classification === 'instrument',
          ).length,
          otherCount: judged.filter(({ ledger }) => ledger.classification === 'other')
            .length,
          gstinCount: judged.filter(({ ledger }) => ledger.gstin !== null).length,
          codedCount: judged.filter(({ ledger }) => ledger.plCode !== null).length,
          distinctCodeCount: new Set(
            judged
              .map(({ ledger }) => ledger.plCode)
              .filter((code): code is string => code !== null),
          ).size,
          proposedContactCount,
          unmatchedPartyCount: partyCount - proposedContactCount,
          ambiguousCodeCount: read.ambiguousCodeCount,
          malformedGstinCount: read.malformedGstinCount,
          duplicateNameCount: read.duplicateNameCount,
          importedCount,
          byRootGroup: [...byRootGroup]
            .sort((left, right) => right[1] - left[1])
            .map(([rootGroup, ledgerCount]) => ({ rootGroup, ledgerCount })),
          refusals: read.refusals.map((refusal) => ({ ...refusal })),
        };
      });
    },
  );
}
