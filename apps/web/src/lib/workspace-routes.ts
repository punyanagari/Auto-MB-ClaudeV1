import type { MastersTab } from '../views/Masters.js';
import type { WorkTab } from '../views/WorkDetail.js';

/** Which of the merged Challans module's two registers is showing. The
 * mock addresses them as `?type=delivery` and `?type=installation`
 * (`components/challans-workspace` at `a8e1fde`); this build keeps its
 * hash-serialised navigation, so the same two words ride as a path
 * segment instead of a query parameter. */
export type ChallanRegisterTab = 'delivery' | 'installation';

/** The workspace's whole navigation state as a discriminated union. It
 * lives here rather than in OperationsWorkspace so the hash serializer
 * and any view that wants to render a real link can name a destination
 * without importing the workspace shell. */
export type WorkspaceView =
  | { name: 'dashboard' }
  | { name: 'works' }
  | { name: 'upload' }
  | { name: 'review'; documentId: string }
  | { name: 'work'; workId: string }
  | { name: 'challan-new'; workId: string; workCode: string }
  | { name: 'challan-edit'; workId: string; workCode: string; challanId: string }
  | { name: 'challan'; workId: string; workCode: string; challanId: string }
  | { name: 'masters' }
  | { name: 'issue-challan-new'; workId: string }
  | { name: 'issue-challan-edit'; workId: string; challanId: string }
  | { name: 'issue-challan'; workId: string; challanId: string }
  /** The Challans module: one register with two tabs, delivery and
   * issue, exactly as the mock draws it. Every movement of all three
   * delivery kinds on one tab, the Work's issue challans on the other. A
   * work challan still opens through its Work (`challan` above) — this
   * is the way in for the two kinds that have no Work to open through.
   *
   * `workId` is the mock's `?work=` deep link: present, the register
   * reads one Work and says so with a dismissible chip; absent, it reads
   * across every Work the caller may see. */
  | { name: 'challans'; tab: ChallanRegisterTab; workId: string | null }
  | { name: 'delivery-challan'; challanId: string }
  | { name: 'quotations' }
  | { name: 'approvals' }
  | { name: 'serials' }
  /** The installation module's own register: every recorded installation
   * across the Works the caller may see. A record still opens through its
   * Work (`work` above, Installations tab) — this is the way in when the
   * question is about a date or a location rather than a contract. */
  | { name: 'installations' }
  /** The tax-invoice module's own register: every invoice the caller may
   * see, work-backed and direct alike. A DIRECT invoice — raised against
   * a private customer, so belonging to no Work — has no Work to open
   * through, which is why the opened invoice is a route of its own here
   * rather than only a section of a Work. */
  | { name: 'invoices' }
  | { name: 'invoice'; invoiceId: string }
  /** Tenant-wide record search. The query is part of the route, so a
   * result set can be linked, bookmarked and reached by Back — the same
   * durability finding 28 gave every other view. */
  | { name: 'search'; query: string }
  | { name: 'members' }
  | { name: 'settings' };

/** A parsed location: the view plus the tab state some views carry
 * alongside it (the Work page's section, the Masters category). */
export interface WorkspaceRoute {
  readonly view: WorkspaceView;
  readonly workTab?: WorkTab;
  readonly mastersTab?: MastersTab;
}

/** Kept in sync with WorkDetail's `WORK_TABS`, and held to it by
 * `apps/web/test/workspace-routes.test.ts`, which imports both lists and
 * asserts they are the same set. The duplication is deliberate — the
 * parser must not import a view — but a duplicate that nothing checks is
 * a drift waiting to happen, and the drift is silent: a tab added to the
 * page and not to this list is simply unreachable by URL.
 *
 * A stale tab name in an otherwise well-formed Work fragment degrades to
 * that Work's Overview rather than to the Dashboard: the id in the hash is
 * the durable half of the address, and a renamed section is no reason to
 * throw away the Work the operator asked for. */
export const WORK_TAB_NAMES = [
  'overview',
  'schedules',
  'deliveries',
  'installations',
  'procurement',
  'issues',
  'measurement',
  'bills',
  'instruments',
  'amendments',
  'timeline',
] as const;

const MASTERS_TAB_NAMES = [
  'contacts',
  'locations',
  'units',
  'signatories',
  'gst-rates',
] as const;

function isWorkTab(value: string): value is WorkTab {
  return (WORK_TAB_NAMES as readonly string[]).includes(value);
}

function isMastersTab(value: string): value is MastersTab {
  return (MASTERS_TAB_NAMES as readonly string[]).includes(value);
}

function isChallanRegisterTab(value: string): value is ChallanRegisterTab {
  return value === 'delivery' || value === 'installation';
}

/** Path segments that can never be record ids. `upload` shares the
 * `/works/…` prefix, so a Work id must not look like it. */
