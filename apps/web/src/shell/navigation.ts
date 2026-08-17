import {
  CircleCheckBig,
  Database,
  FileText,
  FolderKanban,
  LayoutDashboard,
  Receipt,
  ScanBarcode,
  ScanSearch,
  Settings as SettingsIcon,
  Truck,
  Users,
  Wrench,
} from 'lucide-react';
import type { WorkspaceView } from '../lib/workspace-routes.js';

/** The modules the rail can open. One key per lamp: a module's register and
 * an opened record inside it light the same lamp. */
export type ModuleKey =
  | 'dashboard'
  | 'works'
  | 'challans'
  | 'invoices'
  | 'quotations'
  | 'approvals'
  | 'search'
  | 'serials'
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
 * rendered as dead entries. Two destinations run the other way: Serial
 * Lookup has no mock entry (`docs/UX.md` merges it into Global Search in a
 * later phase) and Quotations is drawn under Documents in the mock's own
 * list, so both keep their place here in the mock's grammar.
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
    ],
  },
  {
    label: 'Operations',
    items: [
      { key: 'installations', label: 'Installations', icon: Wrench },
      { key: 'serials', label: 'Serial Lookup', icon: ScanBarcode },
      { key: 'search', label: 'Search', icon: ScanSearch },
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
    case 'approvals':
      return { name: 'approvals' };
    case 'search':
      return { name: 'search', query: '' };
    case 'serials':
      return { name: 'serials' };
    case 'installations':
      return { name: 'installations' };
    case 'masters':
      return { name: 'masters' };
    case 'members':
      return { name: 'members' };
    case 'settings':
      return { name: 'settings' };
  }
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
    case 'approvals':
    case 'search':
    case 'serials':
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
    case 'approvals':
      return 'Approvals';
    case 'search':
      return 'Search';
    case 'serials':
      return 'Serial Lookup';
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
