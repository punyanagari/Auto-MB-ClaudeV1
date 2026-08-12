import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { AlertTriangle, Building2 } from 'lucide-react';
import { createApiClient, type ApiClient, type MeResponse } from './api.js';
import { Button } from './ui/button.js';
import { OperationsWorkspace } from './views/OperationsWorkspace.js';
import { OrganisationOnboarding } from './views/OrganisationOnboarding.js';
import { OrgPicker } from './views/OrgPicker.js';
import { SignIn } from './views/SignIn.js';
import { TwoFactorEnrolment } from './views/TwoFactorEnrolment.js';

/** The active organisation is session navigation state, not authority.
 * PostgreSQL's membership floor and RLS still decide every scoped request.
 * sessionStorage keeps a page refresh inside the selected tenant but forces a
 * fresh choice after a new browser session or explicit sign-in. */
const ORGANISATION_SESSION_KEY = 'auto-mb.organisation-id';

type Phase =
  | { name: 'loading' }
  | { name: 'session-error'; message: string }
  | { name: 'signed-out' }
  | { name: 'mfa-enrolment'; me: MeResponse }
  | { name: 'no-organisation'; me: MeResponse }
  | {
      name: 'pick-organisation';
      me: MeResponse;
      organisations: readonly Organisation[];
    }
  | {
      name: 'workspace';
      me: MeResponse;
      organisation: Organisation;
      organisations: readonly Organisation[];
    };

function storedOrganisationId(): string | null {
  try {
    return sessionStorage.getItem(ORGANISATION_SESSION_KEY);
  } catch {
    return null;
  }
}

function rememberOrganisation(id: string): void {
  try {
    sessionStorage.setItem(ORGANISATION_SESSION_KEY, id);
  } catch {
    // Storage is only a navigation convenience. The selected Organisation is
    // still held in React state and every request is authorised server-side.
  }
}

function forgetOrganisation(): void {
  try {
    sessionStorage.removeItem(ORGANISATION_SESSION_KEY);
  } catch {
    // Nothing security-sensitive is stored here.
  }
}

/** listOrganisations is already membership-filtered by the server. The extra
 * intersection makes the UI fail closed if a stale client response ever
 * contains an Organisation whose active membership is absent from /api/me. */
function activeOrganisations(
  me: MeResponse,
  organisations: readonly Organisation[],
): readonly Organisation[] {
  const activeIds = new Set(
    me.memberships
      .filter((membership) => membership.status === 'active')
      .map((membership) => membership.organisationId),
  );
  return organisations.filter((organisation) => activeIds.has(organisation.id));
}

interface AppProps {
  readonly api?: ApiClient;
}

interface RefreshSessionOptions {
  readonly forceOrganisationChoice?: boolean;
  readonly preferredOrganisationId?: string | null;
}

