/**
 * Sending one templated notification (migration 0092).
 *
 * ## This module is the seam, not the route
 *
 * `sendTemplatedNotification` is what the notifications route calls
 * today, and it is deliberately the whole public surface of the feature:
 * a caller names a template and a contact, and gets back the id of a row
 * in the delivery log. It does not name a channel, an address or a
 * transport. Document delivery over WhatsApp and MSME payment alerting
 * are both built on this call, and neither of them should know or care
 * which road a message took — that is decided here, from the
 * organisation's channel configuration and the contact's own consent.
 *
 * The one field a caller conspicuously CANNOT pass is the recipient's
 * address. It comes from the consent record, because the consent record
 * is the only thing in the system that can say which address this contact
 * agreed to be reached at. A parameter would be a way to send somewhere
 * nobody agreed to, so the rule is expressed as a missing field.
 *
 * ## Four transactions, and why each one exists
 *
 *   1. AUTHORISE AND QUEUE. The caller's own guard runs as the first
 *      statement, then the row is written `queued` and COMMITTED before
 *      the provider is called — `gsp/provider-operations.ts`'s shape, for
 *      its reason: a process that dies between "we called Meta" and "Meta
 *      answered" must leave evidence that it called. A single transaction
 *      spanning a network call would either hold a row lock across the
 *      internet or lose the attempt entirely.
 *   2. RE-READ THE CONSENT. Committing before the provider call opens a
 *      window in which the agreement can be withdrawn, and "we sent it
 *      after they opted out" is exactly the fact this pack exists to make
 *      impossible. One row, read immediately before the send.
 *   3. THE PROVIDER CALL. Not a transaction at all, and outside every
 *      lock.
 *   4. COMPLETE. Every outcome lands here — success, a provider refusal,
 *      and any other throw at all.
 *
 * ## What happens when step 4 itself fails
 *
 * The message is on the wire and the ledger cannot say so. The write is
 * retried once; if it fails again the row stays `queued` and the caller
 * gets a named 502 carrying BOTH ids, so an operator can reconcile the
 * delivery log against the provider console by hand. That is the honest
 * end of this design rather than a gap in it: there is no third place to
 * put the fact, and silently answering 201 would report a delivery the
 * register does not hold.
 *
 * ## No retry queue
 *
 * A refusal is recorded with whether the provider called it retryable,
 * and nothing retries it. Automatic retry needs the worker queue (0072),
 * which is another pack's surface this wave; until then the operator
 * reads the code off the delivery log and sends again.
 */
import { randomUUID } from 'node:crypto';
import type { ErrorCode, NotificationChannelName } from '@auto-mb/contracts';
import type { Sql, TransactionSql } from '@auto-mb/db';
import { httpError } from '../http.js';
import { audit } from '../routes/shared.js';
import { withBoundTenant } from '../tenant-context.js';
import {
  NotificationTransportError,
  type EmailTarget,
  type NotificationTransports,
  type TemplatedMessage,
  type WhatsAppTarget,
} from './transport.js';

/**
 * Migration 0092's own refusals, mapped to named codes.
 *
 * Every rule below is checked by this module first, under no lock, so an
 * operator gets a 409 with a remedy. These are what an operator sees when
 * that check lost a race — a channel disabled, or a consent withdrawn,
 * between the read and the insert.
 */
export const NOTIFICATION_DATABASE_REFUSALS: Record<
  string,
  readonly [ErrorCode, string]
