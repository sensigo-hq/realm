// anthropic-workspace-1122.test.ts — issue #1122: `ANTHROPIC_WORKSPACE_ID` names the Anthropic
// workspace on every request, and a workspace refusal stops at its first request with a line saying
// what to set. Every cell drives the REAL SDK against the in-process stub on 127.0.0.1 (the provider
// reaches it through the SDK's `ANTHROPIC_BASE_URL`), which records each request's body and headers
// and, for the refusals, answers with Anthropic's exact bodies (its authentication page, saved as
// `plans/anthropic-workspace/auth.md`: AW-11). The key and the workspace IDs are fakes. Beside each
// cell: (a) the change that turns it red; (b) what it prints when it fails — the request count, the
// header values and the line, never a key or prompt text.
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider } from './anthropic-provider.js';
import type { ToolDefinition } from '../mcp/mcp-extensions.js';
import { startAnthropicStub, type AnthropicStubOptions } from '../test-support/anthropic-stub.js';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const WORKSPACE = 'wrkspc_01FakeWorkspace1122';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};
const lookup = (strict = false): ToolDefinition => ({
  id: 'srv:lookup',
  serverId: 'srv',
  name: 'lookup',
  description: 'Look a thing up',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  ...(strict ? { strict: true } : {}),
});
const EXECUTOR = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

/** Anthropic's error body, as its authentication page shows it. */
const refusal = (type: string, message: string) => ({
  type: 'error',
  error: { type, message },
  request_id: 'req_011Fake1122',
});
/** R1, the current wording (AW-11; the one received live, MA2-LIVE-10). */
const R1_NOW =
  'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
/** R1, the August wording (DG-WS-20). */
const R1_AUGUST =
  'anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.';
const R2 = 'anthropic-workspace-id header must be a valid workspace ID.';
const R3 = `Workspace \`${WORKSPACE}\` not found.`;

const W1 =
  'Anthropic refused this API key because it is not tied to a workspace. Set ANTHROPIC_WORKSPACE_ID to the ID of the workspace to use (in the Claude Console, Settings → Workspaces, the ID column), or use a key made inside a workspace.';
const W2 =
  'Anthropic refused the workspace ID in ANTHROPIC_WORKSPACE_ID as not valid. Copy the ID from the Claude Console (Settings → Workspaces, the ID column); it starts with wrkspc_.';
const W3 =
  'Anthropic has no workspace with the ID in ANTHROPIC_WORKSPACE_ID that this API key can use. Check the ID in the Claude Console (Settings → Workspaces, the ID column).';
/** #676's line for this provider's model, unchanged. */
const MODEL_LINE =
  'Anthropic offers no model named claude-x to this API key. Check the name given to --model; current models are listed at https://platform.claude.com/docs/en/models/overview and retired ones at https://platform.claude.com/docs/en/about-claude/model-deprecations.';

/** The environment of one cell: the stub's address, a fake key and the setting as given. */
function setEnv(baseUrl: string, workspace: string | undefined, customHeaders?: string): void {
  process.env['ANTHROPIC_BASE_URL'] = baseUrl;
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fake-1122-0000';
  if (workspace === undefined) delete process.env['ANTHROPIC_WORKSPACE_ID'];
  else process.env['ANTHROPIC_WORKSPACE_ID'] = workspace;
  if (customHeaders === undefined) delete process.env['ANTHROPIC_CUSTOM_HEADERS'];
  else process.env['ANTHROPIC_CUSTOM_HEADERS'] = customHeaders;
}

/** A provider at Anthropic's own address asking for 5 minutes; `question` puts the cache-miss
 *  question on the wire (the constructor's default is off, AUD1122-28). */
const provider = (question: boolean, endpoint: 'default' | 'custom' = 'default') =>
  new AnthropicProvider('claude-x', {
    endpoint,
    promptCache: { value: 'short', source: 'stated', by: 'realm agent' },
    ...(question ? { cacheDiagnostics: true } : {}),
  });

/** The four places a refused request can be sent again on the base (AW-04, AUD1122-05). */
type Site =
  | 'single-shot, the question on'
  | 'single-shot strict (#236)'
  | 'tool step, the question on'
  | 'tool step, a strict tool (#311)';
const call = (site: Site): Promise<unknown> => {
  switch (site) {
    case 'single-shot, the question on':
      return provider(true).callStepWithMeta('prompt', SCHEMA);
    case 'single-shot strict (#236)':
      return provider(false).callStepWithMeta('prompt', SCHEMA, undefined, {
        structuredOutputStrict: true,
      });
    case 'tool step, the question on':
      return provider(true).callStepWithTools('prompt', [lookup()], EXECUTOR, {
        inputSchema: SCHEMA,
        maxToolCalls: 1,
      });
    case 'tool step, a strict tool (#311)':
      return provider(false).callStepWithTools('prompt', [lookup(true)], EXECUTOR, {
        inputSchema: SCHEMA,
        maxToolCalls: 1,
      });
  }
};

