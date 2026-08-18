import { useEffect, useState } from 'react';
import { ArrowLeft, Plus, Send, Trash2 } from 'lucide-react';
import type { CreateMaintenanceLine, MaintenancePriority } from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { todayIso } from '../format.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Actions, Field, FieldRow, FormError, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { ErrorState, LoadingState } from '../ui/state.js';

/**
 * Raising a site material request.
 *
 * Replicates `app/maintenance/new/page.tsx` and
 * `components/maintenance-request-form.tsx` of the frozen mock at
 * `fdfd610`: the back button, the eyebrowed header, a "Site and fault
 * details" card over a "Requested materials" card whose rows are added
 * and removed one at a time, and a single submit at the foot.
 *
 * Two divergences, both in `docs/UX.md` § 14:
 *
 *   * **The Work picker is the real one.** The mock hard-codes two
 *     options; this reads the Works the caller may see, and a user
 *     without `all_works_access` gets only the ones assigned to them.
 *   * **A material line may name a catalogue part.** The mock's line is
 *     free text with an optional code that resolves to nothing. Picking a
 *     part is what lets the dispatch move real stock and the screen show
 *     what is actually on the shelf; a line with no part is still
 *     allowed, and is the mock's custom item.
 */

interface FormLine {
  readonly key: number;
  itemId: string;
  description: string;
  unit: string;
  quantity: string;
  purpose: string;
  expectedReturnQuantity: string;
  assetSerials: string;
}

let nextKey = 0;
function blankLine(): FormLine {
  nextKey += 1;
  return {
    key: nextKey,
    itemId: '',
    description: '',
    unit: 'Nos',
    quantity: '1',
    purpose: '',
    expectedReturnQuantity: '0',
    assetSerials: '',
  };
}

const PRIORITIES: readonly {
  readonly value: MaintenancePriority;
  readonly label: string;
}[] = [
  { value: 'routine', label: 'Routine' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'critical', label: 'Critical outage' },
];

interface Pickers {
  readonly works: readonly {
    readonly id: string;
    readonly code: string;
    readonly title: string;
  }[];
  readonly parts: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly unit: string;
  }[];
}

interface MaintenanceRequestFormProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onDone: (requestId: string) => void;
  readonly onCancel: () => void;
}

