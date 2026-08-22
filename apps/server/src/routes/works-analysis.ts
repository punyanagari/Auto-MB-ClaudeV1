import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { ObjectStorage } from '@auto-mb/documents';
import {
  DivisionAnalysisResponseSchema,
  ItemGroupProposalsResponseSchema,
  MappedItemAnalysisQuerySchema,
  MappedItemAnalysisResponseSchema,
  defaultWorksAnalysisColumns,
  WORKS_ANALYSIS_REPORTS,
  WorkAnalysisResponseSchema,
  WorksAnalysisDocumentQuerySchema,
  WorksAnalysisOptionsResponseSchema,
  type CombinedPendingTotals,
  type DivisionAnalysisResponse,
  type ItemGroupProposalsResponse,
  type MappedItemAnalysisResponse,
  type WorkAnalysisResponse,
  type WorksAnalysisDocumentQuery,
  type WorksAnalysisOptionsResponse,
  type WorksAnalysisReport,
} from '@auto-mb/contracts';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { assertWorkAccess, hasFullWorkScope } from '../authz.js';
import { httpError } from '../http.js';
import { renderPdfViaGotenberg } from '../pdf-render.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  readDivisionAnalysis,
  readItemGroupProposals,
  readMappedItemAnalysis,
  readWorkAnalysis,
  readWorksAnalysisOptions,
} from '../works-analysis.js';
import {
  renderWorksAnalysisHtml,
  selectColumns,
  toDivisionDocument,
  toMappedItemDocument,
  toWorkDocument,
  worksAnalysisSheet,
  type AnalysisDocument,
} from '../works-analysis-document.js';
import { buildXlsx, XLSX_MEDIA_TYPE } from '../xlsx.js';
import { audit, errorResponses, upstreamErrorResponses } from './shared.js';

/**
 * Works analysis: three reports, on screen, as a PDF, and as a workbook.
 *
 * `packages/contracts/src/works-analysis.ts` states what the figures mean
 * and `src/works-analysis.ts` computes them. This file is the HTTP surface,
 * and it is deliberately six routes rather than nine: the two document
 * routes take the report NAME as a parameter, exactly as
 * `/api/registers/:register/workbook.xlsx` does, so a fourth report is one
 * descriptor here and one entry in the contract rather than a new endpoint,
 * a new schema and a new client method.
 *
 * ## Scope
 *
 * The portfolio reports NARROW to the caller's assignments rather than
 * refusing an assigned-scope member, and they say so on the document. That
 * differs from the management summary beside them, which refuses: a summary
 * of a slice of the portfolio is a management summary that is wrong, while
 * "what is still pending on the Works I run" is a complete and useful
 * answer to a real question. The per-Work report goes through
 * `assertWorkAccess`, so an assigned member reads their own Works and a
 * guessed id answers 404 rather than confirming the Work exists.
 */

const ReportParamsSchema = Type.Object(
  {
    report: Type.Union(WORKS_ANALYSIS_REPORTS.map((name) => Type.Literal(name))),
  },
  { additionalProperties: false },
);

