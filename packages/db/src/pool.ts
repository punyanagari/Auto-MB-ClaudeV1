import postgres, { type Sql } from 'postgres';

export interface DatabasePoolOptions {
  readonly url: string;
  readonly max?: number;
  readonly applicationName?: string;
}

export function createDatabasePool(options: DatabasePoolOptions): Sql {
  return postgres(options.url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: options.applicationName ?? 'auto-mb',
    },
    transform: { undefined: null },
  });
}
