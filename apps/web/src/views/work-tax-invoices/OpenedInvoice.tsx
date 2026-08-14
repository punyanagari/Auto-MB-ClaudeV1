import type {
  Contact,
  CreditNote,
  EwayBill,
  GstRateMaster,
  TaxInvoiceDetailResponse,
} from '@auto-mb/contracts';
import type { ApiClient } from '../../api.js';
import { CreditNotesPanel } from './CreditNotesPanel.js';
import { EwayBillsPanel } from '../EwayBillsPanel.js';
import { InvoiceCancelPanel, InvoiceDetail } from './InvoiceDetail.js';
import { IrpPanel } from './IrpPanel.js';
import { type ActRunner } from './shared.js';

interface OpenedInvoiceProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly detail: TaxInvoiceDetailResponse;
  readonly ewayBills: readonly EwayBill[];
  readonly creditNotes: readonly CreditNote[];
  readonly clients: readonly Contact[];
  readonly shipToContacts: readonly Contact[];
  readonly gstRates: readonly GstRateMaster[];
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly canManageStatutory: boolean;
  readonly pending: boolean;
  readonly act: ActRunner;
  readonly refresh: () => Promise<void>;
  readonly onDeleted: () => Promise<void>;
  readonly onEwayBillsChanged: (bills: readonly EwayBill[]) => void;
}

/**
 * One opened tax invoice, whole: its frozen facts and draft editor, the
 * PDF it renders to, the IRP transport, the Section 34 credit note, the
 * e-way bills, and the cancellation.
 *
 * This exists as a component because there are now TWO ways in. A
 * Work-backed invoice opens from its Work's Bills tab; a DIRECT one has
 * no Work to open through and opens from the organisation-wide invoice
 * register. Both are the same document under the same rules, and an
 * invoice that offered a PDF on one screen and not the other would be
 * two products. The panels each decide for themselves what applies —
 * `IrpPanel` renders nothing on a draft, `CreditNotesPanel` nothing
 * before submit — so neither caller has to know which apply.
 */
export function OpenedInvoice({
  api,
  organisationId,
  detail,
  ewayBills,
  creditNotes,
  clients,
  shipToContacts,
  gstRates,
  canModify,
  canIssue,
  canCancel,
  canManageStatutory,
  pending,
  act,
  refresh,
  onDeleted,
  onEwayBillsChanged,
}: OpenedInvoiceProps) {
  const invoice = detail.invoice;
  // The applicability rule ADR-0013 states, read the same way the server
  // reads it: a CUMULATIVE invoice is one SAC service line by definition,
  // and an ITEMISED one carries goods when any of its lines does.
  const invoiceCarriesGoods =
    invoice.lineShape === 'itemised' && detail.lines.some((line) => !line.isService);
  return (
    <section>
      <InvoiceDetail
        key={`${invoice.id}-${invoice.status}`}
        api={api}
        organisationId={organisationId}
        invoice={invoice}
        lines={detail.lines}
        clients={clients}
        shipToContacts={shipToContacts}
        gstRates={gstRates}
        canModify={canModify}
        canIssue={canIssue}
        pending={pending}
        act={act}
        refresh={refresh}
        onDeleted={onDeleted}
      />

      <IrpPanel
        api={api}
        organisationId={organisationId}
        invoice={invoice}
        canIssue={canIssue}
        canCancel={canCancel}
        canManageStatutory={canManageStatutory}
        pending={pending}
        act={act}
        refresh={refresh}
      />

      <CreditNotesPanel
        key={`credit-notes-${invoice.id}`}
        api={api}
        organisationId={organisationId}
        invoice={invoice}
        creditNotes={creditNotes}
        canModify={canModify}
        canIssue={canIssue}
        canCancel={canCancel}
        canManageStatutory={canManageStatutory}
        pending={pending}
        act={act}
        refresh={refresh}
      />

      {invoice.status === 'submitted' && (
        <EwayBillsPanel
          api={api}
          organisationId={organisationId}
          source={{
            kind: 'tax_invoice',
            id: invoice.id,
            number: invoice.invoiceNumber,
            // ADR-0013: applicability is a property of the LINES. A
            // cumulative invoice carries one SAC service line by
            // definition and can never raise a bill; an itemised one is
            // asked whether any of its lines is goods. The server holds
            // the same rule and refuses the same documents.
            eligible: invoiceCarriesGoods,
            refusal: invoiceCarriesGoods
              ? null
              : 'Every line of this invoice is a service. An e-way bill moves goods, so NIC refuses one for a service-only document; historical records stay readable, reconcilable and cancellable.',
          }}
          ewayBills={ewayBills}
          canModify={canModify}
          canIssue={canIssue}
          canCancel={canCancel}
          canManageStatutory={canManageStatutory}
          pending={pending}
          act={act}
          onEwayBillsChanged={onEwayBillsChanged}
        />
      )}

      {canCancel && (
        <InvoiceCancelPanel
          key={`cancel-${invoice.id}`}
          api={api}
          organisationId={organisationId}
          invoice={invoice}
          pending={pending}
          act={act}
          refresh={refresh}
        />
      )}
    </section>
  );
}
