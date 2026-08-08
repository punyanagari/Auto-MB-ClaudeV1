import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ConfirmWorkRequest,
  LoaDocumentDetail,
  WorkDetailResponse,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import {
  asExtractionPayload,
  normaliseDecimal,
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
  readonly anchorLine: string;
  itemNumber: string;
  description: string;
  unitCode: string;
  awardedQuantity: string;
  effectiveRate: string;
}

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
      anchorLine: item.raw.anchorLine,
      itemNumber: `${scheduleId}/${item.itemSno}`,
      description: item.description,
      unitCode: (item.qtyUnit ?? '').slice(0, 20),
      awardedQuantity: normaliseDecimal(item.qty, 3),
      effectiveRate: normaliseDecimal(item.unitRate, 2),
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
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setHeader(null);
    setItems(null);
    setLoadError(null);
    api
      .getLoaDocument(organisationId, documentId)
      .then((loaded) => {
        if (cancelled) return;
        setDocument(loaded);
        const payload = asExtractionPayload(loaded.extractionPayload);
        if (payload !== null) {
          setHeader(buildHeaderDraft(payload));
          setItems(buildItemDrafts(payload));
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

  function updateHeader<K extends keyof HeaderDraft>(key: K, value: HeaderDraft[K]) {
    setHeader((current) => (current === null ? null : { ...current, [key]: value }));
  }

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current === null
        ? null
        : current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (header === null || items === null) return;
    const withPercentage = header.pricingShape === 'letter_percentage';
    if (withPercentage && header.letterPercentageDirection === '') {
      setConfirmError('Select the percentage direction printed on the letter.');
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
            sourceRef: { scheduleId: item.scheduleId, itemSno: item.itemSno },
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

  if (payload === null || header === null || items === null) {
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

      <form onSubmit={(event) => void confirm(event)}>
        <h2>Letter details</h2>
        <div className="field-row">
          <div className="field">
            <label htmlFor="work-code">Work code (your reference)</label>
            <input
              id="work-code"
              value={header.workCode}
              onChange={(event) => {
                updateHeader('workCode', event.target.value.toUpperCase());
              }}
              required
              pattern="[A-Z0-9][A-Z0-9_/-]{0,19}"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="letter-number">Letter number</label>
            <input
              id="letter-number"
              value={header.letterNumber}
              onChange={(event) => {
                updateHeader('letterNumber', event.target.value);
              }}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="letter-date">Letter date</label>
            <input
              id="letter-date"
              type="date"
              value={header.letterDate}
              onChange={(event) => {
                updateHeader('letterDate', event.target.value);
              }}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="work-title">Work description</label>
          <textarea
            id="work-title"
            value={header.title}
            onChange={(event) => {
              updateHeader('title', event.target.value);
            }}
            required
            minLength={3}
            rows={2}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="advertised-value">Advertised value (₹)</label>
            <input
              id="advertised-value"
              value={header.advertisedValue}
              onChange={(event) => {
                updateHeader('advertisedValue', event.target.value);
              }}
              required
              inputMode="decimal"
            />
          </div>
          <div className="field">
            <label htmlFor="contract-value">Contract value (₹)</label>
            <input
              id="contract-value"
              value={header.contractValue}
              onChange={(event) => {
                updateHeader('contractValue', event.target.value);
              }}
              required
              inputMode="decimal"
            />
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
                value={header.letterPercentage}
                onChange={(event) => {
                  updateHeader('letterPercentage', event.target.value);
                }}
                required
                inputMode="decimal"
              />
            </div>
            <div className="field">
              <label htmlFor="percentage-direction">Direction</label>
              <select
                id="percentage-direction"
                value={header.letterPercentageDirection}
                onChange={(event) => {
                  updateHeader(
                    'letterPercentageDirection',
                    event.target.value as HeaderDraft['letterPercentageDirection'],
                  );
                }}
                required
              >
                <option value="">Choose…</option>
                <option value="below">Below</option>
                <option value="at_par">At par</option>
                <option value="above">Above</option>
              </select>
            </div>
          </div>
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
                        <details>
                          <summary>Printed source row</summary>
                          <pre className="raw-block">{item.anchorLine}</pre>
                        </details>
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
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}

        {confirmError !== null && (
          <p className="form-error" role="alert">
            {confirmError}
          </p>
        )}

        <div className="actions">
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
