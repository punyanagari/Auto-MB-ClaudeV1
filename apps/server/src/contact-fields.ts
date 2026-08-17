import { httpError } from './http.js';

/**
 * The party fields that more than one writer records: a GSTIN, an email
 * address, and — since migration 0078 — the bank account a payment goes
 * to. The Contacts master (routes/masters.ts) writes them for railway
 * offices and vendors; the organisation profile and its own bank accounts
 * (routes/organisation.ts) write the contractor's. They live here so both
 * writers prove the same thing rather than one imitating the other — the
 * organisation's values are read live at every render and printed on the
 * letterhead of every generated document (Delivery Challan, Issue
 * Challan, MB, extension letter, correction notice), so a junk value
 * there is a defect on a tax-facing paper the contractor is answerable
 * for.
 *
 * Every normaliser here is for NEW WRITES only. Rows already stored may
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

/** The RBI's IFSC: four letters naming the bank, a '0' the format
 * reserves, then six alphanumerics naming the branch. Migration 0078
 * binds the same pattern on both tables that store one. */
export const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * Six to eighteen alphanumerics, at least one of them a digit.
 *
 * The length and alphabet are wider than the NPCI 9-to-18 DIGIT range a
 * validator reaches for first, and deliberately: Indian account numbers
 * are not uniformly numeric or uniformly long — cooperative and older
 * district banks issue shorter and occasionally alphanumeric numbers —
 * and refusing a real account is a worse failure than accepting an
 * unlikely-looking one.
 *
 * The digit is what keeps that width honest. Letters are admitted for the
 * banks that use them, but no bank issues an account identified purely by
 * letters, so a value without a digit is prose. Without this clause the
 * space-stripping below turns "ASK RAMESH" into a nine-character
 * "account number" that passes — which is exactly the note this field
 * exists to refuse.
 *
 * Written as one flat lookahead, so it cannot backtrack badly.
 */
export const BANK_ACCOUNT_NUMBER_SHAPE = /^(?=.*[0-9])[0-9A-Z]{6,18}$/;

/** Trims and uppercases, then proves the structure. `undefined` and
 * `null` both mean "no IFSC" and answer null. */
export function normaliseIfsc(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const ifsc = raw.trim().toUpperCase();
  if (!IFSC_SHAPE.test(ifsc)) {
    throw httpError(
      400,
      'IFSC_INVALID',
      'The IFSC must be 11 characters: four letters for the bank, a zero, then six characters for the branch — as printed on the cheque leaf or passbook.',
    );
  }
  return ifsc;
}

/** Trims, strips the spaces and hyphens a passbook prints for
 * readability, and uppercases before proving the shape. */
export function normaliseBankAccountNumber(
  raw: string | null | undefined,
): string | null {
  if (raw === undefined || raw === null) return null;
  const account = raw.replaceAll(/[\s-]/g, '').toUpperCase();
  if (!BANK_ACCOUNT_NUMBER_SHAPE.test(account)) {
    throw httpError(
      400,
      'BANK_ACCOUNT_NUMBER_INVALID',
      'The account number must be 6 to 18 letters or digits including at least one digit, as printed on the passbook. Spaces and hyphens are removed; anything else — a note, a second account, "n/a" — is not an account number.',
    );
  }
  return account;
}

/**
 * The four payable fields are a set: a beneficiary is a name, a bank, a
 * number and an IFSC together. A partial set is not something anyone can
 * be paid as, and storing one would produce a payment advice that fails
 * at the bank rather than here. Migration 0078's
 * `contacts_bank_details_shape_check` refuses the same partial row
 * against a writer that never came through this route.
 */
export function assertBankDetailsComplete(fields: {
  readonly holder: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly ifsc: string | null;
}): void {
  const present = [
    fields.holder,
    fields.bankName,
    fields.accountNumber,
    fields.ifsc,
  ].filter((value) => value !== null).length;
  if (present !== 0 && present !== 4) {
    throw httpError(
      400,
      'BANK_DETAILS_INCOMPLETE',
      'Bank details need the account holder, the bank name, the account number and the IFSC together — a partial set cannot be paid to. Fill all four, or clear them all.',
    );
  }
}
