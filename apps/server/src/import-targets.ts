import type { TransactionSql } from '@auto-mb/db';
import {
  assertBankDetailsComplete,
  assertNotAuthorityDesignation,
  normaliseBankAccountNumber,
  normaliseContactBankDetails,
  normaliseEmail,
  normaliseGstin,
  normaliseIfsc,
} from './contact-fields.js';

/**
 * The registers a spreadsheet may be pointed at, and everything each one
 * needs: the columns it accepts, the template it hands out, the rules a
 * staged row is judged by, and the insert that finally writes it.
 *
 * ## One table, three jobs
 *
 * A `TargetColumn` is the single description of a column. The downloadable
 * template's header row, its worked example and its notes come from it;
 * the parser matches sheet headers against it; and the per-cell length,
 * required and shape checks are read off it rather than written twice.
 * A column added here appears in all three at once, which is the only way
 * a template and the validator behind it stay in agreement — a template
 * promising a column the importer ignores is worse than no template.
 *
 * What is NOT declarative is the handful of rules that span fields or
 * carry a sentence of their own: a GSTIN's structure, an email's shape,
 * the bank set's all-four-or-none rule, rule R16's authority-designation
 * refusal. Those are `validate`, and every one of them CALLS THE SAME
 * FUNCTION THE SINGLE-RECORD ROUTE CALLS. That is the point of importing
 * them from `contact-fields.ts` rather than restating the regexes here:
 * an operator who mistypes a GSTIN gets the identical sentence whether
 * they typed it into the Contacts form or into row 412 of a workbook, and
 * a rule tightened in one place cannot drift out of the other.
 *
 * Two of those — `assertNotAuthorityDesignation` and
 * `normaliseContactBankDetails` — were private to `routes/masters.ts`
 * until this pack, and moved rather than being re-exported from there.
 * A domain module importing a route module inverts the layering `app.ts`
 * is otherwise the only crosser of, and `contact-fields.ts` already
 * described itself as the home of the party fields more than one writer
 * records. This is simply the third writer arriving.
 *
 * ## Two layers, and this is the outer one
 *
 * Nothing here is the authority on whether a row is admissible. The
 * register's own CHECK constraints and unique indexes are, at commit,
 * inside the transaction. What this layer buys is a verdict the operator
 * can read and act on BEFORE anything is written — with a column named,
 * which a bare constraint violation cannot give. A row that passes here
 * and is refused by the database at commit is a real outcome (a
 * concurrent write, a rule this layer does not model) and is reported
 * against that row rather than losing the batch.
 */

/** Where a refusal happened and what it said. `column` is the target
 * column's key, or `null` for a rule that is about the row rather than
 * any one cell. */
export interface RowError {
  readonly column: string | null;
  readonly message: string;
}

/** A cell's shape, which decides how the raw text is read. Everything
 * arrives as a string from the sheet; this says what to do with it. */
type ColumnKind = 'text' | 'boolean' | 'list';

export interface TargetColumn {
  /** Stable key, stored in the staged row's `cells` and quoted in errors. */
  readonly key: string;
  /** The header written into the template, and matched — case- and
   * space-insensitively — against the uploaded sheet's header row. */
  readonly header: string;
  readonly kind: ColumnKind;
  readonly required?: boolean;
  /** Bounds, mirroring the register's own CHECK so the refusal names the
   * column instead of arriving as a bare 23514 at commit. */
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A shape the column must match when present, and the sentence to say
   * when it does not. Both or neither. */
  readonly pattern?: RegExp;
  readonly patternMessage?: string;
  /** Written into the template's example row. */
  readonly example: string;
  /** Written into the template's notes row, under the header. */
  readonly note: string;
}

/** The values one target hands to its own insert. Opaque to the pipeline,
 * which only ever moves it from `validate` to `insert`. */
export type BuiltRow = Record<string, unknown>;

