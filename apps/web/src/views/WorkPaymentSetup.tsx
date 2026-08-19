import { useEffect, useId, useMemo, useState } from 'react';
import type {
  PaymentMatrixCategory,
  PaymentMatrixRow,
  PaymentSetupItemCategory,
  SavePaymentSetupRequest,
  WorkItem,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { PAYMENT_MATRIX_CATEGORIES } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { errorMessage } from '../lib/load-failure.js';
import { proposePaymentCategory } from '../lib/payment-category-proposal.js';
import {
  CATEGORY_LABELS,
  ITEM_CATEGORY_OPTIONS,
  LOCKED_AMC_STAGES,
  STAGE_FIELDS,
  draftFrom,
  draftProblem,
  draftTouched,
  sameRowPercentages,
  submittedDraft,
  type RowDraft,
  type StageField,
} from '../lib/payment-matrix.js';
import { useReload } from '../lib/view-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Modal } from '../ui/dialog.js';
import { FormError } from '../ui/form.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { NumericInput } from '../ui/numeric-input.js';

/**
 * The payment setup a Work is offered as soon as the letter that created
 * it was confirmed, and again from the Work page for as long as the
 * configuration is incomplete.
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
 * opinion about is left uncategorised rather than guessed at. Save DOES
 * commit the proposals still standing when it is pressed, including the
 * ones below the fold — so it says how many, and the audit trail records
 * each of them as a proposal accepted rather than as a typed choice.
 *
 * WHAT IT NEVER OVERWRITES. An item the reviewer already categorised on
 * the LOA review screen, and a matrix row already submitted with the
 * confirmation, are shown as they are: the proposer only fills a NULL
 * category, and the percentage rows load from the saved matrix. A Work
 * that arrives fully configured still opens the dialog once — as a
 * review, with nothing proposed and nothing to send.
 *
 * WHAT IT REFUSES. A save that would leave an item billing through a
 * category with no matrix row. That is the exact state the Measurement
 * Book refuses later, and the whole point of asking now is not to create
 * it. The server refuses it too, on the final state of the Work rather
 * than on what the browser believed.
 *
 * The Schedules tab remains the permanent home of both editors, so
 * "Later" costs nothing.
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

/**
 * The matrix row an item will actually bill through — the client half of
 * the server's `resolvePaymentPercentages`.
 *
 * An uncategorised item is not "no row needed": it resolves through the
 * Work's UNCATEGORISED row, and a Work with uncategorised items and no
 * UNCATEGORISED row is as unbillable as one missing its SUPPLY row. A
 * categorised item deliberately does NOT fall back — its own row is the
 * only one that answers for it.
 */
function resolvedCategoryOf(chosen: string): PaymentMatrixCategory {
  return chosen === '' ? 'UNCATEGORISED' : (chosen as PaymentMatrixCategory);
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
  const [loadVersion, retry] = useReload();

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

  /** Still a proposal exactly while the value on screen IS the proposal
   * and nothing else has answered for it: the operator has not touched
   * the select, and the item carries no saved category of its own. */
  function isUntouchedProposal(item: WorkItem): boolean {
    return overrides[item.id] === undefined && proposals.has(item.id);
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
        setLoadError(errorMessage(cause, 'The payment matrix could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion]);

  /**
   * Every row the operator has typed into, with the problem that holds it
   * back and whether it has actually MOVED.
   *
   * A blank row is not a problem — it is a category this Work does not
   * configure yet. A row that reads exactly as it loaded is not a change:
   * resubmitting it would take the row lock, run the upsert and write a
   * `row_updated` audit event whose before and after are equal, which is
   * noise in the one trail a reviewer reads to find out who moved a
   * percentage.
   */
  const rowStates = PAYMENT_MATRIX_CATEGORIES.map((category) => {
    const draft = drafts[category] ?? draftFrom(undefined);
    const submitted = submittedDraft(category, draft);
    const saved = (rows ?? []).find((row) => row.category === category);
    return {
      category,
      draft,
      submitted,
      saved,
      touched: draftTouched(draft),
      problem: draftProblem(submitted),
      unchanged: sameRowPercentages(submitted, saved),
    };
  });
  const blocked = rowStates.some((row) => row.touched && row.problem !== null);

  /** What Save will send: only the rows that actually move, and only the
   * items whose category actually moves. Sending either unchanged would
   * write an audit event saying nothing changed. */
  function requestBody(): SavePaymentSetupRequest {
    const matrixRows = rowStates
      .filter((row) => row.touched && row.problem === null && !row.unchanged)
      .map((row) => ({
        category: row.category,
        pctSupply: row.submitted.pctSupply,
        pctInstallation: row.submitted.pctInstallation,
        pctPac: row.submitted.pctPac,
        pctFinalBill: row.submitted.pctFinalBill,
      }));
    const itemCategories: PaymentSetupItemCategory[] = workItems
      .filter((item) => chosenFor(item) !== (item.paymentCategory ?? ''))
      .map((item) => ({
        workItemId: item.id,
        paymentCategory:
          chosenFor(item) === '' ? null : (chosenFor(item) as WorkItemPaymentCategory),
        // Provenance, not decoration: an accepted proposal and a typed
        // choice are different acts, and only the audit trail can say
        // afterwards which one set a category that turns out to be wrong.
        proposed: isUntouchedProposal(item),
      }));
    return { matrixRows, itemCategories };
  }

  const outgoing = requestBody();
  const proposedInRequest = outgoing.itemCategories.filter(
    (entry) => entry.proposed,
  ).length;

  /**
   * The categories this Work's items will bill through that would still
   * have no matrix row after this save.
   *
   * Checked over ALL items rather than only the ones being changed: an
   * item nobody touched today is just as unbillable as one set a moment
   * ago, and the Measurement Book will name it either way. A row already
   * saved counts as covered even when its inputs are blanked here —
   * blanking does not delete (see the note the table carries).
   */
  const missingCoverage = PAYMENT_MATRIX_CATEGORIES.filter((category) => {
    const used = workItems.some(
      (item) => resolvedCategoryOf(chosenFor(item)) === category,
    );
    if (!used) return false;
    const configured =
      (rows ?? []).some((row) => row.category === category) ||
      outgoing.matrixRows.some((row) => row.category === category);
    return !configured;
  });

  async function save(): Promise<void> {
    if (missingCoverage.length > 0) {
      const many = missingCoverage.length > 1;
      setSaveError(
        `Enter the stage percentages for ${missingCoverage
          .map((category) => CATEGORY_LABELS[category])
          .join(', ')} first. Items on this Work bill through ${
          many ? 'those rows' : 'that row'
        }, and a Measurement Book cannot be finalized while ${
          many ? 'they are' : 'it is'
        } missing. Nothing was saved.`,
      );
      return;
    }
    const body = outgoing;
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
        errorMessage(
          cause,
          'The payment setup could not be saved. Nothing was changed.',
        ),
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

  const uncategorisedCount = workItems.filter(
    (item) => (item.paymentCategory ?? null) === null,
  ).length;

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
        <ErrorState onRetry={retry} retryLabel="Retry payment setup">
          {loadError}
        </ErrorState>
      ) : rows === null ? (
        <LoadingState label="the payment matrix" rows={6} columns={4} />
      ) : (
        <>
          <h3>Stage percentages</h3>
          {/* The modal surface is the scrollport (see ui/table.tsx): a
              table that made its own would pin its heading to a box that
              never scrolls, and put a second scrollbar inside the first. */}
          <DataTable scroll={false}>
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
              {rowStates.map(({ category, draft, saved, touched, problem }) => (
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
                    {/* Emptying the inputs of a configured row looks like
                        removing it and is not: this dialog only writes
                        rows, so the saved percentages would stand. Said
                        here rather than fixed with a Delete button,
                        because deleting a row a Work is already billing
                        through is not a thing to offer in a setup prompt
                        — the Schedules screen owns it. */}
                    {saved !== undefined && !touched && (
                      <span className="block text-[13px] font-normal text-muted-foreground">
                        Clearing these boxes does not remove the saved row. Remove it
                        under Schedules &amp; items.
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
                        <NumericInput
                          aria-label={`${label} for ${CATEGORY_LABELS[category]}`}
                          className="w-24"
                          value={locked ? '0' : draft[field]}
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
          {workItems.length === 0 ? (
            <EmptyState>
              This Work has no items, so there is nothing to categorise. Items arrive
              with the letter, or are added under Schedules &amp; items.
            </EmptyState>
          ) : (
            <>
              {proposals.size > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {proposals.size} of {workItems.length} item
                  {workItems.length === 1 ? '' : 's'} arrived with a category read from
                  their description and marked as a proposal. Check each one — nothing
                  is saved until you press Save.
                </p>
              ) : uncategorisedCount === 0 ? (
                // Not "nothing matched": every item was decided on the LOA
                // review screen, so there was nothing left to propose
                // against. Saying the wrong one of these two invites the
                // operator to go looking for a proposal that was never due.
                <p className="text-sm text-muted-foreground">
                  Every item already carries a category from the letter review, so
                  nothing was proposed. Change any of them below.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No category could be read from the descriptions of the{' '}
                  {uncategorisedCount} uncategorised item
                  {uncategorisedCount === 1 ? '' : 's'}, so{' '}
                  {uncategorisedCount === 1 ? 'it is' : 'they are'} yours to set.
                </p>
              )}
              <DataTable scroll={false}>
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
                    const isProposal = isUntouchedProposal(item);
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
                              {ITEM_CATEGORY_OPTIONS.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                            {isProposal && <Badge variant="warning">proposed</Badge>}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </>
          )}
        </>
      )}

      {saveError !== null && <FormError>{saveError}</FormError>}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {/* Save commits the proposals still standing, including the ones
            the operator never scrolled to. That is the ratified
            behaviour; this line is what makes it honest. */}
        {proposedInRequest > 0 && (
          <p className="mr-auto m-0 text-sm text-muted-foreground">
            {proposedInRequest} proposed categor{proposedInRequest === 1 ? 'y' : 'ies'}{' '}
            will be saved.
          </p>
        )}
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
