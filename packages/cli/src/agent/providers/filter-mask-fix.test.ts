// filter-mask-fix.test.ts — the filter-mask fix, PR 1 (the CLI). A value Realm hides, shown in an
// agent step's prompt through a filter (`| upper`), reached the model provider in its filtered form:
// the prompt was masked after its filters ran, by exact forms. And a span mark planted inside a tool
// result's value passed the mask, because the marks were stripped after it. The writer's own
// span-aware print is unchanged. Every fake here is made up for the test.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (1) what turns it red, (2) what it prints then.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from '../run-agent.js';
import { LlmProvider } from './llm-provider.js';
import { serializeToolResult, setAdditionalRedactionValues } from './agent-utils.js';
import { addDeclaredValues, installWriter, pass, writerTestSeams } from '../../output/writer.js';

const SECRET = 'fm-cli-declared-3c9e';
const MARK = String.fromCharCode(0xe000);
/** The declared fake with a span mark planted after its fifth character. */
const MARKED = `${SECRET.slice(0, 5)}${MARK}${SECRET.slice(5)}`;

afterEach(() => {
  setAdditionalRedactionValues([]);
  vi.restoreAllMocks();
});

/** The prompt `runAgent` sends the model for one agent step rendering `template` over `params`. */
async function promptSent(template: string, params: Record<string, unknown>): Promise<string> {
  const prompts: string[] = [];
  const provider = new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta(prompt: string) {
      prompts.push(prompt);
      return { output: { summary: 'ok' } } as never;
    }
  })();
  const definition = {
    id: 'fm-cli',
    name: 'Filter-mask CLI',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { ask: { description: 'Ask', execution: 'agent', prompt: template } },
  } as WorkflowDefinition;
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
      redactionValues: [SECRET],
    },
    { definition, params },
  );
  // Witness: the step ran and the model was asked once. (2) prints the result and the count.
  expect({ result, calls: prompts.length }).toEqual({ result: 'completed', calls: 1 });
  return prompts[0]!;
}

describe('the filter-mask fix — what the model is sent', () => {
  it('(2) a declared value through `| upper` in the prompt reaches the model as the marker, beside the plain field', async () => {
    const sent = await promptSent('Upper: {{ run.params.k | upper }}\nPlain: {{ run.params.k }}', {
      k: SECRET,
    });
    // (1) red when the drive composes the prompt without the agent set (the upper-cased fake is
    //     sent); (2) prints the prompt and whether it holds the fake in any case form.
    expect({
      sent,
      leaks: [SECRET, SECRET.toUpperCase(), SECRET.toLowerCase()].some((f) => sent.includes(f)),
    }).toEqual({ sent: 'Upper: [REDACTED]\nPlain: [REDACTED]', leaks: false });
  });
});

describe('the filter-mask fix (B3) — a tool result strips its marks before it is masked', () => {
  it('(8) a string result and an object result holding a marked declared value are masked', () => {
    setAdditionalRedactionValues([SECRET]);
    const shown = {
      string: serializeToolResult(`found ${MARKED}`),
      object: serializeToolResult({ note: `found ${MARKED}` }),
    };
    // (1) red when either branch masks before it strips (the fake passes, its mark then removed);
    //     (2) prints both results.
    expect(shown).toEqual({
      string: 'found [REDACTED]',
      object: JSON.stringify({ note: 'found [REDACTED]' }),
    });
  });
});

describe('the filter-mask fix (constraint 3) — the writer’s span-aware print is unchanged', () => {
  it('(10) a private print of a value beside a span: the span’s body as built (a word equal to a declared value included), the value masked', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    installWriter('default');
    addDeclaredValues({ FM_CLI_SECRET: SECRET, FM_CLI_WORD: 'abandoned' });
    const line = `${writerTestSeams.span('c', 'abandoned')} beside ${SECRET}`;
    // (1) red when the writer's span-aware path is lost (the line falls back to masking whole: the
    //     span's word, equal to a declared value, would be hidden too); (2) prints the shown line.
    expect(pass(line, 'private')).toBe('abandoned beside [REDACTED]');
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
/** The `[Unreleased]` section's `### <heading>` part of CHANGELOG.md. */
function unreleased(heading: string): string {
  const all = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  // #871's form: `[Unreleased]` until a release renames it, then the first section (the release's).
  const top = all.includes('## [Unreleased]')
    ? all.indexOf('## [Unreleased]')
    : all.indexOf('\n## [') + 1;
  const section = all.slice(top, all.indexOf('\n## [', top + 1));
  const start = section.indexOf(`### ${heading}`);
  const end = section.indexOf('\n### ', start + 1);
  return section.slice(start, end === -1 ? undefined : end);
}

describe('the filter-mask fix — the words', () => {
  it('(13) the changelog says what was wrong, what is closed and what is kept, and names the library’s new options', () => {
    const fixed =
      "- A value Realm hides (a declared secret; for the model also an environment value or a credential-shaped value), shown in a template through a filter such as `upper`, `lower` or `truncate`, reached a gate's question and a model's prompt in its filtered form, because the mask ran after the filter; and a span mark planted inside a value passed an MCP reply's mask and a tool result's on its way to the model, because marks were stripped after it. Both are closed: the value is masked before its filters run, at every place a template is rendered, and marks are stripped before any mask. A question opened before this version keeps the text it was opened with until it is answered, and the release notes' Upgrading section says how to find and rotate what was shown; a reply's `disclosure.hidden` counts what the reply's own mask replaced, not a marker a template rendered.";
    const added =
      '- `WaysContext`, `composeWaysAt` and `submitHumanResponse` take an optional `disclosure` set, and `pendingGateQuestion` an optional set, so a program that composes ways, answers a question or renders the fallback question masks each value before its template filters run.';
    // (1) red when either line is missing from its section under `[Unreleased]`, or reworded; (2)
    //     prints which was found.
    expect({
      fixedFound: flat(unreleased('Fixed')).includes(flat(fixed)),
      addedFound: flat(unreleased('Added')).includes(flat(added)),
    }).toEqual({ fixedFound: true, addedFound: true });
  });

  it('the templates page says a value hidden whole shows as the marker, whatever its filter (pinned by the core cell (6))', () => {
    const sentence =
      'A value that Realm hides whole is shown as `[REDACTED]` instead: it is hidden before any filter runs, and no filter changes it.';
    // (1) red when the sentence leaves the page or is reworded; (2) prints the page and sentence.
    expect(
      flat(
        readFileSync(join(ROOT, 'docs/reference/workflow/input-map-and-templates.md'), 'utf8'),
      ).includes(flat(sentence)),
      sentence,
    ).toBe(true);
  });
});
