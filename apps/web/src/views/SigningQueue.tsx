import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { SigningAgent, SigningRequest } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * The signing queue (migration 0091, ADR-0012 lane 2).
 *
 * THE MOCK DRAWS NO SIGNING SCREEN, and this one is therefore
 * application-first under `AGENTS.md` § Design contract 2 and 4:
 * behaviour the mock cannot express, built inside its existing visual
 * grammar with no new visual language. Every element here is one the mock
 * already ships — its `PageHeader`, its `Card`/`CardHeader`, its
 * `DataTable`, its dot-plus-label status chip, its `ConfirmDialog`, its
 * button variants. `docs/UX.md` § 16 records the stance rather than
 * inventing a mock citation for a screen that does not exist there.
 *
 * ## What it has to say that a register normally does not
 *
 * The SHA-256 of what is being signed, in full, on the row. ADR-0012 §
 * "The approval is the authority" requires the person authorising a
 * signature to see the hash of the bytes it will cover; a hash nobody is
 * shown is a hash nobody can compare against the one the kiosk prints
 * before its PIN dialog opens. It is rendered monospaced and complete
 * rather than truncated, because half a digest compares nothing.
 *
 * And whether a kiosk is registered at all. A queue with no kiosk behind
 * it will never move, and a screen that shows five pending rows and no
 * reason is worse than one that says the machine is not there.
 *
 * ## What it deliberately does not do
 *
 * Raise a request. That action belongs on the document — the challan or
 * the invoice being signed — because it is a thing you do TO a document,
 * and a picker on this screen would be a second place to choose one. This
 * screen is the trail and the escape hatch.
 */

/** Rows per page. Signing is low-volume — one row per issued document
 * anybody asked for a signature on — so the whole recent queue fits one
 * request and the cursor is there for the year, not the day. */
const PAGE_SIZE = 50;

interface SigningQueueProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Owner or office: the roles that may withdraw a request. The `issue`
   * authority is checked by the server, which is where it belongs; this
   * only decides whether the control is worth drawing. */
  readonly canModify: boolean;
}

