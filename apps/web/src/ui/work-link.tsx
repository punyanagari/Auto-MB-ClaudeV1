import { navigateOnClick, workHash } from '../lib/workspace-routes.js';
import type { WorkTab } from '../views/WorkDetail.js';

/**
 * A cross-Work register's identity cell: the Work code as a real link,
 * with the Work's title beneath it.
 *
 * Every register that reads across Works has to answer "which contract is
 * this row" in one column, and the answer is always the same two lines —
 * the code, which is what an operator recognises, and the title, which is
 * what they confirm it by. A real `href` so the row can be middle-clicked
 * into its own tab; a plain left click stays in-app through the shell's
 * navigation, which is what keeps the dirty-editor guard applying.
 *
 * `tab` names the section of the Work the row actually lives on, because
 * landing on Overview from a register row means finding the record again.
 */
export function WorkLink({
  workId,
  workCode,
  workTitle,
  tab,
  onOpenWork,
}: {
  readonly workId: string;
  readonly workCode: string;
  readonly workTitle: string;
  readonly tab?: WorkTab;
  readonly onOpenWork: (workId: string) => void;
}) {
  return (
    <>
      <a
        href={workHash(workId, tab)}
        className="font-medium text-primary underline-offset-4 hover:underline"
        onClick={navigateOnClick(() => {
          onOpenWork(workId);
        })}
      >
        {workCode}
      </a>
      <span className="block text-xs text-muted-foreground">{workTitle}</span>
    </>
  );
}