const WorkParamsSchema = Type.Object(
  { workId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

/** The filename stem and sheet name per report. The `Record` is TOTAL over
 * the contract's union, so a report added there without an entry here fails
 * to compile rather than 404ing at runtime. */
const DOCUMENTS: Readonly<
  Record<WorksAnalysisReport, { sheet: string; stem: string }>
> = {
  work: { sheet: 'Work analysis', stem: 'work-analysis' },
  division: { sheet: 'Division analysis', stem: 'division-analysis' },
  'mapped-item': { sheet: 'Item analysis', stem: 'item-analysis' },
};

/** The sentence an assigned-scope reader needs on a portfolio report, and
 * that a full-scope reader needs to NOT see. A report that silently covered
 * a slice would be read as covering the organisation. */
function scopeNote(fullScope: boolean): string {
  return fullScope
    ? 'This report covers every active Work in the organisation.'
    : 'This report covers only the Works you are assigned to. It is not the organisation’s whole position.';
}

/**
 * The scope sentence goes in `scope`, not into the notes.
 *
 * `docs/UX.md` § 38 promises the reader is told which scope produced the
 * file. A sentence buried under the footnotes of a landscape page nobody
 * scrolls to does not keep that promise: the failure it exists to prevent
 * is a narrowed report being read as the organisation's whole position, and
 * that misreading happens at the top of page one. Both renderers print
 * `scope` directly under the header, above the first table.
 */
function withScope(document: AnalysisDocument, scope: string): AnalysisDocument {
  return { ...document, scope };
}

/**
 * The document under the operator's chosen columns.
 *
 * Absent parameter means every column, which is what a hand-typed URL and
 * every existing caller mean by saying nothing. An EMPTY value is not the
 * same request and is not treated as one — it would produce a page of
 * nothing but identity columns — so it falls back to the report's own
 * defaults rather than to a blank sheet.
 */
function withColumns(
  document: AnalysisDocument,
  report: WorksAnalysisReport,
  columns: string | undefined,
): AnalysisDocument {
  if (columns === undefined) return document;
  const chosen = columns
    .split(',')
    .map((header) => header.trim())
    .filter((header) => header.length > 0);
  return selectColumns(
    document,
    report,
    new Set(chosen.length > 0 ? chosen : defaultWorksAnalysisColumns(report)),
  );
}

/**
 * The division report narrowed to one heading.
 *
 * Filtered on the RESPONSE rather than in SQL: the read already groups
 * every division in one pass, the narrowing is a display choice the
 * operator makes after seeing the list, and a second query shape would be
 * a second place for the division derivation to be wrong. A code that
 * matches nothing yields an empty document rather than a 404 — the honest
 * answer to "what is pending in this division" can be "nothing".
 *
 * `none` addresses the Works whose consignees name no division or name
 * more than one. A real code cannot collide with it: a railway division
 * code is `^[0-9]{2,5}$` on the contact that carries it.
 *
 * The report-wide totals become the CHOSEN division's own. Nothing is
 * added up here — with one division on the page the two figures are the
 * same figure, and leaving the portfolio total under a single division's
 * rows would print a total the rows do not add to, which is § 38's own
 * "two tables, two totals" rule.
 */
const NO_DIVISION = 'none';

const EMPTY_TOTALS: CombinedPendingTotals = {
  rowCount: 0,
  mappedRowCount: 0,
  lineCount: 0,
  pendingSupplyValue: '0.00',
  pendingInstallValue: '0.00',
};

function narrowDivisions(
  analysis: DivisionAnalysisResponse,
  division: string | undefined,
): DivisionAnalysisResponse {
  if (division === undefined) return analysis;
  const divisions = analysis.divisions.filter(
    (entry) => (entry.divisionCode ?? NO_DIVISION) === division,
  );
  return { divisions, totals: divisions[0]?.totals ?? EMPTY_TOTALS };
}

export function registerWorksAnalysisRoutes(
  app: AppInstance,
  auth: Auth,
  database: Sql,
  storage: ObjectStorage,
  gotenbergUrl: string,
): void {
  const tenantRoute = createTenantRouteRegistrar(app, auth, database);

  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/work-analysis/:workId',
      schema: {
        params: WorkParamsSchema,
        response: { 200: WorkAnalysisResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, organisationId, tenant }): Promise<WorkAnalysisResponse> =>
      tenant(async (tx) => {
        const { workId } = request.params;
        await assertWorkAccess(tx, user.id, workId);
        const analysis = await readWorkAnalysis(tx, workId, organisationId);
        if (analysis === null) {
          throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
        }
        return analysis;
      }),
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/division-analysis',
      schema: {
        response: { 200: DivisionAnalysisResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }): Promise<DivisionAnalysisResponse> =>
      tenant(async (tx) =>
        readDivisionAnalysis(tx, await hasFullWorkScope(tx, user.id), user.id),
      ),
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/mapped-item-analysis',
      schema: {
        querystring: MappedItemAnalysisQuerySchema,
        response: { 200: MappedItemAnalysisResponseSchema, ...errorResponses },
      },
    },
    async ({ request, user, tenant }): Promise<MappedItemAnalysisResponse> =>
      tenant(async (tx) =>
        /* `item` narrows to one item group, AFTER the scope flag is read
           and inside the organisation-scoped transaction — it chooses
           among rows the caller may already see and can therefore neither
           widen the read nor reach another tenant's. Same shape as the
           division parameter on the document routes below. */
        readMappedItemAnalysis(
          tx,
          await hasFullWorkScope(tx, user.id),
          user.id,
          request.query.item,
        ),
      ),
  );

  /**
   * What the two portfolio reports can be narrowed to, before either is
   * run.
   *
   * One read for both pickers rather than two endpoints: the analysis tab
   * needs the division headings and the item groups at the same moment —
   * the operator has not yet said which report they want — and a screen
   * that made two round trips to draw two dropdowns would be answering the
   * same question twice. Narrows to the caller's assignments exactly as
   * the reports do.
   */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/analysis/options',
      schema: {
        response: { 200: WorksAnalysisOptionsResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }): Promise<WorksAnalysisOptionsResponse> =>
      tenant(async (tx) =>
        readWorksAnalysisOptions(tx, await hasFullWorkScope(tx, user.id), user.id),
      ),
  );

  /**
   * The proposed item groups.
   *
   * A READ, and that is the whole design: it writes nothing, holds nothing,
   * and expires the moment the descriptions change. Confirming a proposal is
   * `POST /api/masters/canonical-items` with the proposed name and the other
   * wordings as aliases — the control the item master already has, which is
   * also what makes a confirmed group persist and start combining in the
   * report above. There is deliberately no table of half-agreed groups and
   * no third state between "proposed" and "in the item master".
   */
  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/item-group-proposals',
      schema: {
        response: { 200: ItemGroupProposalsResponseSchema, ...errorResponses },
      },
    },
    async ({ user, tenant }): Promise<ItemGroupProposalsResponse> =>
      tenant(async (tx) =>
        readItemGroupProposals(tx, await hasFullWorkScope(tx, user.id), user.id),
      ),
  );

  /**
   * One report as a document.
   *
   * Both the PDF and the workbook build the SAME `AnalysisDocument`, so the
   * two files carry identical figures under identical headings. A reader who
   * prints a report and exports it must not have to reconcile them.
   */
  async function buildDocument(
    tx: TransactionSql,
    report: WorksAnalysisReport,
    userId: string,
    organisationId: string,
    query: WorksAnalysisDocumentQuery,
  ): Promise<{ document: AnalysisDocument; suffix: string }> {
    const { workId } = query;
    const full = await hasFullWorkScope(tx, userId);
    if (report === 'work') {
      if (workId === undefined) {
        throw httpError(
          400,
          'WORK_REQUIRED',
          'The Work analysis is about one Work; name it with workId.',
        );
      }
      await assertWorkAccess(tx, userId, workId);
      const analysis = await readWorkAnalysis(tx, workId, organisationId);
      if (analysis === null) throw httpError(404, 'WORK_NOT_FOUND', 'No such Work.');
      return {
        // A per-Work report is about ONE named Work, so the portfolio scope
        // sentence would say nothing: the reader asked for this Work and
        // got this Work.
        document: withColumns(toWorkDocument(analysis), report, query.columns),
        suffix: `-${analysis.work.workCode.replaceAll('/', '-')}`,
      };
    }
    if (workId !== undefined) {
      throw httpError(
        400,
        'WORK_NOT_APPLICABLE',
        'This report covers the whole portfolio and is not about one Work.',
      );
    }
    if (query.division !== undefined && report !== 'division') {
      throw httpError(
        400,
        'DIVISION_NOT_APPLICABLE',
        'Only the division analysis is grouped by railway division.',
      );
    }
    if (query.item !== undefined && report !== 'mapped-item') {
      throw httpError(
        400,
        'ITEM_NOT_APPLICABLE',
        'Only the item analysis is grouped by item.',
      );
    }
    const document =
      report === 'division'
        ? toDivisionDocument(
            narrowDivisions(
              await readDivisionAnalysis(tx, full, userId),
              query.division,
            ),
          )
        : toMappedItemDocument(
            // The item narrowing is the READ's, not a second filter here:
            // it is the same function the screen calls, so the file and
            // the screen carry one item's rows AND one item's totals.
            await readMappedItemAnalysis(tx, full, userId, query.item),
          );
    return {
      document: withColumns(
        withScope(document, scopeNote(full)),
        report,
        query.columns,
      ),
      suffix: '',
    };
  }

  tenantRoute(
    {
      method: 'GET',
      // The extension is its OWN segment: `:report.pdf` reads to the router
      // as one segment named `report.pdf`, which no params schema can name.
      url: '/api/reports/analysis/:report/report.xlsx',
      schema: {
        params: ReportParamsSchema,
        querystring: WorksAnalysisDocumentQuerySchema,
        response: { ...errorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { report } = request.params;
      const descriptor = DOCUMENTS[report];
      const { bytes, suffix } = await tenant(async (tx) => {
        const built = await buildDocument(
          tx,
          report,
          user.id,
          organisationId,
          request.query,
        );
        const sheet = worksAnalysisSheet(built.document);
        await audit(
          tx,
          organisationId,
          user.id,
          'works_analysis.exported',
          'organisations',
          organisationId,
          { report, format: 'xlsx', rows: sheet.rows.length },
        );
        return {
          suffix: built.suffix,
          bytes: buildXlsx(descriptor.sheet, sheet.columns, sheet.rows),
        };
      });
      void reply.type(XLSX_MEDIA_TYPE);
      void reply.header(
        'content-disposition',
        `attachment; filename="${descriptor.stem}${suffix}.xlsx"`,
      );
      return reply.send(bytes);
    },
  );

  tenantRoute(
    {
      method: 'GET',
      url: '/api/reports/analysis/:report/report.pdf',
      schema: {
        params: ReportParamsSchema,
        querystring: WorksAnalysisDocumentQuerySchema,
        response: { ...upstreamErrorResponses },
      },
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      const { report } = request.params;
      const descriptor = DOCUMENTS[report];
      const { document, suffix, branding } = await tenant(async (tx) => {
        const built = await buildDocument(
          tx,
          report,
          user.id,
          organisationId,
          request.query,
        );
        const [organisation] = await tx<
          {
            address: string | null;
            gstin: string | null;
            contact_phone: string | null;
            contact_email: string | null;
            logo_object_key: string | null;
            logo_media_type: string | null;
          }[]
        >`
          select address, gstin, contact_phone, contact_email,
                 logo_object_key, logo_media_type
          from organisations
          where id = app_private.current_organisation_id()
        `;
        await audit(
          tx,
          organisationId,
          user.id,
          'works_analysis.exported',
          'organisations',
          organisationId,
          { report, format: 'pdf' },
        );
        return { ...built, branding: organisation ?? null };
      });

      let logoDataUri: string | undefined;
      if (branding?.logo_object_key != null && branding.logo_media_type != null) {
        try {
          const logo = await storage.get(branding.logo_object_key);
          logoDataUri = `data:${branding.logo_media_type};base64,${logo.toString('base64')}`;
        } catch (error) {
          // A missing logo must not block a report; it is branding, not
          // content, and the figures are the reason the page exists.
          request.log.warn({ err: error }, 'works analysis: logo unavailable');
        }
      }
      const html = renderWorksAnalysisHtml(document, {
        ...(logoDataUri !== undefined ? { logoDataUri } : {}),
        address: branding?.address ?? null,
        gstin: branding?.gstin ?? null,
        contactPhone: branding?.contact_phone ?? null,
        contactEmail: branding?.contact_email ?? null,
      });
      const pdf = await renderPdfViaGotenberg(gotenbergUrl, html, {
        // A report reads the ledgers and writes nothing, so there is no
        // document to reassure the caller about — only the fact that
        // retrying is safe and costs nothing.
        failureMessage:
          'The PDF service is unavailable; nothing was changed — retry later, or take the workbook instead.',
        logError: (error) => {
          request.log.error({ err: error }, 'works analysis render failed');
        },
      });
      void reply.type('application/pdf');
      void reply.header(
        'content-disposition',
        `inline; filename="${descriptor.stem}${suffix}.pdf"`,
      );
      return reply.send(pdf);
    },
  );
}
