import type { MastersTab } from '../views/Masters.js';
import type { WorkTab } from '../views/WorkDetail.js';

/** Which of the merged Challans module's two registers is showing. The
 * mock addresses them as `?type=delivery` and `?type=installation`
 * (`components/challans-workspace` at `a8e1fde`); this build keeps its
 * hash-serialised navigation, so the same two words ride as a path
 * segment instead of a query parameter. */
export type ChallanRegisterTab = 'delivery' | 'installation';

/** Which of the Payments workspace's two registers is showing. The mock
 * makes these local tab state (`components/payment-requests-workspace`
 * at `fdfe5ef`); they are addresses here for the same reason the Challan
 * registers are — a register worth opening is worth linking to, and a
 * tab strip that is really a nav gets the keyboard behaviour for free
 * instead of promising the tablist pattern and not implementing it. */
export type PaymentsRegisterTab = 'employee' | 'vendors';

/** The workspace's whole navigation state as a discriminated union. It
 * lives here rather than in OperationsWorkspace so the hash serializer
 * and any view that wants to render a real link can name a destination
 * without importing the workspace shell. */
export type WorkspaceView =
  | { name: 'dashboard' }
  | { name: 'works' }
  /** The LOA intake. `tenderId` is the award conversion's deep link: an
   * awarded tender sends the operator here, the screen shows the tender's
   * facts to check the letter against, and the uploaded letter is
   * recorded against that tender. Null is the ordinary intake, reached
   * from the sidebar. */
  | { name: 'upload'; tenderId: string | null }
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
  /** The payments workspace: employee advances and reimbursements, and
   * the vendor liability ledger. The mock's `/payments`
   * (`app/payments/page.tsx` at `fdfe5ef`), which its
   * `/payment-requests` route redirects to. */
  | { name: 'payments'; tab: PaymentsRegisterTab }
  /** The installation module's own register: every recorded installation
   * across the Works the caller may see. A record still opens through its
   * Work (`work` above, Installations tab) — this is the way in when the
   * question is about a date or a location rather than a contract.
   *
   * `workId` is the mock's `?work=` deep link (`components/document-register`
   * at fdfe5ef): present, the register reads one Work and says so with a
   * dismissible chip; absent, it reads across every Work in reach. */
  | { name: 'installations'; workId: string | null }
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
  /** The company document library: organisation-level credentials that
   * belong to no Work (migration 0079). One register, no record page —
   * a credential is its rows, and the versions live inside the row. */
  | { name: 'company-documents' }
  /** The Inspection workspace: RDSO and RITES calls across every Work the
   * caller reaches (migration 0082). One register, no record page — a call
   * is its card, and its documents live inside the card. */
  | { name: 'inspection' }
  /** The tender pipeline (migration 0083). Pre-award and organisation
   * level, so none of the three carries a Work: the register, the NIT
   * intake wizard, and one tender's bid workspace. */
  | { name: 'tenders' }
  /** OEM production. Three addresses, exactly as the mock draws three
   * screens: the job-card register, the item master, and one job card.
   *
   * `workId` on the register is the mock's `?work=` deep link, taken the
   * way every other cross-Work register takes it. */
  | { name: 'production'; workId: string | null }
  | { name: 'production-items' }
  | { name: 'production-job-card'; jobCardId: string }
  /** Maintenance (migration 0088). Three addresses, exactly as the mock
   * draws three screens: the register, the request form, and one job
   * card. Organisation level — a request names a Work, but the register
   * is read across every Work a store clerk serves. */
  | { name: 'maintenance' }
  | { name: 'maintenance-new' }
  | { name: 'maintenance-request'; requestId: string }
  | { name: 'tender-new' }
  | { name: 'tender'; tenderId: string }
  /** The railway receivables register: every prepared bill's position with
   * the railway, across every Work the caller may see. One register and no
   * record page — a bill opens in a sheet over the register, and recording
   * money against it stays on its Work's Bills tab, where the receipt form
   * and its withdrawal path already live. */
  | { name: 'receivables' }
  /** The correspondence register (migration 0086), and the two screens
   * that write into it. Organisation level: a letter may name a Work but
   * need not, so none of the three carries one in its address. */
  | { name: 'correspondence' }
  | { name: 'correspondence-new' }
  | { name: 'correspondence-inward' }
  /** The stock ledger (migration 0087). Organisation-level, so neither
   * carries a Work: the register and its movements, and the shortage
   * screen that turns an open job card's unmet bill of material into a
   * draft purchase order. Two addresses because the mock draws two
   * pages (`app/inventory/page.tsx` and
   * `app/inventory/purchase-orders/page.tsx` at fdfe5ef) with a link
   * each way, not one screen with a tab strip. */
  | { name: 'stock' }
  | { name: 'stock-shortages' }
  /** The signing queue (migration 0091, ADR-0012). Organisation-level:
   * one queue for every issued document waiting on the kiosk, because
   * the kiosk is one machine and the person watching it watches one
   * list. No mock screen — see docs/UX.md § 16. */
  | { name: 'signing' }
  /** Notifications (migration 0092). Organisation-level: which channels
   * the agency speaks through, what it may say, who agreed to be spoken
   * to, and what became of every message. Not per Work — nothing this
   * pack sends is about one. */
  | { name: 'notifications' }
  /** Bringing a register in from a spreadsheet (migration 0094).
   * Organisation-level, because the registers it fills are: a party
   * master and an item catalogue belong to the agency, not to a
   * contract. One address, and the batch it is looking at is state
   * inside the screen rather than a route — an import is a conversation
   * that lasts one sitting, not a record anybody links to. No mock
   * screen — see docs/UX.md § 18. */
  | { name: 'imports' }
  /** The employee master and the monthly payroll run (0089, 0090).
   * Organisation-level, and deliberately: a salary is paid by the agency
   * and not by a contract, so neither carries a Work.
   *
   * Two addresses because the mock draws two pages
   * (`app/employees/page.tsx` and `app/hr/payroll/page.tsx` at fdfd610).
   * The payroll one lives UNDER employees here rather than at the mock's
   * own `/hr/payroll`, because the mock's rail has no entry that reaches
   * it at all — see `docs/UX.md` § 15 — and hanging it off the register
   * gives it the one door the mock forgot without inventing a second
   * rail lamp for a module the mock lists once. */
  | { name: 'employees' }
  | { name: 'payroll' }
  | { name: 'members' }
  /** The organisation-wide audit register (0095). Not the per-Work
   * timeline, which stays a Work workspace section: this one is filtered
   * by actor and action across every module, and is gated on the audit
   * authority AND full work scope. */
  | { name: 'audit' }
  /** The management summary (0095): output tax by month, receivables
   * ageing, payroll cost. Separate from the landing dashboard on purpose
   * — see `packages/contracts/src/mis.ts` — because these are month-end
   * roll-ups nobody needs on every sign-in. */
  | { name: 'mis' }
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
  'inspection',
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

