// snapshot.test.ts — issue #729 PR-0 (D3 A-9, §D premortem 3; Amendment 13 Q2; #715 D6-16, D6-17):
// one record and the reading it is judged at, built in ONE module.
//
// - The witness: no `{ record, at }` Snapshot literal exists outside `snapshot.ts`, which holds
//   exactly two constructors — `loadSnapshot` (its one clock reading, BEFORE the load) and
//   `writtenSnapshot` (a write's returned pair, no clock read). The instrument is exercised on text
//   that must and must not match before it is trusted.
// - Q2: a post-write reply's `basis.as_of` is the write's reading, and its `run_version` the record's.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: file
// paths, counts and instants — never a record's content.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, stampOf, writtenSnapshot } from './snapshot.js';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..', '..');

/** A `{ record, at }` object literal, shorthand or keyed, in either order. */
const SNAPSHOT_LITERAL =
  /\{\s*record(\s*:\s*[^,{}]+)?\s*,\s*at(\s*:\s*[^,{}]+)?\s*\}|\{\s*at(\s*:\s*[^,{}]+)?\s*,\s*record(\s*:\s*[^,{}]+)?\s*\}/;

/** A line of code, not of a comment (a doc comment may quote the literal it describes). */
const isCode = (line: string): boolean => !/^\s*(\*|\/\/|\/\*)/.test(line);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('#729 PR-0 — the Snapshot is built in one module', () => {
  it('the instrument: it matches every spelling of the literal, and not its neighbours', () => {
    // (a) red when the pattern stops matching a spelling the witness relies on; (b) prints which.
    const must = [
      '{ record, at }',
      '{ record: run, at: now }',
      '{ at, record }',
      '{record:r,at:a}',
    ];
    const mustNot = ['{ record, at, extra }', '{ records, at }', 'return { record };', '{ at }'];
    expect({
      matched: must.filter((t) => SNAPSHOT_LITERAL.test(t)),
      wrongly: mustNot.filter((t) => SNAPSHOT_LITERAL.test(t)),
    }).toEqual({ matched: must, wrongly: [] });
  });

  it('no `{ record, at }` literal outside snapshot.ts; snapshot.ts holds exactly its two constructors', () => {
    const files = ['core', 'cli', 'mcp-server', 'testing'].flatMap((pkg) =>
      sources(join(PACKAGES, pkg, 'src')),
    );
    const outside = files
      .filter((file) => !file.endsWith(join('engine', 'snapshot.ts')))
      .filter((file) => !file.endsWith(join('engine', 'snapshot.test.ts')))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            isCode(line) && SNAPSHOT_LITERAL.test(line)
              ? [`${relative(PACKAGES, file)}:${i + 1}`]
              : [],
          ),
      );
    const own = readFileSync(join(HERE, 'snapshot.ts'), 'utf8')
      .split('\n')
      .filter((line) => isCode(line) && SNAPSHOT_LITERAL.test(line));
    // (a) red when a Snapshot is built anywhere else, or snapshot.ts gains a third constructor;
    //     (b) prints the file:lines and the count. The denominator: the files read.
    expect({ outside, constructors: own.length, read: files.length > 600 }).toEqual({
      outside: [],
      constructors: 2,
      read: true,
    });
  });

  it('loadSnapshot reads its clock BEFORE the load — the injected reading when given', async () => {
    const T0 = new Date('2026-10-16T12:00:00.000Z');
    const record = { id: 'r', version: 4 } as unknown as RunRecord;
    // The load takes a second: the reading must be the instant BEFORE it.
    const store = {
      get: async () => {
        vi.setSystemTime(new Date(T0.getTime() + 1_000));
        return record;
      },
    };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const own = await loadSnapshot(store, 'r');
      vi.setSystemTime(T0);
      const injected = await loadSnapshot(store, 'r', {
        now: new Date('2026-01-01T00:00:00.000Z'),
      });
      // (a) red when the clock is read after the load (the reading would be T0 + 1 s), or the
      //     injected reading is ignored; (b) prints both instants.
      expect([own.at.toISOString(), injected.at.toISOString()]).toEqual([
        T0.toISOString(),
        '2026-01-01T00:00:00.000Z',
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(stampOf(writtenSnapshot(record, T0))).toEqual({
      as_of: T0.toISOString(),
      run_version: 4,
    });
  });

  it('Q2: a post-write reply’s basis.as_of is the write’s reading; its run_version the record as written', async () => {
    const store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-snapshot-729-')));
    const d: WorkflowDefinition = {
      id: 'snap',
      name: 'snap',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent', depends_on: [] },
        b: { description: 'b', execution: 'agent', depends_on: ['a'] },
      },
    };
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const now = new Date('2026-10-16T12:34:56.000Z');
    const reply = await executeStep(store, d, {
      runId: run.id,
      command: 'a',
      input: {},
      dispatcher: async () => ({}),
      now,
    });
    const written = await store.get(run.id);
    // (a) red when the reply's ways are judged at another reading (a fresh clock, a re-read); (b)
    //     prints the stamp.
    expect(reply.basis).toMatchObject({ as_of: now.toISOString(), run_version: written.version });
  });
});
