import { useCallback, useEffect, useState } from 'react';
import type { SigningAgent } from '@auto-mb/contracts';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * Registering and revoking the kiosk that holds the organisation's DSC
 * (migration 0091, ADR-0012 lane 2).
 *
 * Owner-only, and in Settings rather than on the queue, because this is
 * the one screen in the product that hands out a credential. The queue
 * reports whether a kiosk exists and when it last polled; deciding that
 * it should exist is a different act by a different person.
 *
 * ## What the owner is actually asked for
 *
 * A PEM chain and a thumbprint, both produced by
 * `tools/kiosk-signing-check.ps1 -ExportChain` at the kiosk itself. The
 * two are checked against each other server-side — the chain's leaf must
 * BE the thumbprint — because pasting the wrong file is the mistake that
 * would otherwise pin the kiosk to a certificate nobody chose.
 *
 * ## The token appears exactly once
 *
 * The server stores only its SHA-256, so the value in this panel after a
 * successful registration is the only copy that will ever exist. It stays
 * on screen until the owner dismisses it, deliberately: a value that
 * vanishes on the next re-render is a value somebody has to re-register
 * to recover.
 *
 * No mock screen; see `docs/UX.md` § 16. Built from the mock's own Card,
 * field, chip, button and confirm-dialog anatomy.
 */

interface SigningKioskSettingsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly isOwner: boolean;
}

export function SigningKioskSettings({
  api,
  organisationId,
  isOwner,
}: SigningKioskSettingsProps) {
  const [agents, setAgents] = useState<readonly SigningAgent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState<SigningAgent | null>(null);

  const reload = useCallback(() => {
    setVersion((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAgents(null);
    setLoadError(null);
    api
      .listSigningRequests(organisationId, { limit: 1 })
      .then((loaded) => {
        if (!cancelled) setAgents(loaded.agents);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The signing kiosks could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, version]);

  const register = useCallback(
    async (data: FormData) => {
      setPending(true);
      setActionError(null);
      try {
        const created = await api.registerSigningAgent(organisationId, {
          label: formValue(data, 'label').trim(),
          certificateChainPem: formValue(data, 'certificateChainPem'),
          certificateThumbprint: formValue(data, 'certificateThumbprint')
            .replaceAll(/[^0-9A-Fa-f]/g, '')
            .toUpperCase(),
        });
        setIssuedToken(created.token);
        reload();
      } catch (cause: unknown) {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The kiosk could not be registered.',
        );
      } finally {
        setPending(false);
      }
    },
    [api, organisationId, reload],
  );

  const revoke = useCallback(
    async (agent: SigningAgent) => {
      setPending(true);
      setActionError(null);
      try {
        await api.revokeSigningAgent(organisationId, agent.id);
        setRevoking(null);
        reload();
      } catch (cause: unknown) {
        setActionError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The kiosk could not be revoked.',
        );
      } finally {
        setPending(false);
      }
    },
    [api, organisationId, reload],
  );

  if (!isOwner) return null;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">Signing kiosk</h2>
      </CardHeader>

      {loadError !== null && agents === null ? (
        <ErrorState onRetry={reload} retryLabel="Retry the signing kiosks">
          {loadError}
        </ErrorState>
      ) : agents === null ? (
        <LoadingState label="the signing kiosks" rows={2} columns={3} />
      ) : agents.length === 0 ? (
        <EmptyState>
          No kiosk is registered, so nothing can be signed. Run
          tools/kiosk-signing-check.ps1 at the machine holding the token to export its
          certificate chain, then register it below.
        </EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {agents.map((agent) => (
            <li
              key={agent.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{agent.label}</span>
                <code className="font-mono text-xs tabular-nums">
                  {agent.certificateThumbprint}
                </code>
                <span className="text-xs text-muted-foreground">
                  {agent.certificateSubject}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  expires {formatTimestamp(agent.certificateNotAfter)} ·{' '}
                  {agent.lastSeenAt === null
                    ? 'never polled'
                    : `last polled ${formatTimestamp(agent.lastSeenAt)}`}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <StatusChip
                  status={agent.revokedAt === null ? 'active' : 'cancelled'}
                />
                {agent.revokedAt === null && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setActionError(null);
                      setRevoking(agent);
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {issuedToken !== null && (
        <div className="mt-4 rounded-lg border border-warning p-3">
          <p className="m-0 text-sm font-medium">
            Copy this token into the kiosk&rsquo;s token file now
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only its digest is stored. It cannot be shown again, and losing it means
            registering the kiosk afresh.
          </p>
          <code className="mt-2 block break-all font-mono text-xs">{issuedToken}</code>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            onClick={() => {
              setIssuedToken(null);
            }}
          >
            I have saved it
          </Button>
        </div>
      )}

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          void register(new FormData(form)).then(() => {
            form.reset();
          });
        }}
      >
        <label className="field">
          <span>Kiosk name</span>
          <input name="label" type="text" required minLength={2} maxLength={120} />
        </label>
        <label className="field">
          <span>Certificate thumbprint</span>
          <input
            name="certificateThumbprint"
            type="text"
            required
            spellCheck={false}
            placeholder="CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4"
          />
        </label>
        <label className="field">
          <span>Certificate chain (PEM, signer first)</span>
          <textarea
            name="certificateChainPem"
            required
            rows={6}
            spellCheck={false}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
        </label>
        <div>
          <Button type="submit" disabled={pending}>
            Register kiosk
          </Button>
        </div>
      </form>

      {actionError !== null && (
        <p className="alert error" role="alert">
          {actionError}
        </p>
      )}

      {revoking !== null && (
        <ConfirmDialog
          title="Revoke this signing kiosk"
          description={`${revoking.label} will stop signing immediately, and every request waiting on it will be failed with a reason. A revoked kiosk can never be restored.`}
          confirmLabel="Revoke kiosk"
          pending={pending}
          tone="destructive"
          onCancel={() => {
            setRevoking(null);
          }}
          onConfirm={() => {
            void revoke(revoking);
          }}
        />
      )}
    </Card>
  );
}
