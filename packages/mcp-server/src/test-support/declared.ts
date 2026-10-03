// issue #620 PR-C — test support: a test double (a plain object, a mock, a cast) declares this realm's
// release line, as every store realm runs against must. Returns its argument, so a factory or a literal
// is wrapped in one place: `return declared({ get, update } as unknown as RunStore)`.
import { declareReleaseLine } from '@sensigo/realm';

export function declared<T extends object>(double: T): T {
  declareReleaseLine(double);
  return double;
}
