// issue #620 PR-C — keeping a declaration true. Every store realm runs against declares a release
// line (realm's own classes through PR-B's mark, a host's class through `declareReleaseLine`). A
// declaration is only worth something if it is true: the store's errors must come from the realm
// whose line it declares, or realm will misread them by class. This law checks it from the store's
// own refusal.
import { releaseLineOf } from '@sensigo/realm';

/**
 * STORE_RELEASE_LINE_TRUE, standalone: `provokeRefusal` must reject with an error the store itself
 * minted; the store's declared release line and that error's line must have the same generation.
 * Throws (rejects) on failure.
 */
export async function storeReleaseLineLaw(
  store: object,
  provokeRefusal: () => Promise<unknown>,
): Promise<void> {
  const storeLine = releaseLineOf(store);
  if (storeLine === undefined) {
    throw new Error(
      'STORE_RELEASE_LINE_TRUE: the store declares no realm release line (declareReleaseLine)',
    );
  }
  let refusal: unknown;
  let refused = false;
  try {
    await provokeRefusal();
  } catch (err) {
    refused = true;
    refusal = err;
  }
  if (!refused) {
    throw new Error(
      'STORE_RELEASE_LINE_TRUE: the provoked call resolved; expected the store to refuse',
    );
  }
  const errorLine = releaseLineOf(refusal);
  if (errorLine === undefined) {
    throw new Error(
      `STORE_RELEASE_LINE_TRUE: the store declares realm ${storeLine.version}, but its refusal ` +
        'carries no realm release line — it is not a realm error',
    );
  }
  if (errorLine.generation !== storeLine.generation) {
    throw new Error(
      `STORE_RELEASE_LINE_TRUE: the store declares realm ${storeLine.version}, but its refusal is ` +
        `an error from realm ${errorLine.version} — the declaration is false`,
    );
  }
}