> = {
  '23K01': [
    'NOTIFICATION_CHANNEL_STATE',
    'Which organisation and which channel a configuration is for cannot be changed.',
  ],
  '23K02': [
    'NOTIFICATION_CHANNEL_INCOMPLETE',
    'This channel cannot be enabled until its own configuration is complete.',
  ],
  '23K03': [
    'NOTIFICATION_TEMPLATE_STATE',
    'The template moved on, or its reviewed body cannot be changed; reload the template list.',
  ],
  '23K04': [
    'NOTIFICATION_CONSENT_STATE',
    'A consent record names one contact on one channel and that cannot be re-pointed.',
  ],
  '23K05': [
    'NOTIFICATION_CHANNEL_NOT_CONFIGURED',
    'That channel is not configured and enabled for this organisation.',
  ],
  '23K06': [
    'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
    'That template cannot be sent on this channel with the parameters given.',
  ],
  '23K07': [
    'NOTIFICATION_CONSENT_MISSING',
    'There is no recorded opt-in for this contact at the address the message is addressed to.',
  ],
  '23K08': [
    'NOTIFICATION_MESSAGE_STATE',
    'What a notification recorded when it was sent cannot be changed afterwards.',
  ],
  '23K09': [
    'NOTIFICATION_MESSAGE_STATE',
    'A delivery status only ever moves forwards; reload the delivery log.',
  ],
};

/**
 * Unique violations this module can produce, named by constraint.
 *
 * `23505` is PostgreSQL's own code and carries no meaning of ours, so the
 * constraint name is what says which rule was broken. Without this map
 * every one of them surfaced as an unmapped 500 — and for
 * `waba_phone_number_id` that was worse than untidy: the index is
 * cluster-wide by necessity (Meta's webhook resolves a tenant by that
 * value before any tenant is bound), so one organisation typing another's
 * phone number id got a 500 while the true owner got a permanent,
 * remedy-less refusal, and the 500-versus-200 split was itself an
 * existence oracle for numbers registered elsewhere on the platform.
 *
 * THE WORDING IS DELIBERATELY NON-ORACULAR. It never says which
 * organisation holds the number, or that one does — only that this
 * deployment cannot accept it here.
 */
const UNIQUE_VIOLATIONS: Record<string, readonly [ErrorCode, string]> = {
  notification_channels_waba_phone_number_id_key: [
    'NOTIFICATION_CHANNEL_NUMBER_TAKEN',
    'This WhatsApp phone number id cannot be registered here. Check it against the Meta console; if it is yours and this refusal persists, ask your administrator to raise it with support.',
  ],
  notification_channels_organisation_id_channel_key: [
    'NOTIFICATION_CHANNEL_STATE',
    'This organisation already has a configuration for that channel; reload the screen and edit it.',
  ],
  notification_templates_organisation_id_name_language_key: [
    'NOTIFICATION_TEMPLATE_EXISTS',
    'A template with this name and language already exists; Meta identifies a template by both.',
  ],
  notification_consents_organisation_id_contact_id_channel_key: [
    'NOTIFICATION_CONSENT_STATE',
    'This contact already has a consent record for that channel; reload the register and edit it.',
  ],
};

function constraintOf(error: unknown): string | undefined {
  const name: unknown =
    typeof error === 'object' && error !== null && 'constraint_name' in error
      ? error.constraint_name
      : undefined;
  return typeof name === 'string' ? name : undefined;
}

/** Turns a 0092 write refusal into the same named 409 the route makes,
 * and lets anything else through as the 500 it is. */
export function rethrowNotificationWriteRefusal(error: unknown): never {
  const code: unknown =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (typeof code === 'string') {
    const refusal = NOTIFICATION_DATABASE_REFUSALS[code];
    if (refusal) throw httpError(409, refusal[0], refusal[1]);
    if (code === '23505') {
      const unique = UNIQUE_VIOLATIONS[constraintOf(error) ?? ''];
      if (unique) throw httpError(409, unique[0], unique[1]);
    }
    // A plain CHECK. Every one of them states a shape the route also
    // states, so reaching here means a value got past the schema — a
    // refusal the operator can act on, not a server fault.
    if (code === '23514') {
      throw httpError(
        409,
        'NOTIFICATION_FIELD_INVALID',
        'One of the values given is not a shape this register accepts; check the phone number, address and template name against the form’s own rules.',
      );
    }
  }
  throw error;
}

