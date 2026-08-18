import { cn } from '../lib/cn.js';

/**
 * The mock's boxed tab list: a `--muted` tray of pill toggles that swap
 * one panel in place.
 *
 * `aria-pressed` toggles inside a `role="group"` rather than a
 * `role="tablist"`, for the reason `docs/UX.md` § 9 gives for the
 * inspection agency pills — these filter one panel in place, and
 * `test/a11y-invariants` refuses a tablist without the roving-tabindex
 * pattern to match.
 *
 * The horizontal scrollport and `shrink-0` are not decoration. Four tabs
 * with real labels are wider than a 375px phone, and without them the
 * tray either clips its last tab or squeezes every label until the words
 * wrap inside 32px pills. The Correspondence register discovered this
 * first; Production and Maintenance carried copies of the rail WITHOUT
 * the fix, which is what made a third copy the moment to extract one.
 */
export function TabRail<Key extends string>({
  label,
  tabs,
  active,
  onSelect,
}: {
  /** Names the group for a screen reader: "Job card sections". */
  readonly label: string;
  readonly tabs: readonly (readonly [Key, string])[];
  readonly active: Key;
  readonly onSelect: (key: Key) => void;
}) {
  return (
    <div className="overflow-x-auto pb-1">
      <div
        className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
        role="group"
        aria-label={label}
      >
        {tabs.map(([key, text]) => (
          <button
            key={key}
            type="button"
            aria-pressed={active === key}
            className={cn(
              'h-8 shrink-0 rounded-md px-3 text-sm font-medium transition-colors',
              active === key
                ? 'bg-card text-foreground shadow-[0_1px_2px_0_rgb(15_23_42/0.05)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => {
              onSelect(key);
            }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
