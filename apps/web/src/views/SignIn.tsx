import { useRef, useState, type FormEvent } from 'react';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
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

/**
 * The sign-in surface, as the mock draws it (`app/sign-in/page` at
 * fdfe5ef): one card in a centred column, its title naming the step the
 * operator is on and its body holding only that step's fields. `App.tsx`
 * supplies the page around it — the product mark, the lede and the
 * background — so this component is the card and nothing else.
 *
 * The graphite marketing panel and its illustrative ledger board are gone
 * with the split screen. The mock puts no orientation copy on this page
 * and every figure on that board was invented; a sign-in screen carrying a
 * fictional work order is a screen that has to be explained.
 */
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

  /** The card's title, which is how the mock says which step is open. */
  const title = totpStep
    ? 'Two-factor check'
    : mode === 'forgot'
      ? notice === null
        ? 'Reset your password'
        : 'Check your email'
      : mode === 'reset'
        ? 'Choose a new password'
        : mode === 'sign-in'
          ? 'Sign in'
          : 'Create your account';

  return (
    <Card>
      <CardHeader>
        {/* The page's one h1, and the anchor `App.tsx` moves focus to. It
            takes the mock's `CardTitle` size rather than the document h1
            scale, because on this page the card title IS the heading. */}
        <h1 id="signin-title" tabIndex={-1} className="text-base font-semibold">
          {title}
        </h1>
      </CardHeader>

      {totpStep ? (
        <>
          <p className="m-0 text-sm text-muted-foreground text-pretty">
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
                minLength={6}
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
        </>
      ) : mode === 'forgot' ? (
        notice === null ? (
          <>
            <p className="m-0 text-sm text-muted-foreground text-pretty">
              We will email a link that lets you set a new password. Your authenticator
              app is not affected — signing in still asks for the code.
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
                  lost the authenticator, an owner has to reset the second factor for
                  you.
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
            {/* Not a FormNotice: this is the whole card after the request,
                and an instruction that expires after six seconds would
                leave the operator looking at a title with nothing under
                it. */}
            <p className="m-0 text-sm text-pretty" role="status">
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
        )
      ) : mode === 'reset' ? (
        <>
          <p className="m-0 text-sm text-muted-foreground text-pretty">
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
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-muted-foreground text-pretty">
            {mode === 'sign-in'
              ? 'Use the email your organisation was invited with.'
              : 'Create the account first; an organisation is chosen or created next.'}
          </p>
          {/* An expired link, or a password that has just changed: both are
              instructions for the very next thing the operator does, so they
              stay until acted on. */}
          {notice !== null && (
            <p className="mt-2 mb-0 text-sm text-pretty" role="status">
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
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
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
        </>
      )}
    </Card>
  );
}
