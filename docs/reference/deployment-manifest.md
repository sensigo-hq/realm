# Deployment Manifest (`realm.yaml`)

One operator-owned file at the **deployment root** is the single home of ALL deployment
configuration: adapter construction (built-in catalog + custom factories), handler/processor
construction config, secret bindings, and gate-notifier config. Workflows keep declaring
CODE via `extensions:` in workflow.yaml (see [Project extensions](project-extensions.md));
the manifest owns CONFIG.

```yaml
# realm.yaml — validated Ajv-strict
version: 1
secrets:
  sources: [dotenv] # dotenv | env; default [dotenv]; order = precedence
  dotenv: ./.env # optional; default <root>/.env; relative to this file
adapters:
  github:
    use: github # catalog name, or ./path.js#Export — resolved vs THIS file's dir
    config: { auth: { token: '${secret:GITHUB_TOKEN}' } }
  gorgias:
    use: gorgias
    config:
      domain: sensigo
      auth: { type: basic, token: '${secret:GORGIAS_EMAIL}:${secret:GORGIAS_API_KEY}' }
handlers:
  record_offer:
    use: ./dist/registry.js#recordOfferFactory
    config: { api_key: '${secret:AIRTABLE_PAT}', base_id: appXXXX }
notifiers:
  slack_gate:
    type: slack
    config:
      webhook_url: '${secret:SLACK_WEBHOOK_URL}'
      bot_token: '${secret:SLACK_BOT_TOKEN}'
      channel_id: C0XXXX
      app_token: '${secret:SLACK_APP_TOKEN}' # Socket Mode (optional)
```

---

## Anchors: whose realm.yaml applies?

- **Operator-registered workflows** (they carry a stored `trust_root`): the manifest at
  `<trust_root>/realm.yaml`, loaded **iff present** — no directory walking, ever. An absent
  manifest is valid (defaults only: the filesystem adapter).
- **Definitions without a trust_root** (agent-created via `create_workflow`, from-string):
  the **daemon's** deployment root — `--project <dir>` on `serve`, `agent`, `run`
  (default: the process cwd; these are operator-launched shells), and on `realm mcp`
  **with NO default**.

**Why `realm mcp` has no cwd default (recorded security decision — do not "improve" it):**
the mcp stdio process's cwd is CLIENT-controlled. With a cwd default, opening a cloned
repository in an MCP client would resolve that repo's realm.yaml — resolving secrets and
importing code the operator never approved. The manifest loads only when `--project` is
typed by the operator in the MCP client config.

`--extensions-module` remains the CODE-module override; `--project` is the CONFIG anchor.

## Secrets

`${secret:NAME}` (NAME = `[A-Z0-9_]+`) is legal **only inside string values under `config`
trees**. Composite references work (`"${secret:A}:${secret:B}"`); `$$` escapes a literal
`$`; malformed reference-like fragments are rejected loudly.

Sources are **declared** (`secrets.sources`, default `[dotenv]`; `env` is opt-in) and the
declared order is the precedence — there is no implicit fallback. The dotenv file is parsed
without mutating `process.env`; a declared-but-missing dotenv file and parse errors are loud
errors. Every unresolved reference is aggregated into ONE error naming each binding site
(`adapters.github.config.auth.token → ${secret:GITHUB_TOKEN}`), the searched sources/paths,
and the fix.

Resolved secret VALUES never appear in logs, errors, or drift records — constructor/factory
throws are wrapped with manifest context and redacted (longest-first replacement; values
shorter than 4 characters are skipped).

**Sentinel mode:** `validate` and `test` always resolve references to labeled sentinels
(`<sentinel:NAME>`) — constructor failures downgrade to warnings. `register`/`watch` resolve
real secrets when sources are available and **degrade with a loud WARN** to sentinels when
they are not (provisioning-friendly, never silent). Execution paths (`run`, `agent`,
`listen`, `serve`, mcp `start_run`) always require REAL resolution — fail-before-create /
`extensions_load_failed` semantics carry over verbatim.

## The built-in catalog (versioned — this table is for realm v0.14)

