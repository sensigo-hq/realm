# Project Extensions

First-class support for project-specific adapters, step handlers, and processors. A workflow
declares its extension modules in `workflow.yaml`; every step-executing or config-validating
entry point (CLI and MCP) loads them identically. No bespoke MCP wrapper servers, no
per-command wiring.

```yaml
# workflow.yaml
extensions: ../../dist/registry.js # string | string[]; RELATIVE paths only
```

```js
// registry.js — declarative default export, instances keyed by REGISTRATION NAME
import { GorgiasAdapter } from '@sensigo/realm';
import { myHandler } from './handlers.js';
import { myProcessor } from './processors.js';

export default {
  adapters: { gorgias: new GorgiasAdapter('gorgias', { ... }) },
  handlers: { check_offer_phrase_handler: myHandler },
  processors: { normalize_offer: myProcessor },
};
```

---

## Module contract

The module's **default export** is a plain declarative object with up to three optional maps:

| Key          | Value                            | Interface (from `@sensigo/realm`)                    |
| ------------ | -------------------------------- | ---------------------------------------------------- |
| `adapters`   | `Record<string, ServiceAdapter>` | callable `fetch` / `create` / `update` (+ `delete?`) |
| `handlers`   | `Record<string, StepHandler>`    | callable `execute`                                   |
| `processors` | `Record<string, Processor>`      | callable `process`                                   |

Rules:

- **The map key is the registration name.** If the instance exposes a differing `id`, the loader
  warns and uses the map key. Workflow YAML references (`services.<name>.adapter`,
  `steps.<name>.handler`) must match the map keys.
- The export must be a **declarative object, not an `ExtensionRegistry` instance** — registry-like
  exports (callable `register`/`getAdapter`) are rejected. Unknown top-level keys (e.g. a typo'd
  `handler:`) are rejected.
- Loading is fail-fast and happens **before any run is created or claimed**. A broken module never
  produces a half-configured run.

### Duck typing and version skew

Validation is structural (**duck-typed**, never `instanceof`): the loader probes the minimal
distinguishing members of each interface. This is deliberate — npm dedupe can put your project's
`@sensigo/realm` and the CLI's on different copies, and `instanceof` across copies is false.
Consequences for module authors:

- Declare `@sensigo/realm` as a **peer dependency** of your extensions package so your instances
  are built against the same engine version that executes them.
- After upgrading Realm across a minor/major boundary, rebuild your compiled registry and
  re-register your workflows.

### Module formats

Both module systems work. ESM projects (`"type": "module"`) export the manifest directly.
tsc-CommonJS builds (`module: commonjs`, no `"type": "module"`) work too — the loader unwraps
Node's CJS-ESM interop (`__esModule` + `default`) automatically, so `export default {...}`
compiles and loads correctly under either configuration.

### TypeScript modules

