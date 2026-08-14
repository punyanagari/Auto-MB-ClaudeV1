import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankNonCode } from './helpers/blank-non-code.js';

/**
 * The standing check behind pack P15's send-after-commit fix.
 *
 * The payment-record route called `reply.status(201).send()` INSIDE its
 * `tenant(...)` transaction callback. `reply.send()` dispatches
 * immediately, so the 201 could reach the client while the COMMIT was
 * still in flight — and a screen that refetches the register on success
 * then renders without the receipt it just recorded. It surfaced as an
 * intermittently failing assertion on the partial-payments test that
 * vanished when a debug query was added, which is how a race introduces
 * itself. The fix was one move: return the payload from the callback and
 * send after the await resolves, the way every sibling route already did.
 *
 * Fixing it once is not the deliverable; the deliverable is that it
 * cannot come back unnoticed (§1.4 finding 1: invariants established
 * once and never converted into standing checks). This census scans the
 * server's own source for any use of `reply` lexically inside a
 * transaction callback — `tenant`, `tenantSnapshot`, `withTenant`,
 * `withTenantSnapshot`, `withBoundTenant`, `withBoundTenantSnapshot`, or
 * `.begin` — and holds the result against the frozen allowlist below,
 * whose one entry is the streamed export. Any touch of `reply` is counted, not
 * just `.send(...)`: a header write is premature in the same way, a
 * chained dispatch may start on a bare `reply` line, and passing `reply`
 * into a helper hides the send one hop away. Nothing inside a
 * transaction has any business holding the reply.
 *
 * The scan is textual and deliberately simple, the same posture the
 * write-loop census takes: brace depth over comment-and-string-blanked
 * source to find callback bodies, a word match to find `reply`. A cheap
 * check that is honest about being cheap beats a perfect one that does
 * not exist. Cross-file flows (a helper that received `reply` under
 * another name) are beyond it, and it does not pretend otherwise.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSource = path.resolve(here, '..', 'src');

/**
 * Sites that deliberately hold the reply inside a transaction, with the
 * reason each one is not the P15 defect. The bar for adding one is a
 * written justification here, next to its entry. The count is exact,
 * both directions — a paid-down entry has to be removed, or it hides the
 * next defect.
 */
const ALLOWED: Record<string, { readonly uses: number; readonly reason: string }> = {
  'routes/export.ts': {
    uses: 3,
    reason:
      'The full-organisation export STREAMS the response from inside its REPEATABLE READ transaction on purpose: the snapshot has to stay open while the client consumes the stream, because the single snapshot is what makes the package one consistent instant, and buffering the whole tenant record to send after commit is the memory profile the streaming rewrite removed. It is a GET whose writes are one audit row, so the mutation-acknowledged-before-commit race this census exists for cannot arise. The three uses are the content-type header, the send of the stream, and the `return reply` that tells Fastify the reply was claimed.',
  },
};

/**
 * A line that opens a transaction callback. The names are the tenant
 * primitives (`tenant-route.ts`, `tenant-context.ts`, `@auto-mb/db`) plus
 * postgres.js's own `.begin`. Each name is required to be followed by
 * `(` and preceded by a non-identifier character, so `createTenantRouteRegistrar`
 * and `tenant:` (the context property) do not match.
 */
