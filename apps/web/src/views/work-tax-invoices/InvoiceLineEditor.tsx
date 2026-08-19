import type {
  GstRateMaster,
  TaxInvoiceLine,
  TaxInvoiceLineInput,
} from '@auto-mb/contracts';
import { Button } from '../../ui/button.js';
import { Field, FieldRow, Actions, Hint } from '../../ui/form.js';
import { GstRateOptions } from './shared.js';
import { NumericInput } from '../../ui/numeric-input.js';

/**
 * The line editor for an ITEMISED tax invoice (migration 0057).
 *
 * The rest of these forms are uncontrolled and read through FormData,
 * which works because their fields are fixed. Lines are not: they are
 * added and removed while the operator types, so they are React state and
 * are submitted from that state directly. Everything else on the form
 * still comes from FormData, unchanged.
 *
 * No money is asked for. A line's taxable value is quantity x rate and its
 * tax is that at its own GST rate, computed in SQL numeric at submit —
 * asking the operator for a figure the server is going to recompute would
 * only create something for the two to disagree about.
 */

export interface DraftLine {
  /** Stable across re-orders and removals, so React keeps input focus
   * where the operator left it. Never sent. */
  readonly key: string;
  readonly isService: boolean;
  readonly hsnSacCode: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitLabel: string;
  readonly unitRate: string;
  readonly gstRate: string;
}

let lineKeySequence = 0;

export function emptyDraftLine(gstRate = ''): DraftLine {
  lineKeySequence += 1;
  return {
    key: `line-${String(lineKeySequence)}`,
    isService: false,
    hsnSacCode: '',
    description: '',
    quantity: '1',
    unitLabel: '',
    unitRate: '',
    gstRate,
  };
}

/** The stored lines of an invoice, as the editor holds them. */
export function draftLinesOf(lines: readonly TaxInvoiceLine[]): DraftLine[] {
  return lines.map((line) => {
    lineKeySequence += 1;
    return {
      key: `line-${String(lineKeySequence)}`,
      isService: line.isService,
      hsnSacCode: line.hsnSacCode,
      description: line.description,
      quantity: line.quantity,
      unitLabel: line.unitLabel ?? '',
      unitRate: line.unitRate,
      gstRate: line.gstRate,
    };
  });
}

/** What goes on the wire: the editor's own key is dropped and an empty
 * unit label is omitted rather than sent as an empty string. */
export function toLineInputs(lines: readonly DraftLine[]): TaxInvoiceLineInput[] {
  return lines.map((line) => ({
    isService: line.isService,
    hsnSacCode: line.hsnSacCode,
    description: line.description,
    quantity: line.quantity,
    unitRate: line.unitRate,
    gstRate: line.gstRate,
    ...(line.unitLabel.trim() === '' ? {} : { unitLabel: line.unitLabel }),
  }));
}

interface InvoiceLineEditorProps {
  /** Prefixes every field id, so the create and edit forms can both be
   * mounted without colliding labels. */
  readonly idPrefix: string;
  readonly lines: readonly DraftLine[];
  readonly gstRates: readonly GstRateMaster[];
  readonly onChange: (lines: readonly DraftLine[]) => void;
}

export function InvoiceLineEditor({
  idPrefix,
  lines,
  gstRates,
  onChange,
}: InvoiceLineEditorProps) {
  function update(key: string, patch: Partial<DraftLine>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  return (
    <>
      {lines.map((line, index) => {
        const id = `${idPrefix}-${line.key}`;
        return (
          <fieldset key={line.key}>
            <legend>Line {index + 1}</legend>
            <FieldRow>
              <Field>
                <label htmlFor={`${id}-kind`}>Supply</label>
                <select
                  id={`${id}-kind`}
                  value={line.isService ? 'service' : 'goods'}
                  onChange={(event) => {
                    update(line.key, {
                      isService: event.currentTarget.value === 'service',
                    });
                  }}
                >
                  <option value="goods">Goods (HSN)</option>
                  <option value="service">Service (SAC)</option>
                </select>
              </Field>
              <Field>
                <label htmlFor={`${id}-code`}>
                  {line.isService ? 'SAC code' : 'HSN code'}
                </label>
                <input
                  id={`${id}-code`}
                  inputMode="numeric"
                  pattern={line.isService ? '[0-9]{6}' : '[0-9]{6,8}'}
                  maxLength={8}
                  required
                  value={line.hsnSacCode}
                  onChange={(event) => {
                    update(line.key, { hsnSacCode: event.currentTarget.value });
                  }}
                />
                <Hint>
                  {line.isService
                    ? 'Six digits — a SAC takes no eight-digit deepening.'
                    : 'Six to eight digits.'}
                </Hint>
              </Field>
            </FieldRow>
            <Field>
              <label htmlFor={`${id}-description`}>Description</label>
              <input
                id={`${id}-description`}
                required
                minLength={3}
                maxLength={1000}
                value={line.description}
                onChange={(event) => {
                  update(line.key, { description: event.currentTarget.value });
                }}
              />
            </Field>
            <FieldRow>
              <Field>
                <label htmlFor={`${id}-quantity`}>Quantity</label>
                <NumericInput
                  id={`${id}-quantity`}
                  required
                  value={line.quantity}
                  onChange={(event) => {
                    update(line.key, { quantity: event.currentTarget.value });
                  }}
                />
              </Field>
              <Field>
                <label htmlFor={`${id}-unit`}>Unit</label>
                <input
                  id={`${id}-unit`}
                  maxLength={20}
                  placeholder="no"
                  value={line.unitLabel}
                  onChange={(event) => {
                    update(line.key, { unitLabel: event.currentTarget.value });
                  }}
                />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field>
                <label htmlFor={`${id}-rate`}>Unit rate</label>
                <NumericInput
                  id={`${id}-rate`}
                  required
                  value={line.unitRate}
                  onChange={(event) => {
                    update(line.key, { unitRate: event.currentTarget.value });
                  }}
                />
                <Hint>
                  Up to two decimal places. The line total is quantity x rate.
                </Hint>
              </Field>
              <Field>
                <label htmlFor={`${id}-gst-rate`}>GST rate (%)</label>
                {gstRates.length > 0 ? (
                  <select
                    id={`${id}-gst-rate`}
                    required
                    value={line.gstRate}
                    onChange={(event) => {
                      update(line.key, { gstRate: event.currentTarget.value });
                    }}
                  >
                    <option value="" disabled>
                      Pick a notified rate
                    </option>
                    <GstRateOptions rates={gstRates} />
                  </select>
                ) : (
                  <NumericInput
                    id={`${id}-gst-rate`}
                    required
                    value={line.gstRate}
                    onChange={(event) => {
                      update(line.key, { gstRate: event.currentTarget.value });
                    }}
                  />
                )}
                <Hint>Each line carries its own rate; the master still decides.</Hint>
              </Field>
            </FieldRow>
            {lines.length > 1 && (
              <Actions>
                <Button
                  variant="ghost"
                  onClick={() => {
                    onChange(lines.filter((row) => row.key !== line.key));
                  }}
                >
                  Remove line {index + 1}
                </Button>
              </Actions>
            )}
          </fieldset>
        );
      })}
      <Actions>
        <Button
          variant="secondary"
          onClick={() => {
            onChange([...lines, emptyDraftLine(lines.at(-1)?.gstRate ?? '')]);
          }}
        >
          Add line
        </Button>
      </Actions>
    </>
  );
}
