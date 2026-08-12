import { Type, type Static } from '@sinclair/typebox';
import { UuidSchema } from './primitives.js';

/**
 * Master data is PICKERS ONLY: documents snapshot the chosen values into
 * their own columns (the Delivery Challan consignee stays a free-text
 * snapshot on the challan — see challans.ts), so editing or retiring a
 * master never rewrites any document. Masters retire via the active flag;
 * a hard delete does not exist.
 */

// --- Contacts (unified master, legacy §9) -----------------------------------
//
// One master for consignees / vendors / clients with role flags. All
// three roles are live: consignees receive railway deliveries, vendors
// take purchase orders and clients buy under tax invoices (the
// procurement wave, PO/BQ, legacy §5.8). GSTIN is uppercased and
// format-validated server-side, accepting TDS-deductor GSTINs ending in
// 'D' (railway units are deductors — spec §2/§5.7).

/** 15 uppercase alphanumerics; exact structure (standard vs deductor
 * ending in 'D') is validated server-side so the error can explain it. */
export const GstinSchema = Type.String({ minLength: 15, maxLength: 15 });

export const ContactSchema = Type.Object(
  {
    id: UuidSchema,
    designation: Type.String({ minLength: 2, maxLength: 200 }),
    contactPerson: Type.Union([
      Type.String({ minLength: 2, maxLength: 200 }),
      Type.Null(),
    ]),
    address: Type.Union([Type.String({ minLength: 3, maxLength: 1000 }), Type.Null()]),
    phone: Type.Union([Type.String({ minLength: 3, maxLength: 30 }), Type.Null()]),
    email: Type.Union([Type.String({ minLength: 3, maxLength: 200 }), Type.Null()]),
    gstin: Type.Union([GstinSchema, Type.Null()]),
    pincode: Type.Union([Type.String({ pattern: '^[0-9]{6}$' }), Type.Null()]),
    stateCode: Type.Union([Type.String({ pattern: '^[0-9]{2}$' }), Type.Null()]),
    /** Explicit NIC BuyerDtls/ShipDtls.Loc value. */
    locality: Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
    /** Railway division code as the railnet STD directory writes it.
     * A number series may draw on it ({DIV} drops one trailing zero),
     * which is why it is stored as the directory writes it. */
    divisionCode: Type.Union([Type.String({ pattern: '^[0-9]{2,5}$' }), Type.Null()]),
    isConsignee: Type.Boolean(),
    /** Purchase orders are placed on vendor contacts (legacy §5.8). */
    isVendor: Type.Boolean(),
    /** Tax invoices name client contacts as the buyer (legacy §5.8). */
    isClient: Type.Boolean(),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type Contact = Static<typeof ContactSchema>;

/** Create and full update share this shape; omitted optionals store NULL
 * — except the ROLE FLAGS, which are membership rather than profile text:
 * an omitted flag leaves the stored value unchanged (false at creation).
 *
 * A create that names neither role makes a consignee, exactly as every
 * create did before the procurement wave; a create carrying `isVendor`
 * and/or `isClient` makes a vendor/client that is NOT a consignee (the
 * roles feed disjoint pickers — railway document flows stay
 * railway-only, §9). `isConsignee` itself is a create-time fact with no
 * request field: it is true exactly when no other role was asked for,
 * and an update never changes it. The R16 authority-designation refusal
 * applies to consignee-role contacts ONLY — a vendor may carry any name
 * its letterhead does. */
export const SaveContactRequestSchema = Type.Object(
  {
    designation: Type.String({ minLength: 2, maxLength: 200 }),
    contactPerson: Type.Optional(Type.String({ minLength: 2, maxLength: 200 })),
    address: Type.Optional(Type.String({ minLength: 3, maxLength: 1000 })),
    phone: Type.Optional(Type.String({ minLength: 3, maxLength: 30 })),
    email: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
    /** Accepted in any case; stored uppercase. */
    gstin: Type.Optional(GstinSchema),
    pincode: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
    stateCode: Type.Optional(Type.String({ pattern: '^[0-9]{2}$' })),
    locality: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
    divisionCode: Type.Optional(Type.String({ pattern: '^[0-9]{2,5}$' })),
    isVendor: Type.Optional(Type.Boolean()),
    isClient: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SaveContactRequest = Static<typeof SaveContactRequestSchema>;

export const ContactListResponseSchema = Type.Object(
  { contacts: Type.Array(ContactSchema) },
  { additionalProperties: false },
);
export type ContactListResponse = Static<typeof ContactListResponseSchema>;

// --- Work <-> consignee association (legacy R16) ----------------------------
//
// "A work may have many consignees; the challan picks one." The
// association is an organisational preference list feeding the pickers —
// linked consignees are OFFERED FIRST for the Work's challans and PAC
// certificates, but any active consignee contact stays selectable
// (legacy behaviour; the association is convenience, not a restriction).
// Documents keep snapshotting whatever was picked.

export const WorkConsigneeListResponseSchema = Type.Object(
  { consignees: Type.Array(ContactSchema) },
  { additionalProperties: false },
);
export type WorkConsigneeListResponse = Static<typeof WorkConsigneeListResponseSchema>;

export const LinkWorkConsigneeRequestSchema = Type.Object(
  { contactId: UuidSchema },
  { additionalProperties: false },
);
export type LinkWorkConsigneeRequest = Static<typeof LinkWorkConsigneeRequestSchema>;

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
