// Extension manifest — pure data describing which project extension modules were loaded
// and which registration names they contributed. Produced by the CLI-side loader
// (loadProjectExtensions in @sensigo/realm-cli); consumed by logging, testing
// (@sensigo/realm-testing fail-if-unmocked semantics), and tests. Core only defines the
// shape — core never loads extension modules (core stays I/O-free for module loading).

/** One loaded extension module: the authored (declared) path and its resolved absolute path. */
export interface ExtensionModuleRef {
  /** The path as authored in workflow.yaml `extensions:` (relative) or typed via --extensions-module. */
  declared: string;
  /** Absolute, realpath-resolved module path that was imported. */
  resolved: string;
}

/** Names contributed by project extension modules, grouped by extension type. */
export interface ExtensionManifest {
  modules: ExtensionModuleRef[];
  adapters: string[];
  handlers: string[];
  processors: string[];
}