export function App({ api: providedApi }: AppProps) {
  const api = useMemo(() => providedApi ?? createApiClient(), [providedApi]);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const mainRef = useRef<HTMLElement>(null);
  const sessionRefreshIdRef = useRef(0);

  const loadSession = useCallback(
    async ({
      forceOrganisationChoice = false,
      preferredOrganisationId = null,
    }: RefreshSessionOptions = {}): Promise<Phase> => {
      const me = await api.me();
      if (me === null) {
        return { name: 'signed-out' };
      }

      // Finding 36: an account holding document authority must enrol in
      // two-factor authentication before any workspace opens. The server
      // refuses tenant requests anyway; this renders the enrolment wall
      // instead of a wall of 403s. Only while the server is enforcing —
      // while the policy deploys dark, the workspace stays usable.
      if (me.mfaRequired && !me.twoFactorEnabled && me.mfaEnforced) {
        return { name: 'mfa-enrolment', me };
      }

      const organisations = activeOrganisations(me, await api.listOrganisations());
      if (organisations.length === 0) {
        return { name: 'no-organisation', me };
      }

      if (organisations.length === 1) {
        const [organisation] = organisations;
        if (organisation === undefined) throw new Error('Organisation list invariant');
        return { name: 'workspace', me, organisation, organisations };
      }

      const rememberedId = preferredOrganisationId ?? storedOrganisationId();
      const remembered = organisations.find(
        (organisation) => organisation.id === rememberedId,
      );
      if (!forceOrganisationChoice && remembered !== undefined) {
        return { name: 'workspace', me, organisation: remembered, organisations };
      }

      return { name: 'pick-organisation', me, organisations };
    },
    [api],
  );

  const refreshSession = useCallback(
    async (options: RefreshSessionOptions = {}) => {
      const refreshId = ++sessionRefreshIdRef.current;
      try {
        const nextPhase = await loadSession(options);
        if (refreshId !== sessionRefreshIdRef.current) return;
        if (nextPhase.name === 'workspace') {
          rememberOrganisation(nextPhase.organisation.id);
        } else {
          forgetOrganisation();
        }
        setPhase(nextPhase);
      } catch (cause: unknown) {
        if (refreshId !== sessionRefreshIdRef.current) return;
        setPhase({
          name: 'session-error',
          message:
            cause instanceof Error
              ? cause.message
              : 'Auto-MB could not check your session. Try again.',
        });
      }
    },
    [loadSession],
  );

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    mainRef.current?.querySelector('h1')?.focus();
  }, [phase.name]);

  function selectOrganisation(organisation: Organisation): void {
    sessionRefreshIdRef.current += 1;
    rememberOrganisation(organisation.id);
    setPhase((current) =>
      current.name === 'pick-organisation'
        ? {
            name: 'workspace',
            me: current.me,
            organisation,
            organisations: current.organisations,
          }
        : current,
    );
  }

  async function signOut(): Promise<void> {
    sessionRefreshIdRef.current += 1;
    try {
      await api.signOut();
    } finally {
      forgetOrganisation();
      setPhase({ name: 'signed-out' });
    }
  }

  if (phase.name === 'workspace') {
    return (
      <OperationsWorkspace
        api={api}
        me={phase.me}
        organisation={phase.organisation}
        organisations={phase.organisations}
        onSwitchOrganisation={() => {
          sessionRefreshIdRef.current += 1;
          forgetOrganisation();
          setPhase({
            name: 'pick-organisation',
            me: phase.me,
            organisations: phase.organisations,
          });
        }}
        onOrganisationCreated={(organisation) => {
          void refreshSession({ preferredOrganisationId: organisation.id });
        }}
        onSignOut={() => void signOut()}
      />
    );
  }

  if (phase.name === 'signed-out') {
    return (
      <main ref={mainRef}>
        <SignIn
          api={api}
          onSignedIn={() => void refreshSession({ forceOrganisationChoice: true })}
        />
      </main>
    );
  }

  if (phase.name === 'session-error') {
    return (
      <main
        ref={mainRef}
        className="grid min-h-screen place-items-center bg-background p-6"
      >
        <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm">
          <span className="mb-4 inline-flex size-11 items-center justify-center rounded-xl bg-warning/15 text-warning-foreground">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </span>
          <h1 tabIndex={-1}>Workspace temporarily unavailable</h1>
          <p className="text-sm text-muted-foreground">{phase.message}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={() => void refreshSession()}>Try again</Button>
            <Button
              variant="outline"
              onClick={() => {
                sessionRefreshIdRef.current += 1;
                forgetOrganisation();
                setPhase({ name: 'signed-out' });
              }}
            >
              Return to sign in
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex h-[4.5rem] items-center justify-between gap-4 border-b border-border bg-card px-4 sm:px-7 print:hidden">
        <span className="flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <span>
            <strong className="block text-base tracking-tight">Auto-MB</strong>
            <span className="block text-[11px] text-muted-foreground">
              Contract operations
            </span>
          </span>
        </span>
        {(phase.name === 'pick-organisation' ||
          phase.name === 'no-organisation' ||
          phase.name === 'mfa-enrolment') && (
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden max-w-64 truncate text-xs text-muted-foreground sm:inline">
              {phase.me.user.email}
            </span>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </header>

      <main ref={mainRef}>
        {phase.name === 'loading' && (
          <div className="grid min-h-[calc(100vh-4.5rem)] place-items-center p-8">
            <div className="text-center" role="status">
              <span className="mx-auto mb-4 block size-10 animate-pulse rounded-2xl bg-primary/15" />
              <p className="font-medium">Opening your workspace…</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Checking your session and organisation access.
              </p>
            </div>
          </div>
        )}
        {phase.name === 'pick-organisation' && (
          <OrgPicker
            organisations={phase.organisations}
            memberships={phase.me.memberships}
            onSelect={selectOrganisation}
          />
        )}
        {phase.name === 'no-organisation' && (
          <OrganisationOnboarding api={api} onCreated={() => void refreshSession()} />
        )}
        {phase.name === 'mfa-enrolment' && (
          <div className="mx-auto mt-[8vh] mb-8 w-full max-w-[30rem] px-4">
            <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
              <h1 tabIndex={-1}>Two-factor authentication required</h1>
              <p className="text-sm text-muted-foreground text-pretty">
                Your account can issue, cancel, or approve legal documents, so it must
                be protected by an authenticator app before the workspace opens.
              </p>
              <TwoFactorEnrolment
                api={api}
                onEnrolled={() =>
                  void refreshSession({ forceOrganisationChoice: true })
                }
              />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
