import { Type, type Static } from '@sinclair/typebox';

export const ApiErrorSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type ApiError = Static<typeof ApiErrorSchema>;
