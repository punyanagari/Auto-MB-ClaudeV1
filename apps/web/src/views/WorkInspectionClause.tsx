import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Plus, Trash2 } from 'lucide-react';
import {
  INSPECTION_AGENCIES,
  INSPECTION_CLAUSE_AGENCIES,
  type Contact,
  type InspectionAgency,
  type InspectionChecklistField,
  type InspectionClauseAgency,
  type InspectionClauseRow,
  type WorkInspectionConfig,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { todayIso } from '../format.js';
import { addressOptionLabel, liveAddresses } from '../lib/addresses.js';
import { proposeInspectionAgency } from '../lib/inspection-clause-match.js';
import { errorMessage } from '../lib/load-failure.js';
import { useAction, useReload } from '../lib/view-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Actions, Field, FormError, FormNotice, Hint } from '../ui/form.js';
import { ScheduleSection, useScheduleAccordion } from '../ui/schedule-section.js';
import { controlCell, wrapCell } from '../ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { NumericInput } from '../ui/numeric-input.js';

/**
 * The Work's Inspection clause tab.
 *
 * Replicates `components/work-inspection-mapping.tsx` and
 * `components/inspection-checklist-config.tsx` of the frozen mock at
 * fdfe5ef, in the order and with the copy the mock's
 * `app/works/[code]/page.tsx` stacks them: the clause mapping table
 * ("Categorize every item and assign the vendor premises used for
 * inspection"), then the per-agency mandatory-document checklist.
 *
 * Two things the mock draws that behave differently here, both flagged in
 * the pull request:
 *
 *   * **The dispatch gate is a real column.** The mock's mapping table has
 *     no such control, because the mock has no despatch to gate. It is the
 *     point of migration 0082, it is off for every existing item, and
 *     moving it is an owner's act — the server refuses it from anyone
 *     else, so the checkbox is disabled for the rest.
 *   * **The checklist is genuinely per Work.** The mock's copy says
 *     "the checklist snapshot used for {workCode}" while its data is a
 *     module constant keyed only by agency. Here the copy is true.
 *
 * There is no `source` column ("Generate" / "Upload" / "Generate /
 * Upload"). Nothing in this application generates a datasheet or an
 * undertaking, so every paper is an upload and a control offering the
 * other two would be a control that lies.
 */

const AGENCY_LABELS: Record<InspectionClauseAgency, string> = {
  RDSO: 'RDSO',
  RITES: 'RITES',
  consignee: 'Consignee',
};

/** The two sections the item list is split into, and the ids the
 * accordion keys its open/shut state on. `matched` is first, so the
 * accordion's own default — first section open, the rest shut — is
 * exactly the behaviour the owner asked for. */
const MATCHED = 'matched';
const OTHER = 'other';
const SECTION_IDS = [MATCHED, OTHER];

interface WorkInspectionClauseProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly workId: string;
  /** Mapping items and configuring the checklist are owner/office work. */
  readonly canModify: boolean;
  /** Only an owner may move the dispatch gate, on the same footing as the
   * Work's excess-delivery permission. */
  readonly canGate: boolean;
}

