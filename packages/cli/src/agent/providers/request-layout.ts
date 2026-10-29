// request-layout.ts — issue #600 caching PR 5 (C3.1): what each built-in adapter's single-shot request
// sends ahead of an agent step's input, as blocks in wire order. A block is stable when it is the same
// on every call of its step (the fixed part a provider can cache); each stable block names its
// segments, the pieces realm builds it from, so a reader can tell where two steps' fixed parts part.
//
// The single-shot request builders (`anthropic-provider.ts`, `openai-provider.ts` — the plain and the
// strict path — and `openai-reasoning-provider.ts`) are NOT built from this: the describer is a mirror,
// pinned to each builder's body by one cross cell per adapter (`request-layout.test.ts`). The submit
// tool is the exception: both sides build it with the one function below, so no cell can catch a
// drift in it; the move is what prevents one. The tools-loop path and `performFinalExtraction` are out
// of its scope: a step with tools is not described (realm marks its turns as it sends them).
import type { CacheBlock } from '@sensigo/realm';
import { buildSystemPrompt } from './agent-utils.js';

/** The tool offered at `tool_choice:'auto'` so the model can return structured output directly —
 * `tool_use.input` arrives pre-parsed, eliminating the fenced/prefaced-JSON parse-failure class by
 * construction. `auto` (never forced) preserves reason-then-answer: a workflow whose output schema
 * declares a reasoning field LAST must not have the model rationalize post-hoc (see the design
 * decision in prompts/robust-anthropic-provider.md). Not pushed into tool_call_records anywhere it's
 * used — it's an extraction mechanism, not an agent-chosen tool. */
export const SUBMIT_TOOL_NAME = '__realm_submit__';

/**
 * Issue #236: `strict` is a NEW sanctioned option, threaded from run-agent through both call
 * sites of this builder (the main `callStep`/`callStepWithMeta` call AND `performFinalExtraction`
 * — design §4 [CG]). Default absent = today's behavior byte-identical: the key is only ever
 * added to the returned object when the caller explicitly opts in.
 */
export function buildSubmitTool(
  schema: Record<string, unknown>,
  opts?: { strict?: boolean },
): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
} {
  return {
    name: SUBMIT_TOOL_NAME,
    description: 'Return your final result for this step as structured data.',
    input_schema: schema,
    ...(opts?.strict === true ? { strict: true } : {}),
  };
}

/**
 * Anthropic's own tool text, in tokens. When a request carries the submit tool, Anthropic adds text
 * of its own that counts toward the cache minimum (PR5M-04: on claude-sonnet-5-5, examples/04's
 * `tag_content` cached 550 tokens with the tool and nothing without it). Counted in total on
 * 2026-10-27 (PR5M-01): 309–314 tokens on claude-sonnet-5-5, 519–529 on claude-sonnet-4-6. The low
 * end is set from 5.5's cached part, the high end from 4.6's total count, an upper bound on its
 * cached part. Adapter knowledge, not a model table: the same band for every model.
 */
export const ANTHROPIC_TOOL_TEXT_TOKENS: { readonly low: number; readonly high: number } = {
  low: 220,
  high: 530,
};

/** The schema name OpenAI's strict path sends (`openai-provider.ts`, `JSON_SCHEMA_NAME`; pinned by
 *  the openai cross cell, which compares this block with the body that path sends). */
const OPENAI_JSON_SCHEMA_NAME = 'realm_step_output';

/** The three built-in request shapes. `openai-reasoning` is the o1 family's (see `chooseAdapter`). */
export type RequestAdapter = 'anthropic' | 'openai' | 'openai-reasoning';

/** A block of a request; `value` is the object sent when the block is JSON. */
export interface Block extends CacheBlock {
  value?: unknown;
}

/** What a step's request is built from. */
export interface RequestParts {
  profile?: string;
  schema?: Record<string, unknown>;
  strict: boolean;
}

/** The system prompt, with its segments: the profile (and its `\n\n`), realm's base, the schema line. */
function systemBlock(
  name: string,
  parts: RequestParts,
  structuredToolOffered: boolean,
  suffix = '',
): Block {
  const text = buildSystemPrompt(parts.schema, parts.profile, structuredToolOffered);
  const withoutSchema = buildSystemPrompt(undefined, parts.profile, structuredToolOffered);
  const profileEnd = parts.profile !== undefined ? parts.profile.length + 2 : 0;
  return {
    name,
    text: `${text}${suffix}`,
    stable: true,
    segments: [
      ...(parts.profile !== undefined ? [{ name: 'profile', start: 0, end: profileEnd }] : []),
      { name: 'base', start: profileEnd, end: withoutSchema.length },
      ...(parts.schema !== undefined
        ? [{ name: 'schema_line', start: withoutSchema.length, end: text.length }]
        : []),
    ],
  };
}

/** Anthropic's `tools` block: `[submitTool]` as sent, segmented into header, schema and strict flag. */
function toolsBlock(schema: Record<string, unknown>, strict: boolean): Block {
  const value = [buildSubmitTool(schema, strict ? { strict: true } : undefined)];
  const text = JSON.stringify(value);
  const schemaText = JSON.stringify(schema);
  const header = text.indexOf('"input_schema":') + '"input_schema":'.length;
  const schemaEnd = header + schemaText.length;
  const strictText = ',"strict":true';
  return {
    name: 'tools',
    text,
    value,
    stable: true,
    segments: [
      { name: 'tool_header', start: 0, end: header },
      { name: 'tool_schema', start: header, end: schemaEnd },
      ...(strict
        ? [{ name: 'tool_strict', start: schemaEnd, end: schemaEnd + strictText.length }]
        : []),
    ],
  };
}

/** The part after the fixed one: the step's input, unknown at admission. */
const INPUT: Block = { name: 'messages', text: '', stable: false, segments: [] };

/**
 * The blocks of `adapter`'s single-shot request for a step built from `parts`, in wire order:
 * - anthropic: `tools` (only with a schema: the submit tool, `strict: true` on the strict rung), then
 *   `system` (the base that names the tool when it is offered), both stable, then `messages`;
 * - openai: on the strict rung with a schema, `response_format` (the `json_schema` object the strict
 *   path sends), then `system`, both stable, then `messages`. The plain path's
 *   `{ type: 'json_object' }` is a request setting, not prompt text, and is no block;
 * - openai-reasoning: `messages-head` (the system prompt and the `\n\n` before the input, folded into
 *   the user message) stable, then the input.
 */
export function describeRequestLayout(adapter: RequestAdapter, parts: RequestParts): Block[] {
  const hasSchema = parts.schema !== undefined;
  switch (adapter) {
    case 'anthropic':
      return [
        ...(hasSchema ? [toolsBlock(parts.schema!, parts.strict)] : []),
        systemBlock('system', parts, hasSchema),
        INPUT,
      ];
    case 'openai': {
      const blocks: Block[] = [];
      if (parts.strict && hasSchema) {
        const value = {
          type: 'json_schema',
          json_schema: { name: OPENAI_JSON_SCHEMA_NAME, strict: true, schema: parts.schema },
        };
        const text = JSON.stringify(value);
        blocks.push({
          name: 'response_format',
          text,
          value,
          stable: true,
          segments: [{ name: 'response_format', start: 0, end: text.length }],
        });
      }
      blocks.push(systemBlock('system', parts, false), INPUT);
      return blocks;
    }
    case 'openai-reasoning':
      return [
        systemBlock('messages-head', parts, false, '\n\n'),
        { ...INPUT, name: 'messages-tail' },
      ];
  }
}
