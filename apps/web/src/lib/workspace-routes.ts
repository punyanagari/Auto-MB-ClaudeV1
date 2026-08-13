import type { MastersTab } from '../views/Masters.js';
import type { WorkTab } from '../views/WorkDetail.js';

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
  /** The Delivery Challan module's own register: every movement, of all
   * three kinds. A work challan still opens through its Work
   * (`challan` above) — this is the way in for the two kinds that have
   * no Work to open through. */
  | { name: 'delivery-challans' }
  | { name: 'delivery-challan'; challanId: string }
  | { name: 'quotations' }
  | { name: 'approvals' }
  | { name: 'serials' }
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

/** Kept in sync with WorkDetail's WORK_TABS — the routes module owns the
 * parse so a stale tab name in a hash degrades to Overview instead of
 * crashing the restore. */
const WORK_TAB_NAMES = [
  'overview',
  'schedules',
  'deliveries',
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
    case 'delivery-challans':
      return '#/delivery-challans';
    case 'delivery-challan':
      return `#/delivery-challans/${view.challanId}`;
    case 'quotations':
      return '#/quotations';
    case 'approvals':
      return '#/approvals';
    case 'serials':
      return '#/serials';
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

export function mastersHash(tab?: MastersTab): string {
  return workspaceHashOf({
    view: { name: 'masters' },
    ...(tab === undefined ? {} : { mastersTab: tab }),
  });
}

/** `#/delivery-challans/<id>` as a plain href — a register row's link. */
export function deliveryChallanHash(challanId: string): string {
  return workspaceHashOf({ view: { name: 'delivery-challan', challanId } });
}

export const SETTINGS_HASH = '#/settings';

/** `#/search/<query>` as a plain href. */
export function searchHash(query: string): string {
  return workspaceHashOf({ view: { name: 'search', query } });
}

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
    case 'delivery-challans': {
      const [challanId, ...extra] = rest;
      if (challanId === undefined) return { view: { name: 'delivery-challans' } };
      if (!isRecordId(challanId) || extra.length > 0) return null;
      return { view: { name: 'delivery-challan', challanId } };
    }
    case 'quotations':
    case 'approvals':
    case 'serials':
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
  if (third === undefined && isWorkTab(second)) {
    return { view: { name: 'work', workId }, workTab: second };
  }
  return null;
}
