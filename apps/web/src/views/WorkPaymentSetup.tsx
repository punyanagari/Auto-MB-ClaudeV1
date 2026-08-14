import { useEffect, useId, useMemo, useState } from 'react';
import type {
  PaymentMatrixCategory,
  PaymentMatrixRow,
  SavePaymentSetupRequest,
  WorkItem,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { PAYMENT_MATRIX_CATEGORIES } from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { proposePaymentCategory } from '../lib/payment-category-proposal.js';
import {
  CATEGORY_LABELS,
  LOCKED_AMC_STAGES,
  STAGE_FIELDS,
  draftFrom,
  draftProblem,
  draftTouched,
  submittedDraft,
  type RowDraft,
  type StageField,
} from '../lib/payment-matrix.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Modal } from '../ui/dialog.js';
import { FormError } from '../ui/form.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { ErrorState, LoadingState } from '../ui/state.js';

/**
 * The payment setup a Work is offered ONCE, immediately after the letter
 * that created it was confirmed.
 *
 * WHY IT EXISTS. Every downstream money screen needs two things this
 * dialog asks for: a payment category per item, and a matrix row per
 * category the items use. Without them a Measurement Book refuses to
 * finalize, naming the categories it cannot resolve — days later, to
 * whoever happens to be billing. Asking at creation is asking while the
 * letter is still in the operator's hands.
 *
 * WHAT IT PROPOSES, AND WHAT THAT MEANS. The item table pre-fills each
 * UNCATEGORISED item's select from `proposePaymentCategory`, a keyword
 * reading of the description, and marks every such row as a proposal
 * until it is saved. Proposals are not data: nothing is written until
 * Save, "Later" writes nothing at all, and an item the proposer has no
 * opinion about is left uncategorised rather than guessed at.
 *
 * WHAT IT NEVER OVERWRITES. An item the reviewer already categorised on
 * the LOA review screen, and a matrix row already submitted with the
 * confirmation, are shown as they are: the proposer only fills a NULL
 * category, and the percentage rows load from the saved matrix. A Work
 * that arrives fully configured still opens the dialog once — as a
 * review, with nothing proposed.
 *
 * The Schedules tab remains the permanent home of both editors, so
 * "Later" costs nothing and the dialog never asks twice.
 */

interface WorkPaymentSetupProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  /** Dismissal — "Later", Escape, or the backdrop. Nothing was saved. */
  readonly onClose: () => void;
  /** A successful save, with what the server wrote, so the Work page can
   * bring its own copy of the items into step without a refetch. */
  readonly onSaved: (
    items: readonly {
      readonly id: string;
      readonly paymentCategory: WorkItemPaymentCategory | null;
    }[],
  ) => void;
}

/** The description a proposal reads: what an approved amendment left, or
 * the awarded text when nothing amended it. A freshly created Work has no
 * amendments, so this is the letter's own wording — but the dialog is a
 * component, and reading the stale field on a Work that has moved on
 * would propose against text no longer in force. */
function effectiveDescriptionOf(item: WorkItem): string {
  return item.effectiveDescription ?? item.description;
}

