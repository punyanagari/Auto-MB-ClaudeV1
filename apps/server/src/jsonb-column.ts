/** postgres.js returns jsonb columns as their raw JSON text; the values
 * travel as structured objects everywhere else in the application. */
export function parseJsonbColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
