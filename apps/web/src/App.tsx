import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { AlertTriangle, FileCheck2, WifiOff } from 'lucide-react';
import { createApiClient, type ApiClient, type MeResponse } from './api.js';
import { useDocumentTitle } from './lib/document-title.js';
import {
  bindOfflineCache,
  isOffline,
  useOnline,
  withOfflineReads,
} from './lib/offline.js';
import { cn } from './lib/cn.js';
import { Button } from './ui/button.js';
import { Card, CardHeader } from './ui/card.js';
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
  /** No network at all, before any workspace exists. Its own phase and
   * not a `session-error`, because the two need opposite words: an
   * outage is the product's problem and this one is the operator's
   * connection, and the way out of it is to reconnect rather than to
   * retry into the same silence. `docs/UX.md` § 23 records why a cold
   * start offline stops here instead of restoring a workspace. */
  | { name: 'offline' }
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

/** What the tab is called before a workspace exists. `workspace` returns
 * null because `OperationsWorkspace` names the tab after the open view; two
 * writers would race on effect order. */
function phaseTitle(phase: Phase): string | null {
  switch (phase.name) {
    case 'loading':
      return 'Opening your workspace';
    case 'session-error':
      return 'Workspace unavailable';
    case 'offline':
      return 'Offline';
    case 'signed-out':
      return 'Sign in';
    case 'mfa-enrolment':
      return 'Two-factor authentication';
    case 'no-organisation':
      return 'Create your organisation';
    case 'pick-organisation':
      return 'Select an organisation';
    case 'workspace':
      return null;
  }
}

/**
 * The frame every screen outside a workspace shares.
 *
 * The mock draws these pages (`app/sign-in/page`, `app/onboarding/page` at
 * fdfe5ef) as one centred column on a full-height background: the product
 * mark and its lede, then the screen's own surface, then a quiet line
 * underneath. There is no chrome bar on any of them, which is why the
 * 4.5rem product header this build carried is gone — its only live control,
 * signing out, is the footer line here.
 *
 * The mark's caption is deliberately a paragraph and not a heading. This
 * shell moves focus to the first `h1` inside `main` whenever the phase
 * changes, and a brand line above every screen would swallow that anchor.
 */
function AuthPage({
  width,
  description,
  footer,
  children,
}: {
  /** The column's width, per screen: the mock's sign-in is `max-w-sm` and
   * its onboarding `max-w-lg`. */
  readonly width: string;
  readonly description: string;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn('flex w-full flex-col gap-6', width)}>
      <div className="text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <FileCheck2 className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-3 text-xl font-semibold">Auto-MB</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
      {footer}
    </div>
  );
}

interface AppProps {
  readonly api?: ApiClient;
}

interface RefreshSessionOptions {
  readonly forceOrganisationChoice?: boolean;
  readonly preferredOrganisationId?: string | null;
}