export interface ImportTarget {
  readonly key: string;
  /** Shown on the Imports screen and in the template's file name. */
  readonly label: string;
  /** The workbook sheet's tab name. Excel caps this at 31 characters. */
  readonly sheetName: string;
  readonly columns: readonly TargetColumn[];
  /**
   * Everything about a row that is not one cell's own shape. Returns the
   * values to insert, or the reasons it cannot.
   *
   * `existing` is the set of natural keys the register already holds,
   * read once per batch rather than once per row: an importer that probes
   * the database per row turns an 800-row sheet into 800 round trips for
   * an answer that one query gives.
   */
  readonly validate: (
    cells: Readonly<Record<string, string>>,
    context: DuplicateContext,
  ) => { row: BuiltRow; naturalKey: string } | { errors: readonly RowError[] };
  /** Reads the natural keys already in the register, lower-cased. */
  readonly existingKeys: (tx: TransactionSql) => Promise<Set<string>>;
  /** Writes one validated row and answers the id it became.
   *
   * The row arrives as `BuiltRow` and is narrowed here, in the one place
   * that knows what its own `validate` produced. TypeScript has no
   * existential type to express "these two agree and nobody else looks
   * inside", and a generic parameter puts the variance on `insert`'s
   * argument, where a registry of differently-typed targets cannot hold
   * them. One narrowing cast per target, beside the code that built the
   * value, is the smaller lie. */
  readonly insert: (
    tx: TransactionSql,
    organisationId: string,
    userId: string,
    row: BuiltRow,
  ) => Promise<string>;
  /** What to say when a row's natural key is already taken. The two
   * registers differ and the difference matters: `contacts` is unique
   * only among ACTIVE rows, so a retired twin does not block a re-import,
   * while `canonical_items` is unique outright and a retired item must be
   * reactivated rather than re-created. */
  readonly duplicateMessage: string;
}

/** What `validate` needs to answer the duplicate question: the register's
 * existing keys, and the keys earlier rows of this same sheet claimed. */
export interface DuplicateContext {
  readonly existing: ReadonlySet<string>;
  readonly claimed: ReadonlySet<string>;
}

/* --- reading a cell -------------------------------------------------------- */

/** The truthy spellings an operator actually types into a yes/no column,
 * across the two languages this product's users write in. Anything else
 * — including a blank — is false, because a column of ticks has more
 * blanks than entries and refusing every blank would fail every sheet. */
const TRUE_WORDS = new Set(['yes', 'y', 'true', 't', '1', 'haan', 'हाँ']);
const FALSE_WORDS = new Set(['', 'no', 'n', 'false', 'f', '0', 'nahi', 'नहीं']);

/** Applies the declarative half of a column's rules. Returns the value to
 * carry forward, or the sentence that refuses it. */
function readCell(
  column: TargetColumn,
  raw: string,
): { value: string | boolean | string[] } | { error: string } {
  const text = raw.trim();

  if (column.kind === 'boolean') {
    const word = text.toLowerCase();
    if (TRUE_WORDS.has(word)) return { value: true };
    if (FALSE_WORDS.has(word)) return { value: false };
    return {
      error: `Write yes or no in this column; "${text}" is neither.`,
    };
  }

  if (column.kind === 'list') {
    // Semicolons, not commas: the values this splits are item aliases,
    // and an alias routinely contains a comma ("Relay, 24V DC"). A comma
    // separator would quietly cut those in half.
    const items = text
      .split(';')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    for (const item of items) {
      if (column.maxLength !== undefined && item.length > column.maxLength) {
        return {
          error: `Each entry in this column must be ${String(column.maxLength)} characters or fewer; one is ${String(item.length)}.`,
        };
      }
    }
    return { value: items };
  }

  if (text.length === 0) {
    if (column.required === true)
      return { error: 'This column is required and is empty.' };
    return { value: '' };
  }
  if (column.minLength !== undefined && text.length < column.minLength) {
    return {
      error: `This column needs at least ${String(column.minLength)} characters; it has ${String(text.length)}.`,
    };
  }
  if (column.maxLength !== undefined && text.length > column.maxLength) {
    return {
      error: `This column takes at most ${String(column.maxLength)} characters; it has ${String(text.length)}.`,
    };
  }
  if (column.pattern !== undefined && !column.pattern.test(text)) {
    return {
      error: column.patternMessage ?? 'This value is not in the expected format.',
    };
  }
  return { value: text };
}