export function WorkPaymentSetup({
  api,
  organisationId,
  workId,
  workItems,
  onClose,
  onSaved,
}: WorkPaymentSetupProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [rows, setRows] = useState<readonly PaymentMatrixRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  /**
   * ONLY what the operator has changed, keyed by item — not the whole
   * table.
   *
   * The seeded alternative is a trap here: the Work page recomputes its
   * item list on every render and re-renders whenever one of its half-
   * dozen supporting registers resolves, so an effect that re-seeded the
   * selects from the items would silently undo the operator's choices
   * mid-dialog. An override map has nothing to re-seed.
   */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  /** The proposal for every item that has no category yet, computed once
   * from the items themselves. Items the reviewer already categorised are
   * absent: their saved category is the answer. */
  const proposals = useMemo(() => {
    const proposed = new Map<string, WorkItemPaymentCategory>();
    for (const item of workItems) {
      if ((item.paymentCategory ?? null) !== null) continue;
      const category = proposePaymentCategory(effectiveDescriptionOf(item));
      if (category !== null) proposed.set(item.id, category);
    }
    return proposed;
  }, [workItems]);

  /** What the select shows: the operator's own choice if they made one,
   * else the item's saved category, else the proposal, else
   * uncategorised. */
  function chosenFor(item: WorkItem): string {
    return overrides[item.id] ?? item.paymentCategory ?? proposals.get(item.id) ?? '';
  }

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

  /** Every row the operator has typed into, with the problem that holds
   * it back — a blank row is not a problem, it is a category this Work
   * does not configure yet. */
  const rowProblems = PAYMENT_MATRIX_CATEGORIES.map((category) => {
    const draft = drafts[category] ?? draftFrom(undefined);
    const submitted = submittedDraft(category, draft);
    return {
      category,
      draft,
      submitted,
      touched: draftTouched(draft),
      problem: draftProblem(submitted),
    };
  });
  const blocked = rowProblems.some((row) => row.touched && row.problem !== null);

  /** What Save will send: the complete rows, and only the items whose
   * category actually moves. Sending an unchanged item would write an
   * audit event saying nothing changed. */
  function requestBody(): SavePaymentSetupRequest {
    const matrixRows = rowProblems
      .filter((row) => row.touched && row.problem === null)
      .map((row) => ({
        category: row.category,
        pctSupply: row.submitted.pctSupply.trim(),
        pctInstallation: row.submitted.pctInstallation.trim(),
        pctPac: row.submitted.pctPac.trim(),
        pctFinalBill: row.submitted.pctFinalBill.trim(),
      }));
    const itemCategories = workItems
      .filter((item) => chosenFor(item) !== (item.paymentCategory ?? ''))
      .map((item) => ({
        workItemId: item.id,
        paymentCategory:
          chosenFor(item) === '' ? null : (chosenFor(item) as WorkItemPaymentCategory),
      }));
    return { matrixRows, itemCategories };
  }

  async function save(): Promise<void> {
    const body = requestBody();
    if (body.matrixRows.length === 0 && body.itemCategories.length === 0) {
      // Nothing to write. Closing is the honest answer to a Save with no
      // change in it — a request that writes nothing is not proof of
      // anything and the audit trail is better without it.
      onClose();
      return;
    }
    setPending(true);
    setSaveError(null);
    try {
      const saved = await api.saveWorkPaymentSetup(organisationId, workId, body);
      onSaved(
        saved.items.map((item) => ({
          id: item.id,
          paymentCategory: item.paymentCategory,
        })),
      );
    } catch (cause) {
      // Inline and persistent, per the repository convention: a refusal
      // names an item or a percentage the operator has to go and fix, and
      // a toast that fades takes the instruction with it. The dialog stays
      // open with every entry intact — nothing was saved.
      setSaveError(
        cause instanceof RequestFailedError
          ? cause.message
          : 'The payment setup could not be saved. Nothing was changed.',
      );
    } finally {
      setPending(false);
    }
  }

  function updateDraft(
    category: PaymentMatrixCategory,
    field: StageField,
    value: string,
  ): void {
    setDrafts((current) => ({
      ...current,
      [category]: { ...(current[category] ?? draftFrom(undefined)), [field]: value },
    }));
  }

  const proposalCount = proposals.size;

  return (
    <Modal
      onClose={pending ? () => undefined : onClose}
      labelledBy={titleId}
      describedBy={descriptionId}
      lockScroll
      className="max-h-[85vh] w-full max-w-5xl overflow-y-auto"
    >
      <h2 id={titleId} className="mt-0">
        Set up payment for this Work
      </h2>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Stage percentages per category must sum to exactly 100, and each item bills
        through its category&apos;s row. Both stay editable later under Schedules &amp;
        items; choose Later to leave this until then.
      </p>

      {loadError !== null ? (
        <ErrorState
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
          retryLabel="Retry payment setup"
        >
          {loadError}
        </ErrorState>
      ) : rows === null ? (
        <LoadingState label="the payment matrix" rows={6} columns={4} />
      ) : (
        <>
          <h3>Stage percentages</h3>
          <DataTable scroll>
            <caption className="sr-only">
              Payment matrix rows: four stage percentages per item category. Leave a
              category blank to configure it later.
            </caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                {STAGE_FIELDS.map(([field, label]) => (
                  <th key={field} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowProblems.map(({ category, draft, touched, problem }) => (
                <tr key={category}>
                  <th scope="row">
                    {CATEGORY_LABELS[category]}
                    {touched && problem !== null && (
                      <span
                        className="block text-[13px] font-medium text-destructive"
                        role="alert"
                      >
                        {problem}
                      </span>
                    )}
                  </th>
                  {STAGE_FIELDS.map(([field, label]) => {
                    // An AMC item is never delivered and never installed
                    // (migration 0068), so those two stages can never
                    // carry a quantity and the server refuses a
                    // percentage on either. Held at 0 and disabled, so the
                    // rule is met while typing rather than at save.
                    const locked = category === 'AMC' && LOCKED_AMC_STAGES.has(field);
                    return (
                      <td key={field}>
                        <input
                          aria-label={`${label} for ${CATEGORY_LABELS[category]}`}
                          className="w-24"
                          value={locked ? '0' : draft[field]}
                          inputMode="decimal"
                          disabled={locked || pending}
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
                </tr>
              ))}
            </tbody>
          </DataTable>

          <h3>Item categories</h3>
          {proposalCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              {proposalCount} of {workItems.length} item
              {workItems.length === 1 ? '' : 's'} arrived with a category read from
              their description and marked as a proposal. Check each one — nothing is
              saved until you press Save.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No category could be read from these descriptions, so every item is yours
              to set.
            </p>
          )}
          {workItems.length === 0 ? (
            <p className="text-muted-foreground">This Work has no items.</p>
          ) : (
            <DataTable scroll>
              <caption className="sr-only">
                Payment category per Work item, with keyword proposals marked
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Description</th>
                  <th scope="col">Payment category</th>
                </tr>
              </thead>
              <tbody>
                {workItems.map((item) => {
                  // Still a proposal exactly while the value on screen IS
                  // the proposal and nothing else has answered for it: the
                  // operator has not touched the select, and the item
                  // carries no saved category of its own.
                  const isProposal =
                    overrides[item.id] === undefined && proposals.has(item.id);
                  return (
                    <tr key={item.id}>
                      <th scope="row">{item.itemNumber}</th>
                      <td className={wrapCell}>{effectiveDescriptionOf(item)}</td>
                      <td>
                        <span className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label={`Payment category for ${item.itemNumber}`}
                            value={chosenFor(item)}
                            disabled={pending}
                            onChange={(event) => {
                              const next = event.target.value;
                              setOverrides((current) => ({
                                ...current,
                                [item.id]: next,
                              }));
                            }}
                          >
                            <option value="">Uncategorised</option>
                            <option value="SUPPLY">Supply</option>
                            <option value="SUPPLY_AND_INSTALLATION">
                              Supply + installation
                            </option>
                            <option value="PURE_INSTALLATION">
                              Purely installation
                            </option>
                            <option value="SPARE_SUPPLY">Spare supply</option>
                            <option value="AMC">Annual maintenance (AMC)</option>
                          </select>
                          {isProposal && <Badge variant="warning">proposed</Badge>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </>
      )}

      {saveError !== null && <FormError>{saveError}</FormError>}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={pending} onClick={onClose}>
          Later
        </Button>
        <Button
          disabled={pending || rows === null || blocked}
          onClick={() => void save()}
        >
          Save payment setup
        </Button>
      </div>
    </Modal>
  );
}