| `use:`        | Constructs         | `config`                            |
| ------------- | ------------------ | ----------------------------------- |
| `github`      | GitHubAdapter      | `{ auth: { token } }`               |
| `slack`       | SlackAdapter       | `{ webhook_url }`                   |
| `http`        | GenericHttpAdapter | per HttpAdapterConfig               |
| `airtable`    | AirtableAdapter    | per AirtableAdapterConfig           |
| `gorgias`     | GorgiasAdapter     | per GorgiasAdapterConfig            |
| `shopify`     | ShopifyAdapter     | per ShopifyAdapterConfig            |
| `notion`      | NotionAdapter      | per NotionAdapterConfig             |
| `parcelpanel` | ParcelPanelAdapter | per ParcelPanelAdapterConfig        |
| `filesystem`  | FileSystemAdapter  | **config-less** (`config:` = error) |
| `mock`        | MockAdapter        | **config-less** (`config:` = error) |

Multi-instance works naturally — entries are keyed by REGISTRATION name:
`{ shop_eu: { use: shopify, config: … }, shop_us: { use: shopify, config: … } }`.

## The factory contract

Custom `use:` module refs (and every catalog wrapper internally) use ONE construction shape:

```js
// ./dist/registry.js
export function recordOfferFactory({ id, config }) {
  // config arrives with ${secret:NAME} references RESOLVED
  return { id, execute: async (inputs, context) => ({ data: {} }) };
}
```

`./path.js#ExportName` — `#ExportName` optional (default export otherwise); a missing export
errors naming the available exports. `use:` containing `/` or a module file extension is a
module ref; anything else is a catalog name (unknown names error listing the valid set and
the CLI version). Module refs resolve against the MANIFEST file's directory and must
realpath-contain within the deployment root. Handlers/processors have no catalog — module
refs only. Constructed instances are duck-probed and enter the same namespace/collision map
as workflow-declared extension exports (duplicate = ERROR; overriding a default-registry
name = WARN).

## Notifiers

`notifiers.slack_gate` is the gate-notification config for `realm agent` — manifest presence
IS the gate switch (the former nine `SLACK_*` environment reads are gone). Combo rules are
schema-enforced: `app_token` (Socket Mode) requires `bot_token`; `signing_secret` and
`events_port` are a pair; `app_token` and `signing_secret` are mutually exclusive.
`events_port` is per-PROJECT now — two deployments no longer contend for one global port
env var.

## Hot rotation and caching

Loader cache entries carry a memory-only freshness hash over the manifest + dotenv bytes,
re-checked at each load (per run-start): a mismatch rebuilds and REPLACES the entry.
Consequences:

- **dotenv secret rotation reaches the next run without a daemon restart**;
- env-sourced secrets are process-fixed (restart to change);
- module CODE stays restart-required (Node's ESM cache);
- a rebuild resets that entry's rate-limiter buckets;
- concurrent rebuilds race benignly (last wins).

The freshness hash is never recorded anywhere (see Drift below).

## Trust model

**Manifest-write = credential-redirection = code-write-equivalent.** The manifest can point
any adapter at any base URL with any bound secret, and `use:` imports code — treat write
access to a deployment root exactly like write access to its code. Manifest paths and
`use:` refs originate only from operator-registered definitions, the operator's deployment
root, or operator-typed flags — webhook/request data can never influence resolution.
Registering a workflow (or configuring `--project`) grants its runs named access to the
deployment's configured capabilities, with zero secret-binding power for agent-authored
definitions.

**Directory = deployment.** Each deployment root owns its realm.yaml + .env. There are no
profiles in v1 (deliberate; additive later).

## Drift evidence

The run identity record includes `manifest: { path, content_hash }` (raw-bytes sha256 —
placeholders included, so an **edited binding is drift** while a **rotated secret value is
not**) and the referenced `secret_names` (names only — never values or value hashes;
recorded, not compared). `use:`-resolved module FILES contribute sweep roots exactly like
workflow-declared extension modules; the manifest FILE itself never becomes a sweep root.
Secret VALUES are not covered by drift evidence.

## Last-resort pattern: throw-at-import

A code module may still throw at import time to guard its own preconditions — but in a
live daemon Node's ESM cache **caches the error**: fixing the environment and retrying
keeps rethrowing the stale error until the process restarts. Manifest-declared config with
`${secret:}` bindings fails in the LOADER instead (never ESM-cached), so fix-and-retry
works live. Prefer the manifest; treat throw-at-import as a last resort.

## CI note

`validate` and `test` run in sentinel mode — CI needs no dummy `.env`. Only execution
paths need real secrets.
