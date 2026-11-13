// result-map-cli-r11.test.ts — R1.1: `trigger.result_map` on the three CLI surfaces that load a
// workflow, through the built `realm`: `realm workflow register`, `realm workflow validate`, and
// `realm workflow validate --registered` (a copy stored before this rule, written straight into the
// store as an older build would have). Each refuses the key on every `auth.mode` but `shared_secret`
// with the loader's sentence naming the mode, and exits 1; with `shared_secret` it is accepted. A
// failing cell prints the surface, the mode, the exit code and the output (no secret is set).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { makeTempHome } from '../test-support/temp-home.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

const AUTH: Record<string, Record<string, string>> = {
  shared_secret: { mode: 'shared_secret', header: 'X-Token', secret_from: 'TOK' },
  hmac: { mode: 'hmac', header: 'X-Sig', secret_from: 'TOK' },
  stripe: { mode: 'stripe', secret_from: 'TOK' },
  github: { mode: 'github', secret_from: 'TOK' },
  none: { mode: 'none' },
};
const yamlOf = (mode: string): string =>
  `id: refunds\nname: refunds\nversion: 1\ntrigger:\n  type: webhook\n  path: /refunds\n  auth:\n` +
  Object.entries(AUTH[mode]!)
    .map(([k, v]) => `    ${k}: ${v}\n`)
    .join('') +
  `  result_map:\n    approved: context.resources.review.approved\n` +
  `steps:\n  review:\n    description: Review.\n    execution: agent\n`;
const refusal = (mode: string): string =>
  `trigger.result_map is allowed only with auth.mode 'shared_secret'; this trigger uses '${mode}'.`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-r11-cli-'));
  mkdirSync(join(root, 'wf'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function realm(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('R1.1 — result_map on register, validate and validate --registered', () => {
  it.each(['hmac', 'stripe', 'github', 'none'])(
    'L1: register and validate refuse it on auth.mode %s, naming the mode',
    (mode) => {
      writeFileSync(join(root, 'wf', 'workflow.yaml'), yamlOf(mode), 'utf8');
      const seen = ['register', 'validate'].map((surface) => {
        const r = realm(['workflow', surface, 'wf']);
        return { surface, code: r.code, refused: r.out.includes(refusal(mode)) };
      });
      // (a) red when the mode check is missing on a surface (it then registers or validates, exit
      //     0) or names another mode; (b) prints each surface's exit code and whether the line came.
      expect(seen).toEqual([
        { surface: 'register', code: 1, refused: true },
        { surface: 'validate', code: 1, refused: true },
      ]);
    },
  );

  it.each(['hmac', 'stripe', 'github', 'none'])(
    'L1: validate --registered refuses a copy stored before the rule, on auth.mode %s',
    async (mode) => {
      const h = await makeTempHome({ home: join(root, '.realm') });
      try {
        await h.home.workflowStore.register({
          id: 'refunds',
          name: 'refunds',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          trust_root: root,
          source_dir: join(root, 'wf'),
          trigger: {
            type: 'webhook',
            path: '/refunds',
            auth: AUTH[mode] as never,
            result_map: { approved: 'context.resources.review.approved' },
          },
          steps: { review: { description: 'Review.', execution: 'agent' } },
        } as never);
      } finally {
        await h.cleanup();
      }
      const r = realm(['workflow', 'validate', '--registered', 'refunds']);
      // (a) red when the stored copy's audit skips the loader's result_map rule; (b) prints the exit
      //     code and the output.
      expect({ code: r.code, refused: r.out.includes(refusal(mode)) }).toEqual({
        code: 1,
        refused: true,
      });
    },
  );

  it('L1: with shared_secret, register, validate and validate --registered accept it', () => {
    writeFileSync(join(root, 'wf', 'workflow.yaml'), yamlOf('shared_secret'), 'utf8');
    const register = realm(['workflow', 'register', 'wf']);
    const validate = realm(['workflow', 'validate', 'wf']);
    const registered = realm(['workflow', 'validate', '--registered', 'refunds']);
    // (a) red when the mode check refuses shared_secret on any surface; (b) prints each exit code
    //     and, for a refusal, the output.
    expect(
      [register, validate, registered].map((r) => (r.code === 0 ? 0 : `${r.code}: ${r.out}`)),
    ).toEqual([0, 0, 0]);
  });
});
