import { Type, type Static } from '@sinclair/typebox';
import { NextCursorSchema } from './pagination.js';
import { UuidSchema, nonBlankString } from './primitives.js';

// --- Notifications (migration 0092) -----------------------------------------
//
// Telling somebody something: the channels the organisation may speak
// through, the templates it is allowed to say, the consent that permits
// each recipient to be spoken to, and the log of what it actually sent.
//
// WhatsApp is the primary channel and email the secondary one. The wire
// says `channel` everywhere rather than modelling WhatsApp specially,
// because the whole point of the pack is that a caller — this route
// today, document delivery and MSME alerting later — asks for a template
// to reach a contact and does not decide which road it takes.
//
// THE MOCK DRAWS NO NOTIFICATIONS SCREEN. The register and settings
// below are application-first under AGENTS.md § Design contract 4, built
// in the mock's existing grammar — its page header, data table, status
// chip and card — with no new visual language. `docs/UX.md` § 17 records
// the stance and the reasoning rather than inventing a citation for a
// screen that does not exist at `punyanagari/Auto-MB-Vercel-du@fdfd610`.
//
// NOTHING HERE CARRIES A CREDENTIAL. The WhatsApp access token, the
// webhook app secret and the SMTP password are deployment environment,
// read into an injected adapter (0053's posture, restated in 0092's
// header). What travels on this wire is identity — the phone number id,
// the display number, the sender address — which an operator must be able
// to read back and compare against the Meta console.

/* --- Vocabulary ----------------------------------------------------------- */

const NOTIFICATION_CHANNELS = ['whatsapp', 'email'] as const;
const NotificationChannelNameSchema = Type.Union(
  NOTIFICATION_CHANNELS.map((value) => Type.Literal(value)),
  { description: 'Which road a notification takes.' },
);
export type NotificationChannelName = Static<typeof NotificationChannelNameSchema>;

/** Meta's own template lifecycle, plus the local `draft` that precedes
 * submission. Recorded by a member reading the Meta console rather than
 * polled: the WABA that would answer a poll is still in onboarding. */
const NOTIFICATION_TEMPLATE_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
const NotificationTemplateStatusSchema = Type.Union(
  NOTIFICATION_TEMPLATE_STATUSES.map((value) => Type.Literal(value)),
  { description: "Where a template has got to in Meta's review." },
);
export type NotificationTemplateStatus = Static<typeof NotificationTemplateStatusSchema>;

const NOTIFICATION_TEMPLATE_CATEGORIES = [
  'utility',
  'marketing',
  'authentication',
] as const;
const NotificationTemplateCategorySchema = Type.Union(
  NOTIFICATION_TEMPLATE_CATEGORIES.map((value) => Type.Literal(value)),
  { description: "Meta's template category, which decides how it is priced and reviewed." },
);

const NOTIFICATION_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed'] as const;
const NotificationStatusSchema = Type.Union(
  NOTIFICATION_STATUSES.map((value) => Type.Literal(value)),
  { description: 'How far a message got. Forward only.' },
);
export type NotificationStatus = Static<typeof NotificationStatusSchema>;

const CONSENT_STATES = ['opted_in', 'opted_out'] as const;
const ConsentStateSchema = Type.Union(
  CONSENT_STATES.map((value) => Type.Literal(value)),
  { description: 'Whether this contact has agreed to be messaged on this channel.' },
);
export type NotificationConsentState = Static<typeof ConsentStateSchema>;

/** E.164, which is what WhatsApp addresses by and what an operator reads
 * off the Meta console. */
const PhoneNumberSchema = Type.String({
  pattern: '^\\+[1-9][0-9]{7,14}$',
  description: 'E.164 telephone number, leading plus included.',
});

/** Meta's own identifier shape: an opaque decimal string. */
const MetaIdSchema = Type.String({ pattern: '^[0-9]{5,32}$' });

/** Deliberately shape-only rather than a full address grammar. The relay
 * is the authority on what it will accept, and a stricter pattern here
 * would refuse valid addresses the relay is happy with. */
const EmailAddressSchema = Type.String({
  pattern: '^[^@\\s]+@[^@\\s]+$',
  minLength: 3,
  maxLength: 200,
});

const TimestampSchema = Type.String({ format: 'date-time' });
const NullableTimestampSchema = Type.Union([TimestampSchema, Type.Null()]);
const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

/* --- Channels ------------------------------------------------------------- */

