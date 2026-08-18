import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, UuidSchema } from './primitives.js';

/**
 * Tenant-wide record search — what the header control labelled "Search
 * Works and records" has to actually do.
 *
 * The registers a clerk reaches for by number or party: Works, delivery
 * challans, issue challans, tax invoices, credit notes, budgetary
 * quotations and purchase orders. Serial numbers are deliberately NOT here
 * — they have their own lookup with its own result shape (delivery,
 * receipt and installation lineage per serial), and duplicating a thinner
 * version of it inside this response would be a second, worse answer to
 * the same question. The web client links into that module instead.
 *
 * Measurement Books are absent for a different reason: a Measurement Book
 * has no title, party or description to match on, only a number and a
 * date, and its number is already reachable from the invoice rows that
 * cite it.
 */

/** The registers a result can come from. */
const SearchResultKindSchema = Type.Union([
  Type.Literal('work'),
  Type.Literal('delivery-challan'),
  Type.Literal('issue-challan'),
  Type.Literal('tax-invoice'),
  Type.Literal('credit-note'),
  Type.Literal('quotation'),
  Type.Literal('purchase-order'),
]);
export type SearchResultKind = Static<typeof SearchResultKindSchema>;

export const SearchQuerySchema = Type.Object(
  {
    q: Type.String({
      minLength: 2,
      maxLength: 120,
      description:
        'Case-insensitive substring. Matched against document numbers, Work codes and titles, and the party each document names.',
    }),
  },
  { additionalProperties: false },
);

const SearchResultSchema = Type.Object(
  {
    kind: SearchResultKindSchema,
    id: UuidSchema,
    /** What the row leads with: the document number, or the Work code.
     * A draft has no number yet, so this falls back to a stable label
     * naming the draft rather than rendering an empty cell. */
    label: Type.String(),
    /** The human line under the label: the Work title, the service or
     * subject, the party. Never empty. */
    detail: Type.String(),
    /** Lifecycle status as the register itself names it, so the result
     * cannot imply a draft is issued. */
    status: Type.String(),
    /** The document's own date, where it has one. */
    date: Type.Union([DateOnlySchema, Type.Null()]),
    /** The Work this belongs to, for the link. Null for the registers
     * that legitimately stand outside a Work: quotations always, and a
     * direct tax invoice or its credit note. */
    workId: Type.Union([UuidSchema, Type.Null()]),
    /** The Work's code, when there is a Work — shown as context. */
    workCode: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type SearchResult = Static<typeof SearchResultSchema>;

const SearchGroupSchema = Type.Object(
  {
    kind: SearchResultKindSchema,
    results: Type.Array(SearchResultSchema),
    /** True when this register held more matches than the per-register
     * cap returned. The count is deliberately absent: an exact total
     * would cost a second scan of every register on every keystroke. */
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type SearchGroup = Static<typeof SearchGroupSchema>;

export const SearchResponseSchema = Type.Object(
  {
    /** The query as it was actually applied, after trimming. */
    query: Type.String(),
    /** Non-empty groups only, in a fixed register order. */
    groups: Type.Array(SearchGroupSchema),
    /** Total returned across the groups — not the total that matched. */
    returned: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type SearchResponse = Static<typeof SearchResponseSchema>;
