import { useCallback, useEffect, useState } from 'react';
import type {
  SaveWarrantyTermsRequest,
  WarrantyStartBasis,
  WorkWarrantyResponse,
} from '@auto-mb/contracts';
import { formValue, type ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { WARRANTY_BASIS_LABELS, warrantyCountdown } from '../lib/warranty.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DateField } from '../ui/date-field.js';
import { Disclosure } from '../ui/disclosure.js';
import { Actions, Field, FormError, Hint } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';

/**
 * The Work's defect liability card, rendered inside its Instruments tab.
 *
 * It lives beside the Performance Bank Guarantee deliberately rather than
 * on a section of its own: the DLP is the reason the guarantee is still
 * with the railway, and the two facts an office compares — when cover ends
 * and when the guarantee lapses — are useless a tab apart.
 *
 * Four areas, in the order the work is done:
 *
 *   1. **The term.** How many months the contract warrants and what starts
 *      the clock. Editing it never reaches a period already running.
 *   2. **Guarantee cover.** The Work's furthest DLP expiry against the
 *      live PBG's, and the shortfall between them when there is one.
 *   3. **Start the clock.** The recorded installations with no period on
 *      them yet, oldest first.
 *   4. **The periods**, with the three acts a live one takes: extend it
 *      after a defect, discharge it when it has run out, or void it.
 *
 * Every number and date here comes from the server. Nothing on this screen
 * does date arithmetic — the expiry, the countdown and the standing are
 * all read, never computed, because the organisation's own calendar day is
 * the one that decides them and the browser's is not.
 */

/** How many periods the card reads at once.
 *
 * Bounded, because a Work's periods grow with its installations and the
 * card is a section of a page rather than the register. Sending no limit
 * at all asks for the whole table and never renders the line below the
 * table that points at the register — the branch would be dead and the
 * read unbounded, which is the pair worth avoiding. */
const CARD_PAGE_SIZE = 100;

interface WorkWarrantyProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Owner or office. Every act here sets or moves a date the railway's
   * guarantee is measured against, so none of them is site work. */
  readonly canModify: boolean;
}

