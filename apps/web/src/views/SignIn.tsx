import { useRef, useState, type FormEvent } from 'react';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';

interface SignInProps {
  readonly api: ApiClient;
  readonly onSignedIn: () => void;
}

type Mode = 'sign-in' | 'sign-up' | 'forgot' | 'reset';

/** What the reset link left in the address bar, read once and removed.
 *
 * The server's `/api/auth/reset-password/:token` callback checks the token
 * and then redirects here carrying either `?token=` (good) or
 * `?error=INVALID_TOKEN` (expired, already spent, or mistyped). The token
 * is a bearer secret for the account, so it is taken out of the address
 * bar immediately: it should not sit in browser history, in a screenshot
 * of the tab, or in whatever the operator pastes into a support ticket.
 */
function takeResetParameters(): { token: string | null; expired: boolean } {
  if (typeof window === 'undefined') return { token: null, expired: false };
  const parameters = new URLSearchParams(window.location.search);
  const token = parameters.get('token');
  const expired = parameters.get('error') === 'INVALID_TOKEN';
  if (token === null && !expired) return { token: null, expired: false };
  parameters.delete('token');
  parameters.delete('error');
  const query = parameters.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
  return { token, expired };
}

/** Where the reset link should land. The server refuses a redirect target
 * outside its trusted origins, so this is deliberately the app's own
 * address and nothing more. */
