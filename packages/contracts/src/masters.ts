import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

/**
 * Master data is PICKERS ONLY: documents snapshot the chosen values into
 * their own columns (the Delivery Challan consignee stays a free-text
 * snapshot on the challan — see challans.ts), so editing or retiring a
 * master never rewrites any document. Masters retire via the active flag;
 * a hard delete does not exist.
 */

// --- Consignee masters ------------------------------------------------------

export const ConsigneeMasterSchema = Type.Object(
  {
    id: UuidSchema,
    designation: Type.String({ minLength: 2, maxLength: 200 }),
    address: Type.Union([Type.String({ minLength: 3, maxLength: 1000 }), Type.Null()]),
    contactPerson: Type.Union([
      Type.String({ minLength: 2, maxLength: 200 }),
      Type.Null(),
    ]),
    phone: Type.Union([Type.String({ minLength: 3, maxLength: 30 }), Type.Null()]),
    email: Type.Union([Type.String({ minLength: 3, maxLength: 200 }), Type.Null()]),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type ConsigneeMaster = Static<typeof ConsigneeMasterSchema>;

/** Create and full update share this shape; omitted optionals store NULL. */
export const SaveConsigneeMasterRequestSchema = Type.Object(
  {
    designation: Type.String({ minLength: 2, maxLength: 200 }),
    address: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })),
    contactPerson: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    phone: Type.Optional(Type.String({ minLength: 3, maxLength: 30 })),
    email: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type SaveConsigneeMasterRequest = Static<
  typeof SaveConsigneeMasterRequestSchema
>;

export const ConsigneeMasterListResponseSchema = Type.Object(
  { consignees: Type.Array(ConsigneeMasterSchema) },
  { additionalProperties: false },
);
export type ConsigneeMasterListResponse = Static<
  typeof ConsigneeMasterListResponseSchema
>;

// --- Location masters -------------------------------------------------------

export const LocationKindSchema = Type.Union([
  Type.Literal('station'),
  Type.Literal('installation_point'),
  Type.Literal('store'),
  Type.Literal('other'),
]);
export type LocationKind = Static<typeof LocationKindSchema>;

export const LocationMasterSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    kind: LocationKindSchema,
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type LocationMaster = Static<typeof LocationMasterSchema>;

export const SaveLocationMasterRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    kind: LocationKindSchema,
  },
  { additionalProperties: false },
);
export type SaveLocationMasterRequest = Static<typeof SaveLocationMasterRequestSchema>;

export const LocationMasterListResponseSchema = Type.Object(
  { locations: Type.Array(LocationMasterSchema) },
  { additionalProperties: false },
);
export type LocationMasterListResponse = Static<
  typeof LocationMasterListResponseSchema
>;

// --- Unit masters -----------------------------------------------------------

export const UnitMasterSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type UnitMaster = Static<typeof UnitMasterSchema>;

export const SaveUnitMasterRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
export type SaveUnitMasterRequest = Static<typeof SaveUnitMasterRequestSchema>;

export const UnitMasterListResponseSchema = Type.Object(
  { units: Type.Array(UnitMasterSchema) },
  { additionalProperties: false },
);
export type UnitMasterListResponse = Static<typeof UnitMasterListResponseSchema>;

// --- Organisation signatories -----------------------------------------------

export const SignatorySchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    designation: Type.String({ minLength: 2, maxLength: 200 }),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Signatory = Static<typeof SignatorySchema>;

export const SaveSignatoryRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    designation: Type.String({ minLength: 2, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type SaveSignatoryRequest = Static<typeof SaveSignatoryRequestSchema>;

export const SignatoryListResponseSchema = Type.Object(
  { signatories: Type.Array(SignatorySchema) },
  { additionalProperties: false },
);
export type SignatoryListResponse = Static<typeof SignatoryListResponseSchema>;
