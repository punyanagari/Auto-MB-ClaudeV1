import { useEffect, useState, type FormEvent } from 'react';
import { toDataURL } from 'qrcode';
import { Check, Copy, Download, ShieldCheck } from 'lucide-react';
import {
  RequestFailedError,
  formValue,
  type ApiClient,
  type TwoFactorEnrolmentStart,
} from '../api.js';
import { Button } from '../ui/button.js';
import { Field, Actions, FormError, Hint } from '../ui/form.js';

interface TwoFactorEnrolmentProps {
  readonly api: ApiClient;
  /** Called once the operator has verified a code AND confirmed the backup
   * codes are stored — never earlier, because the codes are shown once. */
  readonly onEnrolled: () => void;
}

type Step =
  | { name: 'password' }
  | { name: 'verify'; start: TwoFactorEnrolmentStart }
  | { name: 'codes'; backupCodes: readonly string[] };

/** The manual-entry secret inside the otpauth URI, for operators whose
 * authenticator cannot scan the QR. */
function secretOf(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

/** Renders the otpauth URI as a QR image, client-side only — the secret
 * never travels anywhere but the enable response it arrived in. */
function TotpQr({ totpURI }: { readonly totpURI: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    toDataURL(totpURI, { margin: 1, width: 192 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        // The manual secret beside the QR remains the fallback path.
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [totpURI]);
  if (dataUrl === null) {
    return (
      <p className="text-sm text-muted-foreground">
        The QR image could not be drawn; enter the secret below manually.
      </p>
    );
  }
  return (
    <img
      src={dataUrl}
      alt="QR code for the authenticator app"
      className="size-48 rounded-md border border-border bg-white p-2"
    />
  );
}

/** TOTP enrolment: password re-confirmation, authenticator setup with a
 * verification code, then the backup codes exactly once with an explicit
 * stored-confirmation. Used both by the enrolment wall (required accounts)
 * and the account-security settings section. */
export function TwoFactorEnrolment({ api, onEnrolled }: TwoFactorEnrolmentProps) {
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = formValue(new FormData(event.currentTarget), 'password');
    setPending(true);
    setError(null);
    try {
      const start = await api.enableTwoFactor(password);
      setStep({ name: 'verify', start });
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'Enrolment could not be started. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.name !== 'verify') return;
    const code = formValue(new FormData(event.currentTarget), 'code').trim();
    setPending(true);
    setError(null);
    try {
      await api.verifyTotp(code);
      setStep({ name: 'codes', backupCodes: step.start.backupCodes });
    } catch (cause) {
      setError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The code could not be verified. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  function downloadCodes(backupCodes: readonly string[]) {
    const blob = new Blob(
      [
        'Auto-MB two-factor backup codes\n' +
          'Each code signs you in once if the authenticator is lost.\n\n' +
          backupCodes.join('\n') +
          '\n',
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'auto-mb-backup-codes.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (step.name === 'password') {
    return (
      <form onSubmit={(event) => void begin(event)}>
        <p className="text-sm text-muted-foreground text-pretty">
          Two-factor authentication asks for a 6-digit code from an authenticator app at
          every sign-in. Confirm your password to begin.
        </p>
        <Field>
          <label htmlFor="mfa-password">Password</label>
          <input
            id="mfa-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        {error !== null && <FormError>{error}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending}>
            {pending ? 'Preparing…' : 'Start enrolment'}
          </Button>
        </Actions>
      </form>
    );
  }

  if (step.name === 'verify') {
    const secret = secretOf(step.start.totpURI);
    return (
      <form onSubmit={(event) => void verify(event)}>
        <p className="text-sm text-muted-foreground text-pretty">
          Scan this QR code with an authenticator app (Google Authenticator, Aegis,
          1Password…), then enter the app&apos;s current 6-digit code.
        </p>
        <div className="my-4 flex flex-wrap items-start gap-4">
          <TotpQr totpURI={step.start.totpURI} />
          <div className="min-w-48 flex-1">
            <p className="mb-1 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Manual entry secret
            </p>
            <code className="block font-mono text-sm break-all select-all">
              {secret}
            </code>
            <Hint>
              For apps that cannot scan: add an account manually and paste this secret.
            </Hint>
          </div>
        </div>
        <Field>
          <label htmlFor="mfa-verify-code">Authenticator code</label>
          <input
            id="mfa-verify-code"
            name="code"
            type="text"
            className="max-w-40 font-mono tracking-[0.2em] tabular-nums"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            minLength={6}
            maxLength={6}
          />
        </Field>
        {error !== null && <FormError>{error}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending}>
            {pending ? 'Verifying…' : 'Verify code'}
          </Button>
        </Actions>
      </form>
    );
  }

  return (
    <div>
      <p className="flex items-center gap-2 text-sm font-medium text-success">
        <ShieldCheck className="size-4" aria-hidden="true" />
        Two-factor authentication is on for your account.
      </p>
      <p className="text-sm text-muted-foreground text-pretty">
        These backup codes are shown once and never again. Each signs you in one time if
        the authenticator is lost. Store them somewhere safe — a password manager or a
        printed copy in the office safe.
      </p>
      <ul className="my-3 grid max-w-sm list-none grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted/40 p-4 font-mono text-sm tabular-nums">
        {step.backupCodes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      {error !== null && <FormError>{error}</FormError>}
      <Actions>
        <Button
          variant="outline"
          onClick={() => {
            navigator.clipboard
              .writeText(step.backupCodes.join('\n'))
              .then(() => {
                setCopied(true);
              })
              .catch(() => {
                setError(
                  'Copying failed in this browser; use Download or write the codes down.',
                );
              });
          }}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            downloadCodes(step.backupCodes);
          }}
        >
          <Download className="size-4" aria-hidden="true" />
          Download codes
        </Button>
        <Button onClick={onEnrolled}>I have stored these codes</Button>
      </Actions>
    </div>
  );
}
