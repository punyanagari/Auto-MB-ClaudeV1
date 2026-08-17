/** The per-view state inventory that `state-coverage.test.tsx` and
 * `state-coverage-inventory.test.ts` both read. Not a suite of its own —
 * the runner's `include` is `*.{test,spec}.{ts,tsx}`. */
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { RequestFailedError, type ApiClient } from '../../src/api.js';
import { AccountSecurity } from '../../src/views/AccountSecurity.js';
import { RailwayBillPanel } from '../../src/views/RailwayBillPanel.js';
import { Approvals } from '../../src/views/Approvals.js';
import { CompanyDocuments } from '../../src/views/CompanyDocuments.js';
import { Inspection } from '../../src/views/Inspection.js';
import { WorkInspectionClause } from '../../src/views/WorkInspectionClause.js';
import { CompletionExtensions } from '../../src/views/CompletionExtensions.js';
import { DeliveryChallans } from '../../src/views/DeliveryChallans.js';
import { IssueChallans } from '../../src/views/IssueChallans.js';
import { Installations } from '../../src/views/Installations.js';
import { InstallationsRegister } from '../../src/views/InstallationsRegister.js';
import { InvoicesRegister } from '../../src/views/InvoicesRegister.js';
import { IssueChallanDetail } from '../../src/views/IssueChallanDetail.js';
import { IssueChallanEditor } from '../../src/views/IssueChallanEditor.js';
import { Members } from '../../src/views/Members.js';
import { PacCertificates } from '../../src/views/PacCertificates.js';
import { PaymentMatrix } from '../../src/views/PaymentMatrix.js';
import { Payments } from '../../src/views/Payments.js';
import { Quotations } from '../../src/views/Quotations.js';
import { ReviewLoa } from '../../src/views/ReviewLoa.js';
import { Search } from '../../src/views/Search.js';
import { SerialTrace } from '../../src/views/SerialTrace.js';
import { Settings } from '../../src/views/Settings.js';
import { Timeline } from '../../src/views/Timeline.js';
import { WorkBillingReadiness } from '../../src/views/WorkBillingReadiness.js';
import { WorkBillSettlement } from '../../src/views/WorkBillSettlement.js';
import { WorkConsignees } from '../../src/views/WorkConsignees.js';
import { WorkDetail } from '../../src/views/WorkDetail.js';
import { WorkPaymentSetup } from '../../src/views/WorkPaymentSetup.js';
import { WorkTaxInvoices } from '../../src/views/WorkTaxInvoices.js';
import {
  billableBook,
  challanWork,
  ORG_ID,
  DOC_ID,
  REVIEW_DOCUMENT,
  WORK_ID,
} from './helpers.js';

/** How the server fails when it is simply unreachable — the case every
 * one of these views must survive. */
export function outage(): RequestFailedError {
  return new RequestFailedError(
    503,
    'DATABASE_UNAVAILABLE',
    'The database is temporarily unavailable. Nothing was saved. Try again.',
  );
}

export interface StateCase {
  /** The file in `src/views` this case covers, so the inventory test can
   * match cases against the views that have a load path. */
  readonly view: string;
  /** What is loading, for the test name. A view with two independent
   * loads (a register and its picker) gets one case each. */
  readonly name: string;
  /**
   * The `ApiClient` methods that make up THIS load. Only these are made
   * to hang or to fail: a view whose picker fails while its register
   * loads is a different state from one where everything is down, and
   * the point of the case is to pin the right one.
   */
  readonly loads: readonly (keyof ApiClient)[];
  /** Anything else the view needs before it will render at all. */
  readonly stub?: Partial<ApiClient>;
  readonly render: (api: ApiClient) => ReactElement;
  /** The accessible name of the control that re-runs the failed load. */
  readonly retry: RegExp;
  /**
   * The legitimate empty state, or an explicit statement that the view
   * has none. `docs/UX.md` asks for "loaded with records" and
   * "legitimate empty state" as separate patterns; a detail screen that
   * always shows one record has no second pattern to show, and saying so
   * here is the decision being recorded rather than skipped.
   */
  readonly empty:
    | { readonly text: RegExp; readonly stub?: Partial<ApiClient> }
    | { readonly notApplicable: string };
}

const noop = (): void => undefined;

