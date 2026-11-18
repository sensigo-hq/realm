// Gap 1, unit A1 — `realm agent --no-record-model-text`, through the BUILT CLI: the flag a person types
// reaches the drive, whose step then records that recording was off; the same drive without it keeps
// the provider module's text, masked. One project, a provider module that reports its texts, two
// drives.
//
// The cell names the break that turns it red (prompts/gap1-a1-model-text-record.md, check 6) and
// prints the exit codes and each run's field.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempHome, runsOf, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const DECLARED = 'FAKE-a1-flag-declared-0000';

/** A provider module that answers, with one usage record and that request's text. */
const MODULE = `import { LlmProvider } from '@sensigo/realm-cli/agent';
class Module extends LlmProvider {
  capabilities() { return { jsonMode: false }; }
  async callStep() { return { word: 'hello' }; }
  async callStepWithMeta(prompt) {
    return {
      output: { word: 'hello' },
      usage: [{ request_index: 0, request_start: new Date().toISOString(), model: 'module-model' }],
      modelText: [{
        sent: [{ role: 'user', content: prompt }],
        reply: [{ role: 'assistant', content: 'the reply names ${DECLARED}' }],
      }],
    };
  }
}
export default new Module();
`;

let root: string;
let h: TempHome;
let codes: { off: number | null; on: number | null };
let fields: { off: unknown; on: unknown };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'realm-a1-flag-'));
  h = await makeTempHome();
  const project = join(root, 'project');
  mkdirSync(project);
  symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'), 'dir');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
  writeFileSync(join(project, '.env'), `A1_TOKEN=${DECLARED}\n`, 'utf8');
  writeFileSync(
    join(project, 'realm.yaml'),
    [
      'version: 1',
      'secrets:',
      '  sources: [dotenv]',
      '  dotenv: .env',
      'adapters:',
      '  svc:',
      '    use: github',
      '    config: { token: "${secret:A1_TOKEN}" }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(project, 'workflow.yaml'),
    [
      'id: a1-model-text-flag',
      'name: a1 model text flag',
      'version: 1',
      'steps:',
      '  answer:',
      '    description: Answer with one word.',
      '    execution: agent',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(project, 'm.mjs'), MODULE, 'utf8');
  const realm = (args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root!, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  const drive = ['agent', '--workflow', './workflow.yaml', '--provider-module', './m.mjs'];
  const off = realm([...drive, '--no-record-model-text']);
  const first = await runsOf(h.home.runStore);
  const on = realm(drive);
  const both = await runsOf(h.home.runStore);
  const fieldOf = (id: string | undefined) =>
    both.find((r) => r.record.id === id)?.record.evidence.find((e) => e.step_id === 'answer')
      ?.model_text;
  const offId = first[0]?.record.id;
  codes = { off: off.status, on: on.status };
  fields = {
    off: fieldOf(offId),
    on: fieldOf(both.find((r) => r.record.id !== offId)?.record.id),
  };
}, 180_000);

afterAll(async () => {
  await h?.cleanup();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('gap 1, unit A1 — the flag, through the built CLI', () => {
  it('check 6: realm agent --no-record-model-text records that recording was off; without it the module text is kept, masked', () => {
    // (1) red when the command does not pass the flag to the drive (the first run then keeps the
    //     text); (2) prints both exit codes and both fields.
    expect({ codes, fields }).toEqual({
      codes: { off: 0, on: 0 },
      fields: {
        off: { recorded: false, why: 'switched_off' },
        on: {
          recorded: true,
          messages: [
            { role: 'user', text: 'Answer with one word.' },
            { role: 'assistant', text: 'the reply names [REDACTED]', hidden: 1 },
          ],
          tools: [],
          requests: [{ request_id: expect.any(String), sent: [0], reply: [1] }],
        },
      },
    });
  });
});
