import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelImportBatchSchema,
  type ErrorCode,
  ImportBatchDetailSchema,
  ImportBatchListSchema,
  ImportRowsQuerySchema,
  ImportUploadQuerySchema,
  KeysetQuerySchema,
  withKeysetQuery,
} from '@auto-mb/contracts';
import { Type } from '@sinclair/typebox';
import type { Sql, TransactionSql } from '@auto-mb/db';
import type { AppInstance } from '../app-instance.js';
import type { Auth } from '../auth.js';
import { httpError } from '../http.js';
import {
  IMPORT_TARGETS,
  templateRows,
  type BuiltRow,
  type DuplicateContext,
  type ImportTarget,
  type RowError,
  type TargetColumn,
} from '../import-targets.js';
import { headerKey } from '../csv.js';
import type { MalwareScanner } from '../malware-scan.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_XLSX_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import {
  XLSX_MEDIA_TYPE,
  XlsxParseError,
  readXlsxRows,
  writeXlsxWorkbook,
  type SheetRow,
} from '../xlsx.js';
import {
  audit,
  errorResponses,
  requireTrimmed,
  upstreamErrorResponses,
  writeRefusals,
} from './shared.js';

/**
 * Bringing a register in from a spreadsheet (migration 0094).
 *
 * ## The shape of the feature, in three calls
 *
 * `POST /api/imports` takes the workbook bytes and answers with a batch
 * whose every row already carries a verdict. `GET /api/imports/:id` reads
 * that back. `POST /api/imports/:id/import` is the only call that writes
 * to a live register, and until it is made the upload has changed
 * nothing an operator can see anywhere else in the product.
 *
 * That separation is the feature. An import is not a button that either
 * works or does not; it is a conversation about which eleven rows are
 * wrong, and a pipeline that writes as it reads cannot have it.
 *
 * ## Validation happens twice, deliberately
 *
 * Once at upload, to produce a verdict a person can read, and again at
 * the commit, against the register as it is at that moment. The second
 * pass is not paranoia: minutes or days pass between the two, and a
 * contact somebody added by hand in between makes a row that validated
 * cleanly a duplicate. Re-validating means that row is reported against
 * its own line instead of aborting the batch — and the register's own
 * constraints, inside the transaction, remain the authority over both
 * passes.
 *
 * ## Permissions
 *
 * The `import` authority (owner ruling, migration 0094) on top of the
 * writer role the registers themselves require. The authority answers who
 * may point a file at a register, which is a different question from who
 * may add a row to one — see the migration's header for the asymmetry it
 * is drawn around.
 *
 * NO WORK SCOPE. Both registers this ships for are organisation-level
 * master data (`contacts`, `canonical_items`, both already recorded as
 * such in `test/audit-timeline-census.test.ts`), so there is no Work to
 * assert access to. A target that IS Work-scoped must call
 * `assertWorkAccess` before it stages anything, and this comment is here
 * so that requirement is met by a reader rather than discovered.
 *
 * ## Why nothing here is a worker job
 *
 * Migration 0094's header argues it in full. In short: the request cap
 * and the row cap together bound the work to milliseconds of parsing and
 * a few statements, and an asynchronous lane would buy a job kind, a
 * handler and a polling screen in exchange for latency the caller is
 * already waiting through.
 */

/**
 * The database's own refusals, mapped to named codes.
 *
 * Migration 0094 raises with SQLSTATEs from the 23L block, one per rule,
 * so a guard that fires because the route's own check lost a race
 * surfaces as the same 409 an operator would have got from the route —
 * not as an unexplained 500.
 */
const DATABASE_REFUSALS: Record<string, readonly [ErrorCode, string]> = {
  '23L01': [
    'IMPORT_BATCH_FINISHED',
    'The import moved on while this was being recorded; reload the import and try again.',
  ],
  '23L02': [
    'IMPORT_BATCH_FINISHED',
    'The file and target register of an import are recorded once and cannot be changed.',
  ],
  '23L03': [
    'IMPORT_ROW_IMMUTABLE',
    'A staged row records what the sheet contained and cannot be rewritten.',
  ],
  '23L04': [
    'IMPORT_BATCH_FINISHED',
    'The import finished while this was being recorded, so its rows can no longer be written.',
  ],
  // 23L05 is deliberately ABSENT. It fires when a batch would record more
  // imported rows than it judged valid, which no sequence of requests can
  // produce — only a defect in this route's own arithmetic can. Giving it
  // a 409 and a remedy would tell an operator to retry something that
  // will fail identically; letting it surface as a 500 says the true
  // thing, which is that the server got it wrong.
};

const rethrowWriteRefusal = writeRefusals(DATABASE_REFUSALS);

