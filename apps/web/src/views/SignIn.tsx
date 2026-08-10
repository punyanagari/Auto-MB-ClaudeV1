import { useState, type FormEvent } from 'react';
import { RequestFailedError, formValue, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Field, Actions, FormError } from '../ui/form.js';

interface SignInProps {
  readonly api: ApiClient;
  readonly onSignedIn: () => void;
}

type Mode = 'sign-in' | 'sign-up';

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
    <Card
      className="mx-auto mt-[10vh] mb-8 max-w-[26rem]"
      aria-labelledby="signin-title"
    >
      <h1 id="signin-title" tabIndex={-1}>
        {mode === 'sign-in' ? 'Sign in' : 'Create your account'}
      </h1>
      <p className="text-muted-foreground">
        Post-award works execution: LOA to Delivery Challan with an honest quantity
        ledger.
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

        <Actions>
          <Button type="submit" disabled={pending}>
            {pending ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </Button>
          <Button
            variant="outline"
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
    </Card>
  );
}
