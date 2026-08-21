import { Type, type Static } from '@sinclair/typebox';
import { DateOnlySchema, GstRateSchema, UuidSchema } from './primitives.js';

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

// --- Bank beneficiary details (migration 0078) ------------------------------
//
// Shared by the two writers that record a bank account: a contact's
// payment-beneficiary details (below) and the organisation's own accounts
// (organisations.ts). Both are proved by the same normalisers in
// apps/server/src/contact-fields.ts and the same CHECKs in migration 0078,
// so the two surfaces cannot drift into disagreeing about what an account
// number is.

/** RBI IFSC: four letters naming the bank, a reserved '0', six
 * alphanumerics naming the branch. Accepted in any case; stored upper. */
export const IfscSchema = Type.String({ minLength: 11, maxLength: 11 });

/** Six to eighteen alphanumerics, uppercased, at least one a digit.
 * Wider than the NPCI 9-to-18 digit range on purpose — cooperative and
 * older district banks issue shorter and occasionally alphanumeric
 * numbers, and refusing a real account is a worse failure than accepting
 * an unlikely-looking one; the digit clause is what stops that width
 * admitting prose. The exact shape is proved server-side so the refusal
 * can say why. */
export const BankAccountNumberSchema = Type.String({ minLength: 6, maxLength: 18 });

export const BankAccountHolderSchema = Type.String({ minLength: 2, maxLength: 200 });
export const BankNameSchema = Type.String({ minLength: 2, maxLength: 100 });
export const BankBranchSchema = Type.String({ minLength: 2, maxLength: 100 });

/** Five letters, four digits, one letter. Checked here as well as in the
 * database because an unregistered vendor PAN has no GSTIN to fall back
 * on and a typo would silently engage the 206AA floor.
 *
 * Either case is accepted and the route uppercases before storing, the
 * way the GSTIN is handled: a PAN is read off a card and typed, and the
 * database CHECK only accepts upper case, so rejecting lower case at the
 * edge would refuse a correct value for its capitalisation. */
const PanSchema = Type.String({
  pattern: '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$',
  minLength: 10,
  maxLength: 10,
});

// --- The address list (migration 0116) --------------------------------------
//
// A contact keeps more than one address: a vendor with a works at one town
// and a registered office at another, a railway consignee with a stores
// depot beside its headquarters. One of them is PRIMARY, and the primary
// is mirrored onto the contact's own `address`/`pincode`/`locality`/
// `stateCode` fields by the database — so every document flow that
// already prefills from those fields keeps working and now means "the
// primary address" exactly.
//
// Documents still snapshot: choosing a different address changes WHICH
// text is copied onto the record, never what an already-issued record
// says. Retiring an address rewrites nothing.

