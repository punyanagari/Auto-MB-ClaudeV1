// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/ui/button.js';
import { Combobox } from '../src/ui/combobox.js';
import { PageHeader } from '../src/ui/page-header.js';
import { Separator } from '../src/ui/separator.js';
import { Sheet } from '../src/ui/sheet.js';
import { Stat } from '../src/ui/stat.js';
import { Tooltip } from '../src/ui/tooltip.js';

/*
 * The primitives the P2 pack added, tested for the contracts a consumer
 * relies on rather than for their class strings. A class string is what
 * the dual-theme axe suite and the mock diff already police; what a test
 * can hold is the behaviour that is hand-written here because base-ui is
 * not in this stack — the bubble that has to appear on focus and not only
 * on hover, the sheet that has to be a real dialog, the size ladder that
 * the shell now depends on instead of patching heights by hand.
 */

afterEach(cleanup);

describe('the button ladder', () => {
  it('gives every named size a height, so a caller never patches one on', () => {
    const heights: Record<string, string> = {
      xs: 'h-6',
      sm: 'h-7',
      default: 'h-8',
      lg: 'h-9',
      icon: 'size-8',
      'icon-xs': 'size-6',
      'icon-sm': 'size-7',
      'icon-lg': 'size-9',
    };
    for (const [size, expected] of Object.entries(heights)) {
      const { unmount } = render(
        <Button size={size as 'default'}>{`press ${size}`}</Button>,
      );
      expect(screen.getByRole('button').className).toContain(expected);
      unmount();
    }
  });

  it('reserves the asymmetric inset for an icon that says which edge it is on', () => {
    render(
      <Button>
        <svg data-icon="inline-start" />
        Upload LOA
      </Button>,
    );
    /* The padding is a `has-` selector on the button, so what the test can
     * assert is that both halves of the pair are present: the button
     * carries the rule and the icon carries the attribute it keys on. */
    const button = screen.getByRole('button');
    expect(button.className).toContain('has-data-[icon=inline-start]:pl-2');
    expect(button.querySelector('[data-icon="inline-start"]')).not.toBeNull();
  });
});

