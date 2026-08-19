import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MetaCloudWhatsAppTransport,
  readWhatsAppConfig,
} from '../src/notify/meta-cloud.js';
import {
  optOutsOf,
  parameterCountOf,
  receiptsOf,
} from '../src/routes/notifications.js';
import { consentStillStands, fallbackMessageId } from '../src/notify/send.js';
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

  it('falls back to now for a timestamp outside the Date range, rather than throwing', () => {
    // `new Date(1e18 * 1000)` is an Invalid Date and `toISOString()` on it
    // THROWS. Unclamped, one such entry escaped the handler and 500ed the
    // whole batch — which Meta then redelivered forever.
    const [receipt] = receiptsOf({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1' },
                statuses: [
                  { id: 'wamid.FAR', status: 'read', timestamp: '999999999999999999' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(receipt).toBeDefined();
    expect(() => receipt?.occurredAt.toISOString()).not.toThrow();
    expect(Number.isNaN(receipt?.occurredAt.getTime())).toBe(false);
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

describe('optOutsOf', () => {
  function messages(entries: readonly unknown[]): unknown {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '123456789012345' },
                messages: entries,
              },
            },
          ],
        },
      ],
    };
  }

  it('reads a typed opt-out and a tapped one, whatever the casing and punctuation', () => {
    const optOuts = optOutsOf(
      messages([
        { from: '919812345678', type: 'text', text: { body: 'STOP' } },
        { from: '919812345679', type: 'text', text: { body: ' unsubscribe ' } },
        { from: '919812345680', type: 'text', text: { body: 'Stop.' } },
        // Meta sends this INSTEAD of a text message when the recipient
        // taps a template's own opt-out control, so a receiver reading
        // only `text.body` would honour a typed STOP and ignore a tapped
        // one.
        {
          from: '919812345681',
          type: 'button',
          button: { text: 'Stop promotions', payload: 'STOP' },
        },
      ]),
    );
    expect(optOuts.map((entry) => entry.from)).toEqual([
      '919812345678',
      '919812345679',
      '919812345680',
      '919812345681',
    ]);
    expect(optOuts[0]?.phoneNumberId).toBe('123456789012345');
  });

  it('matches the whole message and never a substring of it', () => {
    // Substring matching on a legal act is how a product opts somebody
    // out for using a common English verb.
    const ignored = optOutsOf(
      messages([
        { from: '1', type: 'text', text: { body: 'please do not stop these' } },
        { from: '2', type: 'text', text: { body: 'STOPPED WORK ON SITE' } },
        { from: '3', type: 'text', text: { body: 'unsubscribed already?' } },
        { from: '4', type: 'text', text: { body: '' } },
        { from: '5', type: 'image', image: { id: 'media-1' } },
        // A body long enough to be a letter is not a keyword, whatever it
        // happens to contain.
        { from: '6', type: 'text', text: { body: `STOP${' '.repeat(80)}` } },
      ]),
    );
    expect(ignored).toEqual([]);
  });

  it('is total over anything at all, like the receipt parser beside it', () => {
    const nonsense: readonly unknown[] = [
      null,
      undefined,
      42,
      'a string',
      [],
      {},
      { entry: 'not an array' },
      { entry: [null] },
      { entry: [{ changes: [{ value: null }] }] },
      // No phone number id, so no tenant could be resolved from it.
      { entry: [{ changes: [{ value: { messages: [{ from: '1' }] } }] }] },
      // A sender long enough to be an attack rather than a number.
      messages([{ from: '9'.repeat(64), type: 'text', text: { body: 'STOP' } }]),
      // Only statuses, which is somebody else's parser.
      {
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: '1' },
                  statuses: [{ id: 'x', status: 'read' }],
                },
              },
            ],
          },
        ],
      },
    ];
    for (const [index, input] of nonsense.entries()) {
      expect(optOutsOf(input), `case ${String(index)}`).toEqual([]);
    }
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

describe('consentStillStands', () => {
  /* The predicate behind the re-read that closes the window between the
     queued row committing and the provider being called. Tested here
     rather than as a race because nothing a test can hook runs inside
     that window — the transport double is already past it — so a "race"
     test would be a test of the INSERT guard wearing this name. */
  const address = '+919812345678';

  it('stands only for an opt-in at the same address', () => {
    expect(consentStillStands({ state: 'opted_in', address }, address)).toBe(true);
  });

  it('falls for an opt-out, a moved address, and no record at all', () => {
    expect(consentStillStands({ state: 'opted_out', address }, address)).toBe(false);
    // The half that is easy to drop and expensive to lose: a contact who
    // re-consented on a NEW number has not consented to the old one.
    expect(
      consentStillStands({ state: 'opted_in', address: '+919000000009' }, address),
    ).toBe(false);
    expect(consentStillStands(null, address)).toBe(false);
  });
});

describe('fallbackMessageId', () => {
  it('is unique per call, because the column it fills is unique per CLUSTER', () => {
    // A clock-derived id collided across tenants whose relays both stayed
    // silent in the same millisecond — and the collision landed after the
    // mail had already gone out.
    const ids = new Set(Array.from({ length: 500 }, () => fallbackMessageId()));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^smtp:[0-9a-f-]{36}$/);
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

  it('marks a throttle retryable and a bad template not', async () => {
    // "Try again" and "never try again" are different instructions, and
    // the provider is the one that knows which it is.
    const throttled = transportWith(
      () =>
        new Response(
          JSON.stringify({ error: { code: 130429, message: 'Throttled' } }),
          {
            status: 429,
          },
        ),
    );
    await expect(
      throttled.transport.send({ phoneNumberId: '1', apiBaseUrl: null }, message),
    ).rejects.toMatchObject({ providerCode: '130429', retryable: true });

    const permanent = transportWith(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 132001, message: 'Template does not exist' },
          }),
          { status: 400 },
        ),
    );
    await expect(
      permanent.transport.send({ phoneNumberId: '1', apiBaseUrl: null }, message),
    ).rejects.toMatchObject({ providerCode: '132001', retryable: false });
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
