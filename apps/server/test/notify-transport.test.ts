import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MetaCloudWhatsAppTransport,
  readWhatsAppConfig,
} from '../src/notify/meta-cloud.js';
import { parameterCountOf, receiptsOf } from '../src/routes/notifications.js';
import {
  NotificationTransportError,
  renderTemplateBody,
  verifyMetaSignature,
} from '../src/notify/transport.js';

/**
 * The notification transport's own units (migration 0092).
 *
 * These are the four pieces the integration suite cannot corner: the
 * signature check has to be proved fail-closed against inputs Meta would
 * never send, the webhook parser has to be proved TOTAL over an
 * attacker-shaped body, and the Cloud API adapter's payload shape has to
 * be proved without a WABA to send it to.
 */

const SECRET = `app-secret-${'0'.repeat(32)}`;

function signatureFor(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyMetaSignature', () => {
  it('accepts the digest Meta computes', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
    expect(verifyMetaSignature(SECRET, body, signatureFor(body.toString('utf8')))).toBe(
      true,
    );
  });

  it('refuses everything it cannot verify, with no in-between', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}', 'utf8');
    const cases: readonly (string | undefined)[] = [
      undefined,
      '',
      'sha256=',
      'deadbeef',
      // The right algorithm prefix and a digest of the wrong length: the
      // length check has to come before timingSafeEqual, which throws on
      // mismatched buffers.
      'sha256=abc',
      // Uppercase hex: Meta sends lowercase, and admitting both would
      // widen the accepted set for no reason.
      signatureFor(body.toString('utf8')).toUpperCase(),
      // The right shape, the wrong secret.
      signatureFor(body.toString('utf8'), 'another-secret'),
      // The right secret over different bytes — which is the attack the
      // RAW body exists to close: a re-serialised object would pass here.
      signatureFor('{"object":"whatsapp_business_account" }'),
    ];
    for (const signature of cases) {
      expect(verifyMetaSignature(SECRET, body, signature), String(signature)).toBe(
        false,
      );
    }
  });
});

