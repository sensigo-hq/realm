// inspect-line.ts — R1.3 C2: the one `Callback:` line `realm run inspect` prints for a run that has a
// callback row, from the row's view only (which carries no address, webhook id, body or token) and
// the run's own phase, at the inspect's reading:
//   pending, the run not finished      `Callback: waiting for the run to finish`
//   pending, finished, not yet due     `Callback: pending, attempt <n>[, last answer <s>], next try <W>`
//   pending, finished, due, no try     `Callback: due since <W>; it waits for the next pass of a
//                                       realm listen that can send it` (C3d-B)
//   pending, finished, due, after tries `Callback: due since <W>, attempt <n>[, last answer <s>]; it
//                                       waits for the next pass of a realm listen that can send it`
//   delivered                          `Callback: delivered to <host> <W>, attempt <n>`
//   failed, its window ended (C3b1)    `Callback: expired at attempt <n>, not delivered within its
//                                       time limit`; with no try made (C3d-B): `Callback: expired
//                                       before its first try, not delivered within its time limit`
//   failed otherwise                   `Callback: failed after <n> attempt(s), last answer <s>`
// `<W>` is the one instant formatter's (`in 5m (…)`, `5m ago (…)`); a part whose field is absent, or
// whose instant does not parse, is left out.
import {
  formatInstantWords,
  isPastDeadline,
  type CallbackView,
  type RunStore,
} from '@sensigo/realm';

/** The run's callback view, or `undefined` for no row, a store without the port, or a read that throws. */
export async function readCallbackView(
  store: RunStore,
  runId: string,
): Promise<CallbackView | undefined> {
  const callbacks = store.callbacks;
  if (callbacks === undefined || callbacks === null) return undefined;
  try {
    return await callbacks.read(runId);
  } catch {
    return undefined;
  }
}

/** The `Callback:` line of a run's view (see the module comment). */
export function callbackLine(view: CallbackView, runFinished: boolean, at: Date): string {
  const words = (stamp: string | undefined, cls: 'past_event' | 'deadline'): string =>
    stamp === undefined ? '' : (formatInstantWords(stamp, cls, at) ?? '');
  const answer = view.last_status !== undefined ? `, last answer ${String(view.last_status)}` : '';
  if (view.status === 'delivered') {
    const when = words(view.last_attempt_at, 'past_event');
    return `Callback: delivered to ${view.host}${when === '' ? '' : ` ${when}`}, attempt ${view.attempts}`;
  }
  if (view.status === 'failed') {
    if (view.last_status === 'expired') {
      return view.attempts >= 1
        ? `Callback: expired at attempt ${view.attempts}, not delivered within its time limit`
        : 'Callback: expired before its first try, not delivered within its time limit';
    }
    const attempts = view.attempts === 1 ? 'attempt' : 'attempts';
    return `Callback: failed after ${view.attempts} ${attempts}${answer}`;
  }
  if (!runFinished) return 'Callback: waiting for the run to finish';
  if (isPastDeadline(view.next_attempt_at, at)) {
    const since = words(view.next_attempt_at, 'past_event');
    const tried = view.attempts >= 1 ? `, attempt ${view.attempts}${answer}` : '';
    return `Callback: due${since === '' ? '' : ` since ${since}`}${tried}; it waits for the next pass of a realm listen that can send it`;
  }
  const attempt = view.attempts >= 1 ? `, attempt ${view.attempts}` : '';
  const next = words(view.next_attempt_at, 'deadline');
  return `Callback: pending${attempt}${answer}${next === '' ? '' : `, next try ${next}`}`;
}
