import {
  Boxes,
  CircleCheckBig,
  Database,
  ClipboardCheck,
  FileBadge,
  FileText,
  FolderKanban,
  Gavel,
  Hammer,
  HandCoins,
  Landmark,
  LayoutDashboard,
  Mails,
  PenTool,
  Receipt,
  ScanSearch,
  Settings as SettingsIcon,
  Factory,
  Truck,
  Upload,
  Users,
  Wrench,
} from 'lucide-react';
import { workspaceHashOf, type WorkspaceView } from '../lib/workspace-routes.js';

/** The modules the rail can open. One key per lamp: a module's register and
 * an opened record inside it light the same lamp. */
export type ModuleKey =
  | 'dashboard'
  | 'works'
  | 'tenders'
  | 'challans'
  | 'invoices'
  | 'quotations'
  | 'correspondence'
  | 'company-documents'
  | 'inspection'
  | 'payments'
  | 'receivables'
  | 'approvals'
  | 'search'
  | 'installations'
  | 'production'
  | 'stock'
  | 'signing'
  | 'imports'
  | 'employees'
  | 'maintenance'
  | 'masters'
  | 'members'
  | 'settings';

type NavIcon = typeof LayoutDashboard;

export interface NavItem {
  readonly key: ModuleKey;
  readonly label: string;
  readonly icon: NavIcon;
}

