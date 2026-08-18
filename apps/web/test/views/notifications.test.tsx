// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Contact,
  NotificationChannel,
  NotificationConsent,
  NotificationMessage,
  NotificationTemplate,
} from '@auto-mb/contracts';
import { Notifications } from '../../src/views/Notifications.js';
import { ORG_ID, stubApi } from './helpers.js';

/**
 * What only THIS screen says.
 *
 * The generic loading, empty and failure trio is proved centrally by
 * `state-coverage.test.tsx`, one case per independent load, so none of it
 * is repeated here. What is left is the three things the notifications
 * screen decides that no other screen does: that a configured channel on
 * a deployment with no transport draws two lamps rather than one, that a
 * template's Meta status and an email-only template read differently, and
 * that the channel form is the owner's alone.
 */

const CHANNEL_DEFAULTS = {
  wabaPhoneNumberId: null,
  wabaBusinessAccountId: null,
  displayPhoneNumber: null,
  apiBaseUrl: null,
  fromAddress: null,
  replyToAddress: null,
  updatedAt: '2026-08-18T09:00:00.000Z',
} as const;

function whatsappChannel(
  overrides: Partial<NotificationChannel> = {},
): NotificationChannel {
  return {
    ...CHANNEL_DEFAULTS,
    id: '11111111-1111-4111-8111-111111111111',
    channel: 'whatsapp',
    enabled: true,
    wabaPhoneNumberId: '109876543210987',
    wabaBusinessAccountId: '209876543210987',
    displayPhoneNumber: '+919000000001',
    transportConfigured: true,
    ...overrides,
  };
}

function emailChannel(
  overrides: Partial<NotificationChannel> = {},
): NotificationChannel {
  return {
    ...CHANNEL_DEFAULTS,
    id: '22222222-2222-4222-8222-222222222222',
    channel: 'email',
    enabled: false,
    fromAddress: 'no-reply@contractor.example',
    transportConfigured: true,
    ...overrides,
  };
}

function template(overrides: Partial<NotificationTemplate> = {}): NotificationTemplate {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'challan_issued',
    language: 'en',
    category: 'utility',
    status: 'approved',
    statusReason: null,
    bodyText: 'Challan {{1}} for work {{2}} has been issued.',
    parameterCount: 2,
    emailSubject: 'Challan issued',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function consent(overrides: Partial<NotificationConsent> = {}): NotificationConsent {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    contactId: '55555555-5555-4555-8555-555555555555',
    contactDesignation: 'Sr. DEE (G) CR Nagpur',
    channel: 'whatsapp',
    address: '+919812345678',
    state: 'opted_in',
    evidence: 'Signed the delivery acknowledgement on 12 Aug 2026',
    recordedByUserId: 'user-1',
    recordedAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    channel: 'whatsapp',
    templateId: '33333333-3333-4333-8333-333333333333',
    templateName: 'challan_issued',
    templateLanguage: 'en',
    contactId: '55555555-5555-4555-8555-555555555555',
    contactDesignation: 'Sr. DEE (G) CR Nagpur',
    toAddress: '+919812345678',
    parameters: ['DC/2026/0042', 'WR-BCT-2026'],
    status: 'delivered',
    provider: 'meta_cloud',
    providerMessageId: 'wamid.ABC',
    failureCode: null,
    failureDetail: null,
    requestedByUserId: 'user-1',
    queuedAt: '2026-08-18T09:00:00.000Z',
    sentAt: '2026-08-18T09:00:01.000Z',
    deliveredAt: '2026-08-18T09:00:05.000Z',
    readAt: null,
    failedAt: null,
    ...overrides,
  };
}

/** The two fields the screen's pickers read. Narrowed rather than filled
 * in full: a fixture that restates every column of the contact master is
 * a fixture that breaks when the master gains one. */
const CONTACT = {
  id: '55555555-5555-4555-8555-555555555555',
  designation: 'Sr. DEE (G) CR Nagpur',
} as Contact;

