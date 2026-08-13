/**
 * Document number templates, defined by the organisation.
 *
 * Six documents let their format be configured — the delivery challan,
 * the standalone delivery challan, the issue challan, the tax invoice,
 * the credit note and the budgetary quotation. Every other numbered
 * document keeps its fixed format; a template engine pointed at documents
 * nobody asked to re-format is surface area with no demand behind it.
 *
 * An organisation that configures nothing keeps exactly the numbers it
 * has always had: DEFAULT_TEMPLATES below are the strings the routes used
 * to build by hand, written out as templates.
 *
 * The tokens exist because a real series needed each one. The owner's
 * invoice series is `P{DIV}{FY2}{SEQ:3}` — their letter, the railnet
 * division code less its trailing zero, the financial year, and a
 * three-digit serial — but that is one CONFIGURATION, not a rule of the
 * trade, which is exactly why it lives in their row and not in this file.
 */

import type { TransactionSql } from '@auto-mb/db';

export const NUMBERED_DOCUMENT_TYPES = [
  'delivery_challan',
  'issue_challan',
  'tax_invoice',
  'budgetary_quotation',
  'credit_note',
  'standalone_challan',
] as const;

export type NumberedDocumentType = (typeof NUMBERED_DOCUMENT_TYPES)[number];

/** What each document numbered before the series table existed. Changing
 * one of these changes the numbers of every organisation that has not
 * configured its own — treat them as the compatibility contract they
 * are. */
export const DEFAULT_TEMPLATES: Readonly<Record<NumberedDocumentType, string>> =
  Object.freeze({
    delivery_challan: '{PREFIX}/{SEQ}',
    issue_challan: '{PREFIX}/{SEQ}',
    tax_invoice: 'TI/{FY}/{SEQ:3}',
    budgetary_quotation: 'BQ-{SEQ:2}',
    credit_note: 'CN/{FY}/{SEQ:3}',
    // The standalone challan is new in 0056, so this is a CHOICE rather
    // than a compatibility contract, made on three grounds. It carries
    // {FY} because the counter restarts each financial year while
    // challan_number is unique across the organisation — the default must
    // not be the one shape that wedges the series at the year boundary
    // (finding 8). It reads 'DC' because that is what the trade calls the
    // paper the consignee signs, and a standalone challan is handed to a
    // private customer who has never heard of a Work code. Three digits
    // matches the tax invoice's {SEQ:3}: a year's factory movements are
    // hundreds, not tens.
    standalone_challan: 'DC/{FY}/{SEQ:3}',
  });

/** The values a template may draw on. Absent ones make their token
 * unusable in that document's template — a delivery challan has no
 * buyer division, and a template asking for one is refused when it is
 * SAVED rather than when a document is issued. */
export interface NumberTokens {
  /** The Work's code, for a document that belongs to one. */
  readonly work?: string | null;
  /** The document's own stored prefix (delivery and issue challans keep
   * one per Work). */
  readonly prefix?: string | null;
  /** The buyer/consignee's railway division code, as the railnet
   * directory writes it. {DIV} drops one trailing zero from it. */
  readonly divisionCode?: string | null;
  /** '2026-27'. */
  readonly financialYear?: string | null;
  /** The document's own date, YYYY-MM-DD, for {YYYY} and {YY}. */
  readonly documentDate?: string | null;
  /** The counter value. Always present — every template must consume
   * it, or the series would mint one string for every document. */
  readonly sequence: number;
}

/**
 * The {DIV} token: the directory's division code without ONE trailing
 * zero. 100 -> 10, 140 -> 14.
 *
 * A code that does not end in zero is used as it stands rather than
 * having its last digit eaten — the rule is "drop the trailing zero",
 * and a code without one has nothing to drop.
 */
export function divisionToken(divisionCode: string): string {
  return divisionCode.endsWith('0') && divisionCode.length > 1
    ? divisionCode.slice(0, -1)
    : divisionCode;
}

/** Token names carry digits — {FY2} — so the name is a letter followed
 * by letters or digits, never `[A-Z]+`, which would leave {FY2} unmatched
 * and report it as a malformed brace. Both repetitions are BOUNDED: no
 * real token name is twelve characters and no padding width is three
 * digits, and an unbounded quantifier here is a needless invitation to
 * pathological backtracking on operator-supplied text. */
const TOKEN_PATTERN = /\{([^{}]{1,20})\}/g;

/** Split a token body into its name and optional width: 'SEQ:3' becomes
 * ['SEQ', '3']. Done in code rather than in the pattern because a regex
 * that expressed both alternatives inline is ambiguous enough to be a
 * backtracking hazard on operator-supplied text. */
function splitToken(body: string): { name: string; width: string | undefined } {
  const colon = body.indexOf(':');
  if (colon === -1) return { name: body, width: undefined };
  return { name: body.slice(0, colon), width: body.slice(colon + 1) };
}

/** Every token name a template may use. Anything else is a typo, and
 * saying so when the template is saved beats minting `{DIVISON}` onto a
 * legal document. */
const KNOWN_TOKENS = new Set([
  'WORK',
  'PREFIX',
  'DIV',
  'FY',
  'FY2',
  'YYYY',
  'YY',
  'SEQ',
]);