const TX_OPENER =
  /(^|[^\w.$])(withBoundTenantSnapshot|withBoundTenant|withTenantSnapshot|withTenant|tenantSnapshot|tenant)\s*\(|\.begin\s*\(/;

/** The identifier `reply`, as a whole word. Tested against blanked code,
 * so the word inside a comment or an error message does not count. */
const REPLY = /(^|[^\w.$])reply(?![\w$])/;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every use of `reply` that sits lexically inside a transaction
 * callback. */
function findReplyInTransaction(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split(/\r?\n/);
  const codeLines = blankNonCode(source).split(/\r?\n/);
  let depth = 0;
  const txDepths: number[] = [];
  let pendingTx = false;
  lines.forEach((line, index) => {
    const code = codeLines[index] ?? '';
    const opener = TX_OPENER.exec(code);
    if (txDepths.length > 0 || pendingTx) {
      // Already inside a callback body (or between an opener and its
      // brace): any reply on the line is a finding.
      if (REPLY.test(code)) {
        findings.push({ file, line: index + 1, text: line.trim() });
      }
    } else if (opener !== null) {
      // The opener's own line: only a reply AFTER the call begins is
      // inside it. `reply.send(await tenant(...))` sends after the
      // transaction resolves and stays legal; `tenant((tx) =>
      // doThing(reply))` does not.
      const after = REPLY.exec(code.slice(opener.index + opener[0].length));
      if (after !== null) {
        findings.push({ file, line: index + 1, text: line.trim() });
      }
    }
    if (opener !== null) pendingTx = true;
    for (const character of code) {
      if (character === '{') {
        depth += 1;
        if (pendingTx) {
          txDepths.push(depth);
          pendingTx = false;
        }
      } else if (character === '}') {
        if (txDepths.at(-1) === depth) txDepths.pop();
        depth -= 1;
      }
    }
    // An opener may span lines; it is over once a body brace opened
    // (handled above) or the statement ended without one.
    if (pendingTx && code.includes(';')) pendingTx = false;
  });
  return findings;
}

describe('reply inside a transaction callback', () => {
  it('exists only where the allowlist says it may', async () => {
    const findings: Finding[] = [];
    for await (const match of glob('**/*.ts', { cwd: serverSource })) {
      const relative = match.split(path.sep).join('/');
      const source = await readFile(path.join(serverSource, match), 'utf8');
      findings.push(...findReplyInTransaction(source, relative));
    }

    const byFile = new Map<string, Finding[]>();
    for (const finding of findings) {
      byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
    }

    const unexpected = [...byFile.entries()]
      .filter(([file, found]) => (ALLOWED[file]?.uses ?? 0) < found.length)
      .map(
        ([file, found]) =>
          `${file}: ${String(found.length)} reply use(s) inside a transaction, allowed ${String(
            ALLOWED[file]?.uses ?? 0,
          )} — ${found
            .map((entry) => `line ${String(entry.line)}: ${entry.text}`)
            .join('; ')}`,
      );
    expect(
      unexpected,
      `reply.send() dispatches immediately, so touching the reply inside a transaction callback can put a success status on the wire before COMMIT — the client then acts on a write that is not yet visible, or never happens. Return the payload from the callback and send after the await resolves (see the POST /api/bills/:id/payments handler in routes/bill-payments.ts), or add an entry to ALLOWED in this file with the reason the reply must be held inside.`,
    ).toEqual([]);

    // The other direction: an allowlist entry that no longer matches
    // anything is stale, and a stale exemption hides the next defect.
    const paidDown = Object.entries(ALLOWED)
      .filter(([file, entry]) => (byFile.get(file)?.length ?? 0) < entry.uses)
      .map(
        ([file, entry]) =>
          `${file}: allowed ${String(entry.uses)}, found ${String(
            byFile.get(file)?.length ?? 0,
          )}`,
      );
    expect(
      paidDown,
      'These sites were fixed or removed. Lower (or delete) their ALLOWED entry so the ratchet holds at the new number.',
    ).toEqual([]);
  });

  it('is absent from the route where P15 found it', async () => {
    // The origin site, pinned by name the way the write-loop census pins
    // its converted routes: if the file is ever renamed this fails loudly
    // and the pin moves with it, rather than silently guarding nothing.
    const source = await readFile(
      path.join(serverSource, 'routes', 'bill-payments.ts'),
      'utf8',
    );
    expect(
      findReplyInTransaction(source, 'routes/bill-payments.ts'),
      'routes/bill-payments.ts holds the reply inside a transaction again',
    ).toEqual([]);
  });
});
