// Deployment manifest (`<deployment root>/realm.yaml`, v0.14) — types, Ajv-STRICT schema,
// and the pure validate function (precedent: trigger-schema.ts). The manifest is the single
// home of ALL deployment configuration: adapter construction (built-in catalog + custom
// factories), handler/processor construction config, secret bindings (`${secret:NAME}`),
// and gate-notifier config. Core owns SHAPE validation only — the CLI owns fs/parse/
// resolve/construct. Workflows keep declaring CODE via `extensions:`; the manifest owns
// CONFIG. Trust model: manifest-write = credential-redirection = code-write-equivalent.
import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import { load } from 'js-yaml';
import { createHash } from 'node:crypto';
import { findSecretRefSites } from './secret-refs.js';
import { canonicalJson } from '../store/params-hash.js';

/** One adapter/handler/processor entry, keyed by REGISTRATION name in the manifest maps. */
export interface ManifestEntry {
  /**
   * What constructs the instance: a built-in catalog name (e.g. `github`), or a module
   * reference `./path.js#ExportName` resolved against the MANIFEST file's directory
   * (`#ExportName` optional — default export otherwise). Contains `/` or a file
   * extension → module ref; else catalog name. Handlers/processors have no catalog —
   * module refs only. Omitted `use:` is invalid for adapters and handlers/processors
   * alike (there is nothing to construct).
   */
  use?: string;
  /** Construction config; `${secret:NAME}` references are legal only inside its strings. */
  config?: Record<string, unknown>;
}

/** Slack gate-notifier config — the reborn checkSlackBidirectionalConfig semantics. */
export interface SlackGateNotifierConfig {
  type: 'slack';
  config: {
    webhook_url?: string;
    bot_token?: string;
    channel_id?: string;
    app_token?: string;
    signing_secret?: string;
    events_port?: number;
    reminder_interval_ms?: number;
    escalation_threshold_ms?: number;
  };
}

export interface ManifestSecretsConfig {
  /** Secret sources in PRECEDENCE order. Default: ['dotenv']. `env` is opt-in. */
  sources?: Array<'dotenv' | 'env'>;
  /** dotenv file path, relative to the manifest file. Default: `<root>/.env`. */
  dotenv?: string;
}

export interface DeploymentManifest {
  version: 1;
  secrets?: ManifestSecretsConfig;
  adapters?: Record<string, ManifestEntry>;
  handlers?: Record<string, ManifestEntry>;
  processors?: Record<string, ManifestEntry>;
  notifiers?: { slack_gate?: SlackGateNotifierConfig };
  /**
   * Issue #600 caching PR P — what the runner of this deployment configures for itself.
   * `cache.economics`: the runner's price file (format v1, `cache-economics.ts`), a path relative to
   * this manifest's folder, or absolute. No `${secret:…}`.
   */
  runner?: { cache?: { economics?: string } };
  /**
   * #729 PR-3 (the owner's Q1) — what realm's disclosure law may show. `not_secret`: environment
   * variable NAMES whose values are shown on every surface. A name is exempt only when every loaded
   * manifest lists it, and only while no other, unlisted variable holds the same value.
   */
  disclosure?: { not_secret?: string[] };
}

/**
 * The ONE construction shape for `use:` module refs AND catalog wrappers: a factory
 * receiving the registration id and the secret-RESOLVED config, returning the instance.
 */
export interface ExtensionFactoryContext {
  id: string;
  config: Record<string, unknown>;
}
export type ExtensionFactory<T = unknown> = (ctx: ExtensionFactoryContext) => T;

const ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    use: { type: 'string', minLength: 1 },
    config: { type: 'object' },
  },
} as const;

const ENTRY_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: ENTRY_SCHEMA,
} as const;

