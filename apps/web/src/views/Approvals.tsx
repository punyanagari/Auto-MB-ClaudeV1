import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRequest, VariationOrder } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { DataTable } from '../ui/table.js';
import { Field, Actions, FormError, FormNotice } from '../ui/form.js';

interface ApprovalsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly currentUserId: string;
  readonly canApprove: boolean;
  /** Called after any decision so the caller can refresh the nav badge. */
  readonly onChanged: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  quantity: 'Quantity',
  rate: 'Rate (₹)',
  description: 'Description',
  unit: 'Unit',
  item: 'Item number',
  challanDate: 'Challan date',
  prefix: 'Number prefix',
  consignee: 'Consignee',
  items: 'Lines',
  lines: 'Lines',
  movementType: 'Movement type',
  issuedToName: 'Issued to',
  issuedToRole: 'Issued-to role',
  location: 'Location',
  remarks: 'Remarks',
  statement: 'Correction statement',
};

const TYPE_LABELS: Record<ApprovalRequest['entityType'], string> = {
  work_item_amendment: 'Item amendment',
  challan_cancel_replace: 'Challan cancel & replace',
  issue_challan_cancel_replace: 'Issue Challan cancel & replace',
  challan_correction_notice: 'Correction notice',
};

/** Whether this request is the kind that needs a railway variation order:
 * an item omission. The proposal snapshot is the authority — the server
 * reads the same field. */
function isOmission(approval: ApprovalRequest): boolean {
  const proposed = approval.proposed;
  return (
    typeof proposed === 'object' &&
    proposed !== null &&
    (proposed as { kind?: unknown }).kind === 'remove_item'
  );
}

/** The cited order, beside the omission it authorises, so an approver can
 * see what the railway actually sanctioned before deciding. Every value
 * here was extracted from the uploaded PDF and matched against the Work;
 * none was typed. */
function CitedVariationOrder({
  order,
  pending,
  onOpen,
}: {
  readonly order: VariationOrder;
  readonly pending: boolean;
  readonly onOpen: () => void;
}) {
  const advisory = order.verdict.claims.filter(
    (claim) => !claim.required && !claim.verified,
  );
  return (
    <section aria-label="Cited variation order">
      <h3>Variation order</h3>
      <DataTable>
        <caption className="sr-only">
          The railway variation order cited for this omission
        </caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Read from the order</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Agreement</th>
            <td className="font-mono text-[13px] tabular-nums">
              {order.agreementNumber}
            </td>
          </tr>
          <tr>
            <th scope="row">Variation</th>
            <td className="font-mono text-[13px] tabular-nums">
              {order.variationNumber}
            </td>
          </tr>
          <tr>
            <th scope="row">LOA number</th>
            <td className="font-mono text-[13px] tabular-nums">{order.loaNumber}</td>
          </tr>
          <tr>
            <th scope="row">LOA date</th>
            <td className="font-mono text-[13px] tabular-nums">
              {formatDate(order.loaDate)}
            </td>
          </tr>
        </tbody>
      </DataTable>
      {advisory.map((claim) => (
        <p key={claim.code} className="text-muted-foreground">
          {claim.detail}
        </p>
      ))}
      <Actions>
        <Button variant="outline" disabled={pending} onClick={onOpen}>
          Open {order.originalFilename}
        </Button>
      </Actions>
    </section>
  );
}

/** The upload that makes an omission approvable. There is no field to type
 * a letter number into, deliberately: the server reads the order's own LOA
 * number, date, agreement number and variation number out of the PDF and
 * checks them, plus the omitted item's row, against this Work. */
function CiteVariationOrderForm({
  approval,
  pending,
  onCite,
}: {
  readonly approval: ApprovalRequest;
  readonly pending: boolean;
  readonly onCite: (file: File) => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem(
          `variation-order-${approval.id}`,
        );
        const file =
          input instanceof HTMLInputElement ? (input.files?.[0] ?? null) : null;
        if (file !== null) onCite(file);
      }}
    >
      <p className="text-muted-foreground">
        This omission cannot be approved until the railway variation order that
        authorises it has been uploaded. Upload the machine-readable order issued by
        IREPS — a scan or photograph carries no text to verify.
      </p>
      <Field>
        <label htmlFor={`variation-order-${approval.id}`}>Variation order (PDF)</label>
        <input
          id={`variation-order-${approval.id}`}
          name={`variation-order-${approval.id}`}
          type="file"
          accept="application/pdf"
          required
        />
      </Field>
      <Actions>
        <Button type="submit" disabled={pending}>
          Cite variation order
        </Button>
      </Actions>
    </form>
  );
}