describe('receiptsOf', () => {
  it('reads the statuses array and nothing else', () => {
    const receipts = receiptsOf({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123456789012345' },
                // Both arrays present, as Meta actually sends. Only the
                // statuses are read.
                messages: [{ from: '919812345678', text: { body: 'STOP' } }],
                statuses: [
                  { id: 'wamid.A', status: 'delivered', timestamp: '1786000000' },
                  {
                    id: 'wamid.B',
                    status: 'failed',
                    timestamp: '1786000060',
                    errors: [
                      {
                        code: 131047,
                        title: 'Re-engagement message',
                        // The one field that quotes the recipient back,
                        // and the one that must not travel.
                        error_data: { details: 'Message to +91 98123 45678 failed' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      phoneNumberId: '123456789012345',
      providerMessageId: 'wamid.A',
      status: 'delivered',
      failureCode: null,
    });
    // Meta sends a UNIX SECOND count as a decimal string; a naive
    // `new Date(timestamp)` would read it as milliseconds and land in
    // 1970.
    expect(receipts[0]?.occurredAt.getTime()).toBe(1_786_000_000 * 1000);
    expect(receipts[1]).toMatchObject({
      providerMessageId: 'wamid.B',
      status: 'failed',
      failureCode: '131047',
      failureDetail: 'Re-engagement message',
    });
    // AGENTS.md rule 11: the recipient's number is nowhere in what this
    // function hands on to be stored.
    expect(JSON.stringify(receipts)).not.toContain('98123');
  });

  it('is total over anything at all', () => {
    // The signature proves WHO sent the bytes, not what is in them, so
    // this input is attacker-shaped even after the check passes.
    const nonsense: readonly unknown[] = [
      null,
      undefined,
      42,
      'a string',
      [],
      {},
      { entry: 'not an array' },
      { entry: [null] },
      { entry: [{ changes: {} }] },
      { entry: [{ changes: [{ value: null }] }] },
      // A status array with no phone number id to resolve a tenant from.
      {
        entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read' }] } }] }],
      },
      // A status this product does not model.
      {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: '1' },
                  statuses: [{ id: 'x', status: 'deleted' }],
                },
              },
            ],
          },
        ],
      },
    ];
    for (const [index, input] of nonsense.entries()) {
      expect(receiptsOf(input), `case ${String(index)}`).toEqual([]);
    }
  });

  it('falls back to now when Meta sends no usable timestamp', () => {
    const before = Date.now();
    const [receipt] = receiptsOf({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1' },
                statuses: [
                  { id: 'wamid.C', status: 'sent', timestamp: 'not a number' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(receipt?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('renderTemplateBody and parameterCountOf', () => {
  it('fills placeholders positionally and leaves a missing one standing', () => {
    expect(renderTemplateBody('Challan {{1}} for {{2}}.', ['DC/1', 'WR-BCT'])).toBe(
      'Challan DC/1 for WR-BCT.',
    );
    // Visible rather than blanked: an email reading `{{2}}` is a bug
    // somebody reports, and one reading nothing is a sentence that lost a
    // word without saying so.
    expect(renderTemplateBody('Challan {{1}} for {{2}}.', ['DC/1'])).toBe(
      'Challan DC/1 for {{2}}.',
    );
  });

  it('counts the HIGHEST index, because Meta’s components array is positional', () => {
    expect(parameterCountOf('nothing to fill')).toBe(0);
    expect(parameterCountOf('{{1}} and {{2}}')).toBe(2);
    // A body using 1 and 3 takes THREE parameters at Meta, not two.
    expect(parameterCountOf('{{1}} and {{3}}')).toBe(3);
  });
});

describe('readWhatsAppConfig', () => {
  it('is absent when nothing is configured', () => {
    expect(readWhatsAppConfig({})).toBeNull();
    expect(readWhatsAppConfig({ WHATSAPP_ENABLED: 'false' })).toBeNull();
  });

  it('refuses a half-set block rather than silently disabling the channel', () => {
    expect(() => readWhatsAppConfig({ WHATSAPP_ACCESS_TOKEN: 'x' })).toThrow(
      /WHATSAPP_ENABLED is not true/,
    );
    expect(() => readWhatsAppConfig({ WHATSAPP_ENABLED: 'yes' })).toThrow(
      /must be true or false/,
    );
  });

  it('refuses an app secret short enough to grind', () => {
    // It is the single thing between the public webhook address and a
    // forged delivery receipt, so a short one fails at boot rather than
    // being discovered later.
    expect(() =>
      readWhatsAppConfig({
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_ACCESS_TOKEN: 'token',
        WHATSAPP_APP_SECRET: 'too-short',
        WHATSAPP_VERIFY_TOKEN: 'verify',
      }),
    ).toThrow(/at least 32 characters/);
  });

  it('reads a complete block and defaults the pinned Graph version', () => {
    const config = readWhatsAppConfig({
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_ACCESS_TOKEN: 'token',
      WHATSAPP_APP_SECRET: SECRET,
      WHATSAPP_VERIFY_TOKEN: 'verify',
    });
    expect(config).toMatchObject({ graphVersion: 'v21.0', viaBsp: false });
  });
});

describe('MetaCloudWhatsAppTransport', () => {
  const config = {
    accessToken: 'the-token',
    appSecret: SECRET,
    verifyToken: 'verify',
    graphVersion: 'v21.0',
    timeoutMs: 5000,
    viaBsp: false,
  };

  function transportWith(responder: (url: string, init: RequestInit) => Response): {
    transport: MetaCloudWhatsAppTransport;
    calls: { url: string; body: unknown }[];
  } {
    const calls: { url: string; body: unknown }[] = [];
    const transport = new MetaCloudWhatsAppTransport(config, (input, init) => {
      // The adapter always calls with a string URL and a string body;
      // both are narrowed rather than stringified so a change that
      // started passing a Request or a stream fails here loudly.
      const url = typeof input === 'string' ? input : (input as URL).href;
      const raw = init?.body;
      const body: unknown = JSON.parse(typeof raw === 'string' ? raw : '{}');
      calls.push({ url, body });
      return Promise.resolve(responder(url, init ?? {}));
    });
    return { transport, calls };
  }

  const message = {
    toAddress: '+919812345678',
    templateName: 'challan_issued',
    language: 'en',
    parameters: ['DC/1', 'WR-BCT'],
    bodyText: 'Challan {{1}} for {{2}}.',
    subject: null,
  };

  it('posts Meta’s template shape and returns the wamid', async () => {
    const { transport, calls } = transportWith(
      () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }), {
          status: 200,
        }),
    );
    const id = await transport.send(
      { phoneNumberId: '123456789012345', apiBaseUrl: null },
      message,
    );
    expect(id).toBe('wamid.XYZ');
    expect(calls[0]?.url).toBe(
      'https://graph.facebook.com/v21.0/123456789012345/messages',
    );
    expect(calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // No leading plus: Meta refuses one.
      to: '919812345678',
      type: 'template',
      template: {
        name: 'challan_issued',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'DC/1' },
              { type: 'text', text: 'WR-BCT' },
            ],
          },
        ],
      },
    });
  });

  it('sends NO body component for a template that takes no parameters', async () => {
    const { transport, calls } = transportWith(
      () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.Q' }] }), {
          status: 200,
        }),
    );
    await transport.send(
      { phoneNumberId: '1', apiBaseUrl: null },
      { ...message, parameters: [] },
    );
    // An EMPTY components array is a 132000 refusal from Meta, which is
    // why the field is omitted rather than sent empty.
    expect(calls[0]?.body).toMatchObject({
      template: { name: 'challan_issued', language: { code: 'en' } },
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain('components');
  });

  it('routes through a BSP base URL when the organisation has one', async () => {
    const { transport, calls } = transportWith(
      () =>
        new Response(JSON.stringify({ messages: [{ id: 'wamid.B' }] }), {
          status: 200,
        }),
    );
    await transport.send(
      { phoneNumberId: '77', apiBaseUrl: 'https://bsp.example/wa/' },
      message,
    );
    expect(calls[0]?.url).toBe('https://bsp.example/wa/v21.0/77/messages');
  });

  it('reduces a refusal to a symbolic code and one line, never the payload', async () => {
    const { transport } = transportWith(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 131047,
              message: 'Re-engagement message',
              error_data: { details: 'Message to +91 98123 45678 failed' },
            },
          }),
          { status: 400 },
        ),
    );
    await expect(
      transport.send({ phoneNumberId: '1', apiBaseUrl: null }, message),
    ).rejects.toMatchObject({
      providerCode: '131047',
      detail: 'Re-engagement message',
      httpStatus: 400,
    });
    // The recipient's number is in `error_data.details` and must not
    // reach the delivery log, which is exported.
    await expect(
      transport
        .send({ phoneNumberId: '1', apiBaseUrl: null }, message)
        .catch((cause: unknown) =>
          cause instanceof NotificationTransportError
            ? JSON.stringify({ code: cause.providerCode, detail: cause.detail })
            : 'not a transport error',
        ),
    ).resolves.not.toContain('98123');
  });

  it('refuses an acceptance that names no message id', async () => {
    // Nothing could ever match a delivery receipt to such a row, so it is
    // a failure rather than a quiet success.
    const { transport } = transportWith(
      () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    await expect(
      transport.send({ phoneNumberId: '1', apiBaseUrl: null }, message),
    ).rejects.toMatchObject({ providerCode: 'malformed_response' });
  });

  it('verifies webhooks with the configured app secret', () => {
    const { transport } = transportWith(() => new Response('{}', { status: 200 }));
    const body = Buffer.from('{"a":1}', 'utf8');
    expect(transport.verifyWebhookSignature(body, signatureFor('{"a":1}'))).toBe(true);
    expect(transport.verifyWebhookSignature(body, signatureFor('{"a":2}'))).toBe(false);
    expect(transport.webhookVerifyToken).toBe('verify');
  });
});
