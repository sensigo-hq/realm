// piped-exit-947.test.ts — #947: what a command wrote before it exited reaches the program reading
// its piped output, even when that reader falls behind. The writer's install sets every piped
// stdout and stderr blocking (never `realm mcp`'s channel), so a write into a full pipe waits for the
// reader instead of queueing in memory for `process.exit` to drop. Cells (1), (2) and (7) drive the
// BUILT CLI with a Python reader or client (a Node one writes asynchronously and proves nothing);
// (3) reaches the install's decision through `writerTestSeams`; (5) reads the docs page. Each
// assertion names (a) the break that turns it red and (b) what it prints when it fails: counts,
// booleans, lengths and elapsed times, never a path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writerTestSeams } from './writer.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The probe's handler (I947-PRB-04): 4,096 lines of 1,001 bytes, then a 3,000-byte unfinished
 *  line. `big` then returns; `big_fatal` leaves a throw behind, so the command ends through the
 *  writer's fatal handler (a failing step ends at `process.exit`, as `big` does). */
const EXTENSIONS = `const line = (i) => 'L' + String(i).padStart(4, '0') + 'x'.repeat(995) + '\\n';
const writeAll = () => {
  for (let i = 0; i < 4096; i++) process.stdout.write(line(i));
  process.stdout.write('T'.repeat(3000));
};
export default { handlers: {
  big: { id: 'big', execute: async () => { writeAll(); return { data: { ok: true } }; } },
  big_fatal: { id: 'big_fatal', execute: () => {
    writeAll();
    setImmediate(() => { throw new Error('fatal on purpose 947'); });
    return new Promise(() => {});
  } },
} };
`;

/** The slow reader: starts the command with its stdout on a pipe (stderr too with `combined`, else
 *  to a file), reads nothing for `delay` seconds, then reads to EOF. Writes what it read to
 *  `outpath`; prints `{ code, ended, err }`, `ended` the seconds until the command was seen gone. */
const SLOW_READ = `import json, os, subprocess, sys, tempfile, time
combined, delay, outpath, cmd = sys.argv[1] == 'combined', float(sys.argv[2]), sys.argv[3], sys.argv[4:]
r, w = os.pipe()
err = None if combined else tempfile.TemporaryFile()
start = time.monotonic()
p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=w, stderr=(w if combined else err))
os.close(w)
ended = None
while time.monotonic() - start < delay:
    if ended is None and p.poll() is not None: ended = time.monotonic() - start
    time.sleep(0.02)
data = b''
while True:
    chunk = os.read(r, 1 << 20)
    if not chunk: break
    data += chunk
code = p.wait()
if ended is None: ended = time.monotonic() - start
open(outpath, 'wb').write(data)
text = ''
if err is not None:
    err.seek(0); text = err.read().decode('utf-8', 'replace')
print(json.dumps({'code': code, 'ended': round(ended, 2), 'err': text}))
`;

/** An MCP client that writes synchronously and reads only after: `initialize` and its reply,
 *  `notifications/initialized`, then `count` `tools/list` requests (ids padded by `pad`) in one
 *  blocking write, then every reply, all within 10 s. Prints the counts as JSON. 1,000 requests
 *  padded by 200 are 267,000 bytes; each reply is about 10.7 KB, so the replies to the first pipe
 *  buffer of requests fill the server's pipe many times over. */
const MCP_BATCH = `import json, os, signal, subprocess, sys, time
count, pad, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
class Timeout(Exception): pass
def on_alarm(*_): raise Timeout()
signal.signal(signal.SIGALRM, on_alarm)
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
inp, out = p.stdin.fileno(), p.stdout.fileno()
line = lambda o: (json.dumps(o, separators=(',', ':')) + '\\n').encode()
res = {'sent': count, 'received': 0, 'timedOut': False, 'requestBytes': 0, 'replyBytes': 0}
buf = b''
start = time.monotonic()
signal.alarm(10)
try:
    os.write(inp, line({'jsonrpc': '2.0', 'id': 'init', 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'c947', 'version': '1'}}}))
    while b'\\n' not in buf:
        chunk = os.read(out, 65536)
        if not chunk: break
        buf += chunk
    buf = buf.split(b'\\n', 1)[1] if b'\\n' in buf else b''
    os.write(inp, line({'jsonrpc': '2.0', 'method': 'notifications/initialized'}))
    batch = b''.join(line({'jsonrpc': '2.0', 'id': 'r%05d-%s' % (i, 'p' * pad), 'method': 'tools/list', 'params': {}}) for i in range(count))
    res['requestBytes'] = len(batch)
    view = memoryview(batch)
    while len(view): view = view[os.write(inp, view):]
    while res['received'] < count:
        chunk = os.read(out, 1 << 20)
        if not chunk: break
        res['replyBytes'] += len(chunk)
        buf += chunk
        *done, buf = buf.split(b'\\n')
        for l in done:
            if not l: continue
            o = json.loads(l)
            if 'result' in o and str(o.get('id', '')).startswith('r'): res['received'] += 1
except Timeout:
    res['timedOut'] = True
signal.alarm(0)
res['elapsed'] = round(time.monotonic() - start, 2)
p.kill(); p.wait()
print(json.dumps(res))
`;

