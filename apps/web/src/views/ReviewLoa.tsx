import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  ConfirmPaymentMatrixRow,
  ConfirmWorkRequest,
  ContractSourceContext,
  LoaDocumentDetail,
  WorkDetailResponse,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { Card } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import {
  Field,
  FieldRow,
  Actions,
  ActionBar,
  FormError,
  FieldError,
} from '../ui/form.js';
import { TenderTermsReview } from './TenderTermsReview.js';
import {
  asExtractionPayload,
  exactRowsTotal,
  formatMinorUnits,
  normaliseDecimal,
  parseDecimalMinorUnits,
  type ExtractionPayloadView,
} from '../loa-payload.js';

interface ReviewLoaProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly documentId: string;
  readonly canModify: boolean;
  readonly onConfirmed: (work: WorkDetailResponse) => void;
  readonly onBack: () => void;
}

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
  itemNumber: string;
  description: string;
  unitCode: string;
  awardedQuantity: string;
  effectiveRate: string;
  /** Reviewer-set payment category (Milestone 8); '' = uncategorised.
   * The parser never proposes it â€” categorisation is the reviewer's
   * judgement, and it stays editable on the Work afterwards. */
  paymentCategory: WorkItemPaymentCategory | '';
}

/** The wire shapes these fields must satisfy. Mirrored from
 * DecimalStringSchema and DateOnlySchema so the form never accepts a value
 * the server will refuse â€” and never refuses one it would take. */
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
  };
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
      itemNumber: `${scheduleId}/${item.itemSno}`,
      description: item.description,
      unitCode: (item.qtyUnit ?? '').slice(0, 20),
      awardedQuantity: normaliseDecimal(item.qty, 3),
      effectiveRate: normaliseDecimal(item.unitRate, 6),
      paymentCategory: '',
    };
  });
}

