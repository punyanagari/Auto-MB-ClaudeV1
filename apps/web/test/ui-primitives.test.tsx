// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/ui/button.js';
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
