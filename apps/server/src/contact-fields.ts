import { httpError } from './http.js';

/**
 * The two party fields that more than one writer records: a GSTIN and an
 * email address. The Contacts master (routes/masters.ts) writes them for
 * railway offices; the organisation profile (routes/organisation.ts)
 * writes the contractor's own. They live here so both writers prove the
 * same thing rather than one imitating the other — the organisation's
 * values are read live at every render and printed on the letterhead of
 * every generated document (Delivery Challan, Issue Challan, MB,
 * extension letter, correction notice), so a junk value there is a defect
 * on a tax-facing paper the contractor is answerable for.
 *
 * Both normalisers are for NEW WRITES only. Rows already stored may
 * predate the check; tightening a database CHECK waits until the existing
 * values are cleaned.
 */

/** GSTIN structure (legacy §2/§5.7/§9): the standard 15-character shape
 * (state code, PAN, entity code, the fixed 'Z', check character) OR a
 * TDS-deductor GSTIN — railway units are deductors, and their GSTINs end
 * in 'D'. Uppercased before validation; the 0028 CHECK re-proves both
 * shapes at the database for contacts. The contractor is not a deductor,
 * but accepting both shapes for its own GSTIN too costs nothing and
 * removes any chance of refusing an unusual registration. */
export const GSTIN_STANDARD = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
export const GSTIN_DEDUCTOR = /^[0-9]{2}[0-9A-Z]{12}D$/;

/** Trims and uppercases, then proves the structure. `undefined` and
 * `null` both mean "no GSTIN" and answer null; callers that must tell
 * "omitted" from "cleared" decide that before calling. */
export function normaliseGstin(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const gstin = raw.trim().toUpperCase();
  if (!GSTIN_STANDARD.test(gstin) && !GSTIN_DEDUCTOR.test(gstin)) {
    throw httpError(
      400,
      'GSTIN_INVALID',
      'The GSTIN must be 15 characters: 2-digit state code + PAN + entity code + Z + check character, or a TDS-deductor GSTIN ending in D (railway units).',
    );
  }
  return gstin;
}

/** Deliberately permissive, not an RFC check: one address, exactly one
 * '@', a domain carrying a dot with a non-empty label on each side, and
 * no whitespace anywhere. That is enough to refuse what offices actually
 * park in an optional field — "n/a", "---", a phone number, a note like
 * "office@ — ask Ramesh", or two addresses separated by a slash — without
 * refusing a real but unusual address (plus tags, hyphens, and long
 * government sub-domains all pass). Whether the mailbox exists is proved
 * by sending mail, never by a pattern. Written flat, with no quantifier
 * inside a quantifier, so it cannot backtrack badly on a long value. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]*[^\s@.]\.[^\s@.]+$/;

/** Trims (a pasted address often carries a stray space), then proves the
 * shape. `undefined` and `null` both mean "no email" and answer null. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const email = raw.trim();
  if (!EMAIL_SHAPE.test(email)) {
    throw httpError(
      400,
      'EMAIL_INVALID',
      'The email address must be a single address like name@example.com — no spaces, no notes alongside it, and one address per field. Leave it blank if there is none.',
    );
  }
  return email;
}
