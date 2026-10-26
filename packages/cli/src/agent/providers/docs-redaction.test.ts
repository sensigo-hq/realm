// docs-redaction.test.ts — GHSA-gxfq Step 4: every docs sentence this change wrote about what
// `realm agent` (and a deployment manifest's builder error) hides, quoted word for word — read from
// the repository — by a cell that drives the case and asserts what the sentence states, so neither
// the page nor the behaviour can change alone. The precedent is `../docs-pages-625-agent.test.ts`.
//
// Every value is a FAKE written in this file. A failure prints booleans, counts, or the oracle's
// `{ path, decoders }` pairs — never a secret, a redaction set or an environment. Each cell names
// (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { dump as dumpYaml } from 'js-yaml';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  createDefaultRegistry,
  buildDisclosureSet,
  compileDisclosure,
  disclose,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from '../run-agent.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { LlmProvider } from './llm-provider.js';
import { sanitizeError, serializeToolResult, setAdditionalRedactionValues } from './agent-utils.js';
import { resolveManifestSecrets } from '../../extensions/manifest-secrets.js';
import {
  clearProjectExtensionsCache,
  loadProjectExtensions,
} from '../../extensions/load-project-extensions.js';
import { startAnthropicStub } from '../test-support/anthropic-stub.js';
import { makeJourneyHome } from '../test-support/composed-journey.js';
import { resolveMcpServerEntry } from '../test-support/mcp-server-entry.js';
import { leakedForms } from '../test-support/redaction-oracle.js';

/**
 * #729 PR-3 (L-5): `redactSecretValues` is gone; the loader masks a builder's error at source with
 * core's law over the values it just resolved — this exact call (`load-project-extensions.ts`,
 * `maskDeclared`): the values as declared members, the declared tier, no environment.
 */
const redactSecretValues = (message: string, values: readonly string[]): string =>
  disclose(
    message,
    compileDisclosure(
      values.map((value, i) => ({ value, source: `declared:S${i}` as const })),
      { declared: 'resolved', audience: 'log', environment: 'not_swept' },
    ).set,
    'declared',
  ).text;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../../..');
const CLI = join(HERE, '../../../dist/index.js');
const TOOLS_PAGE = 'docs/guides/agent-tools.md';
const ENV_PAGE = 'docs/reference/environment-and-files.md';
const MANIFEST_PAGE = 'docs/reference/deployment-manifest.md';
const BS = '\\';
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/**
 * Stubs every environment key except HOME to `undefined` (restored by `vi.unstubAllEnvs()`), so a
 * host's environment cannot change a cell's redaction set.
 */
function isolateEnv(): void {
  for (const key of Object.keys(process.env)) if (key !== 'HOME') vi.stubEnv(key, undefined);
}

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
    `${page} no longer says: ${sentence}`,
  ).toBe(true);
}

/** One row of the printers' REAL output (`../test-support/printer-captures/printer-captures.json`). */
interface CaptureRow {
  printer: string;
  case: string;
  value: string;
  output: string;
  source: string;
  anchors: string[];
  lines?: string[];
}
const CAPTURES = (
  JSON.parse(
    readFileSync(join(HERE, '../test-support/printer-captures/printer-captures.json'), 'utf8'),
  ) as { rows: CaptureRow[] }
).rows;

/** One EXECUTED fixture row; throws when the fixture lacks it. */
function captured(printer: string, kase: string): CaptureRow {
  const row = CAPTURES.find((r) => r.printer === printer && r.case === kase);
  if (row === undefined || row.source !== 'executed') {
    throw new Error(`fixture: no executed ${printer} x ${kase} row`);
  }
  return row;
}

/**
 * One EXECUTED fixture row per family the two pages name: `[family, printer, case]`, each a
 * printer's real output on a FAKE value. Where a row is a member's separating row (`sep_<id>`), it
 * goes red when that member is removed (`redaction-printers.test.ts`, P2); each other row's own
 * break is named in the cells below.
 */
const FAMILIES: Array<[family: string, printer: string, kase: string]> = [
  ['JSON-escaped', 'node.JSON.stringify', 'dq_bs'],
  ['every non-ASCII character as \\uXXXX', 'py.json_dumps', 'e_acute'],
  ['inside another JSON string', 'py.json_dumps_twice', 'e_acute'],
  ["Python's repr()", 'py.repr', 'sep_Q1'],
  ["Node's console.log of an object", 'node.inspect_obj', 'c0b'],
  ['quotes doubled (CSV)', 'py.csv', 'sep_S6'],
  ['quotes doubled (YAML)', 'py.yaml_safe_dump_dict', 'sep_S5'],
  ['shell-quoted', 'bash.xtrace', 'sep_S1'],
  ['HTML entities', 'py.html_escape', 'sep_X3'],
  ['XML entities', 'py.sax_escape', 'sep_X1'],
  ['URL-encoded', 'node.encodeURIComponent', 'sep_U1'],
  ['base64', 'py.b64', 'sep_B1'],
  ['base64url', 'node.b64url', 'sep_B2'],
  ['hex', 'py.hex', 'sep_B3'],
];

/**
 * What a family check prints: the family, whether the marker is there, and the oracle's pairs for
 * the row's anchors and lines — never a value or an anchor's text.
 */
function familyVerdict(family: string, row: CaptureRow, out: string, marker: string) {
  const checks = [...row.anchors, ...(row.lines ?? [])];
  return {
    family,
    marker: out.includes(marker),
    leaks: checks.flatMap((x) => leakedForms(out, x)),
  };
}
const HIDDEN_FAMILIES = FAMILIES.map(([family]) => ({ family, marker: true, leaks: [] }));

/** The forms list both pages carry, one bullet per family, each naming the printers that write it. */
const FORMS_BULLETS = [
  "- JSON-escaped, as JavaScript's `JSON.stringify`, Python's `json.dumps` (every non-ASCII character as `\\uXXXX`), Go's `json.Marshal`, PHP's `json_encode` (without its `JSON_HEX_…` flags), Perl's `JSON::PP`, jq's `tojson`, Newtonsoft.Json, Gson, System.Text.Json and Jackson write it, and inside another JSON string;",
  "- in quotes with backslash escapes, as Python's `repr()`, `ascii()`, `unicode_escape` and `repr()` of bytes, Node's `util.inspect` (`console.log` of an object), PHP's `var_export` and `addslashes`, Perl's `Data::Dumper`, Go's `%q`, `%#v` and `%+q`, Rust's `{:?}` and `escape_default()`, Ruby's `inspect`, PyYAML's and js-yaml's double-quoted strings, Windows argument quoting (Python's `subprocess.list2cmdline`) and bash's `declare -p` write it, and with each `\"` written `\\\"`;",
  "- shell-quoted, as bash's xtrace, `${v@Q}` and `printf %q`, jq's `@sh`, Python's `shlex.quote` and BusyBox ash's xtrace write it; and with each `'` doubled (YAML single-quoted strings, SQL quoting), each `\"` doubled (CSV quoting) or each `$` doubled (Makefiles, Compose files);",
  "- with HTML or XML escaping, as Python's `html.escape` and `xml.sax.saxutils`, .NET's `SecurityElement.Escape`, jq's `@html`, lodash's `_.escape`, Ruby's `CGI.escapeHTML`, Go's `html.EscapeString` and PHP's `htmlspecialchars` write it;",
  "- percent-encoded with upper-case hex, as JavaScript's `encodeURIComponent` and `encodeURI`, Node's `querystring.escape`, `URLSearchParams` and `URL`, Python's `quote`, `quote_plus` and `urlencode`, Java's `URLEncoder`, jq's `@uri`, PHP's `urlencode` and Go's `url.QueryEscape`, `url.PathEscape` and `url.UserPassword` write it;",
  "- in base64 and base64url, also when other text was encoded with it (the forms GitHub's runner and Jenkins mask, and, when its base64 ends in `=` padding, each without its last character), and in lower- or upper-case hex.",
];