export interface SendTemplatedNotificationInput {
  readonly organisationId: string;
  readonly userId: string;
  readonly templateId: string;
  readonly contactId: string;
  /** Omit to let the organisation's configuration and the contact's
   * consent decide. This is the intended shape for callers built on top
   * of this pack. */
  readonly channel?: NotificationChannelName;
  readonly parameters: readonly string[];
  /**
   * The caller's WHOLE guard — role and authority both — run as the first
   * statement of the first bound transaction, before any read and long
   * before the provider is called.
   *
   * It is a parameter rather than a fixed check because what a send needs
   * belongs to the ACT, not to the transport. Sending from the
   * notifications screen needs the writer role and the notifications
   * authority; delivering an issued challan over WhatsApp will need the
   * issue authority, and making that caller hold the notifications one
   * too would let every clerk who may issue a document also repoint the
   * organisation's outbound number.
   *
   * IT MUST CHECK EVERYTHING, INCLUDING THE ROLE. This function opens its
   * own transactions rather than running inside the route's, so
   * `createTenantRouteRegistrar`'s `role` and `authority` declarations do
   * not cover it — a route that declared `role: 'writer'` and left it out
   * of here would put a real message on the wire for a viewer and only
   * then refuse.
   */
  readonly authorise: (tx: TransactionSql) => Promise<void>;
}

interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly body_text: string;
  readonly parameter_count: number;
  readonly email_subject: string | null;
}

interface ChannelRow {
  readonly channel: NotificationChannelName;
  readonly enabled: boolean;
  readonly waba_phone_number_id: string | null;
  readonly api_base_url: string | null;
  readonly from_address: string | null;
  readonly reply_to_address: string | null;
}

interface ConsentRow {
  readonly channel: NotificationChannelName;
  readonly address: string;
  readonly state: string;
}

/** Why one candidate channel could not carry this message. Kept as a
 * pair rather than thrown immediately, because the automatic path tries
 * WhatsApp first and must be able to fall through to email without
 * losing the reason WhatsApp was unusable. */
type Refusal = readonly [ErrorCode, string];

function channelRefusal(
  channel: NotificationChannelName,
  template: TemplateRow,
  channels: readonly ChannelRow[],
  consents: readonly ConsentRow[],
  transports: NotificationTransports,
  parameters: readonly string[],
): Refusal | null {
  const configured = channels.find((row) => row.channel === channel);
  if (configured === undefined || !configured.enabled) {
    return [
      'NOTIFICATION_CHANNEL_NOT_CONFIGURED',
      `The ${channel} channel is not configured and enabled for this organisation.`,
    ];
  }
  if (channel === 'whatsapp' && transports.whatsapp === undefined) {
    return [
      'NOTIFICATION_TRANSPORT_NOT_CONFIGURED',
      'This deployment has no WhatsApp transport configured, so nothing can be sent even though the organisation is set up for it.',
    ];
  }
  if (channel === 'email' && transports.email === undefined) {
    return [
      'NOTIFICATION_TRANSPORT_NOT_CONFIGURED',
      'This deployment has no mail relay configured, so nothing can be sent even though the organisation is set up for it.',
    ];
  }
  if (channel === 'whatsapp' && template.status !== 'approved') {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} is ${template.status} at Meta, and only an approved template may be sent over WhatsApp.`,
    ];
  }
  if (channel === 'email' && template.email_subject === null) {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} has no subject line, so it cannot be sent by email.`,
    ];
  }
  if (parameters.length !== template.parameter_count) {
    return [
      'NOTIFICATION_TEMPLATE_NOT_SENDABLE',
      `Template ${template.name}/${template.language} takes ${String(template.parameter_count)} parameters and was given ${String(parameters.length)}.`,
    ];
  }
  const consent = consents.find((row) => row.channel === channel);
  if (consent === undefined || consent.state !== 'opted_in') {
    return [
      'NOTIFICATION_CONSENT_MISSING',
      `This contact has no recorded opt-in for ${channel}.`,
    ];
  }
  return null;
}

