// docs-upgrade-captures-616.test.ts — issue #616 PR-2c (release 0.49.0, row 11): the upgrade guide's
// sections 3–6 quote what the published 0.49.0 printed for the guide's own story, captured from one
// real run on Node 22. This file runs the BUILT CLI through the same story on a scratch home, from the
// same workflow files the capture registered (`fixtures/upgrade-story`: tidy-notes, digest and the
// misspelt intake; `fixtures/upgrade-story-corrected`: intake fixed), and asserts that each quoted
// block is what the command prints.
//
// The page's elision rule, applied here: a line that is only `…` stands for one or more whole lines
// left out (the lines before the first `…` are the output's head, those after the last its tail, the
// ones between found in order); a line ending in ` …` is cut after that point (a prefix). Nothing else
// on a block is edited. Where a line prints Realm's version, the tree's own version is written as the
// page's, 0.49.0, so this file pins the words of each output, not the number.
//
// A red here after a product change means the page no longer shows what Realm prints: re-capture the
// outputs on the published version that carries the change and update the intro's versions. The
// release sitting's captures row owns that (row 11 for 0.49.0; the pre-publication checklist has no
// such step yet).
//
// Section 2's `npm ls` block needs the registry and is not run here: a static cell checks its shape.
// The children run with an environment of PATH and HOME only. The describe that starts the CLI and the
// server carries its own budget (spawn-budget-guard.test.ts, #371).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const UPGRADE = 'docs/guides/upgrade.md';
const PAGE_VERSION = '0.49.0';
const SUMMARY = 'The customer was charged twice and wants one charge refunded.';

/** The code blocks of one language in a section of the page (from `heading` to the next `## `). */
function blocksOf(heading: string, lang: 'text' | 'bash'): string[] {
  const text = readFileSync(join(ROOT, UPGRADE), 'utf8');
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`${UPGRADE} has no heading: ${heading}`);
  const end = text.indexOf('\n## ', start + heading.length);
  const section = text.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\`$`, 'gm'))].map(
    (m) => m[1]!,
  );
}

/** One quoted line against one printed line: equal, or a prefix when the quote ends in ` …`. */
function lineMatches(quoted: string, printed: string | undefined): boolean {
  if (printed === undefined) return false;
  return quoted.endsWith(' …') ? printed.startsWith(quoted.slice(0, -2)) : quoted === printed;
}

/** The page's elision rule: see the header. Each `…` line stands for at least one printed line. */
function matches(block: string, output: string): boolean {
  const printed = output.replace(/\n+$/, '').split('\n');
  const segments: string[][] = [[]];
  for (const line of block.split('\n')) {
    if (line === '…') segments.push([]);
    else segments[segments.length - 1]!.push(line);
  }
  const fits = (segment: string[], at: number): boolean =>
    segment.every((line, i) => lineMatches(line, printed[at + i]));
  if (segments.length === 1) return segments[0]!.length === printed.length && fits(segments[0]!, 0);
  const head = segments[0]!;
  const tail = segments[segments.length - 1]!;
  const tailAt = printed.length - tail.length;
  if (!fits(head, 0) || !fits(tail, tailAt)) return false;
  let at = head.length;
  for (const segment of segments.slice(1, -1)) {
    let found = -1;
    for (let p = at + 1; p + segment.length <= tailAt; p++) {
      if (fits(segment, p)) {
        found = p;
        break;
      }
    }
    if (found < 0) return false;
    at = found + segment.length;
  }
  return tailAt >= at + 1;
}

let scratch = '';
let version = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-upgrade-captures-'));
  version = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).stdout.trim();
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  out: string;
  err: string;
}
/** The tree's version written as the page's, where a line prints it. */
const asPage = (t: string): string =>
  t.split(`realm ${version}'s loader`).join(`realm ${PAGE_VERSION}'s loader`);
/** The built CLI, environment PATH and HOME. */
function realm(args: string[], home: string, cwd: string): Ran {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, out: asPage(r.stdout), err: asPage(r.stderr) };
}

