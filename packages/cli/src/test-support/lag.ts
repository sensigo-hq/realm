// lag.ts — issue #625 PR-2a, F1: the expiry line says how long before the call the question's time
// was up (`had expired 15s before this call`). A cell that drives a real clock cannot know that
// number, so it compares the line with `<lag>` in the number's place. A line with no lag — the form
// before F1, `had expired — …` — keeps its words and still differs from the expected line.
// #715 (b) (03 §B.3, D6-72 (c)): the lag now carries its deadline, `… before this call (deadline
// 2026-10-27T14:03:07Z)`; the instant is written `<instant>`, and a line WITHOUT its deadline is not
// normalised (it still differs from the expected line).

/** The lag as the one formatter writes it, inside the expiry line's words, with its deadline. */
export const LAG =
  /had expired (?:\d+s|\d+m|\d+h \d+m|\d+d \d+h) before this call \(deadline \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/g;

/** The text (or each line of a list) with every expiry line's lag written `<lag>`, its deadline `<instant>`. */
export function lagless<T extends string | readonly string[]>(text: T): T {
  const one = (s: string) =>
    s.replace(LAG, 'had expired <lag> before this call (deadline <instant>)');
  return (typeof text === 'string' ? one(text) : text.map(one)) as T;
}
