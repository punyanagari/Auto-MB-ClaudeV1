import type { FastifyRequest } from 'fastify';

/** An Error carrying an HTTP status and stable code; the app-level error
 * handler forwards both into the ApiError envelope. Optional `details`
 * carry a structured payload (e.g. one-draft 409s answer with
 * `{ existingRecordId }` — see DraftConflictDetails in @auto-mb/contracts). */
export function httpError(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): Error {
  return Object.assign(
    new Error(message),
    details === undefined ? { statusCode, code } : { statusCode, code, details },
  );
}

/** Copies the incoming Fastify headers into a WHATWG Headers object for
 * Better Auth's Web-standard handler and session API. */
export function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.append(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    }
  }
  return headers;
}

/** Rebuilds a Web Request from a Fastify request for Better Auth's
 * handler. Auth endpoints speak JSON, so the already-parsed body is
 * re-serialised. */
export function toWebRequest(request: FastifyRequest): Request {
  const url = `http://${request.headers.host ?? '127.0.0.1'}${request.url}`;
  const headers = toWebHeaders(request);
  const hasBody =
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body !== undefined &&
    request.body !== null;
  if (hasBody) {
    headers.set('content-type', 'application/json');
    return new Request(url, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
    });
  }
  return new Request(url, { method: request.method, headers });
}
