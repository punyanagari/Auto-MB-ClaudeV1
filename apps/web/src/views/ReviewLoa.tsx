import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  ConfirmPaymentMatrixRow,
  ConfirmWorkRequest,
  ContractSourceContext,
  GstBasis,
  LoaDocumentDetail,
  WorkDetailResponse,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { formatDate, formatTimestampDate } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { Button } from '../ui/button.js';
import { ConfirmDialog } from '../ui/confirm.js';
import { StatusChip } from '../ui/chip.js';
import { SignaturePanel } from '../ui/signature-panel.js';
import { Card } from '../ui/card.js';
import { PageHeader } from '../ui/page-header.js';
import {
  ScheduleAccordionControls,
  ScheduleSection,
  useScheduleAccordion,
} from '../ui/schedule-section.js';
import { DataTable, controlCell, wrapCell } from '../ui/table.js';
import {
  Field,
  FieldRow,
  Actions,
  ActionBar,
  FormError,
  FieldError,
  Hint,
} from '../ui/form.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { TenderTermsReview } from './TenderTermsReview.js';
import {
  asExtractionPayload,
  completionDateFrom,
  exactRowsTotal,
  formatMinorUnits,
  normaliseDecimal,
  parseDecimalMinorUnits,
  type ExtractionPayloadView,
  type ReviewFlagView,
} from '../loa-payload.js';
import {
  itemFlagsOf,
  itemLocksOf,
  itemTargetId,
  letterLocksOf,
  type ItemLocks,
} from '../loa-locked-fields.js';

interface ReviewLoaProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly documentId: string;
  readonly canModify: boolean;
  readonly onConfirmed: (work: WorkDetailResponse) => void;
  readonly onBack: () => void;
  /** Leaving after the letter was deliberately withdrawn. Separate from
   * `onBack` because there is nothing left to protect: the reviewer has
   * already answered the only question a departure prompt could ask. */
  readonly onDiscarded: () => void;
  /** Whether the reviewer has corrected anything the parser proposed.
   * The workspace shell holds the departure confirmation, and this is
   * how this screen joins it. */
  readonly onDirtyChange?: (dirty: boolean) => void;
}

/** The product's words for the two classifications, so a read-only fact
 * reads the way the form's own options read. */
const PRICING_SHAPE_WORDS = {
  letter_percentage: 'Letter percentage',
  per_schedule: 'Per-schedule totals',
} as const;

const DIRECTION_WORDS = {
  below: 'Below',
  at_par: 'At par',
  above: 'Above',
} as const;

/** Every field of a reviewer-added row is the reviewer's: nothing was
 * extracted for it. */
const MANUAL_ROW_LOCKS: ItemLocks = {
  description: false,
  unitCode: false,
  awardedQuantity: false,
  effectiveRate: false,
};

interface ItemDraft {
  readonly key: string;
  readonly scheduleId: string;
  readonly itemSno: string;
  readonly needsReview: boolean;
  /** True for a row the reviewer added at review time (no parsed source
   * row exists); confirmed with an explicit manual-entry marker instead
   * of a sourceRef. */
  readonly manual: boolean;
  readonly anchorLine: string;
  /** Which of this row's values the letter already decided. A locked value
   * is shown as printed and cannot be typed over; the server refuses a
   * changed one by name. */
  readonly locks: ItemLocks;
  /** The parser's own flags against this row, shown beside the fields it
   * left open. */
  readonly flags: readonly ReviewFlagView[];
  itemNumber: string;
  description: string;
  unitCode: string;
  awardedQuantity: string;
  effectiveRate: string;
  /** Reviewer-set payment category (Milestone 8); '' = uncategorised.
   * The parser never proposes it — categorisation is the reviewer's
   * judgement, and it stays editable on the Work afterwards. */
  paymentCategory: WorkItemPaymentCategory | '';
}

/** The wire shapes these fields must satisfy. Mirrored from
 * DecimalStringSchema and DateOnlySchema so the form never accepts a value
 * the server will refuse — and never refuses one it would take. */
const WORK_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_/-]{0,19}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$|^(?:0|[1-9]\d*)\.\d{1,3}$/;

interface HeaderDraft {
  workCode: string;
  letterNumber: string;
  letterDate: string;
  title: string;
  advertisedValue: string;
  contractValue: string;
  pricingShape: 'letter_percentage' | 'per_schedule';
  letterPercentage: string;
  letterPercentageDirection: 'below' | 'at_par' | 'above' | '';
  /** Whether the letter's rates are quoted inclusive or exclusive of GST
   * (migration 0062). Never extracted — the letter does not say — so it is
   * always an answerable question here, defaulted to the common case. */
  gstBasis: GstBasis;
  /** The contractual completion date, prefilled as letter date plus the
   * completion period the letter prints, and overwritable. Empty when the
   * letter states no period this screen can do arithmetic on. */
  completionDate: string;
}

interface PbgDraft {
  required: boolean;
  requiredAmount: string;
  submissionDays: string;
  extensionDays: string;
  penalInterestPercent: string;
}

function buildPbgDraft(payload: ExtractionPayloadView): PbgDraft {
  const guarantee = payload.review.header.performanceGuarantee;
  if (
    guarantee === undefined ||
    guarantee.amountFigures === null ||
    guarantee.submissionDays === null
  ) {
    return {
      required: false,
      requiredAmount: '',
      submissionDays: '',
      extensionDays: '',
      penalInterestPercent: '',
    };
  }
  return {
    required: true,
    requiredAmount: guarantee.amountFigures.toFixed(2),
    submissionDays: String(guarantee.submissionDays),
    extensionDays:
      guarantee.extensionDays !== null ? String(guarantee.extensionDays) : '',
    penalInterestPercent:
      guarantee.penalInterestPercent !== null
        ? String(guarantee.penalInterestPercent)
        : '',
  };
}

function buildHeaderDraft(payload: ExtractionPayloadView): HeaderDraft {
  const { header, pricingShape } = payload.review;
  const letterDate = header.letterDate.value;
  return {
    workCode: '',
    letterNumber: header.letterNumber.value ?? '',
    letterDate:
      letterDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(letterDate) ? letterDate : '',
    title: header.workDescription.value ?? '',
    advertisedValue: pricingShape.advertised_value?.toFixed(2) ?? '',
    contractValue: pricingShape.contract_value?.toFixed(2) ?? '',
    pricingShape: pricingShape.pricing_shape ?? 'per_schedule',
    letterPercentage:
      pricingShape.letter_percentage?.toFixed(3) ??
      (pricingShape.letter_percentage_direction === 'at_par' ? '0' : ''),
    letterPercentageDirection: pricingShape.letter_percentage_direction ?? '',
    // The parser proposes nothing here, on any letter. 'inclusive' is the
    // ordinary Indian works contract, and the control below makes the
    // rarer answer a deliberate act rather than a discovery.
    gstBasis: 'inclusive',
    // Derived once, from the letter's own two facts. Not re-derived when
    // the reviewer edits the letter date: a prefill that moved under a
    // date the operator had already answered for would be the screen
    // arguing with them. The hint below names both inputs, so a changed
    // letter date makes the stale proposal visible rather than silent.
    completionDate:
      completionDateFrom(
        letterDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(letterDate) ? letterDate : '',
        header.completionPeriod,
      ) ?? '',
  };
}

/** Everything on this screen the reviewer can change, and nothing else.
 * Locks, parser flags and anchor lines are the letter's, not theirs, so
 * they are left out: comparing them would only make the comparison
 * sensitive to a re-render. Row identity is included, so adding or
 * removing a row counts as an edit even when the remaining values are
 * untouched. */
function comparableDraft(
  header: HeaderDraft,
  items: readonly ItemDraft[],
  pbg: PbgDraft,
): string {
  return JSON.stringify({
    header,
    pbg,
    items: items.map((item) => ({
      key: item.key,
      itemNumber: item.itemNumber,
      description: item.description,
      unitCode: item.unitCode,
      awardedQuantity: item.awardedQuantity,
      effectiveRate: item.effectiveRate,
      paymentCategory: item.paymentCategory,
    })),
  });
}

