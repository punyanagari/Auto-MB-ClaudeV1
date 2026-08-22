import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * A typeable picker over a list too long to read.
 *
 * WHY THIS EXISTS. A native `<select>` over the Works register opens a
 * list of every contract at the browser's own type scale, each row the
 * whole title — "Signalling and telecommunication works including supply,
 * installation, testing and commissioning at …" — and the operator scrolls
 * a wall of near-identical sentences looking for one code. That is what
 * live testing reported on the Reports picker, and the same `<select>` is
 * on every screen that asks which Work something belongs to.
 *
 * So the list is FILTERED BY TYPING and the row is COMPACT: the identifier
 * first, in mono, then as much of the name as the row fits and an ellipsis
 * where it stops. The identifier is what an operator knows and what the
 * paperwork carries; the name is there to confirm the choice, not to be
 * read end to end.
 *
 * WHAT IT IS NOT. Not a dependency, and not a `role="menu"`. It is the
 * ARIA combobox with a listbox popup, spelled out: the input keeps focus
 * throughout and the active option is named by `aria-activedescendant`, so
 * nothing has to be re-parented and no focus is ever stolen. Up/Down move,
 * Home/End jump, Enter takes, Escape closes.
 *
 * FORM SEMANTICS SURVIVE. `name` emits a hidden input carrying the VALUE,
 * so a `FormData` read of a converted form is byte-identical to what the
 * `<select>` produced (`api.ts` `formValue`). `required` rides the visible
 * input, which is empty exactly when nothing is chosen: the text reverts
 * to the selected label whenever the popup closes, and Enter inside an
 * open popup never reaches the form. Half-typed text is therefore never a
 * submission.
 */
export interface ComboboxOption {
  /** What the form and the caller get. */
  readonly value: string;
  /** The name, shown after the code and clipped to the row. */
  readonly label: string;
  /** The identifier — a Work code — shown first, in mono. Searched with
   * the label, so "SIG-2026" and "Alpha yard" both find the same row. */
  readonly code?: string;
}

interface ComboboxProps {
  /** The `<label htmlFor>` target. Required: this control has no name of
   * its own, exactly as a `<select>` has none. */
  readonly id: string;
  readonly options: readonly ComboboxOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Shown when nothing is chosen. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Emits a hidden input of this name carrying `value`, for forms read
   * through `FormData`. */
  readonly name?: string;
  readonly required?: boolean;
  /** Ids of the hint or error text describing this control. */
  readonly describedBy?: string;
  /** What to say when the typed text matches nothing. */
  readonly noMatchLabel?: string;
}

/** Case-insensitive substring over the code AND the label, so an operator
 * finds a row by whichever of the two they happen to remember. */
function matches(option: ComboboxOption, query: string): boolean {
  const hay = `${option.code ?? ''} ${option.label}`.toLowerCase();
  return hay.includes(query.toLowerCase());
}

export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  name,
  required = false,
  describedBy,
  noMatchLabel = 'Nothing matches that.',
}: ComboboxProps) {
  const listId = useId();
  const optionId = (index: number): string => `${listId}-option-${String(index)}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const selectedText =
    selected === null
      ? ''
      : selected.code === undefined
        ? selected.label
        : `${selected.code} — ${selected.label}`;

  /* An empty query is not a filter. Opening the popup with nothing typed
     shows the whole list, which is the `<select>` behaviour this replaces
     and the only way to browse a short one. */
  const shown = useMemo(
    () => (query === '' ? options : options.filter((option) => matches(option, query))),
    [options, query],
  );

  const activeIndex = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

  /* Keyboard movement has to be visible movement. `nearest` is what keeps
     a long list from jumping when the active row is already on screen. */
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const row = listRef.current?.children[activeIndex];
    // jsdom implements no layout and therefore no scrollIntoView.
    (row as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);

  /** Opens on the whole list, with the chosen row already active so Enter
   * on a freshly opened popup re-takes what is already there. */
  function openList(): void {
    setQuery('');
    setOpen(true);
    const at = options.findIndex((option) => option.value === value);
    setActive(at === -1 ? 0 : at);
  }

  function take(option: ComboboxOption): void {
    onChange(option.value);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.max(0, Math.min(shown.length - 1, activeIndex + step)));
      return;
    }
    if (!open) return;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : shown.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      /* Always swallowed while the popup is open, whether or not there is
         a row to take: an Enter meant for the list must never reach the
         form and submit the half-typed text behind it. */
      event.preventDefault();
      const option = shown[activeIndex];
      if (option === undefined) setOpen(false);
      else take(option);
      return;
    }
    if (event.key === 'Escape') {
      // Swallowed so a combobox inside a dialog closes the popup rather
      // than the dialog around it.
      event.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        // aria-controls names the popup on every render, open or shut,
        // which is why the list below is `hidden` rather than unmounted.
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(open && activeIndex >= 0
          ? { 'aria-activedescendant': optionId(activeIndex) }
          : {})}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
        autoComplete="off"
        disabled={disabled}
        required={required}
        value={open ? query : selectedText}
        placeholder={placeholder}
        className="w-full pr-8"
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          if (!disabled) openList();
        }}
        onBlur={() => {
          setOpen(false);
          setQuery('');
        }}
        onKeyDown={onKeyDown}
      />
      <ChevronsUpDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      {name !== undefined && <input type="hidden" name={name} value={value} />}

      {/* A `div` rather than a `ul`, and that is the lint rule's choice
          rather than a preference: a list with `role="listbox"` is a
          non-interactive element wearing an interactive role
          (`jsx-a11y/no-noninteractive-element-to-interactive-role`), and
          the listbox pattern replaces the list semantics anyway. */}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        hidden={!open || shown.length === 0}
        className="absolute top-[calc(100%+0.25rem)] right-0 left-0 z-40 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        {shown.map((option, index) => (
          <div
            key={option.value}
            id={optionId(index)}
            role="option"
            /* -1, never 0: the input keeps focus and `aria-activedescendant`
               above names the active row, which is the whole reason this
               pattern needs no focus management. The attribute is here so
               the row is FOCUSABLE — `jsx-a11y/interactive-supports-focus`
               requires an interactive role to be — not so it is reached by
               Tab, which would put one tab stop per Work in the way. */
            tabIndex={-1}
            aria-selected={option.value === value}
            /* The row is 13px and one line tall, because the list is here
               to be scanned. `truncate` is the ellipsis: the name takes
               the width the row has and stops. */
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] leading-tight',
              index === activeIndex && 'bg-accent text-accent-foreground',
            )}
            // Selection must beat the blur that a mousedown would otherwise
            // fire first, which would close the popup under the pointer.
            onMouseDown={(event) => {
              event.preventDefault();
              take(option);
            }}
            onMouseEnter={() => {
              setActive(index);
            }}
          >
            {option.code !== undefined && (
              <span className="shrink-0 font-mono text-xs tabular-nums">
                {option.code}
              </span>
            )}
            <span className="truncate">{option.label}</span>
          </div>
        ))}
      </div>

      {open && shown.length === 0 && (
        <p
          role="status"
          className="absolute top-[calc(100%+0.25rem)] right-0 left-0 z-40 m-0 rounded-lg border border-border bg-popover px-2 py-1.5 text-[13px] text-muted-foreground shadow-md"
        >
          {noMatchLabel}
        </p>
      )}
    </div>
  );
}