export function App({ api: providedApi }: AppProps) {
  /* The offline read cache wraps whatever client is in play, including
   * the one a test supplies: it is a property of how this application
   * reads, not of how the client fetches. It is inert until bound below,
   * and inert while the browser has a connection. */
  const api = useMemo(
    () => withOfflineReads(providedApi ?? createApiClient()),
    [providedApi],
  );
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const online = useOnline();
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
        // No network is not an outage, and saying "temporarily
        // unavailable" about the operator's own connection sends them
        // to support for something a signal bar would explain.
        if (isOffline()) {
          setPhase({ name: 'offline' });
          return;
        }
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

  /* The connection coming back is the answer to the offline phase, so the
   * session is checked again the moment it does rather than waiting for
   * the operator to find the button. Only from that phase: a workspace
   * already open re-reads through its own screens. */
  useEffect(() => {
    if (online && phase.name === 'offline') void refreshSession();
  }, [online, phase.name, refreshSession]);

  /**
   * Binds the offline read cache to the account and organisation whose
   * records it is allowed to hold, and clears it whenever that changes.
   *
   * This is the whole eviction story, and it is one effect because every
   * departure ends here: signing out, switching organisation, being sent
   * back to the chooser, losing the session. Each of them leaves the
   * workspace phase, which binds null, which empties the cache.
   * `bindOfflineCache` ignores a repeat of the same binding, so this may
   * sit on a phase object that is replaced on every state change.
   */
  useEffect(() => {
    bindOfflineCache(
      phase.name === 'workspace'
        ? { userId: phase.me.user.id, organisationId: phase.organisation.id }
        : null,
    );
  }, [phase]);

  useEffect(() => {
    mainRef.current?.querySelector('h1')?.focus();
  }, [phase.name]);

  const title = phaseTitle(phase);
  useDocumentTitle(title === null ? null : [title]);

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
    } catch {
      /* Swallowed on purpose, and it is not a formality: offline, this
       * call is REFUSED before it is sent (`src/api.ts`), so signing out
       * with no connection would otherwise reject on every attempt. The
       * local half has to happen either way — this browser throws away
       * the workspace it was showing and the records it had cached — and
       * leaving an operator looking at somebody else's screen because
       * the server could not be told is the worse failure. The server
       * session outlives it and ends on its own; nothing here could
       * shorten that without reaching the server. */
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

  /* The mock's quiet footer line under the card, carrying the one control
     the retired header held. An account that has reached a chooser, an
     onboarding form or the enrolment wall is signed in, so the way back
     out has to stay on screen. */
  const signOutFooter =
    phase.name === 'pick-organisation' ||
    phase.name === 'no-organisation' ||
    phase.name === 'mfa-enrolment' ? (
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="max-w-64 truncate">{phase.me.user.email}</span>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    ) : undefined;

  return (
    <main
      ref={mainRef}
      className="flex min-h-svh items-center justify-center bg-background px-4 py-10"
    >
      {phase.name === 'signed-out' && (
        <AuthPage
          width="max-w-sm"
          description="Secure access to railway contract operations."
        >
          <SignIn
            api={api}
            onSignedIn={() => void refreshSession({ forceOrganisationChoice: true })}
          />
        </AuthPage>
      )}

      {phase.name === 'loading' && (
        <AuthPage
          width="max-w-sm"
          description="Checking your session and organisation access."
        >
          <Card className="text-center" role="status">
            <span className="mx-auto mb-3 block size-10 animate-pulse rounded-xl bg-primary/15" />
            <p className="m-0 text-sm font-medium">Opening your workspace…</p>
          </Card>
        </AuthPage>
      )}

      {phase.name === 'session-error' && (
        <AuthPage
          width="max-w-lg"
          description="Your session could not be read just now."
        >
          <Card>
            <CardHeader>
              <h1 tabIndex={-1} className="text-base font-semibold">
                Workspace temporarily unavailable
              </h1>
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-foreground">
                <AlertTriangle className="size-4" aria-hidden="true" />
              </span>
            </CardHeader>
            <p className="m-0 text-sm text-muted-foreground">{phase.message}</p>
            <div className="mt-4 flex flex-wrap gap-2">
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
          </Card>
        </AuthPage>
      )}

      {phase.name === 'offline' && (
        <AuthPage
          width="max-w-lg"
          description="This device has no connection just now."
        >
          <Card>
            <CardHeader>
              <h1 tabIndex={-1} className="text-base font-semibold">
                You are offline
              </h1>
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-foreground">
                <WifiOff className="size-4" aria-hidden="true" />
              </span>
            </CardHeader>
            {/* Two facts and no false promise. The application itself
                opened from the cached shell, which is why there is a page
                here at all; what it cannot do is check who is signed in,
                and it will not guess. `docs/UX.md` § 23. */}
            <p className="m-0 text-sm text-muted-foreground text-pretty">
              Auto-MB opened from the copy saved on this device, but it cannot check
              your session or read any records without a connection. Your work is on the
              server and nothing has been lost.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => void refreshSession()}>Try again</Button>
            </div>
          </Card>
        </AuthPage>
      )}

      {phase.name === 'pick-organisation' && (
        <AuthPage
          width="max-w-lg"
          description="Secure access to railway contract operations."
          footer={signOutFooter}
        >
          <OrgPicker
            organisations={phase.organisations}
            memberships={phase.me.memberships}
            onSelect={selectOrganisation}
          />
        </AuthPage>
      )}

      {phase.name === 'no-organisation' && (
        <AuthPage
          width="max-w-lg"
          description="Set the legal identity used across statutory documents."
          footer={signOutFooter}
        >
          <OrganisationOnboarding api={api} onCreated={() => void refreshSession()} />
        </AuthPage>
      )}

      {phase.name === 'mfa-enrolment' && (
        <AuthPage
          width="max-w-lg"
          description="Secure access to railway contract operations."
          footer={signOutFooter}
        >
          <Card>
            <CardHeader>
              <h1 tabIndex={-1} className="text-base font-semibold">
                Two-factor authentication required
              </h1>
            </CardHeader>
            <p className="m-0 text-sm text-muted-foreground text-pretty">
              Your account can issue, cancel, or approve legal documents, so it must be
              protected by an authenticator app before the workspace opens.
            </p>
            <TwoFactorEnrolment
              api={api}
              onEnrolled={() => void refreshSession({ forceOrganisationChoice: true })}
            />
          </Card>
        </AuthPage>
      )}
    </main>
  );
}