export const STATE_CASES: readonly StateCase[] = [
  {
    view: 'AccountSecurity.tsx',
    name: 'the account security status',
    loads: ['me'],
    render: (api) => <AccountSecurity api={api} />,
    retry: /Retry security status/,
    empty: { notApplicable: 'An account always has a two-factor status.' },
  },
  {
    view: 'Approvals.tsx',
    name: 'the approvals queue',
    loads: ['listApprovals'],
    render: (api) => (
      <Approvals
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-1"
        canApprove
        onChanged={noop}
      />
    ),
    retry: /Retry approvals/,
    empty: { text: /Nothing is waiting for a decision/ },
  },
  {
    view: 'Payments.tsx',
    name: 'the employee payment requests',
    loads: ['listPaymentRequests'],
    render: (api) => (
      <Payments
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-1"
        canManagePayments
        canCancel
        tab="employee"
        onOpenRegister={noop}
      />
    ),
    retry: /Retry payment requests/,
    empty: { text: /No advance or reimbursement has been raised yet/ },
  },
  {
    view: 'Payments.tsx',
    name: 'the vendor ledger',
    loads: ['listVendorInvoices'],
    render: (api) => (
      <Payments
        api={api}
        organisationId={ORG_ID}
        currentUserId="user-1"
        canManagePayments
        canCancel
        tab="vendors"
        onOpenRegister={noop}
      />
    ),
    retry: /Retry vendor ledger/,
    empty: { text: /No vendor invoice has been recorded yet/ },
  },
  {
    view: 'CompletionExtensions.tsx',
    name: 'the completion details',
    loads: ['getWorkCompletion'],
    render: (api) => (
      <CompletionExtensions
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canIssue
        canApprove
      />
    ),
    retry: /Retry completion details/,
    empty: {
      notApplicable:
        'A Work always has a completion position, even when no extension has been asked for.',
    },
  },
  {
    view: 'DeliveryChallans.tsx',
    name: 'the delivery challan register',
    loads: ['listDeliveryChallans'],
    render: (api) => (
      <DeliveryChallans
        api={api}
        organisationId={ORG_ID}
        canModify
        canIssue
        canCancel
        canManageStatutory
        openChallanId={null}
        workId={null}
        onOpenChallan={noop}
        onOpenWorkChallan={noop}
      />
    ),
    retry: /Retry delivery challans/,
    empty: { text: /No delivery challans yet/ },
  },
  {
    view: 'IssueChallans.tsx',
    name: 'the issue challan register',
    loads: ['listIssueChallans'],
    render: (api) => (
      <IssueChallans
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        onOpenIssueChallan={noop}
      />
    ),
    retry: /Retry issue challans/,
    empty: { text: /No issue challans for this Work yet/ },
  },
  {
    view: 'Installations.tsx',
    name: 'the installation records',
    loads: ['listWorkInstallations'],
    render: (api) => (
      <Installations
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canRecordEvidence
        workItems={[]}
        serials={[]}
        onSerialsChanged={noop}
      />
    ),
    retry: /Retry installation records/,
    empty: {
      notApplicable:
        'The register is one row per Work item, so it is empty only when the Work has no items — a state the Work screen itself answers for.',
    },
  },
  {
    view: 'Installations.tsx',
    name: 'the installation location master',
    loads: ['listLocationMasters'],
    render: (api) => (
      <Installations
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canRecordEvidence
        workItems={[]}
        serials={[]}
        onSerialsChanged={noop}
      />
    ),
    retry: /Retry locations/,
    empty: {
      notApplicable:
        'An unlisted location master is offered as a free-text location, not as an empty picker.',
    },
  },
  {
    view: 'InstallationsRegister.tsx',
    name: 'the installation register',
    loads: ['listInstallations'],
    render: (api) => (
      <InstallationsRegister
        api={api}
        organisationId={ORG_ID}
        workId={null}
        onOpenWork={noop}
        onOpenWorks={noop}
        onClearWorkFilter={noop}
      />
    ),
    retry: /Retry installations/,
    empty: { text: /No installations recorded yet/ },
  },
  {
    view: 'InvoicesRegister.tsx',
    name: 'the tax-invoice register',
    loads: ['listTaxInvoices'],
    render: (api) => (
      <InvoicesRegister
        api={api}
        organisationId={ORG_ID}
        canModify
        canIssue
        canCancel
        canManageStatutory
        hasFullWorkScope
        openInvoiceId={null}
        onOpenInvoice={noop}
        onOpenWork={noop}
      />
    ),
    retry: /Retry invoices/,
    empty: { text: /No tax invoice has been raised yet/ },
  },
  {
    view: 'IssueChallanDetail.tsx',
    name: 'the Issue Challan',
    loads: ['getIssueChallan'],
    render: (api) => (
      <IssueChallanDetail
        api={api}
        organisationId={ORG_ID}
        challanId="ic-1"
        canModify
        canIssue
        canCancel
        onEdit={noop}
        onDeleted={noop}
        onBack={noop}
      />
    ),
    retry: /Retry Issue Challan/,
    empty: { notApplicable: 'A detail screen shows one record or none at all.' },
  },
  {
    view: 'IssueChallanEditor.tsx',
    name: 'the Work items to issue against',
    loads: ['workBalance'],
    render: (api) => (
      <IssueChallanEditor
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        challanId={null}
        onSaved={noop}
        onCancel={noop}
      />
    ),
    retry: /Retry items/,
    empty: { notApplicable: 'An editor with no items is a Work with no schedule.' },
  },
  {
    view: 'Members.tsx',
    name: 'the member list',
    loads: ['listMembers'],
    render: (api) => (
      <Members api={api} organisationId={ORG_ID} currentUserId="user-1" />
    ),
    retry: /Retry members/,
    empty: {
      notApplicable:
        'An organisation always has at least the owner who created it; migration 0064 keeps it that way.',
    },
  },
  {
    view: 'PacCertificates.tsx',
    name: 'the PAC certificates',
    loads: ['listWorkPacCertificates'],
    render: (api) => (
      <PacCertificates
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        workItems={[]}
      />
    ),
    retry: /Retry PAC certificates/,
    empty: {
      notApplicable:
        'The screen leads with the per-item acceptance position, which exists before any certificate does.',
    },
  },
  {
    view: 'PaymentMatrix.tsx',
    name: 'the payment matrix',
    loads: ['getPaymentMatrix'],
    render: (api) => (
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={noop}
      />
    ),
    retry: /Retry payment matrix/,
    empty: {
      notApplicable:
        'The matrix is a fixed row per payment category; an unconfigured category is a blank row, not an empty register.',
    },
  },
  {
    view: 'PaymentMatrix.tsx',
    name: 'the tender evidence to compare the matrix against',
    loads: ['getWorkContractSourceContext'],
    render: (api) => (
      <PaymentMatrix
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        canModify
        onItemCategoryChanged={noop}
      />
    ),
    retry: /Retry tender comparison/,
    empty: {
      notApplicable:
        'A Work with no tender documents shows no comparison panel rather than an empty one.',
    },
  },
  {
    view: 'WorkPaymentSetup.tsx',
    name: 'the payment matrix behind the post-creation setup dialog',
    loads: ['getPaymentMatrix'],
    render: (api) => (
      <WorkPaymentSetup
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
        onClose={noop}
        onSaved={noop}
      />
    ),
    retry: /Retry payment setup/,
    // The percentage half is a fixed row per category, which has no
    // empty state — but the ITEMS half is a register of the Work's items,
    // and a Work with none of them is a real state the dialog can open
    // in. It is what a confirmation with an empty schedule produces.
    empty: { text: /This Work has no items/ },
  },
  {
    view: 'RailwayBillPanel.tsx',
    name: "the railway's bill against a measurement",
    loads: ['listReceivedRailwayBills'],
    render: (api) => (
      <RailwayBillPanel
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        book={billableBook()}
        canIssue
        canCancel
        onClosed={async () => {
          await Promise.resolve();
        }}
      />
    ),
    retry: /Retry railway bills/,
    empty: { text: /still\s+outstanding with the railway/ },
  },
  {
    view: 'Inspection.tsx',
    name: 'the inspection workspace',
    loads: ['listInspectionCalls'],
    render: (api) => (
      <Inspection api={api} organisationId={ORG_ID} canRecord canModify canCancel />
    ),
    retry: /Retry inspection calls/,
    empty: { text: /No RDSO inspection call has been raised/ },
  },
  {
    view: 'WorkInspectionClause.tsx',
    name: "the Work's inspection clause",
    loads: ['getWorkInspectionConfig'],
    render: (api) => (
      <WorkInspectionClause
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canGate
      />
    ),
    retry: /Retry the inspection clause/,
    empty: { text: /nothing to map for\s+inspection/ },
  },
  {
    view: 'CompanyDocuments.tsx',
    name: 'the company document library',
    loads: ['listCompanyDocuments'],
    render: (api) => <CompanyDocuments api={api} organisationId={ORG_ID} canModify />,
    retry: /Retry company documents/,
    empty: { text: /Nothing in the library yet/ },
  },
  {
    view: 'Quotations.tsx',
    name: 'the quotations register',
    loads: ['listBudgetaryQuotations'],
    render: (api) => (
      <Quotations api={api} organisationId={ORG_ID} canModify canIssue canCancel />
    ),
    retry: /Retry quotations/,
    empty: { text: /No quotations yet/ },
  },
  {
    view: 'ReviewLoa.tsx',
    name: 'the LOA document under review',
    loads: ['getLoaDocument'],
    render: (api) => (
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={noop}
        onBack={noop}
        onDiscarded={noop}
      />
    ),
    retry: /Retry document/,
    empty: { notApplicable: 'A review screen reviews exactly one letter.' },
  },
  {
    view: 'ReviewLoa.tsx',
    name: 'the tender evidence matched to the letter',
    loads: ['getLoaContractSourceContext'],
    stub: { getLoaDocument: vi.fn().mockResolvedValue(REVIEW_DOCUMENT) },
    render: (api) => (
      <ReviewLoa
        api={api}
        organisationId={ORG_ID}
        documentId={DOC_ID}
        canModify
        onConfirmed={noop}
        onBack={noop}
        onDiscarded={noop}
      />
    ),
    retry: /Retry tender evidence/,
    empty: {
      notApplicable:
        'A letter uploaded without supporting documents shows no evidence panel rather than an empty one.',
    },
  },
  {
    view: 'Search.tsx',
    name: 'the search results',
    loads: ['search'],
    render: (api) => (
      <Search
        api={api}
        organisationId={ORG_ID}
        query="switchboard"
        onQueryChange={noop}
        onOpenWork={noop}
        onOpenChallan={noop}
        onOpenIssueChallan={noop}
        onOpenQuotations={noop}
      />
    ),
    retry: /Try again/,
    empty: { text: /Nothing in the registers matches/ },
  },
  {
    /* The serial traceability chain, now a scope of Global Search rather
       than a screen of its own (`docs/UX.md` § `#/serials` merges into
       Global Search). It reads on mount from the query Search hands it,
       so it answers to the same three-state contract every register does
       — the merge moved the entry point, not the bar. */
    view: 'SerialTrace.tsx',
    name: 'the serial chain',
    loads: ['searchSerials'],
    render: (api) => (
      <SerialTrace
        api={api}
        organisationId={ORG_ID}
        query="SB-2026-014"
        onOpenWork={noop}
        onOpenChallan={noop}
      />
    ),
    retry: /Retry serial search/,
    empty: { text: /No serial matches/ },
  },
  {
    view: 'Settings.tsx',
    name: 'the organisation profile',
    loads: ['organisationProfile'],
    render: (api) => <Settings api={api} organisationId={ORG_ID} isOwner />,
    retry: /Retry settings/,
    empty: { notApplicable: 'An organisation always has a profile, however sparse.' },
  },
  {
    view: 'Settings.tsx',
    name: 'the number series',
    loads: ['listNumberSeries'],
    render: (api) => <Settings api={api} organisationId={ORG_ID} isOwner />,
    retry: /Retry number series/,
    empty: {
      notApplicable:
        'Every document type has a series — the product default when nothing is configured — so the table is never empty.',
    },
  },
  {
    view: 'Timeline.tsx',
    name: "the Work's timeline",
    loads: ['workTimeline'],
    render: (api) => (
      <Timeline
        api={api}
        organisationId={ORG_ID}
        scope={{ kind: 'work', workId: WORK_ID }}
      />
    ),
    retry: /Retry timeline/,
    empty: { text: /No activity recorded yet/ },
  },
  {
    view: 'WorkBillSettlement.tsx',
    name: 'outstanding with the railway',
    loads: ['listBillSettlement'],
    render: (api) => (
      <WorkBillSettlement
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canIssue
        canCancel
      />
    ),
    retry: /Retry payments against bills/,
    empty: { text: /nothing is outstanding with the railway yet/ },
  },
  {
    view: 'WorkBillingReadiness.tsx',
    name: 'the billing prerequisites',
    loads: ['getPaymentMatrix'],
    render: (api) => (
      <WorkBillingReadiness
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        workItems={[]}
      />
    ),
    retry: /Retry readiness check/,
    empty: {
      notApplicable: 'A readiness check answers met or unmet, never nothing.',
    },
  },
  {
    view: 'WorkConsignees.tsx',
    name: "the Work's consignees",
    loads: ['listWorkConsignees'],
    render: (api) => (
      <WorkConsignees api={api} organisationId={ORG_ID} workId={WORK_ID} canModify />
    ),
    retry: /Retry consignees/,
    empty: { text: /No consignees linked yet/ },
  },
  {
    view: 'WorkDetail.tsx',
    name: 'the Work',
    loads: ['getWork'],
    render: (api) => (
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canCancel
        canApprove
        canManageStatutory
        isOwner
        onNewChallan={noop}
        onOpenChallan={noop}
        onNewIssueChallan={noop}
        onOpenIssueChallan={noop}
        onBack={noop}
      />
    ),
    retry: /Retry Work/,
    empty: { notApplicable: 'A Work screen shows one Work.' },
  },
  {
    view: 'WorkDetail.tsx',
    name: "the Work's supporting registers",
    loads: ['listWorkPurchaseOrders'],
    stub: { getWork: vi.fn().mockResolvedValue(challanWork()) },
    render: (api) => (
      <WorkDetail
        api={api}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canRecordEvidence
        canIssue
        canCancel
        canApprove
        canManageStatutory
        isOwner
        onNewChallan={noop}
        onOpenChallan={noop}
        onNewIssueChallan={noop}
        onOpenIssueChallan={noop}
        onBack={noop}
      />
    ),
    retry: /Retry supporting sections/,
    empty: {
      notApplicable:
        'Each supporting register carries its own empty state inside its tab.',
    },
  },
  {
    view: 'WorkTaxInvoices.tsx',
    name: 'the tax invoices',
    loads: ['listWorkTaxInvoices'],
    render: (api) => (
      <WorkTaxInvoices
        api={api}
        onInvoicesKnown={() => {}}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canCreateDocuments
        canIssue
        canCancel
        canManageStatutory
        pending={false}
        act={() => Promise.resolve()}
      />
    ),
    retry: /Retry tax invoices/,
    empty: { text: /No tax invoice has been raised for this Work yet/ },
  },
  {
    view: 'WorkTaxInvoices.tsx',
    name: 'the Measurement Books available to bill',
    loads: ['listWorkMeasurementBooks'],
    render: (api) => (
      <WorkTaxInvoices
        api={api}
        onInvoicesKnown={() => {}}
        organisationId={ORG_ID}
        workId={WORK_ID}
        canModify
        canCreateDocuments
        canIssue
        canCancel
        canManageStatutory
        pending={false}
        act={() => Promise.resolve()}
      />
    ),
    retry: /Retry$/,
    empty: {
      notApplicable:
        'A Work with nothing billable offers no draft form rather than an empty picker.',
    },
  },
];

