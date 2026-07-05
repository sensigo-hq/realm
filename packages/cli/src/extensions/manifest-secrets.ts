// manifest-secrets.ts — the CLI secrets engine for the deployment manifest (v0.14).
//
// Sources are DECLARED in the manifest (`secrets.sources`, default ['dotenv']; `env` is
// opt-in) and precedence is the declared order — no implicit fallback. dotenv files are
// parsed WITHOUT mutating process.env. All unresolved references are aggregated into ONE
// loud error naming each binding site, the searched sources/paths, and the fix.
//
// Sentinel mode (validate/test, register/watch degrade-with-WARN): every reference
// resolves to a labeled sentinel string — config shape flows end-to-end without real
// credentials; execution paths always require REAL resolution.
//
// Redaction: resolved secret VALUES never appear in logs, errors, or drift records —
// redactSecretValues() replaces them (longest-first; values shorter than 4 chars skipped).
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { ManifestSecretsConfig, SecretRefSite } from '@sensigo/realm';

export type SecretMode = 'real' | 'sentinel';

/**
 * Secret-source/resolution failure — DISTINCT from module/validation errors so that
 * register/watch can degrade-with-WARN to sentinel mode on exactly this class while a
 * broken module or invalid manifest still fails registration hard.
 */
export class ManifestSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestSecretsError';
  }
}

export interface ResolvedSecrets {
  /** name → resolved value (real values, or `<sentinel:NAME>` labels in sentinel mode). */
  values: Record<string, string>;
  /** Whether the values are sentinels (never real credentials). */
  sentinel: boolean;
  /** Human-readable description of the searched sources (for logs and errors). */
  searched: string[];
}

export function sentinelValue(name: string): string {
  return `<sentinel:${name}>`;
}

/**
 * Resolves every referenced secret name from the manifest-declared sources.
 *
 * @param refs         All reference sites collected from the manifest config trees.
 * @param secretsConfig The manifest's `secrets:` section (defaults applied here).
 * @param manifestDir  Directory of the manifest file — the dotenv path anchor.
 * @param mode         'real' resolves from sources (loud aggregate error on any miss);
 *                     'sentinel' resolves every name to `<sentinel:NAME>`.
 */
export function resolveManifestSecrets(
  refs: SecretRefSite[],
  secretsConfig: ManifestSecretsConfig | undefined,
  manifestDir: string,
  mode: SecretMode,
): ResolvedSecrets {
  const names = [...new Set(refs.map((r) => r.name))];

  if (mode === 'sentinel') {
    const values: Record<string, string> = {};
    for (const name of names) values[name] = sentinelValue(name);
    return { values, sentinel: true, searched: ['(sentinel mode — no sources read)'] };
  }

  const sources = secretsConfig?.sources ?? ['dotenv'];
  const dotenvDeclared = secretsConfig?.dotenv !== undefined;
  const dotenvPath = isAbsolute(secretsConfig?.dotenv ?? '')
    ? resolvePath(secretsConfig!.dotenv!)
    : join(manifestDir, secretsConfig?.dotenv ?? '.env');

  const searched: string[] = [];
  const layers: Array<Record<string, string | undefined>> = [];
  for (const source of sources) {
    if (source === 'dotenv') {
      searched.push(`dotenv (${dotenvPath})`);
      let content: string | undefined;
      try {
        content = readFileSync(dotenvPath, 'utf8');
      } catch (err) {
        if (dotenvDeclared) {
          // Declared-but-missing (or unreadable) is a LOUD error, not an empty source.
          throw new ManifestSecretsError(
            `Deployment manifest secrets: declared dotenv file '${dotenvPath}' cannot be read: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
        layers.push({}); // default path absent → empty source (misses aggregate below)
        continue;
      }
      try {
        layers.push(parseDotenv(content));
      } catch (err) {
        throw new ManifestSecretsError(
          `Deployment manifest secrets: failed to parse dotenv file '${dotenvPath}': ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      searched.push('env (process.env)');
      layers.push(process.env);
    }
  }

  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    let found: string | undefined;
    for (const layer of layers) {
      const candidate = layer[name];
      if (candidate !== undefined) {
        found = candidate;
        break; // declared order = precedence
      }
    }
    if (found === undefined) missing.push(name);
    else values[name] = found;
  }

  if (missing.length > 0) {
    const siteLines = refs
      .filter((r) => missing.includes(r.name))
      .map((r) => `  ${r.path} → \${secret:${r.name}}`);
    throw new ManifestSecretsError(
      `Deployment manifest secrets: ${missing.length} unresolved secret reference(s):\n` +
        `${siteLines.join('\n')}\n` +
        `Searched sources (in precedence order): ${searched.join(', ')}.\n` +
        `Fix: add the missing name(s) to your dotenv file, or declare 'env' in ` +
        `secrets.sources and export them in the daemon's environment.`,
    );
  }

  return { values, sentinel: false, searched };
}

/**
 * Replaces every resolved secret VALUE occurring in `message` with a redaction marker.
 * Longest-first plain-string replacement; values shorter than 4 characters are skipped
 * (short values over-redact everything); over-redaction of longer values is accepted.
 */
export function redactSecretValues(message: string, values: Iterable<string>): string {
  const candidates = [...new Set(values)].filter((v) => v.length >= 4);
  candidates.sort((a, b) => b.length - a.length);
  let out = message;
  for (const value of candidates) {
    out = out.split(value).join('[redacted]');
  }
  return out;
}