Compiled JS is the documented default. A declared `.ts` / `.mts` path is loaded through
[`jiti`](https://github.com/unjs/jiti), resolved **from the extension module's own directory**
(your project's `node_modules`) — never from the Realm CLI install. If jiti is absent you get an
actionable error: install jiti in your project, or compile to JS and declare the compiled path.

---

## Collision policy and precedence

| Situation                                                   | Result                  |
| ----------------------------------------------------------- | ----------------------- |
| Extension name overrides a **built-in** name (e.g. `slack`) | **WARN** and allow      |
| The same name claimed by **two declared modules**           | **ERROR** (load fails)  |
| Instance `id` differs from its map key                      | **WARN** (map key wins) |

Precedence (later wins):

```
built-in defaults  <  legacy env-gated built-ins (realm agent: GITHUB_TOKEN / SLACK_WEBHOOK_URL)
                   <  declared `extensions:` modules
                   <  --extensions-module override
```

The env-gated github/slack block in `realm agent` is a **legacy tier** retained for
back-compatibility — the migration path is a project extensions module that constructs those
adapters explicitly.

---

## Trust model

Extension module paths originate **only** from operator-registered workflow definitions or the
operator-typed `--extensions-module` flag — never from request or webhook data. There is no
directory-walking discovery at execution time. Registering a workflow **is** the trust decision:

1. The definition stores the **authored relative paths**, the absolutized workflow directory
   (`source_dir`), and the **trust root** — the nearest ancestor of the workflow directory
   containing `package.json` or `.git` (fallback: the workflow directory itself). All derived
   once, at registration, from an operator-given path.
2. At load time each declared path resolves against `source_dir`; both the resolution and the
   trust root are **realpath-resolved** (symlinks cannot escape), and any resolution outside the
   trust root is refused. Absolute declared paths are rejected by the schema.
3. Definitions created by agents (`origin: 'agent'`, e.g. via the MCP `create_workflow` tool)
   are refused if they carry `extensions`; `create_workflow` itself rejects the key
   (register-time, operator-only), and string-based loading rejects it structurally.

**Consequence, stated plainly: write access to `~/.realm/workflows/` is
code-execution-equivalent; never derive filesystem-write paths from request data in triggered
workflows.**

### realm-cloud / cross-host note

`source_dir` / `trust_root` are **host-specific absolute paths**. A definition registered on one
machine cannot resolve its extensions on another — re-register the workflow **on the executing
host** (the existing norm for workflow_context paths applies here too).

### Downgrade skew

A v0.12 (or older) CLI reading a v0.13 definition silently drops the `extensions` key
(`schema_version` stays 1 — the addition is optional). Custom adapters then fail with
adapter-not-registered at execution time rather than at load. Upgrade the CLI on every host that
executes extension-declaring workflows.

---

## Runtime behavior per entry point

See the [CLI reference](cli-commands.md) for full per-command detail. Summary:

- **`run` / `agent` (fresh)** — extensions load before the run is created (fail-before-create).
- **`agent --run-id`** — extensions load before the run is claimed. If loading fails on a run
  that has **not** started executing, the run is marked terminal with
  `terminal_reason: 'extensions_load_failed'`; re-running `realm agent --run-id <id>` after
  fixing the module **clears exactly that marker and retries**. A run that has already begun
  executing is never mutated by a failed attach.
- **`listen`** — loads every routed workflow's extensions at startup (fail-fast; module
  top-level side effects run in the listen parent). Children re-resolve at spawn.
- **`serve` / `mcp`** — a per-definition registry provider backed by a **process-lifetime
  cache**: module content changes require a process restart (no cache-busting re-imports).
- **`register` / `watch`** — mint the trust decision: full module load + duck validation +
  `config_schema` two-pass **before** persisting.
- **`test`** — extension handlers/processors run **real**; extension adapters the fixture does
  not mock trip a fail-if-unmocked guard (never silently hit a real service).
- **`validate`** — two-pass `config_schema` validation for declaring workflows;
  extension-free workflows keep the historical from-string strictness surface.
- **Read-only commands** (`replay`, `inspect`, `list`, `diff`) never load extension code.

### `--extensions-module <path>` (repair/override)

Available on `agent`, `run`, `serve`, `mcp`, `validate`, `test`. **Replaces** the declared
modules for that invocation and logs loudly. It is an operator-typed path, so trust-root
containment does not apply. Use it for moved files, drift experiments, and repairs — not as the
primary mechanism.

---

## Drift evidence

Every run records the identity of the extension code that actually executed it — captured
at module-**LOAD** time (what is in memory, not what is on disk at some later moment),
recorded as an **append-on-change history** on the run, compared and **WARNed — never
gated** — at attach time and in `realm run inspect`.

**What is recorded** (`RunRecord.extension_identity[]`, one entry per identity change):

- per module: the declared and resolved paths, a sha256 `entry_hash` of the entry file,
  and the load format (`esm` / `cjs` / `ts-jiti`);
- a versioned deterministic directory-tree fingerprint (`dir_tree_v1`) over the deduped
  parent directories of the resolved entries: included extensions
  `.js,.mjs,.cjs,.ts,.mts,.cts,.json`; directories named `node_modules` and `.git`
  excluded at any depth; symlinks skipped; sorted by relative path; caps 2000 files /
  50 MB (over-cap sweeps hash a deterministic prefix and set `truncated: true`);
- labeled advisory `signals` (never compared): `package_version` from the trust root's
  package.json and `git_head` from `.git/HEAD` (one ref-file dereference, no child
  processes) — each independently fail-soft;
- `override_active: true` when `--extensions-module` replaced the declared modules;
- `error` when the capture (or the extension load itself) failed — the failure is itself
  a record.

**Coverage, stated verbatim in `inspect`:** covers files under the recorded roots matching
the recorded rules; imports outside these roots, node_modules, and runtime dynamic imports
are NOT covered.

**When entries are written** (append-on-change): the execution loop appends an entry at
step execution when the run has no history or the last entry denotes different code — so
idempotent creates, batch children, and multi-process resumes never duplicate entries,
and a mid-run code change (fix-registry-then-resume) lands as a second entry with an
advisory envelope warning. `realm agent --run-id` WARNs on stderr when the freshly loaded
identity differs from the run's last recorded one (nothing is written pre-claim); a
pre-execution `extensions_load_failed` write carries an `error` identity entry, giving
the repair loop its before/after pair. Comparison always recomputes under the **recorded**
rule string — an unknown rules version yields an explicit "cannot compare", never a guess.

**`realm run inspect <run-id> --check-drift`** recomputes the last recorded entry against
current disk state with pure hashing (the fingerprint module is structurally incapable of
loading code — no dynamic import, no createRequire) and prints same/DIFFERS/MISSING per
module and for the tree, plus the recorded-vs-current signals.

**Store support:** drift evidence is **JSON-file-store-only for now** — external stores
must round-trip unknown optional RunRecord fields through `update()`; realm-cloud's
columnar store does not yet (its migration spec now includes `extension_identity` and
`workflow_context_snapshots`).