/** WhatsApp first, email second: the ordering is a fact about the
 * customer's counterparties, not a preference. */
const CHANNEL_PREFERENCE: readonly NotificationChannelName[] = ['whatsapp', 'email'];

/** What the provider did, in the one shape the completion transaction
 * writes. `null` code means it succeeded. */
interface Outcome {
  readonly providerMessageId: string | null;
  readonly failureCode: string | null;
  readonly failureDetail: string | null;
  /** Only meaningful on a failure, and only used to word the refusal. */
  readonly retryable: boolean;
}

export async function sendTemplatedNotification(
  database: Sql,
  transports: NotificationTransports,
  input: SendTemplatedNotificationInput,
): Promise<string> {
  const prepared = await withBoundTenant(
    database,
    input.organisationId,
    input.userId,
    async (tx) => {
      // First statement of the first transaction: the membership floor
      // has just been proved by the bind, and this is the act's own role
      // and authority on top of it. Nothing is read and nothing is sent
      // before it passes.
      await input.authorise(tx);

      const [template] = await tx<TemplateRow[]>`
        select id, name, language, status, body_text, parameter_count, email_subject
        from notification_templates where id = ${input.templateId}
      `;
      if (!template) {
        throw httpError(
          404,
          'NOTIFICATION_TEMPLATE_NOT_FOUND',
          'No such notification template.',
        );
      }

      const [contact] = await tx<{ id: string }[]>`
        select id from contacts where id = ${input.contactId} and active
      `;
      if (!contact) {
        throw httpError(
          404,
          'NOTIFICATION_CONTACT_NOT_FOUND',
          'No such contact, or it has been retired.',
        );
      }

      const channels = await tx<ChannelRow[]>`
        select channel, enabled, waba_phone_number_id, api_base_url,
               from_address, reply_to_address
        from notification_channels
      `;
      const consents = await tx<ConsentRow[]>`
        select channel, address, state
        from notification_consents where contact_id = ${input.contactId}
      `;

      const candidates =
        input.channel === undefined ? CHANNEL_PREFERENCE : [input.channel];
      let firstRefusal: Refusal | null = null;
      let chosen: NotificationChannelName | null = null;
      for (const candidate of candidates) {
        const refusal = channelRefusal(
          candidate,
          template,
          channels,
          consents,
          transports,
          input.parameters,
        );
        if (refusal === null) {
          chosen = candidate;
          break;
        }
        firstRefusal ??= refusal;
      }
      if (chosen === null) {
        // `firstRefusal` is set whenever `chosen` is null, because the
        // candidate list is never empty. The fallback exists so the type
        // is honest rather than asserted.
        const [code, message] = firstRefusal ?? [
          'NOTIFICATION_CHANNEL_NOT_CONFIGURED' as const,
          'No notification channel is configured for this organisation.',
        ];
        throw httpError(409, code, message);
      }

      const channelRow = channels.find((row) => row.channel === chosen);
      const consent = consents.find((row) => row.channel === chosen);
      if (channelRow === undefined || consent === undefined) {
        throw new Error('the chosen notification channel disappeared while locked');
      }

      const provider =
        chosen === 'email' ? 'smtp' : (transports.whatsapp?.provider ?? 'meta_cloud');

      const [row] = await tx<{ id: string }[]>`
        insert into notification_messages (
          organisation_id, channel, template_id, contact_id, to_address,
          parameters, provider, requested_by_user_id
        )
        values (
          ${input.organisationId}, ${chosen}, ${template.id}, ${input.contactId},
          ${consent.address}, ${tx.json([...input.parameters] as never)},
          ${provider}, ${input.userId}
        )
        returning id
      `.catch(rethrowNotificationWriteRefusal);
      if (!row) throw new Error('the notification row was not written');

      const message: TemplatedMessage = {
        toAddress: consent.address,
        templateName: template.name,
        language: template.language,
        parameters: input.parameters,
        bodyText: template.body_text,
        subject: template.email_subject,
      };
      return {
        messageId: row.id,
        channel: chosen,
        templateId: template.id,
        channelRow,
        message,
      };
    },
  );

  // The window the commit above opens, closed. Between that commit and
  // the provider call an owner can withdraw the consent, and "we sent it
  // after they opted out" is precisely the fact this pack exists to make
  // impossible. One row, one statement.
  const stillConsented = await withBoundTenant(
    database,
    input.organisationId,
    input.userId,
    async (tx) => {
      const [consent] = await tx<{ state: string; address: string }[]>`
        select state, address from notification_consents
        where contact_id = ${input.contactId} and channel = ${prepared.channel}
      `;
      return consentStillStands(consent ?? null, prepared.message.toAddress);
    },
  );
  if (!stillConsented) {
    await completeNotification(database, input, prepared.messageId, {
      providerMessageId: null,
      failureCode: 'consent_withdrawn',
      failureDetail:
        'The consent for this address was withdrawn or changed before the message left.',
      retryable: false,
    });
    throw httpError(
      409,
      'NOTIFICATION_CONSENT_MISSING',
      'The recorded opt-in for this address changed while the message was being prepared, so nothing was sent.',
    );
  }

  // EVERY outcome of the provider call lands in the completion
  // transaction — including a throw that is not a transport error at all.
  // An earlier draft rethrew those before completing, which left the row
  // `queued` forever: no receipt can rescue it, because the outcome shape
  // requires a queued row to carry a NULL provider message id and a
  // receipt is looked up by that id.
  let outcome: Outcome;
  try {
    outcome = {
      providerMessageId: await callProvider(transports, prepared),
      failureCode: null,
      failureDetail: null,
      retryable: false,
    };
  } catch (cause) {
    outcome =
      cause instanceof NotificationTransportError
        ? {
            providerMessageId: null,
            failureCode: cause.providerCode,
            failureDetail: cause.retryable
              ? `${cause.detail ?? 'The provider refused the message.'} (retryable)`
              : cause.detail,
            retryable: cause.retryable,
          }
        : {
            providerMessageId: null,
            // A bug in this server, a DNS failure, a bad certificate: not
            // the provider's refusal and not classifiable as one, but it
            // still ends this attempt and the ledger has to say so.
            failureCode: 'transport_error',
            failureDetail: 'The message could not be handed to the provider.',
            retryable: true,
          };
  }

  await completeNotification(database, input, prepared.messageId, outcome);

  if (outcome.failureCode !== null) {
    throw httpError(
      502,
      'NOTIFICATION_SEND_FAILED',
      `The ${prepared.channel} provider refused the message (${outcome.failureCode}). Nothing was delivered and the attempt is on the delivery log.${
        outcome.retryable
          ? ' The provider called this temporary, so sending again may work.'
          : ''
      }`,
    );
  }
  return prepared.messageId;
}