export function WorkWarranty({
  api,
  organisationId,
  workId,
  canModify,
}: WorkWarrantyProps) {
  const [data, setData] = useState<WorkWarrantyResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, notice, actionError, act, setActionError } = useAction();
  const [loadVersion, retry] = useReload();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    api
      .getWorkWarranty(organisationId, workId, { limit: CARD_PAGE_SIZE })
      .then((loaded) => {
        if (cancelled) return;
        setData(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          errorMessage(cause, 'The defect liability periods could not be loaded.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const refresh = useCallback(async () => {
    setData(
      await api.getWorkWarranty(organisationId, workId, { limit: CARD_PAGE_SIZE }),
    );
  }, [api, organisationId, workId]);

  if (loadError !== null) {
    return (
      <>
        <h2>Defect liability</h2>
        <ErrorState onRetry={retry} retryLabel="Retry defect liability">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <h2>Defect liability</h2>
        <LoadingState label="the defect liability periods" rows={3} columns={4} />
      </>
    );
  }

  const { terms, pbgCover } = data;

  return (
    <>
      <h2>Defect liability</h2>
      <p className="text-muted-foreground">
        The warranty that runs on each installed quantity, and the Performance Bank
        Guarantee that has to outlive it. A period ends on the last day it covers;
        extending one after a defect moves that day forward.
      </p>
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}

      {/* 1. The contract term. */}
      <section
        className="data-surface mt-3 mb-4 p-4"
        aria-label="Defect liability term"
      >
        {terms === null ? (
          <p className="m-0 text-muted-foreground">
            No defect liability term is recorded for this Work, so no period can be
            started. Read the months and the starting point off the contract.
          </p>
        ) : (
          <dl className="m-0 flex flex-col gap-2 p-0 text-xs">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
              <dt className="text-muted-foreground">Warranty period</dt>
              <dd className="m-0 font-medium">
                {String(terms.dlpMonths)} months from{' '}
                {WARRANTY_BASIS_LABELS[terms.startBasis]}
              </dd>
            </div>
            {terms.notes !== null && (
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
                <dt className="text-muted-foreground">Clause note</dt>
                <dd className="m-0 font-medium">{terms.notes}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {canModify && (
        <Disclosure
          label={terms === null ? 'Record defect liability term' : 'Revise the term…'}
          startOpen={terms === null}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              const months = Number(formValue(formData, 'dlp-months'));
              if (!Number.isInteger(months) || months < 1 || months > 120) {
                setActionError(
                  'Enter the warranty period as a whole number of months, between 1 and 120.',
                );
                return;
              }
              const notes = formValue(formData, 'dlp-notes').trim();
              const body: SaveWarrantyTermsRequest = {
                dlpMonths: months,
                startBasis: formValue(formData, 'dlp-basis') as WarrantyStartBasis,
                ...(notes.length > 0 ? { notes } : {}),
              };
              void act(async () => {
                await api.saveWarrantyTerms(organisationId, workId, body);
                await refresh();
              }, 'Defect liability term recorded.');
            }}
          >
            <Field>
              <label htmlFor="dlp-months">Warranty period (months)</label>
              <input
                id="dlp-months"
                name="dlp-months"
                type="number"
                min={1}
                max={120}
                required
                defaultValue={terms?.dlpMonths ?? 24}
              />
            </Field>
            <Field>
              <label htmlFor="dlp-basis">The period starts from</label>
              <select
                id="dlp-basis"
                name="dlp-basis"
                required
                defaultValue={terms?.startBasis ?? 'installation'}
              >
                <option value="installation">The installation date</option>
                <option value="pac">
                  The PAC certificate date (provisional acceptance)
                </option>
              </select>
              <Hint>
                Periods already started keep the term they began under; this changes
                only the ones started from now on.
              </Hint>
            </Field>
            <Field>
              <label htmlFor="dlp-notes">Clause note (optional)</label>
              <input
                id="dlp-notes"
                name="dlp-notes"
                maxLength={1000}
                defaultValue={terms?.notes ?? ''}
              />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Save term
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}

      {/* 2. Guarantee cover. */}
      <section className="data-surface mb-4 p-4" aria-label="Guarantee cover">
        <dl className="m-0 flex flex-col gap-2 p-0 text-xs">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-muted-foreground">Warranty cover runs to</dt>
            <dd className="m-0 font-medium">
              {pbgCover.dlpCoverUntil !== null
                ? formatDate(pbgCover.dlpCoverUntil)
                : 'No period started'}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
            <dt className="text-muted-foreground">Performance guarantee</dt>
            <dd className="m-0 font-medium">
              {pbgCover.instrumentReference !== null &&
              pbgCover.instrumentExpiresOn !== null
                ? `${pbgCover.instrumentReference} expires ${formatDate(pbgCover.instrumentExpiresOn)}`
                : pbgCover.requiredByLetter
                  ? 'No live guarantee with an expiry date on record'
                  : 'The letter demands none'}
            </dd>
          </div>
        </dl>
        {pbgCover.shortfallDays !== null && (
          <p className="mt-3 mb-0 border-t border-border pt-3 text-xs">
            <StatusChip status="expiring">
              Short by {String(pbgCover.shortfallDays)} days
            </StatusChip>{' '}
            <span className="text-muted-foreground">
              The guarantee lapses before the warranty does. Ask the bank to extend it,
              or record the extended instrument above.
            </span>
          </p>
        )}
      </section>

      {/* 3. Start the clock. */}
      {canModify && terms !== null && data.candidates.length > 0 && (
        <Disclosure
          label="Start a defect liability period…"
          startOpen={data.warranties.length === 0}
        >
          <p className="text-muted-foreground">
            Recorded installations with no period on them, oldest first.
            {data.candidatesTruncated &&
              ' More are waiting than are listed; start these and the next ones appear.'}
          </p>
          <DataTable>
            <caption className="sr-only">
              Installations waiting for a defect liability period
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className={numericCell}>
                  Quantity
                </th>
                <th scope="col">Installed on</th>
                <th scope="col">Location</th>
                <th scope="col">
                  {terms.startBasis === 'pac' ? 'Start from' : 'Action'}
                </th>
                {terms.startBasis === 'pac' && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((candidate) => (
                <StartWarrantyRow
                  key={candidate.installationId}
                  candidate={candidate}
                  basis={terms.startBasis}
                  pending={pending}
                  onStart={(pacCertificateId) =>
                    void act(async () => {
                      await api.startInstallationWarranty(
                        organisationId,
                        candidate.installationId,
                        pacCertificateId === null ? {} : { pacCertificateId },
                      );
                      await refresh();
                    }, `Defect liability period started for ${candidate.itemNumber}.`)
                  }
                />
              ))}
            </tbody>
          </DataTable>
        </Disclosure>
      )}

      {/* 4. The periods. */}
      {data.warranties.length > 0 ? (
        <>
          <DataTable>
            <caption className="sr-only">
              Defect liability periods for this Work, with the item, the dates they run
              between, their standing and the time left
            </caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className={numericCell}>
                  Quantity
                </th>
                <th scope="col">Starts</th>
                <th scope="col">Runs to</th>
                <th scope="col">Standing</th>
                <th scope="col">Countdown</th>
                <th scope="col">Location</th>
              </tr>
            </thead>
            <tbody>
              {data.warranties.map((warranty) => (
                <tr key={warranty.id}>
                  <th scope="row">{warranty.itemNumber}</th>
                  <td className={numericCell}>{warranty.quantity}</td>
                  <td>
                    {formatDate(warranty.dlpStartOn)}
                    {warranty.pacReference !== null && (
                      <span className="text-muted-foreground">
                        {' '}
                        · PAC {warranty.pacReference}
                      </span>
                    )}
                  </td>
                  <td>
                    {formatDate(warranty.dlpExpiresOn)}
                    {warranty.dlpExpiresOn !== warranty.originalExpiresOn && (
                      <span className="text-muted-foreground">
                        {' '}
                        · extended from {formatDate(warranty.originalExpiresOn)}
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusChip status={warranty.standing} />
                  </td>
                  <td>{warrantyCountdown(warranty.daysToExpiry)}</td>
                  <td className={wrapCell}>{warranty.locationName}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {data.nextCursor !== null && (
            <p className="text-muted-foreground">
              Only the most recent periods are shown here. The Warranties register reads
              every one of them, with a filter.
            </p>
          )}
          {canModify &&
            data.warranties
              .filter((warranty) => warranty.status === 'active')
              .map((warranty) => (
                <div key={`acts-${warranty.id}`} className="my-3">
                  <h3>
                    {warranty.itemNumber} · runs to {formatDate(warranty.dlpExpiresOn)}
                  </h3>
                  <Disclosure label="Extend after a defect…">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const formData = new FormData(event.currentTarget);
                        void act(async () => {
                          await api.extendWarranty(organisationId, warranty.id, {
                            expiresOn: formValue(formData, `extend-to-${warranty.id}`),
                            reason: formValue(
                              formData,
                              `extend-reason-${warranty.id}`,
                            ).trim(),
                          });
                          await refresh();
                        }, `The period for ${warranty.itemNumber} was extended.`);
                      }}
                    >
                      <DateField
                        id={`extend-to-${warranty.id}`}
                        name={`extend-to-${warranty.id}`}
                        label={`New last covered day for ${warranty.itemNumber}`}
                        required
                        hint="After the day the period already runs to, and within ten years of its start."
                      />
                      <Field>
                        <label htmlFor={`extend-reason-${warranty.id}`}>
                          Why the period is extended
                        </label>
                        <input
                          id={`extend-reason-${warranty.id}`}
                          name={`extend-reason-${warranty.id}`}
                          required
                          minLength={3}
                          maxLength={500}
                        />
                        <Hint>
                          Recorded on the Work&rsquo;s Timeline, which is where a moved
                          expiry is explained.
                        </Hint>
                      </Field>
                      <Actions>
                        <Button type="submit" variant="outline" disabled={pending}>
                          Extend period
                        </Button>
                      </Actions>
                    </form>
                  </Disclosure>
                  <Disclosure label="Discharge the period…">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const formData = new FormData(event.currentTarget);
                        void act(async () => {
                          await api.closeWarranty(organisationId, warranty.id, {
                            closedOn: formValue(formData, `close-on-${warranty.id}`),
                            note: formValue(
                              formData,
                              `close-note-${warranty.id}`,
                            ).trim(),
                          });
                          await refresh();
                        }, `The period for ${warranty.itemNumber} is discharged.`);
                      }}
                    >
                      <DateField
                        id={`close-on-${warranty.id}`}
                        name={`close-on-${warranty.id}`}
                        label={`Discharged on, for ${warranty.itemNumber}`}
                        required
                        hint={`On or after ${formatDate(warranty.dlpExpiresOn)}, and never in the future.`}
                      />
                      <Field>
                        <label htmlFor={`close-note-${warranty.id}`}>
                          What the discharge rests on
                        </label>
                        <input
                          id={`close-note-${warranty.id}`}
                          name={`close-note-${warranty.id}`}
                          required
                          minLength={3}
                          maxLength={1000}
                        />
                      </Field>
                      <Actions>
                        <Button type="submit" variant="outline" disabled={pending}>
                          Discharge period
                        </Button>
                      </Actions>
                    </form>
                  </Disclosure>
                  <Disclosure label="Void the period…">
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const note = formValue(
                          new FormData(event.currentTarget),
                          `void-note-${warranty.id}`,
                        ).trim();
                        void act(async () => {
                          await api.voidWarranty(organisationId, warranty.id, note);
                          await refresh();
                        }, `The period for ${warranty.itemNumber} is voided.`);
                      }}
                    >
                      <Field>
                        <label htmlFor={`void-note-${warranty.id}`}>
                          Why the period is voided
                        </label>
                        <input
                          id={`void-note-${warranty.id}`}
                          name={`void-note-${warranty.id}`}
                          required
                          minLength={3}
                          maxLength={1000}
                        />
                        <Hint>
                          Voiding is how a period started in error is undone, and it is
                          what releases the installation record to be cancelled. A
                          discharged period cannot be voided.
                        </Hint>
                      </Field>
                      <Actions>
                        <Button type="submit" variant="outline" disabled={pending}>
                          Void period
                        </Button>
                      </Actions>
                    </form>
                  </Disclosure>
                </div>
              ))}
        </>
      ) : (
        <p className="text-muted-foreground">
          No defect liability period has been started on this Work.
        </p>
      )}
    </>
  );
}

interface StartWarrantyRowProps {
  readonly candidate: WorkWarrantyResponse['candidates'][number];
  readonly basis: WarrantyStartBasis;
  readonly pending: boolean;
  readonly onStart: (pacCertificateId: string | null) => void;
}

/** One un-started installation. On the PAC basis it carries the picker for
 * the certificate the clock starts from, and the action is disabled while
 * no certificate exists to pick — a period cannot start from a certificate
 * the railway has not issued. */
function StartWarrantyRow({
  candidate,
  basis,
  pending,
  onStart,
}: StartWarrantyRowProps) {
  const [certificateId, setCertificateId] = useState(candidate.pacOptions[0]?.id ?? '');
  const blocked = basis === 'pac' && candidate.pacOptions.length === 0;
  return (
    <tr>
      <th scope="row">{candidate.itemNumber}</th>
      <td className={numericCell}>{candidate.quantity}</td>
      <td>{formatDate(candidate.installedOn)}</td>
      <td className={wrapCell}>{candidate.locationName}</td>
      {basis === 'pac' && (
        <td>
          {blocked ? (
            <span className="text-muted-foreground">
              No PAC certificate certifies this item yet
            </span>
          ) : (
            <>
              <label
                className="sr-only"
                htmlFor={`warranty-pac-${candidate.installationId}`}
              >
                PAC certificate for {candidate.itemNumber}
              </label>
              <select
                id={`warranty-pac-${candidate.installationId}`}
                value={certificateId}
                onChange={(event) => {
                  setCertificateId(event.target.value);
                }}
              >
                {candidate.pacOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.reference} · {formatDate(option.issueDate)}
                  </option>
                ))}
              </select>
            </>
          )}
        </td>
      )}
      <td>
        <Button
          variant="outline"
          disabled={pending || blocked}
          onClick={() => {
            onStart(basis === 'pac' ? certificateId : null);
          }}
        >
          Start period
        </Button>
      </td>
    </tr>
  );
}
