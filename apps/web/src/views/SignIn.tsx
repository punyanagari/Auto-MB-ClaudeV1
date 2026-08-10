import { useState, type FormEvent } from 'react';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Field, Actions, FormError } from '../ui/form.js';

interface SignInProps {
  readonly api: ApiClient;
  readonly onSignedIn: () => void;
}

type Mode = 'sign-in' | 'sign-up';

/** What the product does, in the order a contractor does it. Kept to four
 * because the panel is an orientation, not a feature list. */
const STAGES = [
  {
    title: 'Read the letter',
    body: 'Upload the LOA. The parser proposes header, schedules, items and rates; nothing becomes a contract record until a human confirms it.',
  },
  {
    title: 'Issue the challan',
    body: 'Every Delivery Challan draws on awarded quantities, carries its consignee, and takes a number it keeps forever.',
  },
  {
    title: 'Measure and bill',
    body: 'Stage-wise Measurement Books finalise against the payment matrix, and bills are prepared from what was actually measured.',
  },
  {
    title: 'Answer for it',
    body: 'Awarded, delivered, installed and remaining, per item — with the evidence trail behind each number.',
  },
] as const;

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
      className="rounded-lg border border-sidebar-border bg-sidebar-accent p-4 font-mono text-[11px] select-none sm:p-5 sm:text-xs"
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
  const [mode, setMode] = useState<Mode>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = formValue(data, 'email');
    const password = formValue(data, 'password');
    const name = formValue(data, 'name');

    setPending(true);
    setError(null);
    try {
      if (mode === 'sign-up') {
        await api.signUp(email, name, password);
      } else {
        await api.signIn(email, password);
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
          <p className="mb-3 text-[11px] font-semibold tracking-[0.18em] text-sidebar-primary uppercase">
            Post-award works execution
          </p>
          {/* Deliberately not a heading: the page's one h1 belongs to the form,
              and a second heading above it would put the document out of order. */}
          <p className="text-2xl leading-snug font-semibold tracking-tight text-balance sm:text-3xl">
            From the Letter of Acceptance to an honest quantity ledger.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-sidebar-faint text-pretty">
            Built for Indian government works contracts — Railways first. Every issued
            document keeps its number for good, and every number on screen can be traced
            back to the evidence that produced it.
          </p>
        </div>

        <div className="hidden max-w-xl lg:block">
          <LedgerBoard />
        </div>

        <ul className="hidden max-w-xl list-none flex-col gap-4 p-0 lg:flex">
          {STAGES.map((stage, index) => (
            <li key={stage.title} className="flex gap-3">
              <span
                className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-sidebar-border font-mono text-[10px] font-semibold text-sidebar-primary tabular-nums"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span>
                <span className="text-sm font-semibold">{stage.title}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-sidebar-faint text-pretty">
                  {stage.body}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Paper, and the only thing on it is the form. */}
      <section className="flex items-center justify-center bg-background px-6 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <h1 id="signin-title" tabIndex={-1}>
            {mode === 'sign-in' ? 'Sign in' : 'Create your account'}
          </h1>
          <p className="text-sm text-muted-foreground text-pretty">
            {mode === 'sign-in'
              ? 'Use the email your organisation was invited with.'
              : 'Create the account first; an organisation is chosen or created next.'}
          </p>

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
                  setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                  setError(null);
                }}
              >
                {mode === 'sign-in'
                  ? 'New here? Create an account'
                  : 'Have an account? Sign in'}
              </Button>
            </Actions>
          </form>
        </div>
      </section>
    </div>
  );
}