export class NumberTemplateError extends Error {}

/**
 * Expand a template against its tokens.
 *
 * Throws NumberTemplateError when a token the template uses has no value
 * — which the caller turns into a named 400 rather than a number with a
 * hole in it. Numbers are legal identifiers; half of one is worse than
 * none.
 */
export function renderNumberTemplate(template: string, tokens: NumberTokens): string {
  return template.replace(TOKEN_PATTERN, (whole, body: string) => {
    const { name, width } = splitToken(body);
    switch (name) {
      case 'SEQ': {
        const padding = width === undefined || width === '' ? 1 : Number(width);
        return String(tokens.sequence).padStart(padding, '0');
      }
      case 'WORK':
        return required(tokens.work, whole, 'this document belongs to no Work');
      case 'PREFIX':
        return required(tokens.prefix, whole, 'this document has no prefix');
      case 'DIV':
        return divisionToken(
          required(
            tokens.divisionCode,
            whole,
            'the party on this document has no division code — set it on the contact',
          ),
        );
      case 'FY':
        return required(
          tokens.financialYear,
          whole,
          'this document has no financial year',
        );
      case 'FY2':
        // '2026-27' -> '26': the year the financial year opens in.
        return required(
          tokens.financialYear,
          whole,
          'this document has no financial year',
        ).slice(2, 4);
      case 'YYYY':
        return required(tokens.documentDate, whole, 'this document has no date').slice(
          0,
          4,
        );
      case 'YY':
        return required(tokens.documentDate, whole, 'this document has no date').slice(
          2,
          4,
        );
      default:
        // Unreachable: assertValidTemplate refuses unknown tokens when
        // the template is saved, and the defaults use known ones.
        throw new NumberTemplateError(`${whole} is not a number template token.`);
    }
  });
}

function required(
  value: string | null | undefined,
  token: string,
  why: string,
): string {
  if (value === null || value === undefined || value === '') {
    throw new NumberTemplateError(`${token} cannot be filled in: ${why}.`);
  }
  return value;
}

/**
 * Check a template before it is stored, so a malformed one is a 400 on
 * the settings screen rather than a failure at the moment a document is
 * issued — by which point the operator has a finished document and no
 * number to put on it.
 *
 * Beyond shape, the template must carry its counter's SCOPE. Counters
 * are narrower than the uniqueness key — delivery and issue challans
 * count per Work, tax invoices per financial year, while the unique
 * constraint is organisation-wide — so a scope-free template such as
 * `{SEQ}` or `TI/{SEQ}` would mint the same number again from the
 * second Work or the second financial year onward. Because the counter
 * update rolls back with the failed issue, every retry then requests
 * the same number: the series wedges at issue time, with a finished
 * document in hand and only a settings change able to clear it.
 * Refusing the template here, where the fix IS a settings change, is
 * the remediation of finding 8 in
 * `docs/AUDIT-DISPOSITION-2026-08-10.md`; migration 0047 binds the same
 * rule against direct SQL.
 */
export function assertValidTemplate(
  template: string,
  documentType: NumberedDocumentType,
): void {
  const allowed = ALLOWED_TOKENS[documentType];
  const trimmed = template.trim();
  if (trimmed.length === 0) {
    throw new NumberTemplateError('A number template cannot be blank.');
  }
  const unbalanced = trimmed.replace(TOKEN_PATTERN, '');
  if (unbalanced.includes('{') || unbalanced.includes('}')) {
    throw new NumberTemplateError(
      'A number template has an unclosed or malformed token; tokens look like {SEQ:3}.',
    );
  }
  let usesSequence = false;
  const used = new Set<string>();
  for (const match of trimmed.matchAll(TOKEN_PATTERN)) {
    const { name, width } = splitToken(match[1] ?? '');
    if (!KNOWN_TOKENS.has(name)) {
      throw new NumberTemplateError(
        `{${name}} is not a number template token. Available: ${[...KNOWN_TOKENS]
          .map((token) => `{${token}}`)
          .join(', ')}.`,
      );
    }
    if (!allowed.has(name)) {
      throw new NumberTemplateError(
        `{${name}} is not available on this document — it has no such value to fill in.`,
      );
    }
    used.add(name);
    if (name === 'SEQ') {
      usesSequence = true;
      if (
        width !== undefined &&
        (!/^[0-9]{1,2}$/.test(width) || Number(width) < 1 || Number(width) > 12)
      ) {
        throw new NumberTemplateError(
          'A {SEQ:n} width must be between 1 and 12 digits.',
        );
      }
    }
  }
  if (!usesSequence) {
    throw new NumberTemplateError(
      'A number template must use {SEQ}, or every document would take the same number.',
    );
  }
  const scope = SCOPE_TOKENS[documentType];
  if (scope.tokens.length > 0 && !scope.tokens.some((token) => used.has(token))) {
    throw new NumberTemplateError(
      `This template must include ${scope.tokens
        .map((token) => `{${token}}`)
        .join(' or ')}: ${scope.why}.`,
    );
  }
}

