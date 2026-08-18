import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type {
  ImportBatch,
  ImportBatchDetail,
  ImportColumn,
  ImportTarget,
  ImportTargetKey,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { formatTimestamp } from '../format.js';
import { describeLoadFailure } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

/**
 * Bringing a register in from a spreadsheet (migration 0094).
 *
 * THE MOCK DRAWS NO IMPORTS SCREEN, and this one is therefore
 * application-first under `AGENTS.md` § Design contract 2 and 4:
 * behaviour the mock cannot express, built inside its existing visual
 * grammar with no new visual language. Every element here is one the mock
 * already ships — its `PageHeader`, its `Card`/`CardHeader`, its
 * `DataTable`, its dot-plus-label status chip, its `ConfirmDialog`, its
 * button variants, its three shared states. `docs/UX.md` § 18 records the
 * stance rather than inventing a mock citation for a screen that does not
 * exist at `punyanagari/Auto-MB-Vercel-du@fdfd610`.
 *
 * ## The screen is a conversation, not a button
 *
 * An import is never "did it work". It is "which eleven rows are wrong,
 * and why", and the layout follows that: the batch list is the history,
 * and the open batch below it is the argument. The register is untouched
 * until the operator presses the one button that writes — which is why
 * that button says how many rows it will write and the screen says, in
 * words, that nothing has happened yet.
 *
 * ## What it deliberately does not do
 *
 * **Edit a cell.** A staged row is what the sheet contained, and the
 * database refuses to rewrite it (0094, SQLSTATE 23L03). An operator who
 * could patch row 412 here would produce a register nobody could
 * reconcile against the file it came from, and the file is the thing
 * their colleague will send again next quarter. They fix the workbook and
 * upload it again, which is also the only fix that survives.
 *
 * **Live-poll a batch.** Parsing is synchronous (0094's header argues
 * why), so a batch is judged by the time the upload answers. There is
 * nothing to wait for and therefore no spinner to invent.
 */

/** Rows of one batch drawn at a time. Sheets run to thousands and the
 * errors are the point, so the table shows the errors first and pages the
 * rest — a browser asked to lay out five thousand rows of eighteen cells
 * stops being a screen. */
const ROWS_SHOWN = 200;

interface ImportsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Whether this membership holds the import authority (0094). The
   * server refuses regardless; this only decides whether the controls are
   * worth drawing. */
  readonly canImport: boolean;
}