/** One pending request: diff rendering plus the decision controls. */
function ApprovalCard({
  approval,
  currentUserId,
  canApprove,
  pending,
  onApprove,
  onReject,
  onWithdraw,
  onCite,
  onOpenOrder,
}: {
  readonly approval: ApprovalRequest;
  readonly currentUserId: string;
  readonly canApprove: boolean;
  readonly pending: boolean;
  readonly onApprove: (note: string) => void;
  readonly onReject: (note: string) => void;
  readonly onWithdraw: () => void;
  readonly onCite: (file: File) => void;
  readonly onOpenOrder: () => void;
}) {
  const [note, setNote] = useState('');
  const isRequester = approval.requestedByUserId === currentUserId;
  const omissionNeedsOrder = isOmission(approval) && approval.variationOrder == null;
  return (
    <article
      className="rounded-xl border border-border bg-card p-5 shadow-sm print:border-0 print:p-0 print:shadow-none"
      aria-label={`${TYPE_LABELS[approval.entityType]} for ${approval.workCode}`}
    >
      <h2>
        {approval.workCode}
        {approval.itemNumber !== null && (
          <span className="text-muted-foreground"> · item {approval.itemNumber}</span>
        )}
        {approval.documentNumber != null && approval.documentNumber.length > 0 && (
          <span className="text-muted-foreground"> · {approval.documentNumber}</span>
        )}
      </h2>
      <p className="text-muted-foreground">{TYPE_LABELS[approval.entityType]}</p>
      <p>{approval.reason}</p>
      <p className="text-muted-foreground">
        Requested by {isRequester ? 'you' : approval.requestedByUserId}
      </p>
      <DataTable>
        <caption className="sr-only">
          Proposed changes for {approval.workCode}
          {approval.itemNumber !== null ? ` item ${approval.itemNumber}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Current</th>
            <th scope="col">Proposed</th>
          </tr>
        </thead>
        <tbody>
          {approval.diff.map((entry) => (
            <tr key={entry.field}>
              <th scope="row">{FIELD_LABELS[entry.field] ?? entry.field}</th>
              <td>{entry.before ?? '—'}</td>
              <td>
                <strong>{entry.after ?? '—'}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {/* `!= null` rather than `!== null`: a client cached from before
          this field existed sends undefined, and a blank card is a better
          answer than a crash. */}
      {approval.variationOrder != null && (
        <CitedVariationOrder
          order={approval.variationOrder}
          pending={pending}
          onOpen={onOpenOrder}
        />
      )}
      {omissionNeedsOrder && (
        <CiteVariationOrderForm approval={approval} pending={pending} onCite={onCite} />
      )}
      {canApprove && (
        <Field>
          <label htmlFor={`decision-note-${approval.id}`}>
            Decision note (required to reject)
          </label>
          <input
            id={`decision-note-${approval.id}`}
            value={note}
            maxLength={1000}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </Field>
      )}
      <Actions>
        {canApprove && (
          <>
            {/* The server refuses this by name regardless; disabling it
                keeps the approver from meeting a 409 they could have been
                told about, and the sentence above says why. */}
            <Button
              disabled={pending || omissionNeedsOrder}
              onClick={() => {
                onApprove(note.trim());
              }}
            >
              Approve and apply
            </Button>
            <Button
              variant="outline"
              disabled={pending || note.trim().length < 3}
              onClick={() => {
                onReject(note.trim());
              }}
            >
              Reject
            </Button>
          </>
        )}
        {isRequester && (
          <Button variant="outline" disabled={pending} onClick={onWithdraw}>
            Withdraw
          </Button>
        )}
      </Actions>
    </article>
  );
}

/** The approvals queue: pending amendment requests awaiting a decision.
 * Approving applies the change atomically; a failed apply (e.g. the
 * delivered quantity moved) leaves the request pending with the server's
 * explanation shown. */
export function Approvals({
  api,
  organisationId,
  currentUserId,
  canApprove,
  onChanged,
}: ApprovalsProps) {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    const loaded = await api.listApprovals(organisationId, 'pending');
    setApprovals(loaded);
  }, [api, organisationId]);

  useEffect(() => {
    let cancelled = false;
    setApprovals(null);
    setLoadError(null);
    api
      .listApprovals(organisationId, 'pending')
      .then((loaded) => {
        if (!cancelled) setApprovals(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The approvals queue could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId]);

  /** Opens the cited order in a new tab. The endpoint needs the
   * organisation header, so the bytes are fetched and handed to the
   * browser as an object URL rather than linked to directly. */
  async function openVariationOrder(approvalId: string): Promise<void> {
    setActionError(null);
    try {
      const blob = await api.downloadVariationOrderFile(organisationId, approvalId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // Revoked on the next tick: the new tab has already taken the bytes.
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 60_000);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The cited variation order could not be opened.',
      );
    }
  }

  async function act(work: () => Promise<void>, done: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      await reload();
      setNotice(done);
      onChanged();
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The decision failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full" aria-labelledby="approvals-title">
      <h1 id="approvals-title" tabIndex={-1}>
        Approvals
      </h1>
      <p className="text-muted-foreground">
        Pending amendment and correction requests. Approving applies the change
        immediately; original awarded values and issued snapshots are never overwritten.
      </p>

      {loadError !== null && <FormError>{loadError}</FormError>}
      {approvals === null && loadError === null && (
        <p className="text-muted-foreground" role="status">
          Loading approvals…
        </p>
      )}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {actionError !== null && <FormError>{actionError}</FormError>}

      {approvals !== null && approvals.length === 0 && (
        <p className="text-muted-foreground">Nothing is waiting for a decision.</p>
      )}
      {approvals !== null &&
        approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            currentUserId={currentUserId}
            canApprove={canApprove}
            pending={pending}
            onOpenOrder={() => {
              void openVariationOrder(approval.id);
            }}
            onCite={(file) => {
              void act(async () => {
                await api.attachVariationOrder(
                  organisationId,
                  approval.id,
                  file,
                  file.name,
                );
              }, `Variation order cited for ${approval.workCode}; the omission can now be approved.`);
            }}
            onApprove={(note) => {
              void act(async () => {
                await api.approveAmendment(
                  organisationId,
                  approval.id,
                  note.length >= 3 ? note : undefined,
                );
              }, `Amendment for ${approval.workCode} approved and applied.`);
            }}
            onReject={(note) => {
              void act(async () => {
                await api.rejectAmendment(organisationId, approval.id, note);
              }, `Amendment for ${approval.workCode} rejected.`);
            }}
            onWithdraw={() => {
              void act(async () => {
                await api.withdrawAmendment(organisationId, approval.id);
              }, `Your request for ${approval.workCode} was withdrawn.`);
            }}
          />
        ))}
    </Card>
  );
}
