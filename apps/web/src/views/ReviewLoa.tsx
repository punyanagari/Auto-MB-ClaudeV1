import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  ConfirmWorkRequest,
  LoaDocumentDetail,
  WorkDetailResponse,
  WorkItemPaymentCategory,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
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
  // removed rows included): Σ quantity × rate in BigInt minor units,
  // never floats. Null until every row carries plain decimals.
  const rowsTotal = useMemo(
    () => (items === null ? null : exactRowsTotal(items)),
    [items],
  );
  const totalsDifference = useMemo(() => {
    if (rowsTotal === null || header === null) return null;
    // Both sides are read at the row total's own scale — quantity (3 dp) ×
    // rate (6 dp) lands on 9. Parsing narrower silently dropped the whole
    // comparison whenever a rate carried more than a paisa of decimals.
    const totalMinor = parseDecimalMinorUnits(rowsTotal, 9);
    const contractMinor = parseDecimalMinorUnits(header.contractValue, 9);
    if (totalMinor === null || contractMinor === null) return null;
    const diff = totalMinor - contractMinor;
    const negative = diff < 0n;
    const magnitude = negative ? -diff : diff;
    return `${negative ? '-' : ''}₹${formatMinorUnits(magnitude, 9)}`;
  }, [rowsTotal, header]);

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
          ? cause.message
          : 'The Work could not be created. Nothing was saved.',
      );
      setPending(false);
    }
  }

  if (loadError !== null) {
    return (
      <section className="card" aria-labelledby="review-title">
        <h1 id="review-title" tabIndex={-1}>
          Review LOA
        </h1>
        <p className="form-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (document === null) {
    return (
      <section className="card" aria-labelledby="review-title">
        <h1 id="review-title" tabIndex={-1}>
          Review LOA
        </h1>
        <p className="muted" role="status">
          Loading document…
        </p>
      </section>
    );
  }

  if (payload === null || header === null || items === null || pbg === null) {
    return (
      <section className="card" aria-labelledby="review-title">
        <h1 id="review-title" tabIndex={-1}>
          Review LOA
        </h1>
        <p className="form-error" role="alert">
          Extraction did not produce reviewable content for {document.originalFilename}.
          Upload a clearer copy or contact support.
        </p>
        <div className="actions">
          <button type="button" className="button--ghost" onClick={onBack}>
            Back to Works
          </button>
        </div>
      </section>
    );
  }

  const flagged = payload.review.needsReview.total;

  return (
    <section className="card card--wide" aria-labelledby="review-title">
      <h1 id="review-title" tabIndex={-1}>
        Review {document.originalFilename}
      </h1>
      <p className="muted">
        Values below are prefilled from the letter's own text; every parsed field keeps
        its printed source. Correct anything that reads wrong — nothing becomes a Work
        until you confirm.
      </p>

      {flagged > 0 && (
        <div className="flag-panel" role="note" aria-labelledby="flags-title">
          <h2 id="flags-title">
            {flagged} item{flagged === 1 ? '' : 's'} need attention
          </h2>
          <ul className="flag-list">
            {payload.review.flags.map((flag, index) => (
              <li key={`${flag.code}-${String(index)}`}>
                <span className="chip chip--review">{flag.code}</span> {flag.message}
                <details>
                  <summary>Printed source</summary>
                  <pre className="raw-block">{flag.rawBlock}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* noValidate: the checks in confirm() replace the native ones so that
          every failure names its field, binds a message, and moves focus. */}
      <form noValidate onSubmit={(event) => void confirm(event)}>
        <h2>Letter details</h2>
        <div className="field-row">
          <div className="field">
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
              autoComplete="off"
              aria-invalid={fieldErrors['work-code'] !== undefined}
              aria-describedby={
                fieldErrors['work-code'] !== undefined ? 'work-code-error' : undefined
              }
            />
            {fieldErrors['work-code'] !== undefined && (
              <p className="form-error" id="work-code-error">
                {fieldErrors['work-code']}
              </p>
            )}
          </div>
          <div className="field">
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
            {fieldErrors['letter-number'] !== undefined && (
              <p className="form-error" id="letter-number-error">
                {fieldErrors['letter-number']}
              </p>
            )}
          </div>
          <div className="field">
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
            {fieldErrors['letter-date'] !== undefined && (
              <p className="form-error" id="letter-date-error">
                {fieldErrors['letter-date']}
              </p>
            )}
          </div>
        </div>
        <div className="field">
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
          {fieldErrors['work-title'] !== undefined && (
            <p className="form-error" id="work-title-error">
              {fieldErrors['work-title']}
            </p>
          )}
        </div>
        <div className="field-row">
          <div className="field">
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
              <p className="form-error" id="advertised-value-error">
                {fieldErrors['advertised-value']}
              </p>
            )}
          </div>
          <div className="field">
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
              <p className="form-error" id="contract-value-error">
                {fieldErrors['contract-value']}
              </p>
            )}
          </div>
          <div className="field">
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
          </div>
        </div>
        {header.pricingShape === 'letter_percentage' && (
          <div className="field-row">
            <div className="field">
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
              {fieldErrors['letter-percentage'] !== undefined && (
                <p className="form-error" id="letter-percentage-error">
                  {fieldErrors['letter-percentage']}
                </p>
              )}
            </div>
            <div className="field">
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
                <p className="form-error" id="percentage-direction-error">
                  {fieldErrors['percentage-direction']}
                </p>
              )}
            </div>
          </div>
        )}

        <h2>Performance guarantee requirement</h2>
        <p className="muted">
          What the letter demands, not what has been submitted — record the submitted
          bank guarantee later as a PBG instrument on the Work.
        </p>
        {payload.review.header.performanceGuarantee?.needsReview === true && (
          <p className="muted">
            <span className="chip chip--review">needs review</span> The parser could not
            fully read the performance-guarantee clause; check the printed source below
            and correct the values.
          </p>
        )}
        <div className="field">
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
        </div>
        {pbg.required && (
          <div className="field-row">
            <div className="field">
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
            </div>
            <div className="field">
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
                <p className="form-error" id="pbg-submission-days-error">
                  {fieldErrors['pbg-submission-days']}
                </p>
              )}
            </div>
            <div className="field">
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
            </div>
            <div className="field">
              <label htmlFor="pbg-penal-interest">Penal interest (% p.a.)</label>
              <input
                id="pbg-penal-interest"
                value={pbg.penalInterestPercent}
                onChange={(event) => {
                  updatePbg('penalInterestPercent', event.target.value);
                }}
                inputMode="decimal"
              />
            </div>
          </div>
        )}
        {typeof payload.review.header.performanceGuarantee?.raw === 'string' && (
          <details>
            <summary>Printed source (performance guarantee)</summary>
            <pre className="raw-block">
              {payload.review.header.performanceGuarantee.raw}
            </pre>
          </details>
        )}

        {scheduleIds.map((scheduleId) => (
          <div key={scheduleId}>
            <h2>Schedule {scheduleId}</h2>
            <table className="data-table data-table--editable">
              <caption className="visually-hidden">
                Awarded items in schedule {scheduleId}; every field is editable
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
                        <input
                          aria-label={`Item number for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.itemNumber}
                          onChange={(event) => {
                            updateItem(item.key, { itemNumber: event.target.value });
                          }}
                          required
                        />
                      </td>
                      <td className="cell--wrap">
                        <textarea
                          aria-label={`Description for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.description}
                          onChange={(event) => {
                            updateItem(item.key, { description: event.target.value });
                          }}
                          required
                          minLength={3}
                          rows={2}
                        />
                        {item.manual ? (
                          <p className="muted">
                            <span className="chip chip--review">manual row</span> Added
                            by you — the parsed letter has no printed source row for it.
                          </p>
                        ) : (
                          <details>
                            <summary>Printed source row</summary>
                            <pre className="raw-block">{item.anchorLine}</pre>
                          </details>
                        )}
                      </td>
                      <td>
                        <input
                          aria-label={`Unit for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.unitCode}
                          onChange={(event) => {
                            updateItem(item.key, { unitCode: event.target.value });
                          }}
                          required
                          maxLength={20}
                        />
                      </td>
                      <td>
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
                      </td>
                      <td>
                        <input
                          aria-label={`Rate for row ${item.itemSno} in schedule ${scheduleId}`}
                          value={item.effectiveRate}
                          onChange={(event) => {
                            updateItem(item.key, { effectiveRate: event.target.value });
                          }}
                          required
                          inputMode="decimal"
                        />
                      </td>
                      <td>
                        {/* Optional, reviewer's judgement — the parser
                            never proposes a category. Percentages are
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
                        </select>
                      </td>
                      <td>
                        {removeCandidate === item.key ? (
                          <span className="actions">
                            <button
                              type="button"
                              onClick={() => {
                                removeRow(item.key);
                              }}
                            >
                              Confirm remove
                            </button>
                            <button
                              type="button"
                              className="button--ghost"
                              onClick={() => {
                                setRemoveCandidate(null);
                              }}
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="button--ghost"
                            aria-label={`Remove row ${item.itemSno} in schedule ${scheduleId}`}
                            onClick={() => {
                              setRemoveCandidate(item.key);
                            }}
                          >
                            Remove
                          </button>
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
            </table>
          </div>
        ))}

        <h2>Add a row</h2>
        <p className="muted">
          For letters the parser could not fully serve: added rows are flagged for
          review and confirmed with a manual-entry marker instead of a printed source
          row. Removing a parsed row never edits the stored letter — the extraction
          stays intact on the document.
        </p>
        <div className="field-row">
          <div className="field">
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
          </div>
          <div className="actions">
            <button type="button" onClick={addManualRow}>
              Add row
            </button>
          </div>
        </div>

        <p className="muted" data-testid="reconciliation-totals">
          {rowsTotal === null
            ? 'Row totals will appear when every quantity and rate is a plain decimal number.'
            : `Entered rows total ₹${rowsTotal} across ${String(items.length)} row${items.length === 1 ? '' : 's'}${
                totalsDifference === null
                  ? ''
                  : ` — contract value ₹${header.contractValue} (difference ${totalsDifference})`
              }.`}
        </p>

        {confirmError !== null && (
          <p className="form-error" role="alert">
            {confirmError}
          </p>
        )}

        <div className="actions action-bar">
          {canModify && (
            <button type="submit" disabled={pending}>
              {pending ? 'Creating Work…' : 'Confirm and create Work'}
            </button>
          )}
          <button type="button" className="button--ghost" onClick={onBack}>
            Back to Works
          </button>
        </div>
        {!canModify && (
          <p className="muted">
            Your role can review but not confirm; ask an owner or office member to
            confirm this letter.
          </p>
        )}
      </form>
    </section>
  );
}
