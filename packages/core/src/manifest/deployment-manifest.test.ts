// Tests for the deployment-manifest schema (Ajv strict + notifier combos + secret-ref
// placement) and the ${secret:NAME} grammar.
import { describe, it, expect } from 'vitest';
import {
  validateDeploymentManifest,
  collectManifestSecretRefs,
  type DeploymentManifest,
} from './deployment-manifest.js';
import {
  scanSecretString,
  interpolateSecretString,
  interpolateConfigTree,
  findSecretRefSites,
} from './secret-refs.js';

const VALID: DeploymentManifest = {
  version: 1,
  secrets: { sources: ['dotenv'], dotenv: './.env' },
  adapters: {
    github: { use: 'github', config: { auth: { token: '${secret:GITHUB_TOKEN}' } } },
  },
  handlers: {
    record_offer: { use: './dist/registry.js#recordOfferFactory', config: { base_id: 'appX' } },
  },
  notifiers: {
    slack_gate: {
      type: 'slack',
      config: { webhook_url: '${secret:SLACK_WEBHOOK_URL}', channel_id: 'C0X' },
    },
  },
};

describe('validateDeploymentManifest — Ajv strict structure', () => {
  it('accepts the full valid document', () => {
    expect(validateDeploymentManifest(VALID)).toEqual([]);
  });

  it('accepts a minimal document and empty sections', () => {
    expect(validateDeploymentManifest({ version: 1 })).toEqual([]);
    expect(validateDeploymentManifest({ version: 1, adapters: {}, notifiers: {} })).toEqual([]);
  });

  it('rejects a missing/bad version', () => {
    expect(validateDeploymentManifest({})).not.toEqual([]);
    const errors = validateDeploymentManifest({ version: 2 });
    expect(errors.join(' ')).toContain('version');
  });

  it('rejects unknown top-level and nested keys (strict)', () => {
    expect(validateDeploymentManifest({ version: 1, adaptors: {} }).join(' ')).toContain(
      "unknown key 'adaptors'",
    );
    expect(
      validateDeploymentManifest({
        version: 1,
        adapters: { github: { use: 'github', configs: {} } },
      }).join(' '),
    ).toContain("unknown key 'configs'");
    expect(
      validateDeploymentManifest({
        version: 1,
        notifiers: { slack_gate: { type: 'slack', config: { webhookUrl: 'x' } } },
      }).join(' '),
    ).toContain("unknown key 'webhookUrl'");
  });

  it('rejects bad secrets.sources entries', () => {
    expect(validateDeploymentManifest({ version: 1, secrets: { sources: ['vault'] } })).not.toEqual(
      [],
    );
  });
});

describe('validateDeploymentManifest — notifier combos (reborn bidirectional checks)', () => {
  const slack = (config: Record<string, unknown>): unknown => ({
    version: 1,
    notifiers: { slack_gate: { type: 'slack', config } },
  });

  it('app_token requires bot_token', () => {
    expect(validateDeploymentManifest(slack({ app_token: 'xapp' })).join(' ')).toContain(
      "'app_token' (Socket Mode) requires 'bot_token'",
    );
    expect(validateDeploymentManifest(slack({ app_token: 'xapp', bot_token: 'xoxb' }))).toEqual([]);
  });

  it('signing_secret and events_port are a pair', () => {
    expect(validateDeploymentManifest(slack({ signing_secret: 's' })).join(' ')).toContain(
      "requires 'events_port'",
    );
    expect(validateDeploymentManifest(slack({ events_port: 3141 })).join(' ')).toContain(
      "requires 'signing_secret'",
    );
    expect(validateDeploymentManifest(slack({ signing_secret: 's', events_port: 3141 }))).toEqual(
      [],
    );
  });

  it('app_token and signing_secret are mutually exclusive', () => {
    expect(
      validateDeploymentManifest(
        slack({ app_token: 'x', bot_token: 'b', signing_secret: 's', events_port: 1 }),
      ).join(' '),
    ).toContain('mutually exclusive');
  });

  it('events_port must be an integer in port range', () => {
    expect(
      validateDeploymentManifest(slack({ signing_secret: 's', events_port: 99999 })),
    ).not.toEqual([]);
    expect(
      validateDeploymentManifest(slack({ signing_secret: 's', events_port: 1.5 })),
    ).not.toEqual([]);
  });
});