function renderNotifications(
  options: {
    readonly channels?: readonly NotificationChannel[];
    readonly templates?: readonly NotificationTemplate[];
    readonly consents?: readonly NotificationConsent[];
    readonly messages?: readonly NotificationMessage[];
    readonly contacts?: readonly Contact[];
    readonly isOwner?: boolean;
  } = {},
) {
  const api = stubApi({
    listNotificationChannels: vi.fn().mockResolvedValue({
      channels: options.channels ?? [whatsappChannel(), emailChannel()],
    }),
    listNotificationTemplates: vi.fn().mockResolvedValue({
      templates: options.templates ?? [template()],
      nextCursor: null,
    }),
    listNotificationConsents: vi.fn().mockResolvedValue({
      consents: options.consents ?? [consent()],
      nextCursor: null,
    }),
    listNotifications: vi.fn().mockResolvedValue({
      messages: options.messages ?? [message()],
      nextCursor: null,
    }),
    saveNotificationChannel: vi
      .fn()
      .mockResolvedValue({ channel: whatsappChannel({ enabled: false }) }),
    createNotificationTemplate: vi.fn().mockResolvedValue({ template: template() }),
    setNotificationTemplateStatus: vi.fn().mockResolvedValue({ template: template() }),
    recordNotificationConsent: vi.fn().mockResolvedValue({ consent: consent() }),
    sendNotification: vi.fn().mockResolvedValue({ message: message() }),
    listContacts: vi.fn().mockResolvedValue(options.contacts ?? [CONTACT]),
  });
  render(
    <Notifications
      api={api}
      organisationId={ORG_ID}
      isOwner={options.isOwner ?? true}
    />,
  );
  return api;
}

