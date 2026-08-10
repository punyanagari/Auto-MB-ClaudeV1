import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { createApiClient, type ApiClient, type MeResponse } from './api.js';
import { Button } from './ui/button.js';
import { OrgPicker } from './views/OrgPicker.js';
import { SignIn } from './views/SignIn.js';
import { Workspace } from './views/Workspace.js';

const ORGANISATION_STORAGE_KEY = 'auto-mb.organisation';

type Phase =
  | { name: 'loading' }
  | { name: 'signed-out' }
  | { name: 'pick-organisation'; me: MeResponse }
  | { name: 'workspace'; me: MeResponse; organisation: Organisation };

function storedOrganisation(): Organisation | null {
  try {
    const raw = localStorage.getItem(ORGANISATION_STORAGE_KEY);
    return raw === null ? null : (JSON.parse(raw) as Organisation);
  } catch {
    return null;
  }
}

interface AppProps {
  readonly api?: ApiClient;
}

export function App({ api: providedApi }: AppProps) {
  const api = useMemo(() => providedApi ?? createApiClient(), [providedApi]);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const mainRef = useRef<HTMLElement>(null);

  const refreshSession = useCallback(async () => {
    const me = await api.me();
    if (me === null) {
      setPhase({ name: 'signed-out' });
      return;
    }
    const remembered = storedOrganisation();
    const activeMembership =
      remembered !== null &&
      me.memberships.some(
        (membership) =>
          membership.organisationId === remembered.id && membership.status === 'active',
      );
    setPhase(
      activeMembership
        ? { name: 'workspace', me, organisation: remembered }
        : { name: 'pick-organisation', me },
    );
  }, [api]);

  useEffect(() => {
    refreshSession().catch(() => {
      setPhase({ name: 'signed-out' });
    });
  }, [refreshSession]);

  // Screen-reader and keyboard users land on the new view's heading.
  useEffect(() => {
    mainRef.current?.querySelector('h1')?.focus();
  }, [phase.name]);

  function selectOrganisation(organisation: Organisation) {
    localStorage.setItem(ORGANISATION_STORAGE_KEY, JSON.stringify(organisation));
    setPhase((current) =>
      current.name === 'pick-organisation' || current.name === 'workspace'
        ? { name: 'workspace', me: current.me, organisation }
        : current,
    );
  }

  async function signOut() {
    try {
      await api.signOut();
    } finally {
      localStorage.removeItem(ORGANISATION_STORAGE_KEY);
      setPhase({ name: 'signed-out' });
    }
  }

  // Signed in with an organisation bound: the Workspace owns the whole
  // frame (module sidebar plus topbar). Every other phase renders as a
  // calm centered page under a minimal brand bar.
  if (phase.name === 'workspace') {
    return (
      <Workspace
        api={api}
        me={phase.me}
        organisation={phase.organisation}
        onSwitchOrganisation={() => {
          setPhase({ name: 'pick-organisation', me: phase.me });
        }}
        onSignOut={() => void signOut()}
      />
    );
  }

  // Signed out, the sign-in page is the whole window: it carries the brand
  // itself, so a bar above it would say Auto-MB twice.
  if (phase.name === 'signed-out') {
    return (
      <main ref={mainRef}>
        <SignIn api={api} onSignedIn={() => void refreshSession()} />
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-3 print:hidden">
        <span className="font-semibold tracking-tight">Auto-MB</span>
        {phase.name === 'pick-organisation' && (
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-muted-foreground">{phase.me.user.email}</span>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </header>

      <main ref={mainRef}>
        {phase.name === 'loading' && (
          <p className="p-8 text-center text-muted-foreground" role="status">
            Loading…
          </p>
        )}
        {phase.name === 'pick-organisation' && (
          <OrgPicker
            api={api}
            onSelect={selectOrganisation}
            onCreated={(organisation) => {
              // The new membership must be in the session snapshot before
              // the workspace binds to the organisation.
              void refreshSession().then(() => {
                selectOrganisation(organisation);
              });
            }}
          />
        )}
      </main>
    </div>
  );
}
