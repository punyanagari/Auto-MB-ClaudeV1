import type { IrpProviderState, TaxInvoiceStatus } from '@auto-mb/contracts';
import type { ReactNode } from 'react';
import { formatDate } from '../../format.js';
import { StatusChip } from '../../ui/chip.js';

/** The fields both the register row and the Work's list row carry about an
 * invoice's statutory standing. Deliberately a structural subset, so the
 * one badge serves `TaxInvoiceRegisterEntry` and `TaxInvoice` alike. */
export interface IrpBadgeRow {
  readonly irn: string | null;
  readonly irpProvider: 'manual' | 'whitebooks' | null;
  readonly irpProviderState: IrpProviderState;
  readonly status: TaxInvoiceStatus;
  readonly irpReportingOverdue: boolean;
  readonly irpReportingDeadline: string | null;
}

interface IrpBadgeProps {
  readonly row: IrpBadgeRow;
  /** Prepended to every label. The register has a dedicated IRP column and
   * passes nothing; the Work's list sits the badge beside the local status
   * chip and passes 'IRP ' so the two are told apart. */
  readonly prefix?: string;
  /** What to render when there is no statutory signal yet. The register
   * shows an em dash in its column; the list shows nothing extra. */
  readonly placeholder?: ReactNode;
}

/**
 * One invoice's IRP standing, as one chip, shared by the organisation-wide
 * register and the Work's own invoice list so the two cannot fork again.
 *
 * The statutory state is read from `irpProviderState`, never inferred from
 * `irn !== null`. An IRN that has since been CANCELLED still has a non-null
 * `irn`; short-circuiting on that once rendered a cancelled invoice as
 * "Registered", the one thing it is not. The vocabulary is the document
 * surface's own (`IrpPanel`): a verified registration reads plainly, and
 * every other state carries its provider-state word and its tone —
 * destructive for a cancelled IRN, so it can never be mistaken for a live
 * one.
 */
export function IrpBadge({ row, prefix = '', placeholder = <>—</> }: IrpBadgeProps) {
  if (row.irn !== null) {
    const registered =
      row.irpProviderState === 'registered' ||
      row.irpProviderState === 'registered_unverified';
    const verified = row.irpProvider === 'whitebooks';
    // A verified, still-registered IRN keeps the blue "issued" tone it has
    // always carried; every other state renders in the tone its own word
    // earns (cancelled -> destructive, and so on).
    const chipStatus = registered && verified ? 'issued' : row.irpProviderState;
    const label = registered
      ? verified
        ? `${prefix}Registered`
        : `${prefix}Manual — unverified`
      : verified
        ? `${prefix}Whitebooks — ${row.irpProviderState}`
        : `${prefix}Manual — ${row.irpProviderState} · unverified`;
    return <StatusChip status={chipStatus}>{label}</StatusChip>;
  }
  // No IRN yet: the only statutory signal is the frozen reporting window
  // (migration 0049), and only once the invoice is submitted.
  if (row.status !== 'submitted') return <>{placeholder}</>;
  if (row.irpReportingOverdue) {
    return <StatusChip status="expired">{`${prefix}Overdue`}</StatusChip>;
  }
  if (row.irpReportingDeadline !== null) {
    return (
      <StatusChip status="review">
        {`${prefix}Due ${formatDate(row.irpReportingDeadline)}`}
      </StatusChip>
    );
  }
  return <>{placeholder}</>;
}
