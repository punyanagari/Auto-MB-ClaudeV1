import postgres, { type Sql } from 'postgres';

export interface DatabasePoolOptions {
  readonly url: string;
  readonly max?: number;
  readonly applicationName?: string;
}

/**
 * Severities that arrive on the NoticeResponse channel and say nothing a
 * reader needs. `create ... if not exists` and `drop ... if exists` — which
 * the migration series and every throwaway-database fixture are full of —
 * announce their no-ops as NOTICE, and postgres.js's DEFAULT handler prints
 * each one as a full parsed-error object: severity, SQLSTATE, file, line,
 * routine. Eight lines that look exactly like a failure, for a statement
 * that did what it was asked.
 *
 * That is the log noise the process audit measured: expected refusals and
 * expected no-ops, formatted indistinguishably from real errors, in a
 * volume that buries the one line somebody is actually looking for.
 *
 * WARNING and above are NOT in this set and still print. A real error never
 * comes through here at all — it rejects the query and surfaces at the call
 * site — so nothing that fails a test is being swallowed.
 */
const QUIET_NOTICE_SEVERITIES = new Set(['DEBUG', 'LOG', 'INFO', 'NOTICE']);

export function createDatabasePool(options: DatabasePoolOptions): Sql {
  return postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: options.applicationName ?? 'auto-mb',
    },
    transform: { undefined: null },
    onnotice: (notice) => {
      const severity = String(notice.severity ?? '').toUpperCase();
      if (QUIET_NOTICE_SEVERITIES.has(severity)) return;
      // One line, not an object dump: a WARNING is worth reading, and it is
      // worth being able to read it beside the test that provoked it.
      console.warn(`postgres ${severity}: ${notice.message ?? '(no message)'}`);
    },
  });
}