/**
 * Runs every column's declarative rules over one row's cells.
 *
 * Collects ALL of them rather than stopping at the first. An operator
 * fixing a sheet wants the whole list for a row in one pass; a validator
 * that reports one error per attempt turns an eleven-mistake row into
 * eleven uploads.
 */
export function readCells(
  columns: readonly TargetColumn[],
  cells: Readonly<Record<string, string>>,
): { values: Record<string, string | boolean | string[]> } | { errors: RowError[] } {
  const values: Record<string, string | boolean | string[]> = {};
  const errors: RowError[] = [];
  for (const column of columns) {
    const read = readCell(column, cells[column.key] ?? '');
    if ('error' in read) errors.push({ column: column.key, message: read.error });
    else values[column.key] = read.value;
  }
  return errors.length > 0 ? { errors } : { values };
}

/** Runs a shared validator that answers by throwing an `httpError`, and
 * attributes whatever it says to one column. The validators are written
 * for a route, where the message becomes a 400; here the same message
 * becomes a row's error, unchanged. */
function attribute<T>(
  column: string | null,
  run: () => T,
): { value: T } | { error: RowError } {
  try {
    return { value: run() };
  } catch (cause: unknown) {
    const message =
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : 'This value was refused.';
    return { error: { column, message } };
  }
}

/** Both registers ask the same duplicate questions in the same order:
 * against the register, then against the rows above this one in the same
 * sheet. A sheet listing a vendor twice is the commonest real defect in
 * an assembled list, and it is worth its own sentence. */
function duplicateError(
  naturalKey: string,
  column: string,
  context: DuplicateContext,
  registerMessage: string,
): RowError | null {
  if (context.existing.has(naturalKey)) {
    return { column, message: registerMessage };
  }
  if (context.claimed.has(naturalKey)) {
    return {
      column,
      message: 'An earlier row of this sheet already claims this entry.',
    };
  }
  return null;
}

/* --- contacts -------------------------------------------------------------- */

const PINCODE = /^[0-9]{6}$/;
const STATE_CODE = /^[0-9]{2}$/;
const DIVISION_CODE = /^[0-9]{2,5}$/;
const PAN = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/;

