import {
  SearchQuerySchema,
  SearchResponseSchema,
  type SearchGroup,
  type SearchResult,
  type SearchResultKind,
} from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { Auth } from '../auth.js';
import { hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { errorResponses } from './shared.js';
import type { AppInstance } from '../app-instance.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';

/**
 * Tenant-wide record search — the endpoint behind the header control that
 * has always been labelled "Search Works and records" while only ever
 * navigating to the Works register.
 *
 * ## Tenancy
 *
 * Every query below runs inside the membership-bound transaction and names
 * no organisation id, exactly like the rest of the codebase: the RLS
 * policy on each register pins rows to
 * `app_private.current_organisation_id()`, which itself returns NULL
 * unless the bound user holds an ACTIVE membership in the bound
 * organisation. Adding an explicit `organisation_id = …` predicate here
 * would not make it safer and would make the boundary look like a
 * per-query convention that a future query could forget. The boundary is
 * the transaction.
 *
 * ## Work scope
 *
 * A membership with `work_scope = 'assigned'` sees only its assigned
 * Works, so every Work-bound register carries the same assignment filter
 * the Works listing uses. This matters more here than in a single-record
 * route: a search that leaked one row would leak the existence of a Work
 * the member was deliberately not assigned to, and the document number in
 * that row would be enough to guess at.
 *
 * Two registers legitimately stand outside a Work and are therefore
 * visible to every member of the organisation:
 *
 * - **Budgetary quotations** have no `work_id` column at all — an offer
 *   precedes the award. This matches the quotation listing's own rule.
 * - **Direct tax invoices and their credit notes** carry a NULL
 *   `work_id`: they are raised against a private customer with no works
 *   contract behind them. A Work-scoped member sees those, and Work-bound
 *   documents only for their own Works — the same rule the credit-note
 *   listing already applies.
 *
 * ## What is not here
 *
 * Serial numbers have their own module with a much richer per-serial
 * answer (delivery, receipt and installation lineage). Reproducing a
 * thinner version of that here would be a second, worse answer to the same
 * question, so the web client links into that module instead.
 *
 * Measurement Books carry no title, party or description — only a number
 * and a date — and their numbers already surface on the invoices that cite
 * them.
 */

/**
 * Per-register cap. Deliberately small: this answers a header control, and
 * a clerk who sees ten hits in a register refines the query rather than
 * scrolling. One extra row is fetched to detect truncation without a
 * second counting scan over seven registers.
 */
const GROUP_LIMIT = 10;

/** The order groups are returned in — most-used register first. */
const GROUP_ORDER: readonly SearchResultKind[] = [
  'work',
  'delivery-challan',
  'issue-challan',
  'tax-invoice',
  'credit-note',
  'purchase-order',
  'quotation',
];

/** LIKE/ILIKE treat %, _ and the escape character specially; the user's
 * text is a literal substring, so all three are escaped (backslash is
 * PostgreSQL's default escape character). Same helper as the serial
 * lookup — without it, a query of `%` would return every row in the
 * organisation. */
function escapeLikePattern(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** One raw row, uniform across the registers so the mapping stays in one
 * place rather than seven. */
interface RegisterRow {
  readonly id: string;
  readonly label: string | null;
  readonly detail: string | null;
  readonly status: string;
  readonly date: string | null;
  readonly work_id: string | null;
  readonly work_code: string | null;
}

/** The label a draft carries before it has a number. Naming the register
 * and the party is more use than an empty cell, and it can never be
 * mistaken for an issued document's number. */
function draftLabel(kind: SearchResultKind): string {
  switch (kind) {
    case 'delivery-challan':
      return 'Delivery Challan (draft)';
    case 'issue-challan':
      return 'Issue Challan (draft)';
    case 'tax-invoice':
      return 'Tax invoice (draft)';
    case 'credit-note':
      return 'Credit note (draft)';
    case 'purchase-order':
      return 'Purchase order (draft)';
    case 'quotation':
      return 'Quotation (draft)';
    case 'work':
      return 'Work';
  }
}

function toGroup(kind: SearchResultKind, rows: readonly RegisterRow[]): SearchGroup {
  return {
    kind,
    truncated: rows.length > GROUP_LIMIT,
    results: rows.slice(0, GROUP_LIMIT).map((row): SearchResult => ({
      kind,
      id: row.id,
      label: row.label ?? draftLabel(kind),
      detail: row.detail ?? '—',
      status: row.status,
      date: row.date,
      workId: row.work_id,
      workCode: row.work_code,
    })),
  };
}

export function registerSearchRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/search',
      schema: {
        querystring: SearchQuerySchema,
        response: { 200: SearchResponseSchema, ...errorResponses },
      },
    },
    // No role is declared: reading the registers a member can already list
    // is not a privileged act, and a viewer who cannot find a document
    // cannot do the reading the role exists for.
    async ({ request, user, tenant }) => {
      const query = request.query.q.trim();
      if (query.length < 2) {
        throw httpError(
          400,
          'SEARCH_QUERY_TOO_SHORT',
          'Enter at least two characters to search.',
        );
      }
      const pattern = `%${escapeLikePattern(query)}%`;

      // REPEATABLE READ: seven register reads in sequence. Under READ
      // COMMITTED a document issued midway could appear in one group with
      // a number and be absent from a related group, which reads as data
      // loss to a clerk checking one document across registers.
      return tenant(async (tx) => {
        const full = await hasFullWorkScope(tx, user.id);
        const groups: SearchGroup[] = [];
        for (const kind of GROUP_ORDER) {
          const rows = await searchRegister(tx, kind, pattern, user.id, full);
          if (rows.length > 0) groups.push(toGroup(kind, rows));
        }
        return {
          query,
          groups,
          returned: groups.reduce((total, group) => total + group.results.length, 0),
        };
      });
    },
  );
}