const NotificationChannelSchema = Type.Object(
  {
    id: UuidSchema,
    channel: NotificationChannelNameSchema,
    /** Whether to actually send. Separate from whether the fields are
     * filled in, because Meta onboarding arrives in pieces over weeks. */
    enabled: Type.Boolean(),
    wabaPhoneNumberId: Type.Union([MetaIdSchema, Type.Null()]),
    wabaBusinessAccountId: Type.Union([MetaIdSchema, Type.Null()]),
    displayPhoneNumber: Type.Union([PhoneNumberSchema, Type.Null()]),
    /** Null means Meta Cloud API direct, which is the default. A value
     * fronts the same wire protocol through a BSP. */
    apiBaseUrl: NullableStringSchema,
    fromAddress: Type.Union([EmailAddressSchema, Type.Null()]),
    replyToAddress: Type.Union([EmailAddressSchema, Type.Null()]),
    /** Whether the DEPLOYMENT has a transport for this channel at all —
     * the access token or the SMTP relay. Read from the server's
     * environment, never from this organisation's row, and reported so
     * the screen can say "configured here, but this deployment cannot
     * send" instead of failing at the first message. */
    transportConfigured: Type.Boolean(),
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type NotificationChannel = Static<typeof NotificationChannelSchema>;

export const NotificationChannelListResponseSchema = Type.Object(
  { channels: Type.Array(NotificationChannelSchema) },
  { additionalProperties: false },
);
export type NotificationChannelListResponse = Static<
  typeof NotificationChannelListResponseSchema
>;

/**
 * The whole configuration of one channel, replaced in one call.
 *
 * A PUT rather than a PATCH because the shape CHECKs in 0092 are
 * per-channel: a partial update would have to merge against the stored
 * row to know whether the result is a legal WhatsApp row or a legal email
 * one, and the merge is exactly where a half-configured channel gets
 * enabled by accident.
 */
export const SaveNotificationChannelSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    wabaPhoneNumberId: Type.Optional(Type.Union([MetaIdSchema, Type.Null()])),
    wabaBusinessAccountId: Type.Optional(Type.Union([MetaIdSchema, Type.Null()])),
    displayPhoneNumber: Type.Optional(Type.Union([PhoneNumberSchema, Type.Null()])),
    apiBaseUrl: Type.Optional(
      Type.Union([
        Type.String({ pattern: '^https://', minLength: 12, maxLength: 400 }),
        Type.Null(),
      ]),
    ),
    fromAddress: Type.Optional(Type.Union([EmailAddressSchema, Type.Null()])),
    replyToAddress: Type.Optional(Type.Union([EmailAddressSchema, Type.Null()])),
  },
  { additionalProperties: false },
);
export type SaveNotificationChannel = Static<typeof SaveNotificationChannelSchema>;

export const NotificationChannelResponseSchema = Type.Object(
  { channel: NotificationChannelSchema },
  { additionalProperties: false },
);
export type NotificationChannelResponse = Static<
  typeof NotificationChannelResponseSchema
>;

/* --- Templates ------------------------------------------------------------ */

