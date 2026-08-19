import { useCallback, useEffect, useState } from 'react';
import type {
  AmcCycleProposalResponse,
  Contact,
  PacCertificateListResponse,
  PacCertificationBasis,
  RecordPacCertificateRequest,
  WorkItem,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { openPdf } from '../lib/openPdf.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Actions, Field, FormError, Hint } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { Disclosure } from '../ui/disclosure.js';
import { NumericInput } from '../ui/numeric-input.js';

/** Which quantity the R18 cap measures against, in the operator's own
 * words. An installable item is capped at what was installed; an AMC
 * item is never installed at all, so it is capped at the quantity the
 * LOA sanctioned (migration 0068). The column names the rule rather than
 * leaving the operator to work out why an item with nothing installed
 * still has certification available. */
const BASIS_LABELS: Record<PacCertificationBasis, string> = {
  installed: 'installed',
  sanctioned: 'sanctioned',
};

interface PacCertificatesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** PACs are railway-issued certificates recorded by office staff:
   * record and cancel run under owner/office. */
  readonly canModify: boolean;
  readonly workItems: readonly WorkItem[];
}

/**
 * PAC certificates (Milestone 8 phase 1, legacy §5.5 and rule R18): the
 * railway's provisional acceptance of installed quantities, recorded in
 * parts — reference, issue date, issuing consignee (designation
 * snapshotted from the picked master), per-item certified quantities
 * capped at installed minus already certified, optional scanned PDF.
 * Recorded certificates cancel with a note, releasing their quantities.
 */