function resetRedirectTarget(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/** The quantity ledger as a platform indicator board: the accent in this
 * system is the amber of an Indian Railways indicator, so the one graphic
 * on the page is that board showing the product's actual promise. Decorative
 * — every figure in it is illustrative, and the prose beside it carries the
 * meaning, so assistive technology is spared a fictional work order. */
function LedgerBoard() {
  const lit = 7;
  const pips = 10;
  return (
    <div
      aria-hidden="true"
      className="rounded-lg border border-sidebar-border bg-sidebar-accent p-4 font-mono text-xs select-none sm:p-5"
    >
      <div className="mb-3 flex items-baseline justify-between border-b border-sidebar-border pb-2 tracking-[0.18em] text-sidebar-faint uppercase">
        <span>Quantity ledger</span>
        <span>DCW-1</span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-y-2 tabular-nums">
        <dt className="text-sidebar-faint">Awarded</dt>
        <dd className="m-0 text-sidebar-foreground">1,250 Nos</dd>
        <dt className="text-sidebar-faint">Delivered</dt>
        <dd className="m-0 text-sidebar-foreground">875 Nos</dd>
        <dt className="text-sidebar-faint">Remaining</dt>
        <dd className="m-0 text-sidebar-foreground">375 Nos</dd>
      </dl>
      <div className="mt-4 flex items-center gap-1.5">
        {Array.from({ length: pips }, (_, index) => (
          <span
            key={index}
            className={
              index < lit
                ? 'h-2 flex-1 rounded-full bg-sidebar-primary'
                : 'h-2 flex-1 rounded-full bg-sidebar-border'
            }
          />
        ))}
      </div>
      <p className="mt-2 mb-0 tracking-[0.18em] text-sidebar-faint uppercase">
        70% executed
      </p>
    </div>
  );
}

export function SignIn({ api, onSignedIn }: SignInProps) {
  // Read before the first paint: a reset link opens straight onto the
  // new-password form rather than onto a sign-in box the operator cannot
  // satisfy.
  const resetParametersRef = useRef<{ token: string | null; expired: boolean } | null>(
    null,
  );
  resetParametersRef.current ??= takeResetParameters();
  const resetParameters = resetParametersRef.current;

  const [mode, setMode] = useState<Mode>(
    resetParameters.token === null ? 'sign-in' : 'reset',
  );
  const [error, setError] = useState<string | null>(
    resetParameters.expired
      ? 'That reset link has expired or was already used. Ask for a new one.'
      : null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** A pending two-factor challenge: the password was right, and the
   * session exists only after a code proves the second factor. */
  const [totpStep, setTotpStep] = useState(false);
  const [useBackupCode, setUseBackupCode] = useState(false);

  function switchMode(next: Mode): void {
    setMode(next);
    setError(null);
    setNotice(null);
  }

  /** Asks for the recovery mail. The server answers identically for an
   * address it knows and one it does not, and so does this screen: a form
   * that said "no such account" would be an account-existence oracle on
   * an unauthenticated page. */
  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = formValue(new FormData(event.currentTarget), 'email');

    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await api.requestPasswordReset(email, resetRedirectTarget());
      setNotice(
        `If ${email} has an account, a reset link is on its way. The link works ` +
          'once and stops working after an hour. Check the spam folder before ' +
          'asking again.',
      );
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  /** Spends the token on the new password, then hands the operator back to
   * the sign-in form — the reset does not create a session, and with the
   * second factor untouched the next sign-in still asks for a code. */
  async function submitNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = formValue(data, 'password');
    const confirmation = formValue(data, 'password-confirmation');
    const token = resetParameters.token;
    // eslint-disable-next-line security/detect-possible-timing-attacks -- a null check on a value this browser was given, not a comparison against a secret; the heuristic fires on the identifier's name alone
    if (token === null) {
      setError('That reset link is incomplete. Ask for a new one.');
      return;
    }
    // eslint-disable-next-line security/detect-possible-timing-attacks -- both sides are what this operator just typed into this form; there is no secret on the other side to leak a timing signal about
    if (password !== confirmation) {
      setError('The two passwords do not match.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      resetParametersRef.current = { token: null, expired: false };
      setMode('sign-in');
      setError(null);
      setNotice(
        'Password changed, and every other session was signed out. Sign in with ' +
          'the new password; your authenticator app is unchanged.',
      );
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = formValue(data, 'email');
    const password = formValue(data, 'password');
    const name = formValue(data, 'name');

    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'sign-up') {
        await api.signUp(email, name, password);
      } else {
        const outcome = await api.signIn(email, password);
        if (outcome.twoFactorRequired) {
          setTotpStep(true);
          setUseBackupCode(false);
          return;
        }
      }
      onSignedIn();
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = formValue(new FormData(event.currentTarget), 'code').trim();

    setPending(true);
    setError(null);
    try {
      if (useBackupCode) {
        await api.verifyBackupCode(code);
      } else {
        await api.verifyTotp(code);
      }
      onSignedIn();
    } catch (cause) {
      // Errors persist inline until a correct code lands — including the
      // 429 lockout message, which tells the operator to wait rather than
      // burn more attempts.
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The server could not be reached. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_30rem]">
      {/* The graphite rail, widened into a whole panel. On a phone it keeps
          the brand and the promise and drops the rest, so the form is not
          pushed below a screenful of orientation. */}
      <section className="flex flex-col justify-center gap-8 bg-sidebar px-6 py-10 text-sidebar-foreground sm:px-10 lg:px-14 lg:py-16">
        <div className="flex items-center gap-3">
          <span
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-sidebar-primary font-semibold text-sidebar-primary-foreground"
            aria-hidden="true"
          >
            MB
          </span>
          <span className="text-base font-semibold tracking-tight">Auto-MB</span>
        </div>

        <div className="max-w-xl">
          <p className="mb-3 text-xs font-semibold tracking-[0.18em] text-sidebar-primary uppercase">
            Post-award works execution
          </p>
          {/* Deliberately not a heading: the page's one h1 belongs to the form,
              and a second heading above it would put the document out of order. */}
          <p className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-3xl">
            From the Letter of Acceptance to an honest quantity ledger.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-sidebar-faint text-pretty">
            Works execution for Indian government contracts, Railways first.
          </p>
        </div>

        <div className="hidden max-w-md lg:block">
          <LedgerBoard />
        </div>
      </section>

      {/* Paper, and the only thing on it is the form. */}
      <section className="flex items-center justify-center bg-background px-6 py-12 sm:px-10">
        {totpStep ? (
          <div className="w-full max-w-sm">
            <h1 id="signin-title" tabIndex={-1}>
              Two-factor check
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              {useBackupCode
                ? 'Enter one of the backup codes you stored when enrolling. Each code works once.'
                : 'Enter the 6-digit code from your authenticator app.'}
            </p>

            <form onSubmit={(event) => void submitCode(event)}>
              <Field>
                <label htmlFor="signin-code">
                  {useBackupCode ? 'Backup code' : 'Authenticator code'}
                </label>
                <input
                  id="signin-code"
                  name="code"
                  type="text"
                  className="font-mono tracking-[0.2em] tabular-nums"
                  inputMode={useBackupCode ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  minLength={useBackupCode ? 6 : 6}
                  maxLength={useBackupCode ? 20 : 6}
                  key={useBackupCode ? 'backup' : 'totp'}
                />
              </Field>

              {error !== null && <FormError>{error}</FormError>}

              <Actions className="flex-col items-stretch gap-3">
                <Button type="submit" disabled={pending} className="w-full">
                  {pending ? 'Checking…' : 'Verify and sign in'}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setUseBackupCode(!useBackupCode);
                    setError(null);
                  }}
                >
                  {useBackupCode
                    ? 'Use your authenticator instead'
                    : 'Use a backup code instead'}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    setTotpStep(false);
                    setUseBackupCode(false);
                    setError(null);
                  }}
                >
                  Back to sign in
                </Button>
              </Actions>
            </form>
          </div>
        ) : mode === 'forgot' ? (
          <div className="w-full max-w-sm">
            <h1 id="signin-title" tabIndex={-1}>
              {notice === null ? 'Reset your password' : 'Check your email'}
            </h1>
            {notice === null ? (
              <>
                <p className="text-sm text-muted-foreground text-pretty">
                  We will email a link that lets you set a new password. Your
                  authenticator app is not affected — signing in still asks for the
                  code.
                </p>

                <form onSubmit={(event) => void requestReset(event)}>
                  <Field>
                    <label htmlFor="reset-email">Email</label>
                    <input
                      id="reset-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      autoFocus
                      required
                    />
                    <Hint>
                      Use the email your organisation was invited with. If you have also
                      lost the authenticator, an owner has to reset the second factor
                      for you.
                    </Hint>
                  </Field>

                  {error !== null && <FormError>{error}</FormError>}

                  <Actions className="flex-col items-stretch gap-3">
                    <Button type="submit" disabled={pending} className="w-full">
                      {pending ? 'Sending…' : 'Email the reset link'}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full"
                      onClick={() => {
                        switchMode('sign-in');
                      }}
                    >
                      Back to sign in
                    </Button>
                  </Actions>
                </form>
              </>
            ) : (
              <>
                {/* Not a FormNotice: this is the whole screen after the
                    request, and an instruction that expires after six
                    seconds would leave the operator looking at a heading
                    with nothing under it. */}
                <p className="text-sm text-pretty" role="status">
                  {notice}
                </p>
                <Actions className="flex-col items-stretch gap-3">
                  <Button
                    className="w-full"
                    onClick={() => {
                      switchMode('sign-in');
                    }}
                  >
                    Back to sign in
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      switchMode('forgot');
                    }}
                  >
                    Use a different email
                  </Button>
                </Actions>
              </>
            )}
          </div>
        ) : mode === 'reset' ? (
          <div className="w-full max-w-sm">
            <h1 id="signin-title" tabIndex={-1}>
              Choose a new password
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              Setting it here signs out every other session on this account. The
              authenticator app stays as it is.
            </p>

            <form onSubmit={(event) => void submitNewPassword(event)}>
              <Field>
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                  minLength={8}
                />
                <Hint>At least 8 characters.</Hint>
              </Field>
              <Field>
                <label htmlFor="new-password-confirmation">Repeat the password</label>
                <input
                  id="new-password-confirmation"
                  name="password-confirmation"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </Field>

              {error !== null && <FormError>{error}</FormError>}

              <Actions className="flex-col items-stretch gap-3">
                <Button type="submit" disabled={pending} className="w-full">
                  {pending ? 'Saving…' : 'Set the password'}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    switchMode('sign-in');
                  }}
                >
                  Back to sign in
                </Button>
              </Actions>
            </form>
          </div>
        ) : (
          <div className="w-full max-w-sm">
            <h1 id="signin-title" tabIndex={-1}>
              {mode === 'sign-in' ? 'Sign in' : 'Create your account'}
            </h1>
            <p className="text-sm text-muted-foreground text-pretty">
              {mode === 'sign-in'
                ? 'Use the email your organisation was invited with.'
                : 'Create the account first; an organisation is chosen or created next.'}
            </p>
            {/* An expired link, or a password that has just changed: both
                are instructions for the very next thing the operator does,
                so they stay until acted on. */}
            {notice !== null && (
              <p className="mt-2 text-sm text-pretty" role="status">
                {notice}
              </p>
            )}

            <form onSubmit={(event) => void submit(event)}>
              {mode === 'sign-up' && (
                <Field>
                  <label htmlFor="signin-name">Full name</label>
                  <input
                    id="signin-name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    required
                    minLength={2}
                  />
                </Field>
              )}
              <Field>
                <label htmlFor="signin-email">Email</label>
                <input
                  id="signin-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                />
              </Field>
              <Field>
                <label htmlFor="signin-password">Password</label>
                <input
                  id="signin-password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === 'sign-up' ? 'new-password' : 'current-password'
                  }
                  required
                  minLength={8}
                />
              </Field>

              {error !== null && <FormError>{error}</FormError>}

              <Actions className="flex-col items-stretch gap-3">
                <Button type="submit" disabled={pending} className="w-full">
                  {pending
                    ? 'Working…'
                    : mode === 'sign-in'
                      ? 'Sign in'
                      : 'Create account'}
                </Button>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    switchMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                  }}
                >
                  {mode === 'sign-in'
                    ? 'New here? Create an account'
                    : 'Have an account? Sign in'}
                </Button>
                {mode === 'sign-in' && (
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => {
                      switchMode('forgot');
                    }}
                  >
                    Forgot your password?
                  </Button>
                )}
              </Actions>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