async function callProvider(
  transports: NotificationTransports,
  prepared: {
    readonly channel: NotificationChannelName;
    readonly channelRow: ChannelRow;
    readonly message: TemplatedMessage;
  },
): Promise<string> {
  if (prepared.channel === 'whatsapp') {
    const transport = transports.whatsapp;
    if (transport === undefined) throw new Error('the WhatsApp transport disappeared');
    const target: WhatsAppTarget = {
      // Both are non-null: the channel could not have been enabled
      // without them (0092's guard), and the row was read inside the
      // same transaction that proved it enabled.
      phoneNumberId: prepared.channelRow.waba_phone_number_id ?? '',
      apiBaseUrl: prepared.channelRow.api_base_url,
    };
    return transport.send(target, prepared.message);
  }
  const transport = transports.email;
  if (transport === undefined) throw new Error('the email transport disappeared');
  const target: EmailTarget = {
    fromAddress: prepared.channelRow.from_address ?? '',
    replyToAddress: prepared.channelRow.reply_to_address,
  };
  return transport.send(target, prepared.message);
}

/**
 * The completion transaction, and the audit row, together.
 *
 * Together on purpose: an earlier draft wrote the audit event in a LATER
 * transaction opened by the route, so a refusal there — a role wall, a
 * lost connection — rolled the audit back and left a message on the wire
 * that nothing in the trail recorded. What was sent and the record that
 * it was sent now commit or fail as one.
 *
 * Retried ONCE on failure, because the common cause is a dropped
 * connection and the second attempt costs one round trip. If it fails
 * again the caller is told, with both ids, rather than being answered 201
 * over a ledger that does not hold the delivery.
 */
