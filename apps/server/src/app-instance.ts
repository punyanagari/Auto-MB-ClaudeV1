import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

/**
 * The Fastify instance as every route module sees it: buildApp applies the
 * TypeBox type provider once, so `request.params`, `request.body` and
 * `request.query` carry the static types of the schemas each route declares
 * and the `as { ... }` casts are gone. This is purely a compile-time alias —
 * runtime validation and serialisation are exactly what they were.
 */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;
