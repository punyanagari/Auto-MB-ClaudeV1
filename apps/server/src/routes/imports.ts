import { createHash } from 'node:crypto';
import {
  ApiErrorSchema,
  CancelImportBatchSchema,
  type ErrorCode,
  ImportBatchDetailSchema,
  ImportBatchListSchema,
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
  type DuplicateContext,
  type ImportTarget,
  type RowError,
  type TargetColumn,
} from '../import-targets.js';
import type { MalwareScanner } from '../malware-scan.js';
import { cursorRowId, keysetPage, sqlLimit } from '../pagination.js';
import { createTenantRouteRegistrar } from '../tenant-route.js';
import {
  MAX_XLSX_UPLOAD_BYTES,
  assertNotMalware,
  consumeUpload,
} from '../upload-guards.js';
import {
  XLSX_LIMITS,
  XLSX_MEDIA_TYPE,
  XlsxParseError,
  readXlsxRows,
  writeXlsxWorkbook,
} from '../xlsx.js';
import {
  audit,
  errorResponses,
  requireTrimmed,
  upstreamErrorResponses,
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
    'IMPORT_BATCH_FINISHED',
    'A staged row records what the sheet contained and is not edited after it is staged.',
  ],
  '23L04': [
    'IMPORT_BATCH_FINISHED',
    'The import finished while this was being recorded, so its rows can no longer be written.',
  ],
  '23L05': [
    'IMPORT_BATCH_FINISHED',
    'The import recorded more imported rows than it judged valid and was rolled back.',
  ],
};

function rethrowWriteRefusal(error: unknown): never {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
  const refusal = DATABASE_REFUSALS[code];
  if (refusal !== undefined) throw httpError(409, refusal[0], refusal[1]);
  throw error;
}

/** How many batches the register returns when the caller asks for no
 * page. Imports are occasional — a handful in an organisation's first
 * week and then rarely — so the whole history usually fits one request. */
const BATCH_PAGE_LIMIT = 100;

/* --- reading the sheet ----------------------------------------------------- */

/** Header text reduced to what an operator meant by it. Case, spacing and
 * the punctuation people sprinkle through a header row ("GSTIN *",
 * "PIN-code:") are all noise, and a template that only matched its own
 * exact strings would refuse the sheet it generated the moment somebody
 * bolded a column and Excel round-tripped it. */
function headerKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

async function readStagedRows(tx: TransactionSql, batchId: string) {
  return await tx<StagedRow[]>`
    select id, row_number, status, cells, errors, imported_record_id
    from spreadsheet_import_rows
    where batch_id = ${batchId}
    order by row_number
  `;
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
      role: 'writer',
      authority: 'import',
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
      await tenant(async () => undefined);
      const target = requireTarget(request.params.target);
      const bytes = writeXlsxWorkbook(target.sheetName, [
        target.columns.map((column) => column.header),
        target.columns.map((column) => column.example),
        target.columns.map((column) => column.note),
      ]);
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
      const target = requireTarget(request.query.target);
      const { bytes } = consumeUpload(request.body, {
        format: 'xlsx',
        description: 'the workbook',
      });
      // Before the scan, which is the expensive step no ill-formed
      // request should reach (routes/shared.ts § requireTrimmed).
      const filename = requireTrimmed(
        request.query.filename,
        'Name the file being imported.',
      ).replaceAll(/[\p{Cc}\p{Cf}]/gu, '');

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
      await tenant(async () => undefined);
      await assertNotMalware(malwareScanner, bytes);

      let sheet: string[][];
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
      const mapping = mapHeaders(target, header);

      // Row 1 is the header, so the first data row is 2 — the number the
      // operator reads in the corner of Excel. Blank rows are dropped
      // rather than staged: Excel leaves hundreds behind when content is
      // deleted without deleting the rows.
      const staged = body
        .map((row, index) => ({ rowNumber: index + 2, cells: cellsOf(mapping, row) }))
        .filter((row) => !isBlank(row.cells));
      if (staged.length === 0) {
        throw httpError(
          400,
          'IMPORT_SHEET_EMPTY',
          'That workbook has a header row and no data beneath it.',
        );
      }

      const detail = await tenant(async (tx) => {
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
          rows: (await readStagedRows(tx, batch.id)).map(toRow),
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
        response: { 200: ImportBatchDetailSchema, ...errorResponses },
      },
      role: 'writer',
      authority: 'import',
    },
    async ({ request, tenantSnapshot }) => {
      const { id } = request.params;
      return await tenantSnapshot(async (tx) => {
        const [batch] = await tx<BatchRow[]>`
          select * from spreadsheet_import_batches where id = ${id}
        `;
        if (!batch) throw httpError(404, 'IMPORT_BATCH_NOT_FOUND', 'No such import.');
        return {
          batch: toBatch(batch),
          rows: (await readStagedRows(tx, id)).map(toRow),
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
    },
    async ({ request, user, organisationId, tenant }) => {
      const { id } = request.params;
      return await tenant(async (tx) => {
        const batch = await readBatch(tx, id);
        const target = requireTarget(batch.target);
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

        const staged = await readStagedRows(tx, id);
        const candidates = staged.filter((row) => row.status === 'valid');
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

        const imported: { id: string; recordId: string }[] = [];
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
            imported.push({ id: row.id, recordId });
          } catch (cause: unknown) {
            failed.push({
              id: row.id,
              errors: [
                {
                  column: null,
                  message:
                    cause instanceof Error && cause.message.length > 0
                      ? cause.message
                      : 'The register refused this row.',
                },
              ],
            });
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

        // ONE audit row for the batch, not one per record. An import of
        // eight hundred contacts would otherwise bury every other event
        // in the organisation's trail for that day, and the question the
        // trail has to answer — who brought these in, from what file,
        // when — is a fact about the batch. The batch's own rows carry
        // the per-record detail and are exported alongside it.
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
          rows: (await readStagedRows(tx, id)).map(toRow),
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
        if (batch.status === 'completed' || batch.status === 'cancelled') {
          throw httpError(
            409,
            'IMPORT_BATCH_FINISHED',
            `This import is already ${batch.status} and cannot be withdrawn.`,
          );
        }
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
          rows: (await readStagedRows(tx, id)).map(toRow),
          columns: toColumns(requireTarget(batch.target).columns),
        };
      });
    },
  );
}

/** Re-exported so the upload guard's ceiling and the sheet's own row cap
 * are readable from one place when an operator asks how big a file may
 * be. */
export const IMPORT_LIMITS = {
  maxUploadBytes: MAX_XLSX_UPLOAD_BYTES,
  maxRows: XLSX_LIMITS.maxRows,
} as const;
