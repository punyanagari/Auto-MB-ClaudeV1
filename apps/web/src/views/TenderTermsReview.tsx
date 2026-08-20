import { useEffect, useMemo, useState } from 'react';
import type {
  ConfirmPaymentMatrixRow,
  ContractSourceContext,
  PaymentMatrixCategory,
  TenderPaymentMatrixEvidence,
} from '@auto-mb/contracts';
import { PAYMENT_MATRIX_CATEGORIES } from '@auto-mb/contracts';
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  Link2,
  ShieldCheck,
} from 'lucide-react';
import { CATEGORY_LABELS } from '../lib/payment-matrix.js';
import { Badge } from '../ui/badge.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { NumericInput } from '../ui/numeric-input.js';

const STAGES = [
  ['pctSupply', 'Supply %'],
  ['pctInstallation', 'Installation %'],
  ['pctPac', 'PAC %'],
  ['pctFinalBill', 'Final bill %'],
] as const;

interface MatrixDraft {
  enabled: boolean;
  pctSupply: string;
  pctInstallation: string;
  pctPac: string;
  pctFinalBill: string;
}

type Drafts = Record<PaymentMatrixCategory, MatrixDraft>;

function emptyDraft(): MatrixDraft {
  return {
    enabled: false,
    pctSupply: '',
    pctInstallation: '',
    pctPac: '',
    pctFinalBill: '',
  };
}

function completeSuggestion(
  evidence: TenderPaymentMatrixEvidence,
): ConfirmPaymentMatrixRow | null {
  return evidence.pctSupply !== null &&
    evidence.pctInstallation !== null &&
    evidence.pctPac !== null &&
    evidence.pctFinalBill !== null
    ? {
        category: evidence.category,
        pctSupply: evidence.pctSupply,
        pctInstallation: evidence.pctInstallation,
        pctPac: evidence.pctPac,
        pctFinalBill: evidence.pctFinalBill,
      }
    : null;
}

function signature(row: ConfirmPaymentMatrixRow): string {
  return [
    row.category,
    row.pctSupply,
    row.pctInstallation,
    row.pctPac,
    row.pctFinalBill,
  ].join('|');
}

function initialDrafts(context: ContractSourceContext): Drafts {
  const result = Object.fromEntries(
    PAYMENT_MATRIX_CATEGORIES.map((category) => [category, emptyDraft()]),
  ) as Drafts;
  for (const category of PAYMENT_MATRIX_CATEGORIES) {
    const complete = context.paymentMatrix
      .filter((evidence) => evidence.category === category)
      .map(completeSuggestion)
      .filter((row): row is ConfirmPaymentMatrixRow => row !== null);
    const unique = new Map(complete.map((row) => [signature(row), row]));
    if (unique.size !== 1) continue;
    const row = [...unique.values()][0];
    if (row === undefined) continue;
    result[category] = {
      enabled: true,
      pctSupply: row.pctSupply,
      pctInstallation: row.pctInstallation,
      pctPac: row.pctPac,
      pctFinalBill: row.pctFinalBill,
    };
  }
  return result;
}

function hundredths(raw: string): bigint | null {
  const text = raw.trim();
  const [whole = '', fraction = '', overflow] = text.split('.');
  const isDigits = (value: string) =>
    value.length > 0 &&
    [...value].every((character) => character >= '0' && character <= '9');
  if (
    overflow !== undefined ||
    whole.length > 3 ||
    !isDigits(whole) ||
    (text.includes('.') && (fraction.length > 2 || !isDigits(fraction)))
  ) {
    return null;
  }
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return result <= 10000n ? result : null;
}

function normalisedPercent(raw: string): string | null {
  const value = hundredths(raw);
  return value === null ? null : value.toString();
}

function rowProblem(draft: MatrixDraft): string | null {
  if (!draft.enabled) return null;
  let total = 0n;
  for (const [field, label] of STAGES) {
    const value = hundredths(draft[field]);
    if (value === null)
      return `${label} must be between 0 and 100 with at most two decimals.`;
    total += value;
  }
  return total === 10000n ? null : 'The four stages must sum to exactly 100.';
}