describe('secret-ref grammar', () => {
  it('scans single, composite, and duplicate refs with the NAME charset', () => {
    expect(scanSecretString('${secret:GITHUB_TOKEN}').refs).toEqual(['GITHUB_TOKEN']);
    expect(scanSecretString('${secret:A}:${secret:B_2}').refs).toEqual(['A', 'B_2']);
    expect(scanSecretString('x ${secret:A} y ${secret:A}').refs).toEqual(['A', 'A']);
  });

  it('rejects malformed refs (lowercase, unterminated) instead of passing them silently', () => {
    expect(scanSecretString('${secret:lower}').malformed.length).toBeGreaterThan(0);
    expect(scanSecretString('${secret:UNTERMINATED').malformed.length).toBeGreaterThan(0);
    expect(scanSecretString('${secret:lower}').refs).toEqual([]);
  });

  it('$$ escapes a literal $ (no ref, and interpolates to a single $)', () => {
    expect(scanSecretString('$${secret:A}').refs).toEqual([]);
    expect(scanSecretString('$${secret:A}').malformed).toEqual([]);
    expect(interpolateSecretString('$${secret:A}', () => 'X')).toBe('${secret:A}');
    expect(interpolateSecretString('cost: $$5', () => 'X')).toBe('cost: $5');
  });

  it('interpolates composite refs', () => {
    const resolve = (n: string): string => (n === 'A' ? 'user' : 'pass');
    expect(interpolateSecretString('${secret:A}:${secret:B}', resolve)).toBe('user:pass');
  });

  it('interpolateConfigTree deep-copies and only touches strings', () => {
    const tree = { auth: { token: '${secret:T}' }, port: 8080, list: ['${secret:T}', 1] };
    const out = interpolateConfigTree(tree, () => 'tok');
    expect(out).toEqual({ auth: { token: 'tok' }, port: 8080, list: ['tok', 1] });
    expect(tree.auth.token).toBe('${secret:T}'); // original untouched
  });

  it('findSecretRefSites reports dot-path binding sites', () => {
    const { sites } = findSecretRefSites(
      { auth: { token: '${secret:GITHUB_TOKEN}' } },
      'adapters.github.config',
    );
    expect(sites).toEqual([{ name: 'GITHUB_TOKEN', path: 'adapters.github.config.auth.token' }]);
  });
});

describe('secret-ref placement (legal only inside config strings)', () => {
  it('rejects a ref in use:', () => {
    const errors = validateDeploymentManifest({
      version: 1,
      adapters: { a: { use: './x-${secret:NAME}.js' } },
    });
    expect(errors.join(' ')).toContain('legal only inside string values');
  });

  it('rejects a ref in secrets.dotenv', () => {
    const errors = validateDeploymentManifest({
      version: 1,
      secrets: { dotenv: './${secret:ENV_NAME}.env' },
    });
    expect(errors.join(' ')).toContain('legal only inside string values');
  });

  it('rejects malformed refs inside config trees loudly', () => {
    const errors = validateDeploymentManifest({
      version: 1,
      adapters: { a: { use: 'github', config: { token: '${secret:bad-name}' } } },
    });
    expect(errors.join(' ')).toContain('malformed secret reference');
  });
});

describe('collectManifestSecretRefs', () => {
  it('collects across adapters/handlers/processors/notifiers config trees', () => {
    const refs = collectManifestSecretRefs(VALID);
    expect(refs.map((r) => r.name).sort()).toEqual(['GITHUB_TOKEN', 'SLACK_WEBHOOK_URL']);
  });
});
