// code-source.ts — where a registered handler's, adapter's or processor's code came from (#828 unit 2b).
//
// Every `ExtensionRegistry` entry carries one. Realm reads the built-in and host sources itself: its
// own built-ins are `built_in`, and a host's object registered with no stated source is
// `host_registered` with the fingerprint of its code (`codeTextOf`). A `project` or `catalog` source
// is stated by the code that loads it (the CLI's loader, or a host through `projectSourceOf`) and is
// recorded as given once its shape holds: code in the same process can state any well-formed one.
// Pure data shapes; nothing here reads a file.

/**
 * Where a project's module came from: how it was declared, and the hashes of its file and its
 * folder, or a typed absence when they could not be read.
 *
 * @remarks
 * `declared` is exactly what the run's identity entry holds in `modules[].declared`: the
 * `extensions:` entry, the `--extensions-module` path, or the manifest's whole `use:` text; for
 * `projectSourceOf`, the module's real path. `via` says which: `manifest`, `extensions_file`,
 * `override_flag` or `host_stated`. `entry_hash` is the sha256 of the module's own file, the value
 * the identity's `modules[].entry_hash` holds. `folder_tree_hash` is the dir_tree_v1 hash of the
 * module's own folder; the identity's `tree.tree_hash` joins every module's folder, so the two
 * differ once a project has modules in two folders. Each hash is 64 lowercase hex characters.
 * @beta
 */
export type ProjectSource =
  | {
      readonly source: 'project';
      readonly declared: string;
      readonly via: 'manifest' | 'extensions_file' | 'override_flag' | 'host_stated';
      readonly entry_hash: string;
      readonly folder_tree_hash: string;
    }
  | {
      readonly source: 'project';
      readonly declared: string;
      readonly via: 'manifest' | 'extensions_file' | 'override_flag' | 'host_stated';
      readonly absent: 'hashes_unavailable';
    };

/**
 * Where a registry entry's code came from: Realm's built-in, the built-in adapter catalog, a
 * project's module, or the hosting program.
 *
 * @remarks
 * `built_in`: one of Realm's own built-ins, registered by `createDefaultRegistry()`. `catalog`: an
 * adapter the deployment manifest builds from Realm's catalog, `use` naming the catalog entry.
 * `project`: see {@link ProjectSource}. `host_registered`: an object the hosting program registered
 * with no stated source, with the sha256 of its code's text taken at registration, or
 * `code_text_unavailable` when that text cannot be read (a bound or native function, a callable
 * Proxy, a read that throws).
 * @beta
 */
export type CodeSource =
  | { readonly source: 'built_in' }
  | { readonly source: 'catalog'; readonly use: string }
  | ProjectSource
  | { readonly source: 'host_registered'; readonly code_text_sha256: string }
  | { readonly source: 'host_registered'; readonly absent: 'code_text_unavailable' };
