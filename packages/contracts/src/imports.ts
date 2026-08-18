import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import { UuidSchema, nonBlankString } from './primitives.js';

// --- Spreadsheet imports (migration 0094) -----------------------------------
//
// An operator uploads the register they already keep in Excel, reads
// which rows are wrong and why, fixes them, and then commits. The wire
// model follows that sequence exactly: an upload answers with a batch and
// its judged rows, and a second call turns the valid ones into records.
//
// THE MOCK DRAWS NO IMPORTS SCREEN. This module is application-first
// under AGENTS.md § Design contract 2 and 4, built in the mock's existing
// grammar — its page header, its data table, its status chip, its confirm
// dialog — with no new visual language. `docs/UX.md` § 18 records the
// stance and the reasoning rather than inventing a mock citation for a
// screen that does not exist at `punyanagari/Auto-MB-Vercel-du@fdfd610`.
//
// RAW CELLS TRAVEL. `ImportRow.cells` is the sheet's own text, and the
// screen renders it beside the errors so an operator can see the value
// that was refused without opening the workbook again. It is typed as a
// map of string to string, never `unknown`: the reader never coerces a
// cell, so there is no other shape it could arrive in.

/* --- Vocabulary ------------------------------------------------------------ */

/** The registers a sheet may be pointed at (migration 0094's `target`
 * CHECK). A closed vocabulary, so a caller cannot name a table. */
export const ImportTargetKeySchema = Type.Union(
  [Type.Literal('contacts'), Type.Literal('canonical_items')],
  {
    description: 'The register an uploaded sheet is aimed at.',
  },
);
export type ImportTargetKey = Static<typeof ImportTargetKeySchema>;

/** `pending` staged but unjudged, `validated` judged and awaiting a
 * decision, `completed` and `cancelled` terminal. Migration 0094's guard
 * walks these forwards only. */
export const ImportBatchStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('validated'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
]);
export type ImportBatchStatus = Static<typeof ImportBatchStatusSchema>;

export const ImportRowStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('valid'),
  Type.Literal('error'),
]);
export type ImportRowStatus = Static<typeof ImportRowStatusSchema>;

/* --- What a template promises ---------------------------------------------- */

/** One column of a target, as the Imports screen describes it before a
 * file has been chosen. The same description generates the downloadable
 * template, so the screen and the workbook cannot disagree. */
export const ImportColumnSchema = Type.Object(
  {
    key: nonBlankString({ minLength: 2, maxLength: 60 }),
    header: nonBlankString({ minLength: 2, maxLength: 120 }),
    required: Type.Boolean(),
    note: nonBlankString({ minLength: 2, maxLength: 400 }),
  },
  { additionalProperties: false },
);
export type ImportColumn = Static<typeof ImportColumnSchema>;

export const ImportTargetSchema = Type.Object(
  {
    key: ImportTargetKeySchema,
    label: nonBlankString({ minLength: 2, maxLength: 120 }),
    columns: Type.Array(ImportColumnSchema),
  },
  { additionalProperties: false },
);
export type ImportTarget = Static<typeof ImportTargetSchema>;

/* --- The staged row -------------------------------------------------------- */

/** Which column refused the value, and what it said. `column` is null for
 * a refusal about the row rather than any one cell. */
export const ImportRowErrorSchema = Type.Object(
  {
    column: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
    message: nonBlankString({ minLength: 2, maxLength: 1000 }),
  },
  { additionalProperties: false },
);
export type ImportRowError = Static<typeof ImportRowErrorSchema>;

export const ImportRowSchema = Type.Object(
  {
    id: UuidSchema,
    /** The row number in the sheet, where 1 is the header. Not a
     * sequence: an error report that renumbers the rows it describes
     * cannot be acted on against the open workbook. */
    rowNumber: Type.Integer({ minimum: 2 }),
    status: ImportRowStatusSchema,
    cells: Type.Record(Type.String(), Type.String()),
    errors: Type.Array(ImportRowErrorSchema),
    importedRecordId: Type.Union([UuidSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportRow = Static<typeof ImportRowSchema>;

/* --- The batch ------------------------------------------------------------- */

export const ImportBatchSchema = Type.Object(
  {
    id: UuidSchema,
    target: ImportTargetKeySchema,
    status: ImportBatchStatusSchema,
    originalFilename: Type.String({ minLength: 1, maxLength: 255 }),
    sourceSha256: Type.String({ minLength: 64, maxLength: 64 }),
    rowCount: Type.Integer({ minimum: 0 }),
    validRowCount: Type.Integer({ minimum: 0 }),
    errorRowCount: Type.Integer({ minimum: 0 }),
    /** Below `validRowCount` when a row that validated cleanly lost a
     * race to a concurrent write at commit. */
    importedRowCount: Type.Integer({ minimum: 0 }),
    createdByUserId: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    cancelledReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportBatch = Static<typeof ImportBatchSchema>;

/* --- Requests and responses ------------------------------------------------ */

/** The upload's metadata rides the querystring: the body is the workbook
 * bytes, exactly as every other upload route in this application takes
 * them. */
export const ImportUploadQuerySchema = Type.Object(
  {
    target: ImportTargetKeySchema,
    /** Plain `Type.String`, not `nonBlankString`: 0094's CHECK admits a
     * one-character filename and `nonBlankString` cannot express a floor
     * below two. The route's `requireTrimmed` is the blank guard here,
     * exactly as it is for every other upload's metadata. */
    filename: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);
export type ImportUploadQuery = Static<typeof ImportUploadQuerySchema>;

/** A batch with its rows. Returned by the upload and by the detail read,
 * because both answer the same question — what did this file contain and
 * what is wrong with it. */
export const ImportBatchDetailSchema = Type.Object(
  {
    batch: ImportBatchSchema,
    rows: Type.Array(ImportRowSchema),
    /** The target's column descriptions, so the screen can render the
     * cells in sheet order and label the errors without a second call. */
    columns: Type.Array(ImportColumnSchema),
  },
  { additionalProperties: false },
);
export type ImportBatchDetail = Static<typeof ImportBatchDetailSchema>;

export const ImportBatchListSchema = Type.Object(
  {
    batches: Type.Array(ImportBatchSchema),
    nextCursor: NextCursorSchema,
    /** Every register a sheet may be pointed at, with its columns. The
     * Imports screen needs these before any batch exists — it is the
     * screen an organisation sees on its first day. */
    targets: Type.Array(ImportTargetSchema),
  },
  { additionalProperties: false },
);
export type ImportBatchList = Static<typeof ImportBatchListSchema>;

export const CancelImportBatchSchema = Type.Object(
  { reason: nonBlankString({ minLength: 3, maxLength: 500 }) },
  { additionalProperties: false },
);
export type CancelImportBatch = Static<typeof CancelImportBatchSchema>;
