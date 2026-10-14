// generate.mjs — writes printer-captures.json: each listed printer's REAL output on each FAKE case
// (cases.mjs), plus one separating row per member and structural part. Every row is executed: the local
// printers (python3, node, bash, jq, perl, PyYAML, js-yaml) run here; Go, PHP, Ruby, Rust, Java (Gson,
// Jackson, Jenkins' credentials-binding), .NET (GitHub's runner encoders, Newtonsoft, System.Text.Json,
// microsoft/security-utilities) and BusyBox run in containers pinned by digest, their programs and inputs
// sent on stdin (runtimes/mkbundle.mjs), one container at a time.
//
//   DOCKER=<docker client> node generate.mjs
//
// The Docker client defaults to `docker`. CAPTURE_RAW_DIR=<folder> keeps each container's raw output there,
// with the sha256 of the inputs it ran on, and reuses it on the next run only when today's inputs
// (`inputs.jsonl`, `inputs.b64`) hash the same; a reused capture says `(cached)` in `_generated_by`.
// FAKE values only.
/* global Buffer, console, process, URL */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANCHORS,
  JWT_TEXT,
  JWT_VALUE,
  SEPARATING,
  SINGLE,
  YAML_CASES,
  captureInputs,
  fixtureCases,
} from './cases.mjs';

const here = new URL('.', import.meta.url).pathname;
const DOCKER = process.env.DOCKER ?? 'docker';
const RAW = process.env.CAPTURE_RAW_DIR;
const OUT = join(here, 'printer-captures.json');

/** The images, each pinned by its digest. */
const IMAGES = {
  go: 'golang:1.27@sha256:e432b43af23a9328d56a7c499be0476810aa344acbcf65fc7c455d4ff5a40602',
  php: 'php:8.4-cli@sha256:1d2cf2b7d715b5b3aa959f0150ccbcc7b71e0181b637e443abf40a7fb56bf79a',
  ruby: 'ruby:4.0@sha256:0192d5244fa068587325c3ef4f886fdb2d6775689757d598f9a5261d0f86d40e',
  rust: 'rust:1.99@sha256:6ff07edce8775d0f64be7aba9197229407301bddf2054d62c27b541a6238a181',
  rust181: 'rust:1.81@sha256:7b7f7ae5e49819e708369d49925360bde2af4f1962842e75a14af17342f08262',
  java: 'eclipse-temurin:21-jdk@sha256:3e3c176ffed168beb42c607be9bc1639b466cf00261a0fb04425562c9d0c5c2b',
  dotnet:
    'mcr.microsoft.com/dotnet/sdk:10.0@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317',
  busybox: 'busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662',
};

/** What runs in each container, and which files it needs (destination: source under runtimes/). */
const CONTAINERS = {
  go: { cmd: 'cd /w && go run main.go < inputs.jsonl', files: { 'main.go': 'go/main.go' } },
  php: {
    cmd: 'cd /w && php capture.php < inputs.jsonl',
    files: { 'capture.php': 'php/capture.php' },
  },
  ruby: {
    // UTF-8 locale (Q9) and LANG=C (Q9b, the default external encoding US-ASCII).
    cmd:
      'cd /w && LANG=C.UTF-8 LC_ALL=C.UTF-8 ruby capture.rb < inputs.jsonl && ' +
      'LANG=C LC_ALL=C ruby capture.rb @C < inputs.jsonl',
    files: { 'capture.rb': 'ruby/capture.rb' },
  },
  rust: {
    cmd: 'cd /w && rustc --version >&2 && cargo run --release -q < inputs.jsonl',
    files: { 'Cargo.toml': 'rust/Cargo.toml', 'src/main.rs': 'rust/src/main.rs' },
  },
  rust181: {
    cmd: 'cd /w && rustc --version >&2 && cargo run --release -q < inputs.jsonl',
    files: { 'Cargo.toml': 'rust/Cargo.toml', 'src/main.rs': 'rust/src/main.rs' },
  },
  java: {
    cmd: 'cd /w && sh run.sh',
    files: {
      'Cap.java': 'java/Cap.java',
      'run.sh': 'java/run.sh',
      'stubs/hudson/ExtensionList.java': 'java/stubs/hudson/ExtensionList.java',
      'stubs/hudson/ExtensionPoint.java': 'java/stubs/hudson/ExtensionPoint.java',
    },
  },
  dotnet: {
    cmd: 'cd /w && sh run.sh',
    files: {
      'Program.cs': 'dotnet/Program.cs',
      'ValueEncoders.cs': 'dotnet/ValueEncoders.cs',
      'run.sh': 'dotnet/run.sh',
    },
  },
  busybox: {
    cmd: 'cd /w && sh capture.sh < inputs.b64',
    files: { 'capture.sh': 'busybox/capture.sh' },
  },
};

