// lag.ts — issue #625 PR-2a, F1: the expiry line says how long before the call the question's time
// was up (`had expired 15s before this call`). A cell that drives a real clock cannot know that
// number, so it compares the line with `<lag>` in the number's place. A line with no lag — the form
// before F1, `had expired — …` — keeps its words and still differs from the expected line.

/** The lag as the one formatter (`formatDuration`) writes it, inside the expiry line's words. */
export const LAG = /had expired (?:\d+s|\d+m|\d+h \d+m|\d+d \d+h) before this call/g;

/** The text (or each line of a list) with every expiry line's lag written `<lag>`. */
export function lagless<T extends string | readonly string[]>(text: T): T {
  const one = (s: string) => s.replace(LAG, 'had expired <lag> before this call');
  return (typeof text === 'string' ? one(text) : text.map(one)) as T;
}
