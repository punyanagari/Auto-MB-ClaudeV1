import type { InstallationCounts, Serial, WorkItem } from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { formatDate } from '../format.js';
import { installationsHash } from '../lib/workspace-routes.js';
import { StatusChip } from '../ui/chip.js';
import { FormError } from '../ui/form.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Installations } from './Installations.js';

interface WorkInstallationsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly workItems: readonly WorkItem[];
  readonly serials: readonly Serial[];
  readonly serialsState: 'loading' | 'unavailable' | 'ready';
  readonly setSerials: Dispatch<SetStateAction<readonly Serial[]>>;
  readonly canRecordSiteEvidence: boolean;
  /** Hands the Work page the tally behind its tab badge, on load and
   * after every record or cancel. */
  readonly onCountsChanged?: (counts: InstallationCounts) => void;
}

/** What has physically gone in at site under this Work: the quantity
 * installation records, and the per-serial trace that answers for the
 * individual units behind them.
 *
 * The two were the tail of the Deliveries tab, below the Delivery Challans
 * and the correction notices those challans carry. They read as an
 * afterthought there, and the serial pool a recording draws from is the
 * same list the trace prints — so recording an installation and checking
 * where a unit went were two ends of one screen the operator had to scroll
 * between. They are their own area now, and Deliveries keeps the movement
 * documents alone. */
export function WorkInstallations({
  api,
  organisationId,
  workId,
  workItems,
  serials,
  serialsState,
  setSerials,
  canRecordSiteEvidence,
  onCountsChanged,
}: WorkInstallationsProps) {
  return (
    <>
      <Installations
        api={api}
        organisationId={organisationId}
        workId={workId}
        canRecordEvidence={canRecordSiteEvidence && serialsState === 'ready'}
        workItems={workItems}
        serials={serials}
        onSerialsChanged={setSerials}
        {...(onCountsChanged === undefined ? {} : { onCountsChanged })}
      />

      {/* The other end of the register's `?work=` deep link. The register
          reads across Works and is where a date window lives, so a
          supervisor who has just recorded here and wants the same records
          beside another Work's has one link rather than a module hop and
          a re-filter. A plain anchor: the register is a destination, and
          a middle click should open it in its own tab. */}
      <p className="text-sm">
        <a href={installationsHash(workId)} className="inline-flex items-center gap-1">
          Open these records in the installation register
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
      </p>

      <h2>Serial trace</h2>
      {serialsState === 'loading' ? (
        <p className="text-muted-foreground" role="status">
          Loading serial trace…
        </p>
      ) : serialsState === 'unavailable' ? (
        <FormError>
          The serial trace could not be loaded. Installation recording remains read-only
          until it is available.
        </FormError>
      ) : serials.length > 0 ? (
        <DataTable>
          <caption className="sr-only">
            Every serial number delivered under this Work
          </caption>
          <thead>
            <tr>
              <th scope="col">Serial</th>
              <th scope="col">Item</th>
              <th scope="col">Challan</th>
              <th scope="col">Installation</th>
            </tr>
          </thead>
          <tbody>
            {serials.map((serial) => (
              <tr key={serial.id}>
                <th scope="row">{serial.serialNumber}</th>
                <td className={wrapCell}>{serial.itemDescription}</td>
                <td>{serial.challanNumber ?? '—'}</td>
                <td>
                  {serial.installedOn !== null ? (
                    <StatusChip status="installed">
                      installed {formatDate(serial.installedOn)}
                      {typeof serial.installationLocation === 'string'
                        ? ` at ${serial.installationLocation}`
                        : ''}
                    </StatusChip>
                  ) : (
                    <span className="text-muted-foreground">not installed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">
          No serial numbers recorded yet. Serials are recorded on the challan itself —
          on the draft for items flagged for serial traceability, which the server holds
          the issue for until every unit has one, and after issue for the rest.
        </p>
      )}
    </>
  );
}