export function WorkInspectionClause({
  api,
  organisationId,
  workId,
  canModify,
  canGate,
}: WorkInspectionClauseProps) {
  const [config, setConfig] = useState<WorkInspectionConfig | null>(null);
  const [rows, setRows] = useState<readonly InspectionClauseRow[]>([]);
  /** Vendor-role contacts, with their address lists — RETIRED ones
   * included, because a stored clause may cite a vendor retired since:
   * without its row the citation would render as a blank picker over a
   * green badge, indistinguishable from an unmapped item. The PICKER
   * still offers only live vendors; the retired one appears only as the
   * named, clearable current value of the rows that cite it. */
  const [vendors, setVendors] = useState<readonly Contact[]>([]);
  const [agency, setAgency] = useState<InspectionAgency>('RDSO');
  const [fields, setFields] = useState<readonly InspectionChecklistField[]>([]);
  /** True while this Work is being held to the ORGANISATION's default list
   * rather than one of its own. Saving turns it into an override, and the
   * card says so before it happens. */
  const [inherited, setInherited] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { pending, notice, actionError, act } = useAction();
  const [requestedOn, setRequestedOn] = useState(todayIso);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [loadVersion, retry] = useReload();

  const adopt = useCallback(
    (loaded: WorkInspectionConfig, forAgency: InspectionAgency) => {
      setConfig(loaded);
      setRows(loaded.items);
      setFields(loaded.checklists[forAgency].fields);
      setInherited(loaded.checklists[forAgency].inherited);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    setLoadError(null);
    api
      .listContacts(organisationId, { role: 'vendor', includeRetired: true })
      .then((loaded) => {
        if (!cancelled) setVendors(loaded);
      })
      .catch((cause: unknown) => {
        // Said out loud, not swallowed: with an empty vendor list every
        // saved citation would render as if it were unmapped, which is
        // the screen lying rather than degrading.
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The vendor list could not be loaded.'));
      });
    api
      .getWorkInspectionConfig(organisationId, workId)
      .then((loaded) => {
        if (cancelled) return;
        adopt(loaded, 'RDSO');
        setAgency('RDSO');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The inspection clause could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, workId, loadVersion, adopt]);

  // Before the early returns, because it is a hook: two sections, the
  // matched one open on arrival and the rest shut, which is what
  // `useScheduleAccordion` already does with the first id it is given.
  const accordion = useScheduleAccordion(SECTION_IDS);

  // THE TWO LISTS' keys. An item whose description names an agency is one
  // the operator came here to map; the rest are shown too, collapsed.
  // Memoised on the LOADED config, not on the editable rows: the fuzzy
  // matcher walks every description (a million character comparisons on a
  // 129-item schedule), descriptions never change while editing, and the
  // rows' identity changes on every keystroke.
  const proposals = useMemo(
    () =>
      new Map(
        (config?.items ?? []).map((row) => [
          row.workItemId,
          proposeInspectionAgency(row.description),
        ]),
      ),
    [config],
  );

  if (loadError !== null) {
    return (
      <ErrorState onRetry={retry} retryLabel="Retry the inspection clause">
        {loadError}
      </ErrorState>
    );
  }
  if (config === null) {
    return <LoadingState label="the inspection clause" rows={4} columns={5} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState>
        This Work has no schedule items yet, so there is nothing to map for inspection.
      </EmptyState>
    );
  }

  const update = (workItemId: string, patch: Partial<InspectionClauseRow>) => {
    setRows((current) =>
      current.map((row) =>
        row.workItemId === workItemId ? { ...row, ...patch } : row,
      ),
    );
  };

  const callable = rows.filter((row) => row.agency === agency);

  // THE TWO LISTS. An item whose description names an agency is one the
  // operator came here to map; everything else is shown too — collapsed —
  // because a clause sometimes lives in the tender text rather than in
  // the item, and hiding those items outright would make the screen
  // capable of being wrong in a way nobody could see.
  const matched = rows.filter((row) => proposals.get(row.workItemId) != null);
  const others = rows.filter((row) => proposals.get(row.workItemId) == null);

  const vendorOf = (contactId: string | null): Contact | undefined =>
    contactId === null
      ? undefined
      : vendors.find((candidate) => candidate.id === contactId);

  const activeVendors = vendors.filter((vendor) => vendor.active);

  /** What one row currently cites, retired or not. A retired vendor or
   * address is not hidden from the row that cites it — that rendered as a
   * blank control over a green badge — it is shown by name, marked
   * retired, and stays clearable like any other choice. */
  const citationOf = (row: InspectionClauseRow) => {
    const vendor = vendorOf(row.vendorContactId);
    const live = liveAddresses(vendor);
    const cited =
      row.vendorAddressId === null
        ? undefined
        : (vendor?.addresses ?? []).find(
            (address) => address.id === row.vendorAddressId,
          );
    const vendorRetired = vendor !== undefined && !vendor.active;
    const addressRetired = cited !== undefined && !cited.active;
    return {
      vendor,
      vendorRetired,
      addressRetired,
      offered: addressRetired && cited !== undefined ? [...live, cited] : live,
    };
  };

  /** Picking a vendor proposes its PRIMARY address, which is the one
   * every other picker in the product defaults to, and clears the free
   * text — the two are alternatives, and the database refuses the pair. */
  const chooseVendor = (row: InspectionClauseRow, contactId: string) => {
    if (contactId === '') {
      update(row.workItemId, { vendorContactId: null, vendorAddressId: null });
      return;
    }
    const live = liveAddresses(vendorOf(contactId));
    update(row.workItemId, {
      vendorContactId: contactId,
      vendorAddressId: live[0]?.id ?? null,
      ...(live[0] === undefined ? {} : { vendorPremises: null }),
    });
  };

  const premisesCell = (row: InspectionClauseRow) => {
    const { vendor, vendorRetired, addressRetired, offered } = citationOf(row);
    return (
      <td className={controlCell}>
        <select
          aria-label={`Inspection vendor for ${row.itemNumber}`}
          disabled={!canModify || pending}
          value={row.vendorContactId ?? ''}
          onChange={(event) => {
            chooseVendor(row, event.target.value);
          }}
        >
          <option value="">Not a saved vendor</option>
          {activeVendors.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.designation}
            </option>
          ))}
          {vendorRetired && vendor !== undefined && (
            <option value={vendor.id}>{vendor.designation} (retired)</option>
          )}
        </select>
        {row.vendorContactId !== null && offered.length > 0 && (
          <select
            aria-label={`Inspection address for ${row.itemNumber}`}
            disabled={!canModify || pending}
            value={row.vendorAddressId ?? ''}
            onChange={(event) => {
              const chosen = event.target.value;
              update(row.workItemId, {
                vendorAddressId: chosen === '' ? null : chosen,
                ...(chosen === '' ? {} : { vendorPremises: null }),
              });
            }}
          >
            <option value="">Type the premises instead</option>
            {offered.map((address) => (
              <option key={address.id} value={address.id}>
                {addressOptionLabel(address)}
                {address.active ? '' : ' (retired)'}
              </option>
            ))}
          </select>
        )}
        {row.vendorAddressId === null && (
          <input
            aria-label={`Vendor premises for ${row.itemNumber}`}
            className="w-56"
            disabled={!canModify || pending}
            value={row.vendorPremises ?? ''}
            onChange={(event) => {
              update(row.workItemId, {
                vendorPremises: event.target.value === '' ? null : event.target.value,
              });
            }}
          />
        )}
        {(vendorRetired || addressRetired) && (
          <Hint>
            {vendorRetired ? 'This vendor is retired' : 'This address is retired'} — the
            next call will be refused until it is reactivated in Masters or the row
            picks another.
          </Hint>
        )}
      </td>
    );
  };

  const clauseRow = (row: InspectionClauseRow) => {
    const proposal = proposals.get(row.workItemId) ?? null;
    const { vendorRetired, addressRetired } = citationOf(row);
    return (
      <tr key={row.workItemId}>
        <td className={wrapCell}>
          <span className="font-mono text-xs text-muted-foreground">
            {row.itemNumber}
          </span>
          <span className="block font-medium">{row.description}</span>
        </td>
        <td className={controlCell}>
          <select
            aria-label={`Inspection agency for ${row.itemNumber}`}
            disabled={!canModify || pending}
            value={row.agency ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              update(row.workItemId, {
                agency: value === '' ? null : (value as InspectionClauseAgency),
                // Clearing the agency, or moving it to the consignee,
                // clears the gate with it: the server and the 0082 CHECK
                // both refuse the pair.
                ...(value === 'RDSO' || value === 'RITES'
                  ? {}
                  : { gatesDispatch: false }),
              });
            }}
          >
            <option value="">Map agency</option>
            {INSPECTION_CLAUSE_AGENCIES.map((option) => (
              <option key={option} value={option}>
                {AGENCY_LABELS[option]}
              </option>
            ))}
          </select>
          {/* The proposal, stated and never applied. The select above is
              still empty until somebody chooses, because mapping an item
              is what makes a despatch legitimate and a machine reading of
              the item text is not that decision. */}
          {proposal !== null && row.agency === null && (
            <Hint>Description reads {proposal}.</Hint>
          )}
        </td>
        <td className="text-right">
          <NumericInput
            aria-label={`Inspection quantity for ${row.itemNumber}`}
            className="w-24 text-right font-mono tabular-nums"
            disabled={!canModify || pending}
            value={row.inspectionQuantity ?? ''}
            onChange={(event) => {
              update(row.workItemId, {
                inspectionQuantity:
                  event.target.value === '' ? null : event.target.value,
              });
            }}
          />
        </td>
        <td className="text-right font-mono tabular-nums">
          {row.manufacturedQuantity}
        </td>
        {premisesCell(row)}
        <td>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={row.gatesDispatch}
              disabled={
                !canGate || pending || (row.agency !== 'RDSO' && row.agency !== 'RITES')
              }
              onChange={(event) => {
                update(row.workItemId, { gatesDispatch: event.target.checked });
              }}
            />
            Certificate required
          </label>
        </td>
        <td>
          {row.agency !== null &&
          (row.vendorAddressId !== null || row.vendorPremises !== null) ? (
            vendorRetired || addressRetired ? (
              <Badge variant="destructive">
                <AlertTriangle className="size-3" />
                {vendorRetired ? 'Vendor retired' : 'Address retired'}
              </Badge>
            ) : (
              <Badge variant="success">Mapped</Badge>
            )
          ) : (
            <Badge variant="destructive">
              <AlertTriangle className="size-3" />
              Incomplete
            </Badge>
          )}
        </td>
      </tr>
    );
  };

  const clauseTable = (section: readonly InspectionClauseRow[], caption: string) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col">Item</th>
            <th scope="col">Inspection agency</th>
            <th scope="col">Inspection qty</th>
            <th scope="col">OEM manufactured</th>
            <th scope="col">Inspection vendor and premises</th>
            <th scope="col">Gates despatch</th>
            <th scope="col">Mapping</th>
          </tr>
        </thead>
        <tbody>{section.map(clauseRow)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {actionError !== null && <FormError>{actionError}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}

      <Card className="py-0">
        <CardHeader className="flex flex-wrap items-start justify-between gap-3 pt-4">
          <div>
            <h3 className="font-medium">Inspection clause mapping</h3>
            <p className="text-xs text-muted-foreground">
              Categorize every item and assign the vendor premises used for inspection.
            </p>
          </div>
          {/* A real anchor with a hash href, not a Button: the mock's
              `nativeButton={false}` Base-UI idiom is not ported
              (`docs/UX.md` § Focus, keyboard and navigation — every mock
              Link becomes a real anchor). */}
          <a
            href="#/inspection"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent/35"
          >
            <ExternalLink className="size-4" />
            Open Inspection
          </a>
        </CardHeader>
        {/* TWO LISTS, not one. The matched section is open on
            arrival because it is the six items on a 129-item schedule an
            operator came here for; the rest are shut but present, because
            an inspection clause sometimes lives in the tender text rather
            than in the item description and a screen that hid them would
            be wrong in a way nobody could see. */}
        <div className="px-4 pb-2">
          <ScheduleSection
            heading="Matched items"
            title="Description names RDSO or RITES"
            itemCount={matched.length}
            expanded={accordion.isExpanded(MATCHED)}
            onToggle={() => {
              accordion.toggle(MATCHED);
            }}
            headingLevel={3}
          >
            {matched.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                No item description on this Work names RDSO or RITES. Map from the other
                items below.
              </p>
            ) : (
              clauseTable(
                matched,
                'Items whose description names an inspecting agency, one row per item',
              )
            )}
          </ScheduleSection>
          <ScheduleSection
            heading="Other items"
            title="Map from the tender text"
            itemCount={others.length}
            expanded={accordion.isExpanded(OTHER)}
            onToggle={() => {
              accordion.toggle(OTHER);
            }}
            headingLevel={3}
          >
            {others.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">
                Every item on this Work names an agency in its description.
              </p>
            ) : (
              clauseTable(
                others,
                'Items whose description names no agency, one row per item',
              )
            )}
          </ScheduleSection>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Consignee items remain work-specific and do not appear in the RDSO or RITES
            Inspection workspace, and can never gate despatch: the consignee inspects
            after the material arrives.
          </p>
          {canModify && (
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const saved = await api.saveInspectionClauses(
                    organisationId,
                    workId,
                    {
                      clauses: rows.map((row) => ({
                        workItemId: row.workItemId,
                        agency: row.agency,
                        inspectionQuantity: row.inspectionQuantity,
                        vendorContactId: row.vendorContactId,
                        vendorAddressId: row.vendorAddressId,
                        vendorPremises: row.vendorPremises,
                        gatesDispatch: row.gatesDispatch,
                      })),
                    },
                  );
                  adopt(saved, agency);
                }, 'Inspection clause mapping saved.')
              }
            >
              Save clause mapping
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-medium">Mandatory inspection documents</h3>
            <p className="text-xs text-muted-foreground">
              Configure the checklist snapshot used for this Work&rsquo;s inspection
              calls. A call already raised keeps the list it was raised under.
            </p>
            {inherited && (
              <p className="mt-1 text-xs text-muted-foreground">
                This Work has no list of its own and is being held to the
                organisation&rsquo;s {agency} default. Saving it here creates an
                override for this Work; saving it as the default changes it for every
                Work that has not overridden it.
              </p>
            )}
          </div>
          <Field>
            <label htmlFor="checklist-agency">Agency</label>
            <select
              id="checklist-agency"
              value={agency}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value as InspectionAgency;
                setAgency(next);
                setFields(config.checklists[next].fields);
                setInherited(config.checklists[next].inherited);
                setChosen([]);
              }}
            >
              {INSPECTION_AGENCIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        </CardHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {agency} demands no documents on this Work yet.
            </p>
          )}
          {fields.map((field, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <input
                className="min-w-48 flex-1"
                aria-label={`Document ${String(index + 1)} name`}
                disabled={!canModify || pending}
                value={field.label}
                onChange={(event) => {
                  setFields((current) =>
                    current.map((entry, position) =>
                      position === index
                        ? { ...entry, label: event.target.value }
                        : entry,
                    ),
                  );
                }}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={field.mandatory}
                  disabled={!canModify || pending}
                  onChange={(event) => {
                    setFields((current) =>
                      current.map((entry, position) =>
                        position === index
                          ? { ...entry, mandatory: event.target.checked }
                          : entry,
                      ),
                    );
                  }}
                />
                Mandatory
              </label>
              {canModify && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove ${field.label}`}
                  disabled={pending}
                  onClick={() => {
                    setFields((current) =>
                      current.filter((_, position) => position !== index),
                    );
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          ))}
          {canModify && (
            <Actions>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setFields((current) => [
                    ...current,
                    { label: 'New document', mandatory: true },
                  ]);
                }}
              >
                <Plus data-icon="inline-start" />
                Add document field
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    const saved = await api.saveInspectionChecklist(
                      organisationId,
                      workId,
                      { agency, scope: 'organisation', fields: [...fields] },
                    );
                    adopt(saved, agency);
                  }, `${agency} checklist saved as the organisation default.`)
                }
              >
                Save as organisation default
              </Button>
              <Button
                type="button"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    const saved = await api.saveInspectionChecklist(
                      organisationId,
                      workId,
                      { agency, scope: 'work', fields: [...fields] },
                    );
                    adopt(saved, agency);
                  }, `${agency} checklist saved for this Work.`)
                }
              >
                Save for this Work
              </Button>
            </Actions>
          )}
        </div>
      </Card>

      {canModify && (
        <Card>
          <CardHeader>
            <h3 className="font-medium">Raise an {agency} inspection call</h3>
            <p className="text-xs text-muted-foreground">
              Only items mapped to {agency} can be offered. The call takes the checklist
              above as its snapshot, and its life continues on the Inspection screen.
            </p>
          </CardHeader>
          <div className="flex flex-col gap-3 px-4 pb-4">
            {callable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No item on this Work is mapped to {agency}. Map one above and save the
                mapping first.
              </p>
            ) : (
              <>
                <fieldset className="flex flex-col gap-2">
                  <legend className="section-label">Items offered</legend>
                  {callable.map((row) => (
                    <label
                      key={row.workItemId}
                      className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={chosen.includes(row.workItemId)}
                        disabled={pending}
                        onChange={(event) => {
                          setChosen((current) =>
                            event.target.checked
                              ? [...current, row.workItemId]
                              : current.filter((id) => id !== row.workItemId),
                          );
                        }}
                      />
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.itemNumber}
                      </span>
                      <span className="min-w-0 flex-1">{row.description}</span>
                      <span className="font-mono tabular-nums">
                        {row.inspectionQuantity ?? row.awardedQuantity}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <Field>
                  <label htmlFor="call-requested-on">Request date</label>
                  <input
                    id="call-requested-on"
                    type="date"
                    value={requestedOn}
                    disabled={pending}
                    onChange={(event) => {
                      setRequestedOn(event.target.value);
                    }}
                  />
                  <Hint>DD/MM/YYYY. The day the placing request goes out.</Hint>
                </Field>
                <Actions>
                  <Button
                    type="button"
                    disabled={pending || chosen.length === 0}
                    onClick={() =>
                      void act(async () => {
                        // The call takes its premises from the first item
                        // offered, whole: vendor, address and free text
                        // travel together because the server refuses a
                        // half-stated pair, and the call SNAPSHOTS what it
                        // resolves them to.
                        const source = callable.find((row) =>
                          chosen.includes(row.workItemId),
                        );
                        await api.createInspectionCall(organisationId, workId, {
                          agency,
                          requestedOn,
                          vendorContactId: source?.vendorContactId ?? null,
                          vendorAddressId: source?.vendorAddressId ?? null,
                          vendorPremises: source?.vendorPremises ?? null,
                          items: chosen.map((workItemId) => {
                            const row = callable.find(
                              (candidate) => candidate.workItemId === workItemId,
                            );
                            return {
                              workItemId,
                              quantity:
                                row?.inspectionQuantity ?? row?.awardedQuantity ?? '1',
                            };
                          }),
                        });
                        setChosen([]);
                      }, `${agency} inspection call raised; continue it on the Inspection screen.`)
                    }
                  >
                    Raise inspection call
                  </Button>
                </Actions>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
