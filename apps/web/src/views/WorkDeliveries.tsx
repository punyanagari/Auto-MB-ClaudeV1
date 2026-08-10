import type {
  Challan,
  CorrectionNotice,
  Serial,
  WorkDetailResponse,
  WorkItem,
} from '@auto-mb/contracts';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient } from '../api.js';
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
      <div className="card__header">
        <h2>Delivery Challans</h2>
        {canCreateDocuments &&
          (challans?.some((challan) => challan.status === 'draft') === true ? (
            <button
              type="button"
              onClick={() => {
                const draft = challans.find((challan) => challan.status === 'draft');
                if (draft) onOpenChallan(draft.id);
              }}
            >
              Open draft challan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                onNewChallan(workId, work.workCode);
              }}
            >
              New Delivery Challan
            </button>
          ))}
      </div>
      {challans !== null && challans.length > 0 ? (
        <table className="data-table">
          <caption className="visually-hidden">Delivery Challans for this Work</caption>
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
                  <button
                    type="button"
                    className="button--link"
                    onClick={() => {
                      onOpenChallan(challan.id);
                    }}
                  >
                    {challan.challanNumber ?? 'Draft'}
                  </button>
                </th>
                <td>{challan.challanDate}</td>
                <td>
                  <span className={`chip chip--${challan.status}`}>
                    {challan.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No Delivery Challans yet.</p>
      )}

      {correctionNotices.length > 0 && (
        <>
          <h2>Correction notices</h2>
          <table className="data-table">
            <caption className="visually-hidden">
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
                    <span className={`chip chip--${correctionNotice.status}`}>
                      {correctionNotice.status}
                    </span>
                  </td>
                  <td>{correctionNotice.createdAt.slice(0, 10)}</td>
                  <td>
                    {correctionNotice.renderedAvailable ? (
                      <button
                        type="button"
                        className="button--ghost"
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
                      </button>
                    ) : canCreateDocuments && correctionNotice.status === 'issued' ? (
                      <button
                        type="button"
                        className="button--ghost"
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
                      </button>
                    ) : (
                      <span className="muted">not rendered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
        <table className="data-table">
          <caption className="visually-hidden">
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
                <td className="cell--wrap">{serial.itemDescription}</td>
                <td>{serial.challanNumber ?? '—'}</td>
                <td>
                  {serial.installedOn !== null ? (
                    <span className="chip chip--installed">
                      installed {serial.installedOn}
                      {typeof serial.installationLocation === 'string'
                        ? ` at ${serial.installationLocation}`
                        : ''}
                    </span>
                  ) : (
                    <span className="muted">not installed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          No serial numbers recorded yet. Serials are recorded on each issued challan.
        </p>
      )}
    </>
  );
}