/** Runs `site` against a stub answering every request with `status` and this body; returns how
 *  many requests reached it and the line the provider gives for the error (or what it threw). */
async function refused(
  site: Site,
  workspace: string | undefined,
  status: number,
  body: Record<string, unknown>,
): Promise<{ requests: number; line: string | undefined }> {
  const stub = await startAnthropicStub({
    finalContent: { answer: 'unused' },
    failure: { status, headers: {}, body },
  });
  try {
    setEnv(stub.baseUrl, workspace);
    const err = await call(site).then(
      () => new Error('the call did not fail'),
      (e: unknown) => e,
    );
    const line = provider(false).explainFailure(err);
    return { requests: stub.requests.length, line };
  } finally {
    await stub.close();
  }
}

/** Drives a call that succeeds; returns each request's `anthropic-workspace-id` header. */
async function headersOf(
  options: AnthropicStubOptions,
  run: () => Promise<unknown>,
  workspace: string | undefined,
  customHeaders?: string,
): Promise<Array<string | string[] | undefined>> {
  const stub = await startAnthropicStub(options);
  try {
    setEnv(stub.baseUrl, workspace, customHeaders);
    await run();
    return stub.headers.map((h) => h['anthropic-workspace-id']);
  } finally {
    await stub.close();
  }
}

describe('#1122 checks 1–4 — the header on every request', () => {
  // Check 1. Real case: a single-shot step on a key not tied to a workspace, the setting set, at
  // Anthropic's own address and through a gateway named by ANTHROPIC_BASE_URL (the stub stands in
  // for both). (a) red when the single-shot client gets no `defaultHeaders`; (b) prints the values.
  it.each<[string, 'default' | 'custom']>([
    ["Anthropic's own address", 'default'],
    ['a custom endpoint named by ANTHROPIC_BASE_URL', 'custom'],
  ])(
    '1 single-shot, set, %s: its request carries anthropic-workspace-id with the value',
    async (_n, endpoint) => {
      expect(
        await headersOf(
          { finalContent: { answer: 'a' } },
          () => provider(false, endpoint).callStepWithMeta('prompt', SCHEMA),
          WORKSPACE,
        ),
      ).toEqual([WORKSPACE]);
    },
  );

  // Check 2. Real case: a step that calls one tool, then the final extraction (max_tool_calls 1,
  // which uses the tool loop's own client, AUD1122-21). (a) red when the tool-calling client gets no
  // `defaultHeaders`; (b) prints each request's header value.
  it('2 tool-calling, set: the tool turn and the final extraction both carry it', async () => {
    expect(
      await headersOf(
        { finalContent: { answer: 'a' }, firstToolCall: { match: /lookup/, arguments: {} } },
        () =>
          provider(false).callStepWithTools('prompt', [lookup()], EXECUTOR, {
            inputSchema: SCHEMA,
            maxToolCalls: 1,
          }),
        WORKSPACE,
      ),
    ).toEqual([WORKSPACE, WORKSPACE]);
  });

  // Check 3. Real case: the variable not set, or set to spaces in a `.env`. (a) red when a blank
  // value counts as set; (b) prints the header values.
  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['blank ("   ")', '   '],
  ])('3 %s: no request carries anthropic-workspace-id', async (_n, workspace) => {
    expect(
      await headersOf(
        { finalContent: { answer: 'a' } },
        () => provider(false).callStepWithMeta('prompt', SCHEMA),
        workspace,
      ),
    ).toEqual([undefined]);
  });

  // Check 4. Real case: an operator who also names the header in ANTHROPIC_CUSTOM_HEADERS (SDK
  // 0.92.0+, which merges it under `defaultHeaders`: AW-05, AUD1122-02). (a) red when the variable
  // wins, or both values go; (b) prints the header value.
  it('4 set, and ANTHROPIC_CUSTOM_HEADERS names another: the request carries the setting’s value only', async () => {
    expect(
      await headersOf(
        { finalContent: { answer: 'a' } },
        () => provider(false).callStepWithMeta('prompt', SCHEMA),
        WORKSPACE,
        'anthropic-workspace-id: wrkspc_other',
      ),
    ).toEqual([WORKSPACE]);
  });
});