/** How many batches the register returns when the caller asks for no
 * page. Imports are occasional — a handful in an organisation's first
 * week and then rarely — so the whole history usually fits one request. */
const BATCH_PAGE_LIMIT = 100;

/** Rows of one batch per page. The screen asks for the error rows first
 * and the valid ones after, so the first page of a sheet with eleven bad
 * rows is those eleven. */
const ROW_PAGE_LIMIT = 100;

/** One page of rows plus the cursor for the next, built from the
 * limit-plus-one read above. */
function rowPage(rows: readonly StagedRow[], limit: number) {
  const shown = rows.slice(0, limit);
  return {
    rows: shown.map(toRow),
    nextRowCursor:
      rows.length > limit ? (shown[shown.length - 1]?.row_number ?? null) : null,
  };
}

/* --- reading the sheet ----------------------------------------------------- */

interface SheetMapping {
  /** Target column key, by sheet column index. Sparse: sheet columns the
   * target does not know about are absent and are ignored. */
  readonly byIndex: ReadonlyMap<number, string>;
}

/**
 * Matches the sheet's header row against the target's columns.
 *
 * A column the target does not recognise is IGNORED rather than refused.
 * Real registers arrive with a working note, a serial number, a colleague's
 * initials in column S; refusing the file over them would mean an operator
 * deleting columns from a workbook they need, which is how spreadsheets
 * get corrupted.
 *
 * A REQUIRED column the sheet does not carry is a refusal, because every
 * row would fail identically and reporting that five hundred times is not
 * a verdict, it is noise.
 */
function mapHeaders(target: ImportTarget, header: readonly string[]): SheetMapping {
  const wanted = new Map(
    target.columns.map((column) => [headerKey(column.header), column]),
  );
  const byIndex = new Map<number, string>();
  const seen = new Set<string>();
  header.forEach((cell, index) => {
    const column = wanted.get(headerKey(cell));
    // First occurrence wins. A duplicated header is a copy-paste artefact,
    // and reading the second copy would silently prefer whichever column
    // happened to be further right.
    if (column !== undefined && !seen.has(column.key)) {
      byIndex.set(index, column.key);
      seen.add(column.key);
    }
  });

  const missing = target.columns.filter(
    (column) => column.required === true && !seen.has(column.key),
  );
  if (missing.length > 0) {
    throw httpError(
      400,
      'IMPORT_SHEET_HEADERS_UNRECOGNISED',
      `The sheet is missing these required columns: ${missing
        .map((column) => column.header)
        .join(
          ', ',
        )}. Download the template for this register and copy your rows into it.`,
    );
  }
  return { byIndex };
}

/** One sheet row as the staged `cells` object: target column key to raw
 * text. Columns the sheet omitted are absent rather than empty, so the
 * validator's own "required and empty" rule is what refuses them. */
function cellsOf(
  mapping: SheetMapping,
  row: readonly string[],
): Record<string, string> {
  const cells: Record<string, string> = {};
  for (const [index, key] of mapping.byIndex) {
    const value = row[index];
    if (value !== undefined && value.length > 0) cells[key] = value;
  }
  return cells;
}

/** Whether every cell the target cares about is blank. Trailing empty
 * rows are what Excel leaves behind when somebody deletes content rather
 * than rows, and staging four hundred of them as errors would bury the
 * eleven that matter. */
function isBlank(cells: Record<string, string>): boolean {
  return Object.keys(cells).length === 0;
}

/* --- judging the rows ------------------------------------------------------ */

interface JudgedRow {
  readonly rowNumber: number;
  readonly cells: Record<string, string>;
  readonly errors: readonly RowError[];
}

/**
 * Runs the target's rules over every staged row, in sheet order.
 *
 * Order matters for one reason: the in-sheet duplicate check asks whether
 * an EARLIER row already claimed this key, so the first of two identical
 * rows passes and the second is refused. Refusing both would be
 * defensible and is worse in practice — an operator who pasted a block
 * twice wants the register populated once, not the whole file rejected.
 */
function judge(
  target: ImportTarget,
  existing: ReadonlySet<string>,
  rows: readonly { rowNumber: number; cells: Record<string, string> }[],
): JudgedRow[] {
  const claimed = new Set<string>();
  const context: DuplicateContext = { existing, claimed };
  return rows.map(({ rowNumber, cells }) => {
    const verdict = target.validate(cells, context);
    if ('errors' in verdict) return { rowNumber, cells, errors: verdict.errors };
    claimed.add(verdict.naturalKey);
    return { rowNumber, cells, errors: [] };
  });
}

/* --- rows on the wire ------------------------------------------------------ */