function isPaymentsRegisterTab(value: string): value is PaymentsRegisterTab {
  return value === 'employee' || value === 'vendors';
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
      return view.tenderId === null
        ? '#/works/upload'
        : `#/works/upload/${view.tenderId}`;
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
      // Items is the category the bare address opens, because it is the
      // first tab on the rail (the mock's order, `app/masters/page` at
      // fdfe5ef). Every other category, Contacts included, is its own
      // address.
      const tab = route.mastersTab ?? 'items';
      return tab === 'items' ? '#/masters' : `#/masters/${tab}`;
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
    case 'payments':
      return view.tab === 'employee' ? '#/payments' : `#/payments/${view.tab}`;
    case 'installations':
      return view.workId === null
        ? '#/installations'
        : `#/installations/${view.workId}`;
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
    case 'company-documents':
      return '#/company-documents';
    case 'inspection':
      return '#/inspection';
    case 'signing':
      return '#/signing';
    case 'notifications':
      return '#/notifications';
    case 'imports':
      return '#/imports';
    case 'stock':
      return '#/inventory';
    case 'stock-shortages':
      return '#/inventory/shortages';
    case 'employees':
      return '#/employees';
    case 'payroll':
      return '#/employees/payroll';
    case 'tenders':
      return '#/tenders';
    case 'production':
      return view.workId === null ? '#/production' : `#/production/work/${view.workId}`;
    case 'production-items':
      return '#/production/items';
    case 'production-job-card':
      return `#/production/${view.jobCardId}`;
    case 'maintenance':
      return '#/maintenance';
    case 'maintenance-new':
      return '#/maintenance/new';
    case 'maintenance-request':
      return `#/maintenance/${view.requestId}`;
    case 'tender-new':
      return '#/tenders/new';
    case 'tender':
      return `#/tenders/${view.tenderId}`;
    case 'receivables':
      return '#/receivables';
    case 'correspondence':
      return '#/correspondence';
    case 'correspondence-new':
      return '#/correspondence/new';
    case 'correspondence-inward':
      return '#/correspondence/new/inward';
    case 'members':
      return '#/members';
    case 'audit':
      return '#/audit';
    case 'mis':
      return '#/reports';
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

/** The Payments workspace as a plain href, one register per address. */
export function paymentsHash(tab: PaymentsRegisterTab = 'employee'): string {
  return workspaceHashOf({ view: { name: 'payments', tab } });
}

export function mastersHash(tab?: MastersTab): string {
  return workspaceHashOf({
    view: { name: 'masters' },
    ...(tab === undefined ? {} : { mastersTab: tab }),
  });
}

/** `#/tenders/<id>` as a plain href — what a register row links to. */
export function tenderHash(tenderId: string): string {
  return workspaceHashOf({ view: { name: 'tender', tenderId } });
}

/** The production register as a plain href, and the mock's `?work=` deep
 * link where a Work is named. The chip's clear control is the same
 * helper with no Work, which is what makes dismissing the filter a real
 * link rather than a state reset. */
export function productionHash(workId: string | null = null): string {
  return workspaceHashOf({ view: { name: 'production', workId } });
}

/** `#/production/<id>` — what a register row links to. */
export function productionJobCardHash(jobCardId: string): string {
  return workspaceHashOf({ view: { name: 'production-job-card', jobCardId } });
}

/** `#/maintenance/<id>` — what a maintenance register row links to. */
export function maintenanceRequestHash(requestId: string): string {
  return workspaceHashOf({ view: { name: 'maintenance-request', requestId } });
}

/** `#/inventory` and its shortage screen, as plain hrefs — what the link
 * between the two renders. Derived rather than spelled out, so they
 * cannot drift from the switch above. */
export const STOCK_REGISTER_HASH = workspaceHashOf({ view: { name: 'stock' } });
export const STOCK_SHORTAGES_HASH = workspaceHashOf({
  view: { name: 'stock-shortages' },
});

/** `#/employees` and the payroll workspace under it, as plain hrefs —
 * what the link between the two renders. */
export const EMPLOYEE_REGISTER_HASH = workspaceHashOf({ view: { name: 'employees' } });
export const PAYROLL_HASH = workspaceHashOf({ view: { name: 'payroll' } });

export const SETTINGS_HASH = '#/settings';
export const QUOTATIONS_HASH = '#/quotations';

/** `#/installations`, or the register narrowed to one Work. */
export function installationsHash(workId?: string): string {
  return workspaceHashOf({
    view: { name: 'installations', workId: workId ?? null },
  });
}

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
    case 'payments': {
      const [tab, ...extra] = rest;
      if (extra.length > 0) return null;
      // Employee is the register the module opens on, so the plain
      // address is the plain register — the same shape Challans uses.
      if (tab === undefined) {
        return { view: { name: 'payments', tab: 'employee' } };
      }
      if (!isPaymentsRegisterTab(tab)) return null;
      return { view: { name: 'payments', tab } };
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
    /* The retired standalone serial-lookup destination (`docs/UX.md`
       § `#/serials` merges into Global Search). Old links, bookmarks and
       anything still holding the fragment land on Search rather than on
       the Dashboard: the serial chain is still reachable, one scope in,
       so the honest answer to `#/serials` is the screen that now holds
       it. Serialising never produces this fragment again. */
    case 'serials':
      return rest.length === 0 ? { view: { name: 'search', query: '' } } : null;
    case 'installations': {
      const [workId, ...extra] = rest;
      if (workId === undefined) {
        return { view: { name: 'installations', workId: null } };
      }
      if (!isRecordId(workId) || extra.length > 0) return null;
      return { view: { name: 'installations', workId } };
    }
    case 'inventory': {
      const [first, ...extra] = rest;
      if (extra.length > 0) return null;
      if (first === undefined) return { view: { name: 'stock' } };
      // The mock's own second page is `/inventory/purchase-orders`; this
      // build calls it `shortages` because the orders it drafts are the
      // procurement module's and live under `#/works/…/procurement`,
      // while what this screen owns is the shortage.
      return first === 'shortages' || first === 'purchase-orders'
        ? { view: { name: 'stock-shortages' } }
        : null;
    }
    case 'employees': {
      const [first, ...extra] = rest;
      if (extra.length > 0) return null;
      if (first === undefined) return { view: { name: 'employees' } };
      return first === 'payroll' ? { view: { name: 'payroll' } } : null;
    }
    case 'tenders': {
      const [first, ...extra] = rest;
      if (extra.length > 0) return null;
      if (first === undefined) return { view: { name: 'tenders' } };
      if (first === 'new') return { view: { name: 'tender-new' } };
      return isRecordId(first) ? { view: { name: 'tender', tenderId: first } } : null;
    }
    case 'correspondence': {
      const [first, second, ...extra] = rest;
      if (extra.length > 0) return null;
      if (first === undefined) return { view: { name: 'correspondence' } };
      if (first !== 'new') return null;
      if (second === undefined) return { view: { name: 'correspondence-new' } };
      return second === 'inward' ? { view: { name: 'correspondence-inward' } } : null;
    }
    case 'production': {
      const [first, second, ...extra] = rest;
      if (first === undefined) return { view: { name: 'production', workId: null } };
      if (first === 'items') {
        return extra.length === 0 && second === undefined
          ? { view: { name: 'production-items' } }
          : null;
      }
      if (first === 'work') {
        return extra.length === 0 && second !== undefined && isRecordId(second)
          ? { view: { name: 'production', workId: second } }
          : null;
      }
      if (second !== undefined || extra.length > 0) return null;
      return isRecordId(first)
        ? { view: { name: 'production-job-card', jobCardId: first } }
        : null;
    }
    case 'maintenance': {
      const [first, ...extra] = rest;
      if (extra.length > 0) return null;
      if (first === undefined) return { view: { name: 'maintenance' } };
      if (first === 'new') return { view: { name: 'maintenance-new' } };
      return isRecordId(first)
        ? { view: { name: 'maintenance-request', requestId: first } }
        : null;
    }
    case 'quotations':
    case 'approvals':
    case 'company-documents':
    case 'inspection':
    case 'receivables':
    case 'signing':
    case 'notifications':
    case 'imports':
    case 'members':
    case 'audit':
    case 'settings':
      return rest.length === 0 ? { view: { name: head } } : null;
    // The management summary answers to `#/reports`, which is what an
    // operator would type and what the rail calls it. `mis` is the
    // internal name and never appears in an address.
    case 'reports':
      return rest.length === 0 ? { view: { name: 'mis' } } : null;
    default:
      return null;
  }
}

function parseWorksHash(segments: readonly string[]): WorkspaceRoute | null {
  const [first, ...rest] = segments;
  if (first === undefined) return { view: { name: 'works' } };
  if (first === 'upload') {
    const [tenderId, ...extra] = rest;
    if (extra.length > 0) return null;
    if (tenderId === undefined) return { view: { name: 'upload', tenderId: null } };
    return isRecordId(tenderId) ? { view: { name: 'upload', tenderId } } : null;
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
