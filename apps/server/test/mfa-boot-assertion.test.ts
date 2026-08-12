import { afterEach, describe, expect, it } from 'vitest';
import {
  MfaEnforcementDisabledInProductionError,
  assertProductionMfaEnforcement,
} from '../src/mfa-policy.js';

/**
 * The finding-36 boot assertion: outside an explicit development or test
 * run, a process must refuse to start when the MFA refusals resolve off.
 * Mirrors assertProductionSecret's posture — an unset NODE_ENV counts as
 * production, so a bare `pnpm start` cannot come up one environment
 * variable away from an open MFA gate.
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

describe('assertProductionMfaEnforcement', () => {
  // The full truth table. `enforce` is the resolved MFA_ENFORCE read
  // (process.env.MFA_ENFORCE === 'true'), so 'TRUE', '1', 'yes', '' and
  // unset all arrive here as false.
  const table: {
    nodeEnv: string | undefined;
    enforce: boolean;
    boots: boolean;
  }[] = [
    { nodeEnv: 'development', enforce: true, boots: true },
    { nodeEnv: 'development', enforce: false, boots: true },
    { nodeEnv: 'test', enforce: true, boots: true },
    { nodeEnv: 'test', enforce: false, boots: true },
    { nodeEnv: 'production', enforce: true, boots: true },
    { nodeEnv: 'production', enforce: false, boots: false },
    // An unset NODE_ENV is production for this gate.
    { nodeEnv: undefined, enforce: true, boots: true },
    { nodeEnv: undefined, enforce: false, boots: false },
    // Any unrecognised NODE_ENV spelling is production too.
    { nodeEnv: 'staging', enforce: false, boots: false },
    { nodeEnv: 'Production', enforce: false, boots: false },
    { nodeEnv: 'DEVELOPMENT', enforce: false, boots: false },
  ];

  for (const row of table) {
    const label = `NODE_ENV=${row.nodeEnv ?? '(unset)'} enforce=${String(row.enforce)} → ${
      row.boots ? 'boots' : 'refuses'
    }`;
    it(label, () => {
      setNodeEnv(row.nodeEnv);
      if (row.boots) {
        expect(assertProductionMfaEnforcement(row.enforce)).toBe(row.enforce);
      } else {
        expect(() => assertProductionMfaEnforcement(row.enforce)).toThrow(
          MfaEnforcementDisabledInProductionError,
        );
      }
    });
  }

  it('names the one-env-var-from-off hazard in the refusal', () => {
    setNodeEnv(undefined);
    expect(() => assertProductionMfaEnforcement(false)).toThrow(
      /MFA_ENFORCE must be exactly "true"/,
    );
    try {
      assertProductionMfaEnforcement(false);
      expect.unreachable('assertion must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MfaEnforcementDisabledInProductionError);
      expect((error as Error).name).toBe('MfaEnforcementDisabledInProductionError');
      expect((error as Error).message).toContain('one environment variable away');
    }
  });
});
