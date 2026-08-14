import { useEffect, useMemo, useState } from 'react';
import type {
  ContractSourceContext,
  PaymentMatrixCategory,
  PaymentMatrixRow,
  WorkItem,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { PAYMENT_MATRIX_CATEGORIES } from '@auto-mb/contracts';
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { RequestFailedError, type ApiClient } from '../api.js';
import {
  CATEGORY_LABELS,
  LOCKED_AMC_STAGES,
  STAGE_FIELDS,
  draftFrom,
  draftProblem,
  draftTouched,
  samePercent,
  submittedDraft,
  type RowDraft,
  type StageField,
} from '../lib/payment-matrix.js';
import { Button } from '../ui/button.js';
import { DataTable, numericCell, wrapCell } from '../ui/table.js';
import { FormError } from '../ui/form.js';
import { ErrorState, LoadingState } from '../ui/state.js';

/**
 * Milestone 8 phase 1: the per-Work payment matrix editor and item
 * category assignment. Percentages live ONLY here, keyed by category —
 * per the settled decision R10 there is deliberately no per-item
 * percentage entry (the legacy product built one and reverted it on
 * user request; the copy below states this so nobody asks for it back).
 * All validation mirrors the server: 0–100 each, at most two decimals,
 * exact sum of 100 — checked in integer hundredths, never floats.
 */

function matrixEvidenceWarnings(
  context: ContractSourceContext,
  drafts: Record<string, RowDraft>,
): readonly string[] {
  const warnings: string[] = [];
  for (const category of PAYMENT_MATRIX_CATEGORIES) {
    const evidence = context.paymentMatrix.filter(
      (candidate) =>
        candidate.category === category &&
        candidate.pctSupply !== null &&
        candidate.pctInstallation !== null &&
        candidate.pctPac !== null &&
        candidate.pctFinalBill !== null,
    );
    if (evidence.length === 0) continue;
    const signatures = new Set(
      evidence.map((candidate) =>
        [
          candidate.pctSupply,
          candidate.pctInstallation,
          candidate.pctPac,
          candidate.pctFinalBill,
        ].join('|'),
      ),
    );
    if (signatures.size > 1) {
      warnings.push(
        `${CATEGORY_LABELS[category]} has conflicting percentages across tender documents.`,
      );
      continue;
    }
    const proposed = evidence[0];
    const draft = drafts[category];
    if (proposed === undefined || draft === undefined) continue;
    const empty = STAGE_FIELDS.every(([field]) => draft[field].trim() === '');
    if (empty) {
      warnings.push(
        `${CATEGORY_LABELS[category]} is present in tender evidence but has no manual matrix row.`,
      );
      continue;
    }
    if (
      !samePercent(draft.pctSupply, proposed.pctSupply as string) ||
      !samePercent(draft.pctInstallation, proposed.pctInstallation as string) ||
      !samePercent(draft.pctPac, proposed.pctPac as string) ||
      !samePercent(draft.pctFinalBill, proposed.pctFinalBill as string)
    ) {
      warnings.push(
        `${CATEGORY_LABELS[category]} differs from the percentages extracted from ${proposed.sourceFilename}.`,
      );
    }
  }
  return warnings;
}

interface PaymentMatrixProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  readonly canModify: boolean;
  /** Keeps the parent's Work detail state in step after a category
   * edit, so the items table and the matrix agree without a refetch. */
  readonly onItemCategoryChanged: (
    workItemId: string,
    paymentCategory: WorkItemPaymentCategory | null,
  ) => void;
}