describe('Separator', () => {
  it('announces itself and its orientation when it means something', () => {
    render(<Separator orientation="vertical" />);
    const rule = screen.getByRole('separator');
    expect(rule.getAttribute('aria-orientation')).toBe('vertical');
    expect(rule.hasAttribute('data-vertical')).toBe(true);
  });

  it('stays out of the accessibility tree when it is only a line', () => {
    render(<Separator decorative />);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

describe('Tooltip', () => {
  it('shows the label on focus, not only on hover', () => {
    render(
      <Tooltip content="Approvals" side="right">
        <button type="button">Approvals</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();

    fireEvent.focusIn(screen.getByRole('button'));
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain(
      'Approvals',
    );

    fireEvent.focusOut(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('hides the bubble from a screen reader, which already has the name', () => {
    render(
      <Tooltip content="Upload LOA">
        <button type="button" aria-label="Upload LOA" />
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByRole('button').parentElement as HTMLElement);
    expect(
      screen.getByRole('tooltip', { hidden: true }).getAttribute('aria-hidden'),
    ).toBe('true');
    /* Named once. A bubble in the tree would make it twice. */
    expect(screen.getAllByLabelText('Upload LOA')).toHaveLength(1);
  });

  it('dismisses on Escape rather than sitting over the page', () => {
    render(
      <Tooltip content="Approvals">
        <button type="button">Approvals</button>
      </Tooltip>,
    );
    fireEvent.focusIn(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });
});

describe('Sheet', () => {
  it('is a modal dialog named by its own heading', () => {
    render(
      <Sheet side="bottom" title="Record" onClose={vi.fn()}>
        <p>Body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByRole('heading', { name: 'Record' })).toBeTruthy();
  });

  it('closes from Escape and from its own close control', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Sheet title="Record" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('anchors to the edge it was asked for instead of the middle', () => {
    render(
      <Sheet side="bottom" title="Record" onClose={vi.fn()}>
        <p>Body</p>
      </Sheet>,
    );
    /* The layer must not keep `place-items-center` from `Modal`, or the
     * sheet opens as a centred dialog wearing a sheet's corners. */
    const layer = screen.getByRole('dialog').parentElement as HTMLElement;
    expect(layer.className).toContain('place-items-end');
    expect(layer.className).not.toContain('place-items-center');
  });
});

describe('PageHeader', () => {
  it('leaves the heading addressable, so navigation can still move focus to it', () => {
    render(
      <PageHeader
        eyebrow="Operations"
        title="Delivery challans"
        titleId="challans-title"
        description="Every challan issued against this Work."
        action={<Button>New challan</Button>}
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Delivery challans' });
    expect(heading.id).toBe('challans-title');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByText('Operations').className).toContain('section-label');
    expect(screen.getByRole('button', { name: 'New challan' })).toBeTruthy();
  });
});

describe('Stat', () => {
  it('renders the figure through the shared metric class', () => {
    render(<Stat label="Delivered" value="1,284" hint="of 1,400 supplied" />);
    expect(screen.getByText('Delivered').className).toContain('section-label');
    expect(screen.getByText('1,284').className).toContain('metric-value');
    expect(screen.getByText('of 1,400 supplied')).toBeTruthy();
  });

  it('carries a tone as emphasis without it being the only signal', () => {
    render(<Stat label="Overdue" value="3" hint="past due date" tone="warning" />);
    expect(screen.getByText('3').className).toContain('text-warning-foreground');
    /* The words still say it. Colour is never the whole message. */
    expect(screen.getByText('past due date')).toBeTruthy();
  });
});

/*
 * The searchable picker (§ 38, owner ruling of 2026-08-22).
 *
 * What is tested here is the contract a caller relies on and a `<select>`
 * used to give for free: the list narrows to what was typed, the keyboard
 * moves and takes, and the value a form reads is the option's value and
 * never the text in the box. Every one of those is hand-written, because
 * base-ui is not in this stack.
 */
function Picker({
  onChange = () => undefined,
  ...rest
}: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  return (
    <>
      <label htmlFor="pick">Work</label>
      <Combobox
        id="pick"
        value={rest.value ?? ''}
        onChange={onChange}
        options={[
          { value: 'a', code: 'SIG-2026-11', label: 'Signalling at Alpha yard' },
          { value: 'b', code: 'SIG-2026-14', label: 'Signalling at Beta yard' },
          { value: 'c', code: 'TEL-2026-03', label: 'Telecom at Alpha yard' },
        ]}
        {...rest}
      />
    </>
  );
}

function pickerInput(): HTMLInputElement {
  return screen.getByRole('combobox', { name: 'Work' });
}

describe('Combobox', () => {
  it('is a combobox with a listbox it names, and the list is shut until asked', () => {
    render(<Picker />);
    const input = pickerInput();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    // aria-controls resolves whether or not the popup is showing, which is
    // why the list is `hidden` rather than unmounted.
    const listId = input.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    expect(document.getElementById(listId ?? '')).not.toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('opens on focus and offers every option', () => {
    render(<Picker />);
    fireEvent.focus(pickerInput());
    expect(pickerInput().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('narrows on the code AND on the title, because an operator remembers either', () => {
    render(<Picker />);
    const input = pickerInput();
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: 'tel' } });
    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual([
      'TEL-2026-03Telecom at Alpha yard',
    ]);

    fireEvent.change(input, { target: { value: 'beta' } });
    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual([
      'SIG-2026-14Signalling at Beta yard',
    ]);
  });

  it('says so when nothing matches, rather than showing an empty box', () => {
    render(<Picker />);
    const input = pickerInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Nothing matches');
  });

  it('moves with the arrows and takes with Enter, naming the active row', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const input = pickerInput();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const first = screen.getAllByRole('option')[0];
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[1]?.id,
    );
    fireEvent.keyDown(input, { key: 'End' });
    expect(input.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[2]?.id,
    );
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('takes a clicked row, and shows the chosen one when shut', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Picker onChange={onChange} />);
    fireEvent.focus(pickerInput());
    // mousedown, not click: the pointer press is what would otherwise blur
    // the input and close the popup out from under the pointer.
    fireEvent.mouseDown(screen.getAllByRole('option')[2] as HTMLElement);
    expect(onChange).toHaveBeenCalledWith('c');

    rerender(<Picker onChange={onChange} value="c" />);
    expect(pickerInput().value).toBe('TEL-2026-03 — Telecom at Alpha yard');
  });

  it('closes on Escape and keeps the value it had', () => {
    const onChange = vi.fn();
    render(<Picker onChange={onChange} value="b" />);
    const input = pickerInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'tel' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('SIG-2026-14 — Signalling at Beta yard');
  });

  it('gives a form the VALUE, never the text in the box', () => {
    render(
      <form aria-label="Job card">
        <Picker name="workId" value="b" />
      </form>,
    );
    const form = screen.getByRole<HTMLFormElement>('form', { name: 'Job card' });
    expect(new FormData(form).get('workId')).toBe('b');

    // Half-typed text is not a submission: the box reverts to the chosen
    // row the moment the popup closes, and Enter inside an open popup is
    // swallowed rather than reaching the form.
    const input = pickerInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nonsense' } });
    fireEvent.focusOut(input);
    expect(input.value).toBe('SIG-2026-14 — Signalling at Beta yard');
    expect(new FormData(form).get('workId')).toBe('b');
  });

  it('is empty, and therefore refusable by `required`, when nothing is chosen', () => {
    render(<Picker required value="" />);
    const input = pickerInput();
    expect(input.required).toBe(true);
    expect(input.value).toBe('');
    expect(input.checkValidity()).toBe(false);
  });

  it('prints the code in mono and lets the title clip rather than wrap', () => {
    render(<Picker />);
    fireEvent.focus(pickerInput());
    const row = screen.getAllByRole('option')[0] as HTMLElement;
    expect(row.querySelector('.font-mono')?.textContent).toBe('SIG-2026-11');
    expect(row.querySelector('.truncate')?.textContent).toBe(
      'Signalling at Alpha yard',
    );
  });
});
