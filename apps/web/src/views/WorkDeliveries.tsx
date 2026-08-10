import type {
  Challan,
  CorrectionNotice,
  Serial,
  WorkDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient } from '../api.js';
import { Button } from '../ui/button.js';
import { StatusChip } from '../ui/chip.js';
import { CardHeader } from '../ui/card.js';
import { DataTable, wrapCell } from '../ui/table.js';
import { Installations } from './Installations.js';

interface WorkDeliveriesProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  readonly work: WorkDetailResponse['work'];
  readonly workItems: readonly WorkItem[];
  /** Null while the list is still loading — distinct from "none yet". */
  readonly challans: readonly Challan[] | null;
  readonly correctionNotices: readonly CorrectionNotice[];
  readonly setCorrectionNotices: Dispatch<SetStateAction<readonly CorrectionNotice[]>>;
  readonly serials: readonly Serial[];
  readonly setSerials: Dispatch<SetStateAction<readonly Serial[]>>;
  readonly canCreateDocuments: boolean;
  readonly canRecordSiteEvidence: boolean;
  readonly onNewChallan: (workId: string, workCode: string) => void;
  readonly onOpenChallan: (challanId: string) => void;
  readonly pending: boolean;
  /** The page's shared action runner: reports, refreshes, and clears. */
  readonly act: (run: () => Promise<void>, message: string) => Promise<void>;
}

/** What has physically been delivered under this Work: the Delivery
 * Challans and any correction notices against them, the installations
 * recorded on site, and the serial trace. Split out of WorkDetail, which
 * was rendering eleven areas from one file. */
export function WorkDeliveries({
  api,
  organisationId,
  workId,
  work,
  workItems,
  challans,
  correctionNotices,
  setCorrectionNotices,
  serials,
  setSerials,
  canCreateDocuments,
  canRecordSiteEvidence,
  onNewChallan,
  onOpenChallan,
  pending,
  act,
}: WorkDeliveriesProps) {
  return (
    <>
      <CardHeader>
        <h2>Delivery Challans</h2>
        {canCreateDocuments &&
          (challans?.some((challan) => challan.status === 'draft') === true ? (
            <Button
              onClick={() => {
                const draft = challans.find((challan) => challan.status === 'draft');
                if (draft) onOpenChallan(draft.id);
              }}
            >
              Open draft challan
            </Button>
          ) : (
            <Button
              onClick={() => {
                onNewChallan(workId, work.workCode);
              }}
            >
              New Delivery Challan
            </Button>
          ))}
      </CardHeader>
      {challans !== null && challans.length > 0 ? (
        <DataTable>
          <caption className="sr-only">Delivery Challans for this Work</caption>
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {challans.map((challan) => (
              <tr key={challan.id}>
                <th scope="row">
                  <Button
                    variant="link"
                    size="inline"
                    className="font-medium"
                    onClick={() => {
                      onOpenChallan(challan.id);
                    }}
                  >
                    {challan.challanNumber ?? 'Draft'}
                  </Button>
                </th>
                <td>{challan.challanDate}</td>
                <td>
                  <StatusChip status={challan.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <p className="text-muted-foreground">No Delivery Challans yet.</p>
      )}

      {correctionNotices.length > 0 && (
        <>
          <h2>Correction notices</h2>
          <DataTable>
            <caption className="sr-only">
              Correction notices issued for this Work
            </caption>
            <thead>
              <tr>
                <th scope="col">Notice</th>
                <th scope="col">Status</th>
                <th scope="col">Issued</th>
                <th scope="col">PDF</th>
              </tr>
            </thead>
            <tbody>
              {correctionNotices.map((correctionNotice) => (
                <tr key={correctionNotice.id}>
                  <th scope="row">{correctionNotice.noticeNumber}</th>
                  <td>
                    <StatusChip status={correctionNotice.status} />
                  </td>
                  <td>{correctionNotice.createdAt.slice(0, 10)}</td>
                  <td>
                    {correctionNotice.renderedAvailable ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            const blob = await api.downloadCorrectionNoticePdf(
                              organisationId,
                              correctionNotice.id,
                            );
                            const url = URL.createObjectURL(blob);
                            window.open(url, '_blank', 'noopener');
                            setTimeout(() => {
                              URL.revokeObjectURL(url);
                            }, 60_000);
                          }, 'Correction notice PDF opened in a new tab.')
                        }
                      >
                        Open PDF
                      </Button>
                    ) : canCreateDocuments && correctionNotice.status === 'issued' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void act(async () => {
                            await api.renderCorrectionNotice(
                              organisationId,
                              correctionNotice.id,
                            );
                            setCorrectionNotices(
                              await api.listWorkCorrectionNotices(
                                organisationId,
                                workId,
                              ),
                            );
                          }, 'Correction notice PDF generated.')
                        }
                      >
                        Generate PDF
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">not rendered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      <Installations
        api={api}
        organisationId={organisationId}
        workId={workId}
        canRecordEvidence={canRecordSiteEvidence}
        workItems={workItems}
        serials={serials}
        onSerialsChanged={setSerials}
      />

      <h2>Serial trace</h2>
      {serials.length > 0 ? (
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
                      installed {serial.installedOn}
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
          No serial numbers recorded yet. Serials are recorded on each issued challan.
        </p>
      )}
    </>
  );
}
