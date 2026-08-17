import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { Modal } from './dialog.js';

/* The mock's `components/ui/sheet` at a8e1fde: a dialog that arrives from
 * an edge instead of the middle.
 *
 * It is the mock's skin over this build's own `Modal` (`ui/dialog.tsx`)
 * rather than a second implementation of the same thing. The mock gets
 * `role="dialog"`, the focus trap, Escape, backdrop dismissal and focus
 * restore from base-ui's Dialog; here that contract is already written,
 * already tested, and already the one exemption `eslint.config.js` grants
 * for a non-interactive element that listens for keys. A sheet that
 * re-implemented it would need a second exemption to say the same thing
 * twice, and `docs/UX.md` § Focus, keyboard and navigation is explicit
 * that "the mobile sheets are the same primitive and behave the same way".
 *
 * So this file owns only what makes a sheet a sheet: which edge it is
 * anchored to, how it is shaped against that edge, and the close control
 * the mock puts in its corner. */

/** Where the sheet is anchored, how the layer arranges it there, and how
 * the surface is shaped against that edge.
 *
 * A bottom sheet is the mobile one (`docs/DESIGN.md` § Mobile sheet): it
 * keeps the viewport's bottom inset clear of the home indicator, and caps
 * itself at 80dvh so the page it came from stays visible behind it. */
/* The layer classes stay in `place-items-*`, the same tailwind-merge group
 * as the `place-items-center` they are replacing. An `items-*` override
 * would land in a different group, leave the centring class in the string,
 * and let stylesheet order rather than the caller decide where the sheet
 * opens. The edge each surface is pushed to is then a plain auto margin. */
const SIDES = {
  bottom: {
    layer: 'place-items-end p-0',
    surface:
      'max-h-[80dvh] w-full max-w-none rounded-t-2xl rounded-b-none border-t pb-[calc(env(safe-area-inset-bottom)+1rem)]',
  },
  top: {
    layer: 'place-items-start p-0',
    surface: 'max-h-[80dvh] w-full max-w-none rounded-t-none rounded-b-2xl border-b',
  },
  left: {
    layer: 'place-items-stretch p-0',
    surface: 'mr-auto h-full w-3/4 rounded-none border-r sm:max-w-sm',
  },
  right: {
    layer: 'place-items-stretch p-0',
    surface: 'ml-auto h-full w-3/4 rounded-none border-l sm:max-w-sm',
  },
} as const;

export function Sheet({
  side = 'right',
  title,
  description,
  footer,
  onClose,
  className,
  children,
}: {
  readonly side?: keyof typeof SIDES;
  /** Names the dialog. Visible as its heading, and the accessible name. */
  readonly title: string;
  readonly description?: string;
  /** The actions that close or commit the sheet, pinned to its far edge. */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const seat = SIDES[side];

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      {...(description === undefined ? {} : { describedBy: descriptionId })}
      lockScroll
      overlayClassName={seat.layer}
      className={cn(
        'flex max-h-full flex-col gap-4 p-0 shadow-lg ring-0',
        seat.surface,
        className,
      )}
    >
      <div className="flex flex-col gap-0.5 p-4 pr-12">
        <h2 id={titleId} className="text-base font-medium text-foreground">
          {title}
        </h2>
        {description !== undefined && (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-3 right-3"
        onClick={onClose}
      >
        <X aria-hidden="true" />
        <span className="sr-only">Close</span>
      </Button>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">{children}</div>

      {footer !== undefined && (
        <div className="mt-auto flex flex-col gap-2 p-4">{footer}</div>
      )}
    </Modal>
  );
}
