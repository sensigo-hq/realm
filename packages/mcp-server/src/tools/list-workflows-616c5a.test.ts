// list-workflows-616c5a.test.ts — #616 PR-2c c5a on the MCP door: `list_workflows` through the real
// server (`createRealmMcpServer`, an in-memory client) with a registrar that is not the JSON registry.
// The server neither depends on store-sqlite nor reaches it, so its SQLite arm is a double whose
// entries are core's own (`unreadableById` over core's refusal builders); the real SQLite listing is
// pinned in store-sqlite's `workflow-store-616.test.ts` (c5a). The file arm's whole entry is LW2's
// (`list-workflows.test.ts`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  legacyCopyError,
  storedCopyFaultError,
  unreadableById,
  workflowNotFoundError,
  type RegistryListing,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';
import { declared } from '../test-support/declared.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
});

const DEF: WorkflowDefinition = {
  id: 'wf',
  name: 'WF',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { draft: { description: 'd', execution: 'agent' } },
};

/** A registrar that is not the JSON registry: `list()` returns DEF; the listing, when given. */
function registrar(listing?: () => Promise<RegistryListing>): WorkflowRegistrar {
  return declared({
    register: async () => {},
    get: async (id: string) => {
      if (id === DEF.id) return DEF;
      throw workflowNotFoundError(id);
    },
    list: async () => [DEF],
    ...(listing !== undefined ? { listWithDiagnostics: listing } : {}),
  });
}

/** `list_workflows`, called through a server built on a temp home with `workflowStore` swapped in.
 *  The parameter is typed `WorkflowRegistrar`: the option takes any registry (#661). */
async function listWorkflows(workflowStore: WorkflowRegistrar): Promise<Record<string, unknown>> {
  const h = await makeTempHome();
  handles.push(h);
  const server = createRealmMcpServer({ ...h.stores, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c5a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const raw = (await client.callTool({ name: 'list_workflows', arguments: {} })) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
}

describe('#616 PR-2c c5a — list_workflows over a registrar that is not the JSON registry', () => {
  it("the id arm (the SQLite registry's entries): each entry by `workflow_id` with no `file`, the id-arm hint, the warnings line as before", async () => {
    const old = unreadableById('old', legacyCopyError('old'))!;
    const odd = unreadableById(
      'odd',
      storedCopyFaultError('odd', { kind: 'not_a_workflow', fault: 'no_steps' }),
    )!;
    const reply = await listWorkflows(
      registrar(async () => ({ workflows: [DEF], unreadable: [old, odd], mismatched: [] })),
    );
    const unreadable = reply['unreadable'] as Array<Record<string, unknown>>;
    // (1) red when an id entry is given `file: <id>` (or loses its `workflow_id`), when the file arm's
    //     hint ("names each file …, only needs its file repaired") is given to id entries, or when the
    //     warnings line changes; (2) prints the entries, their keys, the warnings and the hint.
    expect({
      unreadable,
      keys: unreadable.map((u) => Object.keys(u).sort()),
      warnings: reply['warnings'],
      hint: reply['hint'],
    }).toEqual({
      unreadable: [
        { workflow_id: 'old', class: 'legacy', reason: legacyCopyError('old').message },
        {
          workflow_id: 'odd',
          class: 'parse',
          reason: odd.reason,
          repair:
            're-register the workflow from its source (realm workflow register <path-to-workflow>)',
        },
      ],
      keys: [
        ['class', 'reason', 'workflow_id'],
        ['class', 'reason', 'repair', 'workflow_id'],
      ],
      warnings: ["2 registered workflow copies could not be read — see 'unreadable'."],
      hint: "2 registered workflow copies could not be read — 'unreadable' names each workflow by its id and the reason, with the repair where one applies (an operator's act). Do not create a workflow to replace one listed there until an operator has looked: the entry may be a registered workflow that only needs registering again from its source, one an older or a later version of Realm registered, whose reason names the way out, or a registry row that was damaged, whose reason names what to do. Call get_workflow_protocol with a workflow_id before calling start_run.",
    });
  });

  it("the fallback (#661 acceptance 2's first half): a registrar without `listWithDiagnostics` is listed as its `list()` returns, with nothing more said", async () => {
    const reply = await listWorkflows(registrar());
    // (1) red when the member is called unguarded (the call fails), or when the fallback adds an
    //     entry or a warning, or withdraws the healthy hint; (2) prints the reply's four fields.
    expect({
      workflows: reply['workflows'],
      unreadable: reply['unreadable'],
      warnings: reply['warnings'],
      hint: reply['hint'],
    }).toEqual({
      workflows: [{ id: 'wf', name: 'WF', version: 1 }],
      unreadable: [],
      warnings: [],
      hint: 'Call get_workflow_protocol with a workflow_id before calling start_run. If no workflow matches your task, use create_workflow to define and start your own plan.',
    });
  });

  it("#661 acceptance 1 and 3, type level: an object typed `WorkflowRegistrar` is accepted as `createRealmMcpServer`'s `workflowStore` under --strict (the typecheck-tests step compiles this file)", () => {
    // (1) red at `tsc` when the option is typed back to the class (TS2322 here, and at
    //     `listWorkflows`'s call above); (2) the compiler prints the two types.
    const accepts = (
      workflowStore: WorkflowRegistrar,
    ): Parameters<typeof createRealmMcpServer>[0]['workflowStore'] => workflowStore;
    expect(accepts(registrar())).toBeDefined();
  });
});
