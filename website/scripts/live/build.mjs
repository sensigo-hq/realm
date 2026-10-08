// Builds the live-demo bundle: public/live/realm-demo.<sha8>.js + src/live/manifest.json.
// Flags (for the guard's fault-injection only): --omit-inject <name> (repeatable), --fixture <path>,
// --out <dir>, --manifest <path>.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIVE = ROOT + '/src/live';
const SHIMS = LIVE + '/shims';
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const omit = args.flatMap((a, i) => (args[i - 1] === '--omit-inject' ? [a] : []));
// One source: the GitHub stand-in reads the recorder's own fixture (M6).
const FIXTURE = ROOT + '/scripts/replay/github-fixture.json';
const fixture = path.resolve(opt('--fixture', FIXTURE));
const outDir = path.resolve(opt('--out', ROOT + '/public/live'));
const manifestPath = path.resolve(opt('--manifest', LIVE + '/manifest.json'));

const BUILTINS =
  /^(node:)?(fs|fs\/promises|path|os|url|util|assert|stream|events|process|constants|child_process|module|tty|net|http|https|zlib|buffer|string_decoder|worker_threads|async_hooks|readline|timers|timers\/promises|perf_hooks|v8|vm|crypto)$/;
const shims = {
  name: 'realm-demo-shims',
  setup(b) {
    b.onResolve({ filter: /^__REALM_DEMO_FIXTURE__$/ }, () => ({ path: fixture }));
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: SHIMS + '/crypto.mjs' }));
    b.onResolve({ filter: /^proper-lockfile$/ }, () => ({
      path: 'proper-lockfile',
      namespace: 'stub',
    }));
    b.onResolve({ filter: BUILTINS }, (a) => ({
      path: 'node:' + a.path.replace(/^node:/, ''),
      namespace: 'stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: `module.exports = require(${JSON.stringify(SHIMS + '/builtin-stub.cjs')})(${JSON.stringify(a.path)});`,
      loader: 'js',
      resolveDir: SHIMS,
    }));
  },
};
const injects = {
  process: 'process.mjs',
  buffer: 'buffer.mjs',
  sentinels: 'sentinels.mjs',
  fetch: 'fetch.mjs',
};
for (const o of omit) if (!(o in injects)) throw new Error('unknown inject ' + o);
const inject = Object.entries(injects)
  .filter(([k]) => !omit.includes(k))
  .map(([, f]) => SHIMS + '/' + f);

fs.rmSync(outDir, { recursive: true, force: true }); // N7: no stale hashed bundles
fs.mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [LIVE + '/engine.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  plugins: [shims],
  inject,
  loader: { '.yaml': 'text' },
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
});
// M7: the packages pin each other exactly; a partial bump would nest a second copy of the engine.
const copies = [
  ...new Set(
    Object.keys(r.metafile.inputs)
      .map((p) => /^(.*node_modules\/@sensigo\/realm)\//.exec(p)?.[1])
      .filter(Boolean),
  ),
];
if (copies.length !== 1) {
  console.log(
    'build FAILED: the bundle must hold exactly one copy of @sensigo/realm; it holds ' +
      copies.length +
      ': ' +
      copies.join(', '),
  );
  process.exit(1);
}
const code = r.outputFiles[0].contents;
const sha256 = crypto.createHash('sha256').update(code).digest('hex');
const file = `realm-demo.${sha256.slice(0, 8)}.js`;
fs.writeFileSync(outDir + '/' + file, code);
const pkgVersion = (n) =>
  JSON.parse(fs.readFileSync(ROOT + '/node_modules/' + n + '/package.json', 'utf8')).version;
const manifest = {
  file,
  realm_version: pkgVersion('@sensigo/realm'),
  sha256,
  bytes: code.length,
  gzip_bytes: zlib.gzipSync(code, { level: 9 }).length,
  sdk_version: pkgVersion('@modelcontextprotocol/sdk'),
  omitted_injects: omit,
  fixture: path.relative(ROOT, fixture),
};
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `build: ${path.relative(ROOT, outDir)}/${file} ${manifest.bytes} B min, ${manifest.gzip_bytes} B gzip, realm ${manifest.realm_version}, sdk ${manifest.sdk_version}, ${Date.now() - t0} ms`,
);
if (omit.length) console.log('build: FAULT BUILD, injects omitted:', omit.join(','));
if (manifest.fixture !== path.relative(ROOT, FIXTURE))
  console.log('build: FAULT BUILD, fixture:', manifest.fixture);