export function PacCertificates({
  api,
  organisationId,
  workId,
  canModify,
  workItems,
}: PacCertificatesProps) {
  const [data, setData] = useState<PacCertificateListResponse | null>(null);
  /** What each maintenance schedule's cadence proposes for its next
   * period (migration 0107). A convenience read: its failure hides the
   * proposal and leaves the certificate flow itself untouched, so it is
   * defaulted rather than surfaced — an absent cadence and an unreadable
   * one both mean "no proposal to show", and the cadence is set on the
   * Work's schedules screen, not here. */
  const [proposal, setProposal] = useState<AmcCycleProposalResponse>({ schedules: [] });
  const [consignees, setConsignees] = useState<readonly Contact[]>([]);
  const [workConsignees, setWorkConsignees] = useState<readonly Contact[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, notice, actionError, act, setActionError } = useAction();
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    Promise.all([
      api.listWorkPacCertificates(organisationId, workId),
      api.listContacts(organisationId, { role: 'consignee' }).catch(() => []),
      // R16: the Work's linked consignees are offered first; any active
      // consignee stays selectable below them.
      api.listWorkConsignees(organisationId, workId).catch(() => []),
      api
        .getAmcCycleProposal(organisationId, workId)
        .catch(() => ({ schedules: [] as AmcCycleProposalResponse['schedules'] })),
    ])
      .then(([loaded, loadedConsignees, loadedWorkConsignees, loadedProposal]) => {
        if (cancelled) return;
        setData(loaded);
        setConsignees(loadedConsignees);
        setWorkConsignees(loadedWorkConsignees);
        setProposal(loadedProposal);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The PAC certificates could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const refresh = useCallback(async () => {
    setData(await api.listWorkPacCertificates(organisationId, workId));
  }, [api, organisationId, workId]);

  if (loadError !== null) {
    return (
      <>
        <h2>PAC certificates</h2>
        <ErrorState onRetry={retry} retryLabel="Retry PAC certificates">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <h2>PAC certificates</h2>
        <LoadingState label="the PAC certificates" rows={3} columns={3} />
      </>
    );
  }

  const summaryByItem = new Map(
    data.itemSummaries.map((summary) => [summary.workItemId, summary]),
  );
  // A retired contact stops being OFFERED here too. The Work list returns
  // every linked row, retired or not — the link is a preference and is
  // never destroyed — but an abolished post must not keep heading the
  // picker. The "All consignees" group below is already active-only.
  const linkedConsignees = workConsignees.filter((consignee) => consignee.active);

  return (
    <>
      <h2>PAC certificates</h2>
      <p className="text-muted-foreground">
        Railway certification, issued in parts. Per item the certified total can never
        exceed the supporting quantity in the table below — what installation records
        support for an installable item, and the sanctioned quantity for an annual
        maintenance item, which is certified rather than installed. Cancelling a
        certificate releases its quantities.
      </p>
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {/* The next period each maintenance schedule proposes (owner ruling
          of 2026-08-19). A PROPOSAL and nothing more: it writes nothing,
          the cap below is unchanged, and an operator certifying a
          different quantity is certifying what the railway accepted.
          Where the sanctioned quantity does not divide evenly into the
          cadence, the split wobbles in the third decimal and the row says
          so rather than presenting an uneven split as an even one. */}
      {proposal.schedules.map((schedule) => (
        <div key={schedule.scheduleId} className="my-3">
          <h3>
            Next {schedule.cycleNoun} · schedule {schedule.scheduleCode}
          </h3>
          <p className="text-muted-foreground">
            Maintenance billed in {schedule.billingPeriods} {schedule.cycleNoun}{' '}
            periods. These are proposals for the next certificate, not limits.
          </p>
          <DataTable>
            <caption className="sr-only">
              Proposed certified quantity for the next {schedule.cycleNoun} of schedule{' '}
              {schedule.scheduleCode}
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Period</th>
                <th scope="col" className={numericCell}>
                  Certified so far
                </th>
                <th scope="col" className={numericCell}>
                  Propose
                </th>
              </tr>
            </thead>
            <tbody>
              {schedule.items.map((item) => (
                <tr key={item.workItemId}>
                  <th scope="row">{item.itemNumber}</th>
                  <td>
                    {item.nextPeriod === null
                      ? `all ${String(schedule.billingPeriods)} certified`
                      : `${String(item.nextPeriod)} of ${String(schedule.billingPeriods)}`}
                    {!item.divides && (
                      <span className="text-muted-foreground">
                        {' '}
                        · uneven split, periods differ in the third decimal
                      </span>
                    )}
                  </td>
                  <td className={numericCell}>
                    {item.certifiedQuantity} of {item.totalQuantity}
                  </td>
                  <td className={numericCell}>{item.proposedQuantity ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      ))}

      <DataTable>
        <caption className="sr-only">
          PAC-certified quantity per item for this Work
        </caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className={numericCell}>
              Installed
            </th>
            <th scope="col">Capped against</th>
            <th scope="col" className={numericCell}>
              Supporting
            </th>
            <th scope="col" className={numericCell}>
              PAC certified
            </th>
            <th scope="col" className={numericCell}>
              Available
            </th>
          </tr>
        </thead>
        <tbody>
          {data.itemSummaries.map((summary) => (
            <tr key={summary.workItemId}>
              <th scope="row">{summary.itemNumber}</th>
              <td className={numericCell}>{summary.installedQuantity}</td>
              <td>{BASIS_LABELS[summary.certificationBasis]}</td>
              <td className={numericCell}>{summary.supportingQuantity}</td>
              <td className={numericCell}>{summary.pacCertifiedQuantity}</td>
              <td className={numericCell}>{summary.availableQuantity}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {data.certificates.length > 0 ? (
        data.certificates.map((certificate) => (
          <div key={certificate.id} className="my-3">
            <h3>
              PAC {certificate.reference} · {certificate.issueDate}
            </h3>
            <p className="text-muted-foreground">
              Issued by {certificate.consigneeDesignation} ·{' '}
              {certificate.status === 'cancelled' ? (
                <StatusChip status="cancelled" />
              ) : (
                <StatusChip status="installed">recorded</StatusChip>
              )}
              {certificate.cancellationNote !== null && (
                <span className="text-muted-foreground">
                  {' '}
                  {certificate.cancellationNote}
                </span>
              )}
            </p>
            <DataTable>
              <caption className="sr-only">
                Certified quantities on PAC {certificate.reference}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className={numericCell}>
                    Certified quantity
                  </th>
                  <th scope="col" className={numericCell}>
                    Released value
                  </th>
                </tr>
              </thead>
              <tbody>
                {certificate.items.map((line) => (
                  <tr key={line.workItemId}>
                    <th scope="row">{line.itemNumber}</th>
                    <td className={numericCell}>{line.certifiedQuantity}</td>
                    <td className={numericCell}>{line.releasedValue ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <Actions>
              {certificate.documentAvailable && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      await openPdf(() =>
                        api.downloadPacCertificateDocument(
                          organisationId,
                          certificate.id,
                        ),
                      );
                    }, 'Scanned certificate opened in a new tab.')
                  }
                >
                  Open scanned certificate
                </Button>
              )}
            </Actions>
            {canModify && certificate.status === 'recorded' && (
              <>
                <Disclosure label="Upload scanned certificate…">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const input =
                        event.currentTarget.elements.namedItem('pac-document');
                      const file =
                        input instanceof HTMLInputElement
                          ? (input.files?.[0] ?? null)
                          : null;
                      if (file === null) {
                        setActionError('Choose the scanned certificate first.');
                        return;
                      }
                      void act(async () => {
                        await api.uploadPacCertificateDocument(
                          organisationId,
                          certificate.id,
                          file,
                        );
                        await refresh();
                      }, 'Scanned certificate uploaded.');
                    }}
                  >
                    <Field>
                      <label htmlFor={`pac-document-${certificate.id}`}>
                        Scanned certificate (PDF) for {certificate.reference}
                      </label>
                      <input
                        id={`pac-document-${certificate.id}`}
                        name="pac-document"
                        type="file"
                        accept="application/pdf"
                      />
                    </Field>
                    <Actions>
                      <Button type="submit" variant="outline" disabled={pending}>
                        Upload scanned certificate
                      </Button>
                    </Actions>
                  </form>
                </Disclosure>
                <Disclosure label="Cancel certificate…">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const note = formValue(
                        new FormData(event.currentTarget),
                        `pac-cancel-note-${certificate.id}`,
                      ).trim();
                      void act(async () => {
                        await api.cancelPacCertificate(
                          organisationId,
                          certificate.id,
                          note,
                        );
                        await refresh();
                      }, 'PAC certificate cancelled; its certified quantities are released.');
                    }}
                  >
                    <Field>
                      <label htmlFor={`pac-cancel-note-${certificate.id}`}>
                        Cancellation note for PAC {certificate.reference}
                      </label>
                      <input
                        id={`pac-cancel-note-${certificate.id}`}
                        name={`pac-cancel-note-${certificate.id}`}
                        required
                        minLength={3}
                        maxLength={1000}
                      />
                    </Field>
                    <Button type="submit" variant="outline" disabled={pending}>
                      Cancel certificate
                    </Button>
                  </form>
                </Disclosure>
              </>
            )}
          </div>
        ))
      ) : (
        <p className="text-muted-foreground">No PAC certificates recorded yet.</p>
      )}

      {canModify && workItems.length > 0 && (
        <Disclosure
          label="New PAC certificate"
          startOpen={data.certificates.length === 0}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const formData = new FormData(form);
              const items = workItems
                .map((item) => ({
                  workItemId: item.id,
                  certifiedQuantity: formValue(formData, `pac-qty-${item.id}`).trim(),
                }))
                .filter((line) => line.certifiedQuantity.length > 0);
              if (items.length === 0) {
                setActionError('Enter a certified quantity for at least one item.');
                return;
              }
              const body: RecordPacCertificateRequest = {
                reference: formValue(formData, 'pac-reference').trim(),
                issueDate: formValue(formData, 'pac-date'),
                consigneeMasterId: formValue(formData, 'pac-consignee'),
                items,
              };
              void act(async () => {
                await api.recordWorkPacCertificate(organisationId, workId, body);
                await refresh();
                form.reset();
              }, 'PAC certificate recorded.');
            }}
          >
            <Field>
              <label htmlFor="pac-reference">Certificate reference</label>
              <input
                id="pac-reference"
                name="pac-reference"
                required
                minLength={1}
                maxLength={100}
              />
            </Field>
            <Field>
              <label htmlFor="pac-date">Issue date</label>
              <input id="pac-date" name="pac-date" type="date" required />
            </Field>
            <Field>
              <label htmlFor="pac-consignee">Issuing consignee</label>
              <select id="pac-consignee" name="pac-consignee" required>
                {linkedConsignees.length > 0 && (
                  <optgroup label="Linked to this Work">
                    {linkedConsignees.map((consignee) => (
                      <option key={consignee.id} value={consignee.id}>
                        {consignee.designation}
                        {consignee.address !== null ? ` — ${consignee.address}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All consignees">
                  {consignees.map((consignee) => (
                    <option key={`all-${consignee.id}`} value={consignee.id}>
                      {consignee.designation}
                      {consignee.address !== null ? ` — ${consignee.address}` : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
              <Hint>
                Consignees linked to this Work are listed first; any active consignee
                can be picked. The certificate snapshots the designation.
              </Hint>
            </Field>
            <fieldset>
              <legend>
                Certified quantities — leave an item blank to omit it; each entry is
                capped at the supporting quantity minus what is already certified
              </legend>
              {workItems.map((item) => {
                const summary = summaryByItem.get(item.id);
                return (
                  <Field key={item.id}>
                    <label htmlFor={`pac-qty-${item.id}`}>
                      {item.itemNumber} —{' '}
                      {item.effectiveDescription ?? item.description}
                      {summary !== undefined
                        ? ` (${BASIS_LABELS[summary.certificationBasis]} ${summary.supportingQuantity}, certified ${summary.pacCertifiedQuantity}, available ${summary.availableQuantity})`
                        : ''}
                    </label>
                    <NumericInput
                      id={`pac-qty-${item.id}`}
                      name={`pac-qty-${item.id}`}
                    />
                  </Field>
                );
              })}
            </fieldset>
            <Actions>
              <Button type="submit" disabled={pending}>
                Record PAC certificate
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
    </>
  );
}
