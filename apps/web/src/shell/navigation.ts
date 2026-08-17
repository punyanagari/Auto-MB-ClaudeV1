import {
  CircleCheckBig,
  Database,
  ClipboardCheck,
  FileBadge,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Receipt,
  ScanSearch,
  Settings as SettingsIcon,
  Truck,
  Users,
  Wrench,
} from 'lucide-react';
import { workspaceHashOf, type WorkspaceView } from '../lib/workspace-routes.js';

/** The modules the rail can open. One key per lamp: a module's register and
 * an opened record inside it light the same lamp. */
export type ModuleKey =
  | 'dashboard'
  | 'works'
  | 'challans'
  | 'invoices'
  | 'quotations'
  | 'company-documents'
  | 'inspection'
  | 'approvals'
  | 'search'
  | 'installations'
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
 * The mock draws modules this build has no route for — Tenders, Inspection,
 * Payments, E-Way Bills, Correspondence, Production, Inventory, Purchase
 * orders, Maintenance, Employees — and those are omitted rather than
 * rendered as dead entries. Quotations runs the other way: the mock draws
 * it under Documents in its own list, so it keeps its place here.
 *
 * Company documents runs the other way again, and it is the one entry
 * here the mock does not draw in its own rail. The mock HAS the screen
 * (`app/tenders/company-documents/page.tsx` at fdfe5ef) but reaches it
 * from a toolbar button on its Tenders dashboard — and Tenders is one of
 * the modules omitted above, so replicating the placement exactly would
 * leave the screen with no way in at all. It sits under Documents, which
 * is where the mock's own rail groups document registers. Flagged to the
 * owner in the pull request: if the mock later grows a rail entry of its
 * own for it, this follows the mock.
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
    ],
  },
  {
    label: 'Documents',
    items: [
      { key: 'challans', label: 'Challans', icon: Truck },
      { key: 'invoices', label: 'Invoices', icon: Receipt },
      { key: 'quotations', label: 'Quotations', icon: FileText },
      { key: 'company-documents', label: 'Company documents', icon: FileBadge },
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'installations', label: 'Installations', icon: Wrench },
      { key: 'inspection', label: 'Inspection', icon: ClipboardCheck },
      { key: 'search', label: 'Global search', icon: ScanSearch },
    ],
  },
  {
    label: 'Administration',
    items: [
      { key: 'approvals', label: 'Approvals', icon: CircleCheckBig },
      { key: 'masters', label: 'Masters', icon: Database },
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
    case 'challans':
      return { name: 'challans', tab: 'delivery', workId: null };
    case 'invoices':
      return { name: 'invoices' };
    case 'quotations':
      return { name: 'quotations' };
    case 'company-documents':
      return { name: 'company-documents' };
    case 'inspection':
      return { name: 'inspection' };
    case 'approvals':
      return { name: 'approvals' };
    case 'search':
      return { name: 'search', query: '' };
    case 'installations':
      return { name: 'installations', workId: null };
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
    case 'dashboard':
    case 'challans':
    case 'invoices':
    case 'quotations':
    case 'company-documents':
    case 'inspection':
    case 'approvals':
    case 'search':
    case 'installations':
    case 'masters':
    case 'members':
    case 'settings':
      return view.name;
    default:
      return 'works';
  }
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
    case 'company-documents':
      return 'Company documents';
    case 'inspection':
      return 'Inspection';
    case 'approvals':
      return 'Approvals';
    case 'search':
      return 'Global search';
    case 'installations':
      return 'Installations';
    case 'masters':
      return 'Masters';
    case 'members':
      return 'Members';
    case 'settings':
      return 'Settings';
  }
}
