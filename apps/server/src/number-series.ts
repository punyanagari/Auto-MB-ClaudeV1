/**
 * Document number templates, defined by the organisation.
 *
 * Four documents let their format be configured — the delivery challan,
 * the issue challan, the tax invoice and the budgetary quotation. Every
 * other numbered document keeps its fixed format; a template engine
 * pointed at documents nobody asked to re-format is surface area with no
 * demand behind it.
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
 * `allowed` is the token set this document type can actually supply.
 *
 * This validates the template's SHAPE only; it does not prove the
 * template can mint unique numbers. Counters are narrower than the
 * uniqueness key — delivery and issue challans count per Work, tax
 * invoices per financial year, while the unique constraint is
 * organisation-wide — so a scope-free template such as `{SEQ}` or
 * `TI/{SEQ}` is accepted here and then collides on the second Work or
 * the second financial year. Because the counter update rolls back with
 * the failed transaction, the series stays wedged until the template is
 * changed. Making this validation scope-aware is finding 8 in
 * `docs/AUDIT-DISPOSITION-2026-08-10.md`.
 */
export function assertValidTemplate(
  template: string,
  allowed: ReadonlySet<string>,
): void {
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
