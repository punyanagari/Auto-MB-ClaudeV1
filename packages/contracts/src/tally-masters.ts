import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import { SignedMoneyStringSchema, UuidSchema } from './primitives.js';

// --- The Tally ledger census (migration 0118) ---------------------------
//
// Wave T1 of the Tally migration train, surveyed in
// `docs/reference/TALLY-MAPPING-CENSUS.md`. TallyPrime's `All Masters`
// export holds 4,327 ledger masters; this is what the application knows
// about them.
//
// THREE THINGS THE WIRE MODEL SAYS OUT LOUD:
//
//   * A contact here is a PROPOSAL, never a link. Owner ruling 6: parsing
//     a ledger name proposes, a person confirms, and ambiguity proposes
//     nothing. Every field naming one is spelled `proposed*` so no client
//     can render it as a decision somebody made.
//   * `plCode` is TEXT and reaches no Work. Owner rulings 4 and 5: 198
//     distinct codes appear in the masters against 38 works in the
//     system, the surplus is pre-cutover history, and a Tally code never
//     creates a Work.
//   * The import result is a REPORT, not a row list. 4,327 rows is not
//     something an operator reads before pressing commit; the counts, the
//     classes, the group tree and the named refusals are.
//
// THE MOCK DRAWS NO TALLY SCREEN. Application-first under AGENTS.md
// § Design contract 2 and 4, built in the mock's existing grammar and in
// the shape of the Zoho importer beside it. `docs/UX.md` § 35 records the
// stance.

/* --- Vocabulary ------------------------------------------------------------ */

/**
 * What kind of thing a ledger is, derived from TALLY'S OWN reserved group
 * ancestry rather than from this organisation's group spellings.
 *
 *   customer    descends from `Sundry Debtors`
 *   vendor      descends from `Sundry Creditors`
 *   instrument  outside both, and its own name carries a work code — the
 *               security deposits, FDRs, bank guarantees and tender EMDs
 *               waves T4 and T5 reconcile
 *   other       taxes, banks, expenses, capital: real ledgers this
 *               product does not model
 */
export const TallyLedgerClassSchema = Type.Union([
  Type.Literal('customer'),
  Type.Literal('vendor'),
  Type.Literal('instrument'),
  Type.Literal('other'),
]);
export type TallyLedgerClass = Static<typeof TallyLedgerClassSchema>;

/** How a contact was proposed: by GSTIN, which is the identifier the tax
 * system itself uses, or by an exact name. Owner ruling 8 prefers the
 * first and both refuse on ambiguity. There is no `manual` arm because
 * this wave ships nothing that confirms a proposal. */
export const TallyContactMatchMethodSchema = Type.Union([
  Type.Literal('gstin'),
  Type.Literal('name'),
]);
export type TallyContactMatchMethod = Static<typeof TallyContactMatchMethodSchema>;

export const TallyMasterImportModeSchema = Type.Union([
  Type.Literal('preview'),
  Type.Literal('commit'),
]);
export type TallyMasterImportMode = Static<typeof TallyMasterImportModeSchema>;

/* --- One ledger ------------------------------------------------------------ */

