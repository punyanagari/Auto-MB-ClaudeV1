// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SigningAgent, SigningRequest } from '@auto-mb/contracts';
import { SigningQueue } from '../../src/views/SigningQueue.js';
import { ORG_ID, stubApi } from './helpers.js';

/*
 * The signing queue, on the states only it has.
 *
 * The shared loading / empty / failure patterns are covered once for
 * every view by `state-coverage.test.tsx`. What is here is what this
 * screen has to say that no other register does: the full SHA-256 of the
 * bytes a signature will cover, the certificate it will be made with, and
 * whether there is a machine behind the queue at all.
 */

const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const AGENT_ID = '88888888-8888-4888-8888-888888888888';
const SOURCE_SHA = 'a'.repeat(64);
const SIGNED_SHA = 'b'.repeat(64);
const THUMBPRINT = 'CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4';

function request(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    id: REQUEST_ID,
    documentType: 'delivery_challan',
    documentId: '99999999-9999-4999-8999-999999999999',
    documentNumber: 'DC/2026/0042',
    workCode: 'RE-2026-11',
    channel: 'kiosk_dsc',
    status: 'pending',
    sourceSha256: SOURCE_SHA,
    signedSha256: null,
    certificateThumbprint: THUMBPRINT,
    signerName: 'A K SHARMA',
    signingReason: 'Issued by the contractor',
    signingLocation: 'Nagpur',
    requestedByUserId: 'user-1',
    requestedAt: '2026-08-18T09:30:00.000Z',
    expiresAt: '2026-08-25T09:30:00.000Z',
    claimedAt: null,
    completedAt: null,
    signatureVerdict: null,
    failureReason: null,
    ...overrides,
  };
}

function agent(overrides: Partial<SigningAgent> = {}): SigningAgent {
  return {
    id: AGENT_ID,
    label: 'Cabin kiosk',
    certificateThumbprint: THUMBPRINT,
    certificateSubject: 'CN=A K SHARMA, O=PUNYA NAGARI ENTERPRISES, C=IN',
    certificateNotAfter: '2027-05-23T00:00:00.000Z',
    operatorUserId: 'user-1',
    createdAt: '2026-08-17T05:00:00.000Z',
    lastSeenAt: '2026-08-18T09:31:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function renderQueue(
  requests: readonly SigningRequest[],
  agents: readonly SigningAgent[],
  overrides: Parameters<typeof stubApi>[0] = {},
) {
  const api = stubApi({
    listSigningRequests: vi
      .fn()
      .mockResolvedValue({ requests, nextCursor: null, agents }),
    ...overrides,
  });
  render(<SigningQueue api={api} organisationId={ORG_ID} canModify />);
  return api;
}

describe('the signing queue', () => {
  it('prints the covered digest in full, so it can be compared with the kiosk', async () => {
    renderQueue([request()], [agent()]);
    // Complete, not truncated. The kiosk prints this exact string before
    // its PIN dialog opens, and a shortened one compares nothing —
    // ADR-0012 § "The approval is the authority".
    expect(await screen.findByText(SOURCE_SHA)).toBeTruthy();
    expect(screen.getAllByText(THUMBPRINT).length).toBeGreaterThan(0);
  });

  it('shows what was produced beside what was authorised', async () => {
    renderQueue(
      [
        request({
          status: 'signed',
          signedSha256: SIGNED_SHA,
          completedAt: '2026-08-18T09:32:00.000Z',
        }),
      ],
      [agent()],
    );
    expect(await screen.findByText(SOURCE_SHA)).toBeTruthy();
    expect(screen.getByText(`signed ${SIGNED_SHA}`)).toBeTruthy();
  });

  it('says so when no kiosk is registered, rather than leaving a dead queue looking healthy', async () => {
    renderQueue([request()], []);
    expect(await screen.findByText(/No signing kiosk is registered/)).toBeTruthy();
    expect(screen.getByText(/Requests raised now will wait/)).toBeTruthy();
  });

  it('treats a revoked kiosk as no kiosk', async () => {
    renderQueue([request()], [agent({ revokedAt: '2026-08-18T10:00:00.000Z' })]);
    expect(await screen.findByText(/No signing kiosk is registered/)).toBeTruthy();
  });

  it('carries the reason a request stopped', async () => {
    renderQueue(
      [
        request({
          status: 'failed',
          completedAt: '2026-08-18T09:32:00.000Z',
          failureReason: 'The token PIN dialog was cancelled',
        }),
      ],
      [agent()],
    );
    expect(await screen.findByText('The token PIN dialog was cancelled')).toBeTruthy();
  });

  it('withdraws a pending request only with a reason', async () => {
    const cancelSigningRequest = vi
      .fn()
      .mockResolvedValue({ request: request({ status: 'cancelled' }) });
    renderQueue([request()], [agent()], { cancelSigningRequest });

    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const confirm = screen.getByRole('button', { name: 'Withdraw request' });
    // Empty, and whitespace, are both refused — the server's own minimum
    // is three characters and a control that submits blanks would turn a
    // schema refusal into a surprise.
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'The consignee address was wrong' },
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(cancelSigningRequest).toHaveBeenCalledWith(ORG_ID, REQUEST_ID, {
        reason: 'The consignee address was wrong',
      });
    });
  });

  it('offers no withdrawal on a request that has finished', async () => {
    renderQueue(
      [
        request({
          status: 'signed',
          signedSha256: SIGNED_SHA,
          completedAt: '2026-08-18T09:32:00.000Z',
        }),
      ],
      [agent()],
    );
    await screen.findByText(SOURCE_SHA);
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });
});
