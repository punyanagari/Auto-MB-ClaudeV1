import { Type, type Static } from '@sinclair/typebox';

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
