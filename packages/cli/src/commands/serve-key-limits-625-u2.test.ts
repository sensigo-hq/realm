// serve-key-limits-625-u2.test.ts — #625 named keys unit 2b: `realm serve key add`'s limit options
// (`--read-only`, `--allow <tools>`, `--workflows <ids>`), their refusals, and `realm serve key list`'s
// limits words (prompt feat-625-named-keys-u2-limits.md rev 2.1, Behaviour 1 and 6, Words 5, check 7).
// Through the built `realm` with a fresh HOME, as a person runs it: the exit code, both streams and
// the key file. The names are fictional. Beside each assertion: (1) the break that turns it red;
// (2) what it prints when it fails (never a key's text).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveKeysPath } from '../lib/serve-keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const BUDGET = 120_000;
const TOOLS_LINE =
  'list_workflows, get_workflow_protocol, start_run, start_run_batch, execute_step, advance_run, submit_human_response, get_run_state, abandon_run, create_workflow, append_trace';

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-nk2-cmd-'));
  home = join(root, '.realm');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the built `realm` with this cell's HOME and nothing else of the environment. */
function realm(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', HOME: root },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The key file's SHA-256 (or `absent`), to say whether a command changed it. */
function fileState(): string {
  const path = serveKeysPath(home);
  return existsSync(path)
    ? createHash('sha256').update(readFileSync(path)).digest('hex')
    : 'absent';
}

/** The key file as read: its format and each key's name and limits. */
function file(): { format: number; keys: Array<[string, unknown]> } {
  const parsed = JSON.parse(readFileSync(serveKeysPath(home), 'utf8')) as {
    format: number;
    keys: Array<{ name: string; limits?: unknown }>;
  };
  return { format: parsed.format, keys: parsed.keys.map((k) => [k.name, k.limits ?? null]) };
}

describe('check 7 — key add takes each limit option, and their combinations', () => {
  it(
    'each option and each allowed pair is stored as typed (each item trimmed); a key with none stays format 1',
    () => {
      const exits: Record<string, number | null> = {};
      exits['plain'] = realm('serve', 'key', 'add', 'plain').status;
      const formatWithoutLimits = file().format;
      for (const [name, ...options] of [
        ['dash', '--read-only'],
        ['ci', '--allow', 'start_run, get_run_state'],
        ['inv', '--workflows', 'invoices,refunds'],
        ['ro-inv', '--read-only', '--workflows', 'invoices'],
        ['ci-inv', '--allow', 'start_run,abandon_run', '--workflows', ' invoices '],
      ] as const) {
        exits[name] = realm('serve', 'key', 'add', name, ...options).status;
      }
      // (1) red when an option is not read, an item is not trimmed, or format 2 is written for a
      //     file with no limits; (2) prints each exit, the format and every key's limits.
      expect({ exits, formatWithoutLimits, file: file() }).toStrictEqual({
        exits: { plain: 0, dash: 0, ci: 0, inv: 0, 'ro-inv': 0, 'ci-inv': 0 },
        formatWithoutLimits: 1,
        file: {
          format: 2,
          keys: [
            ['plain', null],
            ['dash', { read_only: true }],
            ['ci', { tools: ['start_run', 'get_run_state'] }],
            ['inv', { workflows: ['invoices', 'refunds'] }],
            ['ro-inv', { read_only: true, workflows: ['invoices'] }],
            ['ci-inv', { tools: ['start_run', 'abandon_run'], workflows: ['invoices'] }],
          ],
        },
      });
    },
    BUDGET,
  );
});

describe("check 7 — key add's refusals (Behaviour 1, Words 5)", () => {
  const NOTHING = 'No key was changed.';
  for (const [label, options, line] of [
    [
      '--read-only with --allow',
      ['--read-only', '--allow', 'get_run_state'],
      `Error: --read-only and --allow cannot be used together. ${NOTHING}`,
    ],
    [
      'a tool realm serve does not offer',
      ['--allow', 'start_run,present_question'],
      `Error: --allow names 'present_question', which is not a tool realm serve offers. ${NOTHING} Its tools: ${TOOLS_LINE}.`,
    ],
    [
      'an unknown name with a control character, printed escaped',
      ['--allow', 'start\u0007run'],
      `Error: --allow names 'start\\u0007run', which is not a tool realm serve offers. ${NOTHING} Its tools: ${TOOLS_LINE}.`,
    ],
    [
      '--allow create_workflow with --workflows',
      ['--allow', 'start_run,create_workflow', '--workflows', 'invoices'],
      `Error: --allow names create_workflow, which a key with --workflows cannot use. ${NOTHING}`,
    ],
    [
      'an empty --allow item',
      ['--allow', 'start_run,,abandon_run'],
      `Error: --allow has an empty item. ${NOTHING}`,
    ],
    ['an empty --allow', ['--allow', ''], `Error: --allow has an empty item. ${NOTHING}`],
    [
      'an empty --workflows item (spaces only)',
      ['--workflows', 'invoices, '],
      `Error: --workflows has an empty item. ${NOTHING}`,
    ],
  ] as const) {
    it(
      `${label}: refused with its line, exit 1, the file unchanged`,
      () => {
        expect(realm('serve', 'key', 'add', 'seed').status).toBe(0);
        const before = fileState();
        const r = realm('serve', 'key', 'add', 'new', ...options);
        // (1) red when this refusal is dropped (the key is made); (2) prints the exit, both
        //     streams and whether the file changed.
        expect({ ...r, unchanged: fileState() === before }).toStrictEqual({
          status: 1,
          stdout: '',
          stderr: `${line}\n`,
          unchanged: true,
        });
      },
      BUDGET,
    );
  }
});

describe("check 7 — key list's limits words (Behaviour 6)", () => {
  it(
    'a key with no limits prints its line unchanged; a limited key appends its limits',
    () => {
      for (const [name, ...options] of [
        ['a-plain'],
        ['b-dash', '--read-only'],
        ['c-ci', '--allow', 'start_run,get_run_state'],
        ['d-inv', '--workflows', 'invoices,refunds'],
        ['e-both', '--allow', 'start_run,get_run_state', '--workflows', 'invoices'],
        ['f-ro-inv', '--read-only', '--workflows', 'invoices'],
        ['g-odd', '--workflows', 'inv\u0007'],
      ] as const) {
        expect(realm('serve', 'key', 'add', name, ...options).status).toBe(0);
      }
      const r = realm('serve', 'key', 'list');
      // (1) red when list drops or rewords the limits, prints them for a key with none, or prints
      //     an operator-typed workflow id raw; (2) prints the exit and every line (instants masked).
      expect({
        status: r.status,
        lines: r.stdout
          .trimEnd()
          .split('\n')
          .map((l) => l.replace(/made \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, 'made <when>')),
      }).toStrictEqual({
        status: 0,
        lines: [
          'a-plain  made <when>  does not end',
          'b-dash  made <when>  does not end  limits: read-only',
          'c-ci  made <when>  does not end  limits: tools start_run, get_run_state',
          'd-inv  made <when>  does not end  limits: workflows invoices, refunds',
          'e-both  made <when>  does not end  limits: tools start_run, get_run_state; workflows invoices',
          'f-ro-inv  made <when>  does not end  limits: read-only; workflows invoices',
          'g-odd  made <when>  does not end  limits: workflows inv\\u0007',
        ],
      });
    },
    BUDGET,
  );
});