export function Imports({ api, organisationId, canImport }: ImportsProps) {
  const [batches, setBatches] = useState<readonly ImportBatch[] | null>(null);
  const [targets, setTargets] = useState<readonly ImportTarget[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadVersion, reload] = useReload();
  const [open, setOpen] = useState<ImportBatchDetail | null>(null);
  const [cancelling, setCancelling] = useState<ImportBatch | null>(null);
  const action = useAction();

  useEffect(() => {
    let cancelled = false;
    setBatches(null);
    setLoadError(null);
    api
      .listImportBatches(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setBatches(loaded.batches);
        setTargets(loaded.targets);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(cause);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const openBatch = useCallback(
    (batch: ImportBatch) =>
      action.act(async () => {
        setOpen(await api.readImportBatch(organisationId, batch.id));
      }, ''),
    [action, api, organisationId],
  );

  const header = (
    <PageHeader
      eyebrow="Administration"
      title="Imports"
      titleId="imports-title"
      description="Bring a register in from a spreadsheet. Nothing reaches the register until you say so."
    />
  );

  if (loadError !== null && batches === null) {
    const failure = describeLoadFailure(loadError, 'the imports');
    return (
      <>
        {header}
        {failure.retryable ? (
          <ErrorState onRetry={reload} retryLabel="Retry the imports">
            {failure.message}
          </ErrorState>
        ) : (
          <p className="alert error" role="alert">
            {failure.message}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      {header}

      <section aria-labelledby="imports-title" className="flex flex-col gap-5">
        {canImport && (
          <UploadPanel
            api={api}
            organisationId={organisationId}
            targets={targets}
            onStaged={(detail) => {
              setOpen(detail);
              reload();
            }}
          />
        )}

        {action.actionError !== null && <FormError>{action.actionError}</FormError>}
        {action.notice !== null && <FormNotice>{action.notice}</FormNotice>}

        <Card className="flex flex-col gap-4">
          <CardHeader>
            <h2 className="text-base font-semibold">Recent imports</h2>
          </CardHeader>
          {batches === null ? (
            <LoadingState label="the imports" rows={4} columns={5} />
          ) : batches.length === 0 ? (
            <EmptyState>
              No spreadsheet has been imported yet. Download a template, fill it with
              your rows, and upload it here.
            </EmptyState>
          ) : (
            <DataTable scroll>
              <caption className="sr-only">Recent imports</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Register</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className={wrapCell}>
                      <span className="font-medium">{batch.originalFilename}</span>
                    </td>
                    <td>{registerLabel(targets, batch.target)}</td>
                    <td>
                      <span className="tabular-nums">
                        {formatTimestamp(batch.createdAt)}
                      </span>
                    </td>
                    <td className={numericCell}>
                      {batch.status === 'completed'
                        ? `${String(batch.importedRowCount)} of ${String(batch.rowCount)}`
                        : `${String(batch.validRowCount)} of ${String(batch.rowCount)}`}
                    </td>
                    <td>
                      <StatusChip status={batch.status} />
                      {batch.errorRowCount > 0 && (
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {String(batch.errorRowCount)} in error
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void openBatch(batch);
                        }}
                      >
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        {open !== null && (
          <BatchDetail
            api={api}
            organisationId={organisationId}
            detail={open}
            canImport={canImport}
            onChanged={(detail) => {
              setOpen(detail);
              reload();
            }}
            onWithdraw={() => {
              setCancelling(open.batch);
            }}
          />
        )}
      </section>

      {cancelling !== null && (
        <WithdrawDialog
          batch={cancelling}
          pending={action.pending}
          onCancel={() => {
            setCancelling(null);
          }}
          onConfirm={(reason) => {
            void action.act(async () => {
              const detail = await api.cancelImportBatch(
                organisationId,
                cancelling.id,
                {
                  reason,
                },
              );
              setCancelling(null);
              setOpen(detail);
              reload();
            }, 'The import was withdrawn.');
          }}
        />
      )}
    </>
  );
}

function registerLabel(targets: readonly ImportTarget[], key: ImportTargetKey): string {
  return targets.find((target) => target.key === key)?.label ?? key;
}

/**
 * Choosing a register and a file.
 *
 * The template download sits beside the file picker rather than on a page
 * of its own, because the two are one act: the answer to "what columns
 * does this want" is a workbook, and an operator who has to go and find
 * it will type the headers from memory instead.
 */
function UploadPanel({
  api,
  organisationId,
  targets,
  onStaged,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly targets: readonly ImportTarget[];
  readonly onStaged: (detail: ImportBatchDetail) => void;
}) {
  const [target, setTarget] = useState<ImportTargetKey | ''>('');
  const fileInput = useRef<HTMLInputElement>(null);
  const action = useAction('The workbook could not be read.');
  const chosen = targets.find((entry) => entry.key === target);

  const download = useCallback(
    (key: ImportTargetKey, label: string) =>
      action.act(async () => {
        const blob = await api.downloadImportTemplate(organisationId, key);
        // An anchor with a download attribute, not `window.open`: a
        // spreadsheet cannot render in a tab, so opening one produces a
        // blank page or a second download the browser did not name.
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `auto-mb-${key}-template.xlsx`;
        anchor.click();
        // The same 60-second revoke every other download here uses: the
        // click is asynchronous and revoking immediately races it.
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 60_000);
      }, `The ${label} template was downloaded.`),
    [action, api, organisationId],
  );

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <h2 className="text-base font-semibold">Import a spreadsheet</h2>
      </CardHeader>

      <div className="flex flex-wrap items-end gap-3">
        <label className="field min-w-56">
          <span>Register</span>
          <select
            value={target}
            onChange={(event) => {
              setTarget(event.target.value as ImportTargetKey | '');
            }}
          >
            <option value="">Choose a register…</option>
            {targets.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {chosen !== undefined && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                void download(chosen.key, chosen.label);
              }}
              disabled={action.pending}
            >
              <Download data-icon="inline-start" aria-hidden="true" />
              Download template
            </Button>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label={`${chosen.label} workbook`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file === undefined) return;
                void action.act(async () => {
                  onStaged(
                    await api.uploadImportWorkbook(organisationId, chosen.key, file),
                  );
                }, `${file.name} was checked. Nothing has been written yet.`);
              }}
            />
            <Button
              onClick={() => {
                fileInput.current?.click();
              }}
              disabled={action.pending}
            >
              <Upload data-icon="inline-start" aria-hidden="true" />
              {action.pending ? 'Checking…' : 'Choose a workbook'}
            </Button>
          </>
        )}
      </div>

      {chosen !== undefined && <ColumnGuide columns={chosen.columns} />}
      {action.actionError !== null && <FormError>{action.actionError}</FormError>}
      {action.notice !== null && <FormNotice>{action.notice}</FormNotice>}
    </Card>
  );
}

/** What the chosen register expects, drawn before a file is picked. The
 * same descriptions generate the downloadable template server-side, so
 * this list and that workbook cannot disagree. */
function ColumnGuide({ columns }: { readonly columns: readonly ImportColumn[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">
        Columns this register reads ({String(columns.length)})
      </summary>
      <ul className="mt-2 flex list-none flex-col gap-1 p-0">
        {columns.map((column) => (
          <li key={column.key} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{column.header}</span>
            {column.required && (
              <span className="text-xs font-semibold text-warning-foreground">
                required
              </span>
            )}
            <span className="text-xs text-muted-foreground">{column.note}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One batch: what it holds, what is wrong with it, and the two things
 * that can be done about it.
 *
 * Errors are drawn FIRST, whatever their row number. The valid rows are
 * not what anybody opened this screen to read, and burying eleven
 * refusals under four hundred passes is how an operator concludes the
 * import "just failed".
 */
function BatchDetail({
  api,
  organisationId,
  detail,
  canImport,
  onChanged,
  onWithdraw,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly detail: ImportBatchDetail;
  readonly canImport: boolean;
  readonly onChanged: (detail: ImportBatchDetail) => void;
  readonly onWithdraw: () => void;
}) {
  const action = useAction('The rows could not be written.');
  const { batch, rows, columns } = detail;
  const ordered = [...rows].sort((left, right) => {
    if (left.status === right.status) return left.rowNumber - right.rowNumber;
    return left.status === 'error' ? -1 : 1;
  });
  const shown = ordered.slice(0, ROWS_SHOWN);
  const open = batch.status === 'validated';

  return (
    <Card className="flex flex-col gap-4">
      <CardHeader>
        <h2 className="text-base font-semibold">{batch.originalFilename}</h2>
      </CardHeader>

      <p className="text-sm text-muted-foreground">
        <span className="tabular-nums">{String(batch.rowCount)}</span> rows read,{' '}
        <span className="tabular-nums">{String(batch.validRowCount)}</span> ready,{' '}
        <span className="tabular-nums">{String(batch.errorRowCount)}</span> in error.{' '}
        {batch.status === 'completed' ? (
          <>
            <span className="tabular-nums">{String(batch.importedRowCount)}</span> rows
            were written to the register.
          </>
        ) : batch.status === 'cancelled' ? (
          <>This import was withdrawn and nothing was written.</>
        ) : (
          <>Nothing has been written to the register yet.</>
        )}
      </p>

      {open && canImport && (
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={action.pending || batch.validRowCount === 0}
            onClick={() => {
              void action.act(async () => {
                onChanged(await api.commitImportBatch(organisationId, batch.id));
              }, 'The rows were written to the register.');
            }}
          >
            {action.pending ? 'Writing…' : `Import ${String(batch.validRowCount)} rows`}
          </Button>
          <Button variant="outline" onClick={onWithdraw} disabled={action.pending}>
            Withdraw
          </Button>
        </div>
      )}

      {action.actionError !== null && <FormError>{action.actionError}</FormError>}
      {action.notice !== null && <FormNotice>{action.notice}</FormNotice>}

      <DataTable scroll>
        <caption className="sr-only">Rows of {batch.originalFilename}</caption>
        <thead>
          <tr>
            <th scope="col">Sheet row</th>
            <th scope="col">Status</th>
            <th scope="col">What is wrong</th>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.id}>
              <td className={numericCell}>{String(row.rowNumber)}</td>
              <td>
                <StatusChip status={row.status} />
              </td>
              <td className={wrapCell}>
                {row.errors.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {row.errors.map((error, index) => (
                      <li key={`${row.id}-${String(index)}`} className="text-xs">
                        {error.column !== null && (
                          <span className="font-medium">
                            {columns.find((column) => column.key === error.column)
                              ?.header ?? error.column}
                            :{' '}
                          </span>
                        )}
                        {error.message}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
              {columns.map((column) => (
                <td key={column.key}>{row.cells[column.key] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>

      {ordered.length > shown.length && (
        <p className="text-sm text-muted-foreground">
          Showing the first <span className="tabular-nums">{String(shown.length)}</span>{' '}
          of <span className="tabular-nums">{String(ordered.length)}</span> rows, errors
          first.
        </p>
      )}
    </Card>
  );
}

function WithdrawDialog({
  batch,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly batch: ImportBatch;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      title="Withdraw this import"
      description={`${batch.originalFilename} will not be written to the register. The import keeps its record and the reason you give.`}
      confirmLabel="Withdraw import"
      pending={pending}
      confirmDisabled={reason.trim().length < 3}
      tone="destructive"
      onCancel={onCancel}
      onConfirm={() => {
        onConfirm(reason.trim());
      }}
    >
      <label className="field">
        <span>Reason</span>
        <input
          type="text"
          value={reason}
          maxLength={500}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </label>
    </ConfirmDialog>
  );
}