export function SigningQueue({ api, organisationId, canModify }: SigningQueueProps) {
  const [requests, setRequests] = useState<readonly SigningRequest[] | null>(null);
  const [agents, setAgents] = useState<readonly SigningAgent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [withdrawing, setWithdrawing] = useState<SigningRequest | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadVersion((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRequests(null);
    setLoadError(null);
    api
      .listSigningRequests(organisationId, { limit: PAGE_SIZE })
      .then((loaded) => {
        if (cancelled) return;
        setRequests(loaded.requests);
        setAgents(loaded.agents);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The signing queue could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const withdraw = useCallback(
    async (request: SigningRequest, reason: string) => {
      setPending(true);
      setActionError(null);
      try {
        await api.cancelSigningRequest(organisationId, request.id, { reason });
        setWithdrawing(null);
        reload();
      } catch (cause: unknown) {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The request could not be withdrawn.',
        );
      } finally {
        setPending(false);
      }
    },
    [api, organisationId, reload],
  );

  const header = (
    <PageHeader
      eyebrow="Documents"
      title="Signing queue"
      titleId="signing-queue-title"
      description="Issued documents waiting for the organisation's digital signature, and what the kiosk did with each one."
    />
  );

  if (loadError !== null && requests === null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry the signing queue">
          {loadError}
        </ErrorState>
      </>
    );
  }

  const live = agents.filter((agent) => agent.revokedAt === null);

  return (
    <>
      {header}

      <KioskPanel agents={live} />

      <div className="mt-4">
        {requests === null ? (
          <LoadingState label="the signing queue" rows={5} columns={6} />
        ) : requests.length === 0 ? (
          <EmptyState>
            No document has been sent for signature yet. Raise a request from the
            challan or invoice you want signed.
          </EmptyState>
        ) : (
          <DataTable scroll>
            <caption className="sr-only">Signing queue</caption>
            <thead>
              <tr>
                <th scope="col">Document</th>
                <th scope="col">Work</th>
                <th scope="col">Raised</th>
                <th scope="col">Covered bytes (SHA-256)</th>
                <th scope="col">Certificate</th>
                <th scope="col">Status</th>
                {canModify && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id}>
                  <td>
                    <span className="font-medium">
                      {request.documentNumber ?? 'Unnumbered'}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {request.documentType === 'delivery_challan'
                        ? 'Delivery challan'
                        : 'Tax invoice'}
                    </span>
                  </td>
                  <td>{request.workCode ?? '—'}</td>
                  <td>
                    <span className="tabular-nums">
                      {formatTimestamp(request.requestedAt)}
                    </span>
                    {request.completedAt !== null && (
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        finished {formatTimestamp(request.completedAt)}
                      </span>
                    )}
                  </td>
                  <td>
                    {/* Complete, never truncated: half a digest compares
                        nothing, and comparing it against what the kiosk
                        printed is the whole point of showing it. */}
                    <code className="break-all font-mono text-xs">
                      {request.sourceSha256}
                    </code>
                    {request.signedSha256 !== null && (
                      <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                        signed {request.signedSha256}
                      </code>
                    )}
                  </td>
                  <td>
                    <code className="break-all font-mono text-xs">
                      {request.certificateThumbprint ?? '—'}
                    </code>
                  </td>
                  <td>
                    <StatusChip status={request.status} />
                    {request.failureReason !== null && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {request.failureReason}
                      </span>
                    )}
                  </td>
                  {canModify && (
                    <td>
                      {request.status === 'pending' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setActionError(null);
                            setWithdrawing(request);
                          }}
                        >
                          Withdraw
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}

        {loadError !== null && requests !== null && (
          <p className="alert error" role="alert">
            {loadError}
          </p>
        )}
        {actionError !== null && (
          <p className="alert error" role="alert">
            {actionError}
          </p>
        )}
      </div>

      {withdrawing !== null && (
        <WithdrawDialog
          request={withdrawing}
          pending={pending}
          onCancel={() => {
            setWithdrawing(null);
          }}
          onConfirm={(reason) => {
            void withdraw(withdrawing, reason);
          }}
        />
      )}
    </>
  );
}

/**
 * Whether there is a machine behind the queue.
 *
 * Drawn even when there is one, because "the kiosk last polled four days
 * ago" is the fact that explains a queue that has stopped moving, and it
 * is invisible everywhere else.
 */
function KioskPanel({ agents }: { readonly agents: readonly SigningAgent[] }) {
  if (agents.length === 0) {
    return (
      <Card className="border-warning">
        <CardHeader>
          <h2 className="text-base font-semibold">No signing kiosk is registered</h2>
        </CardHeader>
        <p className="text-sm text-muted-foreground">
          Nothing can sign until a kiosk is registered under Settings with the
          certificate it holds. Requests raised now will wait.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Signing kiosk</h2>
      </CardHeader>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {agents.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <ShieldCheck
              className="text-success-foreground"
              data-icon="inline-start"
              aria-hidden="true"
            />
            <span className="text-sm font-medium">{agent.label}</span>
            <code className="font-mono text-xs">{agent.certificateThumbprint}</code>
            <span className="text-xs text-muted-foreground">
              {agent.certificateSubject}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {agent.lastSeenAt === null
                ? 'never polled'
                : `last polled ${formatTimestamp(agent.lastSeenAt)}`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function WithdrawDialog({
  request,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly request: SigningRequest;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      title="Withdraw this signing request"
      description={`${request.documentNumber ?? 'This document'} will not be signed. The request keeps its record and the reason you give.`}
      confirmLabel="Withdraw request"
      pending={pending}
      confirmDisabled={reason.trim().length < 3}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={() => {
        onConfirm(reason.trim());
      }}
    >
      <label className="field">
        <span>Reason</span>
        <input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
    </ConfirmDialog>
  );
}