/**
 * Views with a mount load path that this table deliberately does not
 * cover, each with the reason. The inventory test reads it, so an
 * exemption is a recorded decision rather than an omission — and
 * deleting one is how a later pack claims the view.
 */
export const EXEMPT_VIEWS: Readonly<Record<string, string>> = {
  // Owned by pack P9 this wave; their state branches are not this pack's
  // to edit. All three dead-end on a failed load today.
  'OperationsDashboard.tsx': 'pack P9 owns this view in wave 2',
  'Masters.tsx': 'pack P9 owns this view in wave 2',
  'Works.tsx': 'pack P9 owns this view in wave 2',
  // Owned by pack P10 this wave. ChallanDetail and ChallanEditor
  // dead-end on a failed load; MeasurementBooks already retries.
  'ChallanDetail.tsx': 'pack P10 owns this view in wave 2',
  'ChallanEditor.tsx': 'pack P10 owns this view in wave 2',
  'MeasurementBooks.tsx': 'pack P10 owns this view in wave 2',
  // Deliberately silent loads, documented at the call site: the pending
  // approvals badge and the Work-status read behind a challan screen are
  // conveniences whose failure the destination screen reports itself.
  'OperationsWorkspace.tsx':
    'its two mount loads are badge conveniences whose failure the destination screen owns',
  // The register itself is loaded and retried by WorkDetail; this view's
  // own mount load is the vendor picker, which degrades to no create
  // form rather than to a failure.
  'WorkPurchaseOrders.tsx':
    'WorkDetail owns the purchase-order load, its failure state and its retry',
};
