import { useCallback, useEffect, useState } from 'react';
import { Boxes, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type {
  BomNode,
  ProductionItem,
  ProductionSpecification,
} from '@auto-mb/contracts';
import { RequestFailedError, type ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardHeader } from '../ui/card.js';
import { Actions, Field, FieldRow, FormError, FormNotice } from '../ui/form.js';
import { PageHeader } from '../ui/page-header.js';
import { EmptyState, ErrorState, LoadingState } from '../ui/state.js';

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

export function ProductionItems({
  api,
  organisationId,
  canModify,
}: ProductionItemsProps) {
  const [items, setItems] = useState<readonly ProductionItem[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setLoadError(null);
    api
      .listProductionItems(organisationId)
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded.items);
        setActiveId((current) =>
          current !== null && loaded.items.some((item) => item.id === current)
            ? current
            : (loaded.items.find((item) => item.manufactured)?.id ??
              loaded.items[0]?.id ??
              null),
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The item master could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, loadVersion]);

  const reload = useCallback(() => {
    setLoadVersion((current) => current + 1);
  }, []);

  const [creating, setCreating] = useState(false);

  const header = (
    <PageHeader
      eyebrow="Production master"
      title="Manufactured items"
      titleId="production-items-title"
      description="Define OEM products, user-owned specifications, serial series, and recursive bills of material."
      action={
        canModify ? (
          <Button
            onClick={() => {
              setCreating((open) => !open);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add OEM item
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

  return (
    <>
      {header}
      {creating && (
        <ItemForm
          api={api}
          organisationId={organisationId}
          onSaved={(created) => {
            setCreating(false);
            setActiveId(created.id);
            reload();
          }}
          onCancel={() => {
            setCreating(false);
          }}
        />
      )}
      {items.length === 0 ? (
        <EmptyState>
          Nothing in the catalogue yet. Add the products the agency manufactures and the
          parts they are built from; a bill of material joins the two.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold">OEM catalogue</h2>
            </CardHeader>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {items.map((item) => (
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
                    {!item.manufactured && (
                      <Badge variant="outline" className="mt-2">
                        Component
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {active !== null && (
            <ItemDetail
              key={active.id}
              api={api}
              organisationId={organisationId}
              item={active}
              catalogue={items}
              canModify={canModify}
              onChanged={reload}
            />
          )}
        </div>
      )}
    </>
  );
}

/** The create form. Inline under the header rather than in a modal: the
 * mock's own "Add OEM item" opens nothing, so there is no dialog to
 * replicate, and a six-field form does not earn a focus trap. */
function ItemForm({
  api,
  organisationId,
  onSaved,
  onCancel,
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly onSaved: (item: ProductionItem) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <Card className="mb-4">
      <CardHeader>
        <h2 className="text-base font-semibold">New OEM item</h2>
      </CardHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setPending(true);
          api
            .saveProductionItem(organisationId, null, {
              itemCode: draft.itemCode,
              name: draft.name,
              category: draft.category,
              unit: draft.unit,
              manufactured: draft.manufactured,
              ...(draft.manufactured
                ? { serialPrefix: draft.serialPrefix.toUpperCase() }
                : {}),
              serialControlled: draft.manufactured || draft.serialControlled,
            })
            .then(onSaved)
            .catch((cause: unknown) => {
              setError(
                cause instanceof RequestFailedError
                  ? cause.message
                  : 'The item could not be saved.',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <FieldRow>
          <Field>
            <label htmlFor="production-item-code">Part number</label>
            <input
              id="production-item-code"
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
            <label htmlFor="production-item-name">Name</label>
            <input
              id="production-item-name"
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
            <label htmlFor="production-item-category">Category</label>
            <input
              id="production-item-category"
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
            <label htmlFor="production-item-unit">Unit</label>
            <input
              id="production-item-unit"
              required
              maxLength={20}
              value={draft.unit}
              onChange={(event) => {
                set('unit', event.currentTarget.value);
              }}
            />
          </Field>
        </FieldRow>
        <Field>
          <label
            className="flex items-center gap-2 font-normal!"
            htmlFor="production-item-manufactured"
          >
            <input
              id="production-item-manufactured"
              type="checkbox"
              checked={draft.manufactured}
              onChange={(event) => {
                set('manufactured', event.currentTarget.checked);
              }}
            />
            The agency manufactures this. A job card may be raised for it, and every
            unit it produces is named from a serial series.
          </label>
        </Field>
        {draft.manufactured ? (
          <Field>
            <label htmlFor="production-item-prefix">Serial series</label>
            <input
              id="production-item-prefix"
              required
              pattern="[A-Za-z0-9][A-Za-z0-9-]{1,15}"
              maxLength={16}
              placeholder="IPDB6"
              value={draft.serialPrefix}
              onChange={(event) => {
                set('serialPrefix', event.currentTarget.value);
              }}
            />
            <p className="m-0 text-xs text-muted-foreground">
              Units are named{' '}
              <span className="font-mono tabular-nums">
                {(draft.serialPrefix || 'PREFIX').toUpperCase()}-00001
              </span>
              . It cannot be changed once the first unit is built.
            </p>
          </Field>
        ) : (
          <Field>
            <label
              className="flex items-center gap-2 font-normal!"
              htmlFor="production-item-serial-controlled"
            >
              <input
                id="production-item-serial-controlled"
                type="checkbox"
                checked={draft.serialControlled}
                onChange={(event) => {
                  set('serialControlled', event.currentTarget.checked);
                }}
              />
              Capture this part&apos;s serials when it is consumed into a unit.
            </label>
          </Field>
        )}
        {error !== null && <FormError>{error}</FormError>}
        <Actions>
          <Button type="submit" disabled={pending}>
            Add item
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
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly item: ProductionItem;
  readonly catalogue: readonly ProductionItem[];
  readonly canModify: boolean;
  readonly onChanged: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <p className="section-label m-0">OEM item</p>
            <h2 className="mt-1 text-xl font-semibold">{item.name}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge variant="neutral">{item.category}</Badge>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {item.itemCode} · {item.unit}
              </span>
            </div>
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

      <SpecificationsCard
        api={api}
        organisationId={organisationId}
        item={item}
        canModify={canModify}
        onSaved={onChanged}
      />

      {item.manufactured && (
        <BillOfMaterialCard
          api={api}
          organisationId={organisationId}
          item={item}
          catalogue={catalogue}
          canModify={canModify}
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
                    cause instanceof RequestFailedError
                      ? cause.message
                      : 'The specifications could not be saved.',
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
}: {
  readonly api: ApiClient;
  readonly organisationId: string;
  readonly item: ProductionItem;
  readonly catalogue: readonly ProductionItem[];
  readonly canModify: boolean;
}) {
  const [nodes, setNodes] = useState<readonly BomNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [componentId, setComponentId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [pending, setPending] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setNodes(null);
    setLoadError(null);
    api
      .getProductionBom(organisationId, item.id)
      .then((loaded) => {
        if (cancelled) return;
        setNodes(loaded.nodes);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(
          cause instanceof RequestFailedError
            ? cause.message
            : 'The bill of material could not be loaded.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [api, organisationId, item.id, loadVersion]);

  /* Every item except this one is a candidate. The database refuses a
     cycle and a retired part regardless (migration 0084 § 2); the select
     only spares the operator the two refusals it can see coming. */
  const candidates = catalogue.filter((candidate) => candidate.id !== item.id);

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
              setAdding((open) => !open);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Material
          </Button>
        )}
      </CardHeader>

      {adding && canModify && (
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
                setAdding(false);
                setComponentId('');
                setQuantity('1');
              })
              .catch((cause: unknown) => {
                setActionError(
                  cause instanceof RequestFailedError
                    ? cause.message
                    : 'The material could not be added.',
                );
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
            </Field>
            <Field>
              <label htmlFor="bom-quantity">Quantity per unit</label>
              <input
                id="bom-quantity"
                required
                inputMode="decimal"
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </Actions>
        </form>
      )}

      {actionError !== null && <FormError>{actionError}</FormError>}

      {loadError !== null ? (
        <ErrorState
          onRetry={() => {
            setLoadVersion((current) => current + 1);
          }}
          retryLabel="Retry the bill of material"
        >
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
                    })
                    .catch((cause: unknown) => {
                      setActionError(
                        cause instanceof RequestFailedError
                          ? cause.message
                          : 'The material could not be removed.',
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
