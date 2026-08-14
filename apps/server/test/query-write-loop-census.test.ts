import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankNonCode } from './helpers/blank-non-code.js';

/**
 * The standing check behind pack P11's write-loop conversions.
 *
 * The 2026-08-13 review counted nineteen places where the server issued
 * one INSERT or UPDATE per row of a document — a round-trip per challan
 * line, per work item, per Measurement Book line — inside the very
 * transaction that holds the Work's row lock. Converting them once is
 * not the deliverable; the deliverable is that they cannot come back
 * unnoticed, which is what this census is (§1.4 finding 1: invariants
 * established once and never converted into standing checks).
 *
 * It scans the server's own source for a SQL write statement written
 * inside a JavaScript loop and holds the result against the frozen
 * allowlist below. A new one fails the build; an allowlisted one has to
 * be justified in writing, here, next to its entry.
 *
 * The scan is textual and deliberately simple: brace depth to find loop
 * bodies, and a line that STARTS a SQL write to find the statements.
 * That is the same posture `scripts/check-comment-refs.mjs` takes — a
 * cheap check that is honest about being cheap beats a perfect one that
 * does not exist.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = path.resolve(here, '..', 'src');

/**
 * Per-row writes that stay, with the reason each one is not a defect.
 * The count is exact: a file may hold no more in-loop writes than it is
 * allowed, and no fewer either — paying one down means editing this
 * table, which is the point.
 */
const ALLOWED: Record<string, { readonly writes: number; readonly reason: string }> = {
  'gsp/provider-operations.ts': {
    writes: 6,
    reason:
      'Lease recovery branches to a DIFFERENT table per row (tax invoices, credit notes, e-way bills), so there is no single statement to batch into. The loop runs over rows returned by one lease-expiry UPDATE, in practice none or one.',
  },
  'import/importer.ts': {
    writes: 7,
    reason:
      'The v1 import CLI writes each source row inside its own savepoint and skips the ones that fail, so a bad legacy row does not abort the batch. Batching would trade that per-row isolation — the whole reason the importer can run against real legacy data — for round-trips on an offline job that no request waits on.',
  },
};

/** A line that begins a SQL write statement, once the leading whitespace
 * and any backtick opening the tagged template are stripped. Written
 * against a normalised line rather than as one regex over the raw text,
 * so it stays linear. */
const WRITE_STATEMENT = /^(insert into|update) [a-z_]/i;

function startsWriteStatement(line: string): boolean {
  const normalised = line.replace(/\s+/g, ' ').trim().replace(/^` ?/, '');
  return WRITE_STATEMENT.test(normalised);
}
/** A line that opens a JavaScript loop, tested against the same
 * whitespace-normalised form. */
const LOOP_HEAD = /(^|[^\w.])(for|for await|while) ?\(|\.forEach ?\(/;

function opensLoop(line: string): boolean {
  return LOOP_HEAD.test(line.replace(/\s+/g, ' '));
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every SQL write statement that sits inside a loop body. Brace
 * counting runs over `blankNonCode` output rather than the raw text —
 * see `helpers/blank-non-code.ts`, where the blanking lived inline here
 * until the reply-inside-transaction census needed the same ground. */
function findInLoopWrites(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  const codeLines = blankNonCode(source).split(/\r?\n/);
  let depth = 0;
  const loopDepths: number[] = [];
  let pendingLoop = false;
  lines.forEach((line, index) => {
    const code = codeLines[index] ?? '';
    // A write inside a loop body, or one written on the loop's own line
    // (`for (…) await tx\`insert …\`;`).
    if (
      startsWriteStatement(line) &&
      (loopDepths.length > 0 || pendingLoop || opensLoop(code))
    ) {
      findings.push({ file, line: index + 1, text: line.trim() });
    }
    if (opensLoop(code)) pendingLoop = true;
    for (const character of code) {
      if (character === '{') {
        depth += 1;
        if (pendingLoop) {
          loopDepths.push(depth);
          pendingLoop = false;
        }
      } else if (character === '}') {
        if (loopDepths.at(-1) === depth) loopDepths.pop();
        depth -= 1;
      }
    }
    // A loop head may span lines; it is over once a body brace opened
    // (handled above) or the statement ended without one.
    if (pendingLoop && code.includes(';')) pendingLoop = false;
  });
  return findings;
}

describe('per-row write loops', () => {
  it('exist only where the allowlist says they may', async () => {
    const findings: Finding[] = [];
    for await (const match of glob('**/*.ts', { cwd: serverSource })) {
      const relative = match.split(path.sep).join('/');
      const source = await readFile(path.join(serverSource, match), 'utf8');
      findings.push(...findInLoopWrites(source, relative));
    }

    const byFile = new Map<string, Finding[]>();
    for (const finding of findings) {
      byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
    }

    const unexpected = [...byFile.entries()]
      .filter(([file, found]) => (ALLOWED[file]?.writes ?? 0) < found.length)
      .map(
        ([file, found]) =>
          `${file}: ${String(found.length)} in-loop write(s), allowed ${String(
            ALLOWED[file]?.writes ?? 0,
          )} — ${found.map((entry) => `line ${String(entry.line)}`).join(', ')}`,
      );
    expect(
      unexpected,
      `A SQL write inside a JavaScript loop costs one database round-trip per row of the document, inside the transaction holding the Work's locks. Write the rows in one statement (the house pattern is "insert into … select … from unnest(\${array}::type[])" — see routes/measurement-books/finalize.ts), or add an entry to ALLOWED in this file with the reason it must stay.`,
    ).toEqual([]);

    // The other direction: an allowlist entry that no longer matches
    // anything is stale, and a stale exemption hides the next defect.
    const paidDown = Object.entries(ALLOWED)
      .filter(([file, entry]) => (byFile.get(file)?.length ?? 0) < entry.writes)
      .map(
        ([file, entry]) =>
          `${file}: allowed ${String(entry.writes)}, found ${String(
            byFile.get(file)?.length ?? 0,
          )}`,
      );
    expect(
      paidDown,
      'These write loops were converted or removed. Lower (or delete) their ALLOWED entry so the ratchet holds at the new number.',
    ).toEqual([]);
  });

  it('are absent from every request-path route this pack converted', async () => {
    const converted = [
      'routes/challans.ts',
      'routes/issue-challans.ts',
      'routes/purchase-orders.ts',
      'routes/quotations.ts',
      'routes/tax-invoices/internal.ts',
      'routes/loa.ts',
      'routes/identity.ts',
      'routes/retention.ts',
      'routes/measurement-books/finalize.ts',
      'routes/measurement-books/merge.ts',
      'gst-rates.ts',
    ];
    for (const file of converted) {
      const source = await readFile(path.join(serverSource, file), 'utf8');
      expect(
        findInLoopWrites(source, file),
        `${file} writes rows one at a time`,
      ).toEqual([]);
    }
  });
});