describe(
  '#616 PR-2c row 11 — the upgrade guide’s quoted outputs (upgrade.md sections 3–6), on the built CLI',
  { timeout: 60_000 },
  () => {
    it('each quoted block is what the CLI prints for the guide’s story; the states the prose names hold', async () => {
      const home = join(scratch, 'home');
      const workflows = join(home, 'workflows');
      mkdirSync(home);
      cpSync(join(FIXTURES, 'upgrade-story'), workflows, { recursive: true });
      cpSync(join(FIXTURES, 'old-json-home', 'runs'), join(home, 'realm-old', 'runs'), {
        recursive: true,
      });
      const inFolder = (args: string[]): Ran => realm(args, home, workflows);
      // The move's step 4: the workflows registered again from their source folders.
      const tidyNotes = inFolder(['workflow', 'register', 'tidy-notes']);
      const digest = inFolder(['workflow', 'register', 'digest']);
      const intake = inFolder(['workflow', 'register', 'intake']);
      // Section 3.
      const listed = inFolder(['workflow', 'list']);
      const audited = inFolder(['workflow', 'validate', '--registered', 'digest']);
      // Section 4: the page's own loop, run by bash with `realm` on PATH as the built CLI.
      const loopCode = blocksOf('## 4. See the new version find a problem', 'bash').find((b) =>
        b.startsWith('for dir in'),
      );
      const bin = join(scratch, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'realm'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
      chmodSync(join(bin, 'realm'), 0o755);
      const loop = spawnSync('bash', ['-c', loopCode ?? 'exit 99'], {
        cwd: workflows,
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: home },
        encoding: 'utf8',
      });
      // Section 5: the file corrected, registered and audited.
      cpSync(
        join(FIXTURES, 'upgrade-story-corrected', 'intake', 'workflow.yaml'),
        join(workflows, 'intake', 'workflow.yaml'),
      );
      const fixed = inFolder(['workflow', 'register', 'intake']);
      const fixedAudit = inFolder(['workflow', 'validate', '--registered', 'intake']);
      // Section 6: the fixture's runs imported (the first section), then one run of intake finished
      // over the built server, `realm mcp`: start_run, then execute_step with a summary.
      const imported = realm(['run', 'import', join(home, 'realm-old', 'runs')], home, home);
      const client = new Client({ name: 'docs-upgrade-captures-616', version: '0' });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [CLI, 'mcp'],
          env: { PATH: process.env['PATH'] ?? '', HOME: home },
          stderr: 'ignore',
        }),
      );
      const reply = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as {
          content: { text: string }[];
        };
        return JSON.parse(r.content[0]!.text) as {
          run_id: string;
          status: string;
          run_phase: string;
        };
      };
      let started: Awaited<ReturnType<typeof reply>>;
      let answered: Awaited<ReturnType<typeof reply>>;
      try {
        started = await reply('start_run', { workflow_id: 'intake' });
        answered = await reply('execute_step', {
          run_id: started.run_id,
          command: 'summarise',
          params: { summary: SUMMARY },
        });
      } finally {
        await client.close();
      }
      const runs = realm(['run', 'list'], home, home);
      const migrated = realm(['run', 'migrate', '--stamp-seals'], home, home);

      const s3 = blocksOf('## 3. Check the workflows you have registered', 'text');
      const s4 = blocksOf('## 4. See the new version find a problem', 'text');
      const s5 = blocksOf('## 5. Fix, and register again', 'text');
      const s6 = blocksOf('## 6. Check the runs', 'text');
      const quoted: [command: string, block: string | undefined, printed: string][] = [
        ['realm workflow list', s3[0], listed.out],
        ['realm workflow validate --registered digest', s3[1], audited.out],
        [
          'realm workflow register intake (the misspelt file; its line is on stderr)',
          s4[0],
          intake.err,
        ],
        ['the loop over the source folders', s4[1], loop.stdout],
        [
          'realm workflow register intake, then realm workflow validate --registered intake',
          s5[0],
          fixed.out + fixedAudit.out,
        ],
        ['realm run migrate --stamp-seals', s6[0], migrated.out],
      ];
      // (a) red when a quoted block is not what the command prints under the elision rule (a
      //     character changed on the page, or the product's words changed); (b) prints, per block,
      //     `upgrade.md no longer matches <command>`, the block and what the command printed.
      expect(
        quoted
          .filter(([, block, printed]) => block === undefined || !matches(block, printed))
          .map(
            ([command, block, printed]) =>
              `upgrade.md no longer matches ${command}:\n${block ?? '(no block)'}\n--- it prints:\n${printed}`,
          )
          .join('\n\n'),
      ).toBe('');
      // (a) red when a state the page's prose names does not hold: the misspelt file registered or
      //     printing on stdout, a command failing, the run not completing, the list not holding the
      //     two imported runs and the finished one; (b) prints every code and state.
      expect({
        registered: [tidyNotes.code, digest.code],
        refused: [intake.code, intake.out],
        audited: audited.code,
        loop: loop.status,
        fixed: [fixed.code, fixedAudit.code],
        imported: imported.code,
        run: [started!.status, answered!.status, answered!.run_phase],
        listed: runs.out
          .trimEnd()
          .split('\n')
          .map((l) => l.split(/ {2,}/).slice(1, 3).join(' ')),
        migrated: migrated.code,
      }).toEqual({
        registered: [0, 0],
        refused: [1, ''],
        audited: 0,
        loop: 0,
        fixed: [0, 0],
        imported: 0,
        run: ['ok', 'ok', 'completed'],
        listed: ['intake v1 completed', 'tidy-notes v1 running', 'tidy-notes v1 running'],
        migrated: 0,
      });
    });
  },
);

describe('#616 PR-2c row 11 — the `npm ls` block (upgrade.md section 2)', () => {
  it('names all five packages at one version and marks each dependent’s core deduped', () => {
    const block = blocksOf('## 2. Upgrade every package together', 'text')[0] ?? '';
    const lines = block.split('\n');
    const dependents = [
      '@sensigo/realm-cli',
      '@sensigo/realm-mcp',
      '@sensigo/realm-store-sqlite',
      '@sensigo/realm-testing',
    ];
    const versions = new Set([...block.matchAll(/@sensigo\/[a-z-]+@(\S+)/g)].map((m) => m[1]));
    const opens = (name: string) => lines.findIndex((l) => l.includes(`┬ ${name}@`));
    // (a) red when a package's pair is gone, two versions show, or a dependent's core is not marked
    //     `deduped`; (b) prints the missing names and the counts.
    expect({
      versions: versions.size,
      missing: [
        ...dependents.filter((n) => opens(n) < 0),
        ...(lines.at(-1)?.startsWith('└── @sensigo/realm@') === true ? [] : ['@sensigo/realm']),
      ],
      notDeduped: dependents
        .slice(1)
        .filter((n) => !/── @sensigo\/realm@\S+ deduped$/.test(lines[opens(n) + 1] ?? '')),
      deduped: lines.filter((l) => /── @sensigo\/realm@\S+ deduped$/.test(l)).length,
    }).toEqual({ versions: 1, missing: [], notDeduped: [], deduped: 4 });
  });
});
