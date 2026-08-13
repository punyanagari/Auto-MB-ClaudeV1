import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  MALWARE_SCANNER_HOST_ENV,
  MalwareScanningUnconfiguredInProductionError,
  assertProductionMalwareScanning,
} from '../src/upload-guards.js';

/**
 * The malware-scanning boot assertion (improvement programme P4).
 *
 * Upload scanning is configuration-gated: with `CLAMAV_HOST` unset,
 * `buildApp` registers every upload route behind `noScanner`, whose scan
 * is a no-op, so `assertNotMalware` returns immediately and unscanned
 * attachments are stored and served back to the organisation. The
 * fail-closed behaviour docs/SECURITY.md describes — an unreachable
 * scanner refuses the upload — only exists once scanning is switched on.
 *
 * A production process therefore refuses to start rather than come up one
 * environment variable away from no scanning at all. This is the same
 * posture as `assertProductionSecret` (auth.ts) and
 * `assertProductionMfaEnforcement` (mfa-policy.ts), including its reading
 * of NODE_ENV: only an explicit development or test run is exempt, so a
 * bare `pnpm start` is treated as production.
 */

const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }
}

afterEach(() => {
  setNodeEnv(originalNodeEnv);
});

const configured = { host: 'clamav', port: 3310 } as const;

describe('assertProductionMalwareScanning', () => {
  const table: {
    nodeEnv: string | undefined;
    clamav: { host: string; port: number } | undefined;
    boots: boolean;
  }[] = [
    { nodeEnv: 'development', clamav: configured, boots: true },
    { nodeEnv: 'development', clamav: undefined, boots: true },
    { nodeEnv: 'test', clamav: configured, boots: true },
    { nodeEnv: 'test', clamav: undefined, boots: true },
    { nodeEnv: 'production', clamav: configured, boots: true },
    { nodeEnv: 'production', clamav: undefined, boots: false },
    // An unset NODE_ENV is production for this gate.
    { nodeEnv: undefined, clamav: configured, boots: true },
    { nodeEnv: undefined, clamav: undefined, boots: false },
    // Any unrecognised NODE_ENV spelling is production too.
    { nodeEnv: 'staging', clamav: undefined, boots: false },
    { nodeEnv: 'Production', clamav: undefined, boots: false },
    { nodeEnv: 'DEVELOPMENT', clamav: undefined, boots: false },
  ];

  for (const row of table) {
    const label = `NODE_ENV=${row.nodeEnv ?? '(unset)'} clamav=${
      row.clamav === undefined ? 'unset' : 'configured'
    } → ${row.boots ? 'boots' : 'refuses'}`;
    it(label, () => {
      setNodeEnv(row.nodeEnv);
      if (row.boots) {
        expect(() => {
          assertProductionMalwareScanning(row.clamav);
        }).not.toThrow();
      } else {
        expect(() => {
          assertProductionMalwareScanning(row.clamav);
        }).toThrow(MalwareScanningUnconfiguredInProductionError);
      }
    });
  }

  it('names the variable and the hazard in the refusal', () => {
    setNodeEnv(undefined);
    try {
      assertProductionMalwareScanning(undefined);
      expect.unreachable('assertion must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MalwareScanningUnconfiguredInProductionError);
      expect((error as Error).name).toBe(
        'MalwareScanningUnconfiguredInProductionError',
      );
      expect((error as Error).message).toContain(MALWARE_SCANNER_HOST_ENV);
      expect((error as Error).message).toContain('unscanned');
    }
  });

  it('reads the same variable name main.ts reads', () => {
    expect(MALWARE_SCANNER_HOST_ENV).toBe('CLAMAV_HOST');
  });
});

describe('buildApp wiring', () => {
  it('refuses to build an upload-serving instance in production with no scanner', async () => {
    setNodeEnv('production');
    // The assertion runs before any pool, listener or route exists, so
    // the unreachable database URL is never dialled and nothing is left
    // half-built by the refusal.
    await expect(
      buildApp({
        databaseUrl: 'postgres://unused:unused@127.0.0.1:1/unused',
        authSecret: `boot-assertion-secret-${'0'.repeat(32)}`,
      }),
    ).rejects.toBeInstanceOf(MalwareScanningUnconfiguredInProductionError);
  });

  it('exempts an instance that registers no upload routes', async () => {
    setNodeEnv('production');
    // Without authentication and a database there is no upload surface to
    // protect — health probes and the metrics endpoint are all such an
    // instance serves — so the assertion deliberately does not fire.
    const app = await buildApp({});
    await app.close();
  });
});
