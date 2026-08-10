import { Type, type Static, type TString } from '@sinclair/typebox';

export const UuidSchema = Type.String({ format: 'uuid' });
export type Uuid = Static<typeof UuidSchema>;

/* A REAL calendar date, not merely a YYYY-MM-DD shape: month and day
 * ranges are held, and 29 February is admitted only in a leap year. A
 * shape-only pattern let '2026-02-31' and '2026-00-10' through every
 * application gate — '2026-02-31' even compares LATER than '2026-02-28'
 * in the routes' string comparisons, so it passed the "must extend the
 * current completion date" and "not in the future" checks — and failed
 * only when Postgres cast it, which reaches the caller as a 500.
 * Assembled from named parts so the leap-year branch stays readable. */
const YEAR = '[1-9]\\d{3}';
const THIRTY_ONE_DAY_MONTH = '(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])';
const THIRTY_DAY_MONTH = '(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)';
const FEBRUARY = '02-(?:0[1-9]|1\\d|2[0-8])';
/** Divisible by four and not by a hundred, or divisible by four hundred. */
const LEAP_YEAR =
  '(?:[1-9]\\d(?:0[48]|[2468][048]|[13579][26])|(?:[2468][048]|[13579][26])00)';

export const DateOnlySchema = Type.String({
  pattern: `^(?:${YEAR}-(?:${THIRTY_ONE_DAY_MONTH}|${THIRTY_DAY_MONTH}|${FEBRUARY})|${LEAP_YEAR}-02-29)$`,
  description: 'Calendar date with no time or timezone.',
});
export type DateOnly = Static<typeof DateOnlySchema>;

export const DecimalStringSchema = Type.String({
  pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,3})?$',
  description:
    'Decimal value transported as a string; authoritative arithmetic is not binary floating point.',
});
export type DecimalString = Static<typeof DecimalStringSchema>;

/** RATE fields carry up to six fraction digits (rate columns are
 * numeric(18,6); v1 agreement rates run to 0.8517/mtr and finer).
 * Quantities and money amounts keep the 3dp DecimalString shape. */
export const RateStringSchema = Type.String({
  pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,6})?$',
  description:
    'Rate value transported as a string with up to six fraction digits; authoritative arithmetic is not binary floating point.',
});
export type RateString = Static<typeof RateStringSchema>;

/* --- Bounded variants -------------------------------------------------
 * The database already refuses a zero quantity, a negative value, and a
 * number too wide for its column. What it cannot do is say so usefully:
 * a CHECK violation (23514) and a numeric overflow (22003) carry no HTTP
 * status, so the caller gets a 500 'The request could not be completed.'
 * with no field named while the real reason lands only in the server log.
 * These variants refuse the same values at the API boundary, where the
 * validator names the offending field — and, inside an array, its index.
 * The integer-digit ceilings are the storage columns' own: numeric(18,3)
 * holds fifteen, numeric(18,6) twelve. */

/** Strictly positive, up to three fraction digits — awarded quantities,
 * measured quantities (PRODUCT.md invariant 6). '0' and '0.000' are
 * refused here; the amendment paths, where quantity '0' MEANS "omit the
 * item", keep the unbounded DecimalString on purpose. */
export const PositiveDecimalStringSchema = Type.String({
  pattern:
    '^(?:[1-9]\\d{0,14}(?:\\.\\d{1,3})?|0\\.(?:[1-9]\\d{0,2}|0[1-9]\\d?|00[1-9]))$',
  description:
    'Strictly positive decimal transported as a string; up to three fraction digits.',
});
export type PositiveDecimalString = Static<typeof PositiveDecimalStringSchema>;

/** Non-negative, up to three fraction digits — money values, whose
 * columns read `CHECK (… >= 0)`. Zero is a legitimate value; a minus
 * sign is not. */
export const NonNegativeDecimalStringSchema = Type.String({
  pattern: '^(?:0|[1-9]\\d{0,14})(?:\\.\\d{1,3})?$',
  description:
    'Non-negative decimal transported as a string; up to three fraction digits.',
});
export type NonNegativeDecimalString = Static<typeof NonNegativeDecimalStringSchema>;

