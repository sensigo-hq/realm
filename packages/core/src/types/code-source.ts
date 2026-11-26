// code-source.ts — where a registered handler's, adapter's or processor's code came from (#828 unit 2b),
// and which code a step's attempt chose (unit 2c).
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
 * module's own folder. The CLI's loader takes it after the load's last import, from the sweeps the
 * identity reads, so with one folder it equals the identity's `tree.tree_hash` from the same load;
 * the identity's tree joins every module's folder, so the two differ once a project has modules in
 * two folders. Each hash is 64 lowercase hex characters.
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

/**
 * Which code Realm chose for one attempt of a step that runs a handler or an adapter, as its evidence
 * entry records it (`EvidenceSnapshot.code_source`).
 *
 * @remarks
 * The first form is the code chosen at the attempt's lookup: its `kind` and `name`, the adapter
 * step's `service`, where the code came from (`from`), Realm's `realm_version` when the code was
 * Realm's own (`built_in`, or `catalog`) and replaced no built-in, and `replaces_built_in: true`
 * when code other than that built-in was chosen under a built-in's name (never `false`). The other
 * two say why no code was chosen: `not_registered` (the lookup found nothing under that name) and
 * `not_looked_up` (the attempt failed before any code was chosen: an adapter step whose service is
 * not declared, or whose service names no adapter). `name` is left out when it is not known.
 *
 * The writer rule, for later Realms: `codeSourceOf` reads only these forms, member by member, and
 * answers `unreadable` for any member, word or form it does not declare, never a guess. A later Realm
 * that adds even an informative member accepts that older readers say `unreadable` for those entries;
 * one that changes what the other members mean writes a new form, never an added member, so a reader
 * that skips unknown members is not misled either. A new kind of entry no code made, on a step that
 * runs code, carries a `code_source` form this reader does not read (so older readers say
 * `unreadable`), never a new marker alone; the field then also appears on an entry that is not an
 * attempt, and such a form names no code.
 * @beta
 */
export type StepCodeSource =
  | {
      readonly kind: 'handler' | 'adapter';
      readonly name: string;
      readonly service?: string;
      readonly from: CodeSource;
      readonly realm_version?: string;
      readonly replaces_built_in?: true;
    }
  | {
      readonly absent: 'not_registered';
      readonly kind: 'handler' | 'adapter';
      readonly name: string;
      readonly service?: string;
    }
  | {
      readonly absent: 'not_looked_up';
      readonly kind: 'handler' | 'adapter';
      readonly name?: string;
      readonly service?: string;
    };
