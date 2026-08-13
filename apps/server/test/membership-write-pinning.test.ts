import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Every membership and assignment WRITE is pinned to the bound
 * organisation, not only to the user.
 *
 * The 12 August 2026 re-audit recorded that "every membership read" is
 * organisation-pinned while two writes were not: the member PATCH's
 * `update organisation_memberships ... where user_id = $1` and the
 * assignment PUT's `delete from work_assignments where user_id = $1`. Both
 * are privilege writes, and both were protected by row-level security
 * alone. Tenancy is enforced twice everywhere else in this codebase — the
 * policy AND the predicate — and a behavioural test cannot tell the two
 * layers apart, because RLS already denies the cross-tenant row.
 *
 * So the invariant is asserted where it is visible: over the source. Any
 * statement in identity.ts that writes to one of these two tables must
 * carry `organisation_id = app_private.current_organisation_id()`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const identityRoute = path.resolve(here, '..', 'src', 'routes', 'identity.ts');

const PINNED_TABLES = ['organisation_memberships', 'work_assignments'] as const;
const PREDICATE = 'organisation_id = app_private.current_organisation_id()';

let source = '';

beforeAll(async () => {
  source = await readFile(identityRoute, 'utf8');
});

/** Splits the file into template-literal SQL statements: postgres.js
 * tagged templates are the only way this route talks to the database. */
function sqlStatements(): string[] {
  return [...source.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1] ?? '')
    .filter((body) => /\b(select|insert|update|delete)\b/i.test(body));
}

describe('identity route membership writes', () => {
  it('reads the route source', () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(sqlStatements().length).toBeGreaterThan(5);
  });

  it.each(PINNED_TABLES)(
    'pins every write to %s to the bound organisation',
    (table) => {
      const writes = sqlStatements().filter((statement) => {
        const flat = `${statement.replace(/\s+/g, ' ').toLowerCase()} `;
        return (
          flat.includes(`update ${table} `) ||
          flat.includes(`delete from ${table} `) ||
          flat.includes(`insert into ${table} `)
        );
      });
      expect(
        writes.length,
        `no write to ${table} found in identity.ts`,
      ).toBeGreaterThan(0);
      const unpinned = writes.filter((statement) => {
        // An INSERT names the organisation in its column list instead of a
        // WHERE clause; the row it writes is checked by the RLS WITH CHECK
        // and by the FK, and there is no other row it could reach.
        if (/\binsert\s+into\b/i.test(statement)) {
          return !/\borganisation_id\b/i.test(statement);
        }
        return !statement.includes(PREDICATE);
      });
      expect(
        unpinned,
        `writes to ${table} that do not carry "${PREDICATE}":\n${unpinned.join('\n---\n')}`,
      ).toEqual([]);
    },
  );
});
