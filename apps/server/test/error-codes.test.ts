import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isErrorCode, type ErrorCode } from '@auto-mb/contracts';
import { ENVELOPE_CODES, REMEDIES } from '../src/remedies.js';

/*
 * The standing check behind the declared refusal vocabulary (pack P12).
 *
 * The reconciled review's API-design dimension counted 323 undeclared
 * error-code strings across 633 refusals: `httpError` took `code: string`,
 * so a typo was a new code, a second spelling of an existing refusal was a
 * new code, and no client could know which codes it was allowed to switch
 * on. `packages/contracts/src/errors.ts` now declares the vocabulary and
 * `httpError` takes `ErrorCode`, which makes the TYPE CHECKER the primary
 * guard: an undeclared code does not compile.
 *
 * This file guards the two things a type checker cannot:
 *
 *  1. that no code re-enters through a cast or a widened variable, by
 *     re-running the census over the source and checking every literal
 *     against the list; and
 *  2. that the list does not rot — a declared code no part of the server
 *     can produce is a promise to clients that nothing keeps, and the
 *     reason the previous inventories drifted.
 */

const SERVER_SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const SOURCES = sourceFiles(SERVER_SRC).map((file) => readFileSync(file, 'utf8'));

/** Every `httpError(status, 'CODE', …)` literal in the server. */
function thrownCodes(): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const text of SOURCES) {
    const pattern = /httpError\(\s*\d{3}\s*,\s*'([A-Z0-9_]+)'/gs;
    let match = pattern.exec(text);
    while (match !== null) {
      codes.add(match[1] as string);
      match = pattern.exec(text);
    }
  }
  return codes;
}

/** Whether a code appears anywhere in the server source as a literal.
 * Broader than `thrownCodes` on purpose: a third of the vocabulary is
 * raised indirectly — the statutory adapter's `StatutoryProviderError`,
 * the snapshot and IRN evidence errors, the shared master-route helper —
 * and those are the codes a `httpError(` census could never see, which is
 * how they stayed undeclared in the first place. */
function isWrittenSomewhere(code: string): boolean {
  return SOURCES.some((text) => text.includes(`'${code}'`));
}

describe('the declared refusal vocabulary', () => {
  it('declares every code the routes throw as a literal', () => {
    const undeclared = [...thrownCodes()].filter((code) => !isErrorCode(code)).sort();

    expect(
      undeclared,
      'add the code to ERROR_CODES in packages/contracts/src/errors.ts, or spell the refusal as an existing one',
    ).toEqual([]);
  });

  it('declares no code the server can no longer produce', () => {
    const envelope = new Set<string>(ENVELOPE_CODES);
    const orphaned = ERROR_CODES.filter(
      (code) => !envelope.has(code) && !isWrittenSomewhere(code),
    ).sort();

    expect(
      orphaned,
      'a declared code nothing can raise is a promise to clients with nothing behind it — delete it',
    ).toEqual([]);
  });

  it('carries a remedy only for codes it declares', () => {
    // The type of REMEDIES already says this; asserted at runtime too
    // because a catalog is the kind of thing that gets a cast bolted on.
    const undeclared = Object.keys(REMEDIES)
      .filter((code) => !isErrorCode(code))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('refuses a code that is not in the vocabulary', () => {
    // The behavioural half of the compile-time guard: what `httpError`
    // refuses to be handed, `isErrorCode` refuses to recognise, so a
    // client narrowing on the vocabulary reaches the same verdict the
    // server's type checker did.
    expect(isErrorCode('A_CODE_NOBODY_DECLARED')).toBe(false);
    expect(isErrorCode('WORK_NOT_FOUND')).toBe(true);
  });

  it('holds one spelling per refusal', () => {
    // The dedupe that came with the list, kept: these are the spellings
    // that collapsed, and a route reintroducing one is reintroducing a
    // second name for a refusal that already has one.
    const retired = [
      'CATEGORY_INVALID',
      'CONSIGNEE_MASTER_NOT_FOUND',
      'CONSIGNEE_MASTER_RETIRED',
      'CREDIT_NOTE_NUMBER_CONFLICT',
      'CREDIT_NOTE_RENDER_INPUT_INVALID',
      'CREDIT_NOTE_RENDER_SOURCE_CHANGED',
      'DOCUMENT_ALREADY_DISCARDED',
      'LOA_DOCUMENT_DISCARDED',
      'LOA_DOCUMENT_NOT_FOUND',
      'PAC_CERTIFICATE_ALREADY_CANCELLED',
      'PERCENTAGES_SUM_INVALID',
      'PERCENTAGE_INVALID',
      'PO_NUMBER_CONFLICT',
      'TAX_INVOICE_NUMBER_CONFLICT',
      'TAX_INVOICE_RENDER_INPUT_INVALID',
      'TAX_INVOICE_RENDER_SOURCE_CHANGED',
    ] as const;

    const revived = retired.filter((code) =>
      (ERROR_CODES as readonly string[]).includes(code),
    );
    expect(revived).toEqual([]);
  });

  it('names codes in the house shape', () => {
    // SCREAMING_SNAKE_CASE, checked without a nested quantifier: the
    // linter reads `(?:_[A-Z0-9]+)*` over a `[A-Z0-9]*` prefix as
    // catastrophic-backtracking bait, and this input is a literal list, so
    // the cheap character-by-character check is the honest one.
    const malformed = ERROR_CODES.filter(
      (code: ErrorCode) =>
        !/^[A-Z0-9_]+$/.test(code) ||
        code.startsWith('_') ||
        code.endsWith('_') ||
        code.includes('__') ||
        /^[0-9]/.test(code),
    );
    expect(malformed).toEqual([]);
  });
});