/** Non-negative RATE — deliberately not positive. PRODUCT.md invariant 6
 * makes rates non-negative, and free-issue / nil-rate supply lines are
 * real, so '0' must keep working. */
export const NonNegativeRateStringSchema = Type.String({
  pattern: '^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,6})?$',
  description: 'Non-negative rate transported as a string; up to six fraction digits.',
});
export type NonNegativeRateString = Static<typeof NonNegativeRateStringSchema>;

/** A decimal that merely has to FIT its numeric(18,3) column. Sign and
 * floor stay with the route that owns the field — an issue-challan line
 * quantity of '0' still earns the route's QUANTITY_INVALID and its
 * message — so this only stops the sixteen-digit typo that used to reach
 * Postgres as a numeric field overflow and come back as a 500. */
export const StorableDecimalStringSchema = Type.String({
  pattern: '^-?(?:0|[1-9]\\d{0,14})(?:\\.\\d{1,3})?$',
  description:
    'Decimal value that fits its numeric(18,3) column: at most fifteen integer digits.',
});
export type StorableDecimalString = Static<typeof StorableDecimalStringSchema>;

/* --- Tax facts (migration 0033) ---------------------------------------
 * A GST tax invoice and an e-way bill cannot be built without them: the
 * IRP refuses an e-invoice line with no HSN/SAC code or no rate, and the
 * NIC payload names the supplier's state. Each carries exactly the bound
 * its column holds, so a mistyped code is a 400 naming the field rather
 * than a CHECK violation surfacing as an opaque 500. */

/** HSN (goods) or SAC (services) code: 6 to 8 digits — optional metadata
 * everywhere it appears, because the tax invoice is cumulative (one service
 * line at a SAC for the MB total), never per-item. Which reading
 * applies follows the item's `isService` flag, not the code's shape —
 * both are digits, and both columns hold the same CHECK. */
export const HsnCodeSchema = Type.String({
  pattern: '^[0-9]{6,8}$',
  description: 'HSN (goods) or SAC (services) code: 6 to 8 digits.',
});
export type HsnCode = Static<typeof HsnCodeSchema>;

/** Total GST percentage for a line, 0 to 100 inclusive, transported as a
 * string like every other authoritative number here. Two fraction digits
 * is the numeric(5,2) column's own scale — and a real bound, not a
 * formality: 0.25% and 1.5% are both notified rates, while a third digit
 * would be rounded away silently on the way in. Zero is legitimate
 * (exempt and nil-rated supply), a negative rate is not. */
export const GstRateSchema = Type.String({
  pattern: '^(?:100(?:\\.0{1,2})?|0(?:\\.\\d{1,2})?|[1-9]\\d?(?:\\.\\d{1,2})?)$',
  description:
    'GST percentage between 0 and 100 inclusive, with up to two fraction digits.',
});
export type GstRate = Static<typeof GstRateSchema>;

/** The two-digit GST state code. It is the first two characters of a
 * registered GSTIN, but it is a fact in its own right: an unregistered
 * organisation still has a place of business, and the invoice still has
 * to name a state to decide CGST+SGST against IGST. */
export const GstStateCodeSchema = Type.String({
  pattern: '^[0-9]{2}$',
  description: 'Two-digit GST state code.',
});
export type GstStateCode = Static<typeof GstStateCodeSchema>;

/** Text the DATABASE validates TRIMMED — `length(btrim(x)) BETWEEN n AND
 * m` — while the schema counted raw characters. A note of three spaces
 * therefore satisfied minLength, reached Postgres, and came back as a
 * bare 500 where the operator should have read "a note is required".
 * The pattern holds exactly the floor the CHECK holds: at least
 * `minLength` characters must survive the removal of leading and
 * trailing SPACES, which is precisely what btrim removes. Nothing that
 * the database accepts today starts failing. `minLength` must be 2 or
 * more (every note, reason, and addressee in this domain is). */
export function nonBlankString(options: {
  readonly minLength: number;
  readonly maxLength: number;
}): TString {
  return Type.String({
    minLength: options.minLength,
    maxLength: options.maxLength,
    pattern: `^ *[^ ][\\s\\S]{${options.minLength - 2},}[^ ] *$`,
    description: `Text with at least ${options.minLength} characters once surrounding spaces are removed.`,
  });
}