describe('the notifications screen', () => {
  it('draws two lamps when the organisation is set up and the deployment is not', async () => {
    // The one thing on this screen with no precedent in the mock, and the
    // reason it is there: Meta's onboarding is the agency's job and the
    // access token is the administrator's, and they come true months
    // apart. A single lamp would have to lie about one of them.
    renderNotifications({
      channels: [whatsappChannel({ transportConfigured: false }), emailChannel()],
    });
    expect(await screen.findByText('+919000000001')).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
    expect(screen.getByText('no transport')).toBeTruthy();
    expect(
      screen.getByText(/the server has no WhatsApp access token configured/),
    ).toBeTruthy();
  });

  it('says "Meta Cloud API direct" when no BSP base URL is configured', async () => {
    renderNotifications();
    expect(await screen.findByText('Meta Cloud API direct')).toBeTruthy();
  });

  it('shows a rejected template with the reason Meta gave', async () => {
    renderNotifications({
      templates: [
        template({
          status: 'rejected',
          statusReason: 'Template content violates policy',
        }),
      ],
    });
    expect(await screen.findByText('rejected')).toBeTruthy();
    expect(screen.getByText('Template content violates policy')).toBeTruthy();
  });

  it('shows an em dash where a template has no email subject, because that is a decision', async () => {
    // A template with no subject line is WhatsApp-only. Its absence IS
    // the fact, so the cell says so rather than being blank.
    renderNotifications({
      templates: [template({ name: 'whatsapp_only', emailSubject: null })],
    });
    expect(await screen.findByText('whatsapp_only')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows the consent address and the words the member wrote down', async () => {
    renderNotifications();
    expect(
      await screen.findByText('Signed the delivery acknowledgement on 12 Aug 2026'),
    ).toBeTruthy();
    // The number appears twice on purpose — once as the address the
    // agreement was given for, once as the address a message actually
    // went to — and the two being the same value is the rule working.
    expect(screen.getAllByText('+919812345678')).toHaveLength(2);
    expect(screen.getByText('opted in')).toBeTruthy();
  });

  it('reads a failed delivery as its provider code, never as a raw payload', async () => {
    renderNotifications({
      messages: [
        message({
          status: 'failed',
          deliveredAt: null,
          failedAt: '2026-08-18T09:00:09.000Z',
          failureCode: '131047',
          failureDetail: 'Re-engagement message',
        }),
      ],
    });
    expect(await screen.findByText('failed')).toBeTruthy();
    expect(screen.getByText('131047')).toBeTruthy();
  });

  it('offers exactly the statuses Meta’s lifecycle allows from where the template is', async () => {
    // The control is drawn from the same edge set migration 0092's guard
    // admits, so anything offered here is something the server accepts.
    // `rejected` is the interesting one: an earlier draft made it a dead
    // end, which burned the template name forever.
    renderNotifications({ templates: [template({ status: 'rejected' })] });
    const control = await screen.findByLabelText(/New status for challan_issued/);
    const offered = [...(control as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    expect(offered).toEqual(['', 'pending', 'disabled']);
  });

  it('draws no status control for a template Meta has withdrawn', async () => {
    renderNotifications({ templates: [template({ status: 'disabled' })] });
    expect(await screen.findByText('Withdrawn by Meta')).toBeTruthy();
    expect(screen.queryByLabelText(/New status for/)).toBeNull();
  });

  it('records what Meta said, with the reason box only where Meta explains itself', async () => {
    const api = renderNotifications({ templates: [template({ status: 'pending' })] });
    const control = await screen.findByLabelText(/New status for challan_issued/);

    // Approving is not something Meta explains, so no reason box.
    fireEvent.change(control, { target: { value: 'approved' } });
    expect(screen.queryByLabelText(/What Meta said/)).toBeNull();

    // Rejecting is.
    fireEvent.change(control, { target: { value: 'rejected' } });
    fireEvent.change(screen.getByLabelText(/What Meta said/), {
      target: { value: 'Template content violates policy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(api.setNotificationTemplateStatus).toHaveBeenCalled();
    });
    expect(vi.mocked(api.setNotificationTemplateStatus).mock.calls[0]?.[2]).toEqual({
      status: 'rejected',
      reason: 'Template content violates policy',
    });
  });

  it('records a consent against the address it was given for', async () => {
    const api = renderNotifications();
    fireEvent.click(await screen.findByText('Record a consent'));
    fireEvent.change(screen.getByLabelText('Contact'), {
      target: { value: '55555555-5555-4555-8555-555555555555' },
    });
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: '+919812345678' },
    });
    fireEvent.change(screen.getByLabelText('How it was obtained'), {
      target: { value: 'Signed the delivery acknowledgement' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }));
    await waitFor(() => {
      expect(api.recordNotificationConsent).toHaveBeenCalled();
    });
    expect(vi.mocked(api.recordNotificationConsent).mock.calls[0]?.[1]).toEqual({
      contactId: '55555555-5555-4555-8555-555555555555',
      channel: 'whatsapp',
      address: '+919812345678',
      state: 'opted_in',
      evidence: 'Signed the delivery acknowledgement',
    });
  });

  it('sends a template to a contact and never names an address', async () => {
    const api = renderNotifications();
    fireEvent.click(await screen.findByText('Send a message'));
    fireEvent.change(screen.getByLabelText('Template'), {
      target: { value: '33333333-3333-4333-8333-333333333333' },
    });
    fireEvent.change(screen.getByLabelText('Contact'), {
      target: { value: '55555555-5555-4555-8555-555555555555' },
    });
    fireEvent.change(screen.getByLabelText('Parameters'), {
      target: { value: 'DC/2026/0042 | WR-BCT-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(api.sendNotification).toHaveBeenCalled();
    });
    const body = vi.mocked(api.sendNotification).mock.calls[0]?.[1];
    expect(body).toEqual({
      templateId: '33333333-3333-4333-8333-333333333333',
      contactId: '55555555-5555-4555-8555-555555555555',
      parameters: ['DC/2026/0042', 'WR-BCT-2026'],
    });
    // The rule, expressed as a missing field: the address comes from the
    // consent record, and a caller who could pass one could send
    // somewhere nobody agreed to.
    expect(body).not.toHaveProperty('address');
  });

  it('hides the channel forms from a member who is not the owner', async () => {
    renderNotifications({ isOwner: false });
    // The register still reads — the notifications authority is what gets
    // you in here — but pointing the organisation's outbound number
    // somewhere else is the owner's alone.
    expect(await screen.findByText('+919000000001')).toBeTruthy();
    expect(screen.queryByText('Change WhatsApp settings')).toBeNull();
    expect(screen.queryByText('Change Email settings')).toBeNull();
    // Writing a template is not owner-only, so it stays.
    expect(screen.getByText('Write a template')).toBeTruthy();
  });

  it('saves only the channel’s own fields, whatever the form holds', async () => {
    const api = renderNotifications();
    fireEvent.click(await screen.findByText('Change Email settings'));
    fireEvent.change(screen.getByLabelText('Sender address'), {
      target: { value: 'billing@contractor.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save channel' }));
    await waitFor(() => {
      expect(api.saveNotificationChannel).toHaveBeenCalled();
    });
    const call = vi.mocked(api.saveNotificationChannel).mock.calls[0];
    expect(call?.[1]).toBe('email');
    // An email row can never carry a phone number id, whatever a client
    // sends: the view normalises per channel, and so does the route.
    expect(call?.[2]).toEqual({
      enabled: false,
      fromAddress: 'billing@contractor.example',
      replyToAddress: null,
    });
  });
});