function buildItemDrafts(payload: ExtractionPayloadView): ItemDraft[] {
  return payload.review.items.map((item, index) => {
    const scheduleId = item.schedule?.id ?? 'UNBOUND';
    return {
      key: `${scheduleId}#${item.itemSno}#${String(index)}`,
      scheduleId,
      itemSno: item.itemSno,
      needsReview: item.needsReview,
      manual: false,
      anchorLine: item.raw.anchorLine,
      locks: itemLocksOf(payload, item),
      flags: itemFlagsOf(payload, itemTargetId(scheduleId, item.itemSno)),
      itemNumber: `${scheduleId}/${item.itemSno}`,
      description: item.description,
      unitCode: (item.qtyUnit ?? '').slice(0, 20),
      awardedQuantity: normaliseDecimal(item.qty, 3),
      effectiveRate: normaliseDecimal(item.unitRate, 6),
      paymentCategory: '',
    };
  });
}

/** One value the letter already decided, read straight off the printed
 * text. It is TEXT, not a disabled control: a disabled input still reads as
 * "a field you cannot use", and this is not a field at all — it is the
 * letter's own value, and the only thing that can change it is a corrected
 * letter. Numbers, money and dates keep the product's mono + tabular
 * figures so a column of them lines up under the eye. */
function ExtractedFact({
  label,
  value,
  numeric = false,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly numeric?: boolean;
  readonly testId?: string;
}) {
  return (
    <>
      <dt className="text-[13px] font-medium text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        className={
          numeric
            ? 'font-mono text-[13px] tabular-nums [overflow-wrap:anywhere]'
            : 'text-[13px] [overflow-wrap:anywhere]'
        }
      >
        {value}
      </dd>
    </>
  );
}

/** The panel the extracted facts sit in. Quieter than the form around it:
 * these are settled facts, not questions. */
function ExtractedFacts({
  children,
  testId,
  caption,
}: {
  readonly children: React.ReactNode;
  readonly testId: string;
  readonly caption: string;
}) {
  return (
    <dl
      data-testid={testId}
      aria-label={caption}
      className="my-3 grid max-w-[46rem] grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3"
    >
      {children}
    </dl>
  );
}

/** One locked value inside the items table. Same reasoning as
 * `ExtractedFact`, in the width a table cell has. */
function LockedCell({
  value,
  numeric = false,
  label,
}: {
  readonly value: string;
  readonly numeric?: boolean;
  readonly label: string;
}) {
  return (
    <span
      aria-label={label}
      className={
        numeric
          ? 'block font-mono text-[13px] tabular-nums'
          : 'block text-[13px] [overflow-wrap:anywhere]'
      }
    >
      {value}
    </span>
  );
}

/** What the parser said it could not read, beside the field it left open. */
function ParserHoleNote({ flags }: { readonly flags: readonly ReviewFlagView[] }) {
  if (flags.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {flags.map((flag) => (
        <span key={flag.code} className="mr-1 inline-block">
          <StatusChip status="review">{flag.code}</StatusChip>
        </span>
      ))}
    </p>
  );
}

/** One item's description cell: two rows by default, the whole thing on
 * request. The letter's descriptions run to five or six lines each, so a
 * table that gives every one of them its full height is a page of
 * paragraphs with the quantities somewhere off to the right.
 *
 * The box is the editable field itself, so this shortens nothing: the
 * full value is in the textarea either way, and only how much of it the
 * box shows changes. */
