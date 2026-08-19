import { httpError } from './http.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid trusted origin: ${value}`);
  }
  if (
    url.origin === 'null' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`Trusted origin must be an origin only: ${value}`);
  }
  return url.origin;
}

/**
 * Routes the Origin guard does not apply to, and cannot sensibly apply to.
 *
 * The guard is a CSRF control. CSRF is an attack on AMBIENT authority: a
 * browser attaches the session cookie to a cross-site form post because
 * the browser, not the caller, decided to. A request authenticated by a
 * bearer token the caller had to possess and send has no ambient
 * authority to abuse — there is nothing for a hostile page to ride.
 *
 * The kiosk signing agent (0091) is exactly that caller, and it is a
 * PowerShell process, which sends no `Origin` header at all. Left inside
 * the guard the whole lane is dead the moment `trustedOrigins` is
 * configured — which is production only, and invisibly, because the agent
 * reads a 403 as a transport blip and backs off.
 *
 * Matched against the ROUTE PATTERN Fastify resolved, never the raw URL:
 * a prefix test on `request.url` would be widened by anything that
 * resolves to a path starting with these strings, and a raw URL is
 * attacker-shaped input. The pattern is what the router already decided.
 */
const ORIGIN_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/signing/agent/claim',
  'POST /api/signing/agent/requests/:id/result',
  // Meta's WhatsApp delivery-receipt webhook (0092). The same argument
  // exactly: it carries no session cookie, so there is no ambient
  // authority for a hostile page to ride, and Meta sends no `Origin`
  // header at all. What stands in place of the guard is the HMAC — the
  // receiver verifies `X-Hub-Signature-256` over the raw body before it
  // reads a field, which is a strictly stronger check than an origin
  // string a browser volunteered.
  'POST /api/notifications/webhook',
]);

export function isOriginExemptRoute(method: string, routePattern: string): boolean {
  return ORIGIN_EXEMPT_ROUTES.has(`${method.toUpperCase()} ${routePattern}`);
}

export function createMutationOriginGuard(
  trustedOrigins: readonly string[],
): (method: string, originHeader: string | undefined, routePattern?: string) => void {
  if (trustedOrigins.length === 0) {
    throw new Error('trustedOrigins cannot be empty when the Origin guard is enabled');
  }
  const allowed = new Set(trustedOrigins.map(canonicalOrigin));
  return (method, originHeader, routePattern) => {
    if (!MUTATION_METHODS.has(method.toUpperCase())) return;
    if (routePattern !== undefined && isOriginExemptRoute(method, routePattern)) return;
    if (
      originHeader === undefined ||
      originHeader === 'null' ||
      originHeader.includes(',') ||
      !allowed.has(originHeader)
    ) {
      throw httpError(
        403,
        'ORIGIN_FORBIDDEN',
        'This mutation did not come from the configured application origin.',
      );
    }
  };
}