let root: string;
let project: string;
let slowRead: string;
let mcpBatch: string;
let outs = 0;

const flow = (name: string, handler: string): string => {
  const dir = join(project, name);
  mkdirSync(join(dir, 'fixtures'), { recursive: true });
  writeFileSync(
    join(dir, 'workflow.yaml'),
    [
      `id: ${name}`,
      `name: ${name}`,
      'version: 1',
      'extensions: ../ext.mjs',
      'steps:',
      '  s:',
      '    description: One step.',
      '    execution: auto',
      `    handler: ${handler}`,
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(dir, 'fixtures', 'big.yaml'),
    'name: big prints\nexpected:\n  final_state: completed\n',
    'utf8',
  );
  return name;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-947-'));
  mkdirSync(join(root, 'home'));
  project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'ext.mjs'), EXTENSIONS, 'utf8');
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n', 'utf8');
  flow('big', 'big');
  flow('big-fatal', 'big_fatal');
  slowRead = join(root, 'slow_read.py');
  writeFileSync(slowRead, SLOW_READ, 'utf8');
  mcpBatch = join(root, 'mcp_batch.py');
  writeFileSync(mcpBatch, MCP_BATCH, 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh HOME, no colour, nothing else from this process's environment. */
const env = (): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: join(root, 'home'),
  NO_COLOR: '1',
});

/** `realm workflow test <name>` into the slow reader (10 s before it reads). */
function testIntoSlowReader(
  name: string,
  combined: boolean,
): { code: number; ended: number; out: string } {
  outs += 1;
  const outFile = join(root, `out-${outs}.txt`);
  const r = spawnSync(
    'python3',
    [
      '-I',
      slowRead,
      combined ? 'combined' : 'split',
      '10',
      outFile,
      process.execPath,
      CLI,
      'workflow',
      'test',
      name,
      '--fixtures',
      join(name, 'fixtures'),
    ],
    { cwd: project, env: env(), encoding: 'utf8', timeout: 60_000 },
  );
  expect({ reader: r.status, error: r.error?.message }).toEqual({ reader: 0, error: undefined });
  const ran = JSON.parse(r.stdout) as { code: number; ended: number };
  return { code: ran.code, ended: ran.ended, out: readFileSync(outFile, 'utf8') };
}