const CONTACT_COLUMNS: readonly TargetColumn[] = [
  {
    key: 'designation',
    header: 'Designation',
    kind: 'text',
    required: true,
    minLength: 2,
    maxLength: 200,
    example: 'Sr.DEE (G) Bhusawal',
    note: 'Required. The office or firm as it is written on the paperwork.',
  },
  {
    key: 'contactPerson',
    header: 'Contact person',
    kind: 'text',
    minLength: 2,
    maxLength: 200,
    example: 'R. Sharma',
    note: 'Optional.',
  },
  {
    key: 'address',
    header: 'Address',
    kind: 'text',
    minLength: 3,
    maxLength: 1000,
    example: 'DRM Office, Bhusawal, Maharashtra',
    note: 'Optional. Two contacts may share a designation only if their addresses differ.',
  },
  {
    key: 'phone',
    header: 'Phone',
    kind: 'text',
    minLength: 3,
    maxLength: 30,
    example: '02582-222333',
    note: 'Optional.',
  },
  {
    key: 'email',
    header: 'Email',
    kind: 'text',
    minLength: 3,
    maxLength: 200,
    example: 'sr.dee.bsl@example.railnet.gov.in',
    note: 'Optional. One address only, with no note beside it.',
  },
  {
    key: 'gstin',
    header: 'GSTIN',
    kind: 'text',
    example: '27AAAPZ1234C1ZV',
    note: 'Optional. 15 characters, or a railway deductor GSTIN ending in D.',
  },
  {
    key: 'pincode',
    header: 'PIN code',
    kind: 'text',
    pattern: PINCODE,
    patternMessage: 'The PIN code must be exactly six digits.',
    example: '425201',
    note: 'Optional. Six digits.',
  },
  {
    key: 'stateCode',
    header: 'State code',
    kind: 'text',
    pattern: STATE_CODE,
    patternMessage: 'The state code must be exactly two digits.',
    example: '27',
    note: 'Optional. Two digits, as in the first two characters of a GSTIN.',
  },
  {
    key: 'locality',
    header: 'Locality',
    kind: 'text',
    minLength: 2,
    maxLength: 100,
    example: 'Bhusawal',
    note: 'Optional.',
  },
  {
    key: 'divisionCode',
    header: 'Division code',
    kind: 'text',
    pattern: DIVISION_CODE,
    patternMessage: 'The division code must be two to five digits.',
    example: '03',
    note: 'Optional. Two to five digits.',
  },
  {
    key: 'isVendor',
    header: 'Vendor',
    kind: 'boolean',
    example: 'no',
    note: 'yes or no. A row that is neither vendor nor client is recorded as a consignee.',
  },
  {
    key: 'isClient',
    header: 'Client',
    kind: 'boolean',
    example: 'no',
    note: 'yes or no.',
  },
  {
    key: 'isEmployee',
    header: 'Employee',
    kind: 'boolean',
    example: 'no',
    note: 'yes or no.',
  },
  {
    key: 'pan',
    header: 'PAN',
    kind: 'text',
    pattern: PAN,
    patternMessage:
      'The PAN must be ten characters: five letters, four digits, then a letter.',
    example: 'AAAPZ1234C',
    note: 'Optional.',
  },
  {
    key: 'bankAccountHolder',
    header: 'Bank account holder',
    kind: 'text',
    minLength: 2,
    maxLength: 200,
    example: 'Punya Nagari Engineering',
    note: 'Fill the four bank columns together, or leave all four blank.',
  },
  {
    key: 'bankName',
    header: 'Bank name',
    kind: 'text',
    minLength: 2,
    maxLength: 100,
    example: 'State Bank of India',
    note: 'Part of the bank set.',
  },
  {
    key: 'bankAccountNumber',
    header: 'Bank account number',
    kind: 'text',
    example: '30123456789',
    note: 'Part of the bank set. Spaces and hyphens are removed.',
  },
  {
    key: 'bankIfsc',
    header: 'IFSC',
    kind: 'text',
    example: 'SBIN0000300',
    note: 'Part of the bank set. Eleven characters as printed on the cheque leaf.',
  },
  {
    key: 'bankBranch',
    header: 'Bank branch',
    kind: 'text',
    minLength: 2,
    maxLength: 100,
    example: 'Bhusawal Main',
    note: 'Optional, even when the four bank columns are filled.',
  },
  {
    key: 'bankAccountType',
    header: 'Bank account type',
    kind: 'text',
    minLength: 2,
    maxLength: 50,
    example: 'Current',
    note: 'Optional.',
  },
];

interface ContactRow extends BuiltRow {
  readonly designation: string;
  readonly contactPerson: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly gstin: string | null;
  readonly pincode: string | null;
  readonly stateCode: string | null;
  readonly locality: string | null;
  readonly divisionCode: string | null;
  readonly isConsignee: boolean;
  readonly isVendor: boolean;
  readonly isClient: boolean;
  readonly isEmployee: boolean;
  readonly pan: string | null;
  readonly bank: {
    readonly holder: string | null;
    readonly bankName: string | null;
    readonly accountNumber: string | null;
    readonly ifsc: string | null;
    readonly branch: string | null;
    readonly accountType: string | null;
  };
}

/** `''` means "the operator left the column blank", which the register
 * stores as NULL rather than as an empty string. */
function orNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The active-contacts unique index is on `(lower(designation),
 * lower(coalesce(address, '')))`. Mirrored here so the duplicate a person
 * is warned about is exactly the duplicate the database would refuse. */
function contactKey(designation: string, address: string | null): string {
  return `${designation.toLowerCase()} ${(address ?? '').toLowerCase()}`;
}

const CONTACTS_TARGET: ImportTarget = {
  key: 'contacts',
  label: 'Contacts',
  sheetName: 'Contacts',
  columns: CONTACT_COLUMNS,
  duplicateMessage:
    'An active contact with this designation and address already exists in the register.',

  existingKeys: async (tx) => {
    const rows = await tx<{ designation: string; address: string | null }[]>`
      select designation, address from contacts where active
    `;
    return new Set(rows.map((row) => contactKey(row.designation, row.address)));
  },

  validate: (cells, context) => {
    const read = readCells(CONTACT_COLUMNS, cells);
    if ('errors' in read) return { errors: read.errors };
    const values = read.values;
    const errors: RowError[] = [];

    const designation = values.designation as string;
    const address = orNull(values.address);
    const isVendor = values.isVendor as boolean;
    const isClient = values.isClient as boolean;
    // Role resolution is the route's, verbatim (routes/masters.ts): a row
    // naming neither is a consignee, and rule R16's refusal applies
    // exactly when the contact will be one — a vendor may carry whatever
    // name its letterhead does.
    const isConsignee = !isVendor && !isClient;
    if (isConsignee) {
      const checked = attribute('designation', () => {
        assertNotAuthorityDesignation(designation);
      });
      if ('error' in checked) errors.push(checked.error);
    }

    const gstin = attribute('gstin', () => normaliseGstin(orNull(values.gstin)));
    if ('error' in gstin) errors.push(gstin.error);
    const email = attribute('email', () => normaliseEmail(orNull(values.email)));
    if ('error' in email) errors.push(email.error);

    // The four payable fields are a set, and the set's rule is checked
    // over the NORMALISED values — the same order `normaliseContactBankDetails`
    // uses, so "three of four filled" is refused with the register's own
    // sentence rather than reaching the database as a shape violation.
    const account = attribute('bankAccountNumber', () =>
      normaliseBankAccountNumber(orNull(values.bankAccountNumber)),
    );
    if ('error' in account) errors.push(account.error);
    const ifsc = attribute('bankIfsc', () => normaliseIfsc(orNull(values.bankIfsc)));
    if ('error' in ifsc) errors.push(ifsc.error);
    if (!('error' in account) && !('error' in ifsc)) {
      const set = attribute('bankAccountHolder', () => {
        assertBankDetailsComplete({
          holder: orNull(values.bankAccountHolder),
          bankName: orNull(values.bankName),
          accountNumber: account.value,
          ifsc: ifsc.value,
        });
      });
      if ('error' in set) errors.push(set.error);
    }

    const naturalKey = contactKey(designation, address);
    const duplicate = duplicateError(
      naturalKey,
      'designation',
      context,
      CONTACTS_TARGET.duplicateMessage,
    );
    if (duplicate !== null) errors.push(duplicate);

    if (errors.length > 0) return { errors };
    return {
      naturalKey,
      row: {
        designation,
        contactPerson: orNull(values.contactPerson),
        address,
        phone: orNull(values.phone),
        email: 'value' in email ? email.value : null,
        gstin: 'value' in gstin ? gstin.value : null,
        pincode: orNull(values.pincode),
        stateCode: orNull(values.stateCode),
        locality: orNull(values.locality),
        divisionCode: orNull(values.divisionCode),
        isConsignee,
        isVendor,
        isClient,
        isEmployee: values.isEmployee,
        pan: orNull(values.pan)?.toUpperCase() ?? null,
        bank: normaliseContactBankDetails({
          ...(orNull(values.bankAccountHolder) !== null
            ? { bankAccountHolder: values.bankAccountHolder as string }
            : {}),
          ...(orNull(values.bankName) !== null
            ? { bankName: values.bankName as string }
            : {}),
          ...(orNull(values.bankAccountNumber) !== null
            ? { bankAccountNumber: values.bankAccountNumber as string }
            : {}),
          ...(orNull(values.bankIfsc) !== null
            ? { bankIfsc: values.bankIfsc as string }
            : {}),
          ...(orNull(values.bankBranch) !== null
            ? { bankBranch: values.bankBranch as string }
            : {}),
          ...(orNull(values.bankAccountType) !== null
            ? { bankAccountType: values.bankAccountType as string }
            : {}),
        }),
      },
    };
  },

  insert: async (tx, organisationId, userId, built) => {
    const row = built as ContactRow;
    const [inserted] = await tx<{ id: string }[]>`
      insert into contacts (
        organisation_id, designation, contact_person, address, phone,
        email, gstin, pincode, state_code, locality, division_code, is_consignee,
        is_vendor, is_client, bank_account_holder, bank_name,
        bank_account_number, bank_ifsc, bank_branch, bank_account_type,
        is_employee, pan, created_by_user_id
      )
      values (
        ${organisationId}, ${row.designation}, ${row.contactPerson}, ${row.address},
        ${row.phone}, ${row.email}, ${row.gstin}, ${row.pincode}, ${row.stateCode},
        ${row.locality}, ${row.divisionCode}, ${row.isConsignee}, ${row.isVendor},
        ${row.isClient}, ${row.bank.holder}, ${row.bank.bankName},
        ${row.bank.accountNumber}, ${row.bank.ifsc}, ${row.bank.branch},
        ${row.bank.accountType}, ${row.isEmployee}, ${row.pan}, ${userId}
      )
      returning id
    `;
    if (!inserted) throw new Error('contact insert returned no row');
    return inserted.id;
  },
};