/** The command lines this generator runs, for `_generated_by` (no machine path in any). */
const generatedBy = ['DOCKER=<docker client> node generate.mjs'];

const work = mkdtempSync(join(tmpdir(), 'printer-captures-'));
const inputs = captureInputs();
const inputsJson = join(work, 'inputs.json');
writeFileSync(inputsJson, JSON.stringify(inputs));
// The containers read ASCII-only JSON lines: every code unit above 0x7e written as a \u escape.
const asciiJson = (o) => {
  const text = JSON.stringify(o);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code > 0x7e ? '\\u' + code.toString(16).padStart(4, '0') : text.charAt(i);
  }
  return out;
};
writeFileSync(
  join(work, 'inputs.jsonl'),
  Object.entries(inputs)
    .map(([c, v]) => asciiJson({ c, v }))
    .join('\n') + '\n',
);
// BusyBox reads `<id> <base64>`; a value holding NUL is not sent (a shell cannot hold one).
const nulCases = Object.entries(inputs)
  .filter(([, v]) => v.includes(String.fromCharCode(0)))
  .map(([c]) => c);
writeFileSync(
  join(work, 'inputs.b64'),
  Object.entries(inputs)
    .filter(([c]) => !nulCases.includes(c))
    .map(([c, v]) => `${c} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join('\n') + '\n',
);

/** The sha256 of the inputs every container reads: a cached capture is reused only on these inputs. */
const inputsHash = ['inputs.jsonl', 'inputs.b64']
  .map((f) =>
    createHash('sha256')
      .update(readFileSync(join(work, f)))
      .digest('hex'),
  )
  .join(' ');

/** Runs a local command and returns its JSON lines. */
function local(command, args, options = {}) {
  const name = command === process.execPath ? 'node' : command;
  generatedBy.push([name, ...args.map((a) => (a === inputsJson ? '<inputs.json>' : a))].join(' '));
  const out = execFileSync(command, args, {
    cwd: here,
    maxBuffer: 1 << 28,
    encoding: 'utf8',
    ...options,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Runs one container; returns its JSON lines and its stderr. */
function container(key) {
  const spec = CONTAINERS[key];
  generatedBy.push(
    `node runtimes/mkbundle.mjs '${spec.cmd}' <files> | <docker client> run -i --rm ${IMAGES[key]} sh -c 'cat > /tmp/b.sh; sh /tmp/b.sh'`,
  );
  const cached = RAW === undefined ? undefined : join(RAW, `${key}.jsonl`);
  const stamp = cached === undefined ? undefined : `${cached}.inputs.sha256`;
  if (
    cached !== undefined &&
    existsSync(cached) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').trim() === inputsHash
  ) {
    generatedBy[generatedBy.length - 1] += ' (cached)';
    return {
      lines: readFileSync(cached, 'utf8'),
      stderr: readFileSync(`${cached}.stderr`, 'utf8'),
    };
  }
  const fileArgs = Object.entries(spec.files).map(
    ([dest, src]) => `${dest}=${join(here, 'runtimes', src)}`,
  );
  fileArgs.push(
    `inputs.jsonl=${join(work, 'inputs.jsonl')}`,
    `inputs.b64=${join(work, 'inputs.b64')}`,
  );
  const bundle = execFileSync(
    process.execPath,
    [join(here, 'runtimes', 'mkbundle.mjs'), spec.cmd, ...fileArgs],
    {
      maxBuffer: 1 << 28,
    },
  );
  console.error(`container ${key}: ${IMAGES[key]}`);
  const run = spawnSync(
    DOCKER,
    ['run', '-i', '--rm', IMAGES[key], 'sh', '-c', 'cat > /tmp/b.sh; sh /tmp/b.sh'],
    {
      input: bundle,
      maxBuffer: 1 << 28,
      timeout: 30 * 60 * 1000,
    },
  );
  if (run.status !== 0) {
    throw new Error(`container ${key} exited ${run.status}: ${String(run.stderr).slice(-2000)}`);
  }
  const lines = run.stdout.toString('utf8');
  const stderr = run.stderr.toString('utf8');
  if (cached !== undefined) {
    mkdirSync(RAW, { recursive: true });
    writeFileSync(cached, lines);
    writeFileSync(`${cached}.stderr`, stderr);
    writeFileSync(stamp, inputsHash + '\n');
  }
  return { lines, stderr };
}

/** A container's output text: its UTF-16 units when it wrote them, else its UTF-8 bytes. */
function decode(row) {
  if (typeof row.u16 === 'string' && row.u16 !== '') {
    let out = '';
    for (let i = 0; i < row.u16.length; i += 4)
      out += String.fromCharCode(parseInt(row.u16.slice(i, i + 4), 16));
    return out;
  }
  return Buffer.from(row.hex ?? '', 'hex').toString('utf8');
}

/** The version in a package's own package.json, found by walking up from its resolved entry. */
function packageVersion(name) {
  let dir = new URL('.', import.meta.resolve(name));
  for (let i = 0; i < 6; i++) {
    const file = new URL('package.json', dir);
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.name === name) return pkg.version;
    }
    dir = new URL('..', dir);
  }
  return 'unknown';
}

const version = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const runtimes = {
  python: version('python3', ['--version']),
  pyyaml: `PyYAML ${version('python3', ['-c', 'import yaml; print(yaml.__version__)'])}`,
  node: `node ${process.version}`,
  jsyaml: `js-yaml ${packageVersion('js-yaml')}`,
  bash: version('bash', ['-c', 'echo bash $BASH_VERSION']),
  jq: version('jq', ['--version']),
  perl: version('perl', ['-e', 'print "perl $^V"']),
};

/** Every capture row: `{ p, c, out, runtime, key }`. */
const captured = [];
const push = (rows, key, runtime) => {
  for (const r of rows) captured.push({ ...r, key, runtime });
};

// ── Local printers ──────────────────────────────────────────────────────────────────────────────
for (const r of local('python3', ['py_capture.py', inputsJson])) {
  push(
    [r],
    'local',
    r.p.startsWith('py.yaml') ? `${runtimes.python}, ${runtimes.pyyaml}` : runtimes.python,
  );
}
for (const r of local(process.execPath, ['node_capture.mjs', inputsJson])) {
  push(
    [r],
    'local',
    r.p === 'node.jsyaml_dump_obj' ? `${runtimes.node}, ${runtimes.jsyaml}` : runtimes.node,
  );
}
for (const r of local('bash', ['shell_capture.sh', inputsJson])) {
  const runtime = r.p.startsWith('jq.')
    ? runtimes.jq
    : r.p.startsWith('perl.')
      ? runtimes.perl
      : runtimes.bash;
  push([r], 'local', runtime);
}
for (const r of local(process.execPath, ['yaml_capture.mjs'])) {
  push(
    [{ ...r, yaml: true }],
    'local',
    r.p.startsWith('py.')
      ? `${runtimes.python}, ${runtimes.pyyaml}`
      : `${runtimes.node}, ${runtimes.jsyaml}`,
  );
}
push(local(process.execPath, ['url_userinfo_capture.mjs', inputsJson]), 'local', runtimes.node);

// ── Containers ──────────────────────────────────────────────────────────────────────────────────
const images = {};
for (const key of Object.keys(CONTAINERS)) {
  const { lines, stderr } = container(key);
  const rows = lines
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const metas = rows.filter((r) => String(r.p).startsWith('meta'));
  const rustc = /rustc (\S+)/.exec(stderr)?.[1];
  const meta = metas[0] ?? {};
  const runtime =
    key === 'go'
      ? `${meta.go}`
      : key === 'php'
        ? `PHP ${meta.php}`
        : key === 'ruby'
          ? `ruby ${meta.ruby}`
          : key.startsWith('rust')
            ? `rustc ${rustc}`
            : key === 'java'
              ? `OpenJDK ${meta.java}, gson 2.14.0, jackson ${meta.jackson2} / ${meta.jackson3}, credentials-binding 728.v902a_273b_8947`
              : key === 'dotnet'
                ? `.NET ${meta.runtime} (invariant globalization), Newtonsoft ${meta.newtonsoftFile}, security-utilities ${meta.msu}`
                : `${meta.busybox}`;
  images[key] = { image: IMAGES[key], runtime };
  for (const r of rows) {
    if (String(r.p).startsWith('meta')) continue;
    let p = String(r.p).replace(/@inv$/, '');
    if (key === 'rust181') {
      // Rust 1.97 and earlier: only its `{:?}` rows, the producer of Q8L.
      if (!p.startsWith('rust.debug_')) continue;
      p = `${p}@1.81`;
    }
    if (key === 'ruby' && p.endsWith('@C') && !/^ruby\.inspect(_hash)?@C$/.test(p)) continue;
    captured.push({ p, c: r.c, out: decode(r), err: r.err ?? null, key, runtime });
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────
const cases = new Map(fixtureCases().map((c) => [c.case, c]));
const separating = new Map(SEPARATING.map((s) => [`sep_${s.member}`, s]));
const single = new Map(SINGLE.map((s) => [s.case, s]));

/**
 * The printers that write nothing for a value without their trigger, each with that rule: the only
 * empty outputs excluded. Any other empty output is a capture fault, and the generator stops.
 */
const EMPTY_WITHOUT_TRIGGER = {
  'gh.TrimDoubleQuotes': (v) => !(v.length > 8 && v.startsWith('"') && v.endsWith('"')),
  'gh.PowerShellPreAmpersandEscape': (v) => !v.includes('&'),
  'gh.PowerShellPostAmpersandEscape': (v) => !v.includes('&'),
  'jenkins.Dollar': (v) => !v.includes('$'),
  'jenkins.Batch': (v) => !v.includes('^'),
};
const rows = [];
const excluded = [];
const exclude = (r, reason) =>
  excluded.push({ printer: r.p, case: r.c, runtime: r.runtime, reason });

for (const r of captured) {
  if (separating.has(r.c) || single.has(r.c)) {
    const s = separating.get(r.c) ?? single.get(r.c);
    if (r.p !== s.printer || r.key !== (s.runtime === 'local' ? 'local' : s.runtime)) continue;
  }
  // Excluded by name.
  if (r.out === 'SKIP (NUL)') {
    exclude(r, 'problem 11: a shell cannot hold NUL');
    continue;
  }
  if (r.p === 'perl.Dumper' && r.c === 'del_e_slash') {
    exclude(r, "problem 11: Perl Data::Dumper's DEL-with-non-ASCII quirk");
    continue;
  }
  if (r.p === 'node.escape_legacy') {
    exclude(r, "problem 11: JavaScript's legacy escape() is not a printer default");
    continue;
  }
  if (r.p === 'php.var_export' && r.c === 'nul') {
    exclude(r, 'problem 11: PHP var_export of a value holding NUL');
    continue;
  }
  if (r.yaml === true && r.c === 'long_spaces') {
    exclude(r, 'problem 10: YAML folds a long spaced value across lines');
    continue;
  }
  // Excluded by rule: no printed form to check.
  if ((typeof r.err === 'string' && r.err !== '') || String(r.out).startsWith('ERROR ')) {
    exclude(r, 'the printer refused the value (an error message)');
    continue;
  }
  const meta = separating.get(r.c) ?? single.get(r.c) ?? cases.get(r.c);
  const yamlCase = r.yaml === true ? YAML_CASES[r.c] : undefined;
  const value = yamlCase !== undefined ? yamlCase[0] : meta.value;
  if (r.out === '') {
    const without = EMPTY_WITHOUT_TRIGGER[r.p];
    if (without === undefined || !without(value)) {
      throw new Error(`${r.p} x ${r.c}: an empty output where the printer writes one`);
    }
    exclude(r, 'the printer wrote nothing for this value (no form)');
    continue;
  }
  const row = {
    printer: r.p,
    case: r.c,
    value,
    output: r.out,
    source: 'executed',
    runtime: r.runtime,
    anchors: yamlCase !== undefined ? yamlCase[1] : meta.anchors,
  };
  if (meta?.lines !== undefined && yamlCase === undefined) row.lines = meta.lines;
  if (separating.has(r.c)) row.member = separating.get(r.c).member;
  rows.push(row);
}
for (const c of nulCases.filter((id) => !single.has(id))) {
  excluded.push({
    printer: 'busybox.ash_xtrace',
    case: c,
    runtime: images.busybox.runtime,
    reason: 'problem 11: a shell cannot hold NUL',
  });
}
// The JWT-like row: a 19-byte value inside a JSON object, encoded whole as base64url.
rows.push({
  printer: 'node.b64url',
  case: 'jwt_like',
  value: JWT_VALUE,
  output: Buffer.from(JWT_TEXT, 'utf8').toString('base64url'),
  source: 'executed',
  runtime: runtimes.node,
  anchors: ANCHORS,
});

// Every separating row must be there, once.
for (const s of SEPARATING) {
  const n = rows.filter((r) => r.member === s.member).length;
  if (n !== 1) throw new Error(`separating row ${s.member}: ${n} rows (expected 1)`);
}

generatedBy.push('npx prettier --write printer-captures.json');
writeFileSync(
  OUT,
  JSON.stringify({ _generated_by: generatedBy, _images: images, _excluded: excluded, rows }),
);
execFileSync('npx', ['prettier', '--write', OUT], { stdio: 'inherit' });
console.error(`rows ${rows.length}; excluded ${excluded.length}`);
