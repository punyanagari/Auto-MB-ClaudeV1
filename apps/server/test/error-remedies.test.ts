import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { httpError } from '../src/http.js';
import { ENVELOPE_CODES, REMEDIES, remedyFor } from '../src/remedies.js';

/*
 * The standing check behind the remedy backfill (pack P8).
 *
 * The panel counted roughly three-quarters of 633 server refusals stating a
 * fact with no remedy. Writing remedies once fixes that once; this file is
 * what keeps them. It enforces three things a future change could quietly
 * undo: that every code the server throws OFTEN carries a remedy, that no
 * remedy outlives the code it advises on, and that the envelope actually
 * carries the field.
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Every `httpError(status, 'CODE', …)` in the server, counted. The regex
 * reads the two arguments that are always literals; the message never is. */
function thrownCodes(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const patterns = [
      // The ordinary throw, with the code written at the call site.
      /httpError\(\s*\d{3}\s*,\s*'([A-Z0-9_]+)'/g,
      /* The table-driven throw. A module that maps its database's
       * SQLSTATEs to named refusals (`bill-payments.ts`, `payments.ts`)
       * throws `httpError(409, refusal[0], refusal[1])`, so the code is
       * a variable at the call site and the literal only appears in the
       * table. Those codes ARE thrown — a trigger firing is exactly when
       * an operator meets them — and counting only the call site left
       * the census blind to a whole idiom, which is how a remedy for a
       * live code looked stale. */
      /^\s*'[0-9A-Z]{5}':\s*\[\s*'([A-Z0-9_]+)'/gm,
    ];
    for (const pattern of patterns) {
      let match = pattern.exec(text);
      while (match !== null) {
        const code = match[1] as string;
        counts.set(code, (counts.get(code) ?? 0) + 1);
        match = pattern.exec(text);
      }
    }
  }
  return counts;
}

/** The coverage bar. A code thrown this often is one operators meet, so it
 * must say what to do about it. Lowering this number is how the bar is
 * raised — it is not a ceiling on how many remedies may exist. */
const COVERAGE_THRESHOLD = 3;

describe('refusal remedies', () => {
  const thrown = thrownCodes();

  it('covers every code the server throws three or more times', () => {
    const uncovered = [...thrown]
      .filter(
        ([code, count]) => count >= COVERAGE_THRESHOLD && remedyFor(code) === undefined,
      )
      .map(([code, count]) => `${code} (thrown ${String(count)}×)`)
      .sort();

    expect(uncovered).toEqual([]);
  });

  it('carries remedies for at least the top forty refusals', () => {
    // The pack's own commitment, kept as a floor so a later deletion is a
    // decision rather than an accident.
    expect(Object.keys(REMEDIES).length).toBeGreaterThanOrEqual(40);
  });

  it('advises only on codes the server still throws', () => {
    const orphaned = Object.keys(REMEDIES)
      .filter(
        (code) =>
          !thrown.has(code) && !(ENVELOPE_CODES as readonly string[]).includes(code),
      )
      .sort();

    expect(orphaned).toEqual([]);
  });

  it('mints every envelope-level code it claims to', () => {
    // These three are written by the error handler rather than thrown by a
    // route, so the census above cannot vouch for them. Assert they are
    // still spelled the same way there.
    const appSource = readFileSync(join(SOURCE_ROOT, 'app.ts'), 'utf8');
    for (const code of ENVELOPE_CODES) {
      expect(appSource, code).toContain(`'${code}'`);
    }
  });

  describe('house style', () => {
    const entries = Object.entries(REMEDIES);

    it.each(entries)('%s reads as one operational instruction', (code, remedy) => {
      expect(remedy, `${code} must end in a full stop`).toMatch(/\.$/);
      expect(remedy, `${code} must be one sentence`).not.toMatch(/\.\s/);
      expect(remedy.length, `${code} must say something`).toBeGreaterThan(20);
      expect(remedy, `${code} must instruct rather than apologise`).not.toMatch(
        /\b(sorry|unfortunately|apolog\w+|please)\b/i,
      );
      expect(remedy, `${code} must not shout`).not.toContain('!');
    });
  });

  it('rides the error envelope', async () => {
    const app = await buildApp();
    try {
      app.post('/test-refusal', () => {
        throw httpError(409, 'DRAFT_EXISTS', 'This Work already has a draft challan.');
      });

      const response = await app.inject({ method: 'POST', url: '/test-refusal' });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'DRAFT_EXISTS',
        message: 'This Work already has a draft challan.',
        remedy: REMEDIES['DRAFT_EXISTS'],
      });
    } finally {
      await app.close();
    }
  });

  it('omits the field entirely for a code with no reviewed remedy', async () => {
    const app = await buildApp();
    try {
      // A declared code that deliberately carries no reviewed remedy —
      // since P12 the vocabulary is typechecked, so this can no longer be
      // an invented string, and picking a real unremedied code is a
      // truer test anyway.
      const unremedied = 'FIELD_TOO_SHORT';
      expect(remedyFor(unremedied)).toBeUndefined();
      app.post('/test-unremedied', () => {
        throw httpError(400, unremedied, 'Refused.');
      });

      const response = await app.inject({ method: 'POST', url: '/test-unremedied' });

      expect(response.statusCode).toBe(400);
      // Filler advice would be worse than none: an operator who learns the
      // remedy line is sometimes noise stops reading it.
      expect(Object.keys(response.json())).not.toContain('remedy');
    } finally {
      await app.close();
    }
  });

  it('answers a masked internal failure with a remedy too', async () => {
    const app = await buildApp();
    try {
      app.post('/test-internal', () => {
        throw new Error('a detail the caller must never see');
      });

      const response = await app.inject({ method: 'POST', url: '/test-internal' });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        remedy: REMEDIES['INTERNAL_ERROR'],
      });
    } finally {
      await app.close();
    }
  });
});