export function MaintenanceRequestForm({
  api,
  organisationId,
  onDone,
  onCancel,
}: MaintenanceRequestFormProps) {
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, retry] = useReload();

  const [workId, setWorkId] = useState('');
  const [station, setStation] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterPhone, setRequesterPhone] = useState('');
  const [priority, setPriority] = useState<MaintenancePriority>('routine');
  const [requiredBy, setRequiredBy] = useState('');
  const [faultSummary, setFaultSummary] = useState('');
  const [operationalImpact, setOperationalImpact] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [lines, setLines] = useState<readonly FormLine[]>([blankLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPickers(null);
    setLoadError(null);
    // `listProductionItems`, not `listStockItems`. The picker needs a
    // code, a name and a unit; the stock register answers those AND
    // explodes every open job card's bill of material through
    // `stock_outstanding_requirement`, then computes window counts over
    // the whole catalogue — all of it discarded here. The Production
    // select next door already reads the master for the same three
    // fields.
    Promise.all([
      api.listWorks(organisationId),
      api.listProductionItems(organisationId),
    ])
      .then(([works, catalogue]) => {
        if (cancelled) return;
        setPickers({
          works: works.map((work) => ({
            id: work.id,
            code: work.workCode,
            title: work.title,
          })),
          parts: catalogue.items.map((item) => ({
            id: item.id,
            code: item.itemCode,
            name: item.name,
            unit: item.unit,
          })),
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The Works and parts could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  // Built once. Rendered inside the line loop, a catalogue of several
  // hundred parts becomes that many option nodes PER LINE, and adding a
  // tenth line re-creates all of them.
  const partOptions =
    pickers === null
      ? null
      : pickers.parts.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.code} · {candidate.name}
          </option>
        ));

  const update = (key: number, patch: Partial<FormLine>): void => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="mb-4 -ml-2 text-muted-foreground"
      onClick={onCancel}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      Maintenance
    </Button>
  );

  const header = (
    <PageHeader
      eyebrow="Operations control"
      title="Site material request"
      titleId="maintenance-new-title"
      description="Submit replacement or repair material against a Work and station for whole-request admin approval."
    />
  );

  if (loadError !== null) {
    return (
      <>
        {back}
        {header}
        <ErrorState onRetry={retry} retryLabel="Retry">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (pickers === null) {
    return (
      <>
        {back}
        {header}
        <LoadingState label="the Works and parts" rows={4} columns={2} />
      </>
    );
  }

  const complete =
    workId !== '' &&
    station.trim().length >= 2 &&
    requesterName.trim().length >= 2 &&
    faultSummary.trim().length >= 3 &&
    lines.length > 0 &&
    lines.every(
      (line) =>
        Number(line.quantity) > 0 &&
        (line.itemId !== '' || line.description.trim().length >= 3) &&
        line.unit.trim().length >= 1 &&
        Number(line.expectedReturnQuantity) >= 0 &&
        Number(line.expectedReturnQuantity) <= Number(line.quantity),
    );

  const submit = (): void => {
    setFailure(null);
    setSubmitting(true);
    const payloadLines: CreateMaintenanceLine[] = lines.map((line) => {
      const part = pickers.parts.find((candidate) => candidate.id === line.itemId);
      const serials = line.assetSerials
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
      return {
        ...(line.itemId === '' ? {} : { itemId: line.itemId }),
        description: part?.name ?? line.description.trim(),
        unit: part?.unit ?? line.unit.trim(),
        quantity: line.quantity,
        ...(line.purpose.trim() === '' ? {} : { purpose: line.purpose.trim() }),
        expectedReturnQuantity: line.expectedReturnQuantity,
        ...(serials.length === 0 ? {} : { assetSerials: serials }),
      };
    });
    api
      .createMaintenanceRequest(organisationId, {
        workId,
        station: station.trim(),
        requesterName: requesterName.trim(),
        ...(requesterPhone.trim() === ''
          ? {}
          : { requesterPhone: requesterPhone.trim() }),
        priority,
        ...(requiredBy === '' ? {} : { requiredBy }),
        faultSummary: faultSummary.trim(),
        ...(operationalImpact.trim() === ''
          ? {}
          : { operationalImpact: operationalImpact.trim() }),
        ...(deliveryInstructions.trim() === ''
          ? {}
          : { deliveryInstructions: deliveryInstructions.trim() }),
        lines: payloadLines,
      })
      .then((created) => {
        onDone(created.id);
      })
      .catch((cause: unknown) => {
        setSubmitting(false);
        setFailure(errorMessage(cause, 'The request could not be created.'));
      });
  };

  return (
    <>
      {back}
      {header}

      <Card className="mb-5">
        <CardHeader>
          <h2 className="text-base font-semibold">Site and fault details</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Identify the Work, location, requester, operational impact, and delivery
            need.
          </p>
        </CardHeader>
        <FieldRow>
          <Field>
            <label htmlFor="maintenance-work">Work</label>
            <select
              id="maintenance-work"
              value={workId}
              onChange={(event) => {
                setWorkId(event.currentTarget.value);
              }}
            >
              <option value="">Select a Work</option>
              {pickers.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.code} · {work.title}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <label htmlFor="maintenance-station">Station / site</label>
            <input
              id="maintenance-station"
              maxLength={200}
              placeholder="e.g. Mumbai Central"
              value={station}
              onChange={(event) => {
                setStation(event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor="maintenance-requester">Site engineer</label>
            <input
              id="maintenance-requester"
              maxLength={200}
              value={requesterName}
              onChange={(event) => {
                setRequesterName(event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor="maintenance-phone">Contact number</label>
            <input
              id="maintenance-phone"
              inputMode="tel"
              maxLength={30}
              value={requesterPhone}
              onChange={(event) => {
                setRequesterPhone(event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor="maintenance-priority">Priority</label>
            <select
              id="maintenance-priority"
              value={priority}
              onChange={(event) => {
                setPriority(event.currentTarget.value as MaintenancePriority);
              }}
            >
              {PRIORITIES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <label htmlFor="maintenance-required-by">Required by</label>
            <input
              id="maintenance-required-by"
              type="date"
              min={todayIso()}
              value={requiredBy}
              onChange={(event) => {
                setRequiredBy(event.currentTarget.value);
              }}
            />
          </Field>
        </FieldRow>
        <Field>
          <label htmlFor="maintenance-fault">Fault summary</label>
          <textarea
            id="maintenance-fault"
            rows={2}
            maxLength={1000}
            placeholder="Describe the observed fault and diagnosis"
            value={faultSummary}
            onChange={(event) => {
              setFaultSummary(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="maintenance-impact">Operational impact</label>
          <textarea
            id="maintenance-impact"
            rows={2}
            maxLength={2000}
            placeholder="Services affected, fallback arrangements, passenger impact"
            value={operationalImpact}
            onChange={(event) => {
              setOperationalImpact(event.currentTarget.value);
            }}
          />
        </Field>
        <Field>
          <label htmlFor="maintenance-delivery">Delivery instructions</label>
          <textarea
            id="maintenance-delivery"
            rows={2}
            maxLength={2000}
            placeholder="Contact, access window, handover point"
            value={deliveryInstructions}
            onChange={(event) => {
              setDeliveryInstructions(event.currentTarget.value);
            }}
          />
        </Field>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Requested materials</h2>
            <p className="m-0 text-sm text-muted-foreground">
              Add catalogue parts or custom materials, and say how many failed units the
              site owes back on each line.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLines((current) => [...current, blankLine()]);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add line
          </Button>
        </CardHeader>

        <div className="flex flex-col gap-4">
          {lines.map((line, index) => {
            const part = pickers.parts.find(
              (candidate) => candidate.id === line.itemId,
            );
            return (
              <div key={line.key} className="rounded-xl p-3 ring-1 ring-foreground/10">
                <FieldRow>
                  <Field>
                    <label htmlFor={`line-part-${String(line.key)}`}>
                      Catalogue part
                    </label>
                    <select
                      id={`line-part-${String(line.key)}`}
                      value={line.itemId}
                      onChange={(event) => {
                        const chosen = pickers.parts.find(
                          (candidate) => candidate.id === event.currentTarget.value,
                        );
                        update(line.key, {
                          itemId: event.currentTarget.value,
                          ...(chosen === undefined ? {} : { unit: chosen.unit }),
                        });
                      }}
                    >
                      <option value="">Custom material (no part)</option>
                      {partOptions}
                    </select>
                    <Hint>
                      A catalogue part moves stock when it is dispatched; a custom
                      material does not.
                    </Hint>
                  </Field>
                  <Field>
                    <label htmlFor={`line-description-${String(line.key)}`}>
                      Material description
                    </label>
                    <input
                      id={`line-description-${String(line.key)}`}
                      maxLength={300}
                      value={part?.name ?? line.description}
                      disabled={part !== undefined}
                      onChange={(event) => {
                        update(line.key, { description: event.currentTarget.value });
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`line-quantity-${String(line.key)}`}>
                      Quantity
                    </label>
                    <input
                      id={`line-quantity-${String(line.key)}`}
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={line.quantity}
                      onChange={(event) => {
                        update(line.key, { quantity: event.currentTarget.value });
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`line-unit-${String(line.key)}`}>Unit</label>
                    <input
                      id={`line-unit-${String(line.key)}`}
                      maxLength={20}
                      value={part?.unit ?? line.unit}
                      disabled={part !== undefined}
                      onChange={(event) => {
                        update(line.key, { unit: event.currentTarget.value });
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`line-purpose-${String(line.key)}`}>Purpose</label>
                    <input
                      id={`line-purpose-${String(line.key)}`}
                      maxLength={300}
                      value={line.purpose}
                      onChange={(event) => {
                        update(line.key, { purpose: event.currentTarget.value });
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`line-return-${String(line.key)}`}>
                      Defective qty expected back
                    </label>
                    <input
                      id={`line-return-${String(line.key)}`}
                      type="number"
                      min="0"
                      step="0.001"
                      max={line.quantity}
                      value={line.expectedReturnQuantity}
                      onChange={(event) => {
                        update(line.key, {
                          expectedReturnQuantity: event.currentTarget.value,
                        });
                      }}
                    />
                  </Field>
                  <Field>
                    <label htmlFor={`line-serials-${String(line.key)}`}>
                      Defective asset / serial numbers
                    </label>
                    <input
                      id={`line-serials-${String(line.key)}`}
                      placeholder="Comma separated"
                      value={line.assetSerials}
                      onChange={(event) => {
                        update(line.key, { assetSerials: event.currentTarget.value });
                      }}
                    />
                    <Hint>Office receipt is tracked against these assets.</Hint>
                  </Field>
                </FieldRow>
                <Actions>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove material line ${String(index + 1)}`}
                    disabled={lines.length === 1}
                    onClick={() => {
                      setLines((current) =>
                        current.filter((candidate) => candidate.key !== line.key),
                      );
                    }}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />
                    Remove line
                  </Button>
                </Actions>
              </div>
            );
          })}
        </div>
      </Card>

      {failure !== null && <FormError>{failure}</FormError>}

      <Actions>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!complete || submitting} onClick={submit}>
          <Send data-icon="inline-start" aria-hidden="true" />
          {submitting ? 'Submitting…' : 'Send for admin approval'}
        </Button>
      </Actions>
    </>
  );
}
