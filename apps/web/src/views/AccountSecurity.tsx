import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Disclosure } from '../ui/disclosure.js';
import { Field, Actions, FormError, FormNotice, Hint } from '../ui/form.js';
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

/** The signal lamp for the account's second factor. */
function StatusLamp({ on }: { readonly on: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium">
      <span
        aria-hidden="true"
        className={
          on
            ? 'size-2.5 rounded-full bg-success shadow-[0_0_6px] shadow-success/60'
            : 'size-2.5 rounded-full bg-warning shadow-[0_0_6px] shadow-warning/60'
        }
      />
      {on ? 'Two-factor authentication is on' : 'Two-factor authentication is off'}
    </span>
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
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The backup codes could not be regenerated.',
      );
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
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'Two-factor authentication could not be disabled.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mx-auto mb-8 max-w-[26rem]">
      <h2 className="mt-0">Account security</h2>
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
          <StatusLamp on={state.twoFactorEnabled} />
          {state.mfaRequired && (
            <Hint>
              Your account holds document authority, so two-factor authentication is
              required{state.mfaEnforced ? '' : ' before the pilot goes live'} and
              cannot be turned off.
            </Hint>
          )}

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
