import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorSchema,
  DateOnlySchema,
  DecimalStringSchema,
  ReadinessResponseSchema,
  isHealthResponse,
} from '../src/index.js';

describe('primitive schemas', () => {
  it('accepts well-formed decimal strings and rejects float-ish input', () => {
    for (const valid of ['0', '12', '-3', '100000.00', '95000.5', '0.125']) {
      expect(Value.Check(DecimalStringSchema, valid), valid).toBe(true);
    }
    for (const invalid of ['01', '1.', '.5', '1.2345', '1e3', 'NaN', '', '1,000', 12]) {
      expect(Value.Check(DecimalStringSchema, invalid), String(invalid)).toBe(false);
    }
  });

  it('accepts date-only values and rejects timestamps', () => {
    expect(Value.Check(DateOnlySchema, '2026-01-15')).toBe(true);
    for (const invalid of ['2026-1-15', '2026-01-15T00:00:00Z', '15/01/2026']) {
      expect(Value.Check(DateOnlySchema, invalid), invalid).toBe(false);
    }
  });
});

describe('health contracts', () => {
  const health = {
    status: 'ok',
    service: 'auto-mb-server',
    version: '0.1.0',
    timestamp: '2026-01-15T00:00:00.000Z',
  };

  it('round-trips the health envelope and rejects extras and drift', () => {
    expect(isHealthResponse(health)).toBe(true);
    expect(isHealthResponse({ ...health, status: 'degraded' })).toBe(false);
    expect(isHealthResponse({ ...health, extra: true })).toBe(false);
    expect(isHealthResponse({ ...health, timestamp: 'yesterday' })).toBe(false);
    expect(isHealthResponse(null)).toBe(false);
    expect(isHealthResponse('ok')).toBe(false);
  });

  it('models both readiness outcomes and nothing else', () => {
    expect(Value.Check(ReadinessResponseSchema, { status: 'ready' })).toBe(true);
    expect(
      Value.Check(ReadinessResponseSchema, {
        status: 'not-ready',
        reason: 'database-unreachable',
      }),
    ).toBe(true);
    expect(Value.Check(ReadinessResponseSchema, { status: 'starting' })).toBe(false);
  });

  it('requires code, message, and requestId on API errors', () => {
    expect(
      Value.Check(ApiErrorSchema, {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        requestId: 'req-1',
      }),
    ).toBe(true);
    expect(Value.Check(ApiErrorSchema, { code: 'INTERNAL_ERROR', message: 'x' })).toBe(
      false,
    );
  });
});