const LINE = /^L\d{4}x{995}$/;
const TAIL = 'T'.repeat(3000);
/** What arrived, as counts and booleans: the handler's lines, its tail's length, the result lines. */
function shape(out: string): { lines: number; tailLength: number; pass: boolean; passed: boolean } {
  const lines = out.split('\n');
  return {
    lines: lines.filter((l) => LINE.test(l)).length,
    tailLength: (out.match(/T+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0),
    pass: lines.includes('  PASS big prints'),
    passed: lines.includes('1/1 passed'),
  };
}

describe('#947 — a piped output reaches a reader that falls behind', () => {
  it('(1) `realm workflow test` into a reader that starts 10 s late: every line, the tail and the result lines; the command waits for the reader', () => {
    // (a) red without the install's blocking call: 64 of 4,096 lines, no tail, no result lines, rc 0
    // at about a second (I947-PRB-04). (b) prints the counts, the booleans, rc and the elapsed time.
    const ran = testIntoSlowReader('big', false);
    expect(
      { code: ran.code, ...shape(ran.out), waited: ran.ended >= 10 },
      `ended after ${ran.ended} s`,
    ).toEqual({
      code: 0,
      lines: 4096,
      tailLength: 3000,
      pass: true,
      passed: true,
      waited: true,
    });
  }, 60_000);

  it('(2) the same, ending on an uncaught error: the lines, the tail, THEN the error’s text, in that order (2>&1); rc non-zero', () => {
    // (a) red without the install's blocking call: the lines are lost (the error's text can still
    // arrive, so the order and the counts are asserted, not the text alone). (b) prints counts,
    // the order as booleans, and rc.
    const ran = testIntoSlowReader('big-fatal', true);
    const { lines, tailLength } = shape(ran.out);
    const lastLine = ran.out.lastIndexOf('\nL4095');
    const tailAt = ran.out.indexOf(TAIL);
    const errorAt = ran.out.indexOf('fatal on purpose 947');
    expect(
      {
        failed: ran.code !== 0,
        lines,
        tailLength,
        tailAfterLines: lastLine >= 0 && tailAt > lastLine,
        errorAfterTail: tailAt >= 0 && errorAt > tailAt,
      },
      `rc ${ran.code}`,
    ).toEqual({
      failed: true,
      lines: 4096,
      tailLength: 3000,
      tailAfterLines: true,
      errorAfterTail: true,
    });
  }, 60_000);

  it('(3) the install’s decision per stream: a pipe or socket is set blocking once, a terminal and a stream with no handle are not, `realm mcp` touches neither', () => {
    // (a) red when the terminal guard is dropped (the terminal fake is called), and when the mode
    // guard is dropped (the `mcp` fakes are called). (b) prints each fake's calls and the outcome.
    const fake = (kind: 'pipe' | 'terminal' | 'file') => {
      const calls: unknown[][] = [];
      const handle = {
        setBlocking: (...args: unknown[]) => {
          calls.push(args);
        },
      };
      const stream =
        kind === 'file'
          ? {}
          : kind === 'terminal'
            ? { isTTY: true, _handle: handle }
            : { _handle: handle };
      return { stream, calls };
    };
    const run = (
      mode: 'default' | 'broadcast' | 'mcp',
      out: 'pipe' | 'terminal' | 'file',
      err: 'pipe' | 'terminal' | 'file',
    ) => {
      const o = fake(out);
      const e = fake(err);
      const outcome = writerTestSeams.blockPipes(mode, { stdout: o.stream, stderr: e.stream });
      return { outcome, stdoutCalls: o.calls, stderrCalls: e.calls };
    };
    expect({
      pipes: run('default', 'pipe', 'pipe'),
      broadcast: run('broadcast', 'pipe', 'pipe'),
      terminalOut: run('default', 'terminal', 'pipe'),
      fileErr: run('default', 'pipe', 'file'),
      mcp: run('mcp', 'pipe', 'pipe'),
    }).toEqual({
      pipes: {
        outcome: { stdout: 'blocking', stderr: 'blocking' },
        stdoutCalls: [[true]],
        stderrCalls: [[true]],
      },
      broadcast: {
        outcome: { stdout: 'blocking', stderr: 'blocking' },
        stdoutCalls: [[true]],
        stderrCalls: [[true]],
      },
      terminalOut: {
        outcome: { stdout: 'terminal', stderr: 'blocking' },
        stdoutCalls: [],
        stderrCalls: [[true]],
      },
      fileErr: {
        outcome: { stdout: 'blocking', stderr: 'none' },
        stdoutCalls: [[true]],
        stderrCalls: [],
      },
      mcp: { outcome: { stdout: 'mcp', stderr: 'mcp' }, stdoutCalls: [], stderrCalls: [] },
    });
  });

  it('(5) operate-runs.md says a command waits for a reader that falls behind, right after the paragraph on a handler’s programs', () => {
    // (a) red when the sentence is removed or moved. (b) prints the sentence sought and the
    // paragraph found in its place.
    const sentence =
      'When the program reading a piped output falls behind, the command waits for it instead of dropping what it wrote.';
    const paragraphs = readFileSync(join(ROOT, 'docs/guides/operate-runs.md'), 'utf8').split(
      '\n\n',
    );
    const at = paragraphs.findIndex((p) =>
      p.startsWith(
        "When the output goes to a file or a pipe, what a program started by a step's handler writes there is hidden",
      ),
    );
    const found = at >= 0 ? (paragraphs[at + 1] ?? '') : '(the paragraph before it is gone)';
    expect({ sought: sentence, found: found.slice(0, sentence.length) }).toEqual({
      sought: sentence,
      found: sentence,
    });
  });

  it('(7) `realm mcp` is not changed: a client that writes several pipe buffers of requests before it reads gets every reply', () => {
    // (a) red when mode `mcp` is set blocking too: the server blocks in its first full write, stops
    // reading, the client blocks in its own write, and the 10 s timeout fires. (b) prints replies
    // received against requests sent, the request bytes and the elapsed time.
    const r = spawnSync('python3', ['-I', mcpBatch, '1000', '200', process.execPath, CLI, 'mcp'], {
      cwd: root,
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect({ client: r.status, error: r.error?.message }).toEqual({ client: 0, error: undefined });
    const res = JSON.parse(r.stdout) as {
      sent: number;
      received: number;
      timedOut: boolean;
      requestBytes: number;
      elapsed: number;
    };
    expect(
      {
        received: res.received,
        timedOut: res.timedOut,
        severalPipeBuffers: res.requestBytes >= 256 * 1024,
      },
      `${res.received} of ${res.sent} replies, ${res.requestBytes} request bytes, ${res.elapsed} s`,
    ).toEqual({ received: 1000, timedOut: false, severalPipeBuffers: true });
  }, 60_000);
});