/** The two stages an AMC row may never bill on (migration 0068). */
const LOCKED_AMC_STAGES: ReadonlySet<(typeof STAGES)[number][0]> = new Set([
  'pctSupply',
  'pctInstallation',
]);

function rowOf(
  category: PaymentMatrixCategory,
  draft: MatrixDraft,
): ConfirmPaymentMatrixRow {
  // The AMC row submits 0 on its two unbillable stages whatever the
  // draft holds, so the row that is validated is the row that is sent.
  const locked = category === 'AMC';
  return {
    category,
    pctSupply: locked ? '0' : draft.pctSupply.trim(),
    pctInstallation: locked ? '0' : draft.pctInstallation.trim(),
    pctPac: draft.pctPac.trim(),
    pctFinalBill: draft.pctFinalBill.trim(),
  };
}

function sameMatrix(
  manual: ConfirmPaymentMatrixRow,
  extracted: ConfirmPaymentMatrixRow,
): boolean {
  return STAGES.every(
    ([field]) =>
      normalisedPercent(manual[field]) === normalisedPercent(extracted[field]),
  );
}

interface TenderTermsReviewProps {
  readonly context: ContractSourceContext;
  readonly itemNumbers: readonly string[];
  readonly canModify: boolean;
  readonly onPaymentMatrixChange: (
    rows: readonly ConfirmPaymentMatrixRow[],
    problem: string | null,
  ) => void;
}

