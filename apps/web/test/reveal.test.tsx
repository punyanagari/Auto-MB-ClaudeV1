// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReveal } from '../src/lib/view-state.js';

/*
 * The spatial half of a success message (`docs/UX.md` § Reveal the
 * result). The toast says the save worked; this says WHICH row it wrote,
 * by scrolling it into view and flashing it.
 *
 * Everything here is behaviour a caller depends on and cannot see: that a
 * row revealed before its list has reloaded is still reached when the row
 * finally mounts, that revealing the same row twice is two reveals rather
 * than one, that the highlight takes itself off again, and that the
 * scroll asks for no animation from a viewer who has asked for none.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** jsdom has no layout, so it has no `scrollIntoView` at all. */
function stubScrolling(): ReturnType<typeof vi.fn> {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

/** A register whose rows arrive after the reveal is asked for, the way a
 * real one does: the mutation resolves, then the list reloads. */
function Register({ rows }: { readonly rows: readonly string[] }) {
  const { reveal, revealProps } = useReveal();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          reveal('b');
        }}
      >
        Save b
      </button>
      <ul>
        {rows.map((row) => (
          <li key={row} data-testid={row} {...revealProps(row)}>
            {row}
          </li>
        ))}
      </ul>
    </>
  );
}

describe('useReveal', () => {
  it('scrolls and flashes only the row it was given', () => {
    const scrollIntoView = stubScrolling();
    stubReducedMotion(false);
    render(<Register rows={['a', 'b', 'c']} />);

    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'smooth',
    });
    expect(screen.getByTestId('b').hasAttribute('data-revealed')).toBe(true);
    expect(screen.getByTestId('a').hasAttribute('data-revealed')).toBe(false);
    expect(screen.getByTestId('c').hasAttribute('data-revealed')).toBe(false);
  });

  it('reaches a row that only arrives with the reload after the save', () => {
    const scrollIntoView = stubScrolling();
    stubReducedMotion(false);
    /* The create case: the row does not exist when the mutation resolves.
       A query at reveal time would find nothing; the ref does not fire
       until the reload mounts it. */
    const { rerender } = render(<Register rows={['a']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<Register rows={['a', 'b']} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b').hasAttribute('data-revealed')).toBe(true);
  });

  it('takes the highlight off again when the animation ends', () => {
    stubScrolling();
    stubReducedMotion(false);
    render(<Register rows={['b']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));

    const row = screen.getByTestId('b');
    expect(row.hasAttribute('data-revealed')).toBe(true);
    fireEvent.animationEnd(row);
    expect(row.hasAttribute('data-revealed')).toBe(false);
  });

  it('reveals the same row a second time, so a second edit is not silent', () => {
    const scrollIntoView = stubScrolling();
    stubReducedMotion(false);
    render(<Register rows={['b']} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));
    fireEvent.animationEnd(screen.getByTestId('b'));
    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('b').hasAttribute('data-revealed')).toBe(true);
  });

  it('asks for no scroll animation when the viewer has asked for less motion', () => {
    const scrollIntoView = stubScrolling();
    /* The CSS `scroll-behavior: auto !important` in globals.css does not
       reach an explicit `behavior` argument, so the query is read here. */
    stubReducedMotion(true);
    render(<Register rows={['b']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save b' }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'auto',
    });
  });
});
