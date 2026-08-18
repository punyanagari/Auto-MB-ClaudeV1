import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { formValue, type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { TwoFactorEnrolment } from './TwoFactorEnrolment.js';

interface AccountSecurityProps {
  readonly api: ApiClient;
}

interface SecurityState {
  readonly twoFactorEnabled: boolean;
  readonly mfaRequired: boolean;
  readonly mfaEnforced: boolean;
}

/** The account's second-factor state, as the mock's bordered status row
 * (`app/settings/page` at fdfe5ef: a `rounded-lg border px-4 py-3`
 * strip led by a tinted shield, with the standing reason beneath it).
 * The mock draws only the "on" case; "off" reads the same shape in the
 * warning tone. The icon never carries the state alone — the sentence
 * beside it says it in words. */
function StatusLamp({
  on,
  reason,
}: {
  readonly on: boolean;
  readonly reason?: React.ReactNode;
}) {
  const Icon = on ? ShieldCheck : ShieldAlert;
  return (
    <div className="my-3 flex items-start gap-3 rounded-lg border border-border px-4 py-3">
      <Icon
        aria-hidden="true"
        /* `--warning` is a fill colour for tints, `--warning-foreground`
         * is the ink that goes on them (`docs/DESIGN.md` § Palette); the
         * off state takes the ink so it stays legible on `--card`. */
        className={cn(
          'mt-0.5 size-5 shrink-0',
          on ? 'text-success' : 'text-warning-foreground',
        )}
      />
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">
          {on ? 'Two-factor authentication is on' : 'Two-factor authentication is off'}
        </span>
        {reason !== undefined && (
          <span className="text-xs text-pretty text-muted-foreground">{reason}</span>
        )}
      </div>
    </div>
  );
}

/** Account-level security: two-factor status, enrolment, backup-code
 * rotation, and (where policy allows) disablement. User-level, so it sits
 * on the Settings page but reads nothing from the organisation. */
export function AccountSecurity({ api }: AccountSecurityProps) {
  const [state, setState] = useState<SecurityState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [freshCodes, setFreshCodes] = useState<readonly string[] | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const me = await api.me();
      if (me === null) {
        setLoadError('Your session has expired; sign in again.');
        return;
      }
      setState({
        twoFactorEnabled: me.twoFactorEnabled,
        mfaRequired: me.mfaRequired,
        mfaEnforced: me.mfaEnforced,
      });
    } catch (cause) {
      setLoadError(
        cause instanceof Error
          ? cause.message
          : 'The security status could not be loaded.',
      );
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = formValue(new FormData(event.currentTarget), 'password');
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const codes = await api.regenerateBackupCodes(password);
      setFreshCodes(codes);
      setNotice('New backup codes issued. The previous codes no longer work.');
    } catch (cause) {
      setError(errorMessage(cause, 'The backup codes could not be regenerated.'));
    } finally {
      setPending(false);
    }
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = formValue(new FormData(event.currentTarget), 'password');
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.disableTwoFactor(password);
      setFreshCodes(null);
      setNotice('Two-factor authentication is off. Other sessions were signed out.');
      await reload();
    } catch (cause) {
      // MFA_REQUIRED_BY_POLICY lands here for accounts holding document
      // authority: the server refuses regardless of what this screen shows.
      setError(errorMessage(cause, 'Two-factor authentication could not be disabled.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-4xl">
      <CardHeader>
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-base leading-snug font-medium">Account security</h2>
          <p className="text-sm text-muted-foreground">
            Your sign-in, not this organisation&rsquo;s data. It follows you into every
            organisation you belong to.
          </p>
        </div>
      </CardHeader>
      {state === null ? (
        loadError === null ? (
          <LoadingState label="the account security status" rows={2} />
        ) : (
          <ErrorState
            retryLabel="Retry security status"
            onRetry={() => {
              void reload();
            }}
          >
            {loadError}
          </ErrorState>
        )
      ) : (
        <>
          <StatusLamp
            on={state.twoFactorEnabled}
            reason={
              state.mfaRequired
                ? `Your account holds document authority, so two-factor authentication is required${state.mfaEnforced ? '' : ' before the pilot goes live'} and cannot be turned off.`
                : undefined
            }
          />

          {!state.twoFactorEnabled &&
            (enrolling ? (
              <div className="mt-3">
                <TwoFactorEnrolment
                  api={api}
                  onEnrolled={() => {
                    setEnrolling(false);
                    setNotice('Two-factor authentication is on for your account.');
                    void reload();
                  }}
                />
              </div>
            ) : (
              <Actions>
                <Button
                  onClick={() => {
                    setEnrolling(true);
                    setError(null);
                    setNotice(null);
                  }}
                >
                  Enable two-factor authentication
                </Button>
              </Actions>
            ))}

          {state.twoFactorEnabled && freshCodes !== null && (
            <>
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                Your new backup codes, shown once. Each signs you in one time if the
                authenticator is lost.
              </p>
              <ul className="my-3 grid max-w-sm list-none grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted/40 p-4 font-mono text-sm tabular-nums">
                {freshCodes.map((code) => (
                  <li key={code} className="select-all">
                    {code}
                  </li>
                ))}
              </ul>
            </>
          )}

          {state.twoFactorEnabled && (
            <Disclosure label="Regenerate backup codes">
              <p className="text-muted-foreground">
                Issues a fresh set and revokes every previous code. Do this if the
                stored codes may have been seen.
              </p>
              <form onSubmit={(event) => void regenerate(event)}>
                <Field>
                  <label htmlFor="security-regenerate-password">Password</label>
                  <input
                    id="security-regenerate-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <Actions>
                  <Button type="submit" disabled={pending}>
                    Regenerate codes
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          )}

          {state.twoFactorEnabled && !state.mfaRequired && (
            <Disclosure label="Turn off two-factor authentication">
              <p className="text-muted-foreground">
                Your other sessions are signed out when the second factor changes.
              </p>
              <form onSubmit={(event) => void disable(event)}>
                <Field>
                  <label htmlFor="security-disable-password">Password</label>
                  <input
                    id="security-disable-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <Actions>
                  <Button type="submit" variant="outline" disabled={pending}>
                    Turn off
                  </Button>
                </Actions>
              </form>
            </Disclosure>
          )}

          {error !== null && <FormError>{error}</FormError>}
          {notice !== null && <FormNotice>{notice}</FormNotice>}
        </>
      )}
    </Card>
  );
}
