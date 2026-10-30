// args-witness-729.test.ts — issue #729 PR-0 (D4 P-5; prompt A4): each MCP tool that enacts a verb
// takes exactly that verb's arguments, `ARGS[verb]` — the same names, types and requiredness — read
// from the tool list an agent is served (`tools/list`'s JSON schemas), never from this package's code.
// A tool's extra field is named here with why it is not the verb's argument (it is this door's own);
// anything else on either side fails the cell.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: tool,
// field and type names only.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGS, JsonFileStore, JsonWorkflowStore, type ArgSpec } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

/** The tool that enacts each verb on this door, and the door's own fields with why. */
const DOOR: Record<string, { tool: string; extras: Record<string, string> }> = {
  respond: { tool: 'submit_human_response', extras: {} },
  run_step: {
    tool: 'execute_step',
    extras: {
      trace: "the agent's own tool trace, recorded beside the step (this door's)",
      writer_nonce: "the write-ahead log's nonce for the agent's trace (this door's)",
    },
  },
  advance: { tool: 'advance_run', extras: {} },
  inspect: {
    tool: 'get_run_state',
    extras: {
      include_steps: 'how much of the record this read returns (a view option)',
      // #872 (b1): authorized by MA 4 during the build (add-only), as include_steps' form.
      step_names: "which steps' records this read returns (a view option)",
      cursor: "where this read's page of steps resumes, under the reply's ceiling (a view option)",
    },
  },
  abandon: { tool: 'abandon_run', extras: {} },
};

type JsonSchema = { properties?: Record<string, { type?: string }>; required?: string[] };

describe('#729 PR-0 — P-5: each MCP tool takes its verb’s ARGS', () => {
  it('the five tools that enact a verb: the same arguments, types and requiredness; register is no tool here (A-10)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-args-729-'));
    const server = createRealmMcpServer({
      runStore: new JsonFileStore(join(dir, 'runs')),
      workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'args-witness-729', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const listed = (await client.listTools()).tools;
    const schemaOf = (name: string): JsonSchema =>
      (listed.find((t) => t.name === name)?.inputSchema ?? {}) as JsonSchema;

    const found: string[] = [];
    for (const [verb, door] of Object.entries(DOOR)) {
      const schema = schemaOf(door.tool);
      const fields = Object.keys(schema.properties ?? {});
      const required = new Set(schema.required ?? []);
      const args = ARGS[verb as keyof typeof ARGS] as Readonly<Record<string, ArgSpec>>;
      for (const [arg, spec] of Object.entries(args)) {
        const field = schema.properties?.[arg];
        if (field === undefined) {
          found.push(`${door.tool}: no field for ${verb}'s '${arg}'`);
          continue;
        }
        if (field.type !== spec.type) {
          found.push(`${door.tool}.${arg}: type ${field.type}, ARGS says ${spec.type}`);
        }
        if (required.has(arg) !== spec.required) {
          found.push(
            `${door.tool}.${arg}: required ${required.has(arg)}, ARGS says ${spec.required}`,
          );
        }
      }
      for (const field of fields) {
        if (!(field in args) && !(field in door.extras)) {
          found.push(`${door.tool}: field '${field}' is neither ${verb}'s argument nor named here`);
        }
      }
      for (const extra of Object.keys(door.extras)) {
        if (!fields.includes(extra)) found.push(`${door.tool}: named extra '${extra}' is gone`);
      }
    }
    // (a) red when a tool's field or ARGS drifts apart — a renamed argument, a requiredness or type
    //     change, an unnamed new field; (b) prints each difference by name.
    expect(found).toEqual([]);
    expect(listed.some((t) => /register/.test(t.name))).toBe(false);
  });
});