/** What each document type can fill in. The delivery and issue challans
 * are numbered per Work under a stored prefix and carry no financial
 * year of their own; the budgetary quotation belongs to no Work at all;
 * the tax invoice may or may not, so {WORK} is not offered to it. */
export const ALLOWED_TOKENS: Readonly<
  Record<NumberedDocumentType, ReadonlySet<string>>
> = Object.freeze({
  delivery_challan: new Set(['WORK', 'PREFIX', 'SEQ', 'YYYY', 'YY']),
  issue_challan: new Set(['WORK', 'PREFIX', 'SEQ', 'YYYY', 'YY']),
  tax_invoice: new Set(['PREFIX', 'DIV', 'FY', 'FY2', 'YYYY', 'YY', 'SEQ']),
  budgetary_quotation: new Set(['SEQ', 'YYYY', 'YY']),
  // The credit note numbers exactly like the invoice it supersedes: the
  // prefix and buyer division come from the invoice, the financial year
  // from the note's own date.
  credit_note: new Set(['PREFIX', 'DIV', 'FY', 'FY2', 'YYYY', 'YY', 'SEQ']),
  // {WORK} is deliberately absent: a standalone challan belongs to no
  // Work, so the token could never be filled and offering it would only
  // produce an issue-time refusal on a finished document.
  standalone_challan: new Set(['PREFIX', 'FY', 'FY2', 'YYYY', 'YY', 'SEQ']),
});

/** The tokens that widen a template to its counter's scope, per document
 * type. A template must use at least one of them (finding 8).
 *
 * Challans: the counter runs per Work, so the template needs a per-Work
 * mark. {WORK} is structural — work codes are unique per organisation.
 * {PREFIX} is the historical default's mark: the prefix is operator
 * text, so two Works CAN share one, but the draft's prefix is editable
 * and the issue-time 409 names that way out — the series never wedges.
 *
 * Tax invoices: the counter restarts each financial year, so the
 * template needs the year. {YYYY}/{YY} deliberately do not qualify:
 * they follow the document date's CALENDAR year, which straddles the
 * financial-year boundary — an invoice of FY 2026-27 dated January 2027
 * and one of FY 2027-28 dated May 2027 would both render 2027 with a
 * restarted counter, and collide.
 *
 * Budgetary quotations count per organisation, exactly as wide as their
 * uniqueness key, so any template that consumes {SEQ} is safe. */
const SCOPE_TOKENS: Readonly<
  Record<NumberedDocumentType, { tokens: readonly string[]; why: string }>
> = Object.freeze({
  delivery_challan: {
    tokens: ['WORK', 'PREFIX'],
    why: 'delivery challans count per Work while their numbers are unique across the organisation, so without a per-Work mark a second Work would repeat the first one’s numbers and the series would jam at issue time',
  },
  issue_challan: {
    tokens: ['WORK', 'PREFIX'],
    why: 'issue challans count per Work while their numbers are unique across the organisation, so without a per-Work mark a second Work would repeat the first one’s numbers and the series would jam at issue time',
  },
  tax_invoice: {
    tokens: ['FY', 'FY2'],
    why: 'tax invoices count per financial year while their numbers are unique across the organisation, so without the financial year a second year would repeat the first one’s numbers — and {YYYY}/{YY} follow the calendar year, which straddles the financial-year boundary',
  },
  budgetary_quotation: { tokens: [], why: '' },
  // Standalone challans count per financial year, so {FY}/{FY2} is the
  // structural mark. {PREFIX} is admitted on the footing 0047 gives it to
  // the work challan: the prefix is operator text on an EDITABLE draft, so
  // a repeat answers as a named 409 at issue time with the prefix as the
  // way out, and the series never wedges. It is the weaker of the two —
  // scoping only by prefix means changing it every April — which is why
  // DEFAULT_TEMPLATES uses {FY}. {YYYY}/{YY} still do not qualify: they
  // follow the calendar year, which straddles the financial-year boundary.
  standalone_challan: {
    tokens: ['FY', 'FY2', 'PREFIX'],
    why: 'standalone challans count per financial year while their numbers are unique across the organisation, so without the financial year a second year would repeat the first one’s numbers — {YYYY}/{YY} follow the calendar year, which straddles the financial-year boundary, and {PREFIX} qualifies only because the draft prefix can be changed when a repeat is refused at issue time',
  },
  credit_note: {
    tokens: ['FY', 'FY2'],
    why: 'credit notes count per financial year while their numbers are unique across the organisation, so without the financial year a second year would repeat the first one’s numbers — and {YYYY}/{YY} follow the calendar year, which straddles the financial-year boundary',
  },
});

/**
 * The organisation's template for a document type, or the product
 * default when it has configured none.
 *
 * Read inside the issuing transaction, under the same tenant binding as
 * everything else, so a template edited mid-issue cannot half-apply.
 */
export async function loadNumberTemplate(
  tx: TransactionSql,
  documentType: NumberedDocumentType,
): Promise<string> {
  const rows = await tx<{ template: string }[]>`
    select template from document_number_series
    where document_type = ${documentType}
  `;
  return rows[0]?.template ?? DEFAULT_TEMPLATES[documentType];
}