export function TenderTermsReview({
  context,
  itemNumbers,
  canModify,
  onPaymentMatrixChange,
}: TenderTermsReviewProps) {
  const [drafts, setDrafts] = useState<Drafts>(() => initialDrafts(context));

  useEffect(() => {
    setDrafts(initialDrafts(context));
  }, [context]);

  const matrixState = useMemo(() => {
    const rows: ConfirmPaymentMatrixRow[] = [];
    const problems: string[] = [];
    for (const category of PAYMENT_MATRIX_CATEGORIES) {
      const draft = drafts[category];
      const problem = rowProblem(draft);
      if (problem !== null) problems.push(`${CATEGORY_LABELS[category]}: ${problem}`);
      if (draft.enabled) rows.push(rowOf(category, draft));
    }
    return { rows, problem: problems.length > 0 ? problems.join(' ') : null };
  }, [drafts]);

  useEffect(() => {
    onPaymentMatrixChange(matrixState.rows, matrixState.problem);
  }, [matrixState, onPaymentMatrixChange]);

  const mismatches = useMemo(() => {
    const messages: string[] = [];
    for (const category of PAYMENT_MATRIX_CATEGORIES) {
      const evidence = context.paymentMatrix.filter(
        (candidate) => candidate.category === category,
      );
      if (evidence.length === 0) continue;
      const complete = evidence
        .map(completeSuggestion)
        .filter((row): row is ConfirmPaymentMatrixRow => row !== null);
      const unique = new Map(complete.map((row) => [signature(row), row]));
      const draft = drafts[category];
      if (!draft.enabled) {
        messages.push(
          `${CATEGORY_LABELS[category]} is present in the tender evidence but is not included in the manual matrix.`,
        );
        continue;
      }
      const manual = rowOf(category, draft);
      if (unique.size > 1) {
        messages.push(
          `${CATEGORY_LABELS[category]} has conflicting percentages across the uploaded tender documents.`,
        );
      } else if (
        unique.size === 1 &&
        !sameMatrix(manual, [...unique.values()][0] as ConfirmPaymentMatrixRow)
      ) {
        messages.push(
          `${CATEGORY_LABELS[category]} differs from the percentages extracted from the tender document.`,
        );
      }
    }
    return messages;
  }, [context.paymentMatrix, drafts]);

  function update(category: PaymentMatrixCategory, patch: Partial<MatrixDraft>): void {
    setDrafts((current) => ({
      ...current,
      [category]: { ...current[category], ...patch },
    }));
  }

  if (context.documents.length === 0) {
    return (
      <Card className="border-dashed" aria-labelledby="tender-evidence-title">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <FileSearch className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="tender-evidence-title" className="m-0 text-base">
              Tender evidence
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No optional NIT, Contract Agreement or tender specification was attached.
              Payment categories and percentages can still be entered manually after the
              Work is created.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <section className="flex flex-col gap-5" aria-labelledby="tender-evidence-title">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h2 id="tender-evidence-title" className="m-0 text-base">
                Matched tender evidence
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Every document below matched both the LOA tender number and name of work
                before it was stored.
              </p>
            </div>
          </div>
          <Badge variant="success">{context.documents.length} accepted</Badge>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {context.documents.map((document) => (
            <div
              key={document.id}
              className="rounded-xl border border-border bg-background/60 p-3"
            >
              <p className="truncate text-sm font-medium">
                {document.originalFilename}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {document.kind.replaceAll('_', ' ')}
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                Tender identity matched
              </p>
            </div>
          ))}
        </div>
      </Card>

      <Card aria-labelledby="initial-payment-matrix-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="initial-payment-matrix-title" className="m-0 text-base">
              Initial payment matrix
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Tender percentages prefill this editor when the evidence is complete and
              unambiguous. The values below are the human-confirmed matrix and remain
              manually editable later. A difference is allowed but never silent.
            </p>
          </div>
          <Badge variant="info">Per Work and item category</Badge>
        </div>

        {mismatches.length > 0 && (
          <div
            className="mt-4 rounded-xl border border-warning/35 bg-warning/[0.07] p-4"
            role="note"
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-warning-foreground">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Manual matrix differs from tender evidence
            </p>
            <ul className="mt-2 space-y-1 pl-5 text-xs text-muted-foreground">
              {mismatches.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}

        <DataTable scroll className="mt-4">
          <caption className="sr-only">
            Initial manual payment matrix compared with tender evidence
          </caption>
          <thead>
            <tr>
              <th scope="col">Use</th>
              <th scope="col">Category</th>
              {STAGES.map(([, label]) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
              <th scope="col">Tender evidence</th>
            </tr>
          </thead>
          <tbody>
            {PAYMENT_MATRIX_CATEGORIES.map((category) => {
              const draft = drafts[category];
              const problem = rowProblem(draft);
              const evidence = context.paymentMatrix.filter(
                (candidate) => candidate.category === category,
              );
              return (
                <tr key={category}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Use ${CATEGORY_LABELS[category]} payment row`}
                      checked={draft.enabled}
                      disabled={!canModify}
                      onChange={(event) => {
                        update(category, { enabled: event.target.checked });
                      }}
                    />
                  </td>
                  <th scope="row">{CATEGORY_LABELS[category]}</th>
                  {STAGES.map(([field, label]) => {
                    // The AMC row's two unbillable stages (migration
                    // 0068). Held at 0 and disabled here for the same
                    // reason the Payment matrix screen does it: an AMC
                    // item is never delivered and never installed, the
                    // confirm route refuses a nonzero value, and a
                    // reviewer should meet the rule while typing rather
                    // than at the end of a long confirmation form.
                    const locked = category === 'AMC' && LOCKED_AMC_STAGES.has(field);
                    return (
                      <td key={field}>
                        <NumericInput
                          className="min-w-24"
                          aria-label={`${label} for ${CATEGORY_LABELS[category]}`}
                          value={locked ? '0' : draft[field]}
                          disabled={!canModify || !draft.enabled || locked}
                          title={
                            locked
                              ? 'Annual maintenance is certified rather than delivered or installed, so this stage can never carry a quantity.'
                              : undefined
                          }
                          onChange={(event) => {
                            update(category, { [field]: event.target.value });
                          }}
                        />
                      </td>
                    );
                  })}
                  <td className={wrapCell}>
                    {evidence.length === 0 ? (
                      <span className="text-xs text-muted-foreground">Not found</span>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-xs font-medium text-primary">
                          {evidence.length} source{evidence.length === 1 ? '' : 's'}
                        </summary>
                        <div className="mt-2 space-y-2">
                          {evidence.map((entry) => (
                            <div
                              key={`${entry.sourceDocumentId}-${entry.rawBlock}`}
                              className="rounded-lg bg-muted p-2 text-xs"
                            >
                              <strong className="block">{entry.sourceFilename}</strong>
                              <span>
                                {entry.pctSupply ?? '—'} /{' '}
                                {entry.pctInstallation ?? '—'} / {entry.pctPac ?? '—'} /{' '}
                                {entry.pctFinalBill ?? '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {problem !== null && draft.enabled && (
                      <p className="mt-2 text-xs font-medium text-destructive">
                        {problem}
                      </p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card aria-labelledby="periods-title">
          <h2 id="periods-title" className="mt-0 text-base">
            Warranty and maintenance periods
          </h2>
          {context.periods.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No period clause was extracted.
            </p>
          ) : (
            <ul className="mt-3 flex list-none flex-col gap-3 p-0">
              {context.periods.map((period) => {
                const mapped = period.itemReferences.filter((reference) =>
                  itemNumbers.some((item) =>
                    item
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, '')
                      .endsWith(reference.toUpperCase().replace(/[^A-Z0-9]/g, '')),
                  ),
                );
                return (
                  <li
                    key={`${period.sourceDocumentId}-${period.rawBlock}`}
                    className="rounded-xl border border-border p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={period.kind === 'warranty' ? 'info' : 'neutral'}>
                        {period.kind}
                      </Badge>
                      <strong className="text-sm">
                        {period.durationValue ?? 'Unresolved'}{' '}
                        {period.durationUnit ?? ''}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        {period.scope === 'work' ? 'Whole Work' : 'Specific items'}
                      </span>
                    </div>
                    {period.itemReferences.length > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Printed references: {period.itemReferences.join(', ')}
                        {mapped.length > 0 ? ` · mapped to ${mapped.join(', ')}` : ''}
                      </p>
                    )}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-primary">
                        Printed clause
                      </summary>
                      <p className="mt-2 rounded-lg bg-muted p-2 text-xs">
                        {period.rawBlock}
                      </p>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card aria-labelledby="release-clauses-title">
          <h2 id="release-clauses-title" className="mt-0 text-base">
            PBG and Security Deposit release clauses
          </h2>
          {context.releaseClauses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No release clause was extracted.
            </p>
          ) : (
            <ul className="mt-3 flex list-none flex-col gap-3 p-0">
              {context.releaseClauses.map((clause) => (
                <li
                  key={`${clause.sourceDocumentId}-${clause.kind}-${clause.rawBlock}`}
                  className="rounded-xl border border-border p-3"
                >
                  <Badge variant="warning">
                    {clause.kind === 'pbg' ? 'PBG release' : 'Security Deposit release'}
                  </Badge>
                  <p className="mt-2 text-xs leading-relaxed">{clause.rawBlock}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Source: {clause.sourceFilename}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card aria-labelledby="item-specifications-title">
        <div className="flex items-start gap-3">
          <Link2 className="mt-0.5 size-4 text-primary" aria-hidden="true" />
          <div>
            <h2 id="item-specifications-title" className="m-0 text-base">
              Item specifications
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              References are mapped only when one unambiguous Work item matches.
              Ambiguous or missing references stay visible for manual review.
            </p>
          </div>
        </div>
        {context.itemSpecifications.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No item-specific technical specification was extracted.
          </p>
        ) : (
          <DataTable className="mt-4">
            <caption className="sr-only">Tender item specifications</caption>
            <thead>
              <tr>
                <th scope="col">Tender item reference</th>
                <th scope="col">Mapped Work item</th>
                <th scope="col">Specification</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {context.itemSpecifications.map((entry) => {
                const mapped = itemNumbers.filter((item) =>
                  entry.itemReferences.some((reference) =>
                    item
                      .toUpperCase()
                      .replace(/[^A-Z0-9]/g, '')
                      .endsWith(reference.toUpperCase().replace(/[^A-Z0-9]/g, '')),
                  ),
                );
                return (
                  <tr key={`${entry.sourceDocumentId}-${entry.rawBlock}`}>
                    <td>{entry.itemReferences.join(', ')}</td>
                    <td>
                      {mapped.length === 1 ? (
                        <Badge variant="success">{mapped[0]}</Badge>
                      ) : (
                        <Badge variant="warning">
                          {mapped.length === 0 ? 'Needs mapping' : 'Ambiguous'}
                        </Badge>
                      )}
                    </td>
                    <td className={wrapCell}>{entry.specification}</td>
                    <td className="text-xs text-muted-foreground">
                      {entry.sourceFilename}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>
    </section>
  );
}