interface BatchRow {
  id: string;
  target: string;
  status: string;
  original_filename: string;
  source_sha256: string;
  row_count: number;
  valid_row_count: number;
  error_row_count: number;
  imported_row_count: number;
  created_by_user_id: string;
  created_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
}

interface StagedRow {
  id: string;
  row_number: number;
  status: string;
  cells: unknown;
  errors: unknown;
  imported_record_id: string | null;
}

function toBatch(row: BatchRow) {
  return {
    id: row.id,
    target: row.target as 'contacts' | 'canonical_items',
    status: row.status as 'pending' | 'validated' | 'completed' | 'cancelled',
    originalFilename: row.original_filename,
    sourceSha256: row.source_sha256,
    rowCount: row.row_count,
    validRowCount: row.valid_row_count,
    errorRowCount: row.error_row_count,
    importedRowCount: row.imported_row_count,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt:
      row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    cancelledAt:
      row.cancelled_at === null ? null : new Date(row.cancelled_at).toISOString(),
    cancelledReason: row.cancelled_reason,
  };
}

/** `cells` and `errors` come back as jsonb. postgres.js parses them
 * already, so this is a shape assertion rather than a parse — and it is
 * here because a column whose contents originated in an uploaded file
 * must not be handed to a schema serialiser on the strength of what the
 * writer intended. */
function toRow(row: StagedRow) {
  const cells: Record<string, string> = {};
  if (row.cells !== null && typeof row.cells === 'object') {
    for (const [key, value] of Object.entries(row.cells as Record<string, unknown>)) {
      if (typeof value === 'string') cells[key] = value;
    }
  }
  const errors = Array.isArray(row.errors)
    ? (row.errors as unknown[]).flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        return typeof record.message === 'string'
          ? [
              {
                column: typeof record.column === 'string' ? record.column : null,
                message: record.message,
              },
            ]
          : [];
      })
    : [];
  return {
    id: row.id,
    rowNumber: row.row_number,
    status: row.status as 'pending' | 'valid' | 'error',
    cells,
    errors,
    importedRecordId: row.imported_record_id,
  };
}

/** The column descriptions the screen renders. Deliberately a subset of
 * `TargetColumn`: the example row and the regexes are the template's and
 * the validator's business, not the browser's. */
function toColumns(columns: readonly TargetColumn[]) {
  return columns.map((column) => ({
    key: column.key,
    header: column.header,
    required: column.required ?? false,
    note: column.note,
  }));
}

function requireTarget(key: string): ImportTarget {
  const target = IMPORT_TARGETS[key];
  if (target === undefined) {
    throw httpError(
      400,
      'IMPORT_TARGET_UNKNOWN',
      'That register cannot be imported into.',
    );
  }
  return target;
}

async function readBatch(tx: TransactionSql, id: string): Promise<BatchRow> {
  const [row] = await tx<BatchRow[]>`
    select * from spreadsheet_import_batches where id = ${id} for update
  `;
  if (!row) throw httpError(404, 'IMPORT_BATCH_NOT_FOUND', 'No such import.');
  return row;
}

/**
 * One page of a batch's rows, errors first.
 *
 * PAGINATED ON THE WIRE, which the first cut was not: a 5,000-row sheet
 * of twenty columns was serialised in full by the upload, the read AND
 * the commit, three times over, on top of the expansion the parser's own
 * budget now bounds. The screen only ever drew two hundred of them.
 *
 * ORDERED BY `row_number` ALONE, and the errors-first reading the screen
 * wants is a `status` FILTER rather than a sort. Sorting by status and
 * paging by row number is a keyset that silently drops rows: with errors
 * at 5 and 900 and valid rows at 2 and 3, the first page ends at 900 and
 * `row_number > 900` returns nothing, losing both valid rows. One sort
 * key, one cursor, and a caller that wants errors first asks for them
 * first — which is what the screen does.
 */
async function readStagedRows(
  tx: TransactionSql,
  batchId: string,
  page: { readonly limit: number; readonly cursor?: number; readonly status?: string },
) {
  return await tx<StagedRow[]>`
    select id, row_number, status, cells, errors, imported_record_id
    from spreadsheet_import_rows
    where batch_id = ${batchId}
      and (${page.status ?? null}::text is null or status = ${page.status ?? null})
      and (${page.cursor ?? null}::int is null or row_number > ${page.cursor ?? null})
    order by row_number
    limit ${page.limit + 1}
  `;
}