const RESERVED_WORK_SEGMENTS = new Set(['upload', 'new']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecordId(value: string): boolean {
  return UUID_PATTERN.test(value) && !RESERVED_WORK_SEGMENTS.has(value);
}

/** The canonical fragment for a route, always beginning `#/`. */
export function workspaceHashOf(route: WorkspaceRoute): string {
  const { view } = route;
  switch (view.name) {
    case 'dashboard':
      return '#/';
    case 'works':
      return '#/works';
    case 'upload':
      return '#/works/upload';
    case 'review':
      return `#/loa/${view.documentId}`;
    case 'work': {
      const tab = route.workTab ?? 'overview';
      return tab === 'overview'
        ? `#/works/${view.workId}`
        : `#/works/${view.workId}/${tab}`;
    }
    case 'challan-new':
      return `#/works/${view.workId}/challans/new`;
    case 'challan':
      return `#/works/${view.workId}/challans/${view.challanId}`;
    case 'challan-edit':
      return `#/works/${view.workId}/challans/${view.challanId}/edit`;
    case 'issue-challan-new':
      return `#/works/${view.workId}/issue-challans/new`;
    case 'issue-challan':
      return `#/works/${view.workId}/issue-challans/${view.challanId}`;
    case 'issue-challan-edit':
      return `#/works/${view.workId}/issue-challans/${view.challanId}/edit`;
    case 'masters': {
      const tab = route.mastersTab ?? 'contacts';
      return tab === 'contacts' ? '#/masters' : `#/masters/${tab}`;
    }
    case 'challans': {
      if (view.workId !== null) return `#/challans/${view.tab}/${view.workId}`;
      // Delivery is the tab the module opens on, so the plain address is
      // the plain register — the same shape `?type=` gives the mock.
      return view.tab === 'delivery' ? '#/challans' : `#/challans/${view.tab}`;
    }
    case 'delivery-challan':
      return `#/delivery-challans/${view.challanId}`;
    case 'quotations':
      return '#/quotations';
    case 'approvals':
      return '#/approvals';
    case 'serials':
      return '#/serials';
    case 'installations':
      return '#/installations';
    case 'invoices':
      return '#/invoices';
    case 'invoice':
      return `#/invoices/${view.invoiceId}`;
    case 'search':
      // encodeURIComponent escapes '/' as %2F, and the parser splits the
      // raw fragment before decoding, so a query containing a slash stays
      // one segment and round-trips.
      return view.query === ''
        ? '#/search'
        : `#/search/${encodeURIComponent(view.query)}`;
    case 'members':
      return '#/members';
    case 'settings':
      return '#/settings';
  }
}

/** `#/works/<id>` (or a section of it) as a plain href — what a register
 * row or a blocked-action message links to. */
export function workHash(workId: string, tab?: WorkTab): string {
  return workspaceHashOf({
    view: { name: 'work', workId },
    ...(tab === undefined ? {} : { workTab: tab }),
  });
}

export function challanHash(workId: string, challanId: string): string {
  return workspaceHashOf({
    view: { name: 'challan', workId, workCode: '', challanId },
  });
}

export function issueChallanHash(workId: string, challanId: string): string {
  return workspaceHashOf({ view: { name: 'issue-challan', workId, challanId } });
}

/** The Challans register as a plain href: the module's own tab, and the
 * mock's `?work=` deep link where a Work is named. The chip's clear
 * control is the same helper with no Work — which is what makes
 * dismissing the filter a real link rather than a state reset. */
export function challansHash(
  tab: ChallanRegisterTab,
  workId: string | null = null,
): string {
  return workspaceHashOf({ view: { name: 'challans', tab, workId } });
}

export function mastersHash(tab?: MastersTab): string {
  return workspaceHashOf({
    view: { name: 'masters' },
    ...(tab === undefined ? {} : { mastersTab: tab }),
  });
}

export const SETTINGS_HASH = '#/settings';
export const SERIALS_HASH = '#/serials';
export const QUOTATIONS_HASH = '#/quotations';

/** Click handler for a real `<a href="#/…">`: a plain left click stays
 * in-app through the given handler (synchronous state navigation, and
 * the workspace's dirty-editor guard where the handler routes through
 * it); middle clicks and modifier clicks fall through to the browser so
 * open-in-new-tab works exactly as the href promises. */
export function navigateOnClick(handler: () => void) {
  return (event: {
    readonly defaultPrevented: boolean;
    readonly button: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    preventDefault: () => void;
  }): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    handler();
  };
}

/** Parses a location fragment back into a route. Returns null for
 * anything unknown — the caller falls back to the Dashboard rather than
 * guessing. An empty hash is the Dashboard by definition. */