const NotificationTemplateSchema = Type.Object(
  {
    id: UuidSchema,
    /** Meta's template name rules, enforced on the way in so a name that
     * could never be submitted is refused when it is typed. */
    name: Type.String(),
    language: Type.String(),
    category: NotificationTemplateCategorySchema,
    status: NotificationTemplateStatusSchema,
    /** Meta's own words for what it did, copied by the member who read
     * them. */
    statusReason: NullableStringSchema,
    bodyText: Type.String(),
    parameterCount: Type.Integer(),
    /** Present exactly when this template may go out by email. WhatsApp
     * has no subject line, so its absence is what makes a template
     * WhatsApp-only rather than a missing field. */
    emailSubject: NullableStringSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type NotificationTemplate = Static<typeof NotificationTemplateSchema>;

export const NotificationTemplateListResponseSchema = Type.Object(
  {
    templates: Type.Array(NotificationTemplateSchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type NotificationTemplateListResponse = Static<
  typeof NotificationTemplateListResponseSchema
>;

export const CreateNotificationTemplateSchema = Type.Object(
  {
    name: Type.String({ pattern: '^[a-z0-9_]{1,512}$' }),
    language: Type.String({ pattern: '^[a-z]{2}(_[A-Z]{2})?$' }),
    category: NotificationTemplateCategorySchema,
    bodyText: nonBlankString({ minLength: 1, maxLength: 1024 }),
    /** Optional, and its absence is a decision: a template with no
     * subject is WhatsApp-only. */
    emailSubject: Type.Optional(nonBlankString({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);
export type CreateNotificationTemplate = Static<typeof CreateNotificationTemplateSchema>;

/**
 * Moving a template along Meta's lifecycle.
 *
 * `draft` is absent: a template is created as a draft and never returns
 * to one. So is a resubmission of a rejected template — Meta rejected a
 * body, the body freezes at submission, and a resubmission is therefore a
 * different template rather than the same row asked again.
 */
export const SetNotificationTemplateStatusSchema = Type.Object(
  {
    status: Type.Union(
      (['pending', 'approved', 'rejected', 'paused', 'disabled'] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    reason: Type.Optional(nonBlankString({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);
export type SetNotificationTemplateStatus = Static<
  typeof SetNotificationTemplateStatusSchema
>;

export const NotificationTemplateResponseSchema = Type.Object(
  { template: NotificationTemplateSchema },
  { additionalProperties: false },
);
export type NotificationTemplateResponse = Static<
  typeof NotificationTemplateResponseSchema
>;

/* --- Consent -------------------------------------------------------------- */

const NotificationConsentSchema = Type.Object(
  {
    id: UuidSchema,
    contactId: UuidSchema,
    /** What an operator recognises the contact by; the uuid is what the
     * API addresses. */
    contactDesignation: Type.String(),
    channel: NotificationChannelNameSchema,
    /** The address the agreement was given FOR. Consent is per address,
     * not per person: a railway office mobile is reassigned when the
     * officer transfers. */
    address: Type.String(),
    state: ConsentStateSchema,
    evidence: Type.String(),
    recordedByUserId: Type.String(),
    recordedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type NotificationConsent = Static<typeof NotificationConsentSchema>;

export const NotificationConsentListResponseSchema = Type.Object(
  {
    consents: Type.Array(NotificationConsentSchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type NotificationConsentListResponse = Static<
  typeof NotificationConsentListResponseSchema
>;

export const RecordNotificationConsentSchema = Type.Object(
  {
    contactId: UuidSchema,
    channel: NotificationChannelNameSchema,
    address: nonBlankString({ minLength: 3, maxLength: 200 }),
    state: ConsentStateSchema,
    /** How the agreement was obtained, in the recording member's own
     * words. Required for an opt-out too, where it records who asked to
     * stop. */
    evidence: nonBlankString({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type RecordNotificationConsent = Static<typeof RecordNotificationConsentSchema>;

export const NotificationConsentResponseSchema = Type.Object(
  { consent: NotificationConsentSchema },
  { additionalProperties: false },
);
export type NotificationConsentResponse = Static<
  typeof NotificationConsentResponseSchema
>;

/* --- The delivery log ----------------------------------------------------- */

const NotificationMessageSchema = Type.Object(
  {
    id: UuidSchema,
    channel: NotificationChannelNameSchema,
    templateId: UuidSchema,
    templateName: Type.String(),
    templateLanguage: Type.String(),
    contactId: UuidSchema,
    contactDesignation: Type.String(),
    /** Who it went to. A delivery log that cannot say that answers
     * nothing — but it is never written to a log line (AGENTS.md 11). */
    toAddress: Type.String(),
    /** The ordered {{1}}..{{n}} values. The rendered text is not stored:
     * it is reproducible from the template and these. */
    parameters: Type.Array(Type.String()),
    status: NotificationStatusSchema,
    /** Which transport actually carried it, recorded per message rather
     * than read from the editable channel row. */
    provider: Type.Union(
      (['meta_cloud', 'bsp', 'smtp'] as const).map((value) => Type.Literal(value)),
    ),
    providerMessageId: NullableStringSchema,
    /** The provider's symbolic code and a short line. Never its raw
     * response body, which echoes the recipient's number back. */
    failureCode: NullableStringSchema,
    failureDetail: NullableStringSchema,
    requestedByUserId: Type.String(),
    queuedAt: TimestampSchema,
    sentAt: NullableTimestampSchema,
    deliveredAt: NullableTimestampSchema,
    readAt: NullableTimestampSchema,
    failedAt: NullableTimestampSchema,
  },
  { additionalProperties: false },
);
export type NotificationMessage = Static<typeof NotificationMessageSchema>;

export const NotificationMessageListResponseSchema = Type.Object(
  {
    messages: Type.Array(NotificationMessageSchema),
    nextCursor: NextCursorSchema,
  },
  { additionalProperties: false },
);
export type NotificationMessageListResponse = Static<
  typeof NotificationMessageListResponseSchema
>;

/**
 * Send one templated message to one contact.
 *
 * The caller names the template and the contact and NOT the address: the
 * address comes from the consent record, which is the only thing that can
 * say which address this contact agreed to be reached at. A caller that
 * could pass an address could send to one the contact never consented
 * to — which is the whole rule, expressed as a missing field.
 *
 * `channel` is optional, and omitting it is the intended shape for
 * everything built on top of this pack: the server picks the primary
 * channel the contact has consented to and falls back to the secondary
 * one, so a caller sends a message without knowing which road it takes.
 */
export const SendNotificationSchema = Type.Object(
  {
    templateId: UuidSchema,
    contactId: UuidSchema,
    channel: Type.Optional(NotificationChannelNameSchema),
    parameters: Type.Optional(
      Type.Array(nonBlankString({ minLength: 1, maxLength: 1024 }), { maxItems: 20 }),
    ),
  },
  { additionalProperties: false },
);
export type SendNotification = Static<typeof SendNotificationSchema>;

export const NotificationMessageResponseSchema = Type.Object(
  { message: NotificationMessageSchema },
  { additionalProperties: false },
);
export type NotificationMessageResponse = Static<
  typeof NotificationMessageResponseSchema
>;