/**
 * Forgets what the sheet said, keeping what happened to it.
 *
 * A contacts sheet carries account numbers and IFSCs, and the direct path
 * is deliberately discreet about both — `normaliseContactBankDetails`
 * says in its own comment that they are "never audited and never logged".
 * Staging them for ever, echoing them on every read of the batch and
 * publishing them in the organisation export undoes that, for rows whose
 * authoritative copy is already in `contacts` where the discretion
 * applies.
 *
 * So the cells live exactly as long as they are useful: from the upload
 * until the batch reaches a terminal state, which is the window in which
 * somebody is reading them to decide. The VERDICTS stay — the error
 * messages, the row numbers, the record each row became — because those
 * are what makes a committed import auditable, and none of them carries a
 * value.
 *
 * Runs while the batch is still open, because 0094's row guard refuses
 * every write to a terminal batch. The guard admits this one write and no
 * other: cells may become `{}` and may never become anything else.
 */
async function forgetCells(tx: TransactionSql, batchId: string): Promise<void> {
  await tx`
    update spreadsheet_import_rows
    set cells = '{}'::jsonb
    where batch_id = ${batchId} and cells <> '{}'::jsonb
  `.catch(rethrowWriteRefusal);
}

/**
 * The register's own refusal for a row the database would not take, or a
 * rethrow.
 *
 * Two rules, and the second is the one worth stating. A refusal this
 * function RECOGNISES becomes that row's error in the register's own
 * words — the same sentence the single-record route answers with, because
 * a message an operator reads must not depend on which door they came
 * through. Anything it does not recognise is not a refusal at all: it is
 * a bug in this pipeline, and it aborts the whole commit rather than
 * being written into `errors`, exported, and reported as a batch that
 * "completed". A `TypeError` persisted as a row-level explanation is a
 * defect wearing an operator's clothes.
 */
function rowRefusal(target: ImportTarget, cause: unknown): RowError {
  const code =
    cause !== null && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : '';
  if (code === '23505') return { column: null, message: target.duplicateMessage };
  if (code === '23514' || code === '23502') {
    return {
      column: null,
      message:
        'The register refused this row because one of its values is not something that column accepts; correct it in the sheet and upload it again.',
    };
  }
  throw cause;
}