export function parseWorkspaceHash(hash: string): WorkspaceRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw === '/') return { view: { name: 'dashboard' } };
  if (!raw.startsWith('/')) return null;
  const segments = raw
    .slice(1)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  const [head, ...rest] = segments;
  switch (head) {
    case undefined:
      return { view: { name: 'dashboard' } };
    case 'works':
      return parseWorksHash(rest);
    case 'loa': {
      const [documentId, ...extra] = rest;
      if (documentId === undefined || !isRecordId(documentId) || extra.length > 0) {
        return null;
      }
      return { view: { name: 'review', documentId } };
    }
    case 'masters': {
      const [tab, ...extra] = rest;
      if (extra.length > 0) return null;
      if (tab === undefined) return { view: { name: 'masters' } };
      return isMastersTab(tab) ? { view: { name: 'masters' }, mastersTab: tab } : null;
    }
    case 'search': {
      if (rest.length === 0) return { view: { name: 'search', query: '' } };
      // A single segment by construction (the serializer percent-encodes
      // any slash), but joining is the honest inverse of the split above
      // and keeps a hand-typed `#/search/a/b` meaningful instead of null.
      return { view: { name: 'search', query: rest.join('/') } };
    }
    case 'challans': {
      const [tab, workId, ...extra] = rest;
      if (extra.length > 0) return null;
      if (tab === undefined) {
        return { view: { name: 'challans', tab: 'delivery', workId: null } };
      }
      if (!isChallanRegisterTab(tab)) return null;
      if (workId === undefined) {
        return { view: { name: 'challans', tab, workId: null } };
      }
      if (!isRecordId(workId)) return null;
      return { view: { name: 'challans', tab, workId } };
    }
    case 'delivery-challans': {
      const [challanId, ...extra] = rest;
      // The register moved into the merged Challans module, so the
      // address it used to own redirects into it — the same thing the
      // mock's `/delivery-challans` route does. An OPENED standalone
      // challan keeps its own address: only the register moved, and a
      // link to a record should not lose the record.
      if (challanId === undefined) {
        return { view: { name: 'challans', tab: 'delivery', workId: null } };
      }
      if (!isRecordId(challanId) || extra.length > 0) return null;
      return { view: { name: 'delivery-challan', challanId } };
    }
    // The mock's other redirect (`app/issue-challans/page`). This
    // build never had a top-level issue-challan register, but the
    // address is the obvious guess and landing it on the tab it names
    // costs one line.
    case 'issue-challans':
      return rest.length === 0
        ? { view: { name: 'challans', tab: 'installation', workId: null } }
        : null;
    case 'invoices': {
      const [invoiceId, ...extra] = rest;
      if (invoiceId === undefined) return { view: { name: 'invoices' } };
      if (!isRecordId(invoiceId) || extra.length > 0) return null;
      return { view: { name: 'invoice', invoiceId } };
    }
    case 'quotations':
    case 'approvals':
    case 'serials':
    case 'installations':
    case 'members':
    case 'settings':
      return rest.length === 0 ? { view: { name: head } } : null;
    default:
      return null;
  }
}

function parseWorksHash(segments: readonly string[]): WorkspaceRoute | null {
  const [first, ...rest] = segments;
  if (first === undefined) return { view: { name: 'works' } };
  if (first === 'upload') {
    return rest.length === 0 ? { view: { name: 'upload' } } : null;
  }
  if (!isRecordId(first)) return null;
  const workId = first;
  const [second, third, fourth, ...extra] = rest;
  if (extra.length > 0) return null;
  if (second === undefined) return { view: { name: 'work', workId } };
  if (second === 'challans') {
    if (third === 'new' && fourth === undefined) {
      return { view: { name: 'challan-new', workId, workCode: '' } };
    }
    if (third !== undefined && isRecordId(third)) {
      if (fourth === undefined) {
        return { view: { name: 'challan', workId, workCode: '', challanId: third } };
      }
      if (fourth === 'edit') {
        return {
          view: { name: 'challan-edit', workId, workCode: '', challanId: third },
        };
      }
    }
    return null;
  }
  if (second === 'issue-challans') {
    if (third === 'new' && fourth === undefined) {
      return { view: { name: 'issue-challan-new', workId } };
    }
    if (third !== undefined && isRecordId(third)) {
      if (fourth === undefined) {
        return { view: { name: 'issue-challan', workId, challanId: third } };
      }
      if (fourth === 'edit') {
        return { view: { name: 'issue-challan-edit', workId, challanId: third } };
      }
    }
    return null;
  }
  if (third !== undefined) return null;
  // A known section, or the Work's Overview: see WORK_TAB_NAMES above for
  // why an unrecognised section keeps the Work instead of losing it.
  return isWorkTab(second)
    ? { view: { name: 'work', workId }, workTab: second }
    : { view: { name: 'work', workId } };
}
