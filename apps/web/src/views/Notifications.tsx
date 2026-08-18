import { useCallback, useEffect, useState } from 'react';
import type {
  NotificationChannel,
  NotificationChannelName,
  NotificationConsent,
  NotificationMessage,
  NotificationTemplate,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FieldRow, FormError, FormNotice, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * Notifications (migration 0092).
 *
 * THE MOCK DRAWS NO NOTIFICATIONS SCREEN — `app/settings/page.tsx` at
 * `punyanagari/Auto-MB-Vercel-du@fdfd610` has five tabs and none of them
 * is this — so the screen is application-first under `AGENTS.md` §
 * Design contract 4, built inside the mock's existing visual grammar with
 * no new visual language: its `PageHeader`, its `Card`/`CardHeader`, its
 * `DataTable`, its dot-plus-label status chip, its `Disclosure` for a
 * collapsed form. `docs/UX.md` § 17 records the stance and every chip
 * word this screen adds, rather than inventing a citation.
 *
 * ## Four sections, four independent loads
 *
 * The channels, the templates, the consent register and the delivery log
 * each read on their own and fail on their own, for the reason
 * `Settings.tsx` gives about its own sections: a delivery log that cannot
 * be reached must not blank the channel configuration an operator came
 * here to fix. Each section draws its own skeleton, its own empty state
 * and its own retry.
 *
 * ## What it says that a settings screen normally does not
 *
 * Whether the DEPLOYMENT can send at all. An organisation can complete
 * its WhatsApp configuration months before the server it runs on has an
 * access token, because Meta's onboarding and this deployment's
 * environment are different people's jobs. A screen that showed a green
 * "enabled" lamp over a server that cannot send would be lying, so the
 * channel row carries `transportConfigured` and says so.
 */

/** Rows per page. A delivery log is scrolled rather than paged; the
 * cursor is there for the year, not the day. */
const PAGE_SIZE = 50;

const CHANNEL_LABELS: Readonly<Record<NotificationChannelName, string>> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
};

interface NotificationsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner-only, because saving a channel decides which telephone number
   * the organisation speaks from. The server holds the same rule; this
   * only decides whether the form is worth drawing. */
  readonly isOwner: boolean;
}