export const TallyLedgerSchema = Type.Object(
  {
    id: UuidSchema,
    /** Tally's own identifier for the master, and the idempotency key a
     * re-import updates on. */
    tallyGuid: Type.String({ minLength: 1, maxLength: 80 }),
    /** Tally's edit counter. Stored per owner ruling 2 so the single
     * post-training top-up re-read can see what moved. */
    tallyAlterId: Type.Integer({ minimum: 0 }),
    ledgerName: Type.String({ minLength: 1, maxLength: 300 }),
    parentGroup: Type.String({ maxLength: 300 }),
    /** The group ancestry, ROOT FIRST, ending at the immediate parent. */
    groupPath: Type.Array(Type.String({ minLength: 1, maxLength: 300 })),
    classification: TallyLedgerClassSchema,
    gstin: Type.Union([Type.String({ minLength: 15, maxLength: 15 }), Type.Null()]),
    /** EVIDENCE. The movements that matter to the instruments report are
     * in the vouchers, which is a later wave. */
    openingBalance: Type.Union([SignedMoneyStringSchema, Type.Null()]),
    /** The v1 work code in the ledger's own name, canonical `PL-<n>`.
     * Null where the name carries none, and null where it carries two. */
    plCode: Type.Union([Type.String({ maxLength: 8 }), Type.Null()]),
    tallyIsDeleted: Type.Boolean(),
    /** Another master in the same export cleans to the same name, so this
     * one is never proposed a contact BY NAME. */
    nameAmbiguous: Type.Boolean(),
    proposedContactId: Type.Union([UuidSchema, Type.Null()]),
    proposedContactName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    proposedContactMethod: Type.Union([TallyContactMatchMethodSchema, Type.Null()]),
    sourceFilename: Type.String({ minLength: 1, maxLength: 260 }),
    /** The import that last saw this ledger. A row whose timestamp is
     * older than the newest import is one the latest export no longer
     * carries — a master deleted in Tally, or a whole import of the wrong
     * file. */
    lastSeenAt: Type.String({ format: 'date-time' }),
    importedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type TallyLedger = Static<typeof TallyLedgerSchema>;

/* --- Reading the census ---------------------------------------------------- */

export const TallyLedgerQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(UuidSchema),
    classification: Type.Optional(TallyLedgerClassSchema),
    /** Party ledgers by whether a contact was proposed — the two halves of
     * the propose-and-prove outcome, and the half an operator works
     * through is `unmatched`. */
    matched: Type.Optional(
      Type.Union([Type.Literal('matched'), Type.Literal('unmatched')]),
    ),
    /** Only ledgers whose name carries a work code, which is the
     * instruments question waves T4 and T5 open with. */
    coded: Type.Optional(Type.Boolean()),
    /** A case-insensitive fragment of the ledger name. */
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    /** Include rows the latest import did not see. Off by default: the
     * census describes the export that was last read, and a superseded
     * row in the counts would describe two files at once. */
    includeSuperseded: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type TallyLedgerQuery = Static<typeof TallyLedgerQuerySchema>;

export const TallyLedgerListSchema = Type.Object(
  {
    ledgers: Type.Array(TallyLedgerSchema),
    nextCursor: NextCursorSchema,
    /** Counted over the WHOLE filtered census rather than the page, and
     * sent with the FIRST page only — the register discipline
     * `imported-invoices` states in full. */
    totals: Type.Union([
      Type.Object(
        {
          ledgerCount: Type.Integer({ minimum: 0 }),
          customerCount: Type.Integer({ minimum: 0 }),
          vendorCount: Type.Integer({ minimum: 0 }),
          instrumentCount: Type.Integer({ minimum: 0 }),
          otherCount: Type.Integer({ minimum: 0 }),
          /** Party ledgers carrying a contact proposal, and party ledgers
           * carrying none — the pair an operator is working down. */
          proposedContactCount: Type.Integer({ minimum: 0 }),
          unmatchedPartyCount: Type.Integer({ minimum: 0 }),
          codedCount: Type.Integer({ minimum: 0 }),
          distinctCodeCount: Type.Integer({ minimum: 0 }),
          /** When the census was last read, and from which file. Null on
           * an empty census. */
          lastImportedAt: Type.Union([
            Type.String({ format: 'date-time' }),
            Type.Null(),
          ]),
          lastFilename: Type.Union([Type.String({ maxLength: 260 }), Type.Null()]),
          /** Rows the latest import did not see. Zero unless a master was
           * deleted in Tally or a wrong file was imported once. */
          supersededCount: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type TallyLedgerList = Static<typeof TallyLedgerListSchema>;

/* --- Importing ------------------------------------------------------------- */

/** The upload's metadata rides the querystring: the body is the XML bytes,
 * exactly as every other upload route here takes them. */
export const TallyMasterUploadQuerySchema = Type.Object(
  {
    /** Plain `Type.String`, not `nonBlankString`: a one-character
     * filename is admissible and the route's `requireTrimmed` is the
     * blank guard. */
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    mode: TallyMasterImportModeSchema,
  },
  { additionalProperties: false },
);
export type TallyMasterUploadQuery = Static<typeof TallyMasterUploadQuerySchema>;

/** One ledger the export declares and this census will not store, named
 * with the line it opened on so an operator can find it in the file. The
 * rest of the export still imports. */
export const TallyLedgerRefusalSchema = Type.Object(
  {
    lineNumber: Type.Integer({ minimum: 1 }),
    ledgerName: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
    reason: Type.String({ minLength: 1, maxLength: 400 }),
  },
  { additionalProperties: false },
);
export type TallyLedgerRefusal = Static<typeof TallyLedgerRefusalSchema>;

/** Ledgers under one root group of Tally's chart of accounts, which is
 * how an accountant reads a masters file and how the census in
 * `docs/reference` presents it. */
export const TallyRootGroupCountSchema = Type.Object(
  {
    rootGroup: Type.String({ minLength: 1, maxLength: 300 }),
    ledgerCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type TallyRootGroupCount = Static<typeof TallyRootGroupCountSchema>;

/**
 * What the export contains, and what importing it would do — the same
 * object from a preview and from a commit, so an operator reads the
 * outcome against the report they approved.
 *
 * A REPORT RATHER THAN 4,327 ROWS. The Zoho importer returns every
 * invoice because 638 of them is a list a clerk scrolls and "which ones
 * did you fail to link" is answered by reading it. A masters export is an
 * order of magnitude larger and its question is different: how many of
 * each kind, how many parties the contacts master already knows, how many
 * instruments are keyed to a work. Those are counts. The rows themselves
 * are on the census screen afterwards, filtered.
 */
export const TallyMasterImportResultSchema = Type.Object(
  {
    mode: TallyMasterImportModeSchema,
    filename: Type.String({ minLength: 1, maxLength: 255 }),
    /** Ledger masters read, and group masters behind them. Every
     * classification depends on the group tree, so its size is reported
     * rather than assumed. */
    ledgerCount: Type.Integer({ minimum: 0 }),
    groupCount: Type.Integer({ minimum: 0 }),
    /** Against the census already held: masters this import would add,
     * masters it would refresh because Tally's edit counter moved, and
     * masters it would leave exactly as they are. */
    newCount: Type.Integer({ minimum: 0 }),
    updatedCount: Type.Integer({ minimum: 0 }),
    unchangedCount: Type.Integer({ minimum: 0 }),
    /** Census rows the census holds and this export does not name. A
     * master deleted in Tally, or — on the first import after a wrong
     * one — the whole of the wrong file. */
    supersededCount: Type.Integer({ minimum: 0 }),
    customerCount: Type.Integer({ minimum: 0 }),
    vendorCount: Type.Integer({ minimum: 0 }),
    instrumentCount: Type.Integer({ minimum: 0 }),
    otherCount: Type.Integer({ minimum: 0 }),
    gstinCount: Type.Integer({ minimum: 0 }),
    codedCount: Type.Integer({ minimum: 0 }),
    distinctCodeCount: Type.Integer({ minimum: 0 }),
    /** Party ledgers the contacts master answered for, and party ledgers
     * it did not. A proposal, in both cases — nothing is linked. */
    proposedContactCount: Type.Integer({ minimum: 0 }),
    unmatchedPartyCount: Type.Integer({ minimum: 0 }),
    /** Names carrying two different work codes, which propose nothing;
     * GSTINs in a shape the contacts master would refuse, which import as
     * null; and masters sharing a cleaned name, which may still be
     * proposed a contact by GSTIN but never by name. */
    ambiguousCodeCount: Type.Integer({ minimum: 0 }),
    malformedGstinCount: Type.Integer({ minimum: 0 }),
    duplicateNameCount: Type.Integer({ minimum: 0 }),
    /** Zero on a preview. On a commit, the rows written or refreshed. */
    importedCount: Type.Integer({ minimum: 0 }),
    byRootGroup: Type.Array(TallyRootGroupCountSchema),
    refusals: Type.Array(TallyLedgerRefusalSchema),
  },
  { additionalProperties: false },
);
export type TallyMasterImportResult = Static<typeof TallyMasterImportResultSchema>;
