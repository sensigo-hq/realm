// Tests for the manifest secrets engine: source precedence, aggregated errors, dotenv
// loudness, no process.env mutation, sentinel mode, and redaction.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveManifestSecrets,
  redactSecretValues,
  sentinelValue,
  ManifestSecretsError,
} from './manifest-secrets.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'realm-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const refs = (...names: string[]): Array<{ name: string; path: string }> =>
  names.map((name, i) => ({ name, path: `adapters.a${i}.config.token` }));

describe('resolveManifestSecrets — sources and precedence', () => {
  it('default source is dotenv at <manifestDir>/.env', () => {
    writeFileSync(join(dir, '.env'), 'TOKEN=from-dotenv\n', 'utf8');
    const result = resolveManifestSecrets(refs('TOKEN'), undefined, dir, 'real');
    expect(result.values['TOKEN']).toBe('from-dotenv');
    expect(result.sentinel).toBe(false);
  });

  it('declared order = precedence (dotenv before env, and the reverse)', () => {
    writeFileSync(join(dir, '.env'), 'TOKEN=from-dotenv\n', 'utf8');
    vi.stubEnv('TOKEN', 'from-env');
    const dotenvFirst = resolveManifestSecrets(
      refs('TOKEN'),
      { sources: ['dotenv', 'env'] },
      dir,
      'real',
    );
    expect(dotenvFirst.values['TOKEN']).toBe('from-dotenv');
    const envFirst = resolveManifestSecrets(
      refs('TOKEN'),
      { sources: ['env', 'dotenv'] },
      dir,
      'real',
    );
    expect(envFirst.values['TOKEN']).toBe('from-env');
  });

  it('env is opt-in: process.env is NOT consulted under the default sources', () => {
    vi.stubEnv('ONLY_IN_ENV', 'value');
    expect(() => resolveManifestSecrets(refs('ONLY_IN_ENV'), undefined, dir, 'real')).toThrow(
      ManifestSecretsError,
    );
  });

  it('does not mutate process.env when parsing dotenv', () => {
    writeFileSync(join(dir, '.env'), 'DOTENV_ONLY_KEY=abc\n', 'utf8');
    resolveManifestSecrets(refs('DOTENV_ONLY_KEY'), undefined, dir, 'real');
    expect(process.env['DOTENV_ONLY_KEY']).toBeUndefined();
  });
});

describe('resolveManifestSecrets — loud failures', () => {
  it('aggregates ALL unresolved refs into one error naming binding sites, sources, and the fix', () => {
    writeFileSync(join(dir, '.env'), 'PRESENT=x\n', 'utf8');
    const sites = [
      { name: 'GITHUB_TOKEN', path: 'adapters.github.config.auth.token' },
      { name: 'AIRTABLE_PAT', path: 'handlers.record_offer.config.api_key' },
      { name: 'PRESENT', path: 'adapters.other.config.token' },
    ];
    let error: Error | undefined;
    try {
      resolveManifestSecrets(sites, undefined, dir, 'real');
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeInstanceOf(ManifestSecretsError);
    expect(error!.message).toContain('2 unresolved secret reference(s)');
    expect(error!.message).toContain('adapters.github.config.auth.token → ${secret:GITHUB_TOKEN}');
    expect(error!.message).toContain(
      'handlers.record_offer.config.api_key → ${secret:AIRTABLE_PAT}',
    );
    expect(error!.message).toContain(`dotenv (${join(dir, '.env')})`);
    expect(error!.message).toContain('Fix:');
  });

  it('declared-but-missing dotenv file is a loud error', () => {
    expect(() =>
      resolveManifestSecrets(refs('A'), { dotenv: './missing.env' }, dir, 'real'),
    ).toThrow(/declared dotenv file .* cannot be read/);
  });

  it('undeclared default .env absent → misses aggregate (not a file error)', () => {
    expect(() => resolveManifestSecrets(refs('A'), undefined, dir, 'real')).toThrow(
      /unresolved secret reference/,
    );
  });
});

describe('sentinel mode', () => {
  it('resolves every ref to a labeled sentinel without reading any source', () => {
    const result = resolveManifestSecrets(refs('GITHUB_TOKEN'), undefined, dir, 'sentinel');
    expect(result.sentinel).toBe(true);
    expect(result.values['GITHUB_TOKEN']).toBe('<sentinel:GITHUB_TOKEN>');
    expect(sentinelValue('X')).toBe('<sentinel:X>');
  });
});

describe('redactSecretValues', () => {
  it('replaces every resolved value, longest first (multi-secret message)', () => {
    const message = 'auth failed for token=super-secret-long and key=short-one';
    const out = redactSecretValues(message, ['short-one', 'super-secret-long']);
    expect(out).toBe('auth failed for token=[redacted] and key=[redacted]');
    expect(out).not.toContain('super-secret-long');
  });

  it('longest-first prevents partial reveals when one value contains another', () => {
    const out = redactSecretValues('x=abcdef123456', ['abcdef', 'abcdef123456']);
    expect(out).toBe('x=[redacted]');
  });

  it('skips values shorter than 4 chars (over-redaction guard)', () => {
    const out = redactSecretValues('the answer is 42 and t0k3n-value', ['42', 't0k3n-value']);
    expect(out).toContain('42');
    expect(out).not.toContain('t0k3n-value');
  });
});