function DescriptionCell({
  item,
  scheduleId,
  onChange,
}: {
  readonly item: ItemDraft;
  readonly scheduleId: string;
  readonly onChange: (description: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  /* The toggle says aria-expanded, so it has to name what it expands: the
   * box below, which grows from two rows to ten. */
  const boxId = useId();
  const clampable = item.description.length > 90 || item.description.includes('\n');
  return (
    <>
      <textarea
        id={boxId}
        aria-label={`Description for row ${item.itemSno} in schedule ${scheduleId}`}
        value={item.description}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        required
        minLength={3}
        rows={expanded ? 10 : 2}
      />
      {clampable && (
        <Button
          variant="link"
          size="inline"
          className="mt-1 text-xs"
          aria-expanded={expanded}
          aria-controls={boxId}
          aria-label={
            expanded
              ? `Show less of the description for row ${item.itemSno}`
              : `Show the full description for row ${item.itemSno}`
          }
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </>
  );
}

export function ReviewLoa({
  api,
  organisationId,
  documentId,
  canModify,
  onConfirmed,
  onBack,
  onDiscarded,
  onDirtyChange,
}: ReviewLoaProps) {
  const [document, setDocument] = useState<LoaDocumentDetail | null>(null);
  const [contractContext, setContractContext] = useState<ContractSourceContext | null>(
    null,
  );
  const [contractContextError, setContractContextError] = useState<string | null>(null);
  const [initialPaymentMatrix, setInitialPaymentMatrix] = useState<
    readonly ConfirmPaymentMatrixRow[]
  >([]);
  const [paymentMatrixProblem, setPaymentMatrixProblem] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /* Two counters, deliberately. Re-running the document load rebuilds
   * every draft from the stored extraction, which is right after a failed
   * load and destructive after a good one — so the tender-evidence retry
   * must never reach it. */
  const [documentLoadVersion, setDocumentLoadVersion] = useState(0);
  const [contextLoadVersion, setContextLoadVersion] = useState(0);
  const [header, setHeader] = useState<HeaderDraft | null>(null);
  const [items, setItems] = useState<ItemDraft[] | null>(null);
  const [pbg, setPbg] = useState<PbgDraft | null>(null);
  const [addSchedule, setAddSchedule] = useState('A');
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  /** The one remedy for a wrong extraction: withdraw the letter and upload
   * a corrected one. It asks once — the file leaves the working list and
   * only a fresh upload brings it back. */
  const [discardAsked, setDiscardAsked] = useState(false);
  const [discardPending, setDiscardPending] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  /** The drafts exactly as the extraction produced them. Everything that
   * differs from this is the reviewer's work, and losing it is what the
   * shell's departure confirmation exists to prevent. */
  const [loadedDraft, setLoadedDraft] = useState<string | null>(null);
  /** The payment matrix is derived from the matched tender the moment
   * TenderTermsReview mounts, so its first emission is a starting point,
   * not an edit. Anything after that is the reviewer's. */
  /* This screen opens on a spinner and fills itself in from two independent
   * reads. A sighted reviewer watches the letter appear; a screen-reader
   * user was told nothing — the "Loading document…" line was REMOVED from
   * the page when the content arrived, and a live region that is removed
   * announces nothing. These two hold the arrivals instead, and the regions
   * that carry them (below the heading) are mounted from the first render
   * so a later change is a change rather than an insertion. */
  const [extractionArrival, setExtractionArrival] = useState('');
  const [evidenceArrival, setEvidenceArrival] = useState('');
  const matrixBaselineRef = useRef<string | null>(null);
  const [matrixEdited, setMatrixEdited] = useState(false);
  const manualSequence = useRef(1);
  const fieldRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setHeader(null);
    setItems(null);
    setPbg(null);
    setLoadError(null);
    setFieldErrors({});
    setLoadedDraft(null);
    setExtractionArrival('');
    matrixBaselineRef.current = null;
    setMatrixEdited(false);
    api
      .getLoaDocument(organisationId, documentId)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
        const payload = asExtractionPayload(loaded.extractionPayload);
        if (payload === null) {
          // Two different absences, and they must not read the same. Since
          // pack P18 the letter is read by the worker after the upload is
          // accepted, so a document can legitimately have no payload YET —
          // saying it "produced no reviewable content" would tell the
          // reviewer the letter is unusable when it has simply not been
          // read. There is no progress to report and no spinner to invent:
          // the honest statement is that the reading is still to happen,
          // and reopening the document shows the result.
          const stillReading =
            loaded.extractionStatus === 'pending' ||
            loaded.extractionStatus === 'processing';
          setExtractionArrival(
            stillReading
              ? `${loaded.originalFilename} has been stored and is still being read. Its items and dates appear here once the reading finishes; open it again in a moment.`
              : `Extraction for ${loaded.originalFilename} produced no reviewable content.`,
          );
          return;
        }
        const drafts = buildItemDrafts(payload);
        const headerDraft = buildHeaderDraft(payload);
        const pbgDraft = buildPbgDraft(payload);
        setHeader(headerDraft);
        setItems(drafts);
        setPbg(pbgDraft);
        setLoadedDraft(comparableDraft(headerDraft, drafts, pbgDraft));
        const lastDraft = drafts[drafts.length - 1];
        setAddSchedule(lastDraft !== undefined ? lastDraft.scheduleId : 'A');
        const schedules = new Set(drafts.map((draft) => draft.scheduleId)).size;
        const flaggedCount = payload.review.needsReview.total;
        setExtractionArrival(
          `Extraction ready for ${loaded.originalFilename}: ${String(drafts.length)} item${
            drafts.length === 1 ? '' : 's'
          } across ${String(schedules)} schedule${schedules === 1 ? '' : 's'}, ` +
            `${String(flaggedCount)} flagged for review.`,
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = errorMessage(cause, 'The document could not be loaded.');
        setLoadError(message);
        setExtractionArrival(message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, documentId, documentLoadVersion]);

  useEffect(() => {
    let cancelled = false;
    setContractContext(null);
    setContractContextError(null);
    setEvidenceArrival('');
    api
      .getLoaContractSourceContext(organisationId, documentId)
      .then((loaded) => {
        if (cancelled) return;
        setContractContext(loaded);
        setEvidenceArrival(
          loaded.documents.length === 0
            ? 'No matched tender evidence is attached to this letter.'
            : `Matched tender evidence ready: ${String(loaded.documents.length)} source document${
                loaded.documents.length === 1 ? '' : 's'
              }.`,
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const message = errorMessage(
          cause,
          'The matched tender evidence could not be loaded.',
        );
        setContractContextError(message);
        setEvidenceArrival(message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, documentId, contextLoadVersion]);

  const handlePaymentMatrixChange = useCallback(
    (rows: readonly ConfirmPaymentMatrixRow[], problem: string | null) => {
      setInitialPaymentMatrix(rows);
      setPaymentMatrixProblem(problem);
      const signature = JSON.stringify(rows);
      if (matrixBaselineRef.current === null) {
        matrixBaselineRef.current = signature;
        return;
      }
      setMatrixEdited(signature !== matrixBaselineRef.current);
    },
    [],
  );

  /** What the reviewer would lose by leaving. */
  const edited =
    (loadedDraft !== null &&
      header !== null &&
      items !== null &&
      pbg !== null &&
      comparableDraft(header, items, pbg) !== loadedDraft) ||
    matrixEdited;

  useEffect(() => {
    onDirtyChange?.(edited);
  }, [edited, onDirtyChange]);

  // Unmounting this screen ends its claim on the shell's confirmation.
  // Without this a discarded or confirmed letter would leave the flag
  // set behind it and the next navigation would ask about a form that no
  // longer exists.
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  const payload = useMemo(
    () => (document === null ? null : asExtractionPayload(document.extractionPayload)),
    [document],
  );

  /** Which letter-level values the parser established. Everything true here
   * renders as the letter's own text; the rest stay as fields, because the
   * parser said it could not read them. */
  const locks = useMemo(
    () => (payload === null ? null : letterLocksOf(payload)),
    [payload],
  );

  /** The completion period as printed, for the hint under the completion
   * date. `null` when the letter states none, which is a legitimate
   * letter and not a parse failure. */
  const completionPeriod = useMemo(() => {
    const period = payload?.review.header.completionPeriod;
    if (period === undefined) return null;
    if (period.value !== null && period.unit === 'month') {
      return `${String(period.value)} month${period.value === 1 ? '' : 's'}`;
    }
    return period.raw;
  }, [payload]);

  /** The date that period implies from the letter date CURRENTLY typed —
   * recomputed as the reviewer edits it, so the hint stays honest even
   * though the prefilled field deliberately does not move. */
  const derivedCompletionDate = useMemo(
    () =>
      completionDateFrom(
        header?.letterDate ?? '',
        payload?.review.header.completionPeriod,
      ),
    [header, payload],
  );

  async function discard() {
    setDiscardPending(true);
    setDiscardError(null);
    try {
      await api.discardLoaDocument(organisationId, documentId);
      // Not onBack: the letter is gone, so there is no unsaved work left
      // to warn about and the shell must leave without asking again.
      onDiscarded();
    } catch (cause) {
      setDiscardError(
        errorMessage(cause, 'The letter could not be discarded. Nothing was changed.'),
      );
      setDiscardPending(false);
    }
  }

  const scheduleIds = useMemo(() => {
    if (items === null) return [];
    const ids: string[] = [];
    for (const item of items) {
      if (!ids.includes(item.scheduleId)) ids.push(item.scheduleId);
    }
    return ids;
  }, [items]);
  const accordion = useScheduleAccordion(scheduleIds);

  // Exact-decimal reconciliation over the CURRENT rows (edits, added and
  // removed rows included): Σ quantity × rate in BigInt minor units,
  // never floats. Null until every row carries plain decimals.
  const rowsTotal = useMemo(
    () => (items === null ? null : exactRowsTotal(items)),
    [items],
  );
  const advertisedDifference = useMemo(() => {
    if (rowsTotal === null || header === null) return null;
    // Both sides are read at the row total's own scale — quantity (3 dp) ×
    // rate (6 dp) lands on 9. Parsing narrower silently dropped the whole
    // comparison whenever a rate carried more than a paisa of decimals.
    const totalMinor = parseDecimalMinorUnits(rowsTotal, 9);
    const advertisedMinor = parseDecimalMinorUnits(header.advertisedValue, 9);
    if (totalMinor === null || advertisedMinor === null) return null;
    const diff = totalMinor - advertisedMinor;
    const negative = diff < 0n;
    const magnitude = negative ? -diff : diff;
    return `${negative ? '-' : ''}₹${formatMinorUnits(magnitude, 9)}`;
  }, [rowsTotal, header]);

  const contractValueContext = useMemo(() => {
    if (header === null || header.contractValue.trim() === '') return '';
    if (header.pricingShape === 'per_schedule') {
      return ` Contract value ₹${header.contractValue} comes from the accepted schedule totals.`;
    }
    if (header.letterPercentageDirection === 'at_par') {
      return ` Contract value ₹${header.contractValue} is accepted at par.`;
    }
    if (
      header.letterPercentage.trim() !== '' &&
      (header.letterPercentageDirection === 'above' ||
        header.letterPercentageDirection === 'below')
    ) {
      return ` Contract value ₹${header.contractValue} reflects ${header.letterPercentage}% ${header.letterPercentageDirection} the advertised value.`;
    }
    return ` Contract value ₹${header.contractValue} uses the letter-level adjustment.`;
  }, [header]);

  // The same exact-integer path, one schedule at a time: reconciling a
  // letter is done schedule by schedule, so each table carries its own
  // subtotal in its foot. A schedule holding a half-typed or malformed
  // cell reports nothing rather than a wrong figure, and the server stays
  // authoritative for every stored amount.
  const scheduleSubtotals = useMemo(() => {
    const subtotals = new Map<string, string>();
    if (items === null) return subtotals;
    for (const scheduleId of scheduleIds) {
      const subtotal = exactRowsTotal(
        items.filter((item) => item.scheduleId === scheduleId),
      );
      if (subtotal !== null) subtotals.set(scheduleId, `₹${subtotal}`);
    }
    return subtotals;
  }, [items, scheduleIds]);

  function registerField(field: string, node: HTMLElement | null) {
    if (node === null) {
      fieldRefs.current.delete(field);
      return;
    }
    fieldRefs.current.set(field, node);
  }

  /** Moves focus onto the control that has to change. The form-level
   * role="alert" announces what went wrong; it says nothing about where a
   * keyboard user has to go to fix it, and on a letter with a hundred
   * editable rows the offending box is usually off screen. */
  function focusField(field: string) {
    fieldRefs.current.get(field)?.focus();
  }

  function updateHeader<K extends keyof HeaderDraft>(key: K, value: HeaderDraft[K]) {
    setHeader((current) => (current === null ? null : { ...current, [key]: value }));
  }

  function updatePbg<K extends keyof PbgDraft>(key: K, value: PbgDraft[K]) {
    setPbg((current) => (current === null ? null : { ...current, [key]: value }));
  }

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current === null
        ? null
        : current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  function addManualRow() {
    const scheduleId =
      addSchedule.trim().length > 0
        ? addSchedule.trim()
        : (scheduleIds[scheduleIds.length - 1] ?? 'A');
    const sno = `M${String(manualSequence.current)}`;
    manualSequence.current += 1;
    setItems((current) =>
      current === null
        ? null
        : [
            ...current,
            {
              key: `manual#${sno}`,
              scheduleId,
              itemSno: sno,
              needsReview: true,
              manual: true,
              anchorLine: '',
              locks: MANUAL_ROW_LOCKS,
              flags: [],
              itemNumber: `${scheduleId}/${sno}`,
              description: '',
              unitCode: '',
              awardedQuantity: '',
              effectiveRate: '',
              paymentCategory: '',
            },
          ],
    );
  }

  function removeRow(key: string) {
    setItems((current) =>
      current === null ? null : current.filter((item) => item.key !== key),
    );
    setRemoveCandidate(null);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (contractContextError !== null) {
      setConfirmError(
        'Matched tender evidence could not be loaded. Reload the page before confirming so no contract clause is silently omitted.',
      );
      return;
    }
    if (paymentMatrixProblem !== null) {
      setConfirmError(`Correct the initial payment matrix. ${paymentMatrixProblem}`);
      return;
    }
    if (header === null || items === null || pbg === null) return;
    const withPercentage = header.pricingShape === 'letter_percentage';
    // Every rule is checked in one pass. Answering one failure at a time
    // costs the reviewer a whole resubmission to learn that the PBG window
    // was wrong too, and this form is long enough that a second trip is a
    // second scroll through a hundred rows.
    const nextFieldErrors: Record<string, string> = {};
    const failures: string[] = [];
    const focusTargets: string[] = [];
    function flag(field: string, message: string) {
      nextFieldErrors[field] = message;
      failures.push(message);
      focusTargets.push(field);
    }
    if (!WORK_CODE_PATTERN.test(header.workCode.trim())) {
      flag(
        'work-code',
        'Enter a work code of letters, digits, and / _ - only, up to 20 characters.',
      );
    }
    if (header.letterNumber.trim().length === 0) {
      flag('letter-number', 'Enter the letter number printed on the LOA.');
    }
    if (!DATE_ONLY_PATTERN.test(header.letterDate)) {
      flag('letter-date', 'Enter the date printed on the letter.');
    }
    if (header.title.trim().length < 3) {
      flag('work-title', 'Describe the work in at least 3 characters.');
    }
    if (!DECIMAL_PATTERN.test(header.advertisedValue.trim())) {
      flag(
        'advertised-value',
        'Enter the advertised value in rupees, with up to three decimals.',
      );
    }
    if (!DECIMAL_PATTERN.test(header.contractValue.trim())) {
      flag(
        'contract-value',
        'Enter the accepted value in rupees, with up to three decimals.',
      );
    }
    if (withPercentage && !DECIMAL_PATTERN.test(header.letterPercentage.trim())) {
      flag('letter-percentage', 'Enter the percentage printed on the letter.');
    }
    if (withPercentage && header.letterPercentageDirection === '') {
      flag(
        'percentage-direction',
        'Select the percentage direction printed on the letter.',
      );
    }
    if (header.completionDate.length > 0) {
      if (!DATE_ONLY_PATTERN.test(header.completionDate)) {
        flag('completion-date', 'Enter the completion date, or leave it blank.');
      } else if (header.completionDate < header.letterDate) {
        // The same rule the column's CHECK and both server routes hold.
        flag('completion-date', 'The completion date cannot precede the letter date.');
      }
    }
    const submissionDays = Number.parseInt(pbg.submissionDays, 10);
    if (pbg.required && (!Number.isInteger(submissionDays) || submissionDays < 1)) {
      flag('pbg-submission-days', 'Enter the PBG submission window in days (1–180).');
    }
    if (items.length === 0) {
      // No row survives to be marked wrong, so the summary carries this one
      // alone and focus goes to the control that can satisfy the rule.
      failures.push('Add at least one item row before confirming.');
      focusTargets.push('add-row-schedule');
    }
    setFieldErrors(nextFieldErrors);
    // Fields are flagged in reading order, so the first one is the first
    // offender on screen.
    const firstInvalidField = focusTargets[0];
    if (firstInvalidField !== undefined) {
      setConfirmError(failures.join(' '));
      focusField(firstInvalidField);
      return;
    }
    const request: ConfirmWorkRequest = {
      workCode: header.workCode,
      letterNumber: header.letterNumber,
      letterDate: header.letterDate,
      title: header.title,
      advertisedValue: header.advertisedValue,
      contractValue: header.contractValue,
      pricingShape: header.pricingShape,
      gstBasis: header.gstBasis,
      ...(header.completionDate.length > 0
        ? { completionDate: header.completionDate }
        : {}),
      ...(withPercentage && header.letterPercentageDirection !== ''
        ? {
            letterPercentage: header.letterPercentage,
            letterPercentageDirection: header.letterPercentageDirection,
          }
        : {}),
      ...(pbg.required
        ? {
            pbgRequirement: {
              requiredAmount: pbg.requiredAmount.trim(),
              submissionDays,
              ...(pbg.extensionDays.trim().length > 0
                ? { extensionDays: Number.parseInt(pbg.extensionDays, 10) }
                : {}),
              ...(pbg.penalInterestPercent.trim().length > 0
                ? { penalInterestPercent: pbg.penalInterestPercent.trim() }
                : {}),
            },
          }
        : {}),
      ...(initialPaymentMatrix.length > 0
        ? { paymentMatrix: [...initialPaymentMatrix] }
        : {}),
      schedules: scheduleIds.map((scheduleId) => ({
        scheduleCode: scheduleId,
        title: `Schedule ${scheduleId}`,
        items: items
          .filter((item) => item.scheduleId === scheduleId)
          .map((item) => ({
            itemNumber: item.itemNumber,
            description: item.description,
            unitCode: item.unitCode,
            awardedQuantity: item.awardedQuantity,
            effectiveRate: item.effectiveRate,
            ...(item.paymentCategory !== ''
              ? { paymentCategory: item.paymentCategory }
              : {}),
            ...(item.manual
              ? { manualEntry: true as const }
              : { sourceRef: { scheduleId: item.scheduleId, itemSno: item.itemSno } }),
          })),
      })),
    };
    setPending(true);
    setConfirmError(null);
    try {
      onConfirmed(await api.confirmLoa(organisationId, documentId, request));
    } catch (cause) {
      setConfirmError(
        cause instanceof RequestFailedError
          ? `${cause.message}${cause.requestId === null ? '' : ` Reference: ${cause.requestId}.`}`
          : 'The Work could not be created. Nothing was saved.',
      );
      setPending(false);
    }
  }

  /* Mounted identically at the head of every branch below, so React keeps
   * the same two DOM nodes across the loading → loaded switch. That is the
   * whole trick: a live region only announces a CHANGE to text it already
   * had, so a region rendered for the first time alongside the arrived
   * content says nothing at all. */
  const arrivals = (
    <div className="sr-only">
      <p role="status">{extractionArrival}</p>
      <p role="status">{evidenceArrival}</p>
    </div>
  );

  if (loadError !== null) {
    return (
      <Card aria-labelledby="review-title">
        {arrivals}
        <PageHeader
          eyebrow="Contract source"
          title="Review LOA"
          titleId="review-title"
        />
        <ErrorState
          retryLabel="Retry document"
          onRetry={() => {
            setDocumentLoadVersion((current) => current + 1);
          }}
        >
          {loadError}
        </ErrorState>
      </Card>
    );
  }

  if (document === null) {
    return (
      <Card aria-labelledby="review-title">
        {arrivals}
        <PageHeader
          eyebrow="Contract source"
          title="Review LOA"
          titleId="review-title"
        />
        <LoadingState label="the document" rows={6} columns={3} />
      </Card>
    );
  }

  // A letter that has not been read YET is not a letter that failed, and
  // this branch used to say it was: since pack P18 the reading happens in
  // the worker, so a `pending` or `processing` document reaches here with
  // no payload perfectly normally — through the duplicate-refusal card's
  // "open the document" action, or any deep link — and was told extraction
  // had produced nothing and to upload a clearer copy. That is false, and
  // acting on it (re-uploading) would be refused as a duplicate.
  //
  // No spinner and no progress: there is nothing honest to show, and the
  // P8 conventions do not invent one. A plain sentence and the way back.
  const stillBeingRead =
    document.extractionStatus === 'pending' ||
    document.extractionStatus === 'processing';

  if (stillBeingRead) {
    return (
      <Card aria-labelledby="review-title">
        {arrivals}
        <PageHeader
          eyebrow="Contract source"
          title="Review LOA"
          titleId="review-title"
        />
        <EmptyState action={{ label: 'Back to Works', onClick: onBack }}>
          {document.originalFilename} has been stored and is still being read. Its items
          and dates appear here once the reading finishes; open it again in a moment.
        </EmptyState>
      </Card>
    );
  }

  if (
    payload === null ||
    locks === null ||
    header === null ||
    items === null ||
    pbg === null
  ) {
    return (
      <Card aria-labelledby="review-title">
        {arrivals}
        <PageHeader
          eyebrow="Contract source"
          title="Review LOA"
          titleId="review-title"
        />
        <FormError>
          Extraction did not produce reviewable content for {document.originalFilename}.
          Upload a clearer copy or contact support.
        </FormError>
        <Actions>
          <Button variant="outline" onClick={onBack}>
            Back to Works
          </Button>
        </Actions>
      </Card>
    );
  }

  const flagged = payload.review.needsReview.total;
  /** Whether the letter established anything at all. A letter whose whole
   * header the parser missed shows no panel rather than an empty box. */
  const hasLetterFacts =
    locks.letterNumber ||
    locks.letterDate ||
    locks.title ||
    locks.advertisedValue ||
    locks.contractValue ||
    locks.pricingShape ||
    locks.letterPercentage ||
    locks.letterPercentageDirection;

  return (
    <Card className="w-full" aria-labelledby="review-title">
      {arrivals}
      <PageHeader
        eyebrow="Contract source"
        title={`Review ${document.originalFilename}`}
        titleId="review-title"
        description="The letter is the source of truth for this Work. Values read off it are shown as printed and cannot be edited here; only the values the parser could not read are yours to supply. Nothing becomes a Work until you confirm."
      />

      {/* The rule, and the one way out of it. Placed before the review
          issues: a reviewer who disagrees with an extracted value needs to
          know now that the exit is a corrected letter, not a keystroke. */}
      <div
        className="my-3 rounded-lg border border-border bg-muted/40 px-4 py-3"
        role="note"
        aria-labelledby="extracted-lock-title"
        data-testid="extracted-lock-note"
      >
        <h2 id="extracted-lock-title">Extracted values are read-only</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every quantity, rate, percentage and date recorded against this Work is
          measured from what this letter says, so the extraction is kept exactly as
          printed. Fields the parser flagged stay editable and carry its flag.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Wrong? Discard this letter and upload a corrected one — an extracted value is
          never quietly overwritten.
        </p>
        {canModify && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            aria-haspopup="dialog"
            onClick={() => {
              setDiscardAsked(true);
            }}
          >
            Discard this letter
          </Button>
        )}
        {canModify && discardAsked && (
          <ConfirmDialog
            title={`Discard ${document.originalFilename}?`}
            description="The file stays on record for retention, but leaves the review list. Upload the corrected letter to start again."
            cancelLabel="Keep reviewing"
            confirmLabel="Confirm discard"
            pending={discardPending}
            onCancel={() => {
              setDiscardAsked(false);
              setDiscardError(null);
            }}
            onConfirm={() => void discard()}
          >
            {discardError !== null && <FormError>{discardError}</FormError>}
          </ConfirmDialog>
        )}
        {/* A refusal arriving with the confirmation open is shown inside
            it; behind a modal it would be unreadable. */}
        {discardError !== null && !discardAsked && (
          <FormError>{discardError}</FormError>
        )}
      </div>

      {/* Before everything else about the letter's CONTENT, because it is
          a question about the letter's AUTHENTICITY: whether this file is
          the document the Railway signed. A reviewer who is going to
          reject the file should not first spend twenty minutes correcting
          rows in it. */}
      <SignaturePanel
        status={document.signatureStatus}
        verdict={document.signatureVerdict}
      />

      {/* Above the review issues on purpose: a letter number that already
          belongs to something is the one thing that should stop a
          reviewer BEFORE they spend twenty minutes correcting rows. It is
          a warning and not a refusal — a corrigendum or a re-issued
          acceptance legitimately repeats the number of the letter it
          replaces, and only the reviewer knows which this is. */}
      {document.letterNumberMatches.length > 0 && (
        <div
          className="my-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
          role="note"
          aria-labelledby="letter-number-conflict-title"
          data-testid="letter-number-conflict"
        >
          <h2 id="letter-number-conflict-title">
            Letter number {document.letterNumberMatches[0]?.letterNumber} is already on
            record
          </h2>
          <ul className="mt-2 flex flex-col gap-2 pl-[1.125rem]">
            {document.letterNumberMatches.map((match) => (
              <li key={`${match.kind}-${match.id}`}>
                {match.kind === 'work' ? (
                  <>
                    Work <strong>{match.label}</strong> was created from a letter
                    carrying this number on {formatTimestampDate(match.at)} (
                    {match.status}).
                  </>
                ) : (
                  <>
                    <strong>{match.label}</strong>, uploaded{' '}
                    {formatTimestampDate(match.at)}, carries this number and is{' '}
                    {match.status}.
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-muted-foreground">
            {document.letterNumberMatches.some((match) => match.kind === 'work')
              ? 'This file is not byte-identical to the earlier intake, so it may be a revised or re-issued letter — but a letter number belongs to one Work forever, so confirming under this number will be refused. Record the revision under the number the revised letter actually prints, or amend the existing Work instead.'
              : 'This file is not byte-identical to the earlier upload, so it may be a revised or re-issued letter. Only one of them can become a Work: confirm the one that governs, and discard the other.'}
          </p>
        </div>
      )}

      {flagged > 0 && (
        <div
          className="my-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
          role="note"
          aria-labelledby="flags-title"
        >
          <h2 id="flags-title">
            {flagged} review issue{flagged === 1 ? '' : 's'}{' '}
            {flagged === 1 ? 'needs' : 'need'} attention
          </h2>
          <ul className="mt-2 flex flex-col gap-2 pl-[1.125rem]">
            {payload.review.flags.map((flag, index) => (
              <li key={`${flag.code}-${String(index)}`}>
                <StatusChip status="review">{flag.code}</StatusChip> {flag.message}
                <details>
                  <summary>Printed source</summary>
                  <pre className="my-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {flag.rawBlock}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {contractContextError !== null && (
        // The retry re-runs the evidence load only: the corrections typed
        // into this screen are not saved anywhere yet, and reloading the
        // document would take them with it.
        <ErrorState
          retryLabel="Retry tender evidence"
          onRetry={() => {
            setContextLoadVersion((current) => current + 1);
          }}
        >
          {contractContextError} Load it before confirming, so tender evidence is not
          omitted silently.
        </ErrorState>
      )}
      {contractContext === null && contractContextError === null ? (
        <LoadingState label="the matched tender evidence" rows={2} />
      ) : contractContext !== null ? (
        <TenderTermsReview
          context={contractContext}
          itemNumbers={items.map((item) => item.itemNumber)}
          canModify={canModify}
          onPaymentMatrixChange={handlePaymentMatrixChange}
        />
      ) : null}

      {/* noValidate: the checks in confirm() replace the native ones so that
          every failure names its field, binds a message, and moves focus. */}
      <form noValidate onSubmit={(event) => void confirm(event)}>
        <h2>Letter details</h2>
        {/* What the letter itself says. Read-only text, not disabled
            controls: these are not fields the reviewer is locked out of,
            they are the letter's own values, and the only thing that
            changes one is a corrected letter. */}
        {hasLetterFacts && (
          <ExtractedFacts testId="letter-facts" caption="Values read from the letter">
            {locks.letterNumber && (
              <ExtractedFact
                label="Letter number"
                value={header.letterNumber}
                numeric
                testId="fact-letter-number"
              />
            )}
            {locks.letterDate && (
              <ExtractedFact
                label="Letter date"
                value={formatDate(header.letterDate)}
                numeric
                testId="fact-letter-date"
              />
            )}
            {locks.title && (
              <ExtractedFact
                label="Work description"
                value={header.title}
                testId="fact-title"
              />
            )}
            {locks.advertisedValue && (
              <ExtractedFact
                label="Advertised value"
                value={`₹${header.advertisedValue}`}
                numeric
                testId="fact-advertised-value"
              />
            )}
            {locks.contractValue && (
              <ExtractedFact
                label="Accepted value"
                value={`₹${header.contractValue}`}
                numeric
                testId="fact-contract-value"
              />
            )}
            {locks.pricingShape && (
              <ExtractedFact
                label="Pricing shape"
                value={PRICING_SHAPE_WORDS[header.pricingShape]}
                testId="fact-pricing-shape"
              />
            )}
            {locks.letterPercentage && (
              <ExtractedFact
                label="Percentage"
                value={`${header.letterPercentage}%`}
                numeric
                testId="fact-letter-percentage"
              />
            )}
            {locks.letterPercentageDirection &&
              header.letterPercentageDirection !== '' && (
                <ExtractedFact
                  label="Direction"
                  value={DIRECTION_WORDS[header.letterPercentageDirection]}
                  testId="fact-percentage-direction"
                />
              )}
          </ExtractedFacts>
        )}
        <FieldRow>
          {/* The contractor's own filing reference. The letter does not
              print it, so it is the reviewer's to choose. */}
          <Field>
            <label htmlFor="work-code">Work code (your reference)</label>
            <input
              id="work-code"
              ref={(node) => {
                registerField('work-code', node);
              }}
              value={header.workCode}
              onChange={(event) => {
                updateHeader('workCode', event.target.value.toUpperCase());
              }}
              required
              pattern="[A-Z0-9][A-Z0-9_/-]{0,19}"
              // The pattern's own 20-character bound, said by the control
              // instead of only by the refusal after submit. Typing is
              // stopped at the limit; the pattern still decides the rest.
              maxLength={20}
              autoComplete="off"
              aria-invalid={fieldErrors['work-code'] !== undefined}
              aria-describedby={
                fieldErrors['work-code'] === undefined
                  ? 'work-code-hint'
                  : 'work-code-hint work-code-error'
              }
            />
            <Hint id="work-code-hint">
              Up to 20 characters: letters, digits, and / _ - only, upper-cased as you
              type. It prints on every document for this Work and numbers its challan
              series, so pick the reference your own filing already uses.
            </Hint>
            {fieldErrors['work-code'] !== undefined && (
              <FieldError id="work-code-error">{fieldErrors['work-code']}</FieldError>
            )}
          </Field>
          {/* The GST basis (migration 0062). Always asked, never
              extracted: the letter is silent on GST, and the declaration
              appears on the railway's own bill instead. It cannot be
              changed later, because executed value — and therefore
              whether this Work may ever be marked completed — is measured
              against it, so the hint says which way the rare answer
              matters. */}
          <Field>
            <label htmlFor="gst-basis">Rates quoted</label>
            <select
              id="gst-basis"
              ref={(node) => {
                registerField('gst-basis', node);
              }}
              value={header.gstBasis}
              onChange={(event) => {
                updateHeader('gstBasis', event.target.value as GstBasis);
              }}
            >
              <option value="inclusive">Inclusive of GST (18%)</option>
              <option value="exclusive">Exclusive of GST (18% extra)</option>
            </select>
            <Hint>
              Almost every works-contract LOA quotes rates inclusive of GST. Check the
              letter and the schedule before choosing the other: executed value is
              measured against this, and reading an exclusive letter as inclusive
              overstates execution by 18%.
            </Hint>
          </Field>
          {!locks.letterNumber && (
            <Field>
              <label htmlFor="letter-number">Letter number</label>
              <input
                id="letter-number"
                ref={(node) => {
                  registerField('letter-number', node);
                }}
                value={header.letterNumber}
                onChange={(event) => {
                  updateHeader('letterNumber', event.target.value);
                }}
                required
                aria-invalid={fieldErrors['letter-number'] !== undefined}
                aria-describedby={
                  fieldErrors['letter-number'] !== undefined
                    ? 'letter-number-error'
                    : undefined
                }
              />
              <Hint>
                The parser could not read the letter number; enter it as printed.
              </Hint>
              {fieldErrors['letter-number'] !== undefined && (
                <FieldError id="letter-number-error">
                  {fieldErrors['letter-number']}
                </FieldError>
              )}
            </Field>
          )}
          {!locks.letterDate && (
            <Field>
              <label htmlFor="letter-date">Letter date</label>
              <input
                id="letter-date"
                ref={(node) => {
                  registerField('letter-date', node);
                }}
                type="date"
                value={header.letterDate}
                onChange={(event) => {
                  updateHeader('letterDate', event.target.value);
                }}
                required
                aria-invalid={fieldErrors['letter-date'] !== undefined}
                aria-describedby={
                  fieldErrors['letter-date'] !== undefined
                    ? 'letter-date-error'
                    : undefined
                }
              />
              <Hint>
                The parser could not read the date printed on the letter; enter it.
              </Hint>
              {fieldErrors['letter-date'] !== undefined && (
                <FieldError id="letter-date-error">
                  {fieldErrors['letter-date']}
                </FieldError>
              )}
            </Field>
          )}
        </FieldRow>
        <Field>
          <label htmlFor="completion-date">Completion date</label>
          <input
            id="completion-date"
            ref={(node) => {
              registerField('completion-date', node);
            }}
            type="date"
            value={header.completionDate}
            onChange={(event) => {
              updateHeader('completionDate', event.target.value);
            }}
            aria-invalid={fieldErrors['completion-date'] !== undefined}
            aria-describedby={
              fieldErrors['completion-date'] !== undefined
                ? 'completion-date-error'
                : 'completion-date-hint'
            }
          />
          {/* The derivation, stated rather than implied: the reviewer is
              being asked to confirm arithmetic, and arithmetic they
              cannot see is arithmetic they cannot check. It is a
              proposal — the letter's period is what the parser read, and
              the date is theirs to overwrite or clear. */}
          <Hint id="completion-date-hint">
            {completionPeriod !== null
              ? `${completionPeriod} from the letter date${
                  derivedCompletionDate === null
                    ? '. Enter the date the contract runs to.'
                    : `, which is ${formatDate(derivedCompletionDate)}. Overwrite it if the letter says otherwise.`
                }`
              : 'The letter states no completion period. Enter the date the contract runs to, or leave it blank and set it later.'}
          </Hint>
          {fieldErrors['completion-date'] !== undefined && (
            <FieldError id="completion-date-error">
              {fieldErrors['completion-date']}
            </FieldError>
          )}
        </Field>
        {!locks.title && (
          <Field>
            <label htmlFor="work-title">Work description</label>
            <textarea
              id="work-title"
              ref={(node) => {
                registerField('work-title', node);
              }}
              value={header.title}
              onChange={(event) => {
                updateHeader('title', event.target.value);
              }}
              required
              minLength={3}
              rows={2}
              aria-invalid={fieldErrors['work-title'] !== undefined}
              aria-describedby={
                fieldErrors['work-title'] !== undefined ? 'work-title-error' : undefined
              }
            />
            <Hint>
              The parser could not read the name of work; enter it as printed.
            </Hint>
            {fieldErrors['work-title'] !== undefined && (
              <FieldError id="work-title-error">{fieldErrors['work-title']}</FieldError>
            )}
          </Field>
        )}
        <FieldRow>
          {!locks.advertisedValue && (
            <Field>
              <label htmlFor="advertised-value">Advertised value (₹)</label>
              <input
                id="advertised-value"
                ref={(node) => {
                  registerField('advertised-value', node);
                }}
                value={header.advertisedValue}
                onChange={(event) => {
                  updateHeader('advertisedValue', event.target.value);
                }}
                required
                inputMode="decimal"
                aria-invalid={fieldErrors['advertised-value'] !== undefined}
                aria-describedby={
                  fieldErrors['advertised-value'] !== undefined
                    ? 'advertised-value-error'
                    : undefined
                }
              />
              {fieldErrors['advertised-value'] !== undefined && (
                <FieldError id="advertised-value-error">
                  {fieldErrors['advertised-value']}
                </FieldError>
              )}
            </Field>
          )}
          {!locks.contractValue && (
            <Field>
              <label htmlFor="contract-value">Contract value (₹)</label>
              <input
                id="contract-value"
                ref={(node) => {
                  registerField('contract-value', node);
                }}
                value={header.contractValue}
                onChange={(event) => {
                  updateHeader('contractValue', event.target.value);
                }}
                required
                inputMode="decimal"
                aria-invalid={fieldErrors['contract-value'] !== undefined}
                aria-describedby={
                  fieldErrors['contract-value'] !== undefined
                    ? 'contract-value-error'
                    : undefined
                }
              />
              {fieldErrors['contract-value'] !== undefined && (
                <FieldError id="contract-value-error">
                  {fieldErrors['contract-value']}
                </FieldError>
              )}
            </Field>
          )}
          {!locks.pricingShape && (
            <Field>
              <label htmlFor="pricing-shape">Pricing shape</label>
              <select
                id="pricing-shape"
                value={header.pricingShape}
                onChange={(event) => {
                  updateHeader(
                    'pricingShape',
                    event.target.value as HeaderDraft['pricingShape'],
                  );
                }}
              >
                <option value="letter_percentage">Letter percentage</option>
                <option value="per_schedule">Per-schedule totals</option>
              </select>
            </Field>
          )}
        </FieldRow>
        {header.pricingShape === 'letter_percentage' &&
          (!locks.letterPercentage || !locks.letterPercentageDirection) && (
            <FieldRow>
              {!locks.letterPercentage && (
                <Field>
                  <label htmlFor="letter-percentage">Percentage</label>
                  <input
                    id="letter-percentage"
                    ref={(node) => {
                      registerField('letter-percentage', node);
                    }}
                    value={header.letterPercentage}
                    onChange={(event) => {
                      updateHeader('letterPercentage', event.target.value);
                    }}
                    required
                    inputMode="decimal"
                    aria-invalid={fieldErrors['letter-percentage'] !== undefined}
                    aria-describedby={
                      fieldErrors['letter-percentage'] !== undefined
                        ? 'letter-percentage-error'
                        : undefined
                    }
                  />
                  <Hint>
                    The letter declares no percentage of its own; an at-par acceptance
                    is recorded as 0.
                  </Hint>
                  {fieldErrors['letter-percentage'] !== undefined && (
                    <FieldError id="letter-percentage-error">
                      {fieldErrors['letter-percentage']}
                    </FieldError>
                  )}
                </Field>
              )}
              {!locks.letterPercentageDirection && (
                <Field>
                  <label htmlFor="percentage-direction">Direction</label>
                  <select
                    id="percentage-direction"
                    ref={(node) => {
                      registerField('percentage-direction', node);
                    }}
                    value={header.letterPercentageDirection}
                    onChange={(event) => {
                      updateHeader(
                        'letterPercentageDirection',
                        event.target.value as HeaderDraft['letterPercentageDirection'],
                      );
                    }}
                    required
                    aria-invalid={fieldErrors['percentage-direction'] !== undefined}
                    aria-describedby={
                      fieldErrors['percentage-direction'] !== undefined
                        ? 'percentage-direction-error'
                        : undefined
                    }
                  >
                    <option value="">Choose…</option>
                    <option value="below">Below</option>
                    <option value="at_par">At par</option>
                    <option value="above">Above</option>
                  </select>
                  {fieldErrors['percentage-direction'] !== undefined && (
                    <FieldError id="percentage-direction-error">
                      {fieldErrors['percentage-direction']}
                    </FieldError>
                  )}
                </Field>
              )}
            </FieldRow>
          )}

        <h2>Performance guarantee requirement</h2>
        <p className="text-muted-foreground">
          What the letter demands, not what has been submitted — record the submitted
          bank guarantee later as a PBG instrument on the Work.
        </p>
        {payload.review.header.performanceGuarantee?.needsReview === true && (
          <p className="text-muted-foreground">
            <StatusChip status="review">needs review</StatusChip> The parser could not
            fully read the performance-guarantee clause; check the printed source below
            and enter what the letter demands.
          </p>
        )}
        {locks.pbgClause ? (
          // The clause was read cleanly: what it demands, and by when, is
          // the letter's word. Only the parts the parser could not read
          // stay open below.
          <ExtractedFacts
            testId="pbg-facts"
            caption="Performance guarantee read from the letter"
          >
            <ExtractedFact
              label="Required amount"
              value={`₹${pbg.requiredAmount}`}
              numeric
              testId="fact-pbg-amount"
            />
            <ExtractedFact
              label="Submit within"
              value={`${pbg.submissionDays} days`}
              numeric
              testId="fact-pbg-submission-days"
            />
            {locks.pbgExtensionDays && (
              <ExtractedFact
                label="Extension window"
                value={`${pbg.extensionDays} days`}
                numeric
                testId="fact-pbg-extension-days"
              />
            )}
            {locks.pbgPenalInterest && (
              <ExtractedFact
                label="Penal interest"
                value={`${pbg.penalInterestPercent}% p.a.`}
                numeric
                testId="fact-pbg-penal-interest"
              />
            )}
          </ExtractedFacts>
        ) : (
          <Field>
            <label>
              <input
                type="checkbox"
                checked={pbg.required}
                onChange={(event) => {
                  updatePbg('required', event.target.checked);
                }}
              />{' '}
              The letter demands a Performance Bank Guarantee
            </label>
          </Field>
        )}
        {(locks.pbgClause || pbg.required) && (
          <FieldRow>
            {!locks.pbgClause && (
              <Field>
                <label htmlFor="pbg-amount">Required amount (₹)</label>
                <input
                  id="pbg-amount"
                  value={pbg.requiredAmount}
                  onChange={(event) => {
                    updatePbg('requiredAmount', event.target.value);
                  }}
                  required
                  inputMode="decimal"
                />
              </Field>
            )}
            {!locks.pbgClause && (
              <Field>
                <label htmlFor="pbg-submission-days">Submit within (days)</label>
                <input
                  id="pbg-submission-days"
                  type="number"
                  min={1}
                  max={180}
                  ref={(node) => {
                    registerField('pbg-submission-days', node);
                  }}
                  value={pbg.submissionDays}
                  onChange={(event) => {
                    updatePbg('submissionDays', event.target.value);
                  }}
                  required
                  aria-invalid={fieldErrors['pbg-submission-days'] !== undefined}
                  aria-describedby={
                    fieldErrors['pbg-submission-days'] !== undefined
                      ? 'pbg-submission-days-error'
                      : undefined
                  }
                />
                {fieldErrors['pbg-submission-days'] !== undefined && (
                  <FieldError id="pbg-submission-days-error">
                    {fieldErrors['pbg-submission-days']}
                  </FieldError>
                )}
              </Field>
            )}
            {!locks.pbgExtensionDays && (
              <Field>
                <label htmlFor="pbg-extension-days">Extension window (days)</label>
                <input
                  id="pbg-extension-days"
                  type="number"
                  min={0}
                  value={pbg.extensionDays}
                  onChange={(event) => {
                    updatePbg('extensionDays', event.target.value);
                  }}
                />
              </Field>
            )}
            {!locks.pbgPenalInterest && (
              <Field>
                <label htmlFor="pbg-penal-interest">Penal interest (% p.a.)</label>
                <input
                  id="pbg-penal-interest"
                  value={pbg.penalInterestPercent}
                  onChange={(event) => {
                    updatePbg('penalInterestPercent', event.target.value);
                  }}
                  inputMode="decimal"
                />
              </Field>
            )}
          </FieldRow>
        )}
        {typeof payload.review.header.performanceGuarantee?.raw === 'string' && (
          <details>
            <summary>Printed source (performance guarantee)</summary>
            <pre className="my-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {payload.review.header.performanceGuarantee.raw}
            </pre>
          </details>
        )}

        <h2>Awarded items</h2>
        <ScheduleAccordionControls
          accordion={accordion}
          scheduleCount={scheduleIds.length}
          itemCount={items.length}
        />
        {scheduleIds.map((scheduleId) => (
          <ScheduleSection
            key={scheduleId}
            code={scheduleId}
            itemCount={items.filter((item) => item.scheduleId === scheduleId).length}
            total={scheduleSubtotals.get(scheduleId) ?? null}
            expanded={accordion.isExpanded(scheduleId)}
            onToggle={() => {
              accordion.toggle(scheduleId);
            }}
          >
            <DataTable scroll className="[&_input]:w-28">
              <caption className="sr-only">
                Awarded items in schedule {scheduleId}. Values read from the letter are
                shown as printed; only the ones the parser could not read are editable.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Item number</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Rate (₹)</th>
                  <th scope="col">Payment category</th>
                  <th scope="col">Row actions</th>
                </tr>
              </thead>
              <tbody>
                {items
                  .filter((item) => item.scheduleId === scheduleId)
                  .map((item) => (
                    <tr
                      key={item.key}
                      className={item.needsReview ? 'row--flagged' : undefined}
                    >
                      <td>
                        {/* The product's own per-Work label, not a parser
                            field: the row's binding to its printed source
                            is the sourceRef, which no relabelling moves. */}
                        <input
                          aria-label={`Item number for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.itemNumber}
                          onChange={(event) => {
                            updateItem(item.key, { itemNumber: event.target.value });
                          }}
                          required
                        />
                      </td>
                      <td className={wrapCell}>
                        {item.locks.description ? (
                          <LockedCell
                            value={item.description}
                            label={`Description for row ${item.itemSno} in schedule ${scheduleId}`}
                          />
                        ) : (
                          <DescriptionCell
                            item={item}
                            scheduleId={scheduleId}
                            onChange={(description) => {
                              updateItem(item.key, { description });
                            }}
                          />
                        )}
                        {item.manual ? (
                          <p className="text-muted-foreground">
                            <StatusChip status="review">manual row</StatusChip> Added by
                            you — the parsed letter has no printed source row for it.
                          </p>
                        ) : (
                          <details>
                            <summary>Printed source row</summary>
                            <pre className="my-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
                              {item.anchorLine}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td>
                        {item.locks.unitCode ? (
                          <LockedCell
                            value={item.unitCode}
                            label={`Unit for row ${item.itemSno} in schedule ${scheduleId}`}
                          />
                        ) : (
                          <>
                            <input
                              aria-label={`Unit for row ${item.itemSno} in schedule ${scheduleId}`}
                              value={item.unitCode}
                              onChange={(event) => {
                                updateItem(item.key, { unitCode: event.target.value });
                              }}
                              required
                              maxLength={20}
                            />
                            <ParserHoleNote flags={item.flags} />
                          </>
                        )}
                      </td>
                      <td>
                        {item.locks.awardedQuantity ? (
                          <LockedCell
                            value={item.awardedQuantity}
                            numeric
                            label={`Quantity for row ${item.itemSno} in schedule ${scheduleId}`}
                          />
                        ) : (
                          <input
                            aria-label={`Quantity for row ${item.itemSno} in schedule ${scheduleId}`}
                            value={item.awardedQuantity}
                            onChange={(event) => {
                              updateItem(item.key, {
                                awardedQuantity: event.target.value,
                              });
                            }}
                            required
                            inputMode="decimal"
                          />
                        )}
                      </td>
                      <td>
                        {item.locks.effectiveRate ? (
                          <LockedCell
                            value={item.effectiveRate}
                            numeric
                            label={`Rate for row ${item.itemSno} in schedule ${scheduleId}`}
                          />
                        ) : (
                          <input
                            aria-label={`Rate for row ${item.itemSno} in schedule ${scheduleId}`}
                            value={item.effectiveRate}
                            onChange={(event) => {
                              updateItem(item.key, {
                                effectiveRate: event.target.value,
                              });
                            }}
                            required
                            inputMode="decimal"
                          />
                        )}
                      </td>
                      <td className={controlCell}>
                        {/* Optional, reviewer's judgement — extraction
                            proposes no category, because the letter's
                            item table does not carry one. A row left
                            uncategorised here is offered a keyword
                            PROPOSAL by the payment setup dialog after the
                            Work is created; a row decided here is left
                            exactly as it stands. Percentages are
                            configured per category on the Work's payment
                            matrix, never per item (R10). */}
                        <select
                          aria-label={`Payment category for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.paymentCategory}
                          onChange={(event) => {
                            updateItem(item.key, {
                              paymentCategory: event.target
                                .value as ItemDraft['paymentCategory'],
                            });
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
                      </td>
                      <td>
                        {removeCandidate === item.key ? (
                          <span className="mt-4 flex flex-wrap items-center gap-2 print:hidden">
                            <Button
                              onClick={() => {
                                removeRow(item.key);
                              }}
                            >
                              Confirm remove
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => {
                                setRemoveCandidate(null);
                              }}
                            >
                              Keep
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            aria-label={`Remove row ${item.itemSno} in schedule ${scheduleId}`}
                            onClick={() => {
                              setRemoveCandidate(item.key);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
              {/* The subtotal belongs in the foot, where a table's summary
                  is announced. It is a reconciliation aid for the reviewer's
                  eye only — the server recomputes and stores every amount. */}
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4}>
                    Schedule {scheduleId} subtotal
                  </th>
                  <td colSpan={3} data-testid={`schedule-subtotal-${scheduleId}`}>
                    <strong>
                      {scheduleSubtotals.get(scheduleId) ?? 'Not yet available'}
                    </strong>
                  </td>
                </tr>
              </tfoot>
            </DataTable>
          </ScheduleSection>
        ))}

        <h2>Add a row</h2>
        <p className="text-muted-foreground">
          For letters the parser could not fully serve: added rows are flagged for
          review and confirmed with a manual-entry marker instead of a printed source
          row. Removing a parsed row never edits the stored letter — the extraction
          stays intact on the document.
        </p>
        <FieldRow>
          <Field>
            <label htmlFor="add-row-schedule">Schedule for the new row</label>
            <input
              id="add-row-schedule"
              ref={(node) => {
                registerField('add-row-schedule', node);
              }}
              value={addSchedule}
              onChange={(event) => {
                setAddSchedule(event.target.value);
              }}
              maxLength={50}
            />
          </Field>
          <Actions>
            <Button onClick={addManualRow}>Add row</Button>
          </Actions>
        </FieldRow>

        <p className="text-muted-foreground" data-testid="reconciliation-totals">
          {rowsTotal === null
            ? 'Row totals will appear when every quantity and rate is a plain decimal number.'
            : `Entered rows total ₹${rowsTotal} across ${String(items.length)} row${items.length === 1 ? '' : 's'}${
                advertisedDifference === null
                  ? ''
                  : ` — advertised value ₹${header.advertisedValue} (difference ${advertisedDifference})`
              }.${contractValueContext}`}
        </p>

        {confirmError !== null && <FormError>{confirmError}</FormError>}

        <ActionBar className="flex-wrap">
          {canModify && (
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating Work…' : 'Confirm and create Work'}
            </Button>
          )}
          <Button variant="outline" onClick={onBack}>
            Back to Works
          </Button>
        </ActionBar>
        {!canModify && (
          <p className="text-muted-foreground">
            Your role can review but not confirm; ask an owner or office member to
            confirm this letter.
          </p>
        )}
      </form>
    </Card>
  );
}
