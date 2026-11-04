// filter-stability-differential-3b.test.ts — caching 3-B, B6 (grade 2): a filter is STABLE in
// `FILTER_STABILITY` only if its output depends on its input alone. Every STABLE filter except the two
// named per-runner exceptions (`date`, `sort`: their per-runner cost is recorded in the prompt's
// Problems) is rendered twice, in two child processes under a different time zone, locale, clock and
// environment, from the built package, and the two outputs must be the same bytes. Each cell names
// (a) the change that turns it red and (b) what it prints: the filter names and outputs (fake values).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FILTER_STABILITY } from './render-template.js';

/** One sample per STABLE filter but `date` and `sort`: a placeholder that resolves through it. */
const SAMPLES: Record<string, string> = {
  bullets: '{{ run.params.list | bullets }}',
  join: '{{ run.params.list | join: / }}',
  default: '{{ run.params.absent | default: fallback }}',
  upper: '{{ run.params.text | upper }}',
  lower: '{{ run.params.text | lower }}',
  capitalize: '{{ run.params.word | capitalize }}',
  truncate: '{{ run.params.text | truncate: 8 }}',
  pluck: '{{ run.params.objects | pluck: x }}',
  count: '{{ run.params.list | count }}',
  limit: '{{ run.params.list | limit: 2 }}',
  compact: '{{ run.params.holes | compact }}',
  round: '{{ run.params.number | round: 2 }}',
  floor: '{{ run.params.number | floor }}',
  ceil: '{{ run.params.number | ceil }}',
  abs: '{{ run.params.negative | abs }}',
  number_format: '{{ run.params.number | number_format: 2 }}',
  percent: '{{ run.params.ratio | percent: 1 }}',
  replace: '{{ run.params.text | replace: o, 0 }}',
  yesno: '{{ run.params.flag | yesno }}',
  and_join: '{{ run.params.list | and_join }}',
  trim: '{{ run.params.text | trim }}',
  first: '{{ run.params.list | first }}',
  last: '{{ run.params.list | last }}',
  sum: '{{ run.params.numbers | sum }}',
  flatten: '{{ run.params.nested | flatten }}',
  split: '{{ run.params.csv | split: ";" }}',
  unique: '{{ run.params.repeats | unique }}',
  title: '{{ run.params.text | title }}',
  code: '{{ run.params.word | code }}',
  indent: '{{ run.params.lines | indent: 2 }}',
  duration: '{{ run.params.ms | duration }}',
};

const PARAMS = {
  list: ['beta', 'alpha', 'Ärger', 'zeta'],
  text: '  Hello wörld, İstanbul  ',
  word: 'ırmak',
  objects: [{ x: 'one' }, { x: 'two' }],
  holes: ['a', null, '', 'b'],
  number: 1234567.891,
  negative: -42.5,
  ratio: 0.12345,
  flag: true,
  numbers: [1.5, 2.25, 3],
  nested: [
    [1, 2],
    [3, [4]],
  ],
  csv: 'a;b;c',
  repeats: ['x', 'y', 'x'],
  lines: 'one\ntwo',
  ms: 3_725_000,
};

const DIST = fileURLToPath(new URL('../../dist/engine/render-template.js', import.meta.url));

/**
 * Renders every sample in a child process under `env`, at the render instant `now` (#715 (b): the
 * `time.at` a filter may read) with `Date.now` fixed there too (a filter that read the clock itself).
 */
function renderIn(env: Record<string, string>, now: number): Record<string, string> {
  const script = `
    Date.now = () => ${now};
    const { renderTemplate } = await import(${JSON.stringify(DIST)});
    const samples = JSON.parse(process.argv[1]);
    const params = JSON.parse(process.argv[2]);
    const out = {};
    for (const [name, template] of Object.entries(samples)) {
      out[name] = renderTemplate(
        template,
        { evidenceByStep: {}, runParams: params },
        { time: { at: new Date(${now}) } },
      );
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(SAMPLES), JSON.stringify(PARAMS)],
    { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' },
  );
  return JSON.parse(stdout) as Record<string, string>;
}

// Two child processes, each a Node start and one import: a budget of its own (the spawn guard).
describe(
  'caching 3-B B6 — a STABLE filter gives the same bytes on any runner',
  { timeout: 60_000 },
  () => {
    it('the samples cover every STABLE filter but the two named per-runner exceptions', () => {
      const stable = Object.entries(FILTER_STABILITY)
        .filter(([, v]) => v === 'stable')
        .map(([k]) => k)
        .filter((k) => k !== 'date' && k !== 'sort')
        .sort();
      // (a) red when a filter is classed STABLE with no sample here (or a sample names a filter that
      //     is not STABLE); (b) prints both lists.
      expect(Object.keys(SAMPLES).sort()).toEqual(stable);
    });

    it('two child processes under a different zone, locale, clock and environment render the same bytes', () => {
      const a = renderIn(
        { TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', REALM_3B_PROBE: 'one' },
        Date.UTC(2026, 0, 1),
      );
      const b = renderIn(
        {
          TZ: 'Pacific/Kiritimati',
          LANG: 'tr_TR.UTF-8',
          LC_ALL: 'tr_TR.UTF-8',
          REALM_3B_PROBE: 'two',
        },
        Date.UTC(2031, 6, 15, 13, 37),
      );
      // Every sample resolved (no placeholder left in its output), so each filter really ran.
      const unresolved = Object.entries(a)
        .filter(([, text]) => text.includes('{{'))
        .map(([name]) => name);
      expect(unresolved).toEqual([]);
      // (a) red when a STABLE filter reads the zone, the locale, the clock or the environment;
      //     (b) prints each differing filter with its two outputs.
      const differ = Object.keys(SAMPLES)
        .filter((name) => a[name] !== b[name])
        .map((name) => ({ name, a: a[name], b: b[name] }));
      expect(differ).toEqual([]);
    });
  },
);