export function Notifications({ api, organisationId, isOwner }: NotificationsProps) {
  const [channels, setChannels] = useState<readonly NotificationChannel[] | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<readonly NotificationTemplate[] | null>(
    null,
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [consents, setConsents] = useState<readonly NotificationConsent[] | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly NotificationMessage[] | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);

  const [loadVersion, reload] = useReload();
  const channelAction = useAction('The channel could not be saved.');
  const templateAction = useAction('The template could not be saved.');

  useEffect(() => {
    let cancelled = false;
    setChannels(null);
    setChannelError(null);
    api
      .listNotificationChannels(organisationId)
      .then((loaded) => {
        if (!cancelled) setChannels(loaded.channels);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setChannelError(
            describeLoadFailure(cause, 'The notification channels').message,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  useEffect(() => {
    let cancelled = false;
    setTemplates(null);
    setTemplateError(null);
    api
      .listNotificationTemplates(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (!cancelled) setTemplates(loaded.templates);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setTemplateError(describeLoadFailure(cause, 'The message templates').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  useEffect(() => {
    let cancelled = false;
    setConsents(null);
    setConsentError(null);
    api
      .listNotificationConsents(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (!cancelled) setConsents(loaded.consents);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setConsentError(describeLoadFailure(cause, 'The consent register').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setMessageError(null);
    api
      .listNotifications(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (!cancelled) setMessages(loaded.messages);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setMessageError(describeLoadFailure(cause, 'The delivery log').message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const saveChannel = useCallback(
    async (form: HTMLFormElement, channel: NotificationChannelName) => {
      const data = new FormData(form);
      const optional = (name: string): string | null => {
        const value = formValue(data, name).trim();
        return value === '' ? null : value;
      };
      await channelAction.act(async () => {
        await api.saveNotificationChannel(organisationId, channel, {
          enabled: data.get('enabled') === 'on',
          ...(channel === 'whatsapp'
            ? {
                wabaPhoneNumberId: optional('wabaPhoneNumberId'),
                wabaBusinessAccountId: optional('wabaBusinessAccountId'),
                displayPhoneNumber: optional('displayPhoneNumber'),
                apiBaseUrl: optional('apiBaseUrl'),
              }
            : {
                fromAddress: optional('fromAddress'),
                replyToAddress: optional('replyToAddress'),
              }),
        });
        reload();
      }, `${CHANNEL_LABELS[channel]} settings saved.`);
    },
    [api, organisationId, channelAction, reload],
  );

  const createTemplate = useCallback(
    async (form: HTMLFormElement) => {
      const data = new FormData(form);
      const subject = formValue(data, 'emailSubject').trim();
      await templateAction.act(async () => {
        await api.createNotificationTemplate(organisationId, {
          name: formValue(data, 'name').trim(),
          language: formValue(data, 'language').trim(),
          category: formValue(data, 'category') as NotificationTemplate['category'],
          bodyText: formValue(data, 'bodyText').trim(),
          ...(subject === '' ? {} : { emailSubject: subject }),
        });
        form.reset();
        reload();
      }, 'Template saved as a draft.');
    },
    [api, organisationId, templateAction, reload],
  );

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Notifications"
        titleId="notifications-title"
        description="How this organisation reaches its counterparties: the channels it speaks through, the templates it may send, who has agreed to be messaged, and what became of every message."
      />

      <div className="flex flex-col gap-4">
        <ChannelsSection
          channels={channels}
          error={channelError}
          isOwner={isOwner}
          pending={channelAction.pending}
          notice={channelAction.notice}
          actionError={channelAction.actionError}
          onRetry={reload}
          onSave={(form, channel) => {
            void saveChannel(form, channel);
          }}
        />

        <TemplatesSection
          templates={templates}
          error={templateError}
          pending={templateAction.pending}
          notice={templateAction.notice}
          actionError={templateAction.actionError}
          onRetry={reload}
          onCreate={(form) => {
            void createTemplate(form);
          }}
        />

        <ConsentSection consents={consents} error={consentError} onRetry={reload} />

        <DeliveryLogSection messages={messages} error={messageError} onRetry={reload} />
      </div>
    </>
  );
}

/* --- Channels --------------------------------------------------------------- */

function ChannelsSection({
  channels,
  error,
  isOwner,
  pending,
  notice,
  actionError,
  onRetry,
  onSave,
}: {
  readonly channels: readonly NotificationChannel[] | null;
  readonly error: string | null;
  readonly isOwner: boolean;
  readonly pending: boolean;
  readonly notice: string | null;
  readonly actionError: string | null;
  readonly onRetry: () => void;
  readonly onSave: (form: HTMLFormElement, channel: NotificationChannelName) => void;
}) {
  // Both channels are always drawn, configured or not: a channel with no
  // row is the commonest state and the one an operator has come here to
  // change, so it has to be visible rather than absent.
  const rowFor = (channel: NotificationChannelName): NotificationChannel | undefined =>
    channels?.find((row) => row.channel === channel);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Channels</h2>
          <p className="text-sm text-muted-foreground">
            WhatsApp is the primary channel and email the secondary one. A channel is
            only used once it is switched on, and only if this deployment has a
            transport for it.
          </p>
        </div>
      </CardHeader>
      {error !== null ? (
        <ErrorState onRetry={onRetry} retryLabel="Retry the notification channels">
          {error}
        </ErrorState>
      ) : channels === null ? (
        <LoadingState label="the notification channels" rows={2} columns={3} />
      ) : (
        <div className="flex flex-col gap-4">
          {(['whatsapp', 'email'] as const).map((channel) => {
            const row = rowFor(channel);
            return (
              <div key={channel} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{CHANNEL_LABELS[channel]}</span>
                  <StatusChip
                    status={row?.enabled === true ? 'enabled' : 'disabled'}
                    tone={row?.enabled === true ? 'success' : 'neutral'}
                  />
                  {row?.enabled === true && !row.transportConfigured && (
                    <StatusChip status="no transport" tone="warning" />
                  )}
                </div>
                {row !== undefined && (
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    {channel === 'whatsapp' ? (
                      <>
                        <dt className="text-muted-foreground">Display number</dt>
                        <dd className="m-0 font-mono text-[13px] tabular-nums">
                          {row.displayPhoneNumber ?? '—'}
                        </dd>
                        <dt className="text-muted-foreground">Phone number id</dt>
                        <dd className="m-0 font-mono text-[13px] tabular-nums">
                          {row.wabaPhoneNumberId ?? '—'}
                        </dd>
                        <dt className="text-muted-foreground">Business account</dt>
                        <dd className="m-0 font-mono text-[13px] tabular-nums">
                          {row.wabaBusinessAccountId ?? '—'}
                        </dd>
                        <dt className="text-muted-foreground">Route</dt>
                        <dd className="m-0">
                          {row.apiBaseUrl ?? 'Meta Cloud API direct'}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt className="text-muted-foreground">Sender</dt>
                        <dd className="m-0">{row.fromAddress ?? '—'}</dd>
                        <dt className="text-muted-foreground">Reply to</dt>
                        <dd className="m-0">{row.replyToAddress ?? '—'}</dd>
                      </>
                    )}
                  </dl>
                )}
                {row?.enabled === true && !row.transportConfigured && (
                  <Hint>
                    This organisation is set up, but the server has no{' '}
                    {channel === 'whatsapp' ? 'WhatsApp access token' : 'mail relay'}{' '}
                    configured, so nothing can be sent yet. Ask your administrator.
                  </Hint>
                )}
                {isOwner && (
                  <Disclosure label={`Change ${CHANNEL_LABELS[channel]} settings`}>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        onSave(event.currentTarget, channel);
                      }}
                    >
                      {channel === 'whatsapp' ? (
                        <>
                          <FieldRow>
                            <Field>
                              <label htmlFor={`${channel}-display`}>
                                Display number
                              </label>
                              <input
                                id={`${channel}-display`}
                                name="displayPhoneNumber"
                                type="text"
                                inputMode="tel"
                                defaultValue={row?.displayPhoneNumber ?? ''}
                                placeholder="+919876543210"
                              />
                            </Field>
                            <Field>
                              <label htmlFor={`${channel}-phone-id`}>
                                Phone number id
                              </label>
                              <input
                                id={`${channel}-phone-id`}
                                name="wabaPhoneNumberId"
                                type="text"
                                inputMode="numeric"
                                defaultValue={row?.wabaPhoneNumberId ?? ''}
                              />
                            </Field>
                          </FieldRow>
                          <FieldRow>
                            <Field>
                              <label htmlFor={`${channel}-waba`}>
                                Business account id
                              </label>
                              <input
                                id={`${channel}-waba`}
                                name="wabaBusinessAccountId"
                                type="text"
                                inputMode="numeric"
                                defaultValue={row?.wabaBusinessAccountId ?? ''}
                              />
                            </Field>
                            <Field>
                              <label htmlFor={`${channel}-base`}>
                                Provider base URL
                              </label>
                              <input
                                id={`${channel}-base`}
                                name="apiBaseUrl"
                                type="url"
                                defaultValue={row?.apiBaseUrl ?? ''}
                              />
                              <Hint>
                                Leave empty to talk to the Meta Cloud API directly.
                              </Hint>
                            </Field>
                          </FieldRow>
                        </>
                      ) : (
                        <FieldRow>
                          <Field>
                            <label htmlFor={`${channel}-from`}>Sender address</label>
                            <input
                              id={`${channel}-from`}
                              name="fromAddress"
                              type="email"
                              defaultValue={row?.fromAddress ?? ''}
                            />
                          </Field>
                          <Field>
                            <label htmlFor={`${channel}-reply`}>Reply-to address</label>
                            <input
                              id={`${channel}-reply`}
                              name="replyToAddress"
                              type="email"
                              defaultValue={row?.replyToAddress ?? ''}
                            />
                          </Field>
                        </FieldRow>
                      )}
                      <Field>
                        <label htmlFor={`${channel}-enabled`}>
                          Send through this channel
                        </label>
                        <input
                          id={`${channel}-enabled`}
                          name="enabled"
                          type="checkbox"
                          className="size-4 self-start"
                          defaultChecked={row?.enabled ?? false}
                        />
                      </Field>
                      <Actions>
                        <Button type="submit" disabled={pending}>
                          Save channel
                        </Button>
                      </Actions>
                    </form>
                  </Disclosure>
                )}
              </div>
            );
          })}
        </div>
      )}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}
    </Card>
  );
}

/* --- Templates -------------------------------------------------------------- */

function TemplatesSection({
  templates,
  error,
  pending,
  notice,
  actionError,
  onRetry,
  onCreate,
}: {
  readonly templates: readonly NotificationTemplate[] | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly notice: string | null;
  readonly actionError: string | null;
  readonly onRetry: () => void;
  readonly onCreate: (form: HTMLFormElement) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Message templates</h2>
          <p className="text-sm text-muted-foreground">
            WhatsApp only carries a template Meta has approved. The status here is
            recorded from the Meta console; a template with a subject line can also go
            by email.
          </p>
        </div>
      </CardHeader>
      {error !== null ? (
        <ErrorState onRetry={onRetry} retryLabel="Retry the message templates">
          {error}
        </ErrorState>
      ) : templates === null ? (
        <LoadingState label="the message templates" rows={4} columns={4} />
      ) : templates.length === 0 ? (
        <EmptyState>
          No message template has been written yet. Add one, then submit it in the Meta
          console and record what it answers.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">Message templates</caption>
          <thead>
            <tr>
              <th scope="col">Template</th>
              <th scope="col">Body</th>
              <th scope="col">Parameters</th>
              <th scope="col">Email subject</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((template) => (
              <tr key={template.id}>
                <td>
                  <span className="font-medium">{template.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {template.language} · {template.category}
                  </span>
                </td>
                <td className={wrapCell}>{template.bodyText}</td>
                <td className="text-right! font-mono text-[13px] tabular-nums">
                  {template.parameterCount}
                </td>
                <td className={wrapCell}>{template.emailSubject ?? '—'}</td>
                <td>
                  <StatusChip status={template.status} />
                  {template.statusReason !== null && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {template.statusReason}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <Disclosure label="Write a template">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(event.currentTarget);
          }}
        >
          <FieldRow>
            <Field>
              <label htmlFor="template-name">Name</label>
              <input
                id="template-name"
                name="name"
                type="text"
                required
                pattern="[a-z0-9_]{1,512}"
                placeholder="delivery_challan_issued"
              />
              <Hint>
                Meta&rsquo;s rules: lowercase letters, digits and underscores.
              </Hint>
            </Field>
            <Field>
              <label htmlFor="template-language">Language</label>
              <input
                id="template-language"
                name="language"
                type="text"
                required
                defaultValue="en"
                pattern="[a-z]{2}(_[A-Z]{2})?"
              />
            </Field>
            <Field>
              <label htmlFor="template-category">Category</label>
              <select id="template-category" name="category" defaultValue="utility">
                <option value="utility">Utility</option>
                <option value="marketing">Marketing</option>
                <option value="authentication">Authentication</option>
              </select>
            </Field>
          </FieldRow>
          <Field>
            <label htmlFor="template-body">Body</label>
            <textarea id="template-body" name="bodyText" required rows={3} />
            <Hint>
              Use {'{{1}}'}, {'{{2}}'} for the values filled in at send time.
            </Hint>
          </Field>
          <Field>
            <label htmlFor="template-subject">Email subject</label>
            <input id="template-subject" name="emailSubject" type="text" />
            <Hint>Leave empty for a WhatsApp-only template.</Hint>
          </Field>
          <Actions>
            <Button type="submit" disabled={pending}>
              Add template
            </Button>
          </Actions>
        </form>
      </Disclosure>
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}
    </Card>
  );
}

/* --- Consent ---------------------------------------------------------------- */

function ConsentSection({
  consents,
  error,
  onRetry,
}: {
  readonly consents: readonly NotificationConsent[] | null;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Consent register</h2>
          <p className="text-sm text-muted-foreground">
            Who has agreed to be messaged, on which channel, at which address. Consent
            is recorded against the address it was given for, so a contact whose number
            changes is asked again.
          </p>
        </div>
      </CardHeader>
      {error !== null ? (
        <ErrorState onRetry={onRetry} retryLabel="Retry the consent register">
          {error}
        </ErrorState>
      ) : consents === null ? (
        <LoadingState label="the consent register" rows={4} columns={4} />
      ) : consents.length === 0 ? (
        <EmptyState>
          Nobody has been recorded as consenting yet. Record an opt-in against a contact
          before sending anything to them.
        </EmptyState>
      ) : (
        <DataTable>
          <caption className="sr-only">Consent register</caption>
          <thead>
            <tr>
              <th scope="col">Contact</th>
              <th scope="col">Channel</th>
              <th scope="col">Address</th>
              <th scope="col">How it was obtained</th>
              <th scope="col">Recorded</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {consents.map((consent) => (
              <tr key={consent.id}>
                <td>{consent.contactDesignation}</td>
                <td>{CHANNEL_LABELS[consent.channel]}</td>
                <td className="font-mono text-[13px] tabular-nums">
                  {consent.address}
                </td>
                <td className={wrapCell}>{consent.evidence}</td>
                <td>
                  <span className="tabular-nums">
                    {formatTimestamp(consent.recordedAt)}
                  </span>
                </td>
                <td>
                  <StatusChip
                    status={consent.state === 'opted_in' ? 'opted in' : 'opted out'}
                    tone={consent.state === 'opted_in' ? 'success' : 'neutral'}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

/* --- The delivery log ------------------------------------------------------- */

function DeliveryLogSection({
  messages,
  error,
  onRetry,
}: {
  readonly messages: readonly NotificationMessage[] | null;
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="text-base leading-snug font-medium">Delivery log</h2>
          <p className="text-sm text-muted-foreground">
            Every message this organisation sent and what became of it. A status only
            ever moves forwards, and a failure carries the provider&rsquo;s own reason.
          </p>
        </div>
      </CardHeader>
      {error !== null ? (
        <ErrorState onRetry={onRetry} retryLabel="Retry the delivery log">
          {error}
        </ErrorState>
      ) : messages === null ? (
        <LoadingState label="the delivery log" rows={5} columns={5} />
      ) : messages.length === 0 ? (
        <EmptyState>
          Nothing has been sent yet. Once a channel is switched on and a contact has
          consented, every message appears here.
        </EmptyState>
      ) : (
        <DataTable scroll>
          <caption className="sr-only">Delivery log</caption>
          <thead>
            <tr>
              <th scope="col">Sent to</th>
              <th scope="col">Template</th>
              <th scope="col">Channel</th>
              <th scope="col">Queued</th>
              <th scope="col">Last movement</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.id}>
                <td>
                  <span className="font-medium">{message.contactDesignation}</span>
                  <span className="block font-mono text-xs tabular-nums text-muted-foreground">
                    {message.toAddress}
                  </span>
                </td>
                <td>
                  <span>{message.templateName}</span>
                  <span className="block text-xs text-muted-foreground">
                    {message.templateLanguage}
                  </span>
                </td>
                <td>{CHANNEL_LABELS[message.channel]}</td>
                <td>
                  <span className="tabular-nums">
                    {formatTimestamp(message.queuedAt)}
                  </span>
                </td>
                <td>
                  <span className="tabular-nums">{lastMovementOf(message)}</span>
                </td>
                <td>
                  <StatusChip status={message.status} />
                  {message.failureCode !== null && (
                    <span className="mt-1 block font-mono text-xs">
                      {message.failureCode}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}

/** The most recent thing that happened to a message. The row already
 * shows when it was queued; repeating four timestamp columns for the four
 * states would make every row mostly empty, and the one an operator wants
 * is always the last. */
function lastMovementOf(message: NotificationMessage): string {
  const moment =
    message.failedAt ?? message.readAt ?? message.deliveredAt ?? message.sentAt;
  return moment === null ? '—' : formatTimestamp(moment);
}
