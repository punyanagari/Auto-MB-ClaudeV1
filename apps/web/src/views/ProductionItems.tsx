import { useEffect, useId, useRef, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  BomNode,
  ProductionItem,
  ProductionItemRole,
  ProductionSpecification,
  SaveProductionItemRequest,
} from '@auto-mb/contracts';
import { type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { errorMessage } from '../lib/load-failure.js';
import { useReload } from '../lib/view-state.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { StatusChip } from '../ui/chip.js';
import { Actions, Field, FieldRow, FormError, FormNotice, Hint } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';
import { NumericInput } from '../ui/numeric-input.js';
import { TabRail } from '../ui/tab-rail.js';
import { useUnavailableControl } from '../ui/unavailable.js';

/**
 * The OEM item master and its recursive bill of material.
 *
 * Replicates `app/production/items/page.tsx` of the frozen mock at
 * fdfe5ef: a `[280px_1fr]` split with an "OEM catalogue" card on the left
 * and, on the right, the item header card carrying the serial series in a
 * muted well, then Specifications, then Bill of material — each an
 * indented row with a chevron, a name over its type, and a right-aligned
 * mono quantity with a "Serial required" outline badge.
 *
 * What the mock fakes and this builds, inside its own grammar:
 *
 *   * **Its "Add OEM item" and "Material" buttons do nothing**, and its
 *     specification editor is `useState` over a module literal. Both are
 *     real here, against migration 0084.
 *   * **Its `node.type`** — 'raw' or 'sub-assembly' — is a stored string.
 *     It is derived here from whether the node has a bill of its own,
 *     because those are the same fact and one of them can be wrong.
 *   * **Its BOM tree has no cycle refusal.** `explodeBom` in `lib/data.ts`
 *     recurses with no visited set, so the moment its Material button
 *     reached real data it would stack-overflow. The refusal is in the
 *     database (migration 0084 § 2), and this screen renders the refusal
 *     it raises.
 *   * **Its row prints `node.itemId`** under the name — a fixture key. It
 *     prints the part number here, which is what an operator reads off a
 *     label.
 */

interface ProductionItemsProps {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** The item master is product design: owner and office, exactly as the
   * server gates it. Site staff record units against it. */
  readonly canModify: boolean;
}

interface ItemDraft {
  itemCode: string;
  name: string;
  category: string;
  unit: string;
  manufactured: boolean;
  serialPrefix: string;
  serialControlled: boolean;
}

const EMPTY_DRAFT: ItemDraft = {
  itemCode: '',
  name: '',
  category: '',
  unit: 'Nos',
  manufactured: true,
  serialPrefix: '',
  serialControlled: true,
};

/** What each kind is called where the screen LABELS one. */
const ROLE_NOUN: Readonly<Record<ProductionItemRole, string>> = {
  oem: 'OEM item',
  sub: 'Sub item',
};

/** The same two inside a sentence — "New OEM item", "Add sub item". An
 * initialism keeps its capitals mid-sentence and a common noun does
 * not, which is why this is a second table rather than `toLowerCase`. */
const ROLE_NOUN_INLINE: Readonly<Record<ProductionItemRole, string>> = {
  oem: 'OEM item',
  sub: 'sub item',
};

/**
 * A draft, shaped into the request body both forms send.
 *
 * The implications live here and only here, because the server states
 * them as refusals and a form that computed them differently in two
 * places would meet one of those refusals in exactly one of them: an OEM
 * item is manufactured (migration 0117), and a manufactured item always
 * carries a serial series and is always serial controlled (0084).
 */
function itemBody(
  draft: ItemDraft,
  role: ProductionItemRole,
  specifications?: readonly ProductionSpecification[],
): SaveProductionItemRequest {
  const manufactured = role === 'oem' || draft.manufactured;
  return {
    itemCode: draft.itemCode,
    name: draft.name,
    category: draft.category,
    unit: draft.unit,
    manufactured,
    role,
    ...(manufactured ? { serialPrefix: draft.serialPrefix.toUpperCase() } : {}),
    serialControlled: manufactured || draft.serialControlled,
    ...(specifications === undefined ? {} : { specifications: [...specifications] }),
  };
}

export function ProductionItems({
  api,
  organisationId,
  canModify,
}: ProductionItemsProps) {
  const [items, setItems] = useState<readonly ProductionItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, reload] = useReload();
  const [includeRetired, setIncludeRetired] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /* Item 31: the rail is the OEM catalogue, and sub items are the parts
     it is built from. Both stay reachable — a part still has to be
     renamed and retired — but only one of them is what an operator opens
     this screen to find. */
  const [kind, setKind] = useState<ProductionItemRole>('oem');

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadError(null);
    api
      .listProductionItems(organisationId, includeRetired)
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded.items);
        setActiveId((current) =>
          current !== null && loaded.items.some((item) => item.id === current)
            ? current
            : (loaded.items.find((item) => item.role === 'oem')?.id ??
              loaded.items[0]?.id ??
              null),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The item master could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, includeRetired, loadVersion]);

  const [creating, setCreating] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Production master"
      title="Manufactured items"
      titleId="production-items-title"
      description="Define OEM products and the sub items they are built from, with user-owned specifications, serial series, and recursive bills of material."
      action={
        canModify ? (
          <Button
            onClick={() => {
              setCreating((open) => !open);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add item
          </Button>
        ) : undefined
      }
    />
  );

  if (loadError !== null) {
    return (
      <>
        {header}
        <ErrorState onRetry={reload} retryLabel="Retry the item master">
          {loadError}
        </ErrorState>
      </>
    );
  }

  if (items === null) {
    return (
      <>
        {header}
        <LoadingState label="the item master" rows={4} columns={2} />
      </>
    );
  }

  const active = items.find((item) => item.id === activeId) ?? null;
  const visible = items.filter((item) => item.role === kind);

  return (
    <>
      {header}
      {creating && (
        <ItemForm
          api={api}
          organisationId={organisationId}
          onSaved={(created) => {
            setCreating(false);
            setKind(created.role);
            setActiveId(created.id);
            reload();
          }}
          onCancel={() => {
            setCreating(false);
          }}
        />
      )}
      {actionError !== null && <FormError>{actionError}</FormError>}
      {/* Masters retires a master rather than deleting it, and shows the
          retired ones behind a toggle (`views/Masters.tsx`). The item
          master is a master and behaves like one. */}
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeRetired}
          onChange={(event) => {
            setIncludeRetired(event.currentTarget.checked);
          }}
        />
        Show retired items
      </label>
      {items.length === 0 ? (
        <EmptyState>
          Nothing in the catalogue yet. Add the products the agency manufactures and the
          parts they are built from; a bill of material joins the two.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader className="flex flex-col items-stretch gap-3">
              <h2 className="text-sm font-semibold">Catalogue</h2>
              <TabRail
                label="Catalogue kind"
                tabs={[
                  ['oem', 'OEM items'],
                  ['sub', 'Sub items'],
                ]}
                active={kind}
                onSelect={(next) => {
                  setKind(next);
                  /* The rail's selection follows its filter: an item
                     that is no longer listed cannot be the one the
                     detail pane is describing. When the filter has
                     nothing to select, the pane clears rather than
                     keeping the last item — a detail pane describing a
                     row the rail beside it does not show is the two
                     halves of the screen disagreeing. */
                  setActiveId(items.find((item) => item.role === next)?.id ?? null);
                }}
              />
            </CardHeader>
            {visible.length === 0 ? (
              <EmptyState>
                {kind === 'oem'
                  ? 'No OEM items yet. An OEM item is a product the agency builds and sells, named unit by unit from its own serial series.'
                  : 'No sub items yet. A sub item is a part or a sub-assembly a product is built from; it appears inside a bill of material rather than in the OEM catalogue.'}
              </EmptyState>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {visible.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={item.id === activeId ? 'true' : undefined}
                      onClick={() => {
                        setActiveId(item.id);
                      }}
                      className={cn(
                        'w-full rounded-lg border p-3 text-left transition-colors',
                        item.id === activeId
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-muted',
                      )}
                    >
                      <p className="m-0 font-medium">{item.name}</p>
                      <p className="m-0 mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                        {item.itemCode}
                      </p>
                      {/* A sub item may be bought or built, which is the
                          reason the kind is not the manufactured flag. */}
                      {item.role === 'sub' && item.manufactured && (
                        <Badge variant="outline" className="mt-2">
                          Manufactured
                        </Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {active !== null && (
            <ItemDetail
              key={active.id}
              api={api}
              organisationId={organisationId}
              item={active}
              catalogue={items}
              canModify={canModify}
              onChanged={(saved) => {
                /* An edit may have changed what KIND the item is, and
                   the rail filters on exactly that. Following it keeps
                   the item the operator was editing on screen instead of
                   dropping it out of the list they are looking at — the
                   same move the create form makes. */
                if (saved !== undefined) setKind(saved.role);
                reload();
              }}
              onSetActive={(active) => {
                setActionError(null);
                api
                  .setProductionItemActive(organisationId, active.id, active.active)
                  .then(reload)
                  .catch((cause: unknown) => {
                    setActionError(
                      errorMessage(cause, 'The item could not be retired.'),
                    );
                  });
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * The item form — one component, creating or editing.
 *
 * CREATING, it opens on a QUESTION rather than on fields, per the owner's
 * item-31 ruling: "Add OEM item" misled, because not everything in the
 * catalogue is an OEM product. The kind is asked first because it decides
 * the rest of the form — an OEM item is manufactured and therefore
 * serialised, where a sub item may be bought in. Inline under the header
 * rather than in a modal: the mock's own "Add OEM item" opens nothing, so
 * there is no dialog to replicate, and a six-field form does not earn a
 * focus trap.
 *
 * EDITING is the path the item master never had (owner ruling, item 29).
 * A production item is a MASTER, and a master is meant to be correctable
 * — a part number typed wrong on a Tuesday should not be permanent. Name,
 * part number, category and unit are free; every record that snapshotted
 * them kept its own copy, so none of them rewrites history.
 *
 * ONE component and not two, because the two differ in three lines of
 * initial state and a verb. The version that split them carried a hundred
 * duplicated lines of markup, which is a hundred lines for the two forms
 * to drift apart in — and the field they would drift on is the serial
 * series, whose rules are the ones that matter most.
 *
 * The three things that cannot move are refusals with names rather than
 * controls quietly missing from the form. Each stays visible, disabled,
 * and says why — through `ui/unavailable.tsx`'s `useUnavailableControl`,
 * which is UX § 31's mechanism: the reason is a VISIBLE line bound to the
 * control by `aria-describedby`, so a touch user with no hover and a
 * screen reader that never lands on a disabled control both still get it.
 *
 *   * the serial series, once a unit carries the prefix on its label;
 *   * whether the agency manufactures this, and whether its serials are
 *     captured, once a job card, a unit, a component consumption or a
 *     stock issue references it;
 *   * OEM as a KIND, while the item is not manufactured and can no
 *     longer become so.
 *
 * The same three are refused by the route under its own row lock and by
 * the database guard behind it (`0084` § 1, widened by `0117`). This
 * layer only spares the operator the trip. None of them can bite while
 * CREATING — nothing references a row that does not exist yet — so on
 * that path every reason is null and every control is live.
 */
function ItemForm({
  api,
  organisationId,
  item,
  kind: fixedRole,
  onSaved,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  /** Present means EDIT this item; absent means create a new one. */
  readonly item?: ProductionItem;
  /** Set where the kind is not the operator's to choose — the bill of
   * material creates parts, and a part is a sub item by definition. */
  readonly kind?: ProductionItemRole;
  readonly onSaved: (item: ProductionItem) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ItemDraft>(
    item === undefined
      ? {
          ...EMPTY_DRAFT,
          // The kind the chooser is skipped for still has to bring the
          // default the chooser would have set: a part is bought in
          // until it says otherwise, and a form that opened asking for a
          // serial series it never shows cannot be submitted at all.
          manufactured: fixedRole !== 'sub',
        }
      : {
          itemCode: item.itemCode,
          name: item.name,
          category: item.category,
          unit: item.unit,
          manufactured: item.manufactured,
          serialPrefix: item.serialPrefix ?? '',
          serialControlled: item.serialControlled,
        },
  );
  const [chosen, setChosen] = useState<ProductionItemRole | null>(
    item?.role ?? fixedRole ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /* One id namespace per instance. Three of these can be on screen at
     once — the header's create form, an edit form in the detail pane,
     and the bill of material's inline part form — and a fixed id would
     put duplicates in the document, which is both an axe violation and a
     label pointing at the wrong input. */
  const uid = useId();
  const at = (field: string): string => `${uid}-${field}`;

  const seriesReason =
    item?.serialSeriesLocked === true
      ? `Units have already been built as ${item.serialPrefix ?? ''}-00001 and up, and the prefix is printed on them, so the series can no longer change.`
      : null;
  const flagsReason =
    item?.flagsLocked === true
      ? 'This item has job cards, units or consumptions on record, so whether the agency manufactures it and whether its serials are captured are both settled.'
      : null;
  // Becoming an OEM item means becoming manufactured, which is the one
  // thing the flags lock refuses.
  const oemReason =
    item !== undefined && !item.manufactured && item.flagsLocked
      ? 'An OEM item is manufactured, and this item cannot start being manufactured now that it has job cards, units or consumptions on record.'
      : null;
  /* Four calls and not two, though two of them carry the same sentence:
     each returns its OWN hint id, and two controls describing themselves
     by one id would either duplicate the id in the document or leave one
     of them pointing at a hint that is not beside it. */
  const oem = useUnavailableControl(oemReason);
  const series = useUnavailableControl(seriesReason);
  const madeHere = useUnavailableControl(flagsReason);
  const captureSerials = useUnavailableControl(flagsReason);

  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  if (chosen === null) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <h2 className="text-base font-semibold">What kind of item is this?</h2>
        </CardHeader>
        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            className="h-auto justify-start py-3 text-left"
            onClick={() => {
              setChosen('oem');
              set('manufactured', true);
            }}
          >
            <span>
              <span className="block font-medium">OEM item</span>
              <span className="block text-xs font-normal text-muted-foreground">
                A product the agency builds and sells. It is named unit by unit from its
                own serial series, and job cards are raised for it.
              </span>
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto justify-start py-3 text-left"
            onClick={() => {
              setChosen('sub');
              /* Most sub items are bought in; the ones that are not say
                 so with the checkbox the choice reveals. */
              set('manufactured', false);
            }}
          >
            <span>
              <span className="block font-medium">Sub item</span>
              <span className="block text-xs font-normal text-muted-foreground">
                A part or a sub-assembly a product is built from, bought in or built
                here. It appears inside bills of material rather than in the OEM
                catalogue.
              </span>
            </span>
          </Button>
        </div>
        <Actions>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </Actions>
      </Card>
    );
  }

  const role = chosen;
  const manufactured = role === 'oem' || draft.manufactured;
  const editing = item !== undefined;

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            {editing ? 'Edit' : 'New'} {ROLE_NOUN_INLINE[editing ? item.role : role]}
          </h2>
          {editing && (
            <p className="m-0 text-sm text-muted-foreground">
              Documents that already named this item keep the wording they were issued
              with.
            </p>
          )}
        </div>
        {!editing && fixedRole === undefined && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setChosen(null);
            }}
          >
            Choose a different kind
          </Button>
        )}
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setPending(true);
          api
            .saveProductionItem(organisationId, item?.id ?? null, itemBody(draft, role))
            .then(onSaved)
            .catch((cause: unknown) => {
              setError(errorMessage(cause, 'The item could not be saved.'));
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <FieldRow>
          <Field>
            <label htmlFor={at('code')}>Part number</label>
            <input
              id={at('code')}
              required
              minLength={2}
              maxLength={40}
              value={draft.itemCode}
              onChange={(event) => {
                set('itemCode', event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor={at('name')}>Name</label>
            <input
              id={at('name')}
              required
              minLength={2}
              maxLength={200}
              value={draft.name}
              onChange={(event) => {
                set('name', event.currentTarget.value);
              }}
            />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field>
            <label htmlFor={at('category')}>Category</label>
            <input
              id={at('category')}
              required
              minLength={2}
              maxLength={100}
              value={draft.category}
              onChange={(event) => {
                set('category', event.currentTarget.value);
              }}
            />
          </Field>
          <Field>
            <label htmlFor={at('unit')}>Unit</label>
            <input
              id={at('unit')}
              required
              maxLength={20}
              value={draft.unit}
              onChange={(event) => {
                set('unit', event.currentTarget.value);
              }}
            />
          </Field>
        </FieldRow>
        {/* Creating, the kind was answered by the chooser above and the
            form is already shaped by it. Editing, it is a field like any
            other: picking the wrong kind is exactly the mistake a master
            edit exists to correct (migration 0117). */}
        {editing && (
          <fieldset className="m-0 border-0 p-0">
            <legend className="text-sm leading-snug font-medium">Kind</legend>
            <label
              className="mt-2 flex items-center gap-2 text-sm"
              htmlFor={at('role-oem')}
              title={oemReason ?? undefined}
            >
              <input
                id={at('role-oem')}
                type="radio"
                name={at('role')}
                checked={role === 'oem'}
                {...oem.control}
                onChange={() => {
                  setChosen('oem');
                }}
              />
              OEM item — a product the agency builds and sells
            </label>
            <label
              className="mt-2 flex items-center gap-2 text-sm"
              htmlFor={at('role-sub')}
            >
              <input
                id={at('role-sub')}
                type="radio"
                name={at('role')}
                checked={role === 'sub'}
                onChange={() => {
                  setChosen('sub');
                }}
              />
              Sub item — a part or a sub-assembly, reached through a bill of material
            </label>
            {oemReason !== null && <Hint id={oem.hintId}>{oemReason}</Hint>}
          </fieldset>
        )}
        {/* An OEM item is manufactured by definition (migration 0117),
            so the question is only asked of a sub item — a bolt is
            bought and a welded sub-assembly is not. */}
        {role === 'sub' && (
          <Field>
            <label
              className="flex items-center gap-2 font-normal!"
              htmlFor={at('manufactured')}
              title={flagsReason ?? undefined}
            >
              <input
                id={at('manufactured')}
                type="checkbox"
                checked={draft.manufactured}
                {...madeHere.control}
                onChange={(event) => {
                  set('manufactured', event.currentTarget.checked);
                }}
              />
              The agency manufactures this. A job card may be raised for it, and every
              unit it produces is named from a serial series.
            </label>
            {flagsReason !== null && <Hint id={madeHere.hintId}>{flagsReason}</Hint>}
          </Field>
        )}
        {manufactured ? (
          <Field>
            <label htmlFor={at('prefix')}>Serial series</label>
            <input
              id={at('prefix')}
              required
              pattern="[A-Za-z0-9][A-Za-z0-9-]{1,15}"
              maxLength={16}
              placeholder="IPDB6"
              title={seriesReason ?? undefined}
              {...series.control}
              value={draft.serialPrefix}
              onChange={(event) => {
                set('serialPrefix', event.currentTarget.value);
              }}
            />
            <Hint id={series.hintId}>
              {seriesReason ??
                `Units are named ${(draft.serialPrefix || 'PREFIX').toUpperCase()}-00001. It cannot be changed once the first unit is built.`}
            </Hint>
          </Field>
        ) : (
          <Field>
            <label
              className="flex items-center gap-2 font-normal!"
              htmlFor={at('serial-controlled')}
              title={flagsReason ?? undefined}
            >
              <input
                id={at('serial-controlled')}
                type="checkbox"
                checked={draft.serialControlled}
                {...captureSerials.control}
                onChange={(event) => {
                  set('serialControlled', event.currentTarget.checked);
                }}
              />
              Capture this part&apos;s serials when it is consumed into a unit.
            </label>
            {flagsReason !== null && (
              <Hint id={captureSerials.hintId}>{flagsReason}</Hint>
            )}
          </Field>
        )}
        {error !== null && <FormError>{error}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending}>
            {editing ? 'Save item' : `Add ${ROLE_NOUN_INLINE[role]}`}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </Actions>
      </form>
    </Card>
  );
}

function ItemDetail({
  api,
  organisationId,
  item,
  catalogue,
  canModify,
  onChanged,
  onSetActive,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly item: ProductionItem;
  readonly catalogue: readonly ProductionItem[];
  readonly canModify: boolean;
  /** The saved item is passed when there IS one, so the page can follow
   * a kind the edit changed; the specification editor has nothing to
   * pass and calls this bare. */
  readonly onChanged: (saved?: ProductionItem) => void;
  readonly onSetActive: (next: {
    readonly id: string;
    readonly active: boolean;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <p className="section-label m-0">{ROLE_NOUN[item.role]}</p>
            <h2 className="mt-1 text-xl font-semibold">{item.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="neutral">{item.category}</Badge>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {item.itemCode} · {item.unit}
              </span>
              {!item.active && <StatusChip status="archived">Retired</StatusChip>}
            </div>
            {canModify && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditing((open) => !open);
                  }}
                >
                  <Pencil data-icon="inline-start" aria-hidden="true" />
                  Edit item
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onSetActive({ id: item.id, active: !item.active });
                  }}
                >
                  {item.active ? 'Retire item' : 'Reactivate item'}
                </Button>
              </div>
            )}
          </div>
          {/* The mock's muted well. It prints its fixture's `nextSerial`;
              this prints the SHAPE of the series instead, because the next
              number is claimed from a counter at the moment a unit is
              built and any figure shown here would be stale the instant a
              second operator built one. */}
          <div className="rounded-xl bg-muted p-3">
            <p className="section-label m-0">Serial series</p>
            {item.serialPrefix === null ? (
              <p className="m-0 mt-1 text-sm text-muted-foreground">
                Not manufactured here
              </p>
            ) : (
              <>
                <p className="m-0 mt-1 font-mono font-semibold tabular-nums">
                  {item.serialPrefix}-00000
                </p>
                <p className="m-0 text-xs text-muted-foreground">
                  Claimed per unit, gap-free
                </p>
              </>
            )}
          </div>
        </div>
      </Card>

      {editing && canModify && (
        <ItemForm
          api={api}
          organisationId={organisationId}
          item={item}
          onSaved={(saved) => {
            setEditing(false);
            onChanged(saved);
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      )}

      <SpecificationsCard
        api={api}
        organisationId={organisationId}
        item={item}
        canModify={canModify}
        onSaved={() => {
          onChanged();
        }}
      />

      {item.manufactured && (
        <BillOfMaterialCard
          api={api}
          organisationId={organisationId}
          item={item}
          catalogue={catalogue}
          canModify={canModify}
          onCatalogueChanged={() => {
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function SpecificationsCard({
  api,
  organisationId,
  item,
  canModify,
  onSaved,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly item: ProductionItem;
  readonly canModify: boolean;
  readonly onSaved: () => void;
}) {
  const [specs, setSpecs] = useState<readonly ProductionSpecification[]>(
    item.specifications,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = JSON.stringify(specs) !== JSON.stringify(item.specifications);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Specifications</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Attribute names are created by users.
          </p>
        </div>
        {canModify && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSpecs((current) => [...current, { attribute: '', value: '' }]);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Attribute
          </Button>
        )}
      </CardHeader>
      {specs.length === 0 ? (
        <EmptyState>No specifications yet. Add your first attribute.</EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {specs.map((spec, index) => (
            /* Keyed by position, deliberately: a specification has no id
               of its own — migration 0084 stores the list as one jsonb
               value — so while it is being edited its position IS its
               identity, and rows are only ever appended or removed. */
            <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <label className="sr-only" htmlFor={`spec-attribute-${String(index)}`}>
                Attribute {index + 1}
              </label>
              <input
                id={`spec-attribute-${String(index)}`}
                placeholder="Attribute"
                maxLength={100}
                disabled={!canModify}
                value={spec.attribute}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setSpecs((current) =>
                    current.map((row, at) =>
                      at === index ? { ...row, attribute: next } : row,
                    ),
                  );
                }}
              />
              <label className="sr-only" htmlFor={`spec-value-${String(index)}`}>
                Value {index + 1}
              </label>
              <input
                id={`spec-value-${String(index)}`}
                placeholder="Value"
                maxLength={200}
                disabled={!canModify}
                value={spec.value}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setSpecs((current) =>
                    current.map((row, at) =>
                      at === index ? { ...row, value: next } : row,
                    ),
                  );
                }}
              />
              {canModify && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove specification ${index + 1}`}
                  onClick={() => {
                    setSpecs((current) => current.filter((_, at) => at !== index));
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {error !== null && <FormError>{error}</FormError>}
      {notice !== null && <FormNotice>{notice}</FormNotice>}
      {canModify && dirty && (
        <Actions>
          <Button
            disabled={pending}
            onClick={() => {
              setError(null);
              setNotice(null);
              setPending(true);
              api
                .saveProductionItem(organisationId, item.id, {
                  itemCode: item.itemCode,
                  name: item.name,
                  category: item.category,
                  unit: item.unit,
                  manufactured: item.manufactured,
                  ...(item.serialPrefix === null
                    ? {}
                    : { serialPrefix: item.serialPrefix }),
                  serialControlled: item.serialControlled,
                  specifications: [...specs],
                })
                .then(() => {
                  setNotice('Specifications saved.');
                  onSaved();
                })
                .catch((cause: unknown) => {
                  setError(
                    errorMessage(cause, 'The specifications could not be saved.'),
                  );
                })
                .finally(() => {
                  setPending(false);
                });
            }}
          >
            Save specifications
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSpecs(item.specifications);
            }}
          >
            Discard changes
          </Button>
        </Actions>
      )}
    </Card>
  );
}

function BillOfMaterialCard({
  api,
  organisationId,
  item,
  catalogue,
  canModify,
  onCatalogueChanged,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly item: ProductionItem;
  readonly catalogue: readonly ProductionItem[];
  readonly canModify: boolean;
  /** Called once this card is done with a part created inside it, so the
   * page's own catalogue catches up. Deliberately NOT called the moment
   * the part is created: the reload it triggers replaces the whole grid
   * with the loading state, which would take the half-filled material
   * line with it — and returning to that line with the new part selected
   * is the entire point of creating it here (item 28). */
  readonly onCatalogueChanged: () => void;
}) {
  const [nodes, setNodes] = useState<readonly BomNode[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creatingPart, setCreatingPart] = useState(false);
  const [createdParts, setCreatedParts] = useState<readonly ProductionItem[]>([]);
  const [componentId, setComponentId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [pending, setPending] = useState(false);
  const [loadVersion, retry] = useReload();

  /* The debt of a part created inside this panel: the page's catalogue
     is one load behind until somebody tells it. Held in a ref and
     settled on UNMOUNT rather than only when the panel closes, because
     closing the panel is not the only way to leave it — selecting
     another item in the rail remounts this card by key, and the version
     that only paid on close lost the part on that path, leaving it out
     of the next item's component list until a manual reload. The ref
     rather than `createdParts` because a cleanup closes over the state
     it was created with, and this one must read the latest. */
  const owed = useRef(false);
  const notify = useRef(onCatalogueChanged);
  notify.current = onCatalogueChanged;
  useEffect(
    () => () => {
      if (owed.current) notify.current();
    },
    [],
  );

  /** Closes the panel, and settles the debt if there is one. */
  const closePanel = (): void => {
    setAdding(false);
    setCreatingPart(false);
    setComponentId('');
    setQuantity('1');
    if (owed.current) {
      owed.current = false;
      onCatalogueChanged();
    }
  };

  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    setLoadError(null);
    api
      .getProductionBom(organisationId, item.id)
      .then((loaded) => {
        if (cancelled) return;
        setNodes(loaded.nodes);
        setTruncated(loaded.truncated);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(cause, 'The bill of material could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, item.id, loadVersion]);

  /* Every item except this one is a candidate. The database refuses a
     cycle and a retired part regardless (migration 0084 § 2); the select
     only spares the operator the two refusals it can see coming.
     Anything created inside this panel joins the list immediately —
     the page's own catalogue is a load behind until the panel closes. */
  const candidates = [
    ...catalogue,
    ...createdParts.filter((part) => !catalogue.some((known) => known.id === part.id)),
  ].filter((candidate) => candidate.id !== item.id);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Bill of material</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Nested quantities roll up into production requirements.
          </p>
        </div>
        {canModify && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (adding) closePanel();
              else setAdding(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Material
          </Button>
        )}
      </CardHeader>

      {/* Item 28: the component select used to be an empty dropdown
          whenever the catalogue held nothing else — no reason given and
          nowhere to go. The part is created here instead, and the panel
          comes back with it chosen. */}
      {adding && canModify && creatingPart && (
        <ItemForm
          api={api}
          organisationId={organisationId}
          kind="sub"
          onSaved={(created) => {
            setCreatedParts((current) => [...current, created]);
            setComponentId(created.id);
            setCreatingPart(false);
            owed.current = true;
          }}
          onCancel={() => {
            setCreatingPart(false);
          }}
        />
      )}

      {adding && canModify && !creatingPart && candidates.length === 0 && (
        <div className="mb-3 rounded-lg border border-border p-3">
          <EmptyState>
            There are no other items in the catalogue yet, so there is nothing to build
            this one from. Add the first part — a bought-in component or a sub-assembly
            — and it will be waiting here.
          </EmptyState>
          <Actions>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setCreatingPart(true);
              }}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              Create a part
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={closePanel}>
              Cancel
            </Button>
          </Actions>
        </div>
      )}

      {adding && canModify && !creatingPart && candidates.length > 0 && (
        <form
          className="mb-3 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setActionError(null);
            setPending(true);
            api
              .addProductionBomLine(organisationId, item.id, {
                componentItemId: componentId,
                quantity,
              })
              .then((updated) => {
                setNodes(updated.nodes);
                setTruncated(updated.truncated);
                closePanel();
              })
              .catch((cause: unknown) => {
                setActionError(errorMessage(cause, 'The material could not be added.'));
              })
              .finally(() => {
                setPending(false);
              });
          }}
        >
          <FieldRow>
            <Field>
              <label htmlFor="bom-component">Component</label>
              <select
                id="bom-component"
                required
                value={componentId}
                onChange={(event) => {
                  setComponentId(event.currentTarget.value);
                }}
              >
                <option value="">Choose a part</option>
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.itemCode} · {candidate.name}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => {
                  setCreatingPart(true);
                }}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                Create a part
              </Button>
            </Field>
            <Field>
              <label htmlFor="bom-quantity">Quantity per unit</label>
              <NumericInput
                id="bom-quantity"
                required
                pattern="[0-9]+(\.[0-9]{1,3})?"
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.currentTarget.value);
                }}
              />
            </Field>
          </FieldRow>
          <Actions>
            <Button type="submit" size="sm" disabled={pending}>
              Add material
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={closePanel}>
              Cancel
            </Button>
          </Actions>
        </form>
      )}

      {actionError !== null && <FormError>{actionError}</FormError>}

      {loadError !== null ? (
        <ErrorState onRetry={retry} retryLabel="Retry the bill of material">
          {loadError}
        </ErrorState>
      ) : nodes === null ? (
        <LoadingState label="the bill of material" rows={3} columns={2} />
      ) : nodes.length === 0 ? (
        <EmptyState>
          Nothing in this bill of material yet. Add the parts one unit is built from; a
          part that is itself manufactured brings its own bill with it.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {/* The cap is fine; a bill drawn half-way and presented as
              the whole bill is not. */}
          {truncated && (
            <p className="m-0 text-xs text-warning-foreground">
              This bill of material nests deeper than the limit, so the levels below are
              not shown here. Open a sub-assembly to read its own bill.
            </p>
          )}
          {nodes
            .filter((node) => node.parentLineId === null)
            .map((node) => (
              <BomRow
                key={node.lineId}
                node={node}
                nodes={nodes}
                canModify={canModify}
                onRemove={(lineId) => {
                  setActionError(null);
                  api
                    .removeProductionBomLine(organisationId, lineId)
                    .then((updated) => {
                      setNodes(updated.nodes);
                      setTruncated(updated.truncated);
                    })
                    .catch((cause: unknown) => {
                      setActionError(
                        errorMessage(cause, 'The material could not be removed.'),
                      );
                    });
                }}
              />
            ))}
        </div>
      )}
    </Card>
  );
}

/** One node and its subtree.
 *
 * The wire shape is flat with `parentLineId`, so the nesting is rebuilt
 * here; `docs/UX.md` § 11 records why the contract is not itself
 * recursive. Only the TOP-level rows carry a remove control, because
 * those are the only edges that belong to this item — a nested row is
 * part of the sub-assembly's own bill and is edited by opening it.
 */
function BomRow({
  node,
  nodes,
  canModify,
  onRemove,
}: {
  readonly node: BomNode;
  readonly nodes: readonly BomNode[];
  readonly canModify: boolean;
  readonly onRemove: (lineId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const children = nodes.filter((row) => row.parentLineId === node.lineId);
  /* `aria-expanded` on its own says a control expands something without
     saying what; `test/a11y-invariants` refuses the pair unsaid. */
  const subtreeId = `bom-subtree-${node.lineId}`;

  return (
    <div>
      <div
        className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border border-border p-3"
        style={{ marginLeft: node.depth * 20 }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={subtreeId}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : (
          <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="m-0 text-sm font-medium">{node.name}</p>
          <p className="m-0 text-xs text-muted-foreground">
            {/* The mock's `type`, derived rather than stored. */}
            {node.hasChildren ? 'sub-assembly' : 'raw'} ·{' '}
            <span className="font-mono tabular-nums">{node.itemCode}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 text-right">
          <div>
            <p className="m-0 font-mono text-sm tabular-nums">
              {node.quantity} {node.unit}
            </p>
            {node.depth > 0 && (
              <p className="m-0 font-mono text-xs tabular-nums text-muted-foreground">
                {node.effectiveQuantity} per finished unit
              </p>
            )}
            {node.serialControlled && (
              <Badge variant="outline" className="mt-1">
                Serial required
              </Badge>
            )}
          </div>
          {canModify && node.depth === 0 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${node.name} from the bill of material`}
              onClick={() => {
                onRemove(node.lineId);
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <div id={subtreeId}>
        {open &&
          children.map((child) => (
            <BomRow
              key={child.lineId}
              node={child}
              nodes={nodes}
              canModify={canModify}
              onRemove={onRemove}
            />
          ))}
      </div>
    </div>
  );
}
