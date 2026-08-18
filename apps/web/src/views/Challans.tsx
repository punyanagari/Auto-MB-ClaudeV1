import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import {
  challansHash,
  navigateOnClick,
  type ChallanRegisterTab,
} from '../lib/workspace-routes.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { DownloadButton } from '../ui/download-button.js';
import { PageHeader } from '../ui/page-header.js';
import { Tooltip } from '../ui/tooltip.js';
import { DeliveryChallans } from './DeliveryChallans.js';
import { IssueChallans } from './IssueChallans.js';

/**
 * Challans: one register, two tabs.
 *
 * Ports `components/challans-workspace` and the header half of
 * `components/document-register` at `a8e1fde`. The mock addresses
 * the two tabs as `?type=delivery` and `?type=installation` and narrows
 * either of them with `?work=`; this build carries the same three facts
 * in its hash (`#/challans/<tab>/<workId>`), and the addresses the two
 * registers used to own — `#/delivery-challans` and `#/issue-challans` —
 * redirect into it, as the mock's own route files do.
 *
 * This component holds no data of its own. The two registers below it
 * each read their own list and own their loading, empty and failure
 * states; what lives here is the frame the mock draws around them: the
 * page header, the tab rail, the Work chip, and the create action.
 */

const TABS: readonly { readonly id: ChallanRegisterTab; readonly label: string }[] = [
  { id: 'delivery', label: 'Delivery challans' },
  { id: 'installation', label: 'Issue challans' },
];

interface ChallansProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly canModify: boolean;
  readonly canIssue: boolean;
  readonly canCancel: boolean;
  readonly canManageStatutory: boolean;
  readonly tab: ChallanRegisterTab;
  /** The `?work=` deep link, or null for the register across Works. */
  readonly workId: string | null;
  /** That Work's code, for the chip. Empty while it is still being read —
   * the chip waits rather than naming the Work by its id. */
  readonly workCode: string;
  readonly openChallanId: string | null;
  /** Opens one of the two registers, optionally narrowed to a Work. The
   * tab rail and the chip's clear control are both real links; this is
   * what a plain left click on either of them runs, so the workspace's
   * own navigation — history entry, dirty-editor guard — still owns the
   * move. */
  readonly onOpenRegister: (tab: ChallanRegisterTab, workId: string | null) => void;
  readonly onOpenChallan: (challanId: string | null) => void;
  readonly onOpenWorkChallan: (workId: string, challanId: string) => void;
  readonly onOpenIssueChallan: (workId: string, challanId: string) => void;
  readonly onNewWorkChallan: (workId: string, workCode: string) => void;
  readonly onNewIssueChallan: (workId: string) => void;
}

export function Challans({
  api,
  organisationId,
  canModify,
  canIssue,
  canCancel,
  canManageStatutory,
  tab,
  workId,
  workCode,
  openChallanId,
  onOpenRegister,
  onOpenChallan,
  onOpenWorkChallan,
  onOpenIssueChallan,
  onNewWorkChallan,
  onNewIssueChallan,
}: ChallansProps) {
  /** The delivery register's answer to "does this Work already have an
   * open draft?". It decides the create action, which the mock puts up
   * here in the header rather than in the register. */
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const reportOpenDraft = useCallback((draftChallanId: string | null) => {
    setOpenDraftId(draftChallanId);
  }, []);

  const creating = canModify && workId !== null;
  const draftHeld = tab === 'delivery' && openDraftId !== null;

  return (
    <>
      <PageHeader
        eyebrow="Documents"
        title="Challans"
        titleId="challans-title"
        description="Create and control outward delivery and issue challans from one register. An issued challan is locked, and the number it holds is never reused."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {/* DELIVERY TAB ONLY. This screen carries two registers behind
                one header, and the server can produce a workbook for one of
                them — so the button belongs to that tab rather than to the
                header. Rendered on both, it handed an operator reading
                ISSUE challans a file of DELIVERY challans, with nothing on
                screen or in the file saying so.

                The issue-challan register has no workbook yet:
                `EXPORTABLE_REGISTERS` names what the server can produce,
                and adding one is an entry there plus a descriptor. */}
            {tab === 'delivery' && (
              <DownloadButton
                label="Export .xlsx"
                filename="delivery-challans.xlsx"
                fetchBlob={() =>
                  api.downloadRegisterWorkbook(organisationId, 'delivery-challans')
                }
                {...(workId !== null
                  ? {
                      note: 'Exports every delivery challan, not just this Work’s.',
                    }
                  : {})}
              />
            )}
            {!creating ? null : tab === 'delivery' ? (
              /* The mock holds this button and explains it in a tooltip
               (`components/document-register`). The bubble is
               `aria-hidden` by that primitive's naming rule, and it can
               be: the register's own open-draft panel below carries the
               same sentence as a live region, so the explanation is
               announced whether or not the pointer ever finds the
               button. */
              <Tooltip
                content={
                  draftHeld
                    ? 'Finish or discard the open draft for this Work first.'
                    : 'Draft a delivery challan against this Work.'
                }
              >
                <Button
                  disabled={draftHeld}
                  onClick={() => {
                    onNewWorkChallan(workId, workCode);
                  }}
                >
                  New delivery challan
                </Button>
              </Tooltip>
            ) : (
              <Button
                onClick={() => {
                  onNewIssueChallan(workId);
                }}
              >
                New issue challan
              </Button>
            )}
          </div>
        }
      />

      {/* The mock's `TabsList`: a bordered card rail at `p-1` holding two
          `rounded-md` triggers. They are real anchors here rather than
          Radix triggers — the tab IS the address, so it middle-clicks
          into a new tab and Back walks between the two registers. */}
      <nav aria-label="Challan registers" className="mb-4">
        <ul className="flex w-full list-none justify-start gap-1 rounded-xl border border-border bg-card p-1 sm:w-fit">
          {TABS.map((candidate) => {
            const current = candidate.id === tab;
            return (
              <li key={candidate.id}>
                <a
                  href={challansHash(candidate.id, workId)}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors',
                    current
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent/35',
                  )}
                  onClick={navigateOnClick(() => {
                    onOpenRegister(candidate.id, workId);
                  })}
                >
                  {candidate.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* The mock's `?work=` chip: the Work is named, and the clear
          control is a link back to the same tab without it. */}
      {workId !== null && workCode !== '' && (
        <div className="mb-4 flex">
          <Badge variant="neutral" className="gap-1.5 px-2.5 py-1">
            <span>
              Work <span className="font-mono">{workCode}</span>
            </span>
            <a
              href={challansHash(tab)}
              aria-label="Clear the Work filter"
              className="rounded-sm text-muted-foreground hover:text-foreground"
              onClick={navigateOnClick(() => {
                onOpenRegister(tab, null);
              })}
            >
              <X className="size-3.5" aria-hidden="true" />
            </a>
          </Badge>
        </div>
      )}

      {tab === 'delivery' ? (
        <DeliveryChallans
          api={api}
          organisationId={organisationId}
          canModify={canModify}
          canIssue={canIssue}
          canCancel={canCancel}
          canManageStatutory={canManageStatutory}
          openChallanId={openChallanId}
          workId={workId}
          onOpenChallan={onOpenChallan}
          onOpenWorkChallan={onOpenWorkChallan}
          onOpenDraftChange={reportOpenDraft}
        />
      ) : (
        <IssueChallans
          api={api}
          organisationId={organisationId}
          workId={workId}
          onOpenIssueChallan={onOpenIssueChallan}
        />
      )}
    </>
  );
}
