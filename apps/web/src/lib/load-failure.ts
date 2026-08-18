import { RequestFailedError } from '../api.js';

/**
 * How a failed background read is described to the operator.
 *
 * Audit finding 27 made two points, and only the first had been acted on.
 * The first was that a failed read must never render as a legitimate empty
 * state — an empty register and an unreachable one are different facts,
 * and the operator has to be able to tell. The second, still open, was
 * that "you may not see this" and "this is temporarily unavailable" are
 * also different facts and were being collapsed into one another.
 *
 * They call for opposite responses. An outage is worth retrying, and the
 * data will come back. A refusal is not: retrying a 403 in a loop produces
 * nothing but audit noise, and offering the button implies the operator
 * did something wrong when the answer is that this is not theirs to see.
 */
export interface LoadFailure {
  /** The sentence to render. */
  readonly message: string;
  /** Whether a retry can plausibly succeed — false for a refusal. */
  readonly retryable: boolean;
}

/**
 * Classifies a rejected load.
 *
 * 403 is the tenancy and authority wall: the membership floor, the
 * work-scope filter, a missing document authority. Everything else — a
 * network failure, a 500, a 502 from an upstream, a database outage — is
 * treated as temporary, which is the safe way round: describing an outage
 * as a permission problem would send the operator to an administrator for
 * a problem no permission change can fix.
 *
 * `subject` names what failed to load, in sentence case, e.g.
 * "Measurement Books".
 */
export function describeLoadFailure(cause: unknown, subject: string): LoadFailure {
  if (cause instanceof RequestFailedError && cause.status === 403) {
    return {
      message: `${subject} are not available to you in this organisation.`,
      retryable: false,
    };
  }
  return {
    message: errorMessage(cause, `${subject} could not be loaded.`),
    retryable: true,
  };
}

/**
 * The sentence a failed ACTION renders, as opposed to a failed read.
 *
 * The server's own refusal is always the better sentence — it names the
 * rule that was broken — so it is preferred wherever there is one. The
 * fallback only covers what never reached the server, or came back as
 * something other than a refusal, and defaults to the wording the action
 * handlers had already converged on independently.
 */
export function errorMessage(
  cause: unknown,
  fallback = 'The action failed; nothing was changed.',
): string {
  return cause instanceof RequestFailedError ? cause.message : fallback;
}
