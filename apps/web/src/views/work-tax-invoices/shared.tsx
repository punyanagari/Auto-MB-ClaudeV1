import type { GstRateMaster } from '@auto-mb/contracts';
import { formatDate } from '../../format.js';

/** One option per master row, so a historic invoice date can still pick a
 * rate that has since been end-dated — the SERVER decides validity
 * against the invoice date; this list is a picker convenience. */
export function GstRateOptions({
  rates,
}: {
  readonly rates: readonly GstRateMaster[];
}) {
  return (
    <>
      {rates.map((row) => (
        <option key={row.id} value={row.rate}>
          {row.rate}% · {row.label}
          {row.effectiveTo === null ? '' : ` (until ${formatDate(row.effectiveTo)})`}
        </option>
      ))}
    </>
  );
}

/** The shared action-runner signature every panel receives from the Work
 * page: run the mutation, report the outcome, refresh what it names. */
export type ActRunner = (run: () => Promise<void>, message: string) => Promise<void>;
