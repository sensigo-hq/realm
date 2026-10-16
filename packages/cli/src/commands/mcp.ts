// realm mcp — starts the global Realm MCP server.
// Serves all workflows registered via `realm workflow register`.
// Workflows that declare `extensions:` get their project extension modules resolved
// per-definition via the registryProvider (process-lifetime cache — restart to pick up
// module content changes).
import { Command } from 'commander';
import { JsonWorkflowStore } from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeProjectProviders } from '../extensions/load-project-extensions.js';
import { resolveProgramIdentity } from '../lib/program-identity.js';
import { hostRefusalLine } from '../lib/host-refusal-line.js';
import { cliOperatorRoute } from './ways-renderer.js';
import {
  checkValueLine,
  gateAnswersStartLine,
  readBinDoorSettings,
} from '../lib/gate-answers-door.js';
import { measureSeparation, renderSeparation, systemProbes } from '../lib/separation-check.js';

/**
 * Starts the Realm MCP server using the global workflow store (~/.realm/workflows/).
 * All workflows registered via `realm workflow register` are immediately available.
 * Built-in adapters (FileSystemAdapter etc.) are included automatically; per-workflow
 * project extensions load through the registryProvider.
 */
export const mcpCommand = new Command('mcp')
  .description('Start the Realm MCP server (serves all registered workflows via stdio)')
  .option(
    '--extensions-module <path>',
    "CODE override: module that REPLACES every workflow's declared 'extensions' modules (repair tool)",
  )
  .option(
    '--project <dir>',
    'CONFIG anchor: deployment root whose realm.yaml applies to definitions without a stored trust_root. NO default: the mcp stdio cwd is CLIENT-controlled, so the manifest loads ONLY when --project is typed by the operator (in the MCP client config).',
  )
  .option(
    '--gate-answers <value>',
    'How this server handles gate answers: asked (the default), offered or withheld. The most restrictive of this flag and REALM_MCP_GATE_ANSWERS wins.',
  )
  .option(
    '--form-wait-seconds <seconds>',
    'The longest a form waits for the person, in seconds from 30 to 3600 (default 240). The smallest of this flag and REALM_MCP_FORM_WAIT_SECONDS wins.',
  )
  .option(
    '--check',
    'Print the gate-answers value this server would start with and the separation check, then exit without starting',
  )
  .action(
    async (options: {
      extensionsModule?: string;
      project?: string;
      gateAnswers?: string;
      formWaitSeconds?: string;
      check?: boolean;
    }) => {
      // #627 W (§5.1): the two settings, read as the server will read them — a bad value refuses the
      // start (W-s4, W-s8) before anything else happens.
      const settings = readBinDoorSettings(
        'mcp',
        { gateAnswers: options.gateAnswers, formWaitSeconds: options.formWaitSeconds },
        process.env,
      );
      if (!settings.ok) {
        console.error(settings.line);
        process.exit(1);
      }
      if (options.check === true) {
        // W-s6 and the separation check (Part K): nothing is started.
        console.log(checkValueLine(settings.answers));
        const evidence = await measureSeparation({
          probes: systemProbes(),
          value: { value: settings.answers.value, source: settings.answers.source },
          roots: options.project !== undefined ? [options.project] : [],
        });
        for (const line of renderSeparation(evidence)) console.log(line);
        process.exit(0);
      }
      // issue #625 (holder slice): this program's name, made once, before the transport opens. A name
      // that cannot be used prints one line to stderr and exits 1 — a stdio server prints nothing on
      // stdout before the client's first message, and this does not either.
      const driver = resolveProgramIdentity('mcp-stdio');
      const workflowStore = new JsonWorkflowStore();
      // SECURITY (recorded decision): unlike serve/agent/run there is NO cwd default here —
      // an MCP client opening a cloned repo must not cause its realm.yaml to resolve secrets
      // and import code. Do not "improve" this.
      // issue #620 PR-C: a construction refusal (a store or registry from another realm) is printed
      // as one line and the command exits 1 — never Node's uncaught-exception stack. A release-line
      // refusal here means this command's own install is split: `hostRefusalLine` says so.
      let server: ReturnType<typeof createRealmMcpServer>;
      try {
        // issue #600 caching PR P: the registry and the prices share one load per definition call.
        const { registryProvider, priceSourceProvider } = makeProjectProviders(
          options.extensionsModule,
          options.project,
        );
        server = createRealmMcpServer({
          workflowStore,
          registryProvider,
          priceSourceProvider,
          ...(driver !== undefined ? { driver } : {}),
          // #729 PR-0 (P-6): the CLI's renderer as the operator route — an operator's command reaches
          // only the block addressed to the person.
          operatorRoute: cliOperatorRoute('realm mcp'),
          // #627 W: the flags as the bins pass them (source `flag`); the stdio transport
          // authenticates no one, so its answers name no principal (§5.8's table).
          ...(options.gateAnswers !== undefined ? { gateAnswersFlag: options.gateAnswers } : {}),
          ...(options.formWaitSeconds !== undefined
            ? { formWaitSecondsFlag: options.formWaitSeconds }
            : {}),
          principal: { absent: 'door_authenticates_no_principal' },
        });
      } catch (err) {
        console.error(hostRefusalLine('mcp', err));
        process.exit(1);
      }
      // #627 W: the start line — stderr, since stdout carries the protocol.
      console.error(gateAnswersStartLine(settings.answers, false));
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  );