async function completeNotification(
  database: Sql,
  input: SendTemplatedNotificationInput,
  messageId: string,
  outcome: Outcome,
): Promise<void> {
  const write = async (): Promise<void> => {
    await withBoundTenant(database, input.organisationId, input.userId, async (tx) => {
      if (outcome.failureCode === null) {
        await tx`
          update notification_messages
          set status = 'sent', sent_at = now(),
              provider_message_id = ${outcome.providerMessageId}
          where id = ${messageId}
        `.catch(rethrowNotificationWriteRefusal);
      } else {
        await tx`
          update notification_messages
          set status = 'failed', failed_at = now(),
              failure_code = ${outcome.failureCode},
              failure_detail = ${outcome.failureDetail}
          where id = ${messageId}
        `.catch(rethrowNotificationWriteRefusal);
      }
      // Ids and an outcome word. Never the address, the parameters or the
      // provider's own body (AGENTS.md rule 11).
      await audit(
        tx,
        input.organisationId,
        input.userId,
        outcome.failureCode === null ? 'notification.sent' : 'notification.failed',
        'notification_messages',
        messageId,
        {
          templateId: input.templateId,
          ...(outcome.failureCode === null ? {} : { failureCode: outcome.failureCode }),
        },
      );
    });
  };

  try {
    await write();
  } catch (first) {
    // An httpError means the WRITE was refused on its merits — a guard
    // fired — and retrying it would fail identically. Only an
    // infrastructure failure is worth a second attempt.
    if (typeof first === 'object' && first !== null && 'statusCode' in first)
      throw first;
    try {
      await write();
    } catch {
      throw httpError(
        502,
        'NOTIFICATION_OUTCOME_UNRECORDED',
        `The message was handed to the provider but the delivery log could not be updated. Reconcile notification ${messageId}${
          outcome.providerMessageId === null
            ? ''
            : ` (provider message ${outcome.providerMessageId})`
        } against the provider console by hand.`,
      );
    }
  }
}

/**
 * Whether the agreement read back is still the one this message was
 * prepared against.
 *
 * Extracted so it can be tested, and it has to be: the window it guards —
 * between the queued row committing and the provider being called — is
 * one no test can hook, because the transport double is already past it.
 * A "race" test would be a test of the INSERT guard wearing this
 * predicate's name, which is worse than no test at all. So the predicate
 * is proved directly against every answer the register can give it, and
 * that it is consulted before the provider is a fact about eleven lines
 * above this one.
 *
 * The address comparison is the half that is easy to drop and expensive
 * to lose: a contact who re-consented on a NEW number between the two
 * reads has not consented to the old one, which is the whole per-address
 * rule.
 */
export function consentStillStands(
  consent: { readonly state: string; readonly address: string } | null,
  expectedAddress: string,
): boolean {
  return (
    consent !== null &&
    consent.state === 'opted_in' &&
    consent.address === expectedAddress
  );
}

/** A message id for a relay that returned none. Random rather than
 * clock-derived: the column is unique across the CLUSTER, so two tenants
 * whose relays both stayed silent in the same millisecond would collide —
 * and the collision would land AFTER the mail had already gone out. */
export function fallbackMessageId(): string {
  return `smtp:${randomUUID()}`;
}
