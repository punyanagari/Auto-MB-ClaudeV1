import { useEffect, useState } from 'react';
import type {
  PaymentMatrixCategory,
  PaymentMatrixRow,
  WorkItem,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { PAYMENT_MATRIX_CATEGORIES } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';

/**
 * Milestone 8 phase 1: the per-Work payment matrix editor and item
 * category assignment. Percentages live ONLY here, keyed by category —
 * per the settled decision R10 there is deliberately no per-item
 * percentage entry (the legacy product built one and reverted it on
 * user request; the copy below states this so nobody asks for it back).
 * All validation mirrors the server: 0–100 each, at most two decimals,
 * exact sum of 100 — checked in integer hundredths, never floats.
 */

export const CATEGORY_LABELS: Record<PaymentMatrixCategory, string> = {
  SUPPLY: 'Supply',
  SUPPLY_AND_INSTALLATION: 'Supply + installation',
  PURE_INSTALLATION: 'Purely installation',
  SPARE_SUPPLY: 'Spare supply',
  UNCATEGORISED: 'Uncategorised items',
};

const STAGE_FIELDS = [
  ['pctSupply', 'Supply %'],
  ['pctInstallation', 'Installation %'],
  ['pctPac', 'PAC %'],
  ['pctFinalBill', 'Final bill %'],
] as const;

type StageField = (typeof STAGE_FIELDS)[number][0];

type RowDraft = Record<StageField, string>;

/** Percentage in integer hundredths (two-decimal precision), or null
 * when the text is not a plain 0–100 decimal. Never floats. */
function percentHundredths(raw: string): bigint | null {
  const text = raw.trim();
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (!/^\d{1,3}$/.test(whole)) return null;
  if (dot !== -1 && !/^\d{1,2}$/.test(fraction)) return null;
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return value > 10000n ? null : value;
}

/** Inline validation message for a draft, or null when it is saveable. */
function draftProblem(draft: RowDraft): string | null {
  let total = 0n;
  for (const [field, label] of STAGE_FIELDS) {
    const value = percentHundredths(draft[field]);
    if (value === null) {
      return `${label} must be a number between 0 and 100 with at most two decimals.`;
    }
    total += value;
  }
  if (total !== 10000n) {
    return 'The four stages must sum to exactly 100.';
  }
  return null;
}

function draftFrom(row: PaymentMatrixRow | undefined): RowDraft {
  return {
    pctSupply: row?.pctSupply ?? '',
    pctInstallation: row?.pctInstallation ?? '',
    pctPac: row?.pctPac ?? '',
    pctFinalBill: row?.pctFinalBill ?? '',
  };
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
  }, [api, organisationId, workId]);

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
        <h2>Payment matrix</h2>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </>
    );
  }
  if (rows === null) {
    return (
      <>
        <h2>Payment matrix</h2>
        <p className="muted" role="status">
          Loading payment matrix…
        </p>
      </>
    );
  }

  return (
    <>
      <h2>Payment matrix</h2>
      <p className="muted">
        Stage percentages per item category — supply, installation, PAC, and final bill
        must sum to exactly 100. Uncategorised items pay per the Uncategorised row.
        Percentages are deliberately per category, never per item (settled decision
        R10); finalised Measurement Books snapshot the percentages they billed with, so
        later matrix edits never change a raised MB.
      </p>
      <table className="data-table">
        <caption className="visually-hidden">
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
            const problem = draftProblem(draft);
            const touched =
              draft.pctSupply !== '' ||
              draft.pctInstallation !== '' ||
              draft.pctPac !== '' ||
              draft.pctFinalBill !== '';
            if (!canModify) {
              return (
                <tr key={category}>
                  <th scope="row">{CATEGORY_LABELS[category]}</th>
                  {STAGE_FIELDS.map(([field]) => (
                    <td key={field} className="cell--numeric">
                      {saved?.[field] ?? '—'}
                    </td>
                  ))}
                  <td>
                    <span className="muted">{saved ? 'Configured' : 'Not set'}</span>
                  </td>
                </tr>
              );
            }
            return (
              <tr key={category}>
                <th scope="row">{CATEGORY_LABELS[category]}</th>
                {STAGE_FIELDS.map(([field, label]) => (
                  <td key={field}>
                    <input
                      aria-label={`${label} for ${CATEGORY_LABELS[category]}`}
                      value={draft[field]}
                      inputMode="decimal"
                      onChange={(event) => {
                        updateDraft(category, field, event.target.value);
                      }}
                    />
                  </td>
                ))}
                <td>
                  <span className="actions">
                    <button
                      type="button"
                      disabled={pending || problem !== null}
                      onClick={() =>
                        void act(async () => {
                          const row = await api.upsertPaymentMatrixRow(
                            organisationId,
                            workId,
                            category,
                            {
                              pctSupply: draft.pctSupply,
                              pctInstallation: draft.pctInstallation,
                              pctPac: draft.pctPac,
                              pctFinalBill: draft.pctFinalBill,
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
                    </button>
                    {saved && (
                      <button
                        type="button"
                        className="button--ghost"
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
                      </button>
                    )}
                    {touched && problem !== null && (
                      <span className="form-error" role="alert">
                        {problem}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Item categories</h3>
      <p className="muted">
        Each item resolves its stage percentages through its category's matrix row;
        items left uncategorised resolve through the Uncategorised row. Category is
        payment configuration — Measurement Book finalisation refuses items whose
        category has no matrix row, naming them precisely.
      </p>
      {workItems.length === 0 ? (
        <p className="muted">This Work has no items.</p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">Payment category per Work item</caption>
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
                <td className="cell--wrap">{item.description}</td>
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
                    </select>
                  ) : (
                    <span className={item.paymentCategory === null ? 'muted' : ''}>
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
        </table>
      )}
      {actionError !== null && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {notice !== null && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