/** Ajv-strict JSON schema for the deployment manifest document. */
export const DEPLOYMENT_MANIFEST_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { const: 1 },
    secrets: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: {
          type: 'array',
          minItems: 1,
          items: { enum: ['dotenv', 'env'] },
        },
        dotenv: { type: 'string', minLength: 1 },
      },
    },
    adapters: ENTRY_MAP_SCHEMA,
    handlers: ENTRY_MAP_SCHEMA,
    processors: ENTRY_MAP_SCHEMA,
    notifiers: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slack_gate: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'config'],
          properties: {
            type: { const: 'slack' },
            config: {
              type: 'object',
              additionalProperties: false,
              properties: {
                webhook_url: { type: 'string', minLength: 1 },
                bot_token: { type: 'string', minLength: 1 },
                channel_id: { type: 'string', minLength: 1 },
                app_token: { type: 'string', minLength: 1 },
                signing_secret: { type: 'string', minLength: 1 },
                events_port: { type: 'integer', minimum: 1, maximum: 65535 },
                reminder_interval_ms: { type: 'integer', minimum: 1 },
                escalation_threshold_ms: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
    runner: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cache: {
          type: 'object',
          additionalProperties: false,
          properties: {
            economics: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    disclosure: {
      type: 'object',
      additionalProperties: false,
      properties: {
        not_secret: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        },
      },
    },
  },
};

function formatAjvError(err: ErrorObject): string {
  const where = err.instancePath === '' ? 'manifest' : `manifest${err.instancePath}`;
  const detail =
    err.keyword === 'additionalProperties'
      ? `unknown key '${String((err.params as { additionalProperty?: string }).additionalProperty)}'`
      : (err.message ?? 'invalid');
  return `${where}: ${detail}`;
}

/**
 * Pure structural + semantic validation of a parsed manifest document.
 * Returns actionable error strings (empty = valid). Empty maps and absent sections are
 * valid. Duplicate-name detection across manifest entries and code-module exports is
 * loader-side (post-resolution) — one namespace, one collision map.
 */
export function validateDeploymentManifest(raw: unknown): string[] {
  const errors: string[] = [];
  const ajv = new Ajv({ strict: true, allErrors: true });
  if (!ajv.validate(DEPLOYMENT_MANIFEST_JSON_SCHEMA, raw)) {
    for (const err of ajv.errors ?? []) errors.push(formatAjvError(err));
    return errors;
  }
  const manifest = raw as DeploymentManifest;

  // Notifier combo validation (the reborn checkSlackBidirectionalConfig, as hard schema):
  const slack = manifest.notifiers?.slack_gate?.config;
  if (slack !== undefined) {
    if (slack.app_token !== undefined && slack.bot_token === undefined) {
      errors.push(
        `notifiers.slack_gate: 'app_token' (Socket Mode) requires 'bot_token' — Socket Mode replies are posted via the bot token.`,
      );
    }
    if (slack.signing_secret !== undefined && slack.events_port === undefined) {
      errors.push(
        `notifiers.slack_gate: 'signing_secret' (Events API) requires 'events_port' — the events listener needs a port to bind.`,
      );
    }
    if (slack.events_port !== undefined && slack.signing_secret === undefined) {
      errors.push(
        `notifiers.slack_gate: 'events_port' requires 'signing_secret' — an events listener without request verification is not allowed.`,
      );
    }
    if (slack.app_token !== undefined && slack.signing_secret !== undefined) {
      errors.push(
        `notifiers.slack_gate: 'app_token' and 'signing_secret' are mutually exclusive — Socket Mode and the Events API are alternative reply channels; configure one.`,
      );
    }
  }

  // `${secret:NAME}` placement: legal ONLY inside string values under `config` trees.
  // Also reject malformed reference-like fragments anywhere (typos never pass silently).
  errors.push(...checkSecretRefPlacement(manifest));

  return errors;
}

/** Sections whose `config` subtree is the ONLY legal home for secret references. */
function checkSecretRefPlacement(manifest: DeploymentManifest): string[] {
  const errors: string[] = [];

  const checkEntryMap = (
    section: 'adapters' | 'handlers' | 'processors',
    map: Record<string, ManifestEntry> | undefined,
  ): void => {
    for (const [name, entry] of Object.entries(map ?? {})) {
      // use: must not carry secret refs (it names code, not config).
      if (entry.use !== undefined) {
        const scan = findSecretRefSites(entry.use, `${section}.${name}.use`);
        for (const site of scan.sites) {
          errors.push(
            `${site.path}: '\${secret:${site.name}}' is not allowed here — secret references are legal only inside string values under 'config'.`,
          );
        }
        for (const bad of scan.malformed) {
          errors.push(`malformed secret reference '${bad.fragment}' at ${bad.path}.`);
        }
      }
      const scan = findSecretRefSites(entry.config, `${section}.${name}.config`);
      // #729 PR-3 correction 3 (H-9): the key path goes AFTER realm's words — before a colon, a
      // credential-named last key made the whole sentence read as that key's value (PR3-C3AUD-05).
      for (const bad of scan.malformed) {
        errors.push(
          `malformed secret reference '${bad.fragment}' at ${bad.path} — the form is \${secret:NAME} with NAME = [A-Z0-9_]+.`,
        );
      }
    }
  };
  checkEntryMap('adapters', manifest.adapters);
  checkEntryMap('handlers', manifest.handlers);
  checkEntryMap('processors', manifest.processors);

  const slackConfig = manifest.notifiers?.slack_gate?.config;
  if (slackConfig !== undefined) {
    const scan = findSecretRefSites(slackConfig, 'notifiers.slack_gate.config');
    for (const bad of scan.malformed) {
      errors.push(
        `malformed secret reference '${bad.fragment}' at ${bad.path} — the form is \${secret:NAME} with NAME = [A-Z0-9_]+.`,
      );
    }
  }

  // secrets.dotenv must not carry refs (it locates the source, it cannot use one).
  if (manifest.secrets?.dotenv !== undefined) {
    const scan = findSecretRefSites(manifest.secrets.dotenv, 'secrets.dotenv');
    for (const site of scan.sites) {
      errors.push(
        `${site.path}: '\${secret:${site.name}}' is not allowed here — secret references are legal only inside string values under 'config'.`,
      );
    }
  }

  // issue #600 caching PR P: runner.cache.economics names a file; it cannot use a secret either.
  if (manifest.runner?.cache?.economics !== undefined) {
    const scan = findSecretRefSites(manifest.runner.cache.economics, 'runner.cache.economics');
    for (const site of scan.sites) {
      errors.push(
        `${site.path}: '\${secret:${site.name}}' is not allowed here — secret references are legal only inside string values under 'config'.`,
      );
    }
  }

  return errors;
}

/** Collects every well-formed secret reference site across all config trees. */
/**
 * #729 PR-3 (D-12): sha256 of the manifest's canonical `secrets` block (its JSON with sorted keys; no
 * block hashes as `null`). With the referenced secret names, it decides a run's declared values: a run
 * recorded with it keeps its declared part across any other edit to `realm.yaml`.
 */
export function manifestSecretsBlockHash(manifest: DeploymentManifest): string {
  return createHash('sha256')
    .update(canonicalJson(manifest.secrets ?? null))
    .digest('hex');
}

export function collectManifestSecretRefs(
  manifest: DeploymentManifest,
): Array<{ name: string; path: string }> {
  const sites: Array<{ name: string; path: string }> = [];
  const fromMap = (
    section: 'adapters' | 'handlers' | 'processors',
    map: Record<string, ManifestEntry> | undefined,
  ): void => {
    for (const [name, entry] of Object.entries(map ?? {})) {
      sites.push(...findSecretRefSites(entry.config, `${section}.${name}.config`).sites);
    }
  };
  fromMap('adapters', manifest.adapters);
  fromMap('handlers', manifest.handlers);
  fromMap('processors', manifest.processors);
  const slack = manifest.notifiers?.slack_gate?.config;
  if (slack !== undefined) {
    sites.push(...findSecretRefSites(slack, 'notifiers.slack_gate.config').sites);
  }
  return sites;
}

/**
 * Issue #600 caching PR P — `realm.yaml`'s text, parsed and validated in ONE place: js-yaml's
 * default load (as the CLI loader always read it), then `validateDeploymentManifest`. Pure. The
 * two kinds of failure stay distinct: `yaml` carries js-yaml's message and the error itself as
 * `cause`; `schema` carries the validation errors.
 */
export function parseDeploymentManifest(text: string):
  | { document: DeploymentManifest }
  | {
      error:
        { kind: 'yaml'; message: string; cause: unknown } | { kind: 'schema'; errors: string[] };
    } {
  let raw: unknown;
  try {
    raw = load(text);
  } catch (err) {
    return {
      error: {
        kind: 'yaml',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      },
    };
  }
  const errors = validateDeploymentManifest(raw);
  if (errors.length > 0) return { error: { kind: 'schema', errors } };
  return { document: raw as DeploymentManifest };
}