export const ContactAddressSchema = Type.Object(
  {
    id: UuidSchema,
    /** What the operator calls this place — "Works, Hosur". Optional,
     * because a one-address contact needs no name to be unambiguous. */
    label: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    address: Type.String({ minLength: 3, maxLength: 1000 }),
    pincode: Type.Union([Type.String({ pattern: '^[0-9]{6}$' }), Type.Null()]),
    locality: Type.Union([Type.String({ minLength: 2, maxLength: 100 }), Type.Null()]),
    stateCode: Type.Union([Type.String({ pattern: '^[0-9]{2}$' }), Type.Null()]),
    /** The one every picker offers first, and the one mirrored onto the
     * contact. At most one per contact, and never a retired row. */
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer({ minimum: 0 }),
    active: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ContactAddress = Static<typeof ContactAddressSchema>;

/** Create and full update share this shape. `isPrimary` is a MOVE, not a
 * field: sending it true demotes whichever address held it, and the
 * server refuses to leave a live contact with none. Retiring the primary
 * promotes the next active address rather than failing. */
export const SaveContactAddressRequestSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    address: Type.String({ minLength: 3, maxLength: 1000 }),
    pincode: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
    locality: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
    stateCode: Type.Optional(Type.String({ pattern: '^[0-9]{2}$' })),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type SaveContactAddressRequest = Static<typeof SaveContactAddressRequestSchema>;

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
    /** Where a payment to this contact goes (migration 0078). The four
     * payable fields travel together — holder, bank, number and IFSC are
     * all present or all null, because a partial set is not a beneficiary
     * anyone can be paid as. Branch and account type are decoration on a
     * payment advice and stay independently optional.
     *
     * Returned in full rather than masked, unlike the organisation's own
     * accounts: this is an EDIT form's record, and a masked number cannot
     * be round-tripped through a full-replace update without wiping the
     * value it stands for. Optional on the wire so a reader that predates
     * migration 0078 omits them rather than reporting nulls it never
     * stored. */
    bankAccountHolder: Type.Optional(
      Type.Union([BankAccountHolderSchema, Type.Null()]),
    ),
    bankName: Type.Optional(Type.Union([BankNameSchema, Type.Null()])),
    bankAccountNumber: Type.Optional(
      Type.Union([BankAccountNumberSchema, Type.Null()]),
    ),
    bankIfsc: Type.Optional(Type.Union([IfscSchema, Type.Null()])),
    bankBranch: Type.Optional(Type.Union([BankBranchSchema, Type.Null()])),
    bankAccountType: Type.Optional(
      Type.Union([Type.String({ minLength: 2, maxLength: 50 }), Type.Null()]),
    ),
    /** A person this organisation pays an advance or reimbursement to
     * (migration 0080). Deliberately independent of membership: being
     * paid is not being granted access, and a site worker with no login
     * is still paid. */
    isEmployee: Type.Boolean(),
    /** The party PAN. Decides whether section 206AA floors a vendor
     * payment at 20% (migration 0080). Backfilled from the GSTIN, whose
     * characters 3-12 are the holder PAN. */
    pan: Type.Union([PanSchema, Type.Null()]),
    /** Every address this contact keeps, primary first, retired ones last
     * (migration 0116). The four address fields above remain the PRIMARY
     * address, mirrored by the database, so a reader that only wants "the
     * address" needs nothing from this list.
     *
     * Optional on the wire like the bank block above, so a reader that
     * predates 0116 omits it rather than reporting an empty list it never
     * stored. */
    addresses: Type.Optional(Type.Array(ContactAddressSchema)),
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
    /** Bank beneficiary details (migration 0078). Profile text, so these
     * follow the rule the rest of this body follows and NOT the role
     * flags': an omitted field stores NULL. The four payable fields are
     * refused unless they arrive together. IFSC is accepted in any case
     * and stored upper, like the GSTIN above. */
    bankAccountHolder: Type.Optional(BankAccountHolderSchema),
    bankName: Type.Optional(BankNameSchema),
    bankAccountNumber: Type.Optional(BankAccountNumberSchema),
    bankIfsc: Type.Optional(IfscSchema),
    bankBranch: Type.Optional(BankBranchSchema),
    bankAccountType: Type.Optional(Type.String({ minLength: 2, maxLength: 50 })),
    isEmployee: Type.Optional(Type.Boolean()),
    /** Explicit null clears the PAN; omitting the field preserves what
     * is stored. Same shape as every sibling nullable field, so an edit
     * form that only sends what changed does not blank the rest. */
    pan: Type.Optional(Type.Union([PanSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type SaveContactRequest = Static<typeof SaveContactRequestSchema>;

export const ContactListResponseSchema = Type.Object(
  { contacts: Type.Array(ContactSchema) },
  { additionalProperties: false },
);

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

export const LinkWorkConsigneeRequestSchema = Type.Object(
  { contactId: UuidSchema },
  { additionalProperties: false },
);

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

// --- GST rate master (migration 0048, audit finding 19) ---------------------
//
// The Government-notified GST rates with the date range each was in
// force. Documents must carry a (rate, date) pair a row here covers; the
// server refuses anything else and the 0048 trigger backstops tax
// invoices in the database. Unlike the flag-retired masters above, a
// rate leaves force by END-DATING (effectiveTo) — deleting or editing a
// referenced rate would rewrite the meaning of stored invoices, so
// neither exists. Reads are for every member (pickers); mutations are
// owner-only.

export const GstRateMasterSchema = Type.Object(
  {
    id: UuidSchema,
    /** numeric(5,2)-normalised text, e.g. '18.00'. */
    rate: GstRateSchema,
    label: Type.String({ minLength: 2, maxLength: 100 }),
    effectiveFrom: DateOnlySchema,
    /** null: in force with no announced end. */
    effectiveTo: Type.Union([DateOnlySchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type GstRateMaster = Static<typeof GstRateMasterSchema>;

export const CreateGstRateRequestSchema = Type.Object(
  {
    rate: GstRateSchema,
    label: Type.String({ minLength: 2, maxLength: 100 }),
    effectiveFrom: DateOnlySchema,
    /** Omitted: open-ended. A past notification may arrive already closed. */
    effectiveTo: Type.Optional(DateOnlySchema),
  },
  { additionalProperties: false },
);
export type CreateGstRateRequest = Static<typeof CreateGstRateRequestSchema>;

export const EndDateGstRateRequestSchema = Type.Object(
  { effectiveTo: DateOnlySchema },
  { additionalProperties: false },
);
export type EndDateGstRateRequest = Static<typeof EndDateGstRateRequestSchema>;

export const GstRateListResponseSchema = Type.Object(
  { gstRates: Type.Array(GstRateMasterSchema) },
  { additionalProperties: false },
);

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

// --- Canonical items (migration 0078) ---------------------------------------
//
// The organisation's catalogue of the products behind its differently
// worded schedule lines: three Works can each spell one horn speaker
// differently, and this is where somebody says they are the same thing.
//
// Unlike every other master here, this one is not a picker. Nothing
// selects a canonical item into a document; it exists so schedule lines
// can be searched and compared across Works. Its link to `work_items` is
// DERIVED rather than stored — a line is mapped when its description
// equals this item's name or one of its aliases, lowercased and trimmed —
// so `mappedLineCount` is computed per read and no writer maintains it.
// Migration 0078 records why there is no `canonical_item_id` column.

export const CanonicalItemSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ minLength: 2, maxLength: 200 }),
    /** A label rendered as a badge, not a foreign key. The distinct
     * values across an organisation's items are its group list. */
    groupName: Type.String({ minLength: 2, maxLength: 100 }),
    make: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    model: Type.Union([Type.String({ minLength: 1, maxLength: 100 }), Type.Null()]),
    /** A suggestion for a form default, not a value documents are
     * validated against — so free text rather than a unit master id. */
    defaultUnit: Type.String({ minLength: 1, maxLength: 20 }),
    /** The other wordings that mean this item. Stored trimmed and
     * lowercased: they are matched, not displayed as typed. */
    aliases: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 50,
    }),
    /** Live schedule lines across every Work whose description matches
     * this item's name or one of its aliases. Computed per read. */
    mappedLineCount: Type.Integer({ minimum: 0 }),
    active: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type CanonicalItem = Static<typeof CanonicalItemSchema>;

export const SaveCanonicalItemRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 2, maxLength: 200 }),
    groupName: Type.String({ minLength: 2, maxLength: 100 }),
    make: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    defaultUnit: Type.String({ minLength: 1, maxLength: 20 }),
    /** Trimmed, lowercased and de-duplicated server-side; blanks drop. */
    aliases: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
    ),
  },
  { additionalProperties: false },
);
export type SaveCanonicalItemRequest = Static<typeof SaveCanonicalItemRequestSchema>;

export const CanonicalItemListResponseSchema = Type.Object(
  {
    items: Type.Array(CanonicalItemSchema),
    /** Live schedule lines that no ACTIVE canonical item claims — the
     * warning line the Items tab prints above the table. Counted from the
     * same normalised descriptions the mapping uses, so the two numbers
     * cannot disagree about what a line is. */
    unmappedLineCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CanonicalItemListResponse = Static<typeof CanonicalItemListResponseSchema>;
