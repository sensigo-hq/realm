// foreign-test-clock-715.test.ts — #715 (a) correction 1 (C-6): a copy of a test location opened
// elsewhere, on the BUILT CLI. Every command that opens the run store refuses with one line:
// `Error: <message>`, the way out in it, no stack trace, nothing on stdout, exit code 1 — through the
// one handler at the CLI's entry (`lib/expected-refusal.ts`). `realm mcp` and `realm serve --dev`
// keep their own `realm mcp: …` / `realm serve: …` line (#620 PR-C). Deleting the copied clock file
// makes the folder an ordinary store again. (`realm workflow run` is not spawned: it refuses a
// non-terminal stdin before it opens the store.)
//
// Each child runs with a scratch HOME and a scratch working directory (`dotenv` reads `./.env`), and
// an environment of PATH and HOME only. Each assertion names (a) the change that turns it red and
// (b) what it prints: the first stderr line and the exit code, the scratch folders written `<dir>`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestLocation, type TestLocation } from '@sensigo/realm-testing';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const T = Date.parse('2033-01-02T03:04:05.000Z');

let scratch = '';
let home = '';
let source: TestLocation | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-c6-'));
  home = join(scratch, 'home');
  source = await createTestLocation({
    start: new Date(T),
    root: join(scratch, 'made-here', '.realm'),
  });
  // The copy: the location's files under another folder, where its clock file names the first.
  cpSync(source.root, join(home, '.realm'), { recursive: true });
});

afterAll(async () => {
  await source?.remove();
  rmSync(scratch, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The first stderr line and the exit code, the scratch folder written `<dir>`. */
  shown: string;
}

function realm(args: string[]): Result {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
    input: '',
  });
  const first = (r.stderr.split('\n')[0] ?? '').replaceAll(scratch, '<dir>');
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    shown: `rc ${String(r.status)}: ${first}`,
  };
}

const STACK = /^ {4}at /m;

describe('#715 (a) correction 1 (C-6) — a copied test location, on the built CLI', () => {
  it('realm run list: one Error line with the way out, no stack, nothing on stdout, exit 1', () => {
    // (a) red when the entry stops catching the refusal (the writer's fatal handler prints the stack),
    // or the message loses its way out; (b) prints the first stderr line and the exit code.
    const r = realm(['run', 'list']);
    expect(
      {
        code: r.code,
        stdout: r.stdout,
        starts: r.stderr.startsWith("Error: This store's clock file was created for"),
        wayOut: r.stderr.includes('delete its clock file'),
        stack: STACK.test(r.stderr),
      },
      r.shown,
    ).toEqual({ code: 1, stdout: '', starts: true, wayOut: true, stack: false });
  }, 20_000);

  it('realm run inspect <id>: the same line', () => {
    // (a) red as above; (b) prints the first stderr line and the exit code.
    const r = realm(['run', 'inspect', '00000000-0000-4000-8000-000000000c06']);
    expect(
      {
        code: r.code,
        stdout: r.stdout,
        starts: r.stderr.startsWith("Error: This store's clock file was created for"),
        stack: STACK.test(r.stderr),
      },
      r.shown,
    ).toEqual({ code: 1, stdout: '', starts: true, stack: false });
  }, 20_000);

  it('realm mcp and realm serve --dev keep their own one line, exit 1, no stack', () => {
    // (a) red when the hosts' own catch is bypassed or their prefix changes; (b) prints each first
    // stderr line and exit code.
    const mcp = realm(['mcp']);
    const serve = realm(['serve', '--dev', '--port', '0']);
    expect(
      {
        mcp: [
          mcp.code,
          mcp.stderr.includes("realm mcp: This store's clock file"),
          STACK.test(mcp.stderr),
        ],
        serve: [
          serve.code,
          serve.stderr.includes("realm serve: This store's clock file"),
          STACK.test(serve.stderr),
        ],
      },
      `${mcp.shown} | ${serve.shown}`,
    ).toEqual({ mcp: [1, true, false], serve: [1, true, false] });
  }, 25_000);

  it('deleting the copied clock file makes the folder an ordinary store: realm run list exits 0', () => {
    // (a) red when the way out the message names does not work; (b) prints the first stderr line and
    // the exit code. Runs last: it deletes the copy's clock file.
    unlinkSync(join(home, '.realm', '.realm-test-clock'));
    const r = realm(['run', 'list']);
    expect(r.code, r.shown).toBe(0);
  }, 20_000);
});