export function ReviewLoa({
  api,
  organisationId,
  documentId,
  canModify,
  onConfirmed,
  onBack,
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
  const [header, setHeader] = useState<HeaderDraft | null>(null);
  const [items, setItems] = useState<ItemDraft[] | null>(null);
  const [pbg, setPbg] = useState<PbgDraft | null>(null);
  const [addSchedule, setAddSchedule] = useState('A');
  const [removeCandidate, setRemoveCandidate] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
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
    api
      .getLoaDocument(organisationId, documentId)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
        const payload = asExtractionPayload(loaded.extractionPayload);
        if (payload !== null) {
          const drafts = buildItemDrafts(payload);
          setHeader(buildHeaderDraft(payload));
          setItems(drafts);
          setPbg(buildPbgDraft(payload));
          const lastDraft = drafts[drafts.length - 1];
          setAddSchedule(lastDraft !== undefined ? lastDraft.scheduleId : 'A');
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The document could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, documentId]);

  useEffect(() => {
    let cancelled = false;
    setContractContext(null);
    setContractContextError(null);
    api
      .getLoaContractSourceContext(organisationId, documentId)
      .then((loaded) => {
        if (!cancelled) setContractContext(loaded);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setContractContextError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The matched tender evidence could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, documentId]);

  const handlePaymentMatrixChange = useCallback(
    (rows: readonly ConfirmPaymentMatrixRow[], problem: string | null) => {
      setInitialPaymentMatrix(rows);
      setPaymentMatrixProblem(problem);
    },
    [],
  );

  const payload = useMemo(
    () => (document === null ? null : asExtractionPayload(document.extractionPayload)),
    [document],
  );

  const scheduleIds = useMemo(() => {
    if (items === null) return [];
    const ids: string[] = [];
    for (const item of items) {
      if (!ids.includes(item.scheduleId)) ids.push(item.scheduleId);
    }
    return ids;
  }, [items]);

  // Exact-decimal reconciliation over the CURRENT rows (edits, added and
  // removed rows included): Î£ quantity Ã— rate in BigInt minor units,
  // never floats. Null until every row carries plain decimals.
  const rowsTotal = useMemo(
    () => (items === null ? null : exactRowsTotal(items)),
    [items],
  );
  const advertisedDifference = useMemo(() => {
    if (rowsTotal === null || header === null) return null;
    // Both sides are read at the row total's own scale â€” quantity (3 dp) Ã—
    // rate (6 dp) lands on 9. Parsing narrower silently dropped the whole
    // comparison whenever a rate carried more than a paisa of decimals.
    const totalMinor = parseDecimalMinorUnits(rowsTotal, 9);
    const advertisedMinor = parseDecimalMinorUnits(header.advertisedValue, 9);
    if (totalMinor === null || advertisedMinor === null) return null;
    const diff = totalMinor - advertisedMinor;
    const negative = diff < 0n;
    const magnitude = negative ? -diff : diff;
    return `${negative ? '-' : ''}â‚¹${formatMinorUnits(magnitude, 9)}`;
  }, [rowsTotal, header]);

  const contractValueContext = useMemo(() => {
    if (header === null || header.contractValue.trim() === '') return '';
    if (header.pricingShape === 'per_schedule') {
      return ` Contract value â‚¹${header.contractValue} comes from the accepted schedule totals.`;
    }
    if (header.letterPercentageDirection === 'at_par') {
      return ` Contract value â‚¹${header.contractValue} is accepted at par.`;
    }
    if (
      header.letterPercentage.trim() !== '' &&
      (header.letterPercentageDirection === 'above' ||
        header.letterPercentageDirection === 'below')
    ) {
      return ` Contract value â‚¹${header.contractValue} reflects ${header.letterPercentage}% ${header.letterPercentageDirection} the advertised value.`;
    }
    return ` Contract value â‚¹${header.contractValue} uses the letter-level adjustment.`;
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
      if (subtotal !== null) subtotals.set(scheduleId, `â‚¹${subtotal}`);
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
      flag('letter-date', 'Enter tç]¹¶‰žËkºwµç@€€€€€€€€€€€€€€€±•ÑÑ•ÉA•É•¹Ñ…•¥É•Ñ¥½¸œ°(€€€€€€€€€€€€€€€€€€€•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”…Ì!•…‘•ÉÉ…™Ñl±•ÑÑ•ÉA•É•¹Ñ…•¥É•Ñ¥½¸t°(€€€€€€€€€€€€€€€€€€¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍlÁ•É•¹Ñ…”µ‘¥É•Ñ¥½¸t€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍlÁ•É•¹Ñ…”µ‘¥É•Ñ¥½¸t€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€€€ü€Á•É•¹Ñ…”µ‘¥É•Ñ¥½¸µ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€ô(€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ôˆˆù¡½½Í—Š˜ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰‰•±½Üˆù	•±½Üð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰…Ñ}Á…ÈˆùÐÁ…Èð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰…‰½Ù”ˆù‰½Ù”ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍlÁ•É•¹Ñ…”µ‘¥É•Ñ¥½¸t€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰Á•É•¹Ñ…”µ‘¥É•Ñ¥½¸µ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍlÁ•É•¹Ñ…”µ‘¥É•Ñ¥½¸uô(€€€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€¥ô((€€€€€€€€ñ ÈùA•É™½Éµ…¹”Õ…É…¹Ñ•”É•ÅÕ¥É•µ•¹Ðð½ Èø(€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€]¡…ÐÑ¡”±•ÑÑ•È‘•µ…¹‘Ì°¹½ÐÝ¡…Ð¡…Ì‰••¸ÍÕ‰µ¥ÑÑ•ƒŠPÉ•½ÉÑ¡”ÍÕ‰µ¥ÑÑ•(€€€€€€€€€‰…¹¬Õ…É…¹Ñ•”±…Ñ•È…Ì„A	¥¹ÍÑÉÕµ•¹Ð½¸Ñ¡”]½É¬¸(€€€€€€€€ð½Àø(€€€€€€€íÁ…å±½…¹É•Ù¥•Ü¹¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”ü¹¹••‘ÍI•Ù¥•Ü€ôôôÑÉÕ”€˜˜€ (€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥ÀÍÑ…ÑÕÌô‰É•Ù¥•Üˆù¹••‘ÌÉ•Ù¥•Üð½MÑ…ÑÕÍ¡¥ÀøQ¡”Á…ÉÍ•È½Õ±¹½Ð(€€€€€€€€€€€™Õ±±äÉ•…Ñ¡”Á•É™½Éµ…¹”µÕ…É…¹Ñ•”±…ÕÍ”ì¡•¬Ñ¡”ÁÉ¥¹Ñ•Í½ÕÉ”‰•±½Ü(€€€€€€€€€€€…¹½ÉÉ•ÐÑ¡”Ù…±Õ•Ì¸(€€€€€€€€€€ð½Àø(€€€€€€€€¥ô(€€€€€€€€ñ¥•±ø(€€€€€€€€€€ñ±…‰•°ø(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€ÑåÁ”ô‰¡•­‰½àˆ(€€€€€€€€€€€€€¡•­•õíÁ‰œ¹É•ÅÕ¥É•‘ô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€ÕÁ‘…Ñ•A‰œ É•ÅÕ¥É•œ°•Ù•¹Ð¹Ñ…É•Ð¹¡•­•¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€¼ùìœ€ô(€€€€€€€€€€€Q¡”±•ÑÑ•È‘•µ…¹‘Ì„A•É™½Éµ…¹”	…¹¬Õ…É…¹Ñ•”(€€€€€€€€€€ð½±…‰•°ø(€€€€€€€€ð½¥•±ø(€€€€€€€íÁ‰œ¹É•ÅÕ¥É•€˜˜€ (€€€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Á‰œµ…µ½Õ¹ÐˆùI•ÅÕ¥É•…µ½Õ¹Ð€£Š
ä¤ð½±…‰•°ø(€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€¥ô‰Á‰œµ…µ½Õ¹Ðˆ(€€€€€€€€€€€€€€€Ù…±Õ”õíÁ‰œ¹É•ÅÕ¥É•‘µ½Õ¹Ñô(€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•A‰œ É•ÅÕ¥É•‘µ½Õ¹Ðœ°•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰‘•¥µ…°ˆ(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Á‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌˆùMÕ‰µ¥ÐÝ¥Ñ¡¥¸€¡‘…åÌ¤ð½±…‰•°ø(€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€¥ô‰Á‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌˆ(€€€€€€€€€€€€€€€ÑåÁ”ô‰¹Õµ‰•Èˆ(€€€€€€€€€€€€€€€µ¥¸õìÅô(€€€€€€€€€€€€€€€µ…àõìÄàÁô(€€€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± Á‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌœ°¹½‘”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€Ù…±Õ”õíÁ‰œ¹ÍÕ‰µ¥ÍÍ¥½¹…åÍô(€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•A‰œ ÍÕ‰µ¥ÍÍ¥½¹…åÌœ°•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€…É¥„µ¥¹Ù…±¥õí™¥•±‘ÉÉ½ÉÍlÁ‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌt€„ôôÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€€€…É¥„µ‘•ÍÉ¥‰•‘‰äõì(€€€€€€€€€€€€€€€€€™¥•±‘ÉÉ½ÉÍlÁ‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌt€„ôôÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€€€€€€ü€Á‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌµ•ÉÉ½Èœ(€€€€€€€€€€€€€€€€€€€€èÕ¹‘•™¥¹•(€€€€€€€€€€€€€€€ô(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍlÁ‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌt€„ôôÕ¹‘•™¥¹•€˜˜€ (€€€€€€€€€€€€€€€€ñ¥•±‘ÉÉ½È¥ô‰Á‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌµ•ÉÉ½Èˆø(€€€€€€€€€€€€€€€€€í™¥•±‘ÉÉ½ÉÍlÁ‰œµÍÕ‰µ¥ÍÍ¥½¸µ‘…åÌuô(€€€€€€€€€€€€€€€€ð½¥•±‘ÉÉ½Èø(€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Á‰œµ•áÑ•¹Í¥½¸µ‘…åÌˆùáÑ•¹Í¥½¸Ý¥¹‘½Ü€¡‘…åÌ¤ð½±…‰•°ø(€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€¥ô‰Á‰œµ•áÑ•¹Í¥½¸µ‘…åÌˆ(€€€€€€€€€€€€€€€ÑåÁ”ô‰¹Õµ‰•Èˆ(€€€€€€€€€€€€€€€µ¥¸õìÁô(€€€€€€€€€€€€€€€Ù…±Õ”õíÁ‰œ¹•áÑ•¹Í¥½¹…åÍô(€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•A‰œ •áÑ•¹Í¥½¹…åÌœ°•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰Á‰œµÁ•¹…°µ¥¹Ñ•É•ÍÐˆùA•¹…°¥¹Ñ•É•ÍÐ€ ”À¹„¸¤ð½±…‰•°ø(€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€¥ô‰Á‰œµÁ•¹…°µ¥¹Ñ•É•ÍÐˆ(€€€€€€€€€€€€€€€Ù…±Õ”õíÁ‰œ¹Á•¹…±%¹Ñ•É•ÍÑA•É•¹Ñô(€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•A‰œ Á•¹…±%¹Ñ•É•ÍÑA•É•¹Ðœ°•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰‘•¥µ…°ˆ(€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€ð½¥•±‘I½Üø(€€€€€€€€¥ô(€€€€€€€íÑåÁ•½˜Á…å±½…¹É•Ù¥•Ü¹¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”ü¹É…Ü€ôôô€ÍÑÉ¥¹œœ€˜˜€ (€€€€€€€€€€ñ‘•Ñ…¥±Ìø(€€€€€€€€€€€€ñÍÕµµ…ÉäùAÉ¥¹Ñ•Í½ÕÉ”€¡Á•É™½Éµ…¹”Õ…É…¹Ñ•”¤ð½ÍÕµµ…Éäø(€€€€€€€€€€€€ñÁÉ”±…ÍÍ9…µ”ô‰µä´ÄÉ½Õ¹‘•µµ‰½É‘•È‰½É‘•Èµ‰½É‘•È‰œµµÕÑ•Áà´ÌÁä´È™½¹Ðµµ½¹¼Ñ•áÐµáÌÝ¡¥Ñ•ÍÁ…”µÁÉ”µÝÉ…Àm½Ù•É™±½ÜµÝÉ…Àé…¹åÝ¡•É•tˆø(€€€€€€€€€€€€€íÁ…å±½…¹É•Ù¥•Ü¹¡•…‘•È¹Á•É™½Éµ…¹•Õ…É…¹Ñ•”¹É…Ýô(€€€€€€€€€€€€ð½ÁÉ”ø(€€€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€€€¥ô((€€€€€€€íÍ¡•‘Õ±•%‘Ì¹µ…À ¡Í¡•‘Õ±•%¤€ôø€ (€€€€€€€€€€ñ‘¥Ø­•äõíÍ¡•‘Õ±•%‘ôø(€€€€€€€€€€€€ñ ÈùM¡•‘Õ±”íÍ¡•‘Õ±•%‘ôð½ Èø(€€€€€€€€€€€€ñ…Ñ…Q…‰±”ÍÉ½±°±…ÍÍ9…µ”ô‰l™}¥¹ÁÕÑtéÜ´Èàˆø(€€€€€€€€€€€€€€ñ…ÁÑ¥½¸±…ÍÍ9…µ”ô‰ÍÈµ½¹±äˆø(€€€€€€€€€€€€€€€Ý…É‘•¥Ñ•µÌ¥¸Í¡•‘Õ±”íÍ¡•‘Õ±•%‘ôì•Ù•Éä™¥•±¥Ì•‘¥Ñ…‰±”(€€€€€€€€€€€€€€ð½…ÁÑ¥½¸ø(€€€€€€€€€€€€€€ñÑ¡•…ø(€€€€€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù%Ñ•´¹Õµ‰•Èð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆù•ÍÉ¥ÁÑ¥½¸ð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùU¹¥Ðð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùEÕ…¹Ñ¥Ñäð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùI…Ñ”€£Š
ä¤ð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùA…åµ•¹Ð…Ñ•½Éäð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰½°ˆùI½Ü…Ñ¥½¹Ìð½Ñ ø(€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€ð½Ñ¡•…ø(€€€€€€€€€€€€€€ñÑ‰½‘äø(€€€€€€€€€€€€€€€í¥Ñ•µÌ(€€€€€€€€€€€€€€€€€€¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹Í¡•‘Õ±•%€ôôôÍ¡•‘Õ±•%¤(€€€€€€€€€€€€€€€€€€¹µ…À ¡¥Ñ•´¤€ôø€ (€€€€€€€€€€€€€€€€€€€€ñÑÈ(€€€€€€€€€€€€€€€€€€€€€­•äõí¥Ñ•´¹­•åô(€€€€€€€€€€€€€€€€€€€€€±…ÍÍ9…µ”õí¥Ñ•´¹¹••‘ÍI•Ù¥•Ü€ü€É½Ü´µ™±…•œ€èÕ¹‘•™¥¹•‘ô(€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õí%Ñ•´¹Õµ‰•È™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹¥Ñ•µ9Õµ‰•Éô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ì¥Ñ•µ9Õµ‰•Èè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑ±…ÍÍ9…µ”õíÝÉ…Á•±±ôø(€€€€€€€€€€€€€€€€€€€€€€€€ñÑ•áÑ…É•„(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õí•ÍÉ¥ÁÑ¥½¸™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹‘•ÍÉ¥ÁÑ¥½¹ô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ì‘•ÍÉ¥ÁÑ¥½¸è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€µ¥¹1•¹Ñ õìÍô(€€€€€€€€€€€€€€€€€€€€€€€€€É½ÝÌõìÉô(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€€í¥Ñ•´¹µ…¹Õ…°€ü€ (€€€€€€€€€€€€€€€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñMÑ…ÑÕÍ¡¥ÀÍÑ…ÑÕÌô‰É•Ù¥•Üˆùµ…¹Õ…°É½Üð½MÑ…ÑÕÍ¡¥Àø‘‘•‰ä(€€€€€€€€€€€€€€€€€€€€€€€€€€€å½ÔƒŠPÑ¡”Á…ÉÍ•±•ÑÑ•È¡…Ì¹¼ÁÉ¥¹Ñ•Í½ÕÉ”É½Ü™½È¥Ð¸(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½Àø(€€€€€€€€€€€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€€€€€€€€€€€ñ‘•Ñ…¥±Ìø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÕµµ…ÉäùAÉ¥¹Ñ•Í½ÕÉ”É½Üð½ÍÕµµ…Éäø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñÁÉ”±…ÍÍ9…µ”ô‰µä´ÄÉ½Õ¹‘•µµ‰½É‘•È‰½É‘•Èµ‰½É‘•È‰œµµÕÑ•Áà´ÌÁä´È™½¹Ðµµ½¹¼Ñ•áÐµáÌÝ¡¥Ñ•ÍÁ…”µÁÉ”µÝÉ…Àm½Ù•É™±½ÜµÝÉ…Àé…¹åÝ¡•É•tˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€í¥Ñ•´¹…¹¡½É1¥¹•ô(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÁÉ”ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½‘•Ñ…¥±Ìø(€€€€€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíU¹¥Ð™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹Õ¹¥Ñ½‘•ô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ìÕ¹¥Ñ½‘”è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€µ…á1•¹Ñ õìÈÁô(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíEÕ…¹Ñ¥Ñä™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹…Ý…É‘•‘EÕ…¹Ñ¥Ñåô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€…Ý…É‘•‘EÕ…¹Ñ¥Ñäè•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”°(€€€€€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰‘•¥µ…°ˆ(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíI…Ñ”™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹•™™•Ñ¥Ù•I…Ñ•ô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ì•™™•Ñ¥Ù•I…Ñ”è•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€É•ÅÕ¥É•(€€€€€€€€€€€€€€€€€€€€€€€€€¥¹ÁÕÑ5½‘”ô‰‘•¥µ…°ˆ(€€€€€€€€€€€€€€€€€€€€€€€€¼ø(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€ì¼¨=ÁÑ¥½¹…°°É•Ù¥•Ý•ÈÌ©Õ‘•µ•¹ÐƒŠPÑ¡”Á…ÉÍ•È(€€€€€€€€€€€€€€€€€€€€€€€€€€€¹•Ù•ÈÁÉ½Á½Í•Ì„…Ñ•½Éä¸A•É•¹Ñ…•Ì…É”(€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹™¥ÕÉ•Á•È…Ñ•½Éä½¸Ñ¡”]½É¬ÌÁ…åµ•¹Ð(€€€€€€€€€€€€€€€€€€€€€€€€€€€µ…ÑÉ¥à°¹•Ù•ÈÁ•È¥Ñ•´€¡HÄÀ¤¸€¨½ô(€€€€€€€€€€€€€€€€€€€€€€€€ñÍ•±•Ð(€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíA…åµ•¹Ð…Ñ•½Éä™½ÈÉ½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€Ù…±Õ”õí¥Ñ•´¹Á…åµ•¹Ñ…Ñ•½Éåô(€€€€€€€€€€€€€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€ÕÁ‘…Ñ•%Ñ•´¡¥Ñ•´¹­•ä°ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Á…åµ•¹Ñ…Ñ•½Éäè•Ù•¹Ð¹Ñ…É•Ð(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€¹Ù…±Õ”…Ì%Ñ•µÉ…™ÑlÁ…åµ•¹Ñ…Ñ•½Éät°(€€€€€€€€€€€€€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ôˆˆùU¹…Ñ•½É¥Í•ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰MUAA1dˆùMÕÁÁ±äð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰MUAA1e}9}%9MQ11Q%=8ˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€MÕÁÁ±ä€¬¥¹ÍÑ…±±…Ñ¥½¸(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰AUI}%9MQ11Q%=8ˆùAÕÉ•±ä¥¹ÍÑ…±±…Ñ¥½¸ð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰MAI}MUAA1dˆùMÁ…É”ÍÕÁÁ±äð½½ÁÑ¥½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€ð½Í•±•Ðø(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€€€ñÑø(€€€€€€€€€€€€€€€€€€€€€€€íÉ•µ½Ù•…¹‘¥‘…Ñ”€ôôô¥Ñ•´¹­•ä€ü€ (€€€€€€€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰µÐ´Ð™±•à™±•àµÝÉ…À¥Ñ•µÌµ•¹Ñ•È…À´ÈÁÉ¥¹Ðé¡¥‘‘•¸ˆø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€É•µ½Ù•I½Ü¡¥Ñ•´¹­•ä¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹™¥É´É•µ½Ù”(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Í•ÑI•µ½Ù•…¹‘¥‘…Ñ”¡¹Õ±°¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€-••À(€€€€€€€€€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø(€€€€€€€€€€€€€€€€€€€€€€€€¤€è€ (€€€€€€€€€€€€€€€€€€€€€€€€€€ñ	ÕÑÑ½¸(€€€€€€€€€€€€€€€€€€€€€€€€€€€Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ(€€€€€€€€€€€€€€€€€€€€€€€€€€€…É¥„µ±…‰•°õíI•µ½Ù”É½Ü€‘í¥Ñ•´¹¥Ñ•µM¹½ô¥¸Í¡•‘Õ±”€‘íÍ¡•‘Õ±•%‘õô(€€€€€€€€€€€€€€€€€€€€€€€€€€€½¹±¥¬õì ¤€ôøì(€€€€€€€€€€€€€€€€€€€€€€€€€€€€€Í•ÑI•µ½Ù•…¹‘¥‘…Ñ”¡¥Ñ•´¹­•ä¤ì(€€€€€€€€€€€€€€€€€€€€€€€€€€€õô(€€€€€€€€€€€€€€€€€€€€€€€€€€ø(€€€€€€€€€€€€€€€€€€€€€€€€€€€I•µ½Ù”(€€€€€€€€€€€€€€€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€€€€€€€€€€€€€€€¥ô(€€€€€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€€€€€¤¥ô(€€€€€€€€€€€€€€ð½Ñ‰½‘äø(€€€€€€€€€€€€€ì¼¨Q¡”ÍÕ‰Ñ½Ñ…°‰•±½¹Ì¥¸Ñ¡”™½½Ð°Ý¡•É”„Ñ…‰±”ÌÍÕµµ…Éä(€€€€€€€€€€€€€€€€€¥Ì…¹¹½Õ¹•¸%Ð¥Ì„É•½¹¥±¥…Ñ¥½¸…¥™½ÈÑ¡”É•Ù¥•Ý•ÈÌ(€€€€€€€€€€€€€€€€€•å”½¹±äƒŠPÑ¡”Í•ÉÙ•ÈÉ•½µÁÕÑ•Ì…¹ÍÑ½É•Ì•Ù•Éä…µ½Õ¹Ð¸€¨½ô(€€€€€€€€€€€€€€ñÑ™½½Ðø(€€€€€€€€€€€€€€€€ñÑÈø(€€€€€€€€€€€€€€€€€€ñÑ Í½Á”ô‰É½Üˆ½±MÁ…¸õìÑôø(€€€€€€€€€€€€€€€€€€€M¡•‘Õ±”íÍ¡•‘Õ±•%‘ôÍÕ‰Ñ½Ñ…°(€€€€€€€€€€€€€€€€€€ð½Ñ ø(€€€€€€€€€€€€€€€€€€ñÑ½±MÁ…¸õìÍô‘…Ñ„µÑ•ÍÑ¥õíÍ¡•‘Õ±”µÍÕ‰Ñ½Ñ…°´‘íÍ¡•‘Õ±•%‘õôø(€€€€€€€€€€€€€€€€€€€€ñÍÑÉ½¹œø(€€€€€€€€€€€€€€€€€€€€€íÍ¡•‘Õ±•MÕ‰Ñ½Ñ…±Ì¹•Ð¡Í¡•‘Õ±•%¤€üü€9½Ðå•Ð…Ù…¥±…‰±”ô(€€€€€€€€€€€€€€€€€€€€ð½ÍÑÉ½¹œø(€€€€€€€€€€€€€€€€€€ð½Ñø(€€€€€€€€€€€€€€€€ð½ÑÈø(€€€€€€€€€€€€€€ð½Ñ™½½Ðø(€€€€€€€€€€€€ð½…Ñ…Q…‰±”ø(€€€€€€€€€€ð½‘¥Øø(€€€€€€€€¤¥ô((€€€€€€€€ñ Èù‘„É½Üð½ Èø(€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€½È±•ÑÑ•ÉÌÑ¡”Á…ÉÍ•È½Õ±¹½Ð™Õ±±äÍ•ÉÙ”è…‘‘•É½ÝÌ…É”™±…•™½È(€€€€€€€€€É•Ù¥•Ü…¹½¹™¥Éµ•Ý¥Ñ „µ…¹Õ…°µ•¹ÑÉäµ…É­•È¥¹ÍÑ•…½˜„ÁÉ¥¹Ñ•Í½ÕÉ”(€€€€€€€€€É½Ü¸I•µ½Ù¥¹œ„Á…ÉÍ•É½Ü¹•Ù•È•‘¥ÑÌÑ¡”ÍÑ½É•±•ÑÑ•ÈƒŠPÑ¡”•áÑÉ…Ñ¥½¸(€€€€€€€€€ÍÑ…åÌ¥¹Ñ…Ð½¸Ñ¡”‘½Õµ•¹Ð¸(€€€€€€€€ð½Àø(€€€€€€€€ñ¥•±‘I½Üø(€€€€€€€€€€ñ¥•±ø(€€€€€€€€€€€€ñ±…‰•°¡Ñµ±½Èô‰…‘µÉ½ÜµÍ¡•‘Õ±”ˆùM¡•‘Õ±”™½ÈÑ¡”¹•ÜÉ½Üð½±…‰•°ø(€€€€€€€€€€€€ñ¥¹ÁÕÐ(€€€€€€€€€€€€€¥ô‰…‘µÉ½ÜµÍ¡•‘Õ±”ˆ(€€€€€€€€€€€€€É•˜õì¡¹½‘”¤€ôøì(€€€€€€€€€€€€€€€É•¥ÍÑ•É¥•± …‘µÉ½ÜµÍ¡•‘Õ±”œ°¹½‘”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€Ù…±Õ”õí…‘‘M¡•‘Õ±•ô(€€€€€€€€€€€€€½¹¡…¹”õì¡•Ù•¹Ð¤€ôøì(€€€€€€€€€€€€€€€Í•Ñ‘‘M¡•‘Õ±”¡•Ù•¹Ð¹Ñ…É•Ð¹Ù…±Õ”¤ì(€€€€€€€€€€€€€õô(€€€€€€€€€€€€€µ…á1•¹Ñ õìÔÁô(€€€€€€€€€€€€¼ø(€€€€€€€€€€ð½¥•±ø(€€€€€€€€€€ñÑ¥½¹Ìø(€€€€€€€€€€€€ñ	ÕÑÑ½¸½¹±¥¬õí…‘‘5…¹Õ…±I½Ýôù‘É½Üð½	ÕÑÑ½¸ø(€€€€€€€€€€ð½Ñ¥½¹Ìø(€€€€€€€€ð½¥•±‘I½Üø((€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆ‘…Ñ„µÑ•ÍÑ¥ô‰É•½¹¥±¥…Ñ¥½¸µÑ½Ñ…±Ìˆø(€€€€€€€€€íÉ½ÝÍQ½Ñ…°€ôôô¹Õ±°(€€€€€€€€€€€€ü€I½ÜÑ½Ñ…±ÌÝ¥±°…ÁÁ•…ÈÝ¡•¸•Ù•ÉäÅÕ…¹Ñ¥Ñä…¹É…Ñ”¥Ì„Á±…¥¸‘•¥µ…°¹Õµ‰•È¸œ(€€€€€€€€€€€€è¹Ñ•É•É½ÝÌÑ½Ñ…°ƒŠ
ä‘íÉ½ÝÍQ½Ñ…±ô…É½ÍÌ€‘íMÑÉ¥¹œ¡¥Ñ•µÌ¹±•¹Ñ ¥ôÉ½Ü‘í¥Ñ•µÌ¹±•¹Ñ €ôôô€Ä€ü€œœ€è€Ìô‘ì(€€€€€€€€€€€€€€€…‘Ù•ÉÑ¥Í•‘¥™™•É•¹”€ôôô¹Õ±°(€€€€€€€€€€€€€€€€€€ü€œœ(€€€€€€€€€€€€€€€€€€è€ƒŠP…‘Ù•ÉÑ¥Í•Ù…±Õ”ƒŠ
ä‘í¡•…‘•È¹…‘Ù•ÉÑ¥Í•‘Y…±Õ•ô€¡‘¥™™•É•¹”€‘í…‘Ù•ÉÑ¥Í•‘¥™™•É•¹•ô¥€(€€€€€€€€€€€€€ô¸‘í½¹ÑÉ…ÑY…±Õ•½¹Ñ•áÑõô(€€€€€€€€ð½Àø((€€€€€€€í½¹™¥ÉµÉÉ½È€„ôô¹Õ±°€˜˜€ñ½ÉµÉÉ½Èùí½¹™¥ÉµÉÉ½Éôð½½ÉµÉÉ½Èùô((€€€€€€€€ñÑ¥½¹	…È±…ÍÍ9…µ”ô‰™±•àµÝÉ…Àˆø(€€€€€€€€€í…¹5½‘¥™ä€˜˜€ (€€€€€€€€€€€€ñ	ÕÑÑ½¸ÑåÁ”ô‰ÍÕ‰µ¥Ðˆ‘¥Í…‰±•õíÁ•¹‘¥¹ôø(€€€€€€€€€€€€€íÁ•¹‘¥¹œ€ü€É•…Ñ¥¹œ]½É¯Š˜œ€è€½¹™¥É´…¹É•…Ñ”]½É¬ô(€€€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€€€¥ô(€€€€€€€€€€ñ	ÕÑÑ½¸Ù…É¥…¹Ðô‰½ÕÑ±¥¹”ˆ½¹±¥¬õí½¹	…­ôø(€€€€€€€€€€€	…¬Ñ¼]½É­Ì(€€€€€€€€€€ð½	ÕÑÑ½¸ø(€€€€€€€€ð½Ñ¥½¹	…Èø(€€€€€€€ì……¹5½‘¥™ä€˜˜€ (€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµµÕÑ•µ™½É•É½Õ¹ˆø(€€€€€€€€€€€e½ÕÈÉ½±”…¸É•Ù¥•Ü‰ÕÐ¹½Ð½¹™¥É´ì…Í¬…¸½Ý¹•È½È½™™¥”µ•µ‰•ÈÑ¼(€€€€€€€€€€€½¹™¥É´Ñ¡¥Ì±•ÑÑ•È¸(€€€€€€€€€€ð½Àø(€€€€€€€€¥ô(€€€€€€ð½™½É´ø(€€€€ð½…Éø(€€¤ì)ô