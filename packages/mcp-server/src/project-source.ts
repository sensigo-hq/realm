// project-source.ts — #828 unit 2b: `projectSourceOf`, on @sensigo/realm-mcp's main entry, for a host
// that loads its own modules. Its work is `statedProjectSource` in code-hashes.ts, which holds the
// per-process map; that subpath's names stay untagged, so this module carries the release tag.
import type { ProjectSource } from '@sensigo/realm';
import { statedProjectSource } from './code-hashes.js';

/**
 * Where a module the host loads itself came from, for `ExtensionRegistry.register`'s `source`. It is
 * a `project` source stated by the host (`via: 'host_stated'`): its `declared` is the module's real
 * path, with the sha256 of its file and the dir_tree_v1 hash of its folder.
 *
 * @remarks
 * Synchronous. `module` is a path (a relative one resolves against the working directory), a `URL`
 * or a `file:` URL string; a symlink is followed to the real file. The hashes are taken at the
 * first call for that real path, from what this process already holds when a load read them, and
 * kept: later calls return the first result. Call it right after importing the module. A missing
 * file, a folder, an unreadable file or a URL that is not a `file:` one throws a `WorkflowError`
 * with the code `RESOURCE_FETCH_FAILED`, naming the path.
 * @beta
 */
export function projectSourceOf(module: string | URL): ProjectSource {
  return statedProjectSource(module);
}
