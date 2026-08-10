import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Organisation } from '@auto-mb/contracts';
import { Building2 } from 'lucide-react';
import { createApiClient, type ApiClient, type MeResponse } from './api.js';
import { Button } from './ui/button.js';
import { OperationsWorkspace } from './views/OperationsWorkspace.js';
import { OrgPicker } from './views/OrgPicker.js';
import { SignIn } from './views/SignIn.js';

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

  if (phase.name === 'workspace') {
    return (
      <OperationsWorkspace
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

  if (phase.name === 'signed-out') {
    return (
      <main ref={mainRef}>
        <SignIn api={api} onSignedIn={() => void refreshSession()} />
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
        {phase.name === 'pick-organisation' && (
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
                Checking your session and organisations.
              </p>
            </div>
          </div>
        )}
        {phase.name === 'pick-organisation' && (
          <OrgPicker
            api={api}
            onSelect={selectOrganisation}
            onCreated={(organisation) => {
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