export interface NavGroup {
  /** `null` is the mock's first group, which carries no heading. */
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

/**
 * The rail, arranged in the frozen mock's grouping
 * (`components/app-sidebar` at `a8e1fde`): an unlabelled first group,
 * then Documents, Operations and Administration.
 *
 * The mock draws modules this build has no route for — E-Way Bills,
 * Purchase orders, Maintenance — and those are omitted rather than
 * rendered as dead entries. Production (migration 0084), Correspondence
 * (0086) and Inventory (0087) all left that list in the previous wave:
 * Production and Inventory take the places the mock gives them under
 * Operations, and Correspondence the last under Documents. Employees
 * (0089, 0090) leaves it in this one, taking the mock's own first place
 * under Administration.
 * Purchase orders, Employees — and those are omitted rather than
 * rendered as dead entries. Production (migration 0084), Correspondence
 * (0086), Inventory (0087) and Maintenance (0088) have all left that
 * list: Production, Inventory and Maintenance take the places the mock
 * gives them under Operations, and Correspondence the last under
 * Documents.
 * Quotations runs the other way: the mock draws it under Documents in its
 * own list, so it keeps its place here.
 *
 * The unlabelled first group is now Dashboard, Works, Tenders, Payments.
 * The mock's own order there is Dashboard, Works, Tenders, Inspection,
 * Payments: Tenders (migration 0083) and Payments (0080) take the places
 * the mock gives them, and Inspection (0082) is built but lives under
 * Operations in this build, so Payments follows Tenders directly. All
 * three were on the omitted list until this wave; none is now.
 *
 * Company documents runs the other way again, and it is the one entry
 * here the mock does not draw in its own rail. The mock HAS the screen
 * (`app/tenders/company-documents/page.tsx` at fdfe5ef) but reaches it
 * only from a toolbar button on its Tenders dashboard, which makes a
 * reusable credential look like a tender accessory when it is
 * organisation master data every module wants. It sits under Documents,
 * which is where the mock's own rail groups document registers, and the
 * Tenders register does not repeat the button. Flagged to the owner in
 * the pull request: if the mock later grows a rail entry of its own for
 * it, this follows the mock.
 *
 * Serial Lookup has no entry because it no longer has a destination
 * (`docs/UX.md` § `#/serials` merges into Global Search): serials are one
 * scope inside Search, and the chain a serial opens is unchanged.
 *
 * Bills is deliberately absent: `docs/UX.md` § Bills is a Work section
 * settles it as a Work workspace section, and it is reached from there.
 */
export const NAVIGATION: readonly NavGroup[] = [
  {
    label: null,
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'works', label: 'Works', icon: FolderKanban },
      { key: 'tenders', label: 'Tenders', icon: Gavel },
      { key: 'payments', label: 'Payments', icon: HandCoins },
      { key: 'receivables', label: 'Receivables', icon: Landmark },
    ],
  },
  {
    label: 'Documents',
    items: [
      { key: 'challans', label: 'Challans', icon: Truck },
      { key: 'invoices', label: 'Invoices', icon: Receipt },
      { key: 'quotations', label: 'Quotations', icon: FileText },
      { key: 'correspondence', label: 'Correspondence', icon: Mails },
      { key: 'company-documents', label: 'Company documents', icon: FileBadge },
      // The signing queue (0091). Grouped with the documents it signs,
      // not with Administration: it is a register of acts on outward
      // paper, and the mock has no cell for it at all (docs/UX.md § 16).
      { key: 'signing', label: 'Signing queue', icon: PenTool },
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'production', label: 'Production', icon: Factory },
      { key: 'installations', label: 'Installations', icon: Wrench },
      { key: 'inspection', label: 'Inspection', icon: ClipboardCheck },
      { key: 'stock', label: 'Inventory', icon: Boxes },
      // The mock gives Maintenance `ClipboardCheck`, which is already
      // Inspection's lamp on this rail. Two identical icons in one group
      // is worse than one substituted, so it takes `Hammer` — recorded
      // in `docs/UX.md` § 14.
      { key: 'maintenance', label: 'Maintenance', icon: Hammer },
      { key: 'search', label: 'Global search', icon: ScanSearch },
    ],
  },
  {
    label: 'Administration',
    items: [
      // `Users`, which is also Members' icon two rows down. That is the
      // mock's own choice (`components/app-sidebar.tsx` at fdfd610 gives
      // both entries `Users`), and the design contract makes the mock
      // binding: a different icon here would be pixel drift, not a fix.
      { key: 'employees', label: 'Employees', icon: Users },
      { key: 'approvals', label: 'Approvals', icon: CircleCheckBig },
      { key: 'masters', label: 'Masters', icon: Database },
      // Imports (0094) sits directly beneath Masters, because the two
      // registers it fills are the two Masters owns and an operator who
      // has just found the Contacts screen is one row from the way to
      // fill it eight hundred at a time. `Upload` is new to this rail —
      // checked against every icon already on it (docs/UX.md § 18).
      { key: 'imports', label: 'Imports', icon: Upload },
      { key: 'members', label: 'Members', icon: Users },
      { key: 'settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

/** The mobile "More" sheet lists every destination the bottom bar's own two
 * cells do not already carry, in the rail's order so the two agree. */
export const MOBILE_MORE_ITEMS: readonly NavItem[] = NAVIGATION.flatMap(
  (group) => group.items,
).filter((item) => item.key !== 'dashboard' && item.key !== 'works');

export function defaultViewOf(key: ModuleKey): WorkspaceView {
  switch (key) {
    case 'dashboard':
      return { name: 'dashboard' };
    case 'works':
      return { name: 'works' };
    case 'tenders':
      return { name: 'tenders' };
    case 'challans':
      return { name: 'challans', tab: 'delivery', workId: null };
    case 'invoices':
      return { name: 'invoices' };
    case 'quotations':
      return { name: 'quotations' };
    case 'correspondence':
      return { name: 'correspondence' };
    case 'company-documents':
      return { name: 'company-documents' };
    case 'maintenance':
      return { name: 'maintenance' };
    case 'inspection':
      return { name: 'inspection' };
    case 'payments':
      return { name: 'payments', tab: 'employee' };
    case 'receivables':
      return { name: 'receivables' };
    case 'approvals':
      return { name: 'approvals' };
    case 'search':
      return { name: 'search', query: '' };
    case 'installations':
      return { name: 'installations', workId: null };
    case 'production':
      return { name: 'production', workId: null };
    case 'stock':
      return { name: 'stock' };
    case 'signing':
      return { name: 'signing' };
    case 'imports':
      return { name: 'imports' };
    case 'employees':
      return { name: 'employees' };
    case 'masters':
      return { name: 'masters' };
    case 'members':
      return { name: 'members' };
    case 'settings':
      return { name: 'settings' };
  }
}

/** Where a rail destination points, as a plain fragment.
 *
 * The mock's rail is a list of Next `Link`s (`components/app-sidebar` at
 * fdfe5ef), and `docs/UX.md` § navigation asks that every mock `Link`
 * become a real anchor with a hash href. This is that href: the same
 * view `onOpenModule` would set, serialised through the one serializer,
 * so the address a middle-click opens and the address the click produces
 * cannot drift apart. */
export function moduleHash(key: ModuleKey): string {
  return workspaceHashOf({ view: defaultViewOf(key) });
}

export function activeModuleOf(view: WorkspaceView): ModuleKey {
  switch (view.name) {
    // Both of the module's views light the same nav lamp: the register
    // and an opened record are one place.
    case 'delivery-challan':
      return 'challans';
    case 'invoice':
      return 'invoices';
    case 'tender':
    case 'tender-new':
      return 'tenders';
    // Writing a letter and registering one both light the register's lamp:
    // the module is one place.
    case 'correspondence-new':
    case 'correspondence-inward':
      return 'correspondence';
    // The register, the item master and an opened job card are one
    // place, so all three light one lamp.
    case 'production-items':
    case 'production-job-card':
      return 'production';
    // The register and the shortage screen are one place on the rail.
    case 'stock':
    case 'stock-shortages':
      return 'stock';
    // The employee register and the payroll workspace under it are one
    // place too. The mock's own rail reaches only the first of them.
    case 'employees':
    case 'payroll':
      return 'employees';
    // The register, the request form and an opened job card are one
    // place, so all three light one lamp (0088).
    case 'maintenance-new':
    case 'maintenance-request':
      return 'maintenance';
    case 'dashboard':
    case 'challans':
    case 'invoices':
    case 'quotations':
    case 'correspondence':
    case 'company-documents':
    case 'inspection':
    case 'payments':
    case 'receivables':
    case 'tenders':
    case 'approvals':
    case 'search':
    case 'maintenance':
    case 'installations':
    case 'production':
    case 'masters':
    case 'members':
    case 'settings':
      return view.name;
    case 'signing':
      return 'signing';
    case 'imports':
      return 'imports';
    // Everything the WORKS module owns: the register, one Work, and every
    // screen that is really a step inside one — LOA upload and review, the
    // challan and issue-challan editors, an opened challan.
    case 'work':
    case 'works':
    case 'upload':
    case 'review':
    case 'challan':
    case 'challan-new':
    case 'challan-edit':
    case 'issue-challan':
    case 'issue-challan-new':
    case 'issue-challan-edit':
      return 'works';
  }
  // EXHAUSTIVE, on purpose, and this is the whole reason there is no
  // `default` arm. A `default: return 'works'` is what let `#/signing`
  // ship highlighting Works and announcing it as the current page — a
  // wrong `aria-current`, which is a screen-reader defect and not a
  // cosmetic one, and nothing failed. With the switch exhaustive, a new
  // view name fails to typecheck here until somebody says which lamp it
  // lights.
  const unreachable: never = view;
  return unreachable;
}

export function pageTitleOf(view: WorkspaceView): string {
  switch (view.name) {
    case 'dashboard':
      return 'Dashboard';
    case 'works':
      return 'Works';
    case 'upload':
      return 'Upload LOA';
    case 'review':
      return 'Review LOA';
    case 'work':
      return 'Work workspace';
    case 'challan-new':
      return 'New Delivery Challan';
    case 'challan-edit':
      return 'Edit Delivery Challan';
    case 'challan':
      return 'Delivery Challan';
    case 'issue-challan-new':
      return 'New Issue Challan';
    case 'issue-challan-edit':
      return 'Edit Issue Challan';
    case 'issue-challan':
      return 'Issue Challan';
    case 'challans':
      return 'Challans';
    case 'delivery-challan':
      return 'Delivery Challan';
    case 'invoices':
      return 'Invoices';
    case 'invoice':
      return 'Tax invoice';
    case 'quotations':
      return 'Quotations';
    case 'correspondence':
      return 'Correspondence';
    case 'correspondence-new':
      return 'Write outward letter';
    case 'correspondence-inward':
      return 'Upload inward letter';
    case 'company-documents':
      return 'Company documents';
    case 'inspection':
      return 'Inspection';
    case 'production':
      return 'Production';
    case 'production-items':
      return 'Manufactured items';
    case 'production-job-card':
      return 'Job card';
    case 'maintenance':
      return 'Maintenance';
    case 'maintenance-new':
      return 'Site material request';
    case 'maintenance-request':
      return 'Maintenance job card';
    case 'payments':
      return 'Payments';
    case 'tenders':
      return 'Tenders';
    case 'tender-new':
      return 'Upload tender NIT';
    case 'tender':
      return 'Tender workspace';
    case 'receivables':
      return 'Receivables';
    case 'approvals':
      return 'Approvals';
    case 'search':
      return 'Global search';
    case 'installations':
      return 'Installations';
    case 'stock':
      return 'Inventory';
    case 'stock-shortages':
      return 'Shortage procurement';
    case 'signing':
      return 'Signing queue';
    case 'imports':
      return 'Imports';
    case 'employees':
      return 'Employees';
    case 'payroll':
      return 'Monthly payroll';
    case 'masters':
      return 'Masters';
    case 'members':
      return 'Members';
    case 'settings':
      return 'Settings';
  }
}
