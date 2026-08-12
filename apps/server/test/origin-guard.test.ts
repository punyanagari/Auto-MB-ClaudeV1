import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createMutationOriginGuard } from '../src/origin-guard.js';

describe('mutation Origin guard', () => {
  const guard = createMutationOriginGuard([
    'https://auto-mb.example',
    'http://127.0.0.1:4280',
  ]);

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'accepts an exact configured Origin for %s',
    (method) => {
      expect(() => guard(method, 'https://auto-mb.example')).not.toThrow();
    },
  );

  it.each([undefined, 'null', 'https://evil.example', 'https://auto-mb.example.evil'])(
    'rejects missing, opaque, or hostile Origin %s',
    (origin) => {
      expect(() => guard('POST', origin)).toThrowError(
        expect.objectContaining({ statusCode: 403, code: 'ORIGIN_FORBIDDEN' }),
      );
    },
  );

  it('rejects duplicate/multiple Origin header values', () => {
    expect(() =>
      guard('DELETE', 'https://auto-mb.example, https://evil.example'),
    ).toThrowError(expect.objectContaining({ code: 'ORIGIN_FORBIDDEN' }));
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('does not require Origin for %s', (method) => {
    expect(() => guard(method, undefined)).not.toThrow();
  });

  it('rejects malformed trusted-origin configuration at startup', () => {
    expect(() => createMutationOriginGuard(['https://example.com/path'])).toThrow(
      'Trusted origin must be an origin only',
    );
  });

  it('advances the Fastify hook lifecycle for allowed requests', async () => {
    const app = await buildApp({ trustedOrigins: ['https://auto-mb.example'] });
    try {
      app.post('/test-origin-hook', () => ({ ok: true }));

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);

      const allowed = await app.inject({
        method: 'POST',
        url: '/test-origin-hook',
        headers: { origin: 'https://auto-mb.example' },
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json()).toEqual({ ok: true });

      const denied = await app.inject({ method: 'POST', url: '/test-origin-hook' });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