async function searchRegister(
  tx: TransactionSql,
  kind: SearchResultKind,
  pattern: string,
  userId: string,
  full: boolean,
): Promise<RegisterRow[]> {
  switch (kind) {
    case 'work':
      // Matched on what a clerk actually knows: the Work code, the LOA
      // letter number, or words from the name of work. Soft-deleted Works
      // are excluded, as everywhere else.
      return tx<RegisterRow[]>`
        select w.id, w.work_code as label, w.title as detail, w.status,
               null::text as date, w.id as work_id, w.work_code
        from works w
        where w.deleted_at is null
          and (
            w.work_code ilike ${pattern}
            or w.title ilike ${pattern}
            or w.letter_number ilike ${pattern}
          )
          and (${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = w.id and wa.user_id = ${userId}
          ))
        order by w.created_at desc, w.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'delivery-challan':
      // The consignee snapshot is written at draft creation and is NOT
      // NULL, so a draft is findable by the party it is going to as well
      // as by the number it does not have yet.
      return tx<RegisterRow[]>`
        select dc.id, dc.challan_number as label,
               coalesce(
                 dc.consignee_snapshot->>'designation',
                 dc.consignee_snapshot->>'name'
               ) as detail,
               dc.status, dc.challan_date::text as date,
               dc.work_id, w.work_code
        from delivery_challans dc
        join works w on w.id = dc.work_id
        where w.deleted_at is null
          and (
            dc.challan_number ilike ${pattern}
            or dc.consignee_snapshot->>'designation' ilike ${pattern}
            or dc.consignee_snapshot->>'name' ilike ${pattern}
          )
          and (${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = dc.work_id and wa.user_id = ${userId}
          ))
        order by dc.challan_date desc, dc.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'issue-challan':
      return tx<RegisterRow[]>`
        select ic.id, ic.challan_number as label,
               ic.issued_to_name as detail,
               ic.status, ic.challan_date::text as date,
               ic.work_id, w.work_code
        from issue_challans ic
        join works w on w.id = ic.work_id
        where w.deleted_at is null
          and (
            ic.challan_number ilike ${pattern}
            or ic.issued_to_name ilike ${pattern}
            or ic.location ilike ${pattern}
          )
          and (${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = ic.work_id and wa.user_id = ${userId}
          ))
        order by ic.challan_date desc, ic.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'tax-invoice':
      // The buyer snapshot is frozen at submit, so a DRAFT invoice has
      // none: fall back to the live buyer contact, which the draft is
      // required to name. Preferring the snapshot where it exists keeps a
      // submitted invoice findable under the name it was actually issued
      // to, even after the master was edited.
      return tx<RegisterRow[]>`
        select ti.id, ti.invoice_number as label,
               coalesce(
                 ti.buyer_snapshot->>'designation', c.designation
               ) as detail,
               ti.status, ti.invoice_date::text as date,
               ti.work_id, w.work_code
        from tax_invoices ti
        left join works w on w.id = ti.work_id and w.deleted_at is null
        left join contacts c on c.id = ti.buyer_contact_id
        where (
            ti.invoice_number ilike ${pattern}
            or ti.service_description ilike ${pattern}
            or ti.irn ilike ${pattern}
            or ti.buyer_snapshot->>'designation' ilike ${pattern}
            or c.designation ilike ${pattern}
          )
          and (
            ${full}
            or ti.work_id is null
            or exists (
              select 1 from work_assignments wa
              where wa.work_id = ti.work_id and wa.user_id = ${userId}
            )
          )
        order by ti.invoice_date desc, ti.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'credit-note':
      return tx<RegisterRow[]>`
        select cn.id, cn.note_number as label, cn.reason as detail,
               cn.status, cn.note_date::text as date,
               cn.work_id, w.work_code
        from credit_notes cn
        left join works w on w.id = cn.work_id and w.deleted_at is null
        where (
            cn.note_number ilike ${pattern}
            or cn.reason ilike ${pattern}
            or cn.irn ilike ${pattern}
          )
          and (
            ${full}
            or cn.work_id is null
            or exists (
              select 1 from work_assignments wa
              where wa.work_id = cn.work_id and wa.user_id = ${userId}
            )
          )
        order by cn.note_date desc, cn.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'purchase-order':
      return tx<RegisterRow[]>`
        select po.id, po.po_number as label,
               coalesce(
                 po.vendor_snapshot->>'designation', c.designation
               ) as detail,
               po.status, po.po_date::text as date,
               po.work_id, w.work_code
        from purchase_orders po
        join works w on w.id = po.work_id
        left join contacts c on c.id = po.vendor_contact_id
        where w.deleted_at is null
          and (
            po.po_number ilike ${pattern}
            or po.vendor_snapshot->>'designation' ilike ${pattern}
            or c.designation ilike ${pattern}
          )
          and (${full} or exists (
            select 1 from work_assignments wa
            where wa.work_id = po.work_id and wa.user_id = ${userId}
          ))
        order by po.po_date desc, po.id
        limit ${GROUP_LIMIT + 1}
      `;
    case 'quotation':
      // No work_scope filter and no join to works: a budgetary quotation
      // has no work_id at all — the offer precedes the award — so every
      // member of the organisation sees the organisation's offers. Same
      // rule as the quotation listing itself.
      return tx<RegisterRow[]>`
        select bq.id, bq.bq_number as label,
               coalesce(bq.subject, bq.addressed_to) as detail,
               bq.status, bq.bq_date::text as date,
               null::uuid as work_id, null::text as work_code
        from budgetary_quotations bq
        where bq.bq_number ilike ${pattern}
          or bq.addressed_to ilike ${pattern}
          or bq.subject ilike ${pattern}
        order by bq.bq_date desc, bq.id
        limit ${GROUP_LIMIT + 1}
      `;
  }
}
