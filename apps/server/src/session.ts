import type { FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import { httpError, toWebHeaders } from './http.js';

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

export async function requireUser(
  auth: Auth,
  request: FastifyRequest,
): Promise<SessionUser> {
  const session = await auth.api.getSession({ headers: toWebHeaders(request) });
  if (!session) {
    throw httpError(401, 'UNAUTHENTICATED', 'Sign in to use this endpoint.');
  }
  return { id: session.user.id, email: session.user.email };
}
