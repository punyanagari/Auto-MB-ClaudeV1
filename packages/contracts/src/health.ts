import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    service: Type.String(),
    version: Type.String(),
    timestamp: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;

/** Runtime guard for untyped payloads (e.g. fetch responses in the web
 * shell). Format annotations are enforced via the registry in
 * `formats.ts`. */
export function isHealthResponse(value: unknown): value is HealthResponse {
  return Value.Check(HealthResponseSchema, value);
}

export const ReadinessComponentSchema = Type.Union([
  Type.Literal('ok'),
  Type.Literal('failed'),
  Type.Literal('unconfigured'),
]);

export const ReadinessResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ready'), Type.Literal('not-ready')]),
    reason: Type.Optional(Type.String()),
    components: Type.Optional(
      Type.Object(
        {
          database: ReadinessComponentSchema,
          objectStorage: ReadinessComponentSchema,
          pdfRenderer: ReadinessComponentSchema,
          malwareScanner: ReadinessComponentSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ReadinessResponse = Static<typeof ReadinessResponseSchema>;
