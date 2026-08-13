import type {
  Instrument,
  InstrumentStatus,
  WorkDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import { formValue, type ApiClient } from '../api.js';
import { formatInr } from '../format.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { DataTable, numericCell } from '../ui/table.js';
import { Actions, Field } from '../ui/form.js';
import { Disclosure } from '../ui/disclosure.js';
import { PacCertificates } from './PacCertificates.js';

interface WorkInstrumentsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly work: WorkDetailResponse['work'];
  readonly workItems: readonly WorkItem[];
  readonly instruments: readonly Instrument[];
  readonly setInstruments: Dispatch<SetStateAction<readonly Instrument[]>>;
  readonly canModify: boolean;
  readonly canCreateDocuments: boolean;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** The Work's contract instruments — the letter's PBG requirement, the
 * instruments recorded against it, and the acceptance certificates. Split
 * out of WorkDetail, which was rendering eleven areas from one file. */
export function WorkInstruments({
  api,
  organisationId,
  workId,
  work,
  workItems,
  instruments,
  setInstruments,
  canModify,
  canCreateDocuments,
  pending,
  act,
}: WorkInstrumentsProps) {
  return (
    <>
      <h2>Contract instruments</h2>
      {typeof work.pbgRequiredAmount === 'string' ? (
        <dl
          className="mt-3 mb-4 flex flex-wrap gap-x-8 gap-y-4 p-0 [&>div]:min-w-32 [&_dt]:mb-0.5 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:tracking-[0.025em] [&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:m-0 [&_dd]:text-sm [&_dd]:font-medium"
          aria-label="PBG requirement from the letter"
        >
          <div>
            <dt>PBG required by the letter</dt>
            <dd>{formatInr(work.pbgRequiredAmount)}</dd>
          </div>
          <div>
            <dt>Submission window</dt>
            <dd>
              {work.pbgSubmissionDays !== null
                ? `${String(work.pbgSubmissionDays)} days from the letter date`
                : '—'}
              {work.pbgExtensionDays !== null &&
                ` (+${String(work.pbgExtensionDays)} days extension)`}
            </dd>
          </div>
          <div>
            <dt>Penal interest</dt>
            <dd>
              {work.pbgPenalInterestPercent !== null
                ? `${work.pbgPenalInterestPercent}% p.a.`
                : '—'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-muted-foreground">
          The letter records no Performance Bank Guarantee requirement.
        </p>
      )}
      {instruments.length > 0 ? (
        <DataTable>
          <caption className="sr-only">
            Bank guarantees and certificates held for this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Reference</th>
              <th scope="col" className={numericCell}>
                Amount
              </th>
              <th scope="col">Issued</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              {canModify && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {instruments.map((instrument) => (
              <tr key={instrument.id}>
                <td>{INSTRUMENT_LABELS[instrument.kind]}</td>
                <th scope="row">{instrument.reference}</th>
                <td className={numericCell}>
                  {instrument.amount !== null ? formatInr(instrument.amount) : '—'}
                </td>
                <td>{instrument.issuedOn}</td>
                <td>{instrument.expiresOn ?? '—'}</td>
                <td>
                  <StatusChip status={instrument.status} />
                </td>
                {canModify && (
                  <td>
                    {instrument.status === 'active' ? (
                      <InstrumentStatusEditor
                        instrument={instrument}
                        pending={pending}
                        onApply={(status) =>
                          void act(async () => {
                            const updated = await api.updateInstrument(
                              organisationId,
                              instrument.id,
                              { status },
                            );
                            setInstruments((current) =>
                              current.map((candidate) =>
                                candidate.id === updated.id ? updated : candidate,
                              ),
                            );
                          }, `${instrument.reference} marked ${status}.`)
                        }
                      />
                    ) : (
                      <span className="text-muted-foreground">final</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          No PBG, PAC, or document instruments recorded yet.
        </p>
      )}
      {canModify && (
        <Disclosure label="New instrument" startOpen={instruments.length === 0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const kind = formValue(data, 'instrument-kind') || 'pbg';
              const reference = formValue(data, 'instrument-reference');
              const amount = formValue(data, 'instrument-amount').trim();
              const issuedOn = formValue(data, 'instrument-issued');
              const expiresOn = formValue(data, 'instrument-expires');
              const notes = formValue(data, 'instrument-notes').trim();
              void act(async () => {
                const created = await api.createInstrument(organisationId, workId, {
                  kind: kind as Instrument['kind'],
                  reference,
                  issuedOn,
                  ...(amount.length > 0 ? { amount } : {}),
                  ...(expiresOn.length > 0 ? { expiresOn } : {}),
                  ...(notes.length > 0 ? { notes } : {}),
                });
                setInstruments((current) => [...current, created]);
                form.reset();
              }, `${reference} recorded.`);
            }}
          >
            <Field>
              <label htmlFor="instrument-kind">Kind</label>
              <select id="instrument-kind" name="instrument-kind" required>
                <option value="pbg">PBG — Performance Bank Guarantee</option>
                <option value="pac">PAC — Provisional Acceptance Certificate</option>
                <option value="doc">DOC — other contract document</option>
              </select>
            </Field>
            <Field>
              <label htmlFor="instrument-reference">Reference</label>
              <input
                id="instrument-reference"
                name="instrument-reference"
                required
                maxLength={200}
              />
            </Field>
            <Field>
              <label htmlFor="instrument-amount">Amount (₹, optional)</label>
              <input
                id="instrument-amount"
                name="instrument-amount"
                inputMode="decimal"
              />
            </Field>
            <Field>
              <label htmlFor="instrument-issued">Issued on</label>
              <input
                id="instrument-issued"
                name="instrument-issued"
                type="date"
                required
              />
            </Field>
            <Field>
              <label htmlFor="instrument-expires">Expires on (optional)</label>
              <input id="instrument-expires" name="instrument-expires" type="date" />
            </Field>
            <Field>
              <label htmlFor="instrument-notes">Notes (optional)</label>
              <input id="instrument-notes" name="instrument-notes" maxLength={2000} />
            </Field>
            <Actions>
              <Button type="submit" disabled={pending}>
                Add instrument
              </Button>
            </Actions>
          </form>
        </Disclosure>
      )}
      <PacCertificates
        api={api}
        organisationId={organisationId}
        workId={workId}
        canModify={canCreateDocuments}
        workItems={workItems}
      />
    </>
  );
}

interface InstrumentStatusEditorProps {
  readonly instrument: Instrument;
  readonly pending: boolean;
  readonly onApply: (status: Exclude<InstrumentStatus, 'active'>) => void;
}

const INSTRUMENT_LABELS: Record<Instrument['kind'], string> = {
  pbg: 'PBG',
  pac: 'PAC',
  doc: 'DOC',
};

function InstrumentStatusEditor({
  instrument,
  pending,
  onApply,
}: InstrumentStatusEditorProps) {
  const [status, setStatus] = useState<Exclude<InstrumentStatus, 'active'>>('released');
  return (
    <span className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
      <label className="sr-only" htmlFor={`instrument-status-${instrument.id}`}>
        New status for {instrument.reference}
      </label>
      <select
        id={`instrument-status-${instrument.id}`}
        value={status}
        onChange={(event) => {
          setStatus(event.target.value as Exclude<InstrumentStatus, 'active'>);
        }}
      >
        <option value="released">released</option>
        <option value="expired">expired</option>
        <option value="closed">closed</option>
      </select>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          onApply(status);
        }}
      >
        Apply
      </Button>
    </span>
  );
}