/** Runs one agent step whose prompt is `template`, with a stand-in model; returns the prompt it got. */
async function promptSent(
  template: string,
  params: Record<string, unknown>,
  declared: string[],
): Promise<string> {
  const prompts: string[] = [];
  const provider = new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta(prompt: string) {
      prompts.push(prompt);
      return { output: { summary: 'ok' } } as never;
    }
  })();
  const definition = {
    id: 'docs-redaction',
    name: 'Docs redaction',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: { description: 'Ask', execution: 'agent', prompt: template } },
  } as WorkflowDefinition;
  const result = await runAgent(
    {
      store: new InMemoryStore(),
      workflowStore: {
        register: async () => {},
        get: async () => definition,
        list: async () => [definition],
      } as never,
      provider,
      registry: createDefaultRegistry(),
      redactionValues: declared,
    },
    { definition, params },
  );
  // Witness: the step ran and the model was asked once. (b) prints the result and the count.
  expect({ result, calls: prompts.length }).toEqual({ result: 'completed', calls: 1 });
  return prompts[0]!;
}

afterEach(() => {
  setAdditionalRedactionValues([]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe(`${TOOLS_PAGE} — what realm agent replaces (GHSA-gxfq)`, () => {
  it('environment values and declared secrets: in tool results, error messages and the prompt', async () => {
    claim(
      TOOLS_PAGE,
      '`realm agent` replaces the values of its environment variables, and the secrets the manifest declares, with `[REDACTED]`: in tool results and in error messages, both in what it records and in what it shows the model, and in the prompt the agent step sends the model.',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ENV = 'docs-env-fake-value-1';
    const DECLARED = 'docs-declared-fake-2';
    vi.stubEnv('DOCS_REDACTION_ENV', ENV);
    setAdditionalRedactionValues([DECLARED]);
    const text = `${ENV} and ${DECLARED}`;
    const toolResult = serializeToolResult({ t: text });
    const error = sanitizeError(new Error(text));
    const prompt = await promptSent('Use {{ run.params.t }}.', { t: text }, [DECLARED]);
    const gone = (s: string) => ({ env: !s.includes(ENV), declared: !s.includes(DECLARED) });
    // (a) red when either value reaches a tool result, an error message or the prompt. (b) prints,
    //     per surface, whether each value is gone.
    expect({ toolResult: gone(toolResult), error: gone(error), prompt: gone(prompt) }).toEqual({
      toolResult: { env: true, declared: true },
      error: { env: true, declared: true },
      prompt: { env: true, declared: true },
    });
  });

  it("the home folder: the example's error, hidden from the agent and a log at 8 or more characters, shown in the export (correction 1)", () => {
    claim(TOOLS_PAGE, "Here it replaced the home folder's path.");
    claim(
      TOOLS_PAGE,
      '`realm run export` writes them masked too, except that the export file shows your home folder and user name, which the agent and a log hide when they are 8 or more characters long.',
    );
    const shownTo = (audience: 'agent' | 'log' | 'file', home: string, text: string) =>
      disclose(
        text,
        buildDisclosureSet({
          env: { HOME: home, USER: home.split('/').at(-1) ?? '' },
          declared: {},
          declaredState: 'resolved',
          audience,
        }).set,
        'all',
      ).text;
    const HOME = '/home/fake-docs-user';
    const error = `ENOENT: no such file or directory, scandir '${HOME}/notes/notes'`;
    // (a) red when the agent or a log stops hiding a home folder of 8 or more characters, the
    //     export starts hiding it, or a shorter one is hidden; (b) prints the shown texts (fake).
    expect({
      agent: shownTo('agent', HOME, error),
      log: shownTo('log', HOME, `at ${HOME}/x by fake-docs-user`),
      file: shownTo('file', HOME, `at ${HOME}/x by fake-docs-user`),
      short: shownTo('agent', '/h/u', 'at /h/u/x'),
    }).toEqual({
      agent: "ENOENT: no such file or directory, scandir '[REDACTED]/notes/notes'",
      log: 'at [REDACTED]/x by [REDACTED]',
      file: 'at /home/fake-docs-user/x by fake-docs-user',
      short: 'at /h/u/x',
    });
  });

  it("a run's params are kept as given in the run's file; realm run export masks them", async () => {
    claim(
      TOOLS_PAGE,
      "A run's params are kept as given in the run's file; `realm run export` writes them masked too, except that the export file shows your home folder and user name, which the agent and a log hide when they are 8 or more characters long.",
    );
    claim(
      MANIFEST_PAGE,
      "Values are not recorded there (a value passed as a run's param is kept: see [Give an agent step tools](../guides/agent-tools.md#4-read-what-was-recorded)).",
    );
    claim(
      'docs/guides/deploy.md',
      "The token is not in the manifest block of the run's record (a value passed as a run's param is kept: see [Give an agent step tools](agent-tools.md#4-read-what-was-recorded)).",
    );
    const SECRET = 'docs-param-fake-secret-31';
    const home = makeJourneyHome('realm-docs-params-');
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    const originalBaseUrl = process.env['ANTHROPIC_BASE_URL'];
    // The model looks up a workflow named by the secret; the tool's polite failure quotes it.
    const stub = await startAnthropicStub({
      firstToolCall: { match: /get_workflow_protocol/, arguments: { workflow_id: SECRET } },
      finalContent: { summary: 'looked it up' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'fake-docs-redaction-key-0000';
    process.env['ANTHROPIC_BASE_URL'] = stub.baseUrl;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const definition = {
        id: 'docs-redaction-params',
        name: 'Docs redaction params',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        mcp_servers: [
          {
            id: 'realm',
            transport: 'stdio',
            command: process.execPath,
            args: [resolveMcpServerEntry()],
            env: { HOME: home },
          },
        ],
        steps: {
          ask: {
            description: 'Look the key up',
            execution: 'agent',
            depends_on: [],
            tools: ['realm:get_workflow_protocol'],
            prompt: 'Look up the workflow {{ run.params.key }}.',
            input_schema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
              required: ['summary'],
            },
          },
        },
      } as unknown as WorkflowDefinition;
      const runsDir = join(home, '.realm', 'runs');
      const store = new JsonFileStore(runsDir);
      const workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
      await workflowStore.register(definition);
      const result = await runAgent(
        {
          store,
          workflowStore,
          provider: new AnthropicProvider('claude-sonnet-4-5'),
          registry: new ExtensionRegistry(),
          redactionValues: [SECRET],
        },
        { definition, params: { key: SECRET }, pollIntervalMs: 50 },
      );
      const runId = (await store.list())[0]?.id ?? '';
      // What the model is SHOWN for the tool result: the tool_result block of the second request
      // (the tool_use arguments echo the secret by design, so the block, not the whole request).
      const second = (stub.requests[1] ?? {}) as { messages?: Array<{ content?: unknown }> };
      const shownBlocks = (second.messages ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : []))
        .filter((b) => (b as { type?: unknown }).type === 'tool_result')
        .map((b) => JSON.stringify((b as { content?: unknown }).content ?? ''))
        .join(' ');
      const runFile = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), 'utf8')) as RunRecord;
      const out = join(home, 'bundle.json');
      // #729 PR-3: export masks with what it knows; the value is in its environment here, and the
      // run has no project (so its declared secrets are unknown, which the flag accepts).
      const exported = spawnSync(
        process.execPath,
        [CLI, 'run', 'export', runId, '--out', out, '--accept-partial-disclosure'],
        {
          cwd: home,
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: home,
            NO_COLOR: '1',
            DOCS_PARAM_ENV: SECRET,
            REALM_NOT_SECRET: 'HOME',
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      const bundle = JSON.parse(readFileSync(out, 'utf8')) as { run: RunRecord };
      const calls = runFile.evidence.flatMap((snap) => snap.tool_calls ?? []);
      const recorded = calls.map((c) => `${c.result ?? ''} ${c.error ?? ''}`).join(' ');
      // (a) red when the params are redacted in the record, or kept in the export (#729 PR-3), when
      //     the prompt keeps the secret (the wrap at the prompt's assignment removed),
      //     or when the recorded tool result keeps it. (b) prints the facts, never the secret.
      expect({
        result,
        exportCode: exported.status,
        paramInRunFile: runFile.params['key'] === SECRET,
        paramMaskedInExport: bundle.run.params['key'] === '[REDACTED]',
        promptHidesIt: !JSON.stringify(stub.requests[0] ?? {}).includes(SECRET),
        oneToolCall: calls.length,
        recordedResultMarked: recorded.includes('[REDACTED]'),
        recordedResultHidesIt: !recorded.includes(SECRET),
        shownResultMarked: shownBlocks.includes('[REDACTED]'),
        shownResultHidesIt: !shownBlocks.includes(SECRET),
      }).toEqual({
        result: 'completed',
        exportCode: 0,
        paramInRunFile: true,
        paramMaskedInExport: true,
        promptHidesIt: true,
        oneToolCall: 1,
        recordedResultMarked: true,
        recordedResultHidesIt: true,
        shownResultMarked: true,
        shownResultHidesIt: true,
      });
    } finally {
      await stub.close();
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
      if (originalBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = originalBaseUrl;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it('the forms these programs print them in: one executed printer row per family', () => {
    claim(
      TOOLS_PAGE,
      "Here it replaced the home folder's path. A run's params are kept as given in the run's file; `realm run export` writes them masked too, except that the export file shows your home folder and user name, which the agent and a log hide when they are 8 or more characters long. It also replaces each value in the forms these programs print it in:",
    );
    for (const bullet of FORMS_BULLETS) claim(TOOLS_PAGE, bullet);
    isolateEnv();
    const verdicts = FAMILIES.map(([family, printer, kase]) => {
      const row = captured(printer, kase);
      setAdditionalRedactionValues([row.value]);
      return familyVerdict(family, row, serializeToolResult({ text: row.output }), '[REDACTED]');
    });
    // (a) red when a family's form leaves the list: each `sep_<id>` row under its member's removal
    //     (Q1, S6, S5, S1, X3, X1, U1, B1, B2, B3); `py.json_dumps_twice` under E1 and E2 together;
    //     `node.inspect_obj` x `c0b` under Q4. The JSON-escaped and `\uXXXX` rows are written by
    //     several members and the E1 layer: no single removal turns them red. (b) prints, per
    //     family, the marker and the oracle's pairs.
    // The same rows with the value in the environment and nothing declared (no parts).
    const envVerdicts = FAMILIES.map(([family, printer, kase]) => {
      const row = captured(printer, kase);
      setAdditionalRedactionValues([]);
      vi.stubEnv('DOCS_REDACTION_FAMILY_ENV', row.value);
      return familyVerdict(family, row, serializeToolResult({ text: row.output }), '[REDACTED]');
    });
    expect({ declared: verdicts, environment: envVerdicts }).toEqual({
      declared: HIDDEN_FAMILIES,
      environment: HIDDEN_FAMILIES,
    });
  });

  it("the forms bullets' qualifiers: json_encode without its JSON_HEX flags; a trimmed base64 form only when padded", () => {
    for (const bullet of FORMS_BULLETS.filter(
      (b) => b.includes('JSON_HEX') || b.includes('padding'),
    )) {
      claim(TOOLS_PAGE, bullet);
    }
    isolateEnv();
    // PHP's `json_encode` writes `/` as `\/` by default; with `JSON_HEX_QUOT` it also writes `"`
    // as the six-character escape backslash, `u`, `0022` (real PHP 8.4). The value: `"`, `\` and
    // `/`.
    const V = 'Hq7Kd' + '"' + 'Zp9Wm' + BS + 'Rt4Lx/Bv2Nc=Jy8Ts';
    const phpDefault = '"Hq7Kd' + BS + '"Zp9Wm' + BS + BS + 'Rt4Lx' + BS + '/Bv2Nc=Jy8Ts"';
    const phpHexQuot =
      '"Hq7Kd' + BS + 'u' + '0022' + 'Zp9Wm' + BS + BS + 'Rt4Lx' + BS + '/Bv2Nc=Jy8Ts"';
    setAdditionalRedactionValues([V]);
    const hidden = (printed: string): boolean =>
      !serializeToolResult(printed).includes('Zp9Wm') &&
      serializeToolResult(printed).includes('[REDACTED]');
    // A value of 12 bytes has unpadded base64; one of 11 bytes, padded.
    const UNPADDED = 'FAKEpd9xyz12';
    const PADDED = 'FAKEpd9xyz1';
    const trimmedHidden = (value: string): boolean => {
      setAdditionalRedactionValues([value]);
      const encoded = Buffer.from(value).toString('base64');
      const trimmed = encoded.slice(0, -1);
      const out = serializeToolResult(`see ${trimmed} here`);
      return !out.includes(trimmed.slice(0, 8)) && out.includes('[REDACTED]');
    };
    // (a) red when a docs flip drops a qualifier (each `claim`), when PHP's default output stops
    //     being hidden or its `JSON_HEX_QUOT` output starts being hidden (the bullet would then say
    //     less than the code), or when the trimmed form of an unpadded base64 starts being hidden,
    //     or that of a padded one stops; (b) prints the facts.
    expect({
      phpDefaultHidden: hidden(phpDefault),
      phpHexQuotShown: !hidden(phpHexQuot),
      paddedTrimmedHidden: trimmedHidden(PADDED),
      unpaddedTrimmedShown: !trimmedHidden(UNPADDED),
      padding: [
        Buffer.from(PADDED).toString('base64').endsWith('='),
        Buffer.from(UNPADDED).toString('base64').endsWith('='),
      ],
    }).toEqual({
      phpDefaultHidden: true,
      phpHexQuotShown: true,
      paddedTrimmedHidden: true,
      unpaddedTrimmedShown: true,
      padding: [true, false],
    });
  });

  it('for every value: the value with its JSON-style escapes read, and each line of that', () => {
    claim(
      TOOLS_PAGE,
      'For every value, it also hides, in the same forms, the value with these escapes read, when that has 8 or more characters: `\\n`, `\\r`, `\\t`, `\\b`, `\\f`, `\\/`, `\\\\`, `\\"`, `\\uXXXX` and `\\xHH` (a value that ends in a lone `\\` has no such reading); and each line of that which has 8 or more characters and no spaces or other blank characters.',
    );
    isolateEnv();
    // A key written on one line with `\n`, as an ENVIRONMENT value (no parts), printed after a
    // program read its escapes: whole, and one line of it alone.
    const BODY = 'FAKEdocsBodyLine0123456789abcdef';
    vi.stubEnv('DOCS_REDACTION_ONE_LINE', ['fake-docs-key', BODY, 'fake-docs-end'].join(BS + 'n'));
    const whole = serializeToolResult({ t: ['fake-docs-key', BODY, 'fake-docs-end'].join('\n') });
    const line = serializeToolResult({ t: `see ${BODY} here` });
    // A value that ends in a lone `\` has no escapes-read form: printed read, in an error, it shows.
    vi.stubEnv('DOCS_REDACTION_TRAILING', 'FAKEtrail' + BS + 'n' + 'line22x' + BS);
    const trailing = sanitizeError(new Error('key: FAKEtrail\nline22x' + BS));
    // A line of the read value that holds blanks is not hidden on its own.
    vi.stubEnv(
      'DOCS_REDACTION_BLANK_LINE',
      ['fake-docs-key', 'a read line 0123', 'fake-docs-end'].join(BS + 'n'),
    );
    const blankLine = sanitizeError(new Error('see a read line 0123 here'));
    // (a) red when the D layer is removed, or its lines, or when a value ending in a lone `\` gets
    //     a reading, or a read line with blanks is listed. (b) prints four booleans.
    expect({
      wholeHidden: !whole.includes(BODY) && whole.includes('[REDACTED]'),
      lineHidden: line === JSON.stringify({ t: 'see [REDACTED] here' }),
      trailingBackslashShown: trailing.includes('line22x'),
      blankReadLineShown: blankLine === 'see a read line 0123 here',
    }).toEqual({
      wholeHidden: true,
      lineHidden: true,
      trailingBackslashShown: true,
      blankReadLineShown: true,
    });
  });

  it('each line of 8+ characters with no blanks is hidden on its own, everywhere', () => {
    claim(
      TOOLS_PAGE,
      'Each line of a multi-line value that has 8 or more characters and no spaces or other blank characters is hidden on its own, everywhere. So a declared credentials file also hides lines such as `region=us-east-1`. A line with blanks, such as `key = value`, is not hidden on its own.',
    );
    setAdditionalRedactionValues([
      '[default]\naws_access_key_id = FAKEKEYID0000\naws_secret_access_key=fakeSecretKey0000\nregion=us-east-1\nab=c',
    ]);
    const out = serializeToolResult({
      t: 'deploy region=us-east-1 using aws_secret_access_key=fakeSecretKey0000; aws_access_key_id = FAKEKEYID0000; ab=c',
    });
    // (a) red when LINES is removed (the first two), or the lines' floor or blank rule (the last
    //     two: `spacedLineKept` is the `key = value` sentence's fact). (b) prints the four facts.
    expect({
      regionHidden: !out.includes('region=us-east-1'),
      keyLineHidden: !out.includes('aws_secret_access_key=fakeSecretKey0000'),
      spacedLineKept: out.includes('aws_access_key_id = FAKEKEYID0000'),
      shortLineKept: out.includes('ab=c'),
    }).toEqual({
      regionHidden: true,
      keyLineHidden: true,
      spacedLineKept: true,
      shortLineKept: true,
    });
  });

  it('the parts of a declared secret are hidden on their own, at their floors', () => {
    claim(
      TOOLS_PAGE,
      'For a declared secret, some parts of it are also hidden on their own, everywhere: the value without the double quotes around it, when the quoted value has more than 8 characters; the part up to and including its last `&` (or its first `&+`, when it has one), and the part after it, when that part has 6 or more characters (after `&+`, the part starts at the second character after the `+`, and it is hidden when it has 6 or more characters from there); and the value with `\\\\`, `\\\'`, `\\"` and `\\t` read, or with each `\\` dropped, or with each `^` dropped (a doubled one kept once; not both at once), when that has 8 or more characters.',
    );
    /**
     * Whether `part`, in an unrelated tool result, is hidden with only `declared` declared. The
     * result is parsed first: its JSON text writes a tab as `\t`, so a raw search could not fail.
     */
    const hides = (declared: string, part: string): boolean => {
      setAdditionalRedactionValues([declared]);
      const out = JSON.parse(serializeToolResult({ t: `see ${part} here` })) as { t: string };
      return !out.t.includes(part);
    };
    const facts = {
      // At the floor: a quoted value of 9 characters (more than 8); sections of 6 characters,
      // counting the `&`; a value of 8 characters once its escapes are read. Each part is one no
      // other form of the value writes: `\"` read as `"` would be JSON's own form of the value,
      // hidden whatever the parts, so one backslash case reads `\q` (each `\` dropped, Jenkins)
      // and the other `\'` with `\t` (Azure Pipelines reads both; JSON writes the tab back as
      // `\t` but the quote without its backslash).
      unquoted: hides('"fkQv9xz"', 'fkQv9xz'),
      beforeAmp: hides('fkA1x&fkB2y9', 'fkA1x&'),
      afterAmp: hides('fkA1x&fkB2y9', 'fkB2y9'),
      backslashRead: hides(`fkH${BS}qad9x`, 'fkHqad9x'),
      backslashTabRead: hides(`fkH${BS}'a${BS}td9`, "fkH'a\td9"),
      caretRead: hides('fkH^^ad9x', 'fkH^ad9x'),
      // Each kind dropped alone is hidden; both dropped at once is not.
      backslashDroppedOfBoth: hides(`fkH${BS}qa^d9xy`, 'fkHqa^d9xy'),
      caretDroppedOfBoth: hides(`fkH${BS}qa^d9xy`, `fkH${BS}qad9xy`),
      bothDropped: hides(`fkH${BS}qa^d9xy`, 'fkHqad9xy'),
      // One character under each floor: kept.
      unquotedUnder: hides('"fkQv9x"', 'fkQv9x'),
      beforeAmpUnder: hides('fkA1&fkB2y9', 'fkA1&'),
      backslashReadUnder: hides(`fk${BS}qad9x`, 'fkqad9x'),
      // After `&+`, the hidden part starts one character later.
      afterAmpPlus: (() => {
        setAdditionalRedactionValues(['fkA1x&+zfkB2y9']);
        return serializeToolResult({ t: 'see zfkB2y9 here' }).includes('see z[REDACTED] here');
      })(),
    };
    // An environment value is not hidden by its parts; a value both declared and in the
    // environment is.
    setAdditionalRedactionValues([]);
    vi.stubEnv('DOCS_REDACTION_PARTS_ENV', 'fkA1x&fkB2y9');
    const envOnlyHidesPart = !serializeToolResult({ t: 'see fkA1x& here' }).includes('fkA1x&');
    setAdditionalRedactionValues(['fkA1x&fkB2y9']);
    const bothHidesPart = !serializeToolResult({ t: 'see fkA1x& here' }).includes('fkA1x&');
    // (a) red when a part member leaves the list (G1 → `unquoted`, G2 → `beforeAmp`, G3 →
    //     `afterAmp` and `afterAmpPlus`, I3 → `backslashRead`, I1 → `backslashTabRead`, I4 →
    //     `caretRead`), when both kinds start being dropped at once (`bothDropped`), when a floor
    //     is lowered (the `…Under` facts), when `redactionSet()`
    //     passes `parts` for an environment value (`envOnlyHidesPart`), or drops it for a
    //     declared one (`bothHidesPart`). (b) prints the facts.
    expect({ ...facts, envOnlyHidesPart, bothHidesPart }).toEqual({
      unquoted: true,
      beforeAmp: true,
      afterAmp: true,
      backslashRead: true,
      backslashTabRead: true,
      caretRead: true,
      backslashDroppedOfBoth: true,
      caretDroppedOfBoth: true,
      bothDropped: false,
      unquotedUnder: false,
      beforeAmpUnder: false,
      backslashReadUnder: false,
      afterAmpPlus: true,
      envOnlyHidesPart: false,
      bothHidesPart: true,
    });
  });

  it('leaves alone an environment value of 7 characters or fewer, and a declared secret of 3 or fewer, and says so of the secret', async () => {
    claim(
      TOOLS_PAGE,
      '- an environment value of seven characters or fewer, and a declared secret of three or fewer (`realm agent` says so when it loads such a secret);',
    );
    // #729 PR-3: the environment floor is 8 characters (the owner's Q2).
    vi.stubEnv('DOCS_REDACTION_SHORT_ENV', 'q7z2x8w');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The declared values come through the real loader of a deployment manifest, whose filter keeps
    // values of 4 characters or more — the feed `realm agent` hands the redaction set.
    clearProjectExtensionsCache();
    const root = mkdtempSync(join(tmpdir(), 'realm-docs-redaction-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(
        join(root, 'dist', 'factories.js'),
        'export function handlerFactory({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n',
        'utf8',
      );
      writeFileSync(join(root, '.env'), 'TINY=k9w\nFOUR=m3x8\n', 'utf8');
      writeFileSync(
        join(root, 'realm.yaml'),
        'version: 1\nhandlers:\n  h1:\n    use: ./dist/factories.js#handlerFactory\n    config: { a: "${secret:TINY}", b: "${secret:FOUR}" }\n',
        'utf8',
      );
      const definition = {
        id: 'docs-redaction-manifest',
        name: 'Docs redaction manifest',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { s1: { description: 'step', execution: 'agent' } },
        origin: 'human',
        source_dir: root,
        trust_root: root,
      } as WorkflowDefinition;
      const loaded = await loadProjectExtensions(definition);
      setAdditionalRedactionValues(loaded.secretValues ?? []);
      const out = serializeToolResult({ t: 'q7z2x8w k9w m3x8' });
      const warnings = warned.mock.calls.map((c) => String(c[0]));
      // (a) red when a 7-character environment value or a 3-character declared value enters the
      //     set (the first two), a 4-character declared value leaves it (the third), or the load
      //     stops saying so of the short secret (I8; the fourth). (b) prints the four facts.
      expect({
        shortEnvKept: out.includes('q7z2x8w'),
        threeCharDeclaredKept: out.includes('k9w'),
        fourCharDeclaredHidden: !out.includes('m3x8'),
        // #729 PR-3 correction 1 (F37): the warning names the manifest and the key that refers to it.
        saidOfTheShortSecret: warnings.some((w) =>
          w.includes(
            `Secret 'TINY' (in ${join(root, 'realm.yaml')}, at handlers.h1.config.a) is shorter than 4`,
          ),
        ),
      }).toEqual({
        shortEnvKept: true,
        threeCharDeclaredKept: true,
        fourCharDeclaredHidden: true,
        saidOfTheShortSecret: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      clearProjectExtensionsCache();
    }
  });

  it('leaves alone, in base64 and base64url, a value of 6 bytes or fewer encoded with other text', () => {
    claim(
      TOOLS_PAGE,
      '- in base64 and base64url, a value of 6 bytes or fewer that was encoded together with other text (it is hidden at some positions and not at others);',
    );
    isolateEnv();
    const SIX = `Ab1"x${BS}`;
    const SEVEN = `Ab1"x${BS}9`;
    setAdditionalRedactionValues([SIX, SEVEN]);
    const enc = (text: string, url: boolean): string =>
      serializeToolResult({ t: Buffer.from(text).toString(url ? 'base64url' : 'base64') });
    // (a) red when a 6-byte value encoded after a 1-byte prefix and before a `}` is hidden (a
    //     6-byte form below the floor), when a 7-byte value at that position is left (Jenkins'
    //     `a` form removed), or when a 6-byte value alone, or after a 3-byte prefix, stops being
    //     hidden. (b) prints the facts.
    expect({
      bytes: [Buffer.byteLength(SIX), Buffer.byteLength(SEVEN)],
      sixAloneHidden: leakedForms(enc(SIX, false), SIX).length === 0,
      sixPrefixedLeftAlone: leakedForms(enc(`a${SIX}}`, false), SIX).length > 0,
      sixPrefixedUrlLeftAlone: leakedForms(enc(`a${SIX}}`, true), SIX).length > 0,
      sixAfterThreeHidden: leakedForms(enc(`abc${SIX}\n`, false), SIX).length === 0,
      sevenPrefixedHidden: leakedForms(enc(`a${SEVEN}\n`, false), SEVEN).length === 0,
    }).toEqual({
      bytes: [6, 7],
      sixAloneHidden: true,
      sixPrefixedLeftAlone: true,
      sixPrefixedUrlLeftAlone: true,
      sixAfterThreeHidden: true,
      sevenPrefixedHidden: true,
    });
  });

  it('leaves alone a value split across lines: base64 at 76 characters, YAML folded', () => {
    claim(
      TOOLS_PAGE,
      '- a value split across lines by the program that printed it, for example base64 wrapped at 76 characters, or a long YAML string folded at its spaces or after an escaped character; a multi-line value written one line at a time keeps its lines that hold blanks;',
    );
    const SECRET = 'docs-split-secret-value-0123456789-docs-split-secret-value-0123456789';
    const encoded = Buffer.from(SECRET).toString('base64');
    const wrapped = `${encoded.slice(0, 76)}\n${encoded.slice(76)}`;
    const SPACED = `fake ${'word0123 '.repeat(9)}ends`;
    setAdditionalRedactionValues([SECRET, SPACED]);
    const folded = dumpYaml({ note: SPACED });
    // Witness: base64 wraps inside the value, whole the same base64 IS hidden, and js-yaml
    // folded the 90-character value at its spaces. (b) prints the facts.
    expect({
      encodedLength: encoded.length > 76,
      wholeHidden: !serializeToolResult({ t: encoded }).includes(encoded),
      spacedLength: SPACED.length,
      folded: !folded.includes(SPACED) && folded.split('\n').length > 2,
    }).toEqual({ encodedLength: true, wholeHidden: true, spacedLength: 90, folded: true });
    // (a) red when a value split across a line break starts being matched (a line-joining
    //     decode before matching), or a line holding a blank is listed. (b) prints three booleans.
    // A multi-line value written one line at a time: its line holding a blank is kept.
    setAdditionalRedactionValues([SECRET, SPACED, 'fkDocsLineOne01\nfk docs line two 02']);
    expect({
      base64Kept: serializeToolResult({ t: wrapped }) === JSON.stringify({ t: wrapped }),
      yamlKept: serializeToolResult({ t: folded }) === JSON.stringify({ t: folded }),
      blankLineKept:
        serializeToolResult({ t: 'fk docs line two 02' }) ===
        JSON.stringify({ t: 'fk docs line two 02' }),
    }).toEqual({ base64Kept: true, yamlKept: true, blankLineKept: true });
  });

  it('leaves alone the spellings and values its list does not name, each as the page says', () => {
    claim(
      TOOLS_PAGE,
      'This does not catch everything, so do not rely on it to keep a secret out of a record. It leaves alone:',
    );
    // Kept bullets, quoted too: the npm variables (pinned in agent-utils.test.ts's #407 cells) and
    // what the model writes.
    claim(
      TOOLS_PAGE,
      '- the values of three variables that npm sets: `npm_package_name`, `npm_package_version` and `npm_lifecycle_event`;',
    );
    claim(
      TOOLS_PAGE,
      "- the model's own answers, and the arguments of its tool calls. Neither is checked.",
    );
    for (const bullet of [
      '- an environment value that is the word `false`, or two or three numbers joined by dots, such as the version number `11.8.0` (a declared secret with that value is hidden);',
      "- HTML references the named escapers do not write, such as Mustache.js's `&#x2F;` and `&#x3D;`, Handlebars' `&#x3D;` and `&#x60;`, a hex `&#x22;`, decimal `&#47;`, or PHP `htmlentities`' `&eacute;` and `&nbsp;`;",
      '- percent-encoding with lower-case hex, such as `%2f`;',
      "- bash's `$'…'` quoting in a C or POSIX locale, which writes non-ASCII bytes as `\\NNN`, and bash 5.2's `\\~`;",
      '- PyYAML double-quoted output with `allow_unicode`;',
      "- colour codes (ANSI escape sequences) between a value's characters;",
      "- PHP's `var_export` of a value holding a NUL character, which it writes as `'…' . \"\\0\" . '…'`, and Perl's `Data::Dumper` of a value that holds both a control character (a tab, ESC or DEL, for example) and a non-ASCII character, which it writes with the control character as it is and the non-ASCII character as `\\x{…}`;",
      "- a character newer than the Unicode tables of the program that printed it, or of the Node.js that runs Realm, in a value that also holds another non-ASCII character (Python 3.12 to 3.14, older Go, Ruby and Rust; Node 22's tables are older than Node 24's);",
      '- in a URL, its password, `user:password` or token printed on its own, its Basic-auth base64 printed on its own, and the URL without its query string apart from its password: the whole URL is hidden, and for a declared secret the parts around `&`;',
      '- other parts of a value than those named above, such as the password in a connection string written `Password=…` or the token in a value written `Bearer …`;',
      '- other escapings than those named above, or a value mixing several;',
    ]) {
      claim(TOOLS_PAGE, bullet);
    }
    isolateEnv();
    vi.stubEnv('HOME', '/home/fake-docs-user');
    const ch = (cp: number): string => String.fromCodePoint(cp);
    /** Whether `printed` comes back unchanged with `declared` declared (and the environment above). */
    const kept = (declared: string[], printed: string): boolean => {
      setAdditionalRedactionValues(declared);
      return serializeToolResult({ t: printed }) === JSON.stringify({ t: printed });
    };
    const TOKEN = 'FAKEhd7Q/x=Z9tlFAKE';
    const facts = {
      // bullet 2: an environment value `false` or `11.8.0` is kept; a declared one is hidden.
      envFalseKept: (() => {
        vi.stubEnv('DOCS_REDACTION_FALSE', 'false');
        vi.stubEnv('DOCS_REDACTION_VERSION', '11.8.0');
        return kept([], 'was false at 11.8.0');
      })(),
      declaredFalseHidden: !kept(['false'], 'was false'),
      // Two or three numbers joined by dots, not only version numbers; four is hidden.
      envDottedNumbersKept: (() => {
        vi.stubEnv('DOCS_REDACTION_DOTTED_A', '12345.678');
        vi.stubEnv('DOCS_REDACTION_DOTTED_B', '51.5074');
        return kept([], 'at 12345.678 and 51.5074');
      })(),
      envFourNumbersHidden: (() => {
        vi.stubEnv('DOCS_REDACTION_DOTTED_C', '10.20.30.40');
        return !kept([], 'at 10.20.30.40');
      })(),
      // #729 PR-3: "Your home folder, and every other environment value under it, is hidden whole."
      homeValueHiddenWhole: (() => {
        vi.stubEnv('DOCS_REDACTION_UNDER_HOME', '/home/fake-docs-user/projects/notes.md');
        setAdditionalRedactionValues([]);
        return (
          serializeToolResult({ t: '/home/fake-docs-user/projects/notes.md' }) ===
          JSON.stringify({ t: '[REDACTED]' })
        );
      })(),
      // HTML numeric references: Mustache.js writes `/` as `&#x2F;` and `=` as `&#x3D;`.
      mustacheKept: kept([TOKEN], 'FAKEhd7Q&#x2F;x&#x3D;Z9tlFAKE'),
      decimalKept: kept([TOKEN], 'FAKEhd7Q&#47;x&#61;Z9tlFAKE'),
      // Handlebars writes a backtick as `&#x60;`; PHP's `htmlentities` writes an e-acute as `&eacute;`
      // and a non-breaking space as `&nbsp;`.
      handlebarsBacktickKept: kept(['FAKEhd7Q`xZ9tlFAKE'], 'FAKEhd7Q&#x60;xZ9tlFAKE'),
      htmlentitiesKept: kept(
        ['FAKEhd7Q' + ch(0xe9) + ch(0xa0) + 'Z9tlFAKE'],
        'FAKEhd7Q&eacute;&nbsp;Z9tlFAKE',
      ),
      // Lower-case percent-encoding.
      lowerPercentKept: kept([TOKEN], 'FAKEhd7Q%2fx%3dZ9tlFAKE'),
      // bash in a C locale writes `é` as `\303\251`; bash 5.2 writes `~` after `=` as `\~`.
      bashCLocaleKept: kept(
        ['FAKEhd7Q' + ch(0xe9) + 'Z9tlFAKE'],
        `$'FAKEhd7Q${BS}303${BS}251Z9tlFAKE'`,
      ),
      bashTildeKept: kept(['FAKEhd7Q=~Z9tlFAKE'], `FAKEhd7Q=${BS}~Z9tlFAKE`),
      // PyYAML 6.0.1 with allow_unicode writes ESC as `\e` and keeps the NBSP as it is.
      pyyamlUnicodeKept: kept(
        ['FAKEhd7Q' + ch(0x1b) + ch(0xa0) + ch(1) + 'Z9tlFAKE'],
        `k: "FAKEhd7Q${BS}e${ch(0xa0)}${BS}x01Z9tlFAKE"`,
      ),
      // Colour codes between the characters.
      ansiKept: kept(['FAKEhd7QZ9tlFAKE'], 'FAKEhd7Q' + ch(0x1b) + '[31mZ9tlFAKE'),
      // PHP's var_export of a value holding NUL; Perl's Data::Dumper of DEL beside `é`.
      phpNulKept: kept(['FAKEhd7Q' + ch(0) + 'Z9tlFAKE'], `'FAKEhd7Q' . "${BS}0" . 'Z9tlFAKE'`),
      // Beside the non-ASCII character (DEL), and anywhere else in the value (a tab 10 away).
      perlDelKept:
        kept(
          ['FAKEhd7Q' + ch(0x7f) + ch(0xe9) + '/cZ9tlFAKE'],
          `"FAKEhd7Q${ch(0x7f)}${BS}x{e9}/cZ9tlFAKE"`,
        ) &&
        kept(
          ['FAKEhd7Q' + ch(9) + 'Zp9WmRt4Lx' + ch(0xe9) + 'Qw3'],
          `"FAKEhd7Q${ch(9)}Zp9WmRt4Lx${BS}x{e9}Qw3"`,
        ),
      // Python 3.12's repr() escapes U+1C89, which Node 24's tables know, beside a raw `é`.
      unicodeSkewKept: kept(
        ['FAKEhd7Q' + ch(0xe9) + ch(0x1c89) + 'Z9tlFAKE'],
        `'FAKEhd7Q${ch(0xe9)}${BS}u1c89Z9tlFAKE'`,
      ),
      // A URL's password on its own.
      urlPasswordKept: kept(
        [['https', '://', 'fakeuser:FAKEpw12xyz9', '@db.fake.example/x'].join('')],
        'password FAKEpw12xyz9',
      ),
      // The URL without its query string is shown; for a declared secret, the part after `&` is
      // hidden.
      // #729 PR-3: the URL without its query is shown apart from its password, which the URL's
      // user-part anchor always hides.
      urlWithoutQueryKept: (() => {
        setAdditionalRedactionValues([
          ['https', '://', 'fakeuser:FAKEpw12xyz9', '@db.fake.example/x?a=fakeQ1&b=fakeQ2'].join(
            '',
          ),
        ]);
        const printed = ['https', '://', 'fakeuser:FAKEpw12xyz9', '@db.fake.example/x'].join('');
        return (
          serializeToolResult({ t: printed }) ===
          JSON.stringify({ t: 'https://fakeuser:[REDACTED]@db.fake.example/x' })
        );
      })(),
      urlAmpPartHidden: !kept(
        [
          ['https', '://', 'fakeuser:FAKEpw12xyz9', '@db.fake.example/x?a=fakeQ1&b=fakeQ2'].join(
            '',
          ),
        ],
        'see b=fakeQ2 here',
      ),
      // Other parts of a value: a connection string's password; the token after `Bearer `.
      passwordPartKept: kept(['Server=db;' + 'Password=' + 'FAKEpw12xyz9;'], 'pw FAKEpw12xyz9'),
      bearerTokenPartKept: kept(['Bearer ' + 'FAKEtokXYZ12'], 'tok FAKEtokXYZ12'),
      // Another escaping: quoted-printable.
      quotedPrintableKept: kept([TOKEN], 'FAKEhd7Q/x=3DZ9tlFAKE'),
    };
    // (a) red when a docs flip drops a bullet (each `claim`), or when the list starts hiding one of
    //     these spellings, or stops hiding a declared `false`; each fact is the bullet's own. (b)
    //     prints the facts.
    expect(facts).toEqual({
      envFalseKept: true,
      declaredFalseHidden: true,
      envDottedNumbersKept: true,
      envFourNumbersHidden: true,
      homeValueHiddenWhole: true,
      mustacheKept: true,
      decimalKept: true,
      handlebarsBacktickKept: true,
      htmlentitiesKept: true,
      lowerPercentKept: true,
      bashCLocaleKept: true,
      bashTildeKept: true,
      pyyamlUnicodeKept: true,
      ansiKept: true,
      phpNulKept: true,
      perlDelKept: true,
      unicodeSkewKept: true,
      urlPasswordKept: true,
      urlWithoutQueryKept: true,
      urlAmpPartHidden: true,
      passwordPartKept: true,
      bearerTokenPartKept: true,
      quotedPrintableKept: true,
    });
  });

  it("leaves alone a value a template filter changed in the agent step's prompt, but not its lines or parts", async () => {
    claim(
      TOOLS_PAGE,
      "- a value that a template filter changed in the agent step's prompt (for example `| truncate` or `| upper`), except that a whole line of a multi-line value, and a part of a declared secret, are still hidden there;",
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const SECRET = 'docs-filter-secret';
    const upper = await promptSent('Use {{ run.params.key | upper }}.', { key: SECRET }, [SECRET]);
    const TWO_LINES = 'fkLineOne01\nfkLineTwo02';
    const truncatedLines = await promptSent(
      'Use {{ run.params.key | truncate: 20 }}.',
      { key: TWO_LINES },
      [TWO_LINES],
    );
    const AMP = 'fkPartOne1&fkPartTwo2xyz';
    const truncatedPart = await promptSent(
      'Use {{ run.params.key | truncate: 14 }}.',
      { key: AMP },
      [AMP],
    );
    // (a) red when values are hidden before the template renders (then the filter sees only the
    //     marker: `upperSent`); when LINES is removed (`firstLineHidden`); when G2 is removed
    //     (`firstPartHidden`). (b) prints the facts.
    expect({
      upperSent: upper.includes(SECRET.toUpperCase()),
      truncatedLinesCut: !truncatedLines.includes(TWO_LINES),
      firstLineHidden: !truncatedLines.includes('fkLineOne01'),
      truncatedPartCut: !truncatedPart.includes(AMP),
      firstPartHidden: !truncatedPart.includes('fkPartOne1&'),
    }).toEqual({
      upperSent: true,
      truncatedLinesCut: true,
      firstLineHidden: true,
      truncatedPartCut: true,
      firstPartHidden: true,
    });
  });
});

describe(`${ENV_PAGE} — what realm agent reads its environment for (GHSA-gxfq)`, () => {
  it('replaces environment values and their encoded forms in tool results, error messages and the prompt', async () => {
    claim(
      ENV_PAGE,
      '`realm agent` also reads the values of the variables in its environment, so that it can replace them, and the forms [Give an agent step tools](../guides/agent-tools.md#4-read-what-was-recorded) lists, with `[REDACTED]` in tool results, in error messages and in the prompt the agent step sends the model.',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ENV = `Env"fake${BS}value-7`;
    vi.stubEnv('DOCS_REDACTION_ENV_ENCODED', ENV);
    // The value's JSON text, alone on each surface: the oracle decodes JSON only when a whole
    // string parses.
    const escaped = JSON.stringify(ENV);
    const toolResult = serializeToolResult({ text: escaped });
    const error = sanitizeError(new Error(escaped));
    const prompt = await promptSent('{{ run.params.t }}', { t: escaped }, []);
    const hidden = (s: string): boolean => leakedForms(s, ENV).length === 0;
    // (a) red when the escaped form of an environment value reaches any of the three. (b) prints,
    //     per surface, whether it is hidden.
    expect({
      toolResult: hidden(toolResult),
      error: hidden(error),
      prompt: hidden(prompt),
    }).toEqual({ toolResult: true, error: true, prompt: true });
  });
});

describe(`${MANIFEST_PAGE} — secret values in a builder's error (GHSA-gxfq)`, () => {
  it('replaces a secret, the forms these programs print it in and its lines with [REDACTED]', () => {
    claim(
      MANIFEST_PAGE,
      'When a function that builds an entry throws, Realm replaces every secret value of 4 or more characters in the message with `[REDACTED]`, and also the forms these programs print it in:',
    );
    for (const bullet of FORMS_BULLETS) claim(MANIFEST_PAGE, bullet);
    claim(
      MANIFEST_PAGE,
      'It also replaces each line of a multi-line value that has 8 or more characters and no spaces or other blank characters.',
    );
    // Each row's output is the whole message, as a builder's error carries it.
    const verdicts = FAMILIES.map(([family, printer, kase]) => {
      const row = captured(printer, kase);
      return familyVerdict(family, row, redactSecretValues(row.output, [row.value]), '[REDACTED]');
    });
    const LINES_SECRET = 'fkFirstLine01\nline-of-the-key-0001';
    const lineOut = redactSecretValues('failed: line-of-the-key-0001', [LINES_SECRET]);
    // (a) red when a family's form leaves the list (the members the tools page's forms cell
    //     names), or when LINES is removed (`lineHidden`). (b) prints, per family, the marker and
    //     the oracle's pairs, and two booleans.
    expect({
      verdicts,
      lineHidden: leakedForms(lineOut, LINES_SECRET, ['line-of-the-key-0001']).length === 0,
      lineMarked: lineOut.includes('[REDACTED]'),
    }).toEqual({ verdicts: HIDDEN_FAMILIES, lineHidden: true, lineMarked: true });
  });

  it('hides the parts of a declared secret', () => {
    claim(
      MANIFEST_PAGE,
      "It also hides a secret's parts, as [Give an agent step tools](../guides/agent-tools.md#4-read-what-was-recorded) lists them.",
    );
    const out = redactSecretValues('bad token fkB2y9 in the config', ['fkA1x&fkB2y9']);
    // (a) red when `redactSecretValues` drops `parts: true` (or G3 is removed). (b) prints a
    //     boolean.
    expect(out === 'bad token [REDACTED] in the config').toBe(true);
  });

  it('leaves a value of 6 bytes or fewer in base64 and base64url when other text was encoded with it', () => {
    claim(
      MANIFEST_PAGE,
      'In base64 and base64url, a value of 6 bytes or fewer that was encoded together with other text is hidden at some positions and not at others.',
    );
    const SIX = `Ab1"x${BS}`;
    const SEVEN = `Ab1"x${BS}9`;
    const message = (text: string, encoding: 'base64' | 'base64url') =>
      redactSecretValues(`failed: ${Buffer.from(text).toString(encoding)}`, [SIX, SEVEN]);
    // (a) red when a 6-byte value after a 1-byte prefix and before a `}` is hidden (a form below
    //     the floor), when a
    //     7-byte value there is left (Jenkins' `a` form removed), or when a 6-byte value alone or
    //     after a 3-byte prefix is left. (b) prints the facts.
    expect({
      base64LeftAlone: leakedForms(message(`a${SIX}}`, 'base64'), SIX).length > 0,
      base64urlLeftAlone: leakedForms(message(`a${SIX}}`, 'base64url'), SIX).length > 0,
      aloneHidden: leakedForms(message(SIX, 'base64'), SIX).length === 0,
      afterThreeHidden: leakedForms(message(`abc${SIX}\n`, 'base64'), SIX).length === 0,
      sevenHidden: leakedForms(message(`a${SEVEN}\n`, 'base64'), SEVEN).length === 0,
    }).toEqual({
      base64LeftAlone: true,
      base64urlLeftAlone: true,
      aloneHidden: true,
      afterThreeHidden: true,
      sevenHidden: true,
    });
  });

  it('hides every value with its JSON-style escapes read; leaves alone what the tools page lists', () => {
    claim(
      MANIFEST_PAGE,
      'For every value, it also hides, in the same forms, the value with these escapes read, when that has 8 or more characters: `\\n`, `\\r`, `\\t`, `\\b`, `\\f`, `\\/`, `\\\\`, `\\"`, `\\uXXXX` and `\\xHH` (a value that ends in a lone `\\` has no such reading); and each line of that which has 8 or more characters and no spaces or other blank characters.',
    );
    claim(MANIFEST_PAGE, 'It leaves alone what that page lists as left alone.');
    claim(
      MANIFEST_PAGE,
      'With `SHOP_TOKEN=secret-value-123` and a function that throws `bad token ${config.token}`:',
    );
    const BODY = 'FAKEdocsBodyLine0123456789abcdef';
    const ONE_LINE = ['fake-docs-key', BODY, 'fake-docs-end'].join(BS + 'n');
    const read = redactSecretValues(`bad key ${ONE_LINE.split(BS + 'n').join('\n')}`, [ONE_LINE]);
    const kept = redactSecretValues('bad token FAKEhd7Q%2fZ9tlFAKE', ['FAKEhd7Q/Z9tlFAKE']);
    // (a) red when the D layer is removed (`readHidden`), or when lower-case percent-encoding,
    //     which the tools page lists as left alone, starts being hidden (`lowerPercentKept`).
    //     (b) prints two booleans.
    expect({
      readHidden: !read.includes(BODY) && read.includes('[REDACTED]'),
      lowerPercentKept: kept === 'bad token FAKEhd7Q%2fZ9tlFAKE',
    }).toEqual({ readHidden: true, lowerPercentKept: true });
  });

  it("the builder's error keeps no secret in its cause, for an Error and for a thrown string", async () => {
    clearProjectExtensionsCache();
    const root = mkdtempSync(join(tmpdir(), 'realm-docs-cause-'));
    const SECRET = 'fake-cause-secret-0042';
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(
        join(root, 'dist', 'factories.js'),
        'export function throwsError({ config }) { throw new TypeError(`bad token ${config.t}`); }\n' +
          'export function throwsString({ config }) { throw `bad token ${config.t}`; }\n',
        'utf8',
      );
      writeFileSync(join(root, '.env'), `CAUSE=${SECRET}\n`, 'utf8');
      const inspected: string[] = [];
      for (const factory of ['throwsError', 'throwsString']) {
        clearProjectExtensionsCache();
        writeFileSync(
          join(root, 'realm.yaml'),
          `version: 1\nhandlers:\n  h1:\n    use: ./dist/factories.js#${factory}\n    config: { t: "\${secret:CAUSE}" }\n`,
          'utf8',
        );
        const definition = {
          id: `docs-redaction-cause-${factory}`,
          name: 'Docs redaction cause',
          version: 1,
          schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
          steps: { s1: { description: 'step', execution: 'agent' } },
          origin: 'human',
          source_dir: root,
          trust_root: root,
        } as WorkflowDefinition;
        try {
          await loadProjectExtensions(definition);
          inspected.push('did not throw');
        } catch (err) {
          inspected.push(inspect(err, { depth: 5 }));
        }
      }
      // (a) red when the builder's error keeps the original error as its cause (`util.inspect`
      //     prints `[cause]` with the raw message). (b) prints, per factory, whether the error
      //     printed a cause, a marker, and no secret — never the text.
      expect(
        inspected.map((t) => ({
          cause: t.includes('[cause]'),
          marked: t.includes('[REDACTED]'),
          noSecret: !t.includes(SECRET),
        })),
      ).toEqual([
        { cause: true, marked: true, noSecret: true },
        { cause: true, marked: true, noSecret: true },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      clearProjectExtensionsCache();
    }
  });
});

describe(`${MANIFEST_PAGE} — how the dotenv file is read (GHSA-gxfq)`, () => {
  it('reads quoted values across lines, a raw carriage return, and the escapes inside "…"', () => {
    claim(
      MANIFEST_PAGE,
      'In the `dotenv` file, a value in quotes (`\'…\'`, `"…"` or `` `…` ``) may span lines. A carriage return written in the file is read as a line break. Inside `"…"`, `\\n` and `\\r` are read as a line break and a carriage return, also after another backslash: `\\\\n` is a backslash and a line break. In a quoted value, every other character is kept as written: `\\"` stays two characters, and so does `\\\\` unless `n` or `r` follows it.',
    );
    const dir = mkdtempSync(join(tmpdir(), 'realm-docs-dotenv-'));
    try {
      const CR = '\r';
      const LF = '\n';
      writeFileSync(
        join(dir, '.env'),
        [
          `SQ='fa${LF}ke'`,
          `BT=\`fa${LF}ke\``,
          `DQ="fa${LF}ke"`,
          `RAWCR="fa${CR}ke"`,
          `DQN="fa${BS}nke"`,
          `DQR="fa${BS}rke"`,
          `DQBSN="fa${BS}${BS}nke"`,
          `DQQ="fa${BS}"ke"`,
          `DQBS="fa${BS}${BS}ke"`,
        ].join(LF) + LF,
        'utf8',
      );
      const expected: Record<string, string> = {
        SQ: `fa${LF}ke`,
        BT: `fa${LF}ke`,
        DQ: `fa${LF}ke`,
        RAWCR: `fa${LF}ke`,
        DQN: `fa${LF}ke`,
        DQR: `fa${CR}ke`,
        DQBSN: `fa${BS}${LF}ke`,
        DQQ: `fa${BS}"ke`,
        DQBS: `fa${BS}${BS}ke`,
      };
      const names = Object.keys(expected);
      // The manifest's own loading path: the default `dotenv` source at `<manifest dir>/.env`.
      const { values } = resolveManifestSecrets(
        names.map((name, i) => ({ name, path: `handlers.h${i}.config.v` })),
        undefined,
        dir,
        'real',
      );
      // (a) red when the loading path stops reading the file with dotenv's own parser, or dotenv
      //     changes how it reads a quoted value. (b) prints, per name, whether the value read is
      //     the one the paragraph states — never a value.
      expect(Object.fromEntries(names.map((n) => [n, values[n] === expected[n]]))).toEqual(
        Object.fromEntries(names.map((n) => [n, true])),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