export function registerImportRoutes(
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
      url: '/api/imports',
      schema: {
        querystring: withKeysetQuery(KeysetQuerySchema),
        response: { 200: ImportBatchListSchema, ...errorResponses },
      },
      // READS CARRY THE WRITER ROLE AND NOTHING MORE. Which imports an
      // organisation ran, and why eleven rows were refused, is ordinary
      // register history — and the rail draws this screen for every
      // writer, so gating the list on the authority would send everyone
      // who is not a founding owner into a 403 the moment they clicked
      // it. The authority is what governs POINTING A FILE at a register,
      // so it sits on upload, commit, cancel and the template.
      //
      // Reading a batch's staged CELLS is a different question, because a
      // contacts sheet carries bank account numbers. That is answered in
      // the detail route below, not here: this endpoint publishes
      // filenames and counts.
      role: 'writer',
    },
    async ({ request, tenant }) => {
      const query = request.query;
      const { rows, limit } = await tenant(async (tx) => {
        const cursor = await cursorRowId(
          tx,
          'spreadsheet_import_batches',
          query.cursor,
        );
        const pageSize = query.limit ?? BATCH_PAGE_LIMIT;
        const loaded = await tx<BatchRow[]>`
          select * from spreadsheet_import_batches
          where (
            ${cursor}::uuid is null
            or (created_at, id) <
               (select created_at, id from spreadsheet_import_batches where id = ${cursor})
          )
          order by created_at desc, id desc
          limit ${sqlLimit(pageSize)}
        `;
        return { rows: loaded, limit: pageSize };
      });
      const page = keysetPage(rows, limit, (row) => row.id);
      return {
        batches: page.rows.map(toBatch),
        nextCursor: page.nextCursor,
        // Sent with every listing rather than from a route of its own:
        // the screen needs them before a single batch exists, which is
        // exactly the state an organisation is in on its first day.
        targets: Object.values(IMPORT_TARGETS).map((target) => ({
          key: target.key as 'contacts' | 'canonical_items',
          label: target.label,
          columns: toColumns(target.columns),
        })),
      };
    },
  );

  /* --- the template ------------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/imports/templates/:target',
      schema: {
        params: Type.Object(
          { target: Type.String({ maxLength: 40 }) },
          { additionalProperties: false },
        ),
        response: { 400: ApiErrorSchema, 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
      role: 'writer',
      authority: 'import',
    },
    async ({ request, reply, tenant }) => {
      // The membership floor FIRST, before the target is even looked up.
      // The template is not secret, but an endpoint that answers before
      // proving a membership enumerates which registers exist to anyone
      // holding a session — and a non-member who gets 400 for an unknown
      // register and 403 for a known one has been told which is which.
      // `test/route-inventory.integration.test.ts` sweeps every tenant
      // route for exactly this and caught the original ordering.
      await tenant(() => Promise.resolve());
      const target = requireTarget(request.params.target);
      const bytes = writeXlsxWorkbook(target.sheetName, templateRows(target));
      void reply.type(XLSX_MEDIA_TYPE);
      void reply.header(
        'content-disposition',
        `attachment; filename="auto-mb-${target.key}-template.xlsx"`,
      );
      return reply.send(bytes);
    },
  );

  /* --- uploading ---------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imports',
      schema: {
        querystring: ImportUploadQuerySchema,
        response: { 201: ImportBatchDetailSchema, ...upstreamErrorResponses },
      },
      role: 'writer',
      authority: 'import',
      bodyLimit: MAX_XLSX_UPLOAD_BYTES,
    },
    async ({ request, reply, user, organisationId, tenant }) => {
      // Cannot throw: the querystring schema is the closed union, so an
      // unknown target is a 400 from the serialiser before this runs. It
      // is the same lookup every other route makes, and spelling it the
      // same way here is cheaper than a cast that says "trust me".
      const target = requireTarget(request.query.target);
      const { bytes } = consumeUpload(request.body, {
        format: 'xlsx',
        description: 'the workbook',
      });
      // STRIP FIRST, THEN TRIM. The other order reintroduces exactly the
      // failure `requireTrimmed` exists to stop: `"x \u0001"` trims to
      // `"x \u0001"`, passes, and then loses the control character to
      // become `"x "` — untrimmed, so 0094's `btrim(original_filename) =
      // original_filename` CHECK refuses it as a 23514, which reaches the
      // caller as a 500 rather than a 400. `"\u0001"` alone becomes the
      // empty string the CHECK also refuses. Stripping first means
      // whatever `requireTrimmed` approves is what the database sees.
      const filename = requireTrimmed(
        request.query.filename.replaceAll(/[\p{Cc}\p{Cf}]/gu, ''),
        'Name the file being imported.',
      );

      // AUTHORISE BEFORE ANYTHING EXPENSIVE TOUCHES THE BYTES, which is
      // the order every other upload route in this application keeps and
      // which this one originally got wrong. An empty bound transaction
      // is the whole check — `tenant-route.ts` runs the role and
      // authority guard inside every one, and the registrar's comment
      // records that a route legitimately opening more than one is why
      // the handler is handed a closure rather than an open transaction.
      //
      // Without it an unauthenticated stranger's workbook reached the
      // malware scanner and the parser before the membership wall,
      // which is a denial-of-service surface and a scanner bill.
      // `test/route-inventory.integration.test.ts` sweeps every tenant
      // route for a non-member 403 and caught it.
      await tenant(() => Promise.resolve());
      await assertNotMalware(malwareScanner, bytes);

      let sheet: SheetRow[];
      try {
        sheet = readXlsxRows(bytes);
      } catch (cause: unknown) {
        if (cause instanceof XlsxParseError) {
          throw httpError(400, 'IMPORT_SHEET_UNREADABLE', cause.message);
        }
        throw cause;
      }

      const [header, ...body] = sheet;
      if (header === undefined) {
        throw httpError(
          400,
          'IMPORT_SHEET_EMPTY',
          'The first sheet of that workbook has no rows at all.',
        );
      }
      const mapping = mapHeaders(target, header.cells);

      // EVERY ROW CARRIES THE NUMBER THE SHEET STATES, not its position
      // among the rows that happen to be present. Excel omits rows nobody
      // ever populated, so a file whose data resumes at row 40 after a
      // blank block would otherwise have every error after the gap
      // pointing at a line the operator cannot find — which is the exact
      // promise `spreadsheet_import_rows.row_number` makes ("not a
      // sequence"). Blank rows are still dropped rather than staged:
      // Excel leaves hundreds of them behind when content is deleted
      // without deleting the rows.
      const staged = body
        .map((row) => ({
          rowNumber: row.rowNumber,
          cells: cellsOf(mapping, row.cells),
        }))
        .filter((row) => !isBlank(row.cells));
      if (staged.length === 0) {
        throw httpError(
          400,
          'IMPORT_SHEET_EMPTY',
          'That workbook has a header row and no data beneath it.',
        );
      }

      const detail = await tenant(async (tx) => {
        // A NEW SHEET FOR A REGISTER RETIRES THE OPEN ONES AIMED AT IT.
        //
        // Without this a validated batch stays committable for ever, and
        // the ordinary correction loop becomes a trap: upload, see eleven
        // errors, fix the workbook, upload again, and now two batches are
        // committable — the corrected one and the one with the typo still
        // in it. Committing the wrong one writes a known-bad row and
        // looks like a success.
        //
        // Superseding at UPLOAD rather than at commit is the cheaper half
        // of the same rule and closes the window completely: by the time
        // a second batch exists the first can no longer be run at all.
        // The superseded batch keeps its record and its verdicts, exactly
        // as a withdrawn one does.
        await tx`
          update spreadsheet_import_batches
          set status = 'superseded'
          where target = ${target.key} and status in ('pending', 'validated')
        `.catch(rethrowWriteRefusal);

        const existing = await target.existingKeys(tx);
        const judged = judge(target, existing, staged);
        const validCount = judged.filter((row) => row.errors.length === 0).length;

        const [batch] = await tx<BatchRow[]>`
          insert into spreadsheet_import_batches (
            organisation_id, target, original_filename, source_sha256,
            created_by_user_id
          )
          values (
            ${organisationId}, ${target.key}, ${filename},
            ${createHash('sha256').update(bytes).digest('hex')}, ${user.id}
          )
          returning *
        `.catch(rethrowWriteRefusal);
        if (!batch) throw new Error('import batch insert returned no row');

        // One statement for every staged row. The per-row write loop the
        // commit needs is unavoidable there (each insert is isolated in
        // its own savepoint); here there is nothing to isolate, and five
        // thousand round-trips inside a transaction is what
        // `test/query-write-loop-census.test.ts` exists to prevent.
        await tx`
          insert into spreadsheet_import_rows ${tx(
            judged.map((row) => ({
              organisation_id: organisationId,
              batch_id: batch.id,
              row_number: row.rowNumber,
              cells: tx.json(row.cells as never),
              status: row.errors.length === 0 ? 'valid' : 'error',
              errors: tx.json(row.errors as never),
            })),
            'organisation_id',
            'batch_id',
            'row_number',
            'cells',
            'status',
            'errors',
          )}
        `.catch(rethrowWriteRefusal);

        const [validated] = await tx<BatchRow[]>`
          update spreadsheet_import_batches
          set status = 'validated',
              row_count = ${judged.length},
              valid_row_count = ${validCount},
              error_row_count = ${judged.length - validCount}
          where id = ${batch.id}
          returning *
        `.catch(rethrowWriteRefusal);
        if (!validated) throw new Error('import batch update returned no row');

        await audit(
          tx,
          organisationId,
          user.id,
          'spreadsheet_import.staged',
          'spreadsheet_import_batches',
          batch.id,
          {
            target: target.key,
            rowCount: judged.length,
            validRowCount: validCount,
          },
        );

        return {
          batch: toBatch(validated),
          // Errors first, and one page of them: a sheet may hold five
          // thousand rows and the screen opens on what is wrong with it.
          ...rowPage(
            await readStagedRows(tx, batch.id, {
              limit: ROW_PAGE_LIMIT,
              status: 'error',
            }),
            ROW_PAGE_LIMIT,
          ),
          columns: toColumns(target.columns),
        };
      });
      return reply.status(201).send(detail);
    },
  );

  /* --- reading one batch -------------------------------------------------- */

  tenantRoute(
    {
      method: 'GET',
      url: '/api/imports/:id',
      schema: {
        params: Type.Object(
          {
            id: Type.String({
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            }),
          },
          { additionalProperties: false },
        ),
        querystring: ImportRowsQuerySchema,
        response: { 200: ImportBatchDetailSchema, ...errorResponses },
      },
      // THE DETAIL READ KEEPS THE AUTHORITY, where the list above dropped
      // it, and the difference is what the two publish. The list is
      // filenames, counts and statuses. This is the staged CELLS — and a
      // contacts sheet's cells are account numbers and IFSCs, which the
      // direct path treats as values not to be logged or audited. Reading
      // them is a narrower act than reading the register's history, so it
      // carries the narrower grant.
      //
      // The screen agrees rather than discovering this: it draws the list
      // for every writer and the "Open" control only for a member holding
      // the authority (views/Imports.tsx), so nobody is offered a door
      // that answers 403.
      role: 'writer',
      authority: 'import',
    },
    async ({ request, tenantSnapshot }) => {
      const { id } = request.params;
      const query = request.query;
      return await tenantSnapshot(async (tx) => {
        const [batch] = await tx<BatchRow[]>`
          select * from spreadsheet_import_batches where id = ${id}
        `;
        if (!batch) throw httpError(404, 'IMPORT_BATCH_NOT_FOUND', 'No such import.');
        const limit = query.limit ?? ROW_PAGE_LIMIT;
        const loaded = await readStagedRows(tx, id, {
          limit,
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
        });
        return {
          batch: toBatch(batch),
          ...rowPage(loaded, limit),
          columns: toColumns(requireTarget(batch.target).columns),
        };
      });
    },
  );

  /* --- committing --------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imports/:id/import',
      schema: {
        params: Type.Object(
          {
            id: Type.String({
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            }),
          },
          { additionalProperties: false },
        ),
        response: { 200: ImportBatchDetailSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
      // NO `bodyLimit`, deliberately, and therefore outside the upload
      // throttle. This is the most expensive call in the module and the
      // temptation is to put it under the limiter anyway; that was tried
      // and is wrong twice over.
      //
      // It buys no ceiling. A batch commits exactly ONCE — completion is
      // terminal and the guard refuses a second run — so the only way to
      // reach this work again is to upload another sheet, and the upload
      // route is already inside the limiter at thirty per ten minutes.
      // The expensive path is rate-limited at its real entrance.
      //
      // And it breaks a legitimate flow: an operator bringing in a
      // party master and an item catalogue, correcting each once, spends
      // four uploads and four commits in a few minutes. Counting the
      // commits against a window sized for uploads throttles the honest
      // case while leaving the attacker's cost unchanged.
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return await tenant(async (tx) => {
        const batch = await readBatch(tx, id);
        const target = requireTarget(batch.target);
        if (batch.status === 'superseded') {
          throw httpError(
            409,
            'IMPORT_BATCH_SUPERSEDED',
            'A later sheet was uploaded for this register, so this import can no longer be run; open the newest one instead.',
          );
        }
        if (batch.status === 'completed' || batch.status === 'cancelled') {
          throw httpError(
            409,
            'IMPORT_BATCH_FINISHED',
            `This import is already ${batch.status} and cannot be run again.`,
          );
        }
        if (batch.status !== 'validated') {
          throw httpError(
            409,
            'IMPORT_BATCH_NOT_VALIDATED',
            'This import has not finished being checked yet.',
          );
        }

        // Every valid row, not a page of them: this read is the commit's
        // own working set rather than a response, and it has to write all
        // of them. Bounded by the sheet's row cap, and never serialised.
        const candidates = await tx<StagedRow[]>`
          select id, row_number, status, cells, errors, imported_record_id
          from spreadsheet_import_rows
          where batch_id = ${id} and status = 'valid'
          order by row_number
        `;
        if (candidates.length === 0) {
          throw httpError(
            409,
            'IMPORT_NOTHING_TO_IMPORT',
            'Every row of this import is in error, so there is nothing to write; correct the sheet and upload it again.',
          );
        }

        // THE SECOND VALIDATION PASS, against the register as it is NOW.
        // Time has passed since the upload and somebody may have added by
        // hand exactly what this sheet is about to add.
        const existing = await target.existingKeys(tx);
        const claimed = new Set<string>();
        const context: DuplicateContext = { existing, claimed };

        const imported: { id: string; recordId: string; built: BuiltRow }[] = [];
        const failed: { id: string; errors: RowError[] }[] = [];

        for (const row of candidates) {
          const cells = toRow(row).cells;
          const verdict = target.validate(cells, context);
          if ('errors' in verdict) {
            failed.push({ id: row.id, errors: [...verdict.errors] });
            continue;
          }
          try {
            // Each insert in its own savepoint, so one row losing a race
            // to a concurrent write refuses that row instead of aborting
            // the other seven hundred. The same reason the v1 cutover
            // importer does it (test/query-write-loop-census.test.ts).
            let recordId = '';
            await tx.savepoint(async (sp) => {
              recordId = await target.insert(sp, organisationId, user.id, verdict.row);
            });
            claimed.add(verdict.naturalKey);
            imported.push({ id: row.id, recordId, built: verdict.row });
          } catch (cause: unknown) {
            // Recognised refusal or rethrow — never the driver's own
            // message. See `rowRefusal`.
            failed.push({ id: row.id, errors: [rowRefusal(target, cause)] });
          }
        }

        // Two statements, not two per row: the verdicts are applied in
        // bulk over an unnested pair of arrays. The write loop above is
        // the isolation the savepoints buy; this is not, so it is not a
        // loop.
        if (imported.length > 0) {
          await tx`
            update spreadsheet_import_rows as r
            set imported_record_id = v.record_id::uuid
            from (
              select * from unnest(
                ${tx.array(imported.map((row) => row.id))}::uuid[],
                ${tx.array(imported.map((row) => row.recordId))}::uuid[]
              ) as t(row_id, record_id)
            ) as v
            where r.id = v.row_id::uuid
          `.catch(rethrowWriteRefusal);
        }
        if (failed.length > 0) {
          await tx`
            update spreadsheet_import_rows as r
            set status = 'error', errors = v.errors::jsonb
            from (
              select * from unnest(
                ${tx.array(failed.map((row) => row.id))}::uuid[],
                ${tx.array(failed.map((row) => JSON.stringify(row.errors)))}::text[]
              ) as t(row_id, errors)
            ) as v
            where r.id = v.row_id::uuid
          `.catch(rethrowWriteRefusal);
        }

        // ONE AUDIT EVENT PER IMPORTED RECORD, the same event the direct
        // route writes, so a contact brought in by a sheet has the same
        // history panel as one typed into the form. The batch id rides in
        // the payload, which is what turns "who added this vendor" into a
        // question answerable from the vendor rather than only from the
        // Imports screen.
        //
        // One statement for all of them: eight hundred inserts in a loop
        // is what `test/query-write-loop-census.test.ts` exists to
        // prevent, and there is nothing to isolate here.
        if (imported.length > 0) {
          await tx`
            insert into audit_events ${tx(
              imported.map((row) => ({
                organisation_id: organisationId,
                actor_user_id: user.id,
                action: target.audit.action,
                entity_type: target.audit.entityType,
                entity_id: row.recordId,
                details: tx.json({
                  ...target.audit.details(row.built),
                  importBatchId: id,
                }),
              })),
              'organisation_id',
              'actor_user_id',
              'action',
              'entity_type',
              'entity_id',
              'details',
            )}
          `;
        }

        // The cells have done their work: the verdicts are written, the
        // records exist, and what remains is a bank account number in a
        // staging table. Before the batch turns terminal, because the row
        // guard refuses every write to one that has.
        await forgetCells(tx, id);

        const validCount = batch.valid_row_count - failed.length;
        const [completed] = await tx<BatchRow[]>`
          update spreadsheet_import_batches
          set status = 'completed',
              valid_row_count = ${validCount},
              error_row_count = ${batch.row_count - validCount},
              imported_row_count = ${imported.length},
              completed_at = now(),
              completed_by_user_id = ${user.id}
          where id = ${id}
          returning *
        `.catch(rethrowWriteRefusal);
        if (!completed) throw new Error('import batch completion returned no row');

        // …and one for the batch itself, beside the per-record events
        // above. It is the provenance the records point back at: who
        // brought these in, from what file, and how many the register
        // refused.
        await audit(
          tx,
          organisationId,
          user.id,
          'spreadsheet_import.completed',
          'spreadsheet_import_batches',
          id,
          {
            target: target.key,
            importedRowCount: imported.length,
            refusedRowCount: failed.length,
          },
        );

        return {
          batch: toBatch(completed),
          ...rowPage(
            await readStagedRows(tx, id, { limit: ROW_PAGE_LIMIT, status: 'error' }),
            ROW_PAGE_LIMIT,
          ),
          columns: toColumns(target.columns),
        };
      });
    },
  );

  /* --- withdrawing -------------------------------------------------------- */

  tenantRoute(
    {
      method: 'POST',
      url: '/api/imports/:id/cancel',
      schema: {
        params: Type.Object(
          {
            id: Type.String({
              pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            }),
          },
          { additionalProperties: false },
        ),
        body: CancelImportBatchSchema,
        response: { 200: ImportBatchDetailSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      const reason = requireTrimmed(
        request.body.reason,
        'Say why this import is being withdrawn.',
      );
      return await tenant(async (tx) => {
        const batch = await readBatch(tx, id);
        if (
          batch.status === 'completed' ||
          batch.status === 'cancelled' ||
          batch.status === 'superseded'
        ) {
          throw httpError(
            409,
            'IMPORT_BATCH_FINISHED',
            `This import is already ${batch.status} and cannot be withdrawn.`,
          );
        }
        // Nothing here reached a register, so the cells are the only
        // copy — and that is exactly why they go: a withdrawn sheet of
        // vendor bank details has no reason to outlive the decision to
        // withdraw it. The counts and the row-level errors stay.
        await forgetCells(tx, id);

        const [cancelled] = await tx<BatchRow[]>`
          update spreadsheet_import_batches
          set status = 'cancelled',
              cancelled_at = now(),
              cancelled_by_user_id = ${user.id},
              cancelled_reason = ${reason}
          where id = ${id}
          returning *
        `.catch(rethrowWriteRefusal);
        if (!cancelled) throw new Error('import batch cancellation returned no row');
        await audit(
          tx,
          organisationId,
          user.id,
          'spreadsheet_import.cancelled',
          'spreadsheet_import_batches',
          id,
          { target: batch.target, reason },
        );
        return {
          batch: toBatch(cancelled),
          ...rowPage(
            await readStagedRows(tx, id, { limit: ROW_PAGE_LIMIT }),
            ROW_PAGE_LIMIT,
          ),
          columns: toColumns(requireTarget(batch.target).columns),
        };
      });
    },
  );
}