export function PaymentMatrix({
  api,
  organisationId,
  workId,
  workItems,
  canModify,
  onItemCategoryChanged,
}: PaymentMatrixProps) {
  const [rows, setRows] = useState<readonly PaymentMatrixRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [tenderContext, setTenderContext] = useState<ContractSourceContext | null>(
    null,
  );
  const [tenderContextError, setTenderContextError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped by the failure state's retry, to re-run the loads below. */
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    api
      .getPaymentMatrix(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        setRows(loaded);
        const initial: Record<string, RowDraft> = {};
        for (const category of PAYMENT_MATRIX_CATEGORIES) {
          initial[category] = draftFrom(
            loaded.find((row) => row.category === category),
          );
        }
        setDrafts(initial);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The payment matrix could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  function retry(): void {
    setLoadVersion((current) => current + 1);
  }

  useEffect(() => {
    let cancelled = false;
    setTenderContext(null);
    setTenderContextError(null);
    api
      .getWorkContractSourceContext(organisationId, workId)
      .then((loaded) => {
        if (!cancelled) setTenderContext(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setTenderContextError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'Tender evidence could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  const tenderWarnings = useMemo(
    () => (tenderContext === null ? [] : matrixEvidenceWarnings(tenderContext, drafts)),
    [tenderContext, drafts],
  );

  async function act(work: () => Promise<void>, done: string) {
    setPending(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
    } catch (cause) {
      setActionError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The action failed; nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }

  function updateDraft(
    category: PaymentMatrixCategory,
    field: StageField,
    value: string,
  ) {
    setDrafts((current) => ({
      ...current,
      [category]: { ...(current[category] ?? draftFrom(undefined)), [field]: value },
    }));
  }

  if (loadError !== null) {
    return (
      <>
        <h2 id="payment-matrix">Payment matrix</h2>
        <ErrorState onRetry={retry} retryLabel="Retry payment matrix">
          {loadError}
        </ErrorState>
      </>
    );
  }
  if (rows === null) {
    return (
      <>
        <h2 id="payment-matrix">Payment matrix</h2>
        <LoadingState label="the payment matrix" rows={5} columns={4} />
      </>
    );
  }

  return (
    <>
      <h2 id="payment-matrix">Payment matrix</h2>
      <p className="text-muted-foreground">
        Stage percentages per item category — supply, installation, PAC, and final bill
        must sum to exactly 100. Uncategorised items pay per the Uncategorised row.
        Percentages are deliberately per category, never per item (settled decision
        R10); finalised Measurement Books snapshot the percentages they billed with, so
        later matrix edits never change a raised MB.
      </p>
      {tenderContextError !== null && (
        // Degraded rather than blocked: the percentages below are editable
        // and saveable without the tender to compare them against. It is
        // still a load that failed, so it still says how to re-run it.
        <ErrorState onRetry={retry} retryLabel="Retry tender comparison">
          Tender comparison unavailable. {tenderContextError}
        </ErrorState>
      )}
      {tenderContext !== null && tenderContext.documents.length > 0 && (
        <div
          className={`my-4 rounded-xl border p-4 ${
            tenderWarnings.length > 0
              ? 'border-warning/35 bg-warning/[0.06]'
              : 'border-success/25 bg-success/[0.045]'
          }`}
          role="note"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p
                className={`flex items-center gap-2 text-sm font-semibold ${
                  tenderWarnings.length > 0 ? 'text-warning-foreground' : 'text-success'
                }`}
              >
                {tenderWarnings.length > 0 ? (
                  <AlertTriangle className="size-4" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                )}
                {tenderWarnings.length > 0
                  ? 'Manual matrix differs from tender evidence'
                  : 'Manual matrix matches the extracted tender percentages'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The manual matrix remains authoritative. This comparison never
                overwrites a saved value.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
              <FileText className="size-3.5" aria-hidden="true" />
              {tenderContext.documents.length} matched document
              {tenderContext.documents.length === 1 ? '' : 's'}
            </span>
          </div>
          {tenderWarnings.length > 0 && (
            <ul className="mt-3 space-y-1 pl-5 text-xs text-muted-foreground">
              {tenderWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {tenderContext.paymentMatrix.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-primary">
                Show extracted payment clauses
              </summary>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {tenderContext.paymentMatrix.map((entry) => (
                  <div
                    key={`${entry.sourceDocumentId}-${entry.category}-${entry.rawBlock}`}
                    className="rounded-lg border border-border bg-card p-3 text-xs"
                  >
                    <strong>{CATEGORY_LABELS[entry.category]}</strong>
                    <span className="ml-2 font-mono text-muted-foreground">
                      {entry.pctSupply ?? '—'} / {entry.pctInstallation ?? '—'} /{' '}
                      {entry.pctPac ?? '—'} / {entry.pctFinalBill ?? '—'}
                    </span>
                    <p className="mt-2 text-muted-foreground">{entry.rawBlock}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.sourceFilename}
                    </p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <DataTable scroll>
        <caption className="sr-only">
          Payment matrix rows: four stage percentages per item category
        </caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Supply %</th>
            <th scope="col">Installation %</th>
            <th scope="col">PAC %</th>
            <th scope="col">Final bill %</th>
            <th scope="col">Row actions</th>
          </tr>
        </thead>
        <tbody>
          {PAYMENT_MATRIX_CATEGORIES.map((category) => {
            const saved = rows.find((row) => row.category === category);
            const draft = drafts[category] ?? draftFrom(saved);
            const submitted = submittedDraft(category, draft);
            const problem = draftProblem(submitted);
            const touched = draftTouched(draft);
            if (!canModify) {
              return (
                <tr key={category}>
                  <th scope="row">{CATEGORY_LABELS[category]}</th>
                  {STAGE_FIELDS.map(([field]) => (
                    <td key={field} className={numericCell}>
                      {saved?.[field] ?? '—'}
                    </td>
                  ))}
                  <td>
                    <span className="text-muted-foreground">
                      {saved ? 'Configured' : 'Not set'}
                    </span>
                  </td>
                </tr>
              );
            }
            return (
              <tr key={category}>
                <th scope="row">{CATEGORY_LABELS[category]}</th>
                {STAGE_FIELDS.map(([field, label]) => {
                  // An AMC item is never delivered and never installed
                  // (migration 0068), so those two stage deltas are
                  // permanently zero and any percentage on them would
                  // bill nothing, forever. The server refuses it and a
                  // database CHECK backstops the refusal; the input is
                  // held at 0 and disabled so the operator meets the
                  // rule while typing rather than at save.
                  const locked = category === 'AMC' && LOCKED_AMC_STAGES.has(field);
                  return (
                    <td key={field}>
                      <input
                        aria-label={`${label} for ${CATEGORY_LABELS[category]}`}
                        value={locked ? '0' : draft[field]}
                        inputMode="decimal"
                        disabled={locked}
                        title={
                          locked
                            ? 'Annual maintenance is certified rather than delivered or installed, so this stage can never carry a quantity.'
                            : undefined
                        }
                        onChange={(event) => {
                          updateDraft(category, field, event.target.value);
                        }}
                      />
                    </td>
                  );
                })}
                <td>
                  <span className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
                    <Button
                      disabled={pending || problem !== null}
                      onClick={() =>
                        void act(async () => {
                          const row = await api.upsertPaymentMatrixRow(
                            organisationId,
                            workId,
                            category,
                            {
                              pctSupply: submitted.pctSupply,
                              pctInstallation: submitted.pctInstallation,
                              pctPac: submitted.pctPac,
                              pctFinalBill: submitted.pctFinalBill,
                            },
                          );
                          setRows((current) => [
                            ...(current ?? []).filter(
                              (candidate) => candidate.category !== category,
                            ),
                            row,
                          ]);
                          setDrafts((current) => ({
                            ...current,
                            [category]: draftFrom(row),
                          }));
                        }, `Percentages saved for ${CATEGORY_LABELS[category]}.`)
                      }
                    >
                      Save
                    </Button>
                    {saved && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            await api.deletePaymentMatrixRow(
                              organisationId,
                              workId,
                              category,
                            );
                            setRows((current) =>
                              (current ?? []).filter(
                                (candidate) => candidate.category !== category,
                              ),
                            );
                            setDrafts((current) => ({
                              ...current,
                              [category]: draftFrom(undefined),
                            }));
                          }, `${CATEGORY_LABELS[category]} row removed.`)
                        }
                      >
                        Remove
                      </Button>
                    )}
                    {touched && problem !== null && (
                      <span
                        className="my-2 text-[13px] font-medium text-destructive"
                        role="alert"
                      >
                        {problem}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      <h3>Item categories</h3>
      <p className="text-muted-foreground">
        Each item resolves its stage percentages through its category's matrix row;
        items left uncategorised resolve through the Uncategorised row. Category is
        payment configuration — Measurement Book finalisation refuses items whose
        category has no matrix row, naming them precisely.
      </p>
      {workItems.length === 0 ? (
        <p className="text-muted-foreground">This Work has no items.</p>
      ) : (
        <DataTable>
          <caption className="sr-only">Payment category per Work item</caption>
          <thead>
            <tr>
              <th scope="col">Item number</th>
              <th scope="col">Description</th>
              <th scope="col">Payment category</th>
            </tr>
          </thead>
          <tbody>
            {workItems.map((item) => (
              <tr key={item.id}>
                <th scope="row">{item.itemNumber}</th>
                <td className={wrapCell}>{item.description}</td>
                <td>
                  {canModify ? (
                    <select
                      aria-label={`Payment category for ${item.itemNumber}`}
                      value={item.paymentCategory ?? ''}
                      disabled={pending}
                      onChange={(event) => {
                        const next =
                          event.target.value === ''
                            ? null
                            : (event.target.value as WorkItemPaymentCategory);
                        void act(async () => {
                          const updated = await api.setWorkItemPaymentCategory(
                            organisationId,
                            item.id,
                            next,
                          );
                          onItemCategoryChanged(item.id, updated.paymentCategory);
                        }, `Payment category updated for ${item.itemNumber}.`);
                      }}
                    >
                      <option value="">Uncategorised</option>
                      <option value="SUPPLY">Supply</option>
                      <option value="SUPPLY_AND_INSTALLATION">
                        Supply + installation
                      </option>
                      <option value="PURE_INSTALLATION">Purely installation</option>
                      <option value="SPARE_SUPPLY">Spare supply</option>
                      <option value="AMC">Annual maintenance (AMC)</option>
                    </select>
                  ) : (
                    <span
                      className={
                        item.paymentCategory === null ? 'text-muted-foreground' : ''
                      }
                    >
                      {item.paymentCategory === null ||
                      item.paymentCategory === undefined
                        ? 'Uncategorised'
                        : CATEGORY_LABELS[item.paymentCategory]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && (
        <p className="text-muted-foreground" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