describe('#1122 checks 5–8 — a workspace refusal stops at its first request, with its line', () => {
  // Check 5. Real case: the owner's key, not tied to a workspace, with no setting (MA2-LIVE-10).
  // On the base each site sends the refused request again. (a) red when that site's re-send still
  // fires (2 requests) or the line is not W1; (b) prints the request count and the line.
  it.each<[Site]>([
    ['single-shot, the question on'],
    ['single-shot strict (#236)'],
    ['tool step, the question on'],
    ['tool step, a strict tool (#311)'],
  ])('5 R1, the current wording, %s: 1 request, then W1', async (site) => {
    expect(await refused(site, undefined, 400, refusal('invalid_request_error', R1_NOW))).toEqual({
      requests: 1,
      line: W1,
    });
  });

  // Check 6. Real case: the wording Anthropic sent in August (DG-WS-20). (a) red when the message
  // test keys on the current sentence; (b) prints the request count and the line.
  it('6 R1, the August wording, single-shot with the question on: 1 request, then W1', async () => {
    expect(
      await refused(
        'single-shot, the question on',
        undefined,
        400,
        refusal('invalid_request_error', R1_AUGUST),
      ),
    ).toEqual({ requests: 1, line: W1 });
  });

  // Check 7. Real case: a setting that is not a workspace ID (a typo, a pasted name). (a) red when
  // it falls to W1 or to the base; (b) prints the request count and the line.
  it('7 R2, single-shot with the question on: 1 request, then W2', async () => {
    expect(
      await refused(
        'single-shot, the question on',
        'wrkspc_typo',
        400,
        refusal('invalid_request_error', R2),
      ),
    ).toEqual({ requests: 1, line: W2 });
  });

  // Check 8. Real case: a workspace ID from another organization, or one the key may not use. (a)
  // red when it falls to the base (no line) or to #676's line; (b) prints the count and the line.
  it('8 R3, single-shot with the question on: 1 request, then W3, never #676’s line', async () => {
    expect(
      await refused('single-shot, the question on', WORKSPACE, 404, refusal('not_found_error', R3)),
    ).toEqual({ requests: 1, line: W3 });
  });
});

describe('#1122 check 9 — each conjunct of the R-set, alone, leaves the base behaviour', () => {
  // Each row meets every conjunct of an R-set member but one, single-shot with the question on, so
  // a 400 is sent again on the base (2 requests) and a 403 or 404 is not (1). One predicate serves
  // the stop and the line, so each row asserts both. (a) red when the row's conjunct is dropped
  // (the row then stops at 1 request and gives a W-line); (b) prints the row, the count and line.
  it.each<[string, string | undefined, number, string, string, number, string | undefined]>([
    [
      'status: a 403 invalid_request_error naming the header',
      undefined,
      403,
      'invalid_request_error',
      R1_NOW,
      1,
      undefined,
    ],
    [
      'status: a 400 not_found_error "Workspace … not found." with the setting set',
      WORKSPACE,
      400,
      'not_found_error',
      R3,
      2,
      undefined,
    ],
    [
      'type: a 400 of another type naming the header',
      undefined,
      400,
      'permission_error',
      R1_NOW,
      2,
      undefined,
    ],
    [
      'type: a 404 invalid_request_error "Workspace … not found." with the setting set',
      WORKSPACE,
      404,
      'invalid_request_error',
      R3,
      1,
      undefined,
    ],
    [
      'message: a 400 invalid_request_error not naming the header',
      undefined,
      400,
      'invalid_request_error',
      'messages: at least one message is required',
      2,
      undefined,
    ],
    [
      'message: a 404 not_found_error "Workspace …" without "not found"',
      WORKSPACE,
      404,
      'not_found_error',
      `Workspace \`${WORKSPACE}\` is archived.`,
      1,
      undefined,
    ],
    [
      'message: a 404 not_found_error "… not found." not starting "Workspace "',
      WORKSPACE,
      404,
      'not_found_error',
      `Project \`${WORKSPACE}\` not found.`,
      1,
      undefined,
    ],
    [
      'setting: a 404 not_found_error "Workspace … not found." with the setting unset',
      undefined,
      404,
      'not_found_error',
      R3,
      1,
      undefined,
    ],
    [
      'kept: a 404 not_found_error "model: claude-x" with the setting set → #676’s line',
      WORKSPACE,
      404,
      'not_found_error',
      'model: claude-x',
      1,
      MODEL_LINE,
    ],
  ])('9 %s', async (_n, workspace, status, type, message, requests, line) => {
    expect(
      await refused('single-shot, the question on', workspace, status, refusal(type, message)),
    ).toEqual({ requests, line });
  });
});
