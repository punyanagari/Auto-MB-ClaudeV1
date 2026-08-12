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

export function createMutationOriginGuard(
  trustedOrigins: readonly string[],
): (method: string, originHeader: string | undefined) => void {
  if (trustedOrigins.length === 0) {
    throw new Error('trustedOrigins cannot be empty when the Origin guard is enabled');
  }
  const allowed = new Set(trustedOrigins.map(canonicalOrigin));
  return (method, originHeader) => {
    if (!MUTATION_METHODS.has(method.toUpperCase())) return;
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
