import { Type, type Static } from '@sinclair/typebox';

export const UuidSchema = Type.String({ format: 'uuid' });
export type Uuid = Static<typeof UuidSchema>;

export const DateOnlySchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Calendar date with no time or timezone.',
});
export type DateOnly = Static<typeof DateOnlySchema>;

export const DecimalStringSchema = Type.String({
  pattern: '^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,3})?$',
  description:
    'Decimal value transported as a string; authoritative arithmetic is not binary floating point.',
});
export type DecimalString = Static<typeof DecimalStringSchema>;