/* --- canonical items ------------------------------------------------------- */

const CANONICAL_ITEM_COLUMNS: readonly TargetColumn[] = [
  {
    key: 'name',
    header: 'Item name',
    kind: 'text',
    required: true,
    minLength: 2,
    maxLength: 200,
    example: 'Point Machine IRS M 24',
    note: 'Required. Unique in the catalogue, whether or not the item is retired.',
  },
  {
    key: 'groupName',
    header: 'Group',
    kind: 'text',
    required: true,
    minLength: 2,
    maxLength: 100,
    example: 'Signalling',
    note: 'Required. Free text — the catalogue groups by whatever you write here.',
  },
  {
    key: 'make',
    header: 'Make',
    kind: 'text',
    minLength: 1,
    maxLength: 100,
    example: 'Siemens',
    note: 'Optional.',
  },
  {
    key: 'model',
    header: 'Model',
    kind: 'text',
    minLength: 1,
    maxLength: 100,
    example: 'IRSM-24',
    note: 'Optional.',
  },
  {
    key: 'defaultUnit',
    header: 'Default unit',
    kind: 'text',
    required: true,
    minLength: 1,
    maxLength: 20,
    example: 'Nos',
    note: 'Required. Free text — Nos, Set, Metre, and so on.',
  },
  {
    key: 'aliases',
    header: 'Aliases',
    kind: 'list',
    maxLength: 200,
    example: 'point machine; IRS M24; PM-24',
    note: 'Optional. Separate with semicolons, not commas. Up to 50, matched case-insensitively.',
  },
];

interface CanonicalItemRow extends BuiltRow {
  readonly name: string;
  readonly groupName: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly defaultUnit: string;
  readonly aliases: readonly string[];
}

const CANONICAL_ITEMS_TARGET: ImportTarget = {
  key: 'canonical_items',
  label: 'Catalogue items',
  sheetName: 'Catalogue items',
  columns: CANONICAL_ITEM_COLUMNS,
  // Deliberately different from the Contacts sentence. `canonical_items`
  // is unique outright, not only among active rows, so a retired item is
  // reactivated rather than re-created — and an operator told the wrong
  // one of those two things will delete and re-upload for an hour.
  duplicateMessage:
    'The catalogue already holds an item with this name; it may be retired, in which case reactivate it instead of importing it again.',

  existingKeys: async (tx) => {
    const rows = await tx<{ name: string }[]>`select name from canonical_items`;
    return new Set(rows.map((row) => row.name.trim().toLowerCase()));
  },

  validate: (cells, context) => {
    const read = readCells(CANONICAL_ITEM_COLUMNS, cells);
    if ('errors' in read) return { errors: read.errors };
    const values = read.values;
    const errors: RowError[] = [];

    const name = values.name as string;
    // `normaliseAliases` in routes/masters.ts is trim, lower-case, drop
    // blanks, de-duplicate. The `list` cell reader above has already
    // trimmed and dropped the blanks, so what is left of it is one line.
    // Migration 0078 caps the array at 50 and refuses an empty element;
    // the cap is checked here so the refusal names the column.
    const aliases = [
      ...new Set((values.aliases as string[]).map((alias) => alias.toLowerCase())),
    ];
    if (aliases.length > 50) {
      errors.push({
        column: 'aliases',
        message: `An item takes at most 50 aliases; this row has ${String(aliases.length)}.`,
      });
    }

    const naturalKey = name.trim().toLowerCase();
    const duplicate = duplicateError(
      naturalKey,
      'name',
      context,
      CANONICAL_ITEMS_TARGET.duplicateMessage,
    );
    if (duplicate !== null) errors.push(duplicate);

    if (errors.length > 0) return { errors };
    return {
      naturalKey,
      row: {
        name,
        groupName: values.groupName,
        make: orNull(values.make),
        model: orNull(values.model),
        defaultUnit: values.defaultUnit,
        aliases,
      },
    };
  },

  insert: async (tx, organisationId, userId, built) => {
    const row = built as CanonicalItemRow;
    const [inserted] = await tx<{ id: string }[]>`
      insert into canonical_items (
        organisation_id, name, group_name, make, model, default_unit,
        aliases, created_by_user_id
      )
      values (
        ${organisationId}, ${row.name}, ${row.groupName}, ${row.make}, ${row.model},
        ${row.defaultUnit}, ${tx.array([...row.aliases])}, ${userId}
      )
      returning id
    `;
    if (!inserted) throw new Error('canonical item insert returned no row');
    return inserted.id;
  },
};

/* --- the registry ---------------------------------------------------------- */

/**
 * Every register a spreadsheet may be pointed at.
 *
 * The keys are migration 0094's `target` CHECK, and the two agree by
 * inspection rather than by mechanism: the database refuses a value that
 * is not in its own list, and this map refuses one that is not in its.
 * A target added to one and not the other is dead in both directions —
 * unreachable if only the database has it, refused at insert if only this
 * has it — which is the failure mode worth having.
 */
export const IMPORT_TARGETS: Readonly<Record<string, ImportTarget>> = {
  [CONTACTS_TARGET.key]: CONTACTS_TARGET,
  [CANONICAL_ITEMS_TARGET.key]: CANONICAL_ITEMS_TARGET,
};

/**
 * The three rows of a downloadable template.
 *
 * Header, worked example, notes — in that order, because a sheet whose
 * SECOND row is prose is a sheet where the operator types over the prose.
 * The example is row 2 so it can be overtyped directly, and the notes sit
 * beneath everything as the thing you read once and then delete.
 *
 * The importer skips neither: row 2 and row 3 of a returned template are
 * ordinary rows and will be validated like any other. That is deliberate
 * — a template returned unedited should produce a visible, explicable
 * verdict rather than silently importing an example contact.
 */
export function templateRows(target: ImportTarget): string[][] {
  return [
    target.columns.map((column) => column.header),
    target.columns.map((column) => column.example),
    target.columns.map((column) => column.note),
  ];
}
